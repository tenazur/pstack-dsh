/**
 * The `agent/request` effort listener: child vs primary, ordering, and refusal.
 *
 * The mechanism is confirmed by execution, so these tests are
 * about *our* listener's contract, not about whether the hook fires:
 *
 * - a child with a recorded role gets the role's effort;
 * - a **primary** agent's request is returned untouched — by identity, not by equality;
 * - `next()` is awaited **before** the config is replaced. This is asserted through the public
 *   seam: `advertisedEfforts` is consulted by the listener after `await next()` resolves, so the
 *   order log is `['next', 'efforts-consulted']`. An implementation that computed its answer from
 *   the payload before delegating would log the opposite, and one that wrote to
 *   `payload.agent.options` instead of returning a replaced config would never call `next()` at
 *   all.
 * - an effort the route does not advertise is refused, never passed through — the DeepSeek
 *   adapter fails such a request with `UNSUPPORTED_REASONING_EFFORT`
 *   (`dsh-llm-deepseek/lib/index.js:26-29`), so passing it through is a broken child, not a
 *   quieter one.
 *
 * The config returned by `next()` is frozen in the mutation tests: an in-place
 * `config.reasoningEffort = …` throws in strict mode, so a listener written that way fails here
 * rather than silently mutating a config the chain still owns.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEffortListener, createRoleAssignments, EFFORT_WATERFALL_EVENT, readDelegationDepth } from '../src/effort.ts'
import type { AgentRequestPayloadLike, LlmCallConfigLike, RoleAssignmentStore } from '../src/effort.ts'

const ROUTE_CONFIG = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' } as const
const ADVERTISED = ['off', 'low', 'high', 'max']

/** A store with one child already assigned. */
function storeWith(childId: string, role: string, effort: string): RoleAssignmentStore {
  const store = createRoleAssignments()
  store.set(childId, { role, effort })
  return store
}

/** The payload for an in-process child at depth 1, as the harness reports it. */
function childPayload(id = 'session-child-1'): AgentRequestPayloadLike {
  return { agent: { id, options: { subagentDepth: 1 } }, turn: 1, step: 1 }
}

/** The payload for the primary agent: depth absent, which means top-level. */
function primaryPayload(id = 'session-primary'): AgentRequestPayloadLike {
  return { agent: { id, options: {} }, turn: 1, step: 1 }
}

test('a child with a recorded role gets that role\'s effort', async () => {
  const assignments = storeWith('session-child-1', 'architect', 'high')
  const listener = createEffortListener({ assignments, advertisedEfforts: () => ADVERTISED })
  const seed: LlmCallConfigLike = { ...ROUTE_CONFIG }
  const result = await listener(childPayload(), async () => seed)
  assert.equal(result.reasoningEffort, 'high')
  // Everything else the chain set survives the replacement.
  assert.equal(result.provider, 'deepseek-official')
  assert.equal(result.model, 'deepseek-flash')
  assert.notEqual(result, seed)
})

test('a primary agent\'s request is untouched — same object, no effort applied', async () => {
  const assignments = storeWith('session-primary', 'architect', 'high')
  const listener = createEffortListener({ assignments, advertisedEfforts: () => ADVERTISED })
  const seed: LlmCallConfigLike = { ...ROUTE_CONFIG }
  const result = await listener(primaryPayload(), async () => seed)
  assert.equal(result, seed, 'the primary config must be returned by identity, not replaced')
  assert.equal(result.reasoningEffort, 'off')
})

test('depth is the harness field, and only a positive integer depth is a child', () => {
  assert.equal(readDelegationDepth({ id: 'x', options: { subagentDepth: 1 } }), 1)
  assert.equal(readDelegationDepth({ id: 'x', options: {} }), 0)
  assert.equal(readDelegationDepth(undefined), 0)
  assert.equal(readDelegationDepth({ id: 'x', options: { subagentDepth: 0 } }), 0)
  // A malformed depth is treated as top-level: never re-route the human's own session.
  assert.equal(readDelegationDepth({ id: 'x', options: { subagentDepth: -1 } }), 0)
  assert.equal(readDelegationDepth({ id: 'x', options: { subagentDepth: 1.5 } }), 0)
})

test('a malformed depth leaves the request alone rather than guessing it is a child', async () => {
  const assignments = storeWith('weird', 'architect', 'high')
  const listener = createEffortListener({ assignments, advertisedEfforts: () => ADVERTISED })
  const seed: LlmCallConfigLike = { ...ROUTE_CONFIG }
  const result = await listener(
    { agent: { id: 'weird', options: { subagentDepth: -1 } } },
    async () => seed,
  )
  assert.equal(result, seed)
})

test('ORDERING — next() is awaited before the config is replaced', async () => {
  const assignments = storeWith('session-child-1', 'architect', 'high')
  const order: string[] = []
  const listener = createEffortListener({
    assignments,
    advertisedEfforts: () => {
      // Only reachable once `await next()` has resolved inside the listener.
      order.push('efforts-consulted')
      return ADVERTISED
    },
  })
  const seed: LlmCallConfigLike = { ...ROUTE_CONFIG }
  const payload = childPayload()

  const result = await listener(payload, async () => {
    order.push('next')
    // If the listener had written to the payload first, the seed would already carry it.
    assert.equal(payload.agent?.options?.['reasoningEffort'], undefined)
    return seed
  })

  assert.deepEqual(order, ['next', 'efforts-consulted'])
  assert.equal(result.reasoningEffort, 'high')
})

test('ORDERING — the listener replaces the config, it does not mutate the payload or the seed', async () => {
  const assignments = storeWith('session-child-1', 'architect', 'high')
  const listener = createEffortListener({ assignments, advertisedEfforts: () => ADVERTISED })
  const seed = Object.freeze({ ...ROUTE_CONFIG })
  const payload = childPayload()

  // An in-place `config.reasoningEffort = 'high'` throws here (strict mode, frozen object),
  // which is exactly the failure this test exists to catch.
  const result = await listener(payload, async () => seed)

  assert.equal(seed.reasoningEffort, 'off', 'the chain\'s own config must be untouched')
  assert.equal(result.reasoningEffort, 'high')
  assert.equal(payload.agent?.options?.['reasoningEffort'], undefined, 'the agent options must be untouched')
  assert.equal(Object.isFrozen(result), false)
})

test('next() is called exactly once', async () => {
  const assignments = storeWith('session-child-1', 'architect', 'high')
  const listener = createEffortListener({ assignments, advertisedEfforts: () => ADVERTISED })
  let calls = 0
  await listener(childPayload(), async () => {
    calls += 1
    return { ...ROUTE_CONFIG }
  })
  assert.equal(calls, 1)
})

test('an effort the route does not advertise is refused, not passed through', async () => {
  const assignments = storeWith('session-child-1', 'architect', 'xhigh')
  const warnings: string[] = []
  const listener = createEffortListener({
    assignments,
    advertisedEfforts: () => ADVERTISED,
    logger: { warn: (message) => void warnings.push(message) },
  })
  const seed: LlmCallConfigLike = { ...ROUTE_CONFIG }
  const result = await listener(childPayload(), async () => seed)

  assert.equal(result, seed, 'a refused effort leaves the request exactly as the chain composed it')
  assert.equal(result.reasoningEffort, 'off')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /xhigh/)
  assert.match(warnings[0] ?? '', /does not advertise/)
  assert.match(warnings[0] ?? '', /off, low, high, max/)
})

test('an unknown route does not block the override — refusal is the resolver\'s job, not a lookup failure\'s', async () => {
  const assignments = storeWith('session-child-1', 'architect', 'max')
  const listener = createEffortListener({ assignments, advertisedEfforts: () => undefined })
  const result = await listener(childPayload(), async () => ({ ...ROUTE_CONFIG }))
  assert.equal(result.reasoningEffort, 'max')
})

test('no advertised-effort lookup at all still applies the recorded effort', async () => {
  const assignments = storeWith('session-child-1', 'architect', 'low')
  const listener = createEffortListener({ assignments })
  const result = await listener(childPayload(), async () => ({ ...ROUTE_CONFIG }))
  assert.equal(result.reasoningEffort, 'low')
})

test('a child this plugin did not spawn is untouched', async () => {
  const assignments = storeWith('session-child-1', 'architect', 'high')
  const listener = createEffortListener({ assignments, advertisedEfforts: () => ADVERTISED })
  const seed: LlmCallConfigLike = { ...ROUTE_CONFIG }
  const result = await listener(childPayload('some-other-child'), async () => seed)
  assert.equal(result, seed)
})

test('a child with no id is untouched', async () => {
  const assignments = storeWith('session-child-1', 'architect', 'high')
  const listener = createEffortListener({ assignments, advertisedEfforts: () => ADVERTISED })
  const seed: LlmCallConfigLike = { ...ROUTE_CONFIG }
  const result = await listener({ agent: { options: { subagentDepth: 1 } } }, async () => seed)
  assert.equal(result, seed)
})

test('an already-correct effort is left alone', async () => {
  const assignments = storeWith('session-child-1', 'architect', 'off')
  const listener = createEffortListener({ assignments, advertisedEfforts: () => ADVERTISED })
  const seed: LlmCallConfigLike = { ...ROUTE_CONFIG }
  const result = await listener(childPayload(), async () => seed)
  assert.equal(result, seed)
})

test('the event name is the waterfall the finding confirmed', () => {
  assert.equal(EFFORT_WATERFALL_EVENT, 'agent/request')
})

test('assignments are isolated per store, so two stores cannot silently share state', () => {
  const first = createRoleAssignments()
  const second = createRoleAssignments()
  first.set('child', { role: 'architect', effort: 'high' })
  assert.equal(first.size(), 1)
  assert.equal(second.size(), 0)
  assert.equal(second.get('child'), undefined)
  first.delete('child')
  assert.equal(first.size(), 0)
})
