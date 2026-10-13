/**
 * `pstack_spawn`: the role -> route mapping, and the inheriting case.
 *
 * This is Gate 4's own requirement — "a spawned child actually runs on a mapped route, proven by
 * a test that fails when the mapping is removed. Not by reading the code" — so it asserts the
 * request body the tool hands the subagent service, not the shape of the code that builds it.
 *
 * The two cases that matter:
 *
 * - a **mapped** role: the captured `agentOptions` names that exact provider and model;
 * - an **inheriting** role: the captured request has **no `agentOptions` key at all**
 *   (`Object.hasOwn` false, not "undefined"). Omitting means inherit
 *   (`dsh-subagent/lib/index.js:468-484`); sending the parent's own route back would look like a
 *   mapping that does not exist.
 *
 * Removing the mapping from `buildSpawnRequest` makes the mapped test fail. That run is pasted in
 * the unit report; the failing edit is two lines and the test was re-run to show it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSpawnRequest,
  createPstackSpawnTool,
  parseSpawnArgs,
  PSTACK_SPAWN_PARAMETERS,
  PSTACK_SPAWN_TOOL,
  SPAWN_PROVIDER_NAME,
  SpawnArgsError,
} from '../src/tools/spawn.ts'
import type {
  ResolvedRoleLike,
  RoleResolverLike,
  SpawnAgentLike,
  SpawnOutcome,
  SpawnRunContext,
} from '../src/tools/spawn.ts'

const ARCHITECT: ResolvedRoleLike = {
  role: 'architect',
  inherit: false,
  route: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
  routeIndex: 0,
  reason: 'overlay maps architect to route 0',
}

const INHERITING: ResolvedRoleLike = {
  role: 'tdd',
  inherit: true,
  reason: 'no overlay entry for tdd; inheriting the parent route',
}

const UNAVAILABLE: ResolvedRoleLike = {
  role: 'architect',
  inherit: true,
  reason: 'unavailable: credential "CURSOR_API_KEY" is not configured, so no model on this route can authenticate',
}

const PARENT: SpawnAgentLike = { id: 'session-parent', options: { provider: 'deepseek-official', model: 'deepseek-pro' } }

/**
 * The run context a real call arrives with. `null` means "no calling agent" — an explicit
 * `null` rather than `undefined`, because a default parameter would swallow `undefined` and
 * silently hand back the parent.
 */
function exec(agent: SpawnAgentLike | null = PARENT, signal?: AbortSignal): SpawnRunContext {
  const resolved = agent ?? undefined
  return signal === undefined ? { agent: resolved } : { agent: resolved, signal }
}

interface Started {
  readonly name: string
  readonly request: unknown
}

interface Captured {
  readonly started: Started[]
  readonly assignments: { childId: string; role: string; effort: string }[]
}

/** A resolver that answers with one fixed resolution, recording the routeIndex it was asked for. */
function fakeResolver(resolved: ResolvedRoleLike, seen: number[] = []): RoleResolverLike {
  return {
    resolve: (_role: string, routeIndex?: number) => {
      seen.push(routeIndex ?? -1)
      return resolved
    },
  }
}

/** A fake `ctx.subagents` that captures the request and returns a settleable run. */
function fakeSubagents(captured: Captured, childId = 'session-child-1', result: unknown = { stopReason: 'completed', output: [{ type: 'text', text: 'PONG' }] }) {
  return {
    start: async (name: string, request: unknown): Promise<unknown> => {
      captured.started.push({ name, request })
      return {
        id: childId,
        result: Promise.resolve(result),
        dispose: async (): Promise<void> => {},
      }
    },
  }
}

/** Build the tool with a fake resolver, a capturing service, and a capturing assignment sink. */
function toolFor(
  resolved: ResolvedRoleLike,
  seen: number[] = [],
  childId = 'session-child-1',
): { tool: ReturnType<typeof createPstackSpawnTool>; captured: Captured } {
  const captured: Captured = { started: [], assignments: [] }
  const tool = createPstackSpawnTool({
    resolver: fakeResolver(resolved, seen),
    subagents: fakeSubagents(captured, childId),
    assignments: {
      set: (id, assignment) => void captured.assignments.push({ childId: id, ...assignment }),
    },
  })
  return { tool, captured }
}

/** The captured request, with the shape this test needs. Non-null after an asserted start. */
function requestOf(captured: Captured): Record<string, unknown> {
  const first = captured.started[0]
  assert.ok(first !== undefined, 'the tool never called subagents.start')
  assert.equal(typeof first.request, 'object')
  assert.ok(first.request !== null)
  return first.request as Record<string, unknown>
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
  const { tool } = toolFor(ARCHITECT)
  assert.equal(tool.name, PSTACK_SPAWN_TOOL)
  assert.match(tool.name, /^[a-z0-9]+(?:_[a-z0-9]+)*$/)
  assert.ok(tool.description.length > 40)

  const parameters = tool.parameters as Record<string, unknown>
  assert.equal(parameters['type'], 'object')
  const properties = parameters['properties'] as Record<string, unknown>
  // The brief's list is deliberately short, and this asserts it is exactly that list.
  assert.deepEqual(Object.keys(properties).sort(), ['description', 'prompt', 'role', 'route_index'])
  assert.deepEqual(parameters['required'], ['role', 'prompt'])

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
})

test('ACCEPTANCE 2 — a mapped role sends agentOptions naming that provider and model', async () => {
  const { tool, captured } = toolFor(ARCHITECT)
  const value = (await tool.execute(
    { role: 'architect', prompt: 'Design the seam.', description: 'design seam' },
    exec(),
  )) as SpawnOutcome

  const request = requestOf(captured)
  assert.equal(captured.started[0]?.name, SPAWN_PROVIDER_NAME)
  assert.deepEqual(request['agentOptions'], {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
  })
  assert.equal(request['label'], 'design seam')
  assert.deepEqual(request['prompt'], [{ type: 'text', text: 'Design the seam.' }])
  assert.equal(request['parent'], PARENT)

  // The canonical value carries the same mapping, so the transcript is auditable on its own.
  assert.equal(value.role, 'architect')
  assert.equal(value.inherited, false)
  assert.equal(value.routeProvider, 'deepseek-official')
  assert.equal(value.routeModel, 'deepseek-flash')
  assert.equal(value.routeEffort, 'high')
  assert.equal(value.childId, 'session-child-1')
  assert.equal(value.stopReason, 'completed')
  assert.equal(value.output, 'PONG')
  assert.equal(value.subagentProvider, SPAWN_PROVIDER_NAME)
})

test('ACCEPTANCE 2 — an inheriting role sends no agentOptions key at all', async () => {
  const { tool, captured } = toolFor(INHERITING)
  const value = (await tool.execute({ role: 'tdd', prompt: 'Write the failing test first.' }, exec())) as SpawnOutcome

  const request = requestOf(captured)
  assert.equal(Object.hasOwn(request, 'agentOptions'), false, 'an inheriting spawn must omit agentOptions entirely')
  assert.equal(request['agentOptions'], undefined)
  // Label falls back to the role key when no description was given.
  assert.equal(request['label'], 'tdd')
  assert.ok(Object.hasOwn(request, 'parent'))
  assert.ok(Object.hasOwn(request, 'signal'))

  assert.equal(value.inherited, true)
  assert.equal(value.routeProvider, '')
  assert.equal(value.routeModel, '')
  assert.equal(value.routeEffort, '')
  assert.equal(value.routeIndex, -1)
  assert.equal(value.reason, INHERITING.reason)
})

test('an unusable mapping surfaces the resolver reason verbatim, prefixed unavailable:', async () => {
  const { tool, captured } = toolFor(UNAVAILABLE)
  const value = (await tool.execute({ role: 'architect', prompt: 'go' }, exec())) as SpawnOutcome
  assert.equal(value.inherited, true)
  assert.ok(value.reason.startsWith('unavailable:'), value.reason)
  assert.match(value.reason, /CURSOR_API_KEY/)
  // Refused, not degraded: nothing was sent that would pretend the mapping worked.
  assert.equal(Object.hasOwn(requestOf(captured), 'agentOptions'), false)
})

test('route_index is passed to the resolver as its route index, and reported back', async () => {
  const seen: number[] = []
  const { tool } = toolFor({ ...ARCHITECT, routeIndex: 2, reason: 'panel entry 2' }, seen)
  const value = (await tool.execute({ role: 'architect', prompt: 'go', route_index: 2 }, exec())) as SpawnOutcome
  assert.deepEqual(seen, [2])
  assert.equal(value.requestedRouteIndex, 2)
  assert.equal(value.routeIndex, 2)
})

test('omitting route_index asks the resolver for its default', async () => {
  const seen: number[] = []
  const { tool } = toolFor(ARCHITECT, seen)
  await tool.execute({ role: 'architect', prompt: 'go' }, exec())
  assert.deepEqual(seen, [-1], 'the resolver is called with routeIndex undefined, not 0')
})

test('a route with no effort sends provider and model but no reasoningEffort', async () => {
  const { tool, captured } = toolFor({
    role: 'architect',
    inherit: false,
    route: { provider: 'deepseek-official', model: 'deepseek-flash' },
    reason: 'mapped, no effort pinned',
  })
  const value = (await tool.execute({ role: 'architect', prompt: 'go' }, exec())) as SpawnOutcome
  assert.deepEqual(requestOf(captured)['agentOptions'], {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  })
  assert.equal(value.routeEffort, '')
})

test('the canonical value has exactly the keys the output schema requires', async () => {
  const { tool } = toolFor(ARCHITECT)
  const value = (await tool.execute({ role: 'architect', prompt: 'go' }, exec())) as Record<string, unknown>
  const schema = tool.output.schema as Record<string, unknown>
  const required = (schema['required'] as string[]).slice().sort()
  assert.deepEqual(Object.keys(value).sort(), required)
  const blocks = tool.output.render({}, value)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.type, 'text')
  assert.deepEqual(JSON.parse(blocks[0]?.text ?? '{}'), value)
})

test('the role/effort a published child runs is recorded for the effort listener', async () => {
  const { tool, captured } = toolFor(ARCHITECT, [], 'session-child-9')
  await tool.execute({ role: 'architect', prompt: 'go' }, exec())
  assert.deepEqual(captured.assignments, [
    { childId: 'session-child-9', role: 'architect', effort: 'high' },
  ])
})

test('nothing is recorded for a child with no role effort to apply', async () => {
  const { tool, captured } = toolFor(INHERITING)
  await tool.execute({ role: 'tdd', prompt: 'go' }, exec())
  assert.deepEqual(captured.assignments, [])
})

test('bad arguments are refused with path-qualified violations', async () => {
  const { tool, captured } = toolFor(ARCHITECT)
  await assert.rejects(() => tool.execute({ prompt: 'no role' }, exec()), SpawnArgsError)
  await assert.rejects(() => tool.execute({ role: 'x' }, exec()), /arguments\.prompt/)
  await assert.rejects(() => tool.execute({ role: 'x', prompt: 'go', route_index: -1 }, exec()), /route_index/)
  await assert.rejects(() => tool.execute({ role: 'x', prompt: 'go', route_index: 1.5 }, exec()), /route_index/)
  await assert.rejects(() => tool.execute({ role: 'x', prompt: 'go', isolation: true }, exec()), /isolation is not a declared parameter/)
  await assert.rejects(() => tool.execute('not an object', exec()), /must be an object/)
  await assert.rejects(() => tool.execute({ role: '', prompt: 'go' }, exec()), /role/)
  // None of those reached the service: a refused call is not a spawn.
  assert.deepEqual(captured.started, [])
})

test('parseSpawnArgs is the same contract the parameter schema declares', () => {
  const parameters = PSTACK_SPAWN_PARAMETERS as Record<string, unknown>
  const properties = parameters['properties'] as Record<string, unknown>
  const parsed = parseSpawnArgs({ role: 'architect', prompt: 'go', description: 'd', route_index: 3 })
  assert.deepEqual(parsed, { role: 'architect', prompt: 'go', description: 'd', routeIndex: 3 })
  assert.deepEqual(parseSpawnArgs({ role: 'architect', prompt: 'go' }), { role: 'architect', prompt: 'go' })
  assert.deepEqual(Object.keys(properties).sort(), ['description', 'prompt', 'role', 'route_index'])
})

test('a call with no calling agent fails loud rather than spawning into nothing', async () => {
  const { tool, captured } = toolFor(ARCHITECT)
  await assert.rejects(() => tool.execute({ role: 'architect', prompt: 'go' }, exec(null)), /no calling agent/)
  assert.deepEqual(captured.started, [])
})

test('a cancelled call does not reach the service', async () => {
  const { tool, captured } = toolFor(ARCHITECT)
  await assert.rejects(
    () => tool.execute({ role: 'architect', prompt: 'go' }, exec(PARENT, AbortSignal.abort())),
    /abort/i,
  )
  assert.deepEqual(captured.started, [])
})

test('buildSpawnRequest is pure and is where the mapping decision lives', () => {
  const args = parseSpawnArgs({ role: 'architect', prompt: 'go' })
  const mapped = buildSpawnRequest(ARCHITECT, args)
  assert.deepEqual(mapped.agentOptions, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
  })
  const inherited = buildSpawnRequest(INHERITING, args)
  assert.equal(Object.hasOwn(inherited, 'agentOptions'), false)
  // `inherit: false` with no route is also an inherit: never fabricate a route.
  const routeLess = buildSpawnRequest({ role: 'x', inherit: false, reason: 'no route' }, args)
  assert.equal(Object.hasOwn(routeLess, 'agentOptions'), false)
})

test('the effort a role resolved to is one the route advertises, or it is not sent', async () => {
  // The resolver owns refusal (see src/roles/catalog.ts); this asserts the tool does not
  // second-guess it into a route-less state, and that an effort the resolver refused never
  // appears in agentOptions. A checked-but-unadvertised effort has to come back as inherit.
  const refused: ResolvedRoleLike = { role: 'architect', inherit: true, reason: 'unavailable: no route advertises effort "xhigh"' }
  const { tool, captured } = toolFor(refused)
  await tool.execute({ role: 'architect', prompt: 'go' }, exec())
  const options = requestOf(captured)['agentOptions']
  assert.equal(options, undefined)
})
