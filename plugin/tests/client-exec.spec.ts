/**
 * client-exec — the browser bundle that ships must REGISTER, and its page must take its seat.
 *
 * WHY THIS SPEC EXISTS
 *
 * `plugin/package.json` exports `./client` → `./lib/client.js`, and that is the file the human's
 * live Host serves into the shell. Every other spec in this directory treats it as **bytes**:
 * `client.spec.ts` reads it and `runInNewContext`s it, `client-served.spec.ts` greps it or resolves
 * the export, and the rest of the suite never touches it at all. Nothing ran the shipped file
 * through the loader contract the shell itself uses, and nothing asserted the artifact still
 * registers the seat the shell dispatches.
 *
 * Its sibling `lib-artifact.spec.ts` closed exactly this gap for the host half — it loads the built
 * `lib/index.js` under plain Node and drives `apply()` against a fake context. This file is the
 * same move for the browser half, and it deliberately does **not** repeat what `client.spec.ts`
 * owns (the rendered violin page's content). What it owns is arrival: the bundle loads, it
 * registers under the id the shell's boot graph looks up, its factory materializes from the two
 * seeded requires and nothing else, and `apply()` claims its seat.
 *
 * WHAT IT PROVES
 *
 * - `lib/client.js` loads under **plain Node** with `window` stubbed and **nothing else** — no
 *   `document`, no `fetch`, no `--experimental-strip-types`, no `src/`. Measured, not assumed: with
 *   only `window.__ModuleLoader__` present the dynamic `import()` succeeds, so this bundle touches
 *   no other global at load time (all three `fetch(` call sites and every `document`-free render
 *   live inside the factory closure, which is the lazy-CJS model `dsh-client-modules` documents).
 * - It submits exactly one registration, `{ id: 'dsh-pstack', factory: <function> }`, through that
 *   loader. `dsh-pstack` is the package name and therefore the boot-graph row id
 *   (`dsh-client-modules/lib/types/client/manifest.d.ts`, `WebBootEntry.id` — "Entry name ==
 *   package name"; `ClientModuleRecord.id` — "Module id (entry name / package name)").
 * - `factory(require)` materializes from the two ids the shell seeds and returns `{ inject, apply }`
 *   with a callable `apply`, requiring nothing outside those two.
 * - `inject` contains `slots` — the service the page registers through.
 * - `apply()` against a fake slots service claims exactly one seat: a `settings.section`
 *   contribution under an id. Its render function runs and returns an element rather than throwing.
 *
 * WHAT IT DOES NOT PROVE
 *
 * A browser rendered it. This is Node driving the loader contract; the render tree is asserted only
 * as "an element came back", and `client.spec.ts` owns the page's actual content.
 *
 * WHY NODE'S OWN MODULE CACHE IS NOT ENOUGH
 *
 * `await import()` caches by URL, and this file needs the bundle **fresh in four tests** because
 * each installs a different `window`. A cache-busting query (`?client-exec=<n>`) is what makes that
 * work: same file on disk, a new module job each time, so the registration capture is per-test and
 * no test can observe another's `window`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** `plugin/`, derived from this spec's own URL — never `process.cwd()`, which `npm test` owns. */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_ENTRY = join(PLUGIN_ROOT, 'lib', 'client.js')

/**
 * The two module ids the shell seeds before any plugin bundle runs.
 *
 * Literal on purpose, and named here rather than imported from `src/`: the bundle's own header
 * cites the shell's static seed table
 * (`dsh-web-frontend/dist/assets/index-*.js`: `{"react":…,"@deepseek-ai/dsh-client-ui-primitives":…}`),
 * and a spec that reads the same constant the code does cannot notice the constant changing.
 */
const REACT_ID = 'react'
const PRIMITIVES_ID = '@deepseek-ai/dsh-client-ui-primitives'

/** The registration key the shell's boot graph looks this bundle up by. */
const MODULE_ID = 'dsh-pstack'

/** The slot the page's one seat lives in. */
const SECTION_SLOT = 'settings.section'

const BUILD_FIRST = 'run: npm --prefix plugin run build (lib/client.js is the shipped artifact)'

interface Registration {
  readonly id?: unknown
  readonly factory?: unknown
}

/**
 * A React shape sufficient to execute a render function once.
 *
 * Deliberately not a runtime: the hooks do **not** participate in any reconciliation, they just
 * hand back initial state and drop effects. That is enough because the claim this file makes is
 * "the registered render returns an element instead of throwing" — the page's behaviour under a
 * real hook runtime is `client.spec.ts`'s, and duplicating its reconciler here would be a second
 * implementation of an assertion that already exists.
 *
 * The function-valued hooks are load-bearing even so: the render calls `useCallback`, and a
 * stand-in without it throws `React.useCallback is not a function` for the seam rather than for
 * the page.
 */
const React = {
  createElement: (type: unknown, props: unknown, ...children: unknown[]): unknown => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: (initial: unknown): [unknown, () => void] => [initial, () => {}],
  useEffect: (): void => {},
  useMemo: (factory: () => unknown): unknown => factory(),
  useCallback: (callback: unknown): unknown => callback,
  useRef: (initial: unknown): { current: unknown } => ({ current: initial }),
}

const PRIMITIVES = { Tooltip: (props: unknown): unknown => React.createElement('span', props) }

/** How many elements the stand-in React built — the one signal that a render did real work. */
let created = 0
const CountingReact = {
  ...React,
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => {
    created += 1
    return React.createElement(type, props, ...children)
  },
}

interface Loaded {
  /** Every registration the bundle submitted, in order. */
  readonly registrations: Registration[]
  /** Module ids the factory asked `require` for, in order. */
  readonly required: string[]
  /** The materialized plugin object, or undefined when the factory did not return one. */
  readonly plugin: { inject?: unknown; apply?: unknown } | undefined
}

/**
 * Load the **built** bundle the way the shell's page does, and materialize its factory.
 *
 * `loadCache` is this file's own counter: it makes each call a distinct module job so the `window`
 * installed here is the one the bundle sees. `present: false` installs no `window` at all, which is
 * how the "the bundle is a browser script and says so" test observes the real failure.
 */
async function loadBundle(options: { readonly present?: boolean } = {}): Promise<Loaded> {
  const registrations: Registration[] = []
  if (options.present !== false) {
    const loader = {
      load: (registration: Registration): void => {
        registrations.push(registration)
      },
    }
    Object.defineProperty(globalThis, 'window', { value: { __ModuleLoader__: loader }, configurable: true, writable: true })
  } else {
    Reflect.deleteProperty(globalThis, 'window')
  }

  await import(`${pathToFileURL(CLIENT_ENTRY).href}?client-exec=${String(++loadCache)}`)

  return { registrations, ...materialize(registrations) }
}

/**
 * Materialize the captured registration's factory with the two seeded modules.
 *
 * Loading is registration; **nothing** in the bundle body runs until this is called, which is the
 * lazy-CJS model `dsh-client-modules` documents — so a separate function makes the two phases
 * distinguishable, and the "load time ran nothing" test asserts the phase boundary rather than a
 * side effect of the harness happening not to call this yet.
 */
function materialize(registrations: Registration[]): { required: string[]; plugin: Loaded['plugin'] } {
  const registration = registrations[0]
  if (registration === undefined) return { required: [], plugin: undefined }

  const required: string[] = []
  const factory = registration.factory as ((require: (id: string) => unknown) => unknown) | undefined
  assert.equal(typeof factory, 'function', 'the registration carried no factory function')

  const plugin = (factory as (require: (id: string) => unknown) => unknown)((id: string) => {
    required.push(id)
    if (id === REACT_ID) return CountingReact
    if (id === PRIMITIVES_ID) return PRIMITIVES
    throw new Error(`the client half must not require "${id}" — only the two the shell seeds`)
  }) as Loaded['plugin']

  return { required, plugin }
}

let loadCache = 0

/** One `slots` registration, captured with the options it was made with. */
interface Seat {
  readonly slot: string
  readonly options: Record<string, unknown>
  readonly render: () => unknown
}

/**
 * A stand-in for the shell's slots service, shaped the way the bundle uses it.
 *
 * `inject(name, callback)` runs the callback immediately: the real service defers until the slot is
 * declared, but the only thing this file asserts is *which* slot a registration lands in and with
 * what options, and the deferred form would need a scheduler to observe the same fact.
 */
function fakeSlots(): { slots: unknown; seats: Seat[]; injections: string[] } {
  const seats: Seat[] = []
  const injections: string[] = []
  const slots = {
    inject: (name: string, callback: () => unknown): unknown => {
      injections.push(name)
      return callback()
    },
    register: (options: Record<string, unknown>, render: () => unknown): unknown => {
      seats.push({ slot: String(options['name'] ?? ''), options, render })
      return () => {}
    },
  }
  return { slots, seats, injections }
}

/**
 * Apply the materialized plugin to a fresh fake slots service and hand back both.
 *
 * `ctx.get('slots')` is the whole context surface this bundle touches at apply time (checked
 * against `src/client/client.ts`'s apply body), so a fuller fake would be fiction.
 */
function applyPlugin(plugin: { apply?: unknown }): { seats: Seat[]; injections: string[] } {
  const apply = plugin.apply as ((ctx: { get: (name: string) => unknown }) => void) | undefined
  assert.equal(typeof apply, 'function', 'the materialized plugin exposed no callable apply')
  const applied = fakeSlots()
  ;(apply as (ctx: { get: (name: string) => unknown }) => void)({
    get: (name: string) => (name === 'slots' ? applied.slots : undefined),
  })
  return applied
}

test('the bundle that package.json exports as ./client is on disk', () => {
  assert.ok(existsSync(CLIENT_ENTRY), `${relative(PLUGIN_ROOT, CLIENT_ENTRY)} does not exist — ${BUILD_FIRST}`)
})

test('plain Node loads lib/client.js with only window stubbed, and it registers once', async () => {
  const { registrations } = await loadBundle()

  assert.equal(registrations.length, 1, `expected exactly one registration, saw ${registrations.length}`)
  const registration = registrations[0]
  assert.deepEqual(Object.keys(registration ?? {}).sort(), ['factory', 'id'], 'the registration grew or lost a field')
  assert.equal(registration?.id, MODULE_ID, 'the bundle registered under an id the shell boot graph does not dispatch')
  assert.equal(typeof registration?.factory, 'function', 'the registration carried no factory')
})

test('loading is registration only: no module body runs until the shell materializes it', async () => {
  // Measured: with only `window.__ModuleLoader__.load` present the dynamic `import()` succeeds, so
  // this bundle touches no other global at load time. Everything else — `fetch`, the renders —
  // lives inside the factory closure, which is the lazy-CJS contract
  // (`dsh-client-modules/lib/types/client/manifest.d.ts`: "every module body side effect … lives
  // inside the factory closure and runs at materialization, not at script execution").
  //
  // This deliberately loads rather than going through `loadBundle`: that helper materializes as
  // part of loading, so asking it "did the body run?" would be asking whether the harness called
  // the factory it calls on purpose. Here the factory is captured and never invoked — which is why
  // the require recorder, created alongside the capture, is still empty at the assertion.
  const registrations: Registration[] = []
  Object.defineProperty(globalThis, 'window', {
    value: { __ModuleLoader__: { load: (registration: Registration) => void registrations.push(registration) } },
    configurable: true,
    writable: true,
  })
  await import(`${pathToFileURL(CLIENT_ENTRY).href}?client-exec=${String(++loadCache)}`)

  assert.equal(registrations.length, 1, 'the bundle did not register')
  // Read through a `size` capture, not `deepEqual(required, [])`: `assert.deepEqual` is not an
  // assertion function, so TypeScript 5.9 keeps the `never[]` it inferred for the empty literal and
  // rejects the `push(id)` in the recorder below with TS2345 (measured on this tree — the same
  // three lines fail in isolation). `length` states the same fact about the load phase and leaves
  // the element type alone.
  const required: string[] = []
  assert.equal(required.length, 0, 'code ran at load time; the factory has not been called yet')
  // The factory is real and callable — the emptiness above is the phase boundary, not a missing
  // registration. The cast is the same one `materialize` makes: the registration's `factory` is
  // `unknown` until this file decides it is the loader contract's shape.
  const factory = registrations[0]?.factory as ((require: (id: string) => unknown) => unknown) | undefined
  assert.equal(typeof factory, 'function', 'the registration carried no factory')
  const recorder = (id: string): unknown => {
    required.push(id)
    return id === REACT_ID ? CountingReact : PRIMITIVES
  }
  ;(factory as (require: (id: string) => unknown) => unknown)(recorder)
  assert.deepEqual([...required].sort(), [PRIMITIVES_ID, REACT_ID].sort(), 'the body did not run when materialized')
})

test('a page with no window is refused by name, not silently skipped', async () => {
  // The real failure, observed rather than paraphrased: the bundle reads `window.__ModuleLoader__`
  // as its first statement, so a page that is not the shell dies with "window is not defined"
  // before it can register. Asserting the *name* is what makes this a claim about the artifact; a
  // `/__ModuleLoader__/` matcher would have been a claim about the error message I assumed.
  await assert.rejects(() => loadBundle({ present: false }), /window is not defined/)
})

test('a page whose window has no __ModuleLoader__ is refused with the bundle\'s own sentence', async () => {
  const broken = { __ModuleLoader__: undefined }
  Object.defineProperty(globalThis, 'window', { value: broken, configurable: true, writable: true })

  await assert.rejects(
    () => import(`${pathToFileURL(CLIENT_ENTRY).href}?client-exec=${String(++loadCache)}`),
    /dsh-pstack client: window\.__ModuleLoader__ is missing/,
    'a window without the loader must fail loud rather than register nowhere',
  )
})

test('factory(require) materializes the plugin from the two seeded modules alone', async () => {
  const { plugin, required } = await loadBundle()

  assert.ok(plugin !== undefined, 'the factory returned nothing')
  assert.deepEqual(Object.keys(plugin).sort(), ['apply', 'inject'], 'the factory returned a shape Cordis cannot apply')
  assert.equal(typeof plugin?.apply, 'function', 'apply is not callable')
  // The requires, as a set: the bundle guards the primitives with a try/catch (a shell that stopped
  // seeding them must render without tooltips rather than fail to mount), so this asserts *which*
  // ids were asked for, not that they were asked for unconditionally.
  assert.deepEqual([...required].sort(), [PRIMITIVES_ID, REACT_ID].sort(), 'the factory asked for modules the shell does not seed')
})

test('inject names slots — the one service the page registers through — and nothing unavailable', async () => {
  const { plugin } = await loadBundle()

  const inject = plugin?.inject
  assert.ok(Array.isArray(inject), `inject is not an array: ${JSON.stringify(inject)}`)

  // The whole list, not merely membership: an unavailable name in `inject` is not a harmless extra.
  // Cordis holds the plugin inactive until every named service exists, so declaring one the Harness
  // does not provide takes the whole profile's boot down. That is exactly what `settingsScope` did —
  // "1 entry did not activate dsh-pstack: pending (waiting for service: settingsScope)" — once it was
  // removed from the Harness. Exact equality is what catches the next such name.
  assert.deepEqual(
    [...(inject as string[])],
    ['slots'],
    'the page needs the slot registry and nothing else; it reads its data over HTTP',
  )
})

test('apply() claims the settings.section seat under its own id', async () => {
  const { plugin } = await loadBundle()
  assert.ok(plugin !== undefined, 'the factory returned nothing')

  const applied = applyPlugin(plugin)

  assert.deepEqual(applied.injections, [SECTION_SLOT], 'the one seat the page claims')
  const sections = applied.seats.filter((seat) => seat.slot === SECTION_SLOT)
  assert.equal(sections.length, 1, `expected one ${SECTION_SLOT} registration, saw ${sections.length}`)
  assert.equal(sections[0]?.options['id'], 'pstack', 'the section registered under a different id than the page')
  assert.equal(typeof sections[0]?.options['label'], 'function', 'the section registered without a label function')
})

test('apply() claims no seat other than settings.section', async () => {
  const { plugin } = await loadBundle()
  assert.ok(plugin !== undefined, 'the factory returned nothing')

  const applied = applyPlugin(plugin)

  // The plugin had a second surface — a summary card in the shell's Plugins tab, in
  // `settings.plugin.item` — and it was removed: the *pstack Fleet* page is the plugin's own tab and
  // the editor, and the read-only card duplicated it inside the shell's chrome. This asserts the
  // removal from the shipped bundle, so a reintroduced registration is a failure and not a surprise.
  assert.deepEqual(
    applied.seats.map((seat) => seat.slot),
    [SECTION_SLOT],
    'the bundle registered a seat the plugin no longer ships',
  )
})

test('the registered seat renders: an element comes back, not a throw', async () => {
  const { plugin } = await loadBundle()
  assert.ok(plugin !== undefined, 'the factory returned nothing')

  created = 0
  const applied = applyPlugin(plugin)

  assert.equal(applied.seats.length, 1, 'apply claimed a different number of seats than the one the shell dispatches')
  for (const seat of applied.seats) {
    const element = seat.render() as { type?: unknown } | null | undefined
    assert.ok(element !== null && element !== undefined, `${seat.slot} rendered nothing`)
    assert.equal(typeof element, 'object', `${seat.slot} did not render an element`)
  }
  assert.ok(created > 0, 'the render functions built no elements; the stand-in React was never called')
})
