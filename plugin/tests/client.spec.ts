/**
 * The client half: `lib/client.js` must be a lazy-CJS factory registration, and the violin page
 * must run.
 *
 * The file under test is the **built artifact**, not the source: it is read from disk, so a config
 * that stopped emitting it, an emit that grew an `import`/`export`, or a factory that throws on
 * load all fail here. The stand-in React runtime is deliberately tiny — hooks in a stable order,
 * a re-render on state change, and a value passed to `onChange` — so the page is exercised as a
 * component without a browser.
 *
 * What this proves, and what it does not. It proves the bundle registers under our id on a
 * stand-in `window.__ModuleLoader__`, that the factory materializes while requiring nothing but
 * React, that it returns the plugin shape (`{inject, apply}`), that `apply` registers a
 * `settings.section` contribution on the slots service, and that the section renders violins:
 * three bands in origin order, a card per violin whose header states what it resolves to, the
 * catalog's own options in the pickers, the whole groups document in every PUT, the host's
 * sentence on a refusal with the local edit kept, and every task key exactly once. It does **not**
 * prove a browser rendered it; the report says which half was observed live.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** The shell's primitives package: seeded by the shell, so a require and never a dependency. */
const PRIMITIVES_ID = '@deepseek-ai/dsh-client-ui-primitives'
const clientFile = join(pkgDir, 'lib', 'client.js')
const BUILD_FIRST = 'run `npx tsc -p tsconfig.client.json` first: the spec reads the built bundle'

/** The built bundle's text, or a failure that names the missing build step. */
function clientSource(): string {
  assert.ok(existsSync(clientFile), `${clientFile} does not exist — ${BUILD_FIRST}`)
  return readFileSync(clientFile, 'utf8')
}

// ---------------------------------------------------------------------------------------------
// A minimal React stand-in: enough of the hook contract to mount the page outside a browser.
// ---------------------------------------------------------------------------------------------

interface Element {
  readonly type: unknown
  readonly props: Record<string, unknown>
  readonly children: unknown[]
}

type Component = () => unknown

interface ReactStub {
  createElement: (type: unknown, props?: unknown, ...children: unknown[]) => Element
  useState: <T>(initial: T) => [T, (next: T | ((previous: T) => T)) => void]
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => void
}

interface Effect {
  readonly effect: () => void | (() => void)
  started: boolean
}

interface Mount {
  readonly tree: unknown
  readonly text: string
}

interface Runtime {
  readonly React: ReactStub
  mount: (component: Component) => Promise<Mount>
  settle: (component: Component) => Promise<Mount>
  /** Mount, then apply a `useState` change and let the fetch it starts settle. */
  act: (component: Component, run: () => void) => Promise<Mount>
}

/**
 * A hook runtime with no reconciler: `useState`/`useEffect` per call index, a re-render when
 * state changes, and a loop that lets the fetch the effect started settle. Deliberately small:
 * nothing here is a React behaviour this page relies on beyond "hooks are called in a stable
 * order and a state change re-renders".
 */
function createRuntime(): Runtime {
  const state: unknown[] = []
  const effects: (Effect | undefined)[] = []
  let cursor = 0
  let dirty = false
  let tree: unknown = null

  const React: ReactStub = {
    createElement: (type, props, ...children) => ({
      type,
      props: (props ?? {}) as Record<string, unknown>,
      children: children.flat(),
    }),
    useState: <T>(initial: T) => {
      const index = cursor++
      if (!(index in state)) state[index] = initial
      return [
        state[index] as T,
        (next: T | ((previous: T) => T)) => {
          state[index] = typeof next === 'function' ? (next as (previous: T) => T)(state[index] as T) : next
          dirty = true
        },
      ]
    },
    useEffect: (effect) => {
      const index = cursor++
      const previous = effects[index]
      effects[index] = { effect, started: previous?.started ?? false }
    },
  }

  const flush = async (): Promise<void> => {
    for (let turn = 0; turn < 8; turn += 1) await new Promise((resolveTurn) => setTimeout(resolveTurn, 0))
  }

  const settle = async (component: Component): Promise<Mount> => {
    cursor = 0
    tree = component()
    for (let pass = 0; pass < 6; pass += 1) {
      for (const entry of effects) {
        if (entry === undefined || entry.started) continue
        entry.started = true
        entry.effect()
      }
      await flush()
      if (!dirty) break
      dirty = false
      cursor = 0
      tree = component()
    }
    return { tree, text: collectText(tree) }
  }

  const act = async (component: Component, run: () => void): Promise<Mount> => {
    run()
    return settle(component)
  }

  return { React, mount: settle, settle, act }
}

/** Every string in a rendered tree, joined; enough to assert on user-visible copy. */
function collectText(input: unknown): string {
  const node = expand(input)
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join(' ')
  if (node !== null && typeof node === 'object') {
    const element = node as Element
    if ('type' in element && 'children' in element) {
      const inputValue = typeof element.props['value'] === 'string' ? element.props['value'] : ''
      return `${inputValue} ${element.children.map(collectText).join(' ')}`
    }
  }
  return ''
}

/**
 * The copy one element shows, without the leading space `collectText` adds for the value of a
 * control. Use it where the exact text is the assertion.
 */
function textOf(node: unknown): string {
  return collectText(node).trim()
}

/**
 * One element with its children, calling any function component it meets.
 *
 * The runtime here is a hook harness, not a renderer: it never calls a component, so a tree that
 * contains one — the shell's `Tooltip`, which the page wraps its toolbar buttons and its `?` marks
 * in — would hide everything inside it from every assertion. Rendering it in place is the smallest
 * thing that makes the tree mean what a browser would mean by it.
 */
function expand(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expand)
  if (node !== null && typeof node === 'object') {
    const element = node as Element
    if (!('type' in element) || !('children' in element)) return node
    const children = element.children.map(expand)
    if (typeof element.type === 'function') {
      const child = element.props['children']
      const passed = child === undefined ? children : (Array.isArray(child) ? child : [child]).map(expand)
      return expand((element.type as (props: Record<string, unknown>) => unknown)({ ...element.props, children: passed }))
    }
    return { ...element, children }
  }
  return node
}

/**
 * Every element in a subtree, including the ones `elements()` cannot see: a `hover()` child is an
 * already-created element sitting in a prop, and `elements()` walks only `children`, so a mark
 * inside a tooltip wrapper is invisible to it. This walks props too, and renders function
 * components.
 */
function expandAllElements(node: unknown, out: Element[] = []): Element[] {
  const expanded = expand(node)
  if (Array.isArray(expanded)) {
    for (const child of expanded) expandAllElements(child, out)
    return out
  }
  if (expanded !== null && typeof expanded === 'object') {
    const element = expanded as Element & { props: Record<string, unknown> }
    if (!('type' in element) || !('children' in element)) return out
    out.push(element)
    for (const child of element.children) expandAllElements(child, out)
    for (const value of Object.values(element.props ?? {})) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'type' in (value as object)) {
        expandAllElements(value, out)
      }
    }
  }
  return out
}

/** Every element in the tree, in render order. */
function elements(node: unknown, out: Element[] = []): Element[] {
  const expanded = expand(node)
  if (Array.isArray(expanded)) {
    for (const child of expanded) elements(child, out)
    return out
  }
  if (expanded !== null && typeof expanded === 'object') {
    const element = expanded as Element
    if (!('type' in element) || !('children' in element)) return out
    out.push(element)
    for (const child of element.children) elements(child, out)
  }
  return out
}

/** The first descendant of the given element type whose children contain `label`. */
function findElement(node: unknown, type: string, label: string): Element | undefined {
  return elements(node).find((element) => element.type === type && element.children.includes(label))
}

/** Every `select`/`input` the page rendered, in order. */
function controls(node: unknown, type: 'select' | 'input'): Element[] {
  return elements(node).filter((element) => element.type === type)
}

/** The options a selector offers, as `value: label`. */
function optionsOf(select: Element, text: (label: string) => string = (label) => label): string[] {
  return select.children
    .filter((child): child is Element => typeof child === 'object' && child !== null && (child as Element).type === 'option')
    .map((option) => {
      const value = String(option.props['value'] ?? '')
      const label = option.children.map(collectText).join(' ').trim()
      return `${value}:${text(label)}`
    })
}

/** The value of one `data-` attribute on every element that carries it, in render order. */
function attributeValues(node: unknown, name: string): string[] {
  return elements(node)
    .filter((element) => element.props[name] !== undefined)
    .map((element) => String(element.props[name]))
}

/** The controls a reader finds under a label such as `provider`: the one next to that word. */
function labelledAll(node: unknown, label: string): Element[] {
  const found: Element[] = []
  for (const element of elements(node)) {
    if (element.type !== 'label') continue
    const named = element.children.some(
      (child) =>
        typeof child === 'object' &&
        child !== null &&
        Array.isArray((child as Element).children) &&
        (child as Element).children.includes(label),
    )
    if (!named) continue
    // The control may be wrapped in the shell's `Tooltip` (every picker is, so it can explain the
    // options it offers), so it is found at any depth rather than as a direct child.
    const control = elements(element).find(
      (child) => child.type === 'select' || child.type === 'input',
    )
    if (control !== undefined) found.push(control)
  }
  return found
}

/** The one control under a label. */
function labelled(node: unknown, label: string): Element | undefined {
  return labelledAll(node, label)[0]
}

/** The first element carrying a `data-` attribute with this value. */
function carrying(node: unknown, name: string, value: string): Element | undefined {
  return elements(node).find((element) => element.props[name] === value)
}

/** Drop comments, so a source check tests the code and not the prose that explains it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

// ---------------------------------------------------------------------------------------------
// Loading the built bundle exactly the way the browser's module system does.
// ---------------------------------------------------------------------------------------------

interface Registration {
  readonly id: string
  readonly factory: (require: (id: string) => unknown) => unknown
}

type FetchLike = (url: string, init?: { method?: string; body?: string }) => Promise<unknown>

/** Evaluate the bundle against a fake loader global and a fake `fetch`, and return what it registered. */
function evaluateBundle(fetchImpl: FetchLike): Registration[] {
  const registrations: Registration[] = []
  const sandbox: Record<string, unknown> = {
    window: {
      __ModuleLoader__: {
        load: (registration: Registration) => {
          registrations.push(registration)
        },
      },
    },
    fetch: fetchImpl,
  }
  runInNewContext(clientSource(), sandbox)
  return registrations
}

/** A `Response`-shaped object, which is all the page reads. */
function response(status: number, body: unknown): unknown {
  return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body }
}

/** The HTTP calls the page made, in order. */
interface Call {
  readonly url: string
  readonly method: string
  readonly body?: string
}

interface Harness {
  readonly module: { inject?: unknown; apply?: (ctx: unknown) => void }
  readonly runtime: Runtime
  /** Module ids the factory asked for. */
  readonly required: string[]
  /** Slot names `apply` waited for. */
  readonly injected: string[]
  /** Every `settings.section` contribution, with its render function. */
  readonly registered: { options: Record<string, unknown>; render: Component }[]
  readonly calls: Call[]
}

/**
 * A stand-in for the shell's primitives package.
 *
 * The real `Tooltip` renders a fixed-position bubble with the shell's own styling; what this page
 * depends on is only that it exists and that its `label` and its child survive into the tree, so
 * the stand-in renders both in an element carrying `data-tooltip`. `present: false` gives back an
 * empty package, which is how the "no primitive, no crash" path is exercised.
 */
function primitivesStub(React: ReactStub, present = true): { Tooltip?: unknown } {
  if (!present) return {}
  const Tooltip = (props: Record<string, unknown>): unknown =>
    React.createElement(
      'span',
      { 'data-tooltip': String(props['label'] ?? ''), 'data-tooltip-side': String(props['side'] ?? '') },
      // The real Tooltip clones its child and wraps it; the child arrives as one element, and it has
      // to survive into the tree or every marker inside a hover would vanish from the assertions.
      [props['children']],
    )
  return { Tooltip }
}

/** Materialize the bundle's factory and apply it against a recording slots service. */
function harness(
  fetchImpl: FetchLike = () => Promise.reject(new Error('this test provided no fetch')),
  options: { readonly primitives?: boolean } = {},
): Harness {
  const calls: Call[] = []
  const recording: FetchLike = (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', ...(init?.body === undefined ? {} : { body: init.body }) })
    return fetchImpl(url, init)
  }
  const registrations = evaluateBundle(recording)
  assert.equal(registrations.length, 1, 'the bundle must register exactly one module')
  const registration = registrations[0]
  assert.ok(registration, 'no registration')
  const runtime = createRuntime()
  const required: string[] = []
  const module = registration.factory((id: string) => {
    required.push(id)
    if (id === 'react') return runtime.React
    // The shell's primitives module, seeded before any plugin bundle runs. `PRIMITIVES_ID` is the
    // only other id this bundle may ask for.
    if (id === PRIMITIVES_ID) return primitivesStub(runtime.React, options.primitives !== false)
    throw new Error(`the client half must not require "${id}"`)
  }) as { inject?: unknown; apply?: (ctx: unknown) => void }

  const registered: { options: Record<string, unknown>; render: Component }[] = []
  const injected: string[] = []
  const slots = {
    inject: (name: string, callback: () => unknown) => {
      injected.push(name)
      return callback()
    },
    register: (options: Record<string, unknown>, render: Component) => {
      registered.push({ options, render })
      return () => {}
    },
  }
  module.apply?.({ get: (name: string) => (name === 'slots' ? slots : undefined) })
  return { module, runtime, required, injected, registered, calls }
}

/** The one registered render function, or a failure that says which step did not happen. */
function renderFn(h: Harness): Component {
  const contribution = h.registered[0]
  assert.ok(contribution, 'apply() registered no settings.section contribution')
  return contribution.render
}

// ---------------------------------------------------------------------------------------------
// The payloads. Every route, model and effort here is one a live catalog could answer; the page
// may only ever offer what a payload supplies, so the fixtures are where the slugs come from.
// ---------------------------------------------------------------------------------------------

const FLASH = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  efforts: ['off', 'low', 'high', 'max'],
  defaultEffort: 'high',
  credentialRef: 'DEEPSEEK_OFFICIAL_API_KEY',
  credentialSource: 'derived',
}

const PRO = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-pro',
  efforts: ['off', 'low', 'high', 'max'],
  defaultEffort: 'high',
}

/** A second provider, so a provider list that came from the payload is distinguishable. */
const HAIKU = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  efforts: ['off', 'medium', 'high'],
  defaultEffort: 'medium',
}

/** Every task key this build knows, in the order the host lists them. */
const TASK_KEYS = [
  'feature',
  'refactoring',
  'bug-fix',
  'perf-issue',
  'hillclimb',
  'judgment-and-prose',
  'hardest-tasks',
  'how-explorer',
  'how-explainer',
  'why-investigators',
  'why-synthesizer',
  'reflect-tooling',
  'reflect-judgment',
  'swarm-workers',
  'arena-runners',
  'arena-cross-judge-pool',
  'architect-runners',
  'interrogate-reviewers',
  'independent-verifier',
  'poteto-agent',
  'comment-sicko',
]

/** The comparison containers: the only tasks a violin with several selections may hold. */
const PANEL_ROLES = ['arena-runners', 'arena-cross-judge-pool', 'architect-runners', 'interrogate-reviewers']

interface RawViolin {
  readonly id: string
  readonly name: string
  readonly origin: string
  readonly selections: readonly Record<string, unknown>[]
  readonly tasks: readonly string[]
}

interface RawGroups {
  readonly version: 1
  readonly violins: readonly RawViolin[]
}

function rawViolin(
  id: string,
  origin: string,
  selections: readonly Record<string, unknown>[],
  tasks: readonly string[],
  name = id,
): RawViolin {
  return { id, name, origin, selections, tasks }
}

const OFF_FLASH = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' }
const MAX_PRO = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' }
const HIGH_PRO = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }
const LOW_FLASH = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }
const HIGH_HAIKU = { provider: 'anthropic', model: 'claude-haiku-4-5', reasoningEffort: 'high' }

/**
 * A whole fleet, in an order the page must **not** keep: the custom violin first, two comparison
 * violins next, the predefined ones in the middle, the other two comparison violins last. A page
 * that rendered `groups.violins` as it received them would show this order; the bands show the
 * file's order *inside* each band, which is what the expectations below are written against.
 */
function groupsFixture(): RawGroups {
  return {
    version: 1,
    violins: [
      rawViolin(
        'reviewer',
        'custom',
        [{ provider: 'anthropic', model: 'claude-haiku-4-5', reasoningEffort: 'medium', description: 'the second opinion' }],
        ['how-explainer'],
        'Deep review',
      ),
      rawViolin('arena-runners', 'comparison', [MAX_PRO, HIGH_HAIKU], ['arena-runners']),
      rawViolin('arena-cross-judge-pool', 'comparison', [MAX_PRO, HIGH_HAIKU], ['arena-cross-judge-pool']),
      rawViolin('general', 'predefined', [OFF_FLASH], []),
      rawViolin('working', 'predefined', [MAX_PRO], ['feature', 'refactoring']),
      rawViolin('planning', 'predefined', [], []),
      rawViolin('fast', 'predefined', [LOW_FLASH], ['hillclimb']),
      // No selection: the page has to say what its tasks do instead of showing an empty row.
      rawViolin('vision', 'predefined', [], []),
      rawViolin('architect-runners', 'comparison', [MAX_PRO, HIGH_HAIKU], ['architect-runners']),
      rawViolin('interrogate-reviewers', 'comparison', [MAX_PRO, HIGH_HAIKU], ['interrogate-reviewers']),
    ],
  }
}

/** The task keys in no violin, derived the way the host derives them. */
function unassignedOf(groups: RawGroups): string[] {
  const assigned = new Set<string>()
  for (const violin of groups.violins) for (const task of violin.tasks) assigned.add(task)
  return TASK_KEYS.filter((key) => !assigned.has(key))
}

/** A whole `FleetView`, shaped the way `GET /api/pstack/fleet` answers. */
function fleetView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const groups = (overrides['groups'] ?? groupsFixture()) as RawGroups
  return {
    groupsPath: '/home/x/.dsh/pstack-groups.json',
    overlayPath: '/home/x/.dsh/pstack.json',
    origin: 'defaults',
    repairs: [],
    groupsError: null,
    groups,
    problems: [],
    catalog: { routes: [FLASH, PRO, HAIKU], unavailable: [] },
    taskKeys: TASK_KEYS,
    panelRoles: PANEL_ROLES,
    unassigned: unassignedOf(groups),
    modelSelection: { namespace: 'subagent-model-selection', present: true, enabled: false },
    ...overrides,
  }
}

/**
 * The payload the **previous** bundle asked for (the two-level overlay view), which is what a
 * cached client bundle meets after the host grew violins. There is no `groups` in it, which is
 * exactly the version skew the guard exists for.
 */
function preViolinView(): Record<string, unknown> {
  return {
    overlayPath: '/home/x/.dsh/pstack.json',
    overlay: { version: 2 },
    overlayText: '{"version":2,"models":{},"tasks":{}}',
    overlayError: null,
    overlayVersion: 2,
    versionNote: null,
    catalog: { routes: [FLASH], unavailable: [] },
    unavailable: [],
    models: [{ name: 'main', builtIn: true, declared: false, inheritsParent: false, route: null, unavailable: null, overlayDescription: null, usedBy: [] }],
    tasks: [],
    taskKeys: ['feature'],
    roleKeys: ['feature'],
    panelRoles: [],
    modelSelection: { namespace: 'subagent-model-selection', present: false, enabled: null },
  }
}

/** A host that writes what it is sent: the PUT answer is a view built from that document. */
function echoingHost(answer: (sent: RawGroups) => RawGroups = (sent) => sent): FetchLike {
  return (_url, init) => {
    if (init?.method !== 'PUT' || init.body === undefined) return Promise.resolve(response(200, fleetView()))
    const sent = JSON.parse(init.body) as RawGroups
    return Promise.resolve(response(200, fleetView({ groups: answer(sent) })))
  }
}

/** The document the page last PUT, parsed. */
function lastPut(h: Harness): RawGroups {
  const call = [...h.calls].reverse().find((entry) => entry.method === 'PUT')
  assert.ok(call?.body !== undefined, 'the page made no PUT')
  return JSON.parse(call.body) as RawGroups
}

/** One violin of the document the page last PUT. */
function sentViolin(h: Harness, id: string): RawViolin {
  const found = lastPut(h).violins.find((violin) => violin.id === id)
  assert.ok(found !== undefined, `the PUT body has no violin "${id}"`)
  return found
}

/** Click one violin's header, the way a reader opens a card. */
async function openViolin(h: Harness, render: Component, mount: Mount, id: string): Promise<Mount> {
  const header = carrying(mount.tree, 'data-pviolin-header', id)
  assert.ok(header !== undefined, `no header for "${id}" in the rendered tree`)
  return h.runtime.act(render, () => (header.props['onClick'] as () => void)())
}

/** Open every card, one click at a time, re-reading the tree as a person would. */
async function expandAll(h: Harness, render: Component, mount: Mount): Promise<Mount> {
  const ids = attributeValues(mount.tree, 'data-pviolin-header')
  assert.ok(ids.length > 0, 'the page rendered no violins')
  let current = mount
  for (const id of ids) current = await openViolin(h, render, current, id)
  return current
}

// ---------------------------------------------------------------------------------------------
// The bundle contract: unchanged, and the first thing a stale build breaks.
// ---------------------------------------------------------------------------------------------

test('the built bundle is a lazy-CJS registration on window.__ModuleLoader__, not an ES module', () => {
  const source = clientSource()
  assert.match(source, /window\.__ModuleLoader__/, 'the bundle must register on the loader global')
  assert.doesNotMatch(source, /^\s*(?:import|export)\b/m, 'a lazy-CJS factory carries no import/export statement')
  assert.doesNotMatch(
    source,
    /^\s*["']use strict["']/,
    'no directive prologue: these bundles are concatenated into one combo script',
  )

  const registrations = evaluateBundle(() => Promise.reject(new Error('unused')))
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0]?.id, 'dsh-pstack', 'the loader id is the package name')
  assert.equal(typeof registrations[0]?.factory, 'function')
})

test('the factory materializes requiring only react and returns the plugin shape', () => {
  const h = harness()
  assert.deepEqual(
    h.required,
    ['react', PRIMITIVES_ID],
    'React and the shell primitives are peers the loader provides, never dependencies — and they are the only two',
  )
  // Spread first: the factory's array literals carry the vm realm's Array prototype, which
  // `deepStrictEqual` distinguishes from ours even when the contents match.
  //
  // One service, and it must stay exactly one: `settingsScope` used to be listed here as the price
  // of a settings section, but it was removed from the Harness, and a name Cordis cannot provide
  // holds the plugin inactive for ever — the profile fails to boot rather than degrading. The page
  // reads and writes `/api/pstack/fleet` over HTTP and touches no settings service at all.
  assert.deepEqual([...(h.module.inject as string[])], ['slots'], 'the services this bundle registers on')
  assert.equal(typeof h.module.apply, 'function')
})

test('apply registers a settings.section contribution and never reaches for openSection', () => {
  assert.doesNotMatch(
    stripComments(clientSource()),
    /openSection/,
    'openSection belongs to the onboarding coordinator, not a section owner',
  )

  const h = harness()
  // One seat: the *pstack Fleet* page. The card that used to ride this bundle into the shell's
  // Plugins tab was removed, so a second injection here is a reintroduced surface, not a refactor.
  assert.deepEqual(h.injected, ['settings.section'], 'the one seat waits for its slot to exist')
  const contributions = h.registered.filter((entry) => entry.options['name'] === 'settings.section')
  assert.equal(contributions.length, 1, 'one section, registered into settings.section')
  const options = contributions[0]?.options ?? {}
  assert.equal(options['name'], 'settings.section')
  assert.equal(options['id'], 'pstack')
  assert.equal(options['order'], 40)
  assert.equal(typeof options['label'], 'function')
  assert.equal((options['label'] as () => string)(), 'pstack Fleet')
  assert.equal(typeof renderFn(h), 'function')
})

// ---------------------------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------------------------

test('a payload this bundle cannot read shows a sentence, never a blank page', async () => {
  // The real failure: a cached client bundle against a rebuilt host. Before the guard, the render
  // threw on a missing array and React unmounted the tree, so the section rendered as *nothing*.
  const h = harness(() => Promise.resolve(response(200, preViolinView())))
  const mount = await h.runtime.mount(renderFn(h))

  assert.deepEqual(attributeValues(mount.tree, 'data-pfleet-page'), ['violins'], 'the root must mount')
  assert.match(mount.text, /cannot read the host's response/)
  assert.match(mount.text, /missing "groups"/, 'the missing field is named, not summarised')
  assert.match(
    mount.text,
    /reload the page with the cache bypassed/,
    'the likeliest cause and its fix are stated, because a version skew is what this is',
  )
})

test('the bands render in order — Predefined, Comparison, Custom — with the unassigned last', async () => {
  const h = harness(() => Promise.resolve(response(200, fleetView())))
  const mount = await h.runtime.mount(renderFn(h))

  // The fixture lists the custom violin first, so this order can only come from the bands.
  assert.deepEqual(attributeValues(mount.tree, 'data-pviolin'), [
    'general',
    'working',
    'planning',
    'fast',
    'vision',
    'arena-runners',
    'arena-cross-judge-pool',
    'architect-runners',
    'interrogate-reviewers',
    'reviewer',
  ])
  assert.deepEqual(attributeValues(mount.tree, 'data-pfleet-band'), ['predefined', 'comparison', 'custom', 'unassigned'])
  assert.deepEqual(attributeValues(mount.tree, 'data-pviolin-origin'), [
    'predefined',
    'predefined',
    'predefined',
    'predefined',
    'predefined',
    'comparison',
    'comparison',
    'comparison',
    'comparison',
    'custom',
  ])
})

test('a header states what the violin resolves to, and an empty one says what its tasks do', async () => {
  const h = harness(() => Promise.resolve(response(200, fleetView())))
  const mount = await h.runtime.mount(renderFn(h))
  const header = (id: string): string => {
    const button = carrying(mount.tree, 'data-pviolin-header', id)
    assert.ok(button !== undefined, `no header for "${id}"`)
    return collectText(button)
  }

  // `off` is an effort and is printed like one, not omitted as if it were an absence.
  assert.match(header('general'), /deepseek-official\/deepseek-flash · off/)
  assert.match(header('working'), /deepseek-official\/deepseek-v4-pro · max/)
  assert.match(header('fast'), /deepseek-official\/deepseek-flash · low/)
  assert.match(
    header('arena-runners'),
    /2 models — deepseek-official\/deepseek-v4-pro · anthropic\/claude-haiku-4-5/,
    'a violin with several selections says how many and which',
  )
  assert.match(header('planning'), /no model selected — tasks here inherit the parent/)
  assert.match(header('planning'), /0 tasks/)
  assert.match(header('working'), /2 tasks/, 'the badge counts the tasks the violin owns')
})

test('a predefined violin offers no delete control; a custom one does', async () => {
  const h = harness(() => Promise.resolve(response(200, fleetView())))
  const render = renderFn(h)
  const mount = await expandAll(h, render, await h.runtime.mount(render))

  assert.deepEqual(
    attributeValues(mount.tree, 'data-pviolin-delete'),
    ['reviewer'],
    'only the custom violin may be deleted, and nothing says so until its card is open',
  )
})

test('a comparison violin shows its models and no task controls', async () => {
  const h = harness(echoingHost())
  const render = renderFn(h)
  const mount = await openViolin(h, render, await h.runtime.mount(render), 'arena-runners')

  assert.deepEqual(attributeValues(mount.tree, 'data-pviolin-remove-selection'), ['arena-runners:0', 'arena-runners:1'])
  assert.deepEqual(attributeValues(mount.tree, 'data-pviolin-add-selection'), ['arena-runners'])
  assert.equal(labelledAll(mount.tree, 'provider').length, 2, 'one provider picker per selection')
  assert.equal(labelledAll(mount.tree, 'effort').length, 2)

  const remover = carrying(mount.tree, 'data-pviolin-remove-selection', 'arena-runners:0')
  assert.ok(remover !== undefined, 'no remove control for the first selection')
  const after = await h.runtime.act(render, () => (remover.props['onClick'] as () => void)())
  assert.deepEqual(sentViolin(h, 'arena-runners').selections, [HIGH_HAIKU])
  assert.deepEqual(attributeValues(after.tree, 'data-pviolin-remove-selection'), [])
})

test('the pickers offer the catalog the payload carried, and that route’s own efforts', async () => {
  const h = harness(() => Promise.resolve(response(200, fleetView())))
  const render = renderFn(h)
  const mount = await openViolin(h, render, await h.runtime.mount(render), 'general')

  const provider = labelled(mount.tree, 'provider')
  assert.ok(provider !== undefined, 'no provider picker')
  assert.deepEqual(optionsOf(provider), ['deepseek-official:deepseek-official', 'anthropic:anthropic'])

  const model = labelled(mount.tree, 'model')
  assert.ok(model !== undefined, 'no model picker')
  assert.deepEqual(optionsOf(model), ['deepseek-flash:deepseek-flash', 'deepseek-v4-pro:deepseek-v4-pro'])

  const effort = labelled(mount.tree, 'effort')
  assert.ok(effort !== undefined, 'no effort picker')
  assert.deepEqual(optionsOf(effort), [
    ':not set (adapter default)',
    'off:off',
    'low:low',
    'high:high',
    'max:max',
  ])

  assert.equal(labelled(mount.tree, 'name')?.props['value'], 'general', 'the name field holds the label')
  // The note field is gone: the human's words were "which i didn't understand" — and it was the only
  // control on the page whose purpose needed a sentence to explain. The overlay's `description` is
  // still read (the card shows it) and still written by hand; the page no longer edits it.
  assert.equal(labelled(mount.tree, 'note'), undefined, 'no unexplained note field')

  // Another route advertises another set: the list is the route's, not a compiled-in one.
  const other = harness(() => Promise.resolve(response(200, fleetView())))
  const otherRender = renderFn(other)
  const reviewer = await openViolin(other, otherRender, await other.runtime.mount(otherRender), 'reviewer')
  const otherEffort = labelled(reviewer.tree, 'effort')
  assert.ok(otherEffort !== undefined, 'no effort picker on the custom violin')
  assert.deepEqual(optionsOf(otherEffort), [':not set (adapter default)', 'off:off', 'medium:medium', 'high:high'])
  // A file's own description still reaches the page — as the header's second line, which is the only
  // place a note is read now that the field is gone.
  assert.match(collectText(reviewer.tree), /the second opinion/)
})

test('a violin with no selection offers Add a model, which starts from a route the document has', async () => {
  const h = harness(echoingHost())
  const render = renderFn(h)
  const mount = await openViolin(h, render, await h.runtime.mount(render), 'planning')

  assert.deepEqual(attributeValues(mount.tree, 'data-pviolin-add-selection'), ['planning'])
  const adder = carrying(mount.tree, 'data-pviolin-add-selection', 'planning')
  assert.ok(adder !== undefined, 'no Add a model control')
  await h.runtime.act(render, () => (adder.props['onClick'] as () => void)())

  assert.deepEqual(
    sentViolin(h, 'planning').selections,
    [OFF_FLASH],
    'the row is copied from `general`’s first selection, never composed here',
  )
})

test('typing a name writes nothing; committing it on blur writes the document', async () => {
  const h = harness(echoingHost())
  const render = renderFn(h)
  let mount = await openViolin(h, render, await h.runtime.mount(render), 'working')
  const before = h.calls.length

  const name = labelled(mount.tree, 'name')
  assert.ok(name !== undefined, 'no name field')
  mount = await h.runtime.act(render, () =>
    (name.props['onChange'] as (event: unknown) => void)({ target: { value: 'Review crew' } }),
  )
  assert.equal(h.calls.length, before, 'a keystroke is not a write: free text commits on blur or Enter')

  const blurred = labelled(mount.tree, 'name')
  assert.ok(blurred !== undefined, 'no name field after typing')
  assert.equal(blurred.props['value'], 'Review crew', 'the typed text is what the field shows')
  await h.runtime.act(render, () => (blurred.props['onBlur'] as () => void)())
  assert.equal(sentViolin(h, 'working').name, 'Review crew')
})

test('assigning an unassigned task PUTs a document in which the chosen violin holds it', async () => {
  const h = harness(echoingHost())
  const render = renderFn(h)
  const mount = await h.runtime.mount(render)

  const select = carrying(mount.tree, 'data-pfleet-assign', 'bug-fix')
  assert.ok(select !== undefined, 'no assign picker for an unassigned task')
  const after = await h.runtime.act(render, () =>
    (select.props['onChange'] as (event: unknown) => void)({ target: { value: 'working' } }),
  )

  assert.deepEqual(sentViolin(h, 'working').tasks, ['feature', 'refactoring', 'bug-fix'])
  assert.equal(
    carrying(after.tree, 'data-pfleet-unassigned', 'bug-fix'),
    undefined,
    'an assigned task is no longer unassigned',
  )
  const working = await openViolin(h, render, after, 'working')
  assert.ok(
    carrying(working.tree, 'data-pviolin-task', 'bug-fix') !== undefined,
    'and it is a chip inside the violin it was assigned to',
  )
})

test('an unassigned task offers every violin, including the ones the host may refuse', async () => {
  const h = harness(() => Promise.resolve(response(200, fleetView())))
  const mount = await h.runtime.mount(renderFn(h))
  const picker = carrying(mount.tree, 'data-pfleet-assign', 'bug-fix')
  assert.ok(picker !== undefined, 'no picker for an unassigned task')

  // Every violin is offered. What a violin may hold is the host's rule, and a refusal that names the
  // reason teaches more than an option that is missing — so the page does not pre-filter, and a
  // comparison violin appears here even though it currently holds several models.
  assert.deepEqual(optionsOf(picker), [
    'assign to…:→',
    'general:general',
    'working:working',
    'planning:planning',
    'fast:fast',
    'vision:vision',
    'arena-runners:arena-runners',
    'arena-cross-judge-pool:arena-cross-judge-pool',
    'architect-runners:architect-runners',
    'interrogate-reviewers:interrogate-reviewers',
    'reviewer:Deep review (reviewer)',
  ])
})

test('choosing a violin from an unassigned row PUTs that task into it', async () => {
  const h = harness((_url, init) =>
    Promise.resolve(init?.method === 'PUT' ? response(200, fleetView()) : response(200, fleetView())),
  )
  const render = renderFn(h)
  const mount = await h.runtime.mount(render)
  const picker = carrying(mount.tree, 'data-pfleet-assign', 'bug-fix')
  assert.ok(picker !== undefined)
  const after = await h.runtime.act(render, () =>
    (picker.props['onChange'] as (event: unknown) => void)({ target: { value: 'planning' } }),
  )

  const put = h.calls.find((call) => call.method === 'PUT')
  assert.ok(put, `no PUT was issued: ${JSON.stringify(h.calls)}`)
  const body = JSON.parse(String(put.body)) as { violins: { id: string; tasks: string[] }[] }
  assert.deepEqual(body.violins.find((violin) => violin.id === 'planning')?.tasks, ['bug-fix'])
  assert.doesNotMatch(after.text, /bug-fix runs on general/)
})

test('a chip’s × PUTs a document with the task gone from that violin', async () => {
  const h = harness(echoingHost())
  const render = renderFn(h)
  const mount = await openViolin(h, render, await h.runtime.mount(render), 'working')

  const remover = carrying(mount.tree, 'data-pviolin-unassign', 'feature')
  assert.ok(remover !== undefined, 'no × on the task chip')
  const after = await h.runtime.act(render, () => (remover.props['onClick'] as () => void)())

  assert.deepEqual(sentViolin(h, 'working').tasks, ['refactoring'])
  assert.ok(
    carrying(after.tree, 'data-pfleet-unassigned', 'feature') !== undefined,
    'a released task shows up where it runs instead: on `general`, as unassigned',
  )
})

test('Add group writes a custom violin whose id is the slugged name', async () => {
  const h = harness(echoingHost())
  const render = renderFn(h)
  let mount = await h.runtime.mount(render)

  const opener = carrying(mount.tree, 'data-pfleet-action', 'add-group')
  assert.ok(opener !== undefined, 'no Add group control')
  mount = await h.runtime.act(render, () => (opener.props['onClick'] as () => void)())

  const input = elements(mount.tree).find((element) => element.props['data-pfleet-new-group'] !== undefined)
  assert.ok(input !== undefined, 'Add group revealed no name input')
  mount = await h.runtime.act(render, () =>
    (input.props['onChange'] as (event: unknown) => void)({ target: { value: '  Deep  Reviewers! ' } }),
  )

  const confirm = elements(mount.tree).find((element) => element.props['data-pfleet-add-group'] !== undefined)
  assert.ok(confirm !== undefined, 'no control to confirm the new group')
  const after = await h.runtime.act(render, () => (confirm.props['onClick'] as () => void)())

  const added = sentViolin(h, 'deep-reviewers')
  assert.equal(added.origin, 'custom')
  assert.deepEqual(added.tasks, [])
  assert.deepEqual(added.selections, [OFF_FLASH], 'it starts from `general`’s first selection')
  assert.deepEqual(attributeValues(after.tree, 'data-pviolin').slice(-1), ['deep-reviewers'])
  assert.equal(carrying(after.tree, 'data-pviolin', 'deep-reviewers')?.props['data-pviolin-origin'], 'custom')
})

test('the answer to a write replaces the local document, a re-derived id included', async () => {
  // `Arena runners` slugs onto the comparison violin's id. The page proposes it; the host numbers
  // a collision, and what the page shows afterwards is the host's document, not its own proposal.
  const h = harness(
    echoingHost((sent) => ({
      version: 1,
      violins: sent.violins.map((violin, index) =>
        index === sent.violins.length - 1 ? { ...violin, id: 'arena-runners-2' } : violin,
      ),
    })),
  )
  const render = renderFn(h)
  let mount = await h.runtime.mount(render)

  const opener = carrying(mount.tree, 'data-pfleet-action', 'add-group')
  assert.ok(opener !== undefined, 'no Add group control')
  mount = await h.runtime.act(render, () => (opener.props['onClick'] as () => void)())
  const input = elements(mount.tree).find((element) => element.props['data-pfleet-new-group'] !== undefined)
  assert.ok(input !== undefined, 'no name input')
  mount = await h.runtime.act(render, () =>
    (input.props['onChange'] as (event: unknown) => void)({ target: { value: 'Arena runners' } }),
  )
  const confirm = elements(mount.tree).find((element) => element.props['data-pfleet-add-group'] !== undefined)
  assert.ok(confirm !== undefined, 'no confirm control')
  const after = await h.runtime.act(render, () => (confirm.props['onClick'] as () => void)())

  assert.equal(lastPut(h).violins.filter((violin) => violin.id === 'arena-runners').length, 2, 'the proposal collides')
  const shown = attributeValues(after.tree, 'data-pviolin')
  assert.equal(shown.filter((id) => id === 'arena-runners').length, 1)
  assert.equal(shown.filter((id) => id === 'arena-runners-2').length, 1)
})

test('Refresh models re-reads the host, bypassing its cache', async () => {
  const h = harness(() => Promise.resolve(response(200, fleetView())))
  const render = renderFn(h)
  const mount = await h.runtime.mount(render)

  assert.deepEqual(h.calls.map((call) => `${call.method} ${call.url}`), ['GET /api/pstack/fleet'])

  const refresh = carrying(mount.tree, 'data-pfleet-action', 'refresh')
  assert.ok(refresh !== undefined, 'no Refresh models control')
  await h.runtime.act(render, () => (refresh.props['onClick'] as () => void)())

  assert.deepEqual(h.calls.map((call) => `${call.method} ${call.url}`), [
    'GET /api/pstack/fleet',
    'GET /api/pstack/fleet?refresh=1',
  ])
})

test('a refused write shows the host’s sentence and keeps the local edit', async () => {
  const refusal = 'violin "working" holds "feature" but the catalog no longer has its route'
  const h = harness((_url, init) =>
    Promise.resolve(
      init?.method === 'PUT'
        ? response(422, {
            ok: false,
            error: refusal,
            problems: ['violin "working" selection 1 (deepseek-official/deepseek-flash) is not in the live catalog'],
          })
        : response(200, fleetView()),
    ),
  )
  const render = renderFn(h)
  const mount = await openViolin(h, render, await h.runtime.mount(render), 'working')

  const remover = carrying(mount.tree, 'data-pviolin-unassign', 'feature')
  assert.ok(remover !== undefined, 'no × on the task chip')
  const after = await h.runtime.act(render, () => (remover.props['onClick'] as () => void)())

  const status = elements(after.tree).find((element) => element.props['data-pfleet-status'] !== undefined)
  assert.ok(status !== undefined, 'the refusal has to be on the page')
  assert.equal(status.props['data-pfleet-error'], '1')
  assert.match(collectText(status), /violin "working" holds "feature" but the catalog no longer has its route/, 'verbatim')
  assert.match(
    collectText(status),
    /violin "working" selection 1 \(deepseek-official\/deepseek-flash\) is not in the live catalog/,
    'and its problems, on their own lines',
  )

  // The edit stays on screen, because the sentence names the offender and the fix is that edit.
  assert.equal(carrying(after.tree, 'data-pviolin-unassign', 'feature'), undefined)
  assert.ok(carrying(after.tree, 'data-pfleet-unassigned', 'feature') !== undefined)
})

test('the status line carries the host’s own sentences, and stays away when there is nothing to say', async () => {
  const loud = harness(() =>
    Promise.resolve(
      response(
        200,
        fleetView({
          repairs: ['added the missing violin "vision"'],
          groupsError: 'fleet groups file is not valid JSON: Unexpected token }',
          problems: ['violin "working" selection 1 (deepseek-official/deepseek-flash) is not in the live catalog'],
          modelSelection: { namespace: 'subagent-model-selection', present: true, enabled: true },
        }),
      ),
    ),
  )
  const loudMount = await loud.runtime.mount(renderFn(loud))
  const status = elements(loudMount.tree).find((element) => element.props['data-pfleet-status'] !== undefined)
  assert.ok(status !== undefined, 'the host said something and the page has to pass it on')
  const shown = collectText(status)
  assert.match(shown, /added the missing violin "vision"/)
  assert.match(shown, /fleet groups file is not valid JSON: Unexpected token \}/)
  assert.match(shown, /violin "working" selection 1 \(deepseek-official\/deepseek-flash\) is not in the live catalog/)
  assert.match(shown, /the stock subagent tool picks its own models; pstack_spawn does not/)

  const quiet = harness(() => Promise.resolve(response(200, fleetView())))
  const quietMount = await quiet.runtime.mount(renderFn(quiet))
  // The region is mounted permanently and *silent* (`role="status"`, no text), because a live region
  // inserted at the same moment its sentence arrives is announced inconsistently. What "says
  // nothing" now means is that it carries no text — see the live-region test below.
  const quietStatus = elements(quietMount.tree).find(
    (element) => element.props['data-pfleet-status'] !== undefined,
  )
  assert.ok(quietStatus !== undefined, 'the region is mounted even when it has nothing to say')
  assert.equal(textOf(quietStatus), '', 'a healthy fleet earns no sentence at all')
  assert.equal(quietStatus.props['data-pfleet-error'], undefined, 'and no error marker')
  assert.doesNotMatch(quietMount.text, /picks its own models/, 'and no sentence about a preference that is off')
})

test('every task key is accounted for exactly once: a chip, a comparison violin, or an unassigned row', async () => {
  const h = harness(() => Promise.resolve(response(200, fleetView())))
  const render = renderFn(h)
  const mount = await expandAll(h, render, await h.runtime.mount(render))

  // A comparison key is accounted for by the violin that bears its name — that violin *is* the
  // assignment — so it is neither a chip nor an unassigned row, and the page must not show it twice.
  const seen = [
    ...attributeValues(mount.tree, 'data-pviolin-task'),
    ...attributeValues(mount.tree, 'data-pfleet-unassigned'),
    ...PANEL_ROLES,
  ]
  for (const key of TASK_KEYS) {
    assert.equal(seen.filter((entry) => entry === key).length, 1, `"${key}" must appear exactly once`)
  }
  assert.equal(seen.length, TASK_KEYS.length, 'and nothing is listed that is not a task key')
  assert.deepEqual(
    attributeValues(mount.tree, 'data-pviolin-task').filter((task) => PANEL_ROLES.includes(task)),
    [],
    'no comparison violin wears its own name as a chip',
  )
})

test('a violin the page cannot place is named, rather than its tasks silently leaving the page', async () => {
  const odd: RawGroups = {
    version: 1,
    violins: [rawViolin('odd', 'sandbox', [OFF_FLASH], ['feature'])],
  }
  const h = harness(() => Promise.resolve(response(200, fleetView({ groups: odd }))))
  const mount = await h.runtime.mount(renderFn(h))

  assert.equal(carrying(mount.tree, 'data-pviolin', 'odd'), undefined, 'no band can hold a violin whose origin is unknown')
  assert.match(mount.text, /groups\.violins\[0\] \("odd"\) has origin "sandbox"/)
  assert.match(mount.text, /cannot read the host's response/)
})

test('an empty catalog and an empty fleet render a page, not a blank one', async () => {
  const nothing = harness(() =>
    Promise.resolve(
      response(
        200,
        fleetView({
          groups: { version: 1, violins: [] },
          catalog: {
            routes: [],
            unavailable: [{ provider: 'pi-ai', why: 'credential "PI_API_KEY" is not configured' }],
          },
          taskKeys: [],
          panelRoles: [],
        }),
      ),
    ),
  )
  const mount = await nothing.runtime.mount(renderFn(nothing))
  assert.deepEqual(attributeValues(mount.tree, 'data-pfleet-page'), ['violins'])
  assert.equal(carrying(mount.tree, 'data-pfleet-band', 'predefined'), undefined, 'no violins, no bands')
  const silence = elements(mount.tree).find((element) => element.props['data-pfleet-status'] !== undefined)
  assert.ok(silence !== undefined, 'the live region is mounted whether or not it has something to say')
  assert.equal(textOf(silence), '', 'the host had nothing to report, so the page says nothing')
  assert.deepEqual(attributeValues(mount.tree, 'data-pfleet-action'), ['refresh', 'add-group'])
})

test('a selection the catalog does not have yields no options, never a slug of this page’s own', async () => {
  const ghost: RawGroups = {
    version: 1,
    violins: [rawViolin('general', 'predefined', [{ provider: 'ghost-vendor', model: 'ghost-model' }], ['feature'])],
  }
  const h = harness(() => Promise.resolve(response(200, fleetView({ groups: ghost, catalog: { routes: [], unavailable: [] } }))))
  const render = renderFn(h)
  const mount = await openViolin(h, render, await h.runtime.mount(render), 'general')

  assert.match(
    collectText(carrying(mount.tree, 'data-pviolin-header', 'general')),
    /ghost-vendor\/ghost-model/,
    'the header still states what the file says',
  )
  assert.deepEqual(optionsOf(labelled(mount.tree, 'model') as Element), [], 'and the picker offers nothing it cannot read')
  assert.deepEqual(optionsOf(labelled(mount.tree, 'effort') as Element), [':not set (adapter default)'])
})

test('moving a picker and deleting a custom group each write the document at once', async () => {
  const h = harness(echoingHost())
  const render = renderFn(h)
  let mount = await openViolin(h, render, await h.runtime.mount(render), 'reviewer')

  const effort = labelled(mount.tree, 'effort')
  assert.ok(effort !== undefined, 'no effort picker')
  mount = await h.runtime.act(render, () =>
    (effort.props['onChange'] as (event: unknown) => void)({ target: { value: 'high' } }),
  )
  assert.deepEqual(sentViolin(h, 'reviewer').selections, [
    { provider: 'anthropic', model: 'claude-haiku-4-5', reasoningEffort: 'high', description: 'the second opinion' },
  ])

  const remove = carrying(mount.tree, 'data-pviolin-delete', 'reviewer')
  assert.ok(remove !== undefined, 'no Delete group control on a custom violin')
  const after = await h.runtime.act(render, () => (remove.props['onClick'] as () => void)())

  assert.equal(lastPut(h).violins.some((violin) => violin.id === 'reviewer'), false)
  assert.equal(attributeValues(after.tree, 'data-pviolin').includes('reviewer'), false)
  assert.ok(
    carrying(after.tree, 'data-pfleet-unassigned', 'how-explainer') !== undefined,
    'the tasks the group held are unassigned again, which is where they run',
  )
})

test('the shell primitive is required and never a dependency, and its absence is survivable', async () => {
  const h = harness()
  assert.deepEqual(h.required, ['react', PRIMITIVES_ID], 'the primitives package is seeded by the shell')

  // A shell that stopped seeding it: the page still mounts and still shows its controls, because a
  // hover is an explanation and never the only way to reach something.
  const bare = harness(() => Promise.resolve(response(200, fleetView())), { primitives: false })
  const mount = await bare.runtime.mount(renderFn(bare))
  assert.equal(attributeValues(mount.tree, 'data-tooltip').length, 0)
  assert.deepEqual(attributeValues(mount.tree, 'data-pfleet-action'), ['refresh', 'add-group'])
  assert.ok(carrying(mount.tree, 'data-pfleet-assign', 'bug-fix'), 'and the pickers are still there')
})

test('tooltips explain the controls and the tasks, in the shell\'s own bubble', async () => {
  const payload = fleetView()
  const h = harness(() => Promise.resolve(response(200, payload)))
  const render = renderFn(h)
  const mount = await h.runtime.mount(render)

  const labels = attributeValues(mount.tree, 'data-tooltip')
  // The toolbar explains itself rather than carrying standing prose (the human's ask).
  assert.ok(labels.some((label) => /live route catalog/.test(label)), `no toolbar tooltip in ${JSON.stringify(labels)}`)
  assert.ok(labels.some((label) => /named group of model selections/.test(label)))
  // Both buttons sit inside a hover, which is why the wrapper has to render through.
  assert.deepEqual(attributeValues(mount.tree, 'data-pfleet-action'), ['refresh', 'add-group'])

  // `working` holds two tasks in this fixture, so its chips are where the per-task marks live.
  const opened = await openViolin(h, render, mount, 'working')
  const card = carrying(opened.tree, 'data-pviolin', 'working')
  assert.ok(card !== undefined, 'the working card is not in the tree')
  const chips = elements(card)
    .filter((element) => element.props['data-pviolin-task'] !== undefined)
    .map((element) => element.props['data-pviolin-task'])
  assert.deepEqual(chips, ['feature', 'refactoring'], 'the chips are what the hovers hang off')

  // The chip itself carries the explanation: what the task is, and where it runs now.
  const labelsInCard = elements(card)
    .map((element) => element.props['data-tooltip'])
    .filter((value): value is string => typeof value === 'string')
  assert.ok(
    labelsInCard.some((label) => /builds a feature end to end/.test(label) && /currently runs on working/.test(label)),
    `the chip explains its own task; labels were ${JSON.stringify(labelsInCard)}`,
  )
  // And the label it explains is inside that chip, not squeezed out of it: the first screenshot
  // showed three chips whose key had vanished, which is why the `?` no longer sits in the chip.
  assert.deepEqual(
    elements(card)
      .filter((element) => element.props['data-pchip-label'] !== undefined)
      .map((element) => element.props['data-pchip-label']),
    ['feature', 'refactoring'],
    'each chip holds its own task key',
  )
  assert.equal(
    expandAllElements(card).filter((element) => element.props['data-phelp'] !== undefined).length,
    0,
    'no separate mark: the chip is the explanation',
  )
})

test('there is no Save button, no JSON editor, no catalog table and no credential prose', async () => {
  const h = harness(() => Promise.resolve(response(200, fleetView())))
  const mount = await h.runtime.mount(renderFn(h))

  assert.equal(controls(mount.tree, 'input').length, 0, 'there is no text field to fill before anything changes')
  assert.equal(elements(mount.tree).filter((element) => element.type === 'textarea').length, 0)
  assert.doesNotMatch(mount.text, /save/i)
  assert.doesNotMatch(mount.text, /UNVERIFIED|credential/)
  assert.equal(elements(mount.tree).filter((element) => element.type === 'table').length, 0)

  // The toolbar is the title row, and it holds the two controls and nothing else.
  const row = elements(mount.tree).find((element) =>
    element.children.some(
      (child) => typeof child === 'object' && child !== null && (child as Element).type === 'h2',
    ),
  )
  assert.ok(row !== undefined, 'no title row')
  assert.deepEqual(
    elements(row)
      .filter((element) => element.type === 'button')
      .map((element) => textOf(element)),
    ['Refresh models', 'Add group'],
  )
  assert.deepEqual(attributeValues(mount.tree, 'data-pfleet-action'), ['refresh', 'add-group'])
})

// ---------------------------------------------------------------------------------------------
// The real payload. `tests/fixtures/fleet-view.live.json` is what a live Host answered, captured
// with `curl -s http://127.0.0.1:3096/api/pstack/fleet > tests/fixtures/fleet-view.live.json`
// against a throwaway profile.
//
// This is the diagnostic that explains the earlier blank page: a bundle that had
// drifted from the payload, and a hand-written fixture cannot catch that drift because it is
// written by the same hand. A stale capture is harmless — the assertions are about the shape, not
// about which models this machine happens to have.
// ---------------------------------------------------------------------------------------------

/** The captured live payload, read from disk rather than remembered. */
function livePayload(): Record<string, unknown> {
  const path = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fleet-view.live.json')
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

test('the page mounts the payload a live Host really answers, with every violin and task on it', async () => {
  const payload = livePayload()
  const h = harness(() => Promise.resolve(response(200, payload)))
  const mount = await h.runtime.mount(renderFn(h))

  assert.ok(carrying(mount.tree, 'data-pfleet-page', 'violins'), 'the page root')
  assert.doesNotMatch(mount.text, /cannot read the host's response/, 'the guard must not trip on a real payload')
  assert.equal(attributeValues(mount.tree, 'data-pfleet-error').length, 0)

  const groups = payload['groups'] as { violins: { id: string; origin: string; tasks: string[] }[] }
  assert.deepEqual(
    attributeValues(mount.tree, 'data-pviolin'),
    groups.violins.map((violin) => violin.id),
    'one card per violin, in the payload order',
  )

  // Every task key is on the page exactly once: a chip inside its violin, or an unassigned row.
  const unassigned = payload['unassigned'] as string[]
  assert.deepEqual(attributeValues(mount.tree, 'data-pfleet-unassigned'), unassigned)
  const chips = attributeValues(mount.tree, 'data-pviolin-task')
  assert.deepEqual(chips, [], 'a collapsed violin shows no chips')
  const assigned = groups.violins.flatMap((violin) => violin.tasks)
  assert.deepEqual(
    [...new Set([...unassigned, ...assigned])].sort(),
    [...(payload['taskKeys'] as string[])].sort(),
    'and between the rows and the assignments, every key the build knows is accounted for',
  )
})

test('the live payload, expanded: a comparison violin shows its models, never a task chip', async () => {
  const payload = livePayload()
  const h = harness(() => Promise.resolve(response(200, payload)))
  const render = renderFn(h)
  const groups = payload['groups'] as { violins: { id: string; origin: string; selections: unknown[]; tasks: string[] }[] }
  const comparison = groups.violins.find((violin) => violin.origin === 'comparison')
  assert.ok(comparison, 'the live payload has a comparison violin')

  const mount = await h.runtime.mount(render)
  const header = carrying(mount.tree, 'data-pviolin-header', comparison.id)
  assert.ok(header, `no header for ${comparison.id}`)
  const opened = await h.runtime.act(render, () => (header.props['onClick'] as () => void)())

  // The violin *is* the task: it shows the models it will run on, and no task chip — a chip reading
  // `arena-runners` inside the violin `arena-runners` says nothing and was the redundancy a reader
  // spotted in the screenshot.
  assert.deepEqual(attributeValues(opened.tree, 'data-pviolin-task'), [], 'no task chips on a comparison violin')
  assert.equal(carrying(opened.tree, 'data-pviolin-assign', comparison.id), undefined, 'and no task picker')
  assert.match(collectText(opened.tree), new RegExp(`${String(comparison.selections.length)} models`))
  assert.match(
    collectText(opened.tree),
    comparison.id === 'arena-cross-judge-pool' ? /one is picked per run/ : /one child per model/,
    'the header says what the list means — a fan-out and a pool are not the same thing',
  )
})

// ---------------------------------------------------------------------------------------------
// The page without a mouse: what an assistive technology is handed.
//
// The assertions below are written against the DOM the page renders, not against the source text,
// because the question is what a screen reader meets — a `role` on the element, a name on the
// control. The two tests that matter most (the refused write, the nine pickers) are written so
// that the *old* behaviour fails them: see the report for the seeded failure of each.
// ---------------------------------------------------------------------------------------------

test('a refused write lands in a live region that was already on the page, so it is announced', async () => {
  const refusal = 'violin "working" holds "feature" but the catalog no longer has its route'
  const h = harness((_url, init) =>
    Promise.resolve(
      init?.method === 'PUT'
        ? response(422, { ok: false, error: refusal, problems: ['selection 1 is not in the live catalog'] })
        : response(200, fleetView()),
    ),
  )
  const render = renderFn(h)

  // 1. The region is mounted *before* any refusal: a live region inserted at the same moment its
  //    text arrives is announced inconsistently, which is the whole defect.
  const before = await h.runtime.mount(render)
  const region = elements(before.tree).find((element) => element.props['data-pfleet-status'] !== undefined)
  assert.ok(region !== undefined, 'the status region must be on the page before it has anything to say')
  assert.equal(textOf(region), '', 'and silent while there is nothing to report')

  // 2. It is a live region, polite while it is only a note…
  assert.equal(region.props['role'], 'status')
  assert.equal(region.props['aria-live'], 'polite')

  // 3. …and it becomes an interrupting one when the host refuses a write.
  const opened = await openViolin(h, render, before, 'working')
  const remover = carrying(opened.tree, 'data-pviolin-unassign', 'feature')
  assert.ok(remover !== undefined, 'no × on the task chip')
  const after = await h.runtime.act(render, () => (remover.props['onClick'] as () => void)())

  const shouted = elements(after.tree).find((element) => element.props['data-pfleet-status'] !== undefined)
  assert.ok(shouted !== undefined, 'the region survives the refusal')
  assert.equal(shouted.props['role'], 'alert', 'a refusal interrupts; a note does not')
  assert.equal(shouted.props['aria-live'], 'assertive')
  assert.equal(shouted.props['data-pfleet-error'], '1')
  assert.match(
    textOf(shouted),
    /violin "working" holds "feature" but the catalog no longer has its route/,
    'and the region carries the host’s own sentence, which is what the screen reader reads out',
  )
})

test('every provider, model and effort picker is named after the violin it edits', async () => {
  const h = harness(() => Promise.resolve(response(200, fleetView())))
  const render = renderFn(h)
  const mount = await expandAll(h, render, await h.runtime.mount(render))

  // Nine cards render the same three pickers. The `<label>` wrapper can only ever say `provider`,
  // so the distinguishing name has to be on the control itself. `data-pviolin-name` is the card's
  // own name field, which the fixture and the host both fill from the violin's `name`.
  //
  // A violin with **no** selection renders no picker at all (its card says what its tasks do
  // instead), so the expectation is derived from the fixture's selections rather than from the
  // violin list — that is the same rule the page follows.
  const expected = groupsFixture().violins.flatMap((violin) =>
    violin.selections.flatMap(() => (['provider', 'model', 'effort'] as const).map((field) => ({ violin, field }))),
  )
  assert.ok(expected.length > 20, 'the fixture has to actually exercise many pickers')

  for (const { violin, field } of expected) {
    const card = carrying(mount.tree, 'data-pviolin', violin.id)
    assert.ok(card !== undefined, `no card for "${violin.id}"`)
    const nameInput = carrying(card, 'data-pviolin-name', violin.id)
    assert.ok(nameInput !== undefined, `no name field in "${violin.id}"`)
    const shown = String(nameInput.props['value'])
    const control = elements(card).find(
      (element) => element.type === 'select' && element.props['aria-label'] === `${field} for ${shown}`,
    )
    assert.ok(
      control !== undefined,
      `no "${field}" picker named after "${shown}" inside the card for "${violin.id}"`,
    )
  }

  // The bare name is what the old build produced on all nine cards; it must be gone.
  assert.deepEqual(
    elements(mount.tree)
      .filter((element) => element.type === 'select' && element.props['aria-label'] === 'provider')
      .map((element) => element.props['aria-label']),
    [],
    'no picker announces as the bare word "provider" any more',
  )
  assert.equal(
    elements(mount.tree).filter((element) => element.type === 'select' && String(element.props['aria-label']).includes(' for ')).length,
    expected.length,
    'and every select in a card carries a violin-qualified name',
  )

  // Two more names the same rule covers: the assign picker (6.2) and the new-group field (6.7).
  assert.ok(
    elements(mount.tree).some((element) => element.props['aria-label'] === 'assign a task to working'),
    'the assign picker names the violin the task is going to',
  )
})

test('the remove control on a selection has a name, and the name is not "×"', async () => {
  const h = harness(() => Promise.resolve(response(200, fleetView())))
  const render = renderFn(h)
  // A comparison violin carries two selections, which is when the remove button appears at all.
  const mount = await openViolin(h, render, await h.runtime.mount(render), 'arena-runners')

  const removers = elements(mount.tree).filter(
    (element) => element.props['data-pviolin-remove-selection'] !== undefined,
  )
  assert.equal(removers.length, 2, 'one remove control per selection on a two-model violin')

  // The names must be the ones the fixture's two selections imply, in selection order.
  assert.deepEqual(
    removers.map((remover) => remover.props['aria-label']),
    [
      'remove model 1 (deepseek-official/deepseek-v4-pro) from arena-runners',
      'remove model 2 (anthropic/claude-haiku-4-5) from arena-runners',
    ],
  )
  for (const remover of removers) {
    const name = remover.props['aria-label']
    assert.notEqual(name, '×', 'the name must not be the glyph')
    assert.notEqual(name, undefined, 'and it must exist at all')
  }
})
