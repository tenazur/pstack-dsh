/**
 * The overlay file model and the resolution rules.
 *
 * The overlay rules and the role vocabulary are both stated as data here, so both are
 * exercised here against a fixture catalog — every slug is obviously fake (`test-provider` /
 * `test-model`), because a real slug is an install fact and a hardcoded one is how a port ships a
 * config that lies. The one exception is deliberate and named: {@link REAL_CATALOG} carries this
 * machine's four live `deepseek-official` routes, because ACCEPTANCE 4 asks for the built-in names
 * to resolve with no `models` block and that claim is worth nothing against invented slugs.
 *
 * The vocabulary tests carry the weight of a known defect: a Phase 1 scratch probe
 * (an early port assessment) folded `generalPurpose` into `poteto-agent`.
 * The frozen skills are right and the scratch probe was wrong, so the rule is
 * asserted directly rather than left to a comment.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RouteCatalog } from '../src/roles/catalog.ts'
import {
  BUILT_IN_MODEL_NAMES,
  builtInModel,
  canonicalRole,
  INHERIT_PARENT_MODEL,
  isPanelRole,
  namedModelAssignment,
  normaliseRoleKey,
  overlayVersionNote,
  PANEL_ROLES,
  parseOverlay,
  resolvePanel,
  resolveRole,
  ROLE_KEYS,
  serializeOverlay,
  SPAWN_ROLE_VALUES,
  UNAVAILABLE_REASON_PREFIX,
} from '../src/roles/overlay.ts'
import type { OverlayFile, OverlayFileV2 } from '../src/roles/overlay.ts'

/** Fixture catalog. `test-broken` and `test-locked` exist only as unavailable entries. */
const CATALOG: RouteCatalog = {
  routes: [
    { provider: 'test-provider', model: 'test-model', efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'high' },
    { provider: 'test-provider', model: 'test-alt', efforts: ['off', 'high'], defaultEffort: 'off' },
    { provider: 'test-other', model: 'test-second', efforts: [] },
  ],
  unavailable: [
    { provider: 'test-locked', why: 'credential "TEST_LOCKED_API_KEY" is not configured' },
    { provider: 'test-provider', model: 'test-broken', why: 'resolveModelInfo failed: adapter says no' },
  ],
}

/**
 * The four routes this machine's adapter actually enumerates, with the efforts it actually
 * advertises (`off, low, high, max` on every one of them) and the descriptions it ships.
 *
 * Read from a live catalog capture, not from memory. This is the only
 * fixture in this file with real slugs, and the four names below are why.
 */
const REAL_CATALOG: RouteCatalog = {
  routes: [
    {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      efforts: ['off', 'low', 'high', 'max'],
      defaultEffort: 'high',
      credentialRef: 'DEEPSEEK_API_KEY',
      credentialSource: 'declared',
    },
    { provider: 'deepseek-official', model: 'deepseek-v4-flash', efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'high' },
    { provider: 'deepseek-official', model: 'deepseek-v4-pro', efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'high' },
    {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      efforts: ['off', 'low', 'high', 'max'],
      defaultEffort: 'high',
    },
  ],
  unavailable: [],
}

/**
 * The worked example the README prints, with the route names read from the live catalog rather
 * than copied from the brief.
 *
 * **One deviation from the brief's literal example, and it is load-bearing.** The brief's example
 * lists `"bug-fix": ["main", "fast"]`, which the same brief refuses two paragraphs later: "a
 * **scalar** task listing two names must be refused by name, not silently narrowed to the first".
 * `bug-fix` is not a panel role, so that pair is exactly the case the schema must reject — an
 * example that contradicts the rule it documents is worse than one that does not. `bug-fix` is
 * therefore single-valued here, and the multi-name comparison case lives where it belongs, on
 * `arena-runners`. Everything else is byte-for-byte the brief's example.
 */
const README_EXAMPLE = `{
  "version": 2,
  "models": {
    "main":     { "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "off", "description": "the default; most tasks" },
    "smart":    { "provider": "deepseek-official", "model": "deepseek-v4-pro", "reasoningEffort": "max", "description": "planning and hard reasoning" },
    "fast":     { "provider": "deepseek-official", "model": "deepseek-v4-flash", "reasoningEffort": "low", "description": "cheap parallel work" },
    "vision":   { "provider": "deepseek-official", "model": "deepseek-v4-flash-vision-exp" }
  },
  "tasks": {
    "feature":             ["main"],
    "judgment-and-prose":  ["smart"],
    "arena-runners":       ["smart", "main", "fast"],
    "bug-fix":             ["main"]
  }
}`

/** Parse and unwrap, failing the test with the parser's own message when it rejects. */
function parsed(text: string): OverlayFile {
  const result = parseOverlay(text)
  assert.ok(result.ok, `fixture overlay was rejected: ${result.ok ? '' : result.error}`)
  return result.value
}

/** The parse error, failing the test when the text was accepted. */
function rejected(text: string): string {
  const result = parseOverlay(text)
  assert.equal(result.ok, false, `expected a rejection, got ${JSON.stringify(result.ok ? result.value : null)}`)
  return result.ok ? '' : result.error
}

/** A version 2 overlay built by hand, for the cases a file literal would only obscure. */
function v2(models: OverlayFileV2['models'], tasks: OverlayFileV2['tasks']): OverlayFileV2 {
  return { version: 2, models, tasks }
}

test('normaliseRoleKey accepts prose and kebab spellings, and passes kebab through', () => {
  assert.equal(normaliseRoleKey('judgment and prose'), 'judgment-and-prose')
  assert.equal(normaliseRoleKey('judgment-and-prose'), 'judgment-and-prose')
  assert.equal(normaliseRoleKey('arena cross-judge pool'), 'arena-cross-judge-pool')
  assert.equal(normaliseRoleKey('swarm workers'), 'swarm-workers')
  assert.equal(normaliseRoleKey('  Arena   Cross-Judge Pool  '), 'arena-cross-judge-pool')
  assert.equal(normaliseRoleKey('feature'), 'feature')
  assert.equal(normaliseRoleKey('generalPurpose'), 'generalpurpose')
})

test('canonicalRole keeps the three spawn role values verbatim and never folds them together', () => {
  assert.deepEqual([...SPAWN_ROLE_VALUES], ['generalPurpose', 'poteto-agent', 'comment-sicko'])
  assert.equal(canonicalRole('generalPurpose'), 'generalPurpose')
  assert.equal(canonicalRole('generalpurpose'), 'generalPurpose')
  assert.equal(canonicalRole('poteto-agent'), 'poteto-agent')
  assert.equal(canonicalRole('comment-sicko'), 'comment-sicko')
  // The scratch probe's rule (`roles.ts:53`) — `generalPurpose` -> `poteto-agent` — must not hold.
  assert.notEqual(canonicalRole('generalPurpose'), 'poteto-agent')
  assert.equal(canonicalRole('judgment and prose'), 'judgment-and-prose')
})

test('the vocabulary lists every documented role and marks exactly the four panel roles', () => {
  assert.equal(ROLE_KEYS.length, 21)
  assert.ok(ROLE_KEYS.includes('independent-verifier'))
  assert.ok(ROLE_KEYS.includes('swarm-workers'))
  assert.deepEqual(
    [...PANEL_ROLES],
    ['arena-runners', 'arena-cross-judge-pool', 'architect-runners', 'interrogate-reviewers'],
  )
  for (const key of ['arena-runners', 'swarm-workers', 'feature']) assert.ok(ROLE_KEYS.includes(key as never))
  assert.deepEqual(
    ROLE_KEYS.filter((key) => isPanelRole(key)),
    [...PANEL_ROLES],
  )
})

// ---------------------------------------------------------------------------------------------
// ACCEPTANCE 1: version 2 parses, an unknown name is refused, a scalar task with two names is
// refused, and version 1 still parses.
// ---------------------------------------------------------------------------------------------

test('the version 2 example parses with its named models, tasks and descriptions intact', () => {
  const overlay = parsed(README_EXAMPLE)
  assert.equal(overlay.version, 2)
  if (overlay.version !== 2) return
  assert.deepEqual(Object.keys(overlay.models), ['main', 'smart', 'fast', 'vision'])
  assert.deepEqual(overlay.models['main'], {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'off',
    description: 'the default; most tasks',
  })
  assert.equal(overlay.models['vision']?.reasoningEffort, undefined)
  assert.deepEqual(overlay.tasks, {
    feature: ['main'],
    'judgment-and-prose': ['smart'],
    'arena-runners': ['smart', 'main', 'fast'],
    'bug-fix': ['main'],
  })
})

test('the version 2 example survives a serialise/parse round trip', () => {
  const overlay = parsed(README_EXAMPLE)
  assert.deepEqual(parsed(serializeOverlay(overlay)), overlay)
  assert.ok(serializeOverlay(overlay).endsWith('\n'))
})

test('an unknown model name in a task is refused at parse time, naming the task and the name', () => {
  const error = rejected('{"version":2,"tasks":{"feature":["slug-from-memory"]}}')
  assert.match(error, /overlay task "feature" names the model "slug-from-memory"/)
  assert.match(error, /neither built-in nor declared under "models"/)
  assert.match(error, /a task never silently inherits/)
})

test('an unknown model name is refused even when "models" is present and other names resolve', () => {
  const error = rejected(
    '{"version":2,"models":{"main":{"provider":"test-provider","model":"test-model"}},"tasks":{"bug-fix":["nope"]}}',
  )
  assert.match(error, /task "bug-fix" names the model "nope"/)
  assert.match(error, /declared: main/)
})

test('a scalar task listing two names is refused by name, not narrowed to the first', () => {
  const error = rejected('{"version":2,"tasks":{"feature":["main","fast"]}}')
  assert.match(error, /overlay task "feature" lists 2 model names but "feature" is not a panel role/)
  assert.match(error, /arena-runners, arena-cross-judge-pool, architect-runners, interrogate-reviewers/)
  assert.match(error, /Keep one name, or move the comparison to a panel task/)
})

test('a panel task listing several names parses, because that is what a panel is for', () => {
  const overlay = parsed('{"version":2,"tasks":{"arena-runners":["main","fast","smart"]}}')
  assert.equal(overlay.version, 2)
  if (overlay.version !== 2) return
  assert.deepEqual(overlay.tasks['arena-runners'], ['main', 'fast', 'smart'])
})

test('version 1 still parses, key for key, and is never read as a tasks map', () => {
  const overlay = parsed(
    '{"version":1,"roles":{"judgment and prose":{"inherit":true},"arena cross-judge pool":{"routes":[{"provider":"test-provider","model":"test-model"}]}}}',
  )
  assert.equal(overlay.version, 1)
  if (overlay.version !== 1) return
  assert.deepEqual(Object.keys(overlay.roles).sort(), ['arena-cross-judge-pool', 'judgment-and-prose'])
  assert.deepEqual(overlay.roles['judgment-and-prose'], { inherit: true })
  assert.equal(Object.hasOwn(overlay, 'tasks'), false)
  assert.deepEqual(parsed('{"version":1}'), { version: 1, roles: {} })
  assert.deepEqual(parsed('{"version":1,"roles":{}}'), { version: 1, roles: {} })
})

test('a version 1 file reads as everything inherits, and the note says which routes that costs', () => {
  const overlay = parsed(
    '{"version":1,"roles":{"feature":{"routes":[{"provider":"test-provider","model":"test-model","reasoningEffort":"high"}]},"bug-fix":{"inherit":true}}}',
  )
  const resolved = resolveRole('feature', overlay, CATALOG)
  assert.equal(resolved.inherit, true)
  assert.equal(resolved.route, undefined)
  assert.equal(resolved.reason, 'overlay is version 1; every task inherits the parent\'s route')

  const note = overlayVersionNote(overlay)
  assert.ok(note !== undefined)
  assert.match(note, /version 1 overlay/)
  assert.match(note, /"feature", and those routes are NOT applied/)
  assert.match(note, /everything inherits the parent/)
  assert.match(note, /Write a version 2 file/)
})

test('the version note distinguishes "nothing was set" from "a route is not applied"', () => {
  assert.equal(overlayVersionNote(undefined), undefined)
  assert.equal(overlayVersionNote(parsed('{"version":2}')), undefined)
  const empty = overlayVersionNote(parsed('{"version":1,"roles":{"feature":{"inherit":true}}}'))
  assert.match(empty ?? '', /nothing was set and nothing is lost/)
})

test('a version the build does not know is refused by name', () => {
  assert.match(rejected('{"version":3,"roles":{}}'), /version must be 1 or 2, got 3/)
  assert.match(rejected('{"version":2.5}'), /version must be 1 or 2, got 2\.5/)
  assert.match(rejected('{"roles":{}}'), /version must be 1 or 2, got undefined/)
  assert.match(rejected('{"version":"2"}'), /version must be 1 or 2, got "2"/)
})

test('parseOverlay rejects malformed files with a message worth showing a user', async (t) => {
  const cases: readonly { readonly name: string; readonly text: string; readonly error: RegExp }[] = [
    { name: 'invalid JSON', text: '{not json', error: /not valid JSON/ },
    { name: 'not an object', text: '[]', error: /must be a JSON object/ },
    { name: 'unknown top-level key in v2', text: '{"version":2,"roles":{}}', error: /version 2 has unknown top-level key "roles"/ },
    { name: 'roles not an object', text: '{"version":1,"roles":[]}', error: /"roles" must be an object/ },
    { name: 'models not an object', text: '{"version":2,"models":[]}', error: /"models" must be an object/ },
    { name: 'tasks not an object', text: '{"version":2,"tasks":[]}', error: /"tasks" must be an object/ },
    { name: 'task names not an array', text: '{"version":2,"tasks":{"feature":"main"}}', error: /task "feature" must be an array of model names/ },
    { name: 'task name is a number', text: '{"version":2,"tasks":{"feature":[3]}}', error: /task "feature" has a malformed model name \(3\)/ },
    { name: 'model missing provider', text: '{"version":2,"models":{"main":{"model":"test-model"}}}', error: /model "main" needs a non-empty "provider" string/ },
    { name: 'model missing model', text: '{"version":2,"models":{"main":{"provider":"test-provider"}}}', error: /model "main" needs a non-empty "model" string/ },
    { name: 'model malformed effort', text: '{"version":2,"models":{"main":{"provider":"test-provider","model":"test-model","reasoningEffort":3}}}', error: /model "main" has a malformed "reasoningEffort" \(3\)/ },
    { name: 'model unknown key', text: '{"version":2,"models":{"main":{"provider":"test-provider","model":"test-model","effort":"high"}}}', error: /model "main" has unknown key "effort"/ },
    { name: 'model malformed description', text: '{"version":2,"models":{"main":{"provider":"test-provider","model":"test-model","description":"  "}}}', error: /model "main" has a malformed "description"/ },
    { name: 'empty model name', text: '{"version":2,"models":{"  ":{"provider":"test-provider","model":"test-model"}}}', error: /model name that is empty after trimming/ },
    { name: 'two spellings of one task', text: '{"version":2,"tasks":{"judgment and prose":["main"],"judgment-and-prose":["main"]}}', error: /are the same task "judgment-and-prose"/ },
    { name: 'empty task key', text: '{"version":2,"tasks":{"  ":["main"]}}', error: /task key that is empty after normalisation/ },
    { name: 'entry neither inherit nor routes', text: '{"version":1,"roles":{"feature":{}}}', error: /role "feature" must be \{"inherit": true\} or \{"routes": \[\.\.\.\]\}/ },
    { name: 'entry is a string', text: '{"version":1,"roles":{"feature":"inherit"}}', error: /role "feature" must be/ },
    { name: 'inherit false', text: '{"version":1,"roles":{"feature":{"inherit":false}}}', error: /"inherit" must be true \(got false\)/ },
    { name: 'inherit and routes together', text: '{"version":1,"roles":{"feature":{"inherit":true,"routes":[]}}}', error: /has both "inherit" and "routes"/ },
    { name: 'routes not an array', text: '{"version":1,"roles":{"feature":{"routes":"test-model"}}}', error: /"routes" must be an array/ },
    { name: 'route missing provider', text: '{"version":1,"roles":{"feature":{"routes":[{"model":"test-model"}]}}}', error: /route 1 needs a non-empty "provider" string/ },
    { name: 'route missing model', text: '{"version":1,"roles":{"feature":{"routes":[{"provider":"test-provider"}]}}}', error: /route 1 needs a non-empty "model" string/ },
    { name: 'route model is whitespace', text: '{"version":1,"roles":{"feature":{"routes":[{"provider":"test-provider","model":"   "}]}}}', error: /needs a non-empty "model" string/ },
    { name: 'malformed effort number', text: '{"version":1,"roles":{"feature":{"routes":[{"provider":"test-provider","model":"test-model","reasoningEffort":3}]}}}', error: /malformed "reasoningEffort" \(3\)/ },
    { name: 'malformed effort empty', text: '{"version":1,"roles":{"feature":{"routes":[{"provider":"test-provider","model":"test-model","reasoningEffort":""}]}}}', error: /malformed "reasoningEffort"/ },
    { name: 'unknown route key', text: '{"version":1,"roles":{"feature":{"routes":[{"provider":"test-provider","model":"test-model","effort":"high"}]}}}', error: /unknown key "effort"/ },
    { name: 'two spellings of one role', text: '{"version":1,"roles":{"judgment and prose":{"inherit":true},"judgment-and-prose":{"inherit":true}}}', error: /are the same role "judgment-and-prose"/ },
    { name: 'empty role key', text: '{"version":1,"roles":{"  ":{"inherit":true}}}', error: /empty after normalisation/ },
  ]
  for (const item of cases) {
    await t.test(item.name, () => {
      const result = parseOverlay(item.text)
      assert.equal(result.ok, false, `${item.name} was accepted`)
      assert.match(result.ok ? '' : result.error, item.error)
    })
  }
})

// ---------------------------------------------------------------------------------------------
// ACCEPTANCE 3 and 4: resolution, built-ins, and the panel contract the spawn tool consumes.
// ---------------------------------------------------------------------------------------------

test('rule 1: a task with no entry inherits the parent', () => {
  const resolved = resolveRole('feature', v2({}, {}), CATALOG)
  assert.deepEqual(resolved, {
    role: 'feature',
    inherit: true,
    reason: 'no overlay entry for "feature"; inherits the parent\'s route',
  })
})

test('rule 1 also holds when there is no overlay file at all', () => {
  assert.deepEqual(resolveRole('feature', undefined, CATALOG), {
    role: 'feature',
    inherit: true,
    reason: 'no overlay entry for "feature"; inherits the parent\'s route',
  })
})

test('an empty task list and the inherit-parent name both inherit, with their own reason', () => {
  const empty = resolveRole('feature', v2({}, { feature: [] }), CATALOG)
  assert.equal(empty.inherit, true)
  assert.match(empty.reason, /lists no models; inherits the parent's route/)

  const sentinel = resolveRole('feature', v2({}, { feature: [INHERIT_PARENT_MODEL] }), CATALOG)
  assert.equal(sentinel.inherit, true)
  assert.equal(sentinel.route, undefined)
  assert.match(sentinel.reason, /names "inherit-parent"; inherits the parent's route/)
})

test('a task pointing at a named model resolves to that model full route, effort included', () => {
  const overlay = parsed(README_EXAMPLE)
  const resolved = resolveRole('feature', overlay, REAL_CATALOG)
  assert.equal(resolved.inherit, false)
  assert.deepEqual(resolved.route, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'off',
  })
  assert.equal(resolved.routeIndex, undefined)
  assert.match(resolved.reason, /overlay entry for "feature" names the model "main"/)
  assert.match(resolved.reason, /effort off/)
})

test('a hand-built overlay with a prose task key resolves the same as its kebab spelling', () => {
  const overlay = v2(
    { smart: { provider: 'test-provider', model: 'test-alt', reasoningEffort: 'high' } },
    { 'judgment and prose': ['smart'] },
  )
  const byKebab = resolveRole('judgment-and-prose', overlay, CATALOG)
  const byProse = resolveRole('judgment and prose', overlay, CATALOG)
  assert.equal(byKebab.inherit, false)
  assert.deepEqual(byKebab.route, byProse.route)
  assert.deepEqual(byKebab.route, { provider: 'test-provider', model: 'test-alt', reasoningEffort: 'high' })
})

test('a declared model overrides a built-in of the same name', () => {
  const overlay = v2({ main: { provider: 'test-provider', model: 'test-model', reasoningEffort: 'low' } }, { feature: ['main'] })
  const resolved = resolveRole('feature', overlay, CATALOG)
  assert.deepEqual(resolved.route, { provider: 'test-provider', model: 'test-model', reasoningEffort: 'low' })
  assert.deepEqual(namedModelAssignment('main', overlay), {
    provider: 'test-provider',
    model: 'test-model',
    reasoningEffort: 'low',
  })
})

test('a panel task exposes one resolution per name, in order, each with a distinct routeIndex', () => {
  const overlay = parsed(README_EXAMPLE)
  const indices = ['smart', 'main', 'fast']
  const panel = resolvePanel('arena-runners', overlay, REAL_CATALOG)
  assert.deepEqual(
    panel.map((entry) => entry.routeIndex),
    [0, 1, 2],
  )
  assert.deepEqual(
    panel.map((entry) => entry.route?.model),
    ['deepseek-v4-pro', 'deepseek-flash', 'deepseek-v4-flash'],
  )
  assert.deepEqual(
    panel.map((entry) => entry.route?.reasoningEffort),
    ['max', 'off', 'low'],
  )
  assert.deepEqual(
    panel.map((entry) => entry.inherit),
    [false, false, false],
  )
  for (const name of indices) assert.match(panel[indices.indexOf(name)]?.reason ?? '', new RegExp(`names the model "${name}"`))

  // The default is entry 0, so a caller that forgets the index gets the first name, not garbage.
  assert.deepEqual(resolveRole('arena-runners', overlay, REAL_CATALOG).route, panel[0]?.route)
  const outOfRange = resolveRole('arena-runners', overlay, REAL_CATALOG, 3)
  assert.equal(outOfRange.inherit, true)
  assert.match(outOfRange.reason, /out of range/)
})

test('resolvePanel is a one-entry list for a scalar task, an inheriting panel, and a v1 file', () => {
  const overlay = parsed(README_EXAMPLE)
  assert.equal(resolvePanel('feature', overlay, REAL_CATALOG).length, 1)
  assert.equal(resolvePanel('arena-runners', v2({}, {}), CATALOG).length, 1)
  assert.equal(resolvePanel('arena-runners', undefined, CATALOG).length, 1)
  assert.equal(resolvePanel('arena-runners', parsed('{"version":1,"roles":{}}'), CATALOG).length, 1)
})

test('a model whose route the catalog records as unavailable is reported, never spawned', () => {
  const overlay = v2({ broken: { provider: 'test-provider', model: 'test-broken' } }, { feature: ['broken'] })
  const resolved = resolveRole('feature', overlay, CATALOG)
  assert.equal(resolved.inherit, true)
  assert.equal(resolved.route, undefined)
  assert.ok(resolved.reason.startsWith(UNAVAILABLE_REASON_PREFIX), resolved.reason)
  assert.match(resolved.reason, /test-provider\/test-broken/)
  assert.match(resolved.reason, /adapter says no/)
})

test('a model on a provider the catalog never registered is refused, not passed through', () => {
  const overlay = v2({ invented: { provider: 'test-invented', model: 'test-imaginary' } }, { feature: ['invented'] })
  const resolved = resolveRole('feature', overlay, CATALOG)
  assert.equal(resolved.inherit, true)
  assert.equal(resolved.route, undefined)
  assert.match(resolved.reason, /not in the live catalog/)
  assert.match(resolved.reason, /not in the live catalog/)
})

test('an effort the route does not advertise is refused and the advertised ones named', () => {
  const overlay = v2(
    { alt: { provider: 'test-provider', model: 'test-alt', reasoningEffort: 'max' } },
    { feature: ['alt'] },
  )
  const resolved = resolveRole('feature', overlay, CATALOG)
  assert.equal(resolved.inherit, true)
  assert.equal(resolved.route, undefined)
  assert.match(resolved.reason, /does not advertise reasoningEffort "max" \(advertises: off, high\)/)
})

test('off is a legitimate effort: accepted where advertised, refused where it is not', () => {
  const advertised = resolveRole(
    'feature',
    v2({ alt: { provider: 'test-provider', model: 'test-alt', reasoningEffort: 'off' } }, { feature: ['alt'] }),
    CATALOG,
  )
  assert.equal(advertised.inherit, false)
  assert.deepEqual(advertised.route, { provider: 'test-provider', model: 'test-alt', reasoningEffort: 'off' })

  const notAdvertised = resolveRole(
    'feature',
    v2({ second: { provider: 'test-other', model: 'test-second', reasoningEffort: 'off' } }, { feature: ['second'] }),
    CATALOG,
  )
  assert.equal(notAdvertised.inherit, true)
  assert.match(notAdvertised.reason, /does not advertise reasoningEffort "off" \(advertises: none\)/)
})

test('an omitted effort stays omitted and the reason names the adapter default', () => {
  const overlay = v2({ plain: { provider: 'test-provider', model: 'test-model' } }, { feature: ['plain'] })
  const resolved = resolveRole('feature', overlay, CATALOG)
  assert.deepEqual(resolved.route, { provider: 'test-provider', model: 'test-model' })
  assert.match(resolved.reason, /no effort set, adapter default high/)
})

test('ACCEPTANCE 4: the built-in names resolve with no models block at all', () => {
  // Every argument here is the bare `{"version": 2}` form: nothing declared, no boilerplate.
  const bare = parsed('{"version": 2}')
  assert.equal(bare.version, 2)

  for (const builtIn of ['main', 'smart', 'fast', 'vision'] as const) {
    const overlay = parsed(JSON.stringify({ version: 2, tasks: { feature: [builtIn] } }))
    const resolved = resolveRole('feature', overlay, REAL_CATALOG)
    assert.equal(resolved.inherit, false, `${builtIn} did not resolve: ${resolved.reason}`)
    assert.equal(resolved.route?.provider, 'deepseek-official')
    assert.equal(resolved.route?.reasoningEffort, builtInModel(builtIn)?.reasoningEffort)
  }
  assert.equal(resolveRole('feature', bare, REAL_CATALOG).inherit, true)

  const main = resolveRole('feature', parsed('{"version":2,"tasks":{"feature":["main"]}}'), REAL_CATALOG)
  assert.equal(main.route?.model, 'deepseek-flash')
  assert.deepEqual(main.route, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' })
  assert.equal(resolveRole('feature', parsed('{"version":2,"tasks":{"feature":["smart"]}}'), REAL_CATALOG).route?.model, 'deepseek-v4-pro')
  assert.equal(resolveRole('feature', parsed('{"version":2,"tasks":{"feature":["fast"]}}'), REAL_CATALOG).route?.model, 'deepseek-v4-flash')
  assert.equal(
    resolveRole('feature', parsed('{"version":2,"tasks":{"feature":["vision"]}}'), REAL_CATALOG).route?.model,
    'deepseek-v4-flash-vision-exp',
  )
})

test('builtInModel answers the documented assignment for each built-in and nothing for inherit-parent', () => {
  assert.deepEqual([...BUILT_IN_MODEL_NAMES], ['main', 'smart', 'fast', 'vision', 'inherit-parent'])
  assert.equal(builtInModel('main')?.model, 'deepseek-flash')
  assert.equal(builtInModel('smart')?.model, 'deepseek-v4-pro')
  assert.equal(builtInModel('fast')?.model, 'deepseek-v4-flash')
  assert.equal(builtInModel('vision')?.model, 'deepseek-v4-flash-vision-exp')
  assert.equal(builtInModel(INHERIT_PARENT_MODEL), undefined)
  assert.equal(builtInModel('not-a-built-in'), undefined)
  assert.equal(namedModelAssignment('main', undefined)?.model, 'deepseek-flash')
})

test('a built-in whose route the catalog lacks inherits with a reason rather than losing its effort', () => {
  const resolved = resolveRole('feature', parsed('{"version":2,"tasks":{"feature":["main"]}}'), CATALOG)
  assert.equal(resolved.inherit, true)
  assert.match(resolved.reason, /overlay entry for "feature" names the model "main", whose route deepseek-official\/deepseek-flash is not in the live catalog/)
})

test('a built-in effort the route does not advertise is refused, off included', () => {
  const offOnly: RouteCatalog = {
    routes: [{ provider: 'deepseek-official', model: 'deepseek-flash', efforts: ['high'], defaultEffort: 'high' }],
    unavailable: [],
  }
  const resolved = resolveRole('feature', parsed('{"version":2,"tasks":{"feature":["main"]}}'), offOnly)
  assert.equal(resolved.inherit, true)
  assert.match(resolved.reason, /does not advertise reasoningEffort "off" \(advertises: high\)/)
})

test('an empty or whitespace role name inherits with a reason rather than a mangled key', () => {
  const resolved = resolveRole('   ', undefined, CATALOG)
  assert.equal(resolved.inherit, true)
  assert.match(resolved.reason, /role name is empty/)
})

test('generalPurpose resolves as itself: the generic delegate is not poteto-agent', () => {
  // The frozen skills use `generalPurpose` 9 times; the scratch probe
  // folded it into `poteto-agent` and that is the defect this test exists to keep out.
  const overlay = parsed('{"version":2,"tasks":{"generalPurpose":["main"],"poteto-agent":[]}}')
  const generic = resolveRole('generalPurpose', overlay, REAL_CATALOG)
  assert.equal(generic.role, 'generalPurpose')
  assert.equal(generic.inherit, false)
  assert.equal(generic.route?.model, 'deepseek-flash')

  const poteto = resolveRole('poteto-agent', overlay, REAL_CATALOG)
  assert.equal(poteto.role, 'poteto-agent')
  assert.equal(poteto.inherit, true)

  const commentSicko = resolveRole('comment-sicko', overlay, REAL_CATALOG)
  assert.equal(commentSicko.role, 'comment-sicko')
  assert.equal(commentSicko.inherit, true)
  assert.equal(commentSicko.reason, 'no overlay entry for "comment-sicko"; inherits the parent\'s route')
})

test('a resolved route is copied, so a caller cannot mutate the imported overlay', () => {
  const overlay = v2({ plain: { provider: 'test-provider', model: 'test-model' } }, { feature: ['plain'] })
  const resolved = resolveRole('feature', overlay, CATALOG)
  assert.notEqual(resolved.route, overlay.models['plain'])
  assert.deepEqual(resolved.route, { provider: 'test-provider', model: 'test-model' })
  assert.deepEqual(overlay.models['plain'], { provider: 'test-provider', model: 'test-model' })
})

test('parseOverlay accepts the v2 example byte for byte and writes it back hand-editable', () => {
  const overlay = parsed(README_EXAMPLE)
  const text = serializeOverlay(overlay)
  assert.match(text, /\n {2}"version": 2,/)
  assert.match(text, /\n {2}"models": \{/)
  assert.match(text, /\n {2}"tasks": \{/)
  assert.deepEqual(parsed(text), overlay)
})
