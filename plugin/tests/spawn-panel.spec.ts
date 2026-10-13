/**
 * `pstack_spawn_panel`: one child per route entry, and the two weaker panels said out loud.
 *
 * The load-bearing assertion is ACCEPTANCE 1's: with N routes, child `i`'s captured
 * `agentOptions` names **route `i`**, not route 0 N times. It is asserted against the **real**
 * `resolvePanel` (`src/roles/overlay.ts`) over a fixture catalog and a fixture overlay, wired
 * through the production `createPanelResolver` — so the whole mapping path is exercised, not a
 * hand-written stub list. Removing the per-index application from `src/tools/spawn-panel.ts`
 * makes that test fail; that run is pasted in the unit report.
 *
 * Everything Host-shaped is a fake: no `ctx`, no llm service, no credentials, no network. The
 * children are started through the **real** `createPstackSpawnTool`, which is the point — the
 * panel does not re-implement the single-child path, so these tests also cover the reuse.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPanelResolver, createPstackSpawnPanelTool, DEFAULT_INHERIT_WIDTH, MAX_PANEL_WIDTH, PanelRoleError, panelNote, parsePanelArgs, PSTACK_SPAWN_PANEL_TOOL } from '../src/tools/spawn-panel.ts'
import type { PanelChildOutcome, PanelOutcome, PanelResolverLike } from '../src/tools/spawn-panel.ts'
import { SpawnArgsError } from '../src/tools/spawn.ts'
import type { SpawnAgentLike, SpawnRunContext, SubagentServiceLike } from '../src/tools/spawn.ts'
import { PANEL_ROLES } from '../src/roles/overlay.ts'
import type { OverlayFile } from '../src/roles/overlay.ts'
import type { RouteCatalog } from '../src/roles/catalog.ts'

const PARENT: SpawnAgentLike = { id: 'session-parent', options: { provider: 'deepseek-official', model: 'deepseek-pro' } }

/** The run context a real call arrives with. Mirrors `spawn.spec.ts`. */
function exec(signal?: AbortSignal): SpawnRunContext {
  return signal === undefined ? { agent: PARENT } : { agent: PARENT, signal }
}

/**
 * Three distinct routes. The ids are fixture data, never a claim about a real install: no test
 * here may depend on a slug that was not read from a catalog it was handed.
 */
function fixtureCatalog(): RouteCatalog {
  return {
    routes: [
      { provider: 'deepseek-official', model: 'deepseek-flash', efforts: ['off', 'low', 'high'], defaultEffort: 'high' },
      { provider: 'deepseek-official', model: 'deepseek-v4-pro', efforts: ['off', 'low', 'high'], defaultEffort: 'high' },
      { provider: 'example-vendor', model: 'other-model', efforts: ['minimal'], defaultEffort: 'minimal' },
    ],
    unavailable: [{ provider: 'dormant-vendor', why: 'credential "DORMANT_API_KEY" is not configured' }],
  }
}

/**
 * A panel role with three named models, one per fixture route.
 *
 * Version 2: the names are the level the human reads, the routes are the detail behind them, and a
 * panel task lists the names it fans out over.
 */
const THREE_ROUTES: OverlayFile = {
  version: 2,
  models: {
    flash: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
    pro: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
    other: { provider: 'example-vendor', model: 'other-model' },
  },
  tasks: { 'arena-runners': ['flash', 'pro', 'other'] },
}

/** Panel roles with no usable mapping: an explicit empty list, and no entry at all. */
const INHERIT_ENTRY: OverlayFile = { version: 2, models: {}, tasks: { 'architect-runners': [] } }
const EMPTY_OVERLAY: OverlayFile = { version: 2, models: {}, tasks: {} }

/** The one-route install's only legal panel: two names, both assigning the same route. */
const SAME_ROUTE_TWICE: OverlayFile = {
  version: 2,
  models: {
    flash: { provider: 'deepseek-official', model: 'deepseek-flash' },
    'flash-again': { provider: 'deepseek-official', model: 'deepseek-flash' },
  },
  tasks: { 'arena-cross-judge-pool': ['flash', 'flash-again'] },
}

/** A named model whose route the catalog does not have: `resolvePanel` makes it inherit. */
const UNUSABLE_ROUTE: OverlayFile = {
  version: 2,
  models: { ghost: { provider: 'ghost-vendor', model: 'ghost-model' } },
  tasks: { 'interrogate-reviewers': ['ghost'] },
}

interface Started {
  readonly name: string
  readonly request: Record<string, unknown>
}

interface Captured {
  readonly started: Started[]
  readonly assignments: { childId: string; role: string; effort: string }[]
}

/**
 * A fake `ctx.subagents` that captures every request and answers with a distinguishable child.
 * `failAt` makes one child's **start** reject, which is the partial fan-out failure the tool has
 * to attribute; `diagnosticAt` makes one child settle as an error instead of failing to start.
 */
function fakeSubagents(
  captured: Captured,
  options: { readonly failAt?: number; readonly diagnosticAt?: number } = {},
): SubagentServiceLike {
  let call = 0
  return {
    start: async (name: string, request: unknown): Promise<unknown> => {
      const index = call
      call += 1
      captured.started.push({ name, request: request as Record<string, unknown> })
      if (options.failAt === index) throw new Error('provider refused: rate limited')
      const diagnostic = options.diagnosticAt === index ? 'adapter exploded' : ''
      return {
        id: `session-child-${index}`,
        result: Promise.resolve({
          stopReason: diagnostic.length > 0 ? 'error' : 'completed',
          output: [{ type: 'text', text: `OUT-${index}` }],
          ...(diagnostic.length > 0 ? { diagnostic } : {}),
        }),
        dispose: async (): Promise<void> => {},
      }
    },
  }
}

/** The production panel resolver over a fixture catalog and overlay: the real `resolvePanel`. */
function resolverFor(catalog: RouteCatalog, overlay: OverlayFile): PanelResolverLike {
  return createPanelResolver({ catalog: async () => catalog, readOverlay: async () => overlay })
}

/** Build the tool with a real resolver and a capturing service. */
function toolFor(
  resolver: PanelResolverLike,
  captured: Captured,
  serviceOptions: { readonly failAt?: number; readonly diagnosticAt?: number } = {},
): ReturnType<typeof createPstackSpawnPanelTool> {
  return createPstackSpawnPanelTool({
    panelResolver: resolver,
    subagents: fakeSubagents(captured, serviceOptions),
    assignments: { set: (id, assignment) => void captured.assignments.push({ childId: id, ...assignment }) },
  })
}

/** A fresh capture sink. */
function capture(): Captured {
  return { started: [], assignments: [] }
}

/** The `agentOptions` each child was started with, or `undefined` for an inheriting child. */
function agentOptionsOf(captured: Captured): unknown[] {
  return captured.started.map((entry) => entry.request['agentOptions'])
}

/** Walk a raw schema and collect every object node, as `status.spec.ts` does. */
function objectNodes(schema: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return
    const record = node as Record<string, unknown>
    if (record['type'] === 'object') found.push(record)
    const properties = record['properties']
    if (typeof properties === 'object' && properties !== null) {
      for (const child of Object.values(properties as Record<string, unknown>)) visit(child)
    }
    visit(record['items'])
    for (const arm of Array.isArray(record['oneOf']) ? record['oneOf'] : []) visit(arm)
  }
  visit(schema)
  return found
}

test('the definition is shaped the way the registry validates', () => {
  const tool = toolFor(resolverFor(fixtureCatalog(), THREE_ROUTES), capture())
  assert.equal(tool.name, PSTACK_SPAWN_PANEL_TOOL)
  assert.match(tool.name, /^[a-z0-9]+(?:_[a-z0-9]+)*$/)
  assert.ok(tool.description.length > 40)

  const parameters = tool.parameters as Record<string, unknown>
  assert.equal(parameters['type'], 'object')
  const properties = parameters['properties'] as Record<string, unknown>
  assert.deepEqual(Object.keys(properties).sort(), ['count', 'description', 'prompt', 'role'])
  assert.deepEqual(parameters['required'], ['role', 'prompt'])
  assert.equal(parameters['additionalProperties'], false)

  const schema = tool.output.schema as Record<string, unknown>
  assert.equal(typeof tool.output.render, 'function')
  const objects = objectNodes(schema)
  assert.ok(objects.length > 0)
  for (const node of objects) {
    assert.equal(typeof node['additionalProperties'], 'boolean', 'explicit objects declare additionalProperties')
    const required = node['required']
    if (required === undefined) continue
    assert.ok(Array.isArray(required))
    const declared = (node['properties'] ?? {}) as Record<string, unknown>
    for (const key of required as unknown[]) {
      assert.ok(Object.hasOwn(declared, key as string), `required names undeclared property ${String(key)}`)
    }
  }
  // The children array is the part of the value a caller reads; its item schema must be closed.
  const children = (schema['properties'] as Record<string, unknown>)['children'] as Record<string, unknown>
  assert.equal(children['type'], 'array')
  assert.equal((children['items'] as Record<string, unknown>)['type'], 'object')
  assert.equal((children['items'] as Record<string, unknown>)['additionalProperties'], false)
})

test('ACCEPTANCE 1 — a panel role with N routes spawns N children, one per route_index, each on ITS route', async () => {
  const catalog = fixtureCatalog()
  const resolver = resolverFor(catalog, THREE_ROUTES)

  // The real resolvePanel is what is under test: three entries, three distinct routeIndexes.
  const resolved = await resolver.resolvePanel('arena-runners')
  assert.deepEqual(
    resolved.map((entry) => entry.routeIndex),
    [0, 1, 2],
  )
  assert.deepEqual(
    resolved.map((entry) => `${entry.route?.provider}/${entry.route?.model}`),
    ['deepseek-official/deepseek-flash', 'deepseek-official/deepseek-v4-pro', 'example-vendor/other-model'],
  )

  const captured = capture()
  const value = (await toolFor(resolver, captured).execute(
    { role: 'arena-runners', prompt: 'Name the failure modes.' },
    exec(),
  )) as PanelOutcome

  assert.equal(captured.started.length, 3)
  assert.deepEqual(agentOptionsOf(captured), [
    { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
    { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
    { provider: 'example-vendor', model: 'other-model' },
  ])
  // Stated separately because it is the exact defect this test exists for: route[0] three times.
  assert.notDeepEqual(agentOptionsOf(captured)[1], agentOptionsOf(captured)[0])

  // Every child got the same prompt, and a label defaulting to the role key.
  for (const entry of captured.started) {
    assert.deepEqual(entry.request['prompt'], [{ type: 'text', text: 'Name the failure modes.' }])
    assert.equal(entry.request['label'], 'arena-runners')
    assert.equal(entry.request['parent'], PARENT)
  }

  // One entry per child, each naming its own route, and each distinguishable by childId/output.
  assert.equal(value.width, 3)
  assert.deepEqual(value.children.map((child) => child.index), [0, 1, 2])
  assert.deepEqual(value.children.map((child) => child.routeIndex), [0, 1, 2])
  assert.deepEqual(value.children.map((child) => child.route), [
    'deepseek-official/deepseek-flash',
    'deepseek-official/deepseek-v4-pro',
    'example-vendor/other-model',
  ])
  assert.deepEqual(value.children.map((child) => child.childId), [
    'session-child-0',
    'session-child-1',
    'session-child-2',
  ])
  assert.deepEqual(value.children.map((child) => child.output), ['OUT-0', 'OUT-1', 'OUT-2'])
  assert.equal(value.allInherited, false)
  assert.equal(value.distinctRoutes, 3)
  assert.equal(value.succeeded, 3)
  assert.equal(value.failed, 0)
  assert.deepEqual(value.failureIndices, [])
  assert.equal(value.note, '3 children ran on 3 distinct routes')
})

test('ACCEPTANCE 2 — an inheriting panel role spawns N children with NO agentOptions key at all', async () => {
  // Two spellings of "inherits": an explicit entry, and no entry at all.
  for (const overlay of [INHERIT_ENTRY, EMPTY_OVERLAY]) {
    const captured = capture()
    const value = (await toolFor(resolverFor(fixtureCatalog(), overlay), captured).execute(
      { role: 'arena-runners', prompt: 'go' },
      exec(),
    )) as PanelOutcome

    assert.equal(captured.started.length, DEFAULT_INHERIT_WIDTH)
    for (const entry of captured.started) {
      assert.equal(Object.hasOwn(entry.request, 'agentOptions'), false, 'an inheriting child must omit agentOptions')
      assert.equal(entry.request['agentOptions'], undefined)
    }
    assert.equal(value.allInherited, true)
    assert.equal(value.distinctRoutes, 0)
    assert.equal(value.width, DEFAULT_INHERIT_WIDTH)
    assert.deepEqual(value.children.map((child) => child.route), ['inherits parent', 'inherits parent'])
    assert.equal(value.children[0]?.inherited, true)
    assert.equal(value.children[0]?.routeProvider, '')
    // The weaker panel is labelled, not implied: never imply a parity we did not get.
    assert.match(value.note, /same route, separate reads/)
    assert.match(value.note, /seed diversity only, not family diversity/)
  }
})

test('count widens an inheriting panel, and a count the route list overrode is stated', async () => {
  const captured = capture()
  const inherited = (await toolFor(resolverFor(fixtureCatalog(), EMPTY_OVERLAY), captured).execute(
    { role: 'architect-runners', prompt: 'go', count: 3 },
    exec(),
  )) as PanelOutcome
  assert.equal(inherited.width, 3)
  assert.equal(captured.started.length, 3)

  // A mapped panel's width is its route list, and a count that did nothing says so.
  const mappedCapture = capture()
  const mapped = (await toolFor(resolverFor(fixtureCatalog(), THREE_ROUTES), mappedCapture).execute(
    { role: 'arena-runners', prompt: 'go', count: 2 },
    exec(),
  )) as PanelOutcome
  assert.equal(mapped.width, 3, 'the route list sets the width')
  assert.equal(mappedCapture.started.length, 3)
  assert.match(mapped.note, /count=2 was ignored/)
  assert.match(mapped.note, /route list sets the panel width \(3\)/)
})

test('a panel entry naming a route that is not in the live catalog inherits, with its reason', async () => {
  const captured = capture()
  const value = (await toolFor(resolverFor(fixtureCatalog(), UNUSABLE_ROUTE), captured).execute(
    { role: 'interrogate-reviewers', prompt: 'go' },
    exec(),
  )) as PanelOutcome
  assert.equal(value.allInherited, true)
  assert.equal(value.width, DEFAULT_INHERIT_WIDTH)
  for (const entry of captured.started) assert.equal(Object.hasOwn(entry.request, 'agentOptions'), false)
  // The refusal is not swallowed: `unavailable:` is exactly what a caller must see.
  assert.match(value.children[0]?.reason ?? '', /^unavailable:/)
  assert.match(value.children[0]?.reason ?? '', /ghost-vendor\/ghost-model/)
  assert.match(value.note, /seed diversity only, not family diversity/)
})

test('a non-panel role is refused, naming the role and the panel roles', async () => {
  const captured = capture()
  const tool = toolFor(resolverFor(fixtureCatalog(), THREE_ROUTES), captured)
  await assert.rejects(
    () => tool.execute({ role: 'feature', prompt: 'go' }, exec()),
    (error: unknown) => {
      assert.ok(error instanceof PanelRoleError)
      assert.equal(error.role, 'feature')
      assert.deepEqual(error.panelRoles, PANEL_ROLES)
      assert.match(error.message, /feature/)
      for (const panelRole of PANEL_ROLES) assert.match(error.message, new RegExp(panelRole))
      return true
    },
  )
  // Refused, not degraded to width 1: nothing was spawned.
  assert.equal(captured.started.length, 0)
})

test('a child that fails does not hide its siblings', async () => {
  const captured = capture()
  const value = (await toolFor(resolverFor(fixtureCatalog(), THREE_ROUTES), captured, { failAt: 1 }).execute(
    { role: 'arena-runners', prompt: 'go' },
    exec(),
  )) as PanelOutcome

  // All three children ran; the failure is attributed to index 1 and names its route.
  assert.equal(captured.started.length, 3)
  assert.equal(value.width, 3)
  assert.deepEqual(value.children.map((child) => child.index), [0, 1, 2])
  assert.deepEqual(value.children.map((child) => child.status), ['ok', 'error', 'ok'])
  assert.deepEqual(value.failureIndices, [1])

  const failed = value.children[1] as PanelChildOutcome
  assert.equal(failed.route, 'deepseek-official/deepseek-v4-pro', 'a failed child still names its route')
  assert.equal(failed.routeIndex, 1)
  assert.equal(failed.childId, '')
  assert.match(failed.diagnostic, /child 1 did not start/)
  assert.match(failed.diagnostic, /rate limited/)

  // The siblings are intact and reported, not lost behind the failure.
  assert.equal(value.children[0]?.output, 'OUT-0')
  assert.equal(value.children[2]?.output, 'OUT-2')
  assert.equal(value.succeeded, 2)
  assert.equal(value.failed, 1)
  assert.equal(value.started, 2, 'the failed child never started')
})

test('a child that settles as an error is an error entry, not a lost child', async () => {
  const captured = capture()
  const value = (await toolFor(resolverFor(fixtureCatalog(), THREE_ROUTES), captured, { diagnosticAt: 2 }).execute(
    { role: 'arena-runners', prompt: 'go' },
    exec(),
  )) as PanelOutcome
  assert.deepEqual(value.children.map((child) => child.status), ['ok', 'ok', 'error'])
  assert.deepEqual(value.failureIndices, [2])
  assert.equal(value.children[2]?.childId, 'session-child-2', 'it started, so it has an id')
  assert.equal(value.children[2]?.diagnostic, 'adapter exploded')
  assert.equal(value.started, 3)
  assert.equal(value.succeeded, 2)
  assert.equal(value.failed, 1)
})

test('the same route listed twice is one distinct route, and the panel says so', async () => {
  const captured = capture()
  const value = (await toolFor(resolverFor(fixtureCatalog(), SAME_ROUTE_TWICE), captured).execute(
    { role: 'arena-cross-judge-pool', prompt: 'go' },
    exec(),
  )) as PanelOutcome

  assert.equal(value.width, 2, 'one child per entry, even when the entries are identical')
  assert.deepEqual(value.children.map((child) => child.routeIndex), [0, 1])
  assert.deepEqual(agentOptionsOf(captured), [
    { provider: 'deepseek-official', model: 'deepseek-flash' },
    { provider: 'deepseek-official', model: 'deepseek-flash' },
  ])
  assert.equal(value.allInherited, false, 'a route list was applied, so it is not the inheriting case')
  assert.equal(value.distinctRoutes, 1)
  assert.match(value.note, /names 1 distinct route \(deepseek-official\/deepseek-flash\)/)
  assert.match(value.note, /seed diversity only, not family diversity/)
})

test('arguments are validated: count is capped, route_index is refused by name', async () => {
  const tool = toolFor(resolverFor(fixtureCatalog(), EMPTY_OVERLAY), capture())

  for (const count of [0, MAX_PANEL_WIDTH + 1, 2.5, '2']) {
    await assert.rejects(
      () => tool.execute({ role: 'arena-runners', prompt: 'go', count }, exec()),
      (error: unknown) => {
        assert.ok(error instanceof SpawnArgsError)
        assert.match(error.message, new RegExp(`arguments.count must be an integer between 1 and ${MAX_PANEL_WIDTH}`))
        return true
      },
    )
  }

  await assert.rejects(
    () => tool.execute({ role: 'arena-runners', prompt: 'go', route_index: 1 }, exec()),
    (error: unknown) => {
      assert.ok(error instanceof SpawnArgsError)
      assert.match(error.message, /arguments.route_index is not a parameter of pstack_spawn_panel/)
      return true
    },
  )

  await assert.rejects(
    () => tool.execute({ role: 'arena-runners', prompt: 'go', width: 3 }, exec()),
    (error: unknown) => {
      assert.ok(error instanceof SpawnArgsError)
      assert.match(error.message, /arguments.width is not a declared parameter/)
      return true
    },
  )

  // The shared fields are validated by the frozen `parseSpawnArgs`, so its rules still hold here.
  await assert.rejects(() => tool.execute({ prompt: 'go' }, exec()), SpawnArgsError)
  await assert.rejects(() => tool.execute({ role: 'arena-runners', prompt: '' }, exec()), SpawnArgsError)

  const parsed = parsePanelArgs({ role: 'arena-runners', prompt: 'go' })
  assert.equal(parsed.count, undefined, 'an absent count is distinguishable from a stated one')
})

test('a resolver that returns nothing is an error, not a silent width-0 panel', async () => {
  const tool = createPstackSpawnPanelTool({
    panelResolver: { resolvePanel: () => [] },
    subagents: fakeSubagents(capture()),
  })
  await assert.rejects(() => tool.execute({ role: 'arena-runners', prompt: 'go' }, exec()), /returned no resolution/)
})

test('panelNote labels each case without ever implying family diversity', () => {
  assert.equal(panelNote({ width: 3, allInherited: false, distinctRoutes: 3 }), '3 children ran on 3 distinct routes')
  assert.match(panelNote({ width: 1, allInherited: true, distinctRoutes: 0 }), /^all 1 child inherit/)
  assert.match(
    panelNote({ width: 2, allInherited: false, distinctRoutes: 1, onlyRoute: 'a/b', ignoredCount: 2 }),
    /names 1 distinct route \(a\/b\).*count=2 was ignored/,
  )
})
