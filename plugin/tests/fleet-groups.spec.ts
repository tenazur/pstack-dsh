/**
 * The fleet groups module on its own: the defaults, the projection onto the overlay, the import,
 * and every rejection the parser makes.
 *
 * These are rung 4 checks over a pure module — no Host, no filesystem, no HTTP — and the fixture
 * catalog carries **this machine's four real routes and the efforts the adapter really advertises**
 * (`off, low, high, max`), because a heuristic tested against invented slugs proves nothing about
 * the heuristic the machine will run. The one place a route is deliberately absent is the vision
 * test, which needs a catalog without one to prove an unmatched capability leaves the violin empty
 * rather than pointing it at a model that cannot see.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RouteCatalog } from '../src/roles/catalog.ts'
import { PANEL_ROLES, ROLE_KEYS, parseOverlay, resolveRole, serializeOverlay } from '../src/roles/overlay.ts'
import {
  PREDEFINED_VIOLIN_IDS,
  defaultGroups,
  fromOverlay,
  isComparisonViolinId,
  isPredefinedViolinId,
  parseFleetGroups,
  repairedGroups,
  serializeFleetGroups,
  slugifyViolinId,
  toOverlay,
  unassignedTasks,
  violinModelNames,
  violinOfTask,
  violinProblems,
  withSelections,
  withTask,
  withViolin,
  withViolinName,
  withoutTask,
  withoutViolin,
} from '../src/roles/fleet-groups.ts'
import type { FleetGroupsFile, Violin } from '../src/roles/fleet-groups.ts'

/** The four routes this machine enumerates, with their advertised efforts. */
const CATALOG: RouteCatalog = {
  routes: [
    { provider: 'deepseek-official', model: 'deepseek-flash', efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'max' },
    {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      efforts: ['off', 'low', 'high', 'max'],
      defaultEffort: 'max',
      description: 'Fast, efficient, and economical; suited to focused, routine, or parallel tasks.',
    },
    {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      efforts: ['off', 'low', 'high', 'max'],
      defaultEffort: 'max',
      description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
    },
    { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp', efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'max' },
  ],
  unavailable: [{ provider: 'pi-ai', why: 'credential "PI_API_KEY" is not configured' }],
}

/** The session default this machine runs: `deepseek-flash` at `off` (`~/.dsh/settings.yaml`). */
const SESSION_DEFAULT = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' }

/** A violin by id, or a failure that says which ids exist. */
function violin(groups: FleetGroupsFile, id: string): Violin {
  const found = groups.violins.find((entry) => entry.id === id)
  assert.ok(found, `no violin "${id}"; have ${groups.violins.map((entry) => entry.id).join(', ')}`)
  return found
}

// ---------------------------------------------------------------------------------------------
// The defaults: what a fresh install starts from.
// ---------------------------------------------------------------------------------------------

test('the default fleet is five single violins plus one comparison violin per panel task', () => {
  const groups = defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT })

  assert.deepEqual(
    groups.violins.filter((entry) => entry.origin === 'predefined').map((entry) => entry.id),
    [...PREDEFINED_VIOLIN_IDS],
    'the five predefined violins, in the page order',
  )
  assert.deepEqual(
    groups.violins.filter((entry) => entry.origin === 'comparison').map((entry) => entry.id),
    [...PANEL_ROLES],
    'one comparison violin per panel task',
  )
  // A comparison violin holds models, not a task: its id *is* the task key, so a membership list
  // would be the violin wearing its own name.
  for (const key of PANEL_ROLES) {
    assert.deepEqual(violin(groups, key).tasks, [], `${key} holds no tasks`)
    assert.ok(violin(groups, key).selections.length >= 2, `${key} is the model list that task runs`)
  }
})

test('general follows the session default route, and working is that route thinking harder', () => {
  const groups = defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT })

  assert.deepEqual(violin(groups, 'general').selections, [
    { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' },
  ])
  assert.deepEqual(violin(groups, 'working').selections, [
    { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
  ])
})

test('the capability violins pick by hint and never repeat the general route while another matches', () => {
  const groups = defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT })

  // `fast` would match `deepseek-flash` first by id; it must take the other flash model instead, so
  // the fleet is not five names for one route.
  assert.equal(violin(groups, 'fast').selections[0]?.model, 'deepseek-v4-flash')
  assert.equal(violin(groups, 'fast').selections[0]?.reasoningEffort, 'low', 'cheap but still thinking')
  assert.equal(violin(groups, 'planning').selections[0]?.model, 'deepseek-v4-pro')
  assert.equal(violin(groups, 'planning').selections[0]?.reasoningEffort, 'max')
  assert.equal(violin(groups, 'vision').selections[0]?.model, 'deepseek-v4-flash-vision-exp')
  // The adapter's own sentence travels with the selection, so the page shows the adapter's words.
  assert.match(String(violin(groups, 'fast').selections[0]?.description), /Fast, efficient, and economical/)
})

test('a capability the catalog does not offer leaves its violin empty rather than lying', () => {
  const blind: RouteCatalog = { routes: CATALOG.routes.filter((route) => !route.model.includes('vision')), unavailable: [] }
  const groups = defaultGroups({ catalog: blind, sessionDefault: SESSION_DEFAULT })

  assert.deepEqual(violin(groups, 'vision').selections, [], 'no route can see, so nothing is offered')
  // Its tasks stay where they were placed: an empty violin hands them back to the parent, which is
  // the honest degradation and is what `toOverlay` writes.
  assert.deepEqual(toOverlay(groups, ROLE_KEYS).tasks['comment-sicko'], ['inherit-parent'])
})

test('an empty catalog produces violins with no selections, and a legal document', () => {
  const groups = defaultGroups({ catalog: { routes: [], unavailable: [] } })
  for (const id of PREDEFINED_VIOLIN_IDS) assert.deepEqual(violin(groups, id).selections, [])

  const overlay = toOverlay(groups, ROLE_KEYS)
  assert.deepEqual(Object.keys(overlay.models), [], 'nothing to declare')
  assert.deepEqual(overlay.tasks['feature'], ['inherit-parent'], 'and every task says so rather than naming nobody')
  assert.equal(parseOverlay(serializeOverlay(overlay)).ok, true)
})

// ---------------------------------------------------------------------------------------------
// The projection: what the spawn path reads.
// ---------------------------------------------------------------------------------------------

test('every task key is written: its violin name, or general, and never silently dropped', () => {
  const groups = defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT })
  const assigned = withTask(groups, 'feature', 'planning')
  const overlay = toOverlay(assigned, ROLE_KEYS)

  assert.deepEqual(overlay.tasks['feature'], ['planning'], 'the violin it was put in')
  assert.deepEqual(overlay.tasks['refactoring'], ['general'], 'unassigned tasks run on general')
  assert.deepEqual(overlay.tasks['arena-runners'], [...violinModelNames(violin(assigned, 'arena-runners'))])
  assert.deepEqual(
    Object.keys(overlay.tasks).sort(),
    [...ROLE_KEYS].sort(),
    'all 21 keys are stated, so the file says what runs where instead of leaving it to the resolver',
  )
  assert.equal(parseOverlay(serializeOverlay(overlay)).ok, true, 'and the overlay parser accepts it')
})

test('the default fleet places tasks, and every task key survives into the derived file', () => {
  const groups = defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT })

  // The placement is a judgement, so what is asserted is the invariant, not the table: a task is
  // held by exactly one violin or by none, never by two, and the overlay states every key either
  // way. A task that vanished from the projection would spawn on a route nobody chose.
  const owners = new Map<string, string[]>()
  for (const violin of groups.violins) {
    for (const task of violin.tasks) owners.set(task, [...(owners.get(task) ?? []), violin.id])
  }
  for (const [task, holders] of owners) {
    assert.equal(holders.length, 1, `"${task}" is held by ${holders.join(' and ')}; one task belongs to one violin`)
  }
  assert.equal(parseFleetGroups(serializeFleetGroups(groups)).ok, true, 'and the defaults are a file this build accepts')

  const overlay = toOverlay(groups, ROLE_KEYS)
  assert.deepEqual(Object.keys(overlay.tasks).sort(), [...ROLE_KEYS].sort(), 'all 21 keys, placed or not')
  for (const key of PANEL_ROLES) {
    assert.equal(overlay.tasks[key]?.length, 2, `${key} runs the two models its own violin lists`)
  }

  // The placement is not empty either: a fresh fleet that places nothing would pass the invariant
  // above while being exactly the state the human asked to be rid of.
  // Every *assignable* task is placed; the four comparison keys are served by the violin that bears
  // their name, which is a placement too — just one expressed by the violin existing.
  assert.deepEqual(
    [...owners.keys()].sort(),
    ROLE_KEYS.filter((key) => !PANEL_ROLES.includes(key)).sort(),
    'every assignable task key is placed: a task left out would run on a route nobody chose for it',
  )
  assert.ok(violin(groups, 'general').tasks.includes('feature'), 'ordinary work runs on the session route')
  assert.ok(violin(groups, 'planning').tasks.includes('judgment-and-prose'), 'the hardest reasoning is planned for')
  assert.deepEqual(violin(groups, 'fast').tasks, ['how-explorer'], 'the high-volume reading is the cheap one')
  assert.deepEqual(violin(groups, 'vision').tasks, ['poteto-agent', 'comment-sicko'], 'the screen-readers are on the vision route')
  // A comparison task is not in any violin's `tasks` list: the violin that bears its name *is* its
  // assignment. The overlay still states it — checked below by resolving each key — which is why
  // "unassigned" means "no violin holds it" and never "nothing routes it".
})

test('the derived document resolves the way the spawn path reads it', () => {
  const groups = withTask(defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT }), 'feature', 'planning')
  const overlay = parseOverlay(serializeOverlay(toOverlay(groups, ROLE_KEYS)))
  assert.equal(overlay.ok, true)
  if (!overlay.ok) return

  const feature = resolveRole('feature', overlay.value, CATALOG)
  assert.equal(feature.inherit, false)
  assert.deepEqual(feature.route, { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' })

  const refactoring = resolveRole('refactoring', overlay.value, CATALOG)
  assert.deepEqual(refactoring.route, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' })

  // The comparison violin fans out one child per selection, which is the point of it.
  const panel = parseOverlay(serializeOverlay(toOverlay(defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT }), ROLE_KEYS)))
  assert.equal(panel.ok, true)
  if (!panel.ok) return
  const first = resolveRole('arena-runners', panel.value, CATALOG, 0)
  const second = resolveRole('arena-runners', panel.value, CATALOG, 1)
  assert.equal(first.route?.model, 'deepseek-v4-pro')
  assert.equal(second.route?.model, 'deepseek-flash')
})

test('a violin with several selections writes one numbered model name per selection', () => {
  const groups = withSelections(defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT }), 'arena-runners', [
    { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
    { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' },
  ])
  const overlay = toOverlay(groups, ROLE_KEYS)

  assert.deepEqual(violinModelNames(violin(groups, 'arena-runners')), ['arena-runners-1', 'arena-runners-2'])
  assert.deepEqual(Object.keys(overlay.models).filter((name) => name.startsWith('arena-runners')), [
    'arena-runners-1',
    'arena-runners-2',
  ])
  assert.deepEqual(overlay.tasks['arena-runners'], ['arena-runners-1', 'arena-runners-2'])
})

test('a violin with no selection hands its tasks back to the parent instead of naming nobody', () => {
  const emptied = withSelections(defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT }), 'planning', [])
  const overlay = toOverlay(withTask(emptied, 'feature', 'planning'), ROLE_KEYS)

  assert.deepEqual(overlay.tasks['feature'], ['inherit-parent'])
  assert.equal(parseOverlay(serializeOverlay(overlay)).ok, true)
})

test('the defaults place every assignable task; the comparison keys are served by their own violins', () => {
  const groups = defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT })
  // A comparison key is in no violin's task list — it does not need to be, because the violin that
  // bears its name is its assignment — so it is excluded from the band the page shows.
  assert.deepEqual(unassignedTasks(groups, ROLE_KEYS), [], 'nothing is left running on a route nobody chose')

  // Unassigning one puts it back in the band, in the build's own order.
  const released = withoutTask(groups, 'why-synthesizer')
  assert.deepEqual(unassignedTasks(released, ROLE_KEYS), ['why-synthesizer'])
  assert.deepEqual(
    unassignedTasks(withoutTask(released, 'feature'), ROLE_KEYS),
    ROLE_KEYS.filter((key) => key === 'feature' || key === 'why-synthesizer'),
    'the order is ROLE_KEYS order, not the order they were released in',
  )
})

// ---------------------------------------------------------------------------------------------
// The rules the parser and the catalogue check enforce.
// ---------------------------------------------------------------------------------------------

test('one task belongs to exactly one violin, and moving it takes it out of the other', () => {
  const base = defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT })
  const moved = withTask(base, 'how-explainer', 'working')

  assert.ok(!violin(moved, 'planning').tasks.includes('how-explainer'), 'the task left the violin it was in')
  // `working` starts with `hillclimb` now, so the moved task joins it rather than being the only one.
  assert.deepEqual(violin(moved, 'working').tasks, ['hillclimb', 'how-explainer'])
  assert.equal(violinOfTask(moved, 'how-explainer')?.id, 'working')
  assert.equal(parseFleetGroups(serializeFleetGroups(moved)).ok, true)
})

test('the parser refuses one task in two violins, by name', () => {
  const fresh = defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT })
  // The placement is cleared first: this test is about two violins holding one task, and every task
  // already has an owner.
  const base: FleetGroupsFile = { version: 1, violins: fresh.violins.map((entry) => ({ ...entry, tasks: [] })) }
  const doubled: FleetGroupsFile = {
    version: 1,
    violins: base.violins.map((entry) =>
      entry.id === 'planning' ? { ...entry, tasks: ['feature'] } : entry.id === 'working' ? { ...entry, tasks: ['feature'] } : entry,
    ),
  }
  const parsed = parseFleetGroups(serializeFleetGroups(doubled))
  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  assert.match(parsed.error, /task "feature" is assigned to both "\w[\w-]*" and "\w[\w-]*"/)
  assert.match(parsed.error, /"working"/)
  assert.match(parsed.error, /"planning"/)
  assert.match(parsed.error, /one task belongs to exactly one violin/)
})

test('the parser refuses a file that has lost a predefined or comparison violin', () => {
  const fresh = defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT })
  // Two violins holding the same task would be refused for a different reason, so the placement is
  // cleared first: this test is about a missing violin.
  const base: FleetGroupsFile = { version: 1, violins: fresh.violins.map((entry) => ({ ...entry, tasks: isComparisonViolinId(entry.id) ? [entry.id] : [] })) }
  const withoutGeneral = parseFleetGroups(serializeFleetGroups({ version: 1, violins: base.violins.filter((v) => v.id !== 'general') }))
  assert.equal(withoutGeneral.ok, false)
  if (!withoutGeneral.ok) assert.match(withoutGeneral.error, /the predefined violin "general" is missing/)

  const withoutArena = parseFleetGroups(serializeFleetGroups({ version: 1, violins: base.violins.filter((v) => v.id !== 'arena-runners') }))
  assert.equal(withoutArena.ok, false)
  if (!withoutArena.ok) assert.match(withoutArena.error, /the comparison violin "arena-runners" is missing/)
})

test('the parser refuses a capability violin declared as custom, so an id cannot be shadowed', () => {
  const fresh = defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT })
  const base: FleetGroupsFile = { version: 1, violins: fresh.violins.map((entry) => ({ ...entry, tasks: isComparisonViolinId(entry.id) ? [entry.id] : [] })) }
  const shadowed = {
    version: 1,
    violins: base.violins.map((entry) => (entry.id === 'fast' ? { ...entry, origin: 'custom' } : entry)),
  }
  const parsed = parseFleetGroups(JSON.stringify(shadowed))
  assert.equal(parsed.ok, false)
  if (!parsed.ok) assert.match(parsed.error, /"fast" is one of the predefined violins/)
})

test('the parser refuses a malformed selection, an unknown origin and an unknown key, by name', () => {
  const fresh = defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT })
  const base: FleetGroupsFile = { version: 1, violins: fresh.violins.map((entry) => ({ ...entry, tasks: isComparisonViolinId(entry.id) ? [entry.id] : [] })) }
  const mutate = (change: (violins: Violin[]) => unknown): string => {
    const violins = base.violins.map((entry) => ({ ...entry, selections: [...entry.selections], tasks: [...entry.tasks] }))
    return JSON.stringify({ version: 1, violins: change(violins) })
  }

  const badEffort = parseFleetGroups(
    mutate((violins) =>
      violins.map((entry) => (entry.id === 'general' ? { ...entry, selections: [{ provider: 'p', model: 'm', reasoningEffort: '' }] } : entry)),
  ))
  assert.equal(badEffort.ok, false)
  if (!badEffort.ok) assert.match(badEffort.error, /malformed "reasoningEffort"/)

  const badOrigin = parseFleetGroups(mutate((violins) => violins.map((entry) => (entry.id === 'general' ? { ...entry, origin: 'sandbox' } : entry))))
  assert.equal(badOrigin.ok, false)
  if (!badOrigin.ok) assert.match(badOrigin.error, /origin "sandbox"; allows predefined, comparison, custom/)

  const extraKey = parseFleetGroups(
    mutate((violins) => violins.map((entry) => (entry.id === 'general' ? { ...entry, apiKey: 'sk-secret' } : entry))),
  )
  assert.equal(extraKey.ok, false)
  if (!extraKey.ok) assert.match(extraKey.error, /unknown key "apiKey"/)

  const twoIds = parseFleetGroups(mutate((violins) => [...violins, { ...violins[0], name: 'twin' }]))
  assert.equal(twoIds.ok, false)
  if (!twoIds.ok) assert.match(twoIds.error, /two violins share the id "general"/)
})

test('a comparison violin holding several models may not keep a task that names only one', () => {
  const groups = withSelections(defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT }), 'planning', [
    { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
    { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' },
  ])
  const withFeature = withTask(groups, 'feature', 'planning')
  const problems = violinProblems(withFeature, CATALOG)

  assert.equal(problems.length, 1, `expected one problem, got ${problems.join(' | ')}`)
  assert.match(String(problems[0]), /violin "planning" has 2 model selections and holds "judgment-and-prose"/)
  assert.match(String(problems[0]), /"feature"/)
  assert.match(String(problems[0]), /only arena-runners, arena-cross-judge-pool, architect-runners, interrogate-reviewers may list several/)

  // The same shape is legal when the only tasks in it are comparison tasks.
  const legal = withSelections(defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT }), 'arena-runners', [
    { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
    { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' },
  ])
  assert.deepEqual(violinProblems(legal, CATALOG), [])
})

test('the catalogue check names a route that is not enumerated and an effort it does not advertise', () => {
  const groups = withSelections(defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT }), 'general', [
    { provider: 'pi-ai', model: 'pi-1', reasoningEffort: 'high' },
  ])
  const problems = violinProblems(groups, CATALOG)
  assert.equal(problems.length, 1)
  assert.match(String(problems[0]), /violin "general" selection 1 \(pi-ai\/pi-1\) is not in the live catalog/)
  assert.match(String(problems[0]), /credential "PI_API_KEY" is not configured/, 'the catalog own recorded reason rides along')

  const badEffort = withSelections(defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT }), 'general', [
    { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'xhigh' },
  ])
  const effortProblems = violinProblems(badEffort, CATALOG)
  assert.equal(effortProblems.length, 1)
  assert.match(String(effortProblems[0]), /asks for reasoningEffort "xhigh" but the route advertises off, low, high, max/)
})

// ---------------------------------------------------------------------------------------------
// Editing helpers, and the import.
// ---------------------------------------------------------------------------------------------

test('adding a violin slugs the typed name, numbers a collision, and cannot shadow a predefined id', () => {
  const base = defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT })

  const added = withViolin(base, 'My Reviewer!')
  assert.equal(added.id, 'my-reviewer')
  assert.equal(added.groups.violins.at(-1)?.origin, 'custom')
  assert.deepEqual(added.groups.violins.at(-1)?.tasks, [], 'a new violin owns nothing yet')
  assert.equal(slugifyViolinId('  ...  '), 'violin', 'an unslugabble name still gets an id')
  assert.equal(slugifyViolinId('Fast'), 'fast')

  const collision = withViolin(added.groups, 'My Reviewer!')
  assert.equal(collision.id, 'my-reviewer-2')

  // A name that slugs onto a predefined id is numbered rather than allowed to shadow it.
  const shadow = withViolin(base, 'Fast')
  assert.equal(shadow.id, 'fast-2')
  assert.equal(violin(shadow.groups, 'fast').origin, 'predefined')
})

test('a custom violin can be deleted; a predefined one cannot, and an id rename never moves the key', () => {
  const base = defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT })
  const { groups: added, id } = withViolin(base, 'reviewer')

  const removed = withoutViolin(added, id)
  assert.equal(removed.removed, true)
  assert.equal(removed.groups.violins.length, base.violins.length)

  const refused = withoutViolin(base, 'general')
  assert.equal(refused.removed, false)
  assert.equal(refused.groups, base, 'and the group set comes back untouched')

  const renamed = withViolinName(base, 'planning', 'the planner')
  assert.equal(violin(renamed, 'planning').name, 'the planner')
  assert.equal(violin(renamed, 'planning').id, 'planning', 'the id is what the overlay names, so it stays')
})

test('unassigning a task leaves it in no violin, and the projection sends it to general', () => {
  const groups = withoutTask(withTask(defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT }), 'feature', 'planning'), 'feature')
  assert.equal(violinOfTask(groups, 'feature'), undefined)
  assert.deepEqual(toOverlay(groups, ROLE_KEYS).tasks['feature'], ['general'])
})

test('importing an overlay keeps the names it declared, their routes and their task assignments', () => {
  const overlay = parseOverlay(
    JSON.stringify({
      version: 2,
      models: {
        general: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' },
        reviewer: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
      },
      tasks: {
        feature: ['general'],
        refactoring: ['reviewer'],
        'arena-runners': ['general', 'reviewer'],
      },
    }),
  )
  assert.equal(overlay.ok, true)
  if (!overlay.ok) return

  const { groups, dropped } = fromOverlay(overlay.value, { catalog: CATALOG, sessionDefault: SESSION_DEFAULT })

  // A declared name that matches a predefined violin replaces that violin's selections, and the
  // tasks it was holding move with it; a declared name with no counterpart arrives as a custom one.
  assert.equal(violin(groups, 'general').selections[0]?.model, 'deepseek-flash')
  assert.equal(violin(groups, 'general').origin, 'predefined')
  assert.equal(violin(groups, 'reviewer').selections[0]?.model, 'deepseek-v4-pro')
  assert.equal(violin(groups, 'reviewer').origin, 'custom')
  assert.deepEqual(violin(groups, 'reviewer').tasks, ['refactoring'])
  assert.ok(violin(groups, 'general').tasks.includes('feature'))
  // A comparison task takes its whole list into its own violin, in the overlay's order.
  assert.deepEqual(
    violin(groups, 'arena-runners').selections.map((entry) => entry.model),
    ['deepseek-flash', 'deepseek-v4-pro'],
  )
  assert.deepEqual(dropped, [], 'every declared name had an assignment to import')
  assert.deepEqual(violin(groups, 'arena-runners').tasks, ['arena-runners'])
  // What came in is what goes back out: the round trip is the claim that matters.
  const overlay2 = toOverlay(groups, ROLE_KEYS)
  assert.deepEqual(overlay2.tasks['feature'], ['general'])
  assert.deepEqual(overlay2.tasks['refactoring'], ['reviewer'])
  assert.deepEqual(overlay2.tasks['arena-runners'], ['arena-runners-1', 'arena-runners-2'])
  assert.deepEqual(overlay2.models['reviewer'], { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' })
  assert.deepEqual(overlay2.models['general'], { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' })
  assert.equal(parseOverlay(serializeOverlay(overlay2)).ok, true)
})

test('importing a version 1 file or nothing at all lands on the defaults', () => {
  const v1 = parseOverlay(JSON.stringify({ version: 1, roles: { feature: { routes: [{ provider: 'p', model: 'm' }] } } }))
  assert.equal(v1.ok, true)
  if (!v1.ok) return

  const imported = fromOverlay(v1.value, { catalog: CATALOG, sessionDefault: SESSION_DEFAULT })
  const fresh = defaultGroups({ catalog: CATALOG, sessionDefault: SESSION_DEFAULT })
  assert.deepEqual(imported.groups, fresh, 'a v1 file carries routes v2 cannot read as models, so nothing is imported')

  assert.deepEqual(fromOverlay(undefined, { catalog: CATALOG, sessionDefault: SESSION_DEFAULT }).groups, fresh)
})

test('importing reports a built-in name the file pointed at but never declared', () => {
  const overlay = parseOverlay(JSON.stringify({ version: 2, models: {}, tasks: { feature: ['main'] } }))
  assert.equal(overlay.ok, true)
  if (!overlay.ok) return

  const { groups, dropped } = fromOverlay(overlay.value, { catalog: CATALOG, sessionDefault: SESSION_DEFAULT })
  assert.deepEqual(dropped, ['main'], 'a built-in resolves, but nothing was written for it to import')
  // `feature` stays where the defaults put it: the file named a name with no assignment, so there is
  // nothing to move it to, and the defaults' own placement is the honest answer.
  assert.deepEqual(violinOfTask(groups, 'feature')?.id, 'general')
})

test('repair makes an unusable group set writable again, and says what it did', () => {
  const broken: FleetGroupsFile = {
    version: 1,
    violins: [
      { id: 'general', name: 'general', origin: 'predefined', selections: [], tasks: ['feature'] },
      { id: 'general', name: 'twin', origin: 'predefined', selections: [], tasks: [] },
      { id: 'custom-a', name: 'custom-a', origin: 'custom', selections: [], tasks: ['feature'] },
    ],
  }
  const { groups, repairs } = repairedGroups(broken)

  assert.ok(repairs.some((line) => line.includes('dropped a second violin with the id "general"')))
  assert.ok(repairs.some((line) => line.includes('unassigned "feature" from "custom-a"')))
  assert.ok(repairs.some((line) => line.includes('added the missing violin "working"')))
  assert.ok(repairs.some((line) => line.includes('added the missing violin "arena-runners"')))
  assert.equal(parseFleetGroups(serializeFleetGroups(groups)).ok, true, 'and the result is a file this build accepts')
  assert.deepEqual(violin(groups, 'arena-runners').tasks, ['arena-runners'], 'a restored comparison violin takes its task back')
})

test('the helper predicates agree with the ids they describe', () => {
  assert.equal(isPredefinedViolinId('general'), true)
  assert.equal(isPredefinedViolinId('arena-runners'), false)
  assert.equal(isComparisonViolinId('arena-cross-judge-pool'), true)
  assert.equal(isComparisonViolinId('fast'), false)
})
