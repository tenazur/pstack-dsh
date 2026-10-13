/**
 * The fleet groups file: **violins**, and the projection of them onto the overlay.
 *
 * ## Why a second file exists at all
 *
 * The overlay (`$DSH_HOME/pstack.json`, `plugin/src/roles/overlay.ts`) answers one question and
 * answers it well: *which route does this task run on*. It cannot answer the question a person
 * actually asks when they open the settings page — *what is this group of models for, and which
 * tasks belong to it* — because its `models` block is a flat bag of names and its `tasks` block is
 * a flat bag of pointers. The groups file carries the missing structure:
 *
 * - a **violin** has an identity (`id`), a place in the page (`origin`), **one or more model
 *   selections** (`provider` + `model` + effort), and the **tasks assigned to it**;
 * - predefined violins exist from the first run and cannot be deleted, only edited;
 * - one task belongs to exactly one violin, and a violin may hold many tasks;
 * - a task in no violin is **unassigned**, and runs on the `general` violin.
 *
 * The two files are not two truths: the groups file is the source of truth for everything the page
 * edits, and the overlay is **derived** from it by {@link toOverlay}. That derivation is a pure
 * function, which is what makes "editing settings from the settings UI updates the old-style
 * settings" a property of the code rather than a habit: the spawn path (`resolveRole`,
 * `resolvePanel`, `pstack_spawn`, the ported skills) never learns violins exist.
 *
 * ## Two kinds of violin, and the rule that tells them apart
 *
 * A violin's `id` is the model name the overlay declares. What the violin **is** decides how the
 * overlay reads it:
 *
 * - a **single-model violin** is a place to put tasks: its `tasks` list holds the keys assigned to
 *   it, and it writes `models[id]`;
 * - a **comparison violin** is itself the task. Its id is a panel task key, and
 *   its selections are what that task runs — one child per name for a fan-out
 *   (`arena-runners`, `architect-runners`, `interrogate-reviewers`) or one name chosen from the list
 *   for a pool (`arena-cross-judge-pool`). It therefore holds **no tasks**: a pointer from the task
 *   to itself would say nothing, and the page would show a violin wearing its own name as a chip.
 *
 * A comparison violin with several selections writes `models[id-1] … models[id-n]`, because the
 * overlay's `tasks` values are lists of **names** and the same name twice would state nothing about
 * which selection it meant. Numbers keep the mapping reversible, which is what {@link fromOverlay}
 * relies on.
 *
 * ## What is deliberately heuristic, and what is not
 *
 * {@link defaultGroups} has to put *some* route in each predefined violin, and this package may
 * never write a slug it did not read from the live catalog. So the rule
 * is: choose among enumerated routes only, by matching documented word-hints against the route's
 * model id and the adapter's own description. Nothing is constructed, nothing is remembered, and a
 * violin whose capability the catalog does not offer is left with **no selection** and says so,
 * rather than pointing at a model that cannot do the job. Every heuristic is in one table below,
 * so it can be argued with.
 *
 * ## What the parser refuses, by name
 *
 * Every rejection names the offender: the violin, the task, the route, the effort. A task in two
 * violins, a violin with several models holding a task that may name only one, a selection the live
 * catalog does not have, an effort the route does not advertise, an empty name, a duplicate id.
 * `plugin/src/roles/overlay.ts` re-checks the derived document against the same catalog on write,
 * so a hole here cannot become a file the host would refuse.
 */
import type { RouteCatalog } from './catalog.ts'
import { PANEL_ROLES } from './overlay.ts'
import type { OverlayFile, OverlayFileV2, OverlayModel } from './overlay.ts'

/** One `provider + model + effort` a violin can run a child on. */
export interface ViolinSelection {
  readonly provider: string
  readonly model: string
  /**
   * The effort that is part of this selection. `off` is a value, not an omission: writing it means
   * "run with reasoning off", while omitting it means "let the adapter materialise its default".
   */
  readonly reasoningEffort?: string
  /** One line of prose the page shows next to the selection. */
  readonly description?: string
}

/** Where a violin came from. Predefined violins cannot be deleted; custom ones can. */
export type ViolinOrigin = 'predefined' | 'comparison' | 'custom'

/** One violin: a named group of model selections that owns some tasks. */
export interface Violin {
  /** The model name this violin declares in the overlay. Also the page's key for it. */
  readonly id: string
  /** The label the page shows. Equal to {@link id} for a predefined violin. */
  readonly name: string
  readonly origin: ViolinOrigin
  /** One selection for a plain violin, several for a comparison violin. Empty is legal. */
  readonly selections: readonly ViolinSelection[]
  /** The task keys assigned to this violin. A task appears in at most one violin. */
  readonly tasks: readonly string[]
}

/** The groups file. Every field is written by this build; nothing else is preserved. */
export interface FleetGroupsFile {
  readonly version: 1
  readonly violins: readonly Violin[]
}

/**
 * The five violins that exist before anyone edits anything, in the order the page lists them.
 *
 * `general` is the fallback every unassigned task runs on, which is why it is first and why it can
 * never be deleted. The other four are the shapes of work a fleet needs: something that works,
 * something that plans, something cheap to fan out, something that can see.
 */
export const PREDEFINED_VIOLIN_IDS = ['general', 'working', 'planning', 'fast', 'vision'] as const

/** One predefined violin's identity. */
export type PredefinedViolinId = (typeof PREDEFINED_VIOLIN_IDS)[number]

/** True for a name that is one of the five single-selection violins. */
export function isPredefinedViolinId(id: string): id is PredefinedViolinId {
  return (PREDEFINED_VIOLIN_IDS as readonly string[]).includes(id)
}

/** True for a violin whose task key is a comparison container. */
export function isComparisonViolinId(id: string): boolean {
  return (PANEL_ROLES as readonly string[]).includes(id)
}

/**
 * The word-hints each predefined violin matches against an enumerated route, in order.
 *
 * A hint is matched case-insensitively against the model id **and** the adapter's own description
 * (`UsableRoute.description`), never against anything this package wrote. The table is the whole
 * heuristic: if it is wrong, it is wrong here, in one place, in words a person can correct.
 */
const ROUTE_HINTS: Record<PredefinedViolinId, readonly string[]> = {
  // Picked below by preference, not by hint: `general` follows the session's own default route.
  general: [],
  working: [],
  planning: ['pro', 'reason', 'thinking', 'opus', 'sonnet', 'difficult', 'complex', 'quality'],
  fast: ['flash', 'mini', 'fast', 'lite', 'haiku', 'nano', 'small', 'economical', 'routine'],
  vision: ['vision', 'vl', 'image', 'multimodal', 'screenshot'],
}

/**
 * The effort each predefined violin prefers, best first; the first one the route advertises wins.
 *
 * `general` is absent on purpose: it runs at whatever the session itself is configured to use.
 * `fast` prefers `low` over `off` so a cheap child still reasons a little rather than not at all.
 */
const EFFORT_PREFERENCE: Record<Exclude<PredefinedViolinId, 'general'>, readonly string[]> = {
  working: ['high', 'medium', 'max', 'low'],
  planning: ['max', 'xhigh', 'high', 'medium', 'low'],
  fast: ['low', 'off', 'minimal', 'medium'],
  vision: ['medium', 'high', 'default', 'low', 'off'],
}

/** The route the session itself runs, when the caller can read it (`agent-default-model`). */
export interface SessionDefaultRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Options for {@link defaultGroups}. */
export interface DefaultGroupsOptions {
  /** The live route inventory. Nothing is chosen that is not in here. */
  readonly catalog: RouteCatalog
  /** The session's own default route, used for `general` before any heuristic is tried. */
  readonly sessionDefault?: SessionDefaultRoute | undefined
}

/** True when the catalog enumerates this route. */
function isEnumerated(catalog: RouteCatalog, provider: string, model: string): boolean {
  return catalog.routes.some((route) => route.provider === provider && route.model === model)
}

/** The advertised efforts of one route, empty when the catalog does not have it. */
function effortsOf(catalog: RouteCatalog, provider: string, model: string): readonly string[] {
  return catalog.routes.find((route) => route.provider === provider && route.model === model)?.efforts ?? []
}

/** The first preferred effort the route advertises, or `undefined` when it advertises none of them. */
function preferredEffort(preferred: readonly string[], advertised: readonly string[]): string | undefined {
  for (const candidate of preferred) if (advertised.includes(candidate)) return candidate
  return advertised[0]
}

/** A route's model id and description, lowercased, for hint matching. */
function searchableText(entry: { readonly model: string; readonly description?: string }): string {
  return `${entry.model} ${entry.description ?? ''}`.toLowerCase()
}

/**
 * The first enumerated route whose id or description carries one of `hints`, skipping `avoid`.
 *
 * `avoid` is what keeps `fast` from resolving to the very route `general` already uses when the
 * catalog offers a second, more obviously cheap model: a fleet whose five violins all point at one
 * route is not a fleet, and the page would be showing five names for one answer.
 * @param catalog - the live inventory.
 * @param hints - lowercase word-hints, matched as substrings.
 * @param avoid - a `provider/model` to prefer against, when any other route matches.
 * @returns the route, or `undefined` when nothing matches.
 */
function routeMatching(
  catalog: RouteCatalog,
  hints: readonly string[],
  avoid?: string,
): { readonly provider: string; readonly model: string } | undefined {
  const matches = catalog.routes.filter((entry) => {
    const text = searchableText(entry)
    return hints.some((hint) => text.includes(hint))
  })
  if (matches.length === 0) return undefined
  const chosen = matches.find((entry) => `${entry.provider}/${entry.model}` !== avoid) ?? matches[0]
  return chosen === undefined ? undefined : { provider: chosen.provider, model: chosen.model }
}

/** One selection object, with the effort only when there is one to write. */
function selection(
  provider: string,
  model: string,
  effort: string | undefined,
  description?: string,
): ViolinSelection {
  return {
    provider,
    model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    ...(description === undefined ? {} : { description }),
  }
}

/**
 * Where every task starts. **Every task key is placed**, so a fresh fleet is a working fleet and the
 * unassigned band opens empty.
 *
 * The human's instruction was "populate all tasks by default", and it settles an argument this table
 * used to leave open. Leaving a task unassigned **is not neutral**: it runs on `general`, which is a
 * route nobody chose for it. Placing it is a decision, and a decision stated in one table that a
 * person can change in one click beats a silence that reads as "nobody has thought about this yet".
 *
 * Four rules decided the rows, all of them about the shape of the work rather than about the model:
 *
 * - **`general`** — ordinary work, and the largest group. A task that needs a competent model and
 *   nothing special belongs on the session's own route; that is what makes `general` the fallback
 *   rather than a leftover.
 * - **`planning`** — the tasks whose value is judgement: the hardest reasoning, the synthesis, the
 *   verification that must not share the author's blind spots.
 * - **`fast`** — the high-volume mechanical reading: many sources, cheap per item, no judgement.
 * - **`vision`** — the tasks handed a screen. `plugin/agents/poteto-agent.md` and
 *   `plugin/skills/no-comments/` both read files and diffs a model must be able to look at.
 *
 * A comparison task is never listed here: each of the four already belongs to its own violin, and a
 * task belongs to exactly one — so `arena-cross-judge-pool`, which looks like cheap parallel work,
 * stays in the comparison violin that owns it.
 *
 * These are starting points, not policy. Every one is a click away from another violin, and the
 * comparison violins are the only ones that can hold more than one model.
 */
const TASK_PLACEMENT: Record<string, readonly string[]> = {
  general: ['feature', 'refactoring', 'bug-fix', 'perf-issue', 'reflect-tooling', 'swarm-workers'],
  // The long grind: many small verified steps, which is what the session's own route thinking harder
  // is for. It gives `working` a job — a violin with a route and no task is a placeholder.
  working: ['hillclimb'],
  planning: [
    'judgment-and-prose',
    'hardest-tasks',
    'how-explainer',
    'why-investigators',
    'why-synthesizer',
    'independent-verifier',
    'reflect-judgment',
  ],
  fast: ['how-explorer'],
  vision: ['poteto-agent', 'comment-sicko'],
}

/**
 * The tasks each violin starts with, over {@link TASK_PLACEMENT}.
 *
 * A comparison violin starts with none: its id is the task key it serves, so there is nothing to
 * assign. What a person can edit there is the model list, which is the whole of that task's routing.
 * @param id - the violin id.
 * @returns the task keys, in a stable order.
 */
function defaultTasksFor(id: string): readonly string[] {
  return TASK_PLACEMENT[id] ?? []
}

/**
 * The default fleet: five single-selection violins and one comparison violin per panel task.
 *
 * The rules, in order, all over enumerated routes only:
 *
 * 1. `general` — the session's own default route when the catalog has it, else the catalog's first
 *    route, at the session's configured effort when that route advertises it. This is the route a
 *    child would inherit anyway, which is what makes `general` the honest fallback.
 * 2. `working` — the same route as `general`, at {@link EFFORT_PREFERENCE}.working. "The model you
 *    are already talking to, thinking harder" is a defensible default for the tasks that write code.
 * 3. `planning`, `fast`, `vision` — {@link routeMatching} with their hint table, avoiding
 *    `general`'s route when another route matches, at their own preferred effort. A capability the
 *    catalog does not offer leaves the violin **empty**: no selection, and the page says so.
 * 4. each of the four comparison violins ({@link PANEL_ROLES}) holds two selections and **no tasks**
 *    — `planning`'s and `working`'s — which is cross-family on a two-family catalog and
 *    same-family here. The page states the fan-out width; what that
 *    means when the routes are the same is stated where the width is chosen.
 * 5. every task in {@link TASK_PLACEMENT} is placed, and the table covers **all** of `ROLE_KEYS`
 *    except the four comparison keys, which belong to their own violins. A fresh fleet therefore has
 *    an empty unassigned band: nothing is left running on a route nobody chose for it.
 *
 * @param options - the live catalog and, optionally, the session's own route.
 * @returns the groups a fresh install starts from.
 */
export function defaultGroups(options: DefaultGroupsOptions): FleetGroupsFile {
  const { catalog } = options
  const first = catalog.routes[0]
  const session = options.sessionDefault
  const generalRoute =
    session !== undefined && isEnumerated(catalog, session.provider, session.model)
      ? { provider: session.provider, model: session.model }
      : first === undefined
        ? undefined
        : { provider: first.provider, model: first.model }

  const generalEffort =
    generalRoute === undefined
      ? undefined
      : session !== undefined &&
          session.provider === generalRoute.provider &&
          session.model === generalRoute.model &&
          session.reasoningEffort !== undefined &&
          effortsOf(catalog, generalRoute.provider, generalRoute.model).includes(session.reasoningEffort)
        ? session.reasoningEffort
        : preferredEffort(['default'], effortsOf(catalog, generalRoute.provider, generalRoute.model))

  const generalKey = generalRoute === undefined ? undefined : `${generalRoute.provider}/${generalRoute.model}`
  const generalSelection =
    generalRoute === undefined ? undefined : selection(generalRoute.provider, generalRoute.model, generalEffort)

  const workingSelection =
    generalRoute === undefined
      ? undefined
      : selection(
          generalRoute.provider,
          generalRoute.model,
          preferredEffort(EFFORT_PREFERENCE.working, effortsOf(catalog, generalRoute.provider, generalRoute.model)),
        )

  const capability = (id: Exclude<PredefinedViolinId, 'general' | 'working'>): ViolinSelection | undefined => {
    const match = routeMatching(catalog, ROUTE_HINTS[id], generalKey)
    if (match === undefined) return undefined
    const effort = preferredEffort(EFFORT_PREFERENCE[id], effortsOf(catalog, match.provider, match.model))
    const described = catalog.routes.find((route) => route.provider === match.provider && route.model === match.model)
    return selection(match.provider, match.model, effort, described?.description)
  }

  const planning = capability('planning')
  const fast = capability('fast')
  const vision = capability('vision')

  const single: Violin[] = PREDEFINED_VIOLIN_IDS.map((id) => {
    const chosen =
      id === 'general' ? generalSelection : id === 'working' ? workingSelection : id === 'planning' ? planning : id === 'fast' ? fast : vision
    return {
      id,
      name: id,
      origin: 'predefined' as const,
      selections: chosen === undefined ? [] : [chosen],
      tasks: defaultTasksFor(id),
    }
  })

  const comparison: Violin[] = PANEL_ROLES.map((key) => ({
    id: key,
    name: key,
    origin: 'comparison' as const,
    selections: [planning, workingSelection].filter((entry): entry is ViolinSelection => entry !== undefined),
    // No tasks: the violin's **id is the task key**, so its model list is the whole assignment. A
    // task belongs to a violin only when a person chooses to put it there.
    tasks: [],
  }))

  return { version: 1, violins: [...single, ...comparison] }
}

/** True for a JSON object that is not an array and not null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-empty string after trimming, or `undefined`. */
function readText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length > 0 ? text : undefined
}

/** Render a value for an error message without ever throwing on odd input. */
function show(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

/** Parse result. `error` is written to be shown to the person who hand-edited the file. */
export type ParseGroupsResult =
  | { readonly ok: true; readonly value: FleetGroupsFile }
  | { readonly ok: false; readonly error: string }

/** Validate one selection object. */
function parseSelection(
  where: string,
  raw: unknown,
): { readonly ok: true; readonly value: ViolinSelection } | { readonly ok: false; readonly error: string } {
  if (!isRecord(raw)) {
    return { ok: false, error: `${where} must be an object like {"provider": "...", "model": "..."}, got ${show(raw)}` }
  }
  const allowed = ['provider', 'model', 'reasoningEffort', 'description']
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      return { ok: false, error: `${where} has unknown key ${show(key)}; allows ${allowed.join(', ')}` }
    }
  }
  const provider = readText(raw['provider'])
  if (provider === undefined) {
    return { ok: false, error: `${where} needs a non-empty "provider" string, got ${show(raw['provider'])}` }
  }
  const model = readText(raw['model'])
  if (model === undefined) {
    return { ok: false, error: `${where} needs a non-empty "model" string, got ${show(raw['model'])}` }
  }
  const effort = raw['reasoningEffort'] === undefined ? undefined : readText(raw['reasoningEffort'])
  if (raw['reasoningEffort'] !== undefined && effort === undefined) {
    return {
      ok: false,
      error: `${where} has a malformed "reasoningEffort" (${show(raw['reasoningEffort'])}); expected a non-empty effort id such as "high", or omit it`,
    }
  }
  const description = raw['description'] === undefined ? undefined : readText(raw['description'])
  if (raw['description'] !== undefined && description === undefined) {
    return {
      ok: false,
      error: `${where} has a malformed "description" (${show(raw['description'])}); expected a non-empty line of prose, or omit it`,
    }
  }
  return {
    ok: true,
    value: {
      provider,
      model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      ...(description === undefined ? {} : { description }),
    },
  }
}

/** The origins a file may declare, in the page's band order. */
const ORIGINS: readonly ViolinOrigin[] = ['predefined', 'comparison', 'custom']

/**
 * Parse a groups file. Never throws; every rejection carries a message written for the person who
 * edited the file, and every message names the violin or the key that is wrong.
 * @param text - the file's contents.
 * @returns the parsed file, or the reason it was rejected.
 */
export function parseFleetGroups(text: string): ParseGroupsResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: `fleet groups file is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!isRecord(raw)) {
    return { ok: false, error: `fleet groups file must be a JSON object with "version" and "violins", got ${show(raw)}` }
  }
  if (raw['version'] !== 1) {
    return { ok: false, error: `fleet groups version must be 1, got ${show(raw['version'])}` }
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'version' && key !== 'violins') {
      return { ok: false, error: `fleet groups file has unknown top-level key ${show(key)}; allows version, violins` }
    }
  }
  const rawViolins = raw['violins'] === undefined ? [] : raw['violins']
  if (!Array.isArray(rawViolins)) {
    return { ok: false, error: `fleet groups "violins" must be an array, got ${show(rawViolins)}` }
  }

  const violins: Violin[] = []
  const byId = new Map<string, number>()
  const taskOwner = new Map<string, string>()
  for (const [index, rawViolin] of rawViolins.entries()) {
    const where = `fleet groups violin ${index + 1}`
    if (!isRecord(rawViolin)) {
      return { ok: false, error: `${where} must be an object, got ${show(rawViolin)}` }
    }
    for (const key of Object.keys(rawViolin)) {
      if (key !== 'id' && key !== 'name' && key !== 'origin' && key !== 'selections' && key !== 'tasks') {
        return { ok: false, error: `${where} has unknown key ${show(key)}; allows id, name, origin, selections, tasks` }
      }
    }
    const id = readText(rawViolin['id'])
    if (id === undefined) {
      return { ok: false, error: `${where} needs a non-empty "id" string, got ${show(rawViolin['id'])}` }
    }
    if (byId.has(id)) {
      return { ok: false, error: `two violins share the id ${show(id)}; ids are the model names in the overlay and must be unique` }
    }
    byId.set(id, index)
    const name = readText(rawViolin['name']) ?? id

    const origin = rawViolin['origin']
    if (typeof origin !== 'string' || !ORIGINS.includes(origin as ViolinOrigin)) {
      return { ok: false, error: `${where} ("${id}") has origin ${show(origin)}; allows ${ORIGINS.join(', ')}` }
    }
    if (isPredefinedViolinId(id) && origin !== 'predefined') {
      return { ok: false, error: `violin "${id}" is one of the predefined violins (${PREDEFINED_VIOLIN_IDS.join(', ')}) and cannot be declared as ${show(origin)}` }
    }
    if (isComparisonViolinId(id) && origin !== 'comparison') {
      return { ok: false, error: `violin "${id}" names the comparison task "${id}" and must be declared with origin "comparison"` }
    }

    const rawSelections = rawViolin['selections'] === undefined ? [] : rawViolin['selections']
    if (!Array.isArray(rawSelections)) {
      return { ok: false, error: `${where} ("${id}") "selections" must be an array, got ${show(rawSelections)}` }
    }
    const selections: ViolinSelection[] = []
    for (const [at, rawSelection] of rawSelections.entries()) {
      const parsed = parseSelection(`violin "${id}" selection ${at + 1}`, rawSelection)
      if (!parsed.ok) return parsed
      selections.push(parsed.value)
    }

    const rawTasks = rawViolin['tasks'] === undefined ? [] : rawViolin['tasks']
    if (!Array.isArray(rawTasks)) {
      return { ok: false, error: `${where} ("${id}") "tasks" must be an array of task keys, got ${show(rawTasks)}` }
    }
    const tasks: string[] = []
    for (const rawTask of rawTasks) {
      const task = readText(rawTask)
      if (task === undefined) {
        return { ok: false, error: `violin "${id}" has a malformed task key (${show(rawTask)}); expected a non-empty string` }
      }
      const owner = taskOwner.get(task)
      if (owner !== undefined) {
        return {
          ok: false,
          error: `task "${task}" is assigned to both "${owner}" and "${id}"; one task belongs to exactly one violin — unassign it from one of them first`,
        }
      }
      taskOwner.set(task, id)
      tasks.push(task)
    }

    violins.push({
      id,
      name,
      origin: origin as ViolinOrigin,
      selections,
      tasks,
    })
  }

  for (const id of PREDEFINED_VIOLIN_IDS) {
    if (!byId.has(id)) {
      return {
        ok: false,
        error: `the predefined violin "${id}" is missing; the file must declare all of ${PREDEFINED_VIOLIN_IDS.join(', ')} (the page repairs this by writing them back)`,
      }
    }
  }
  for (const key of PANEL_ROLES) {
    if (!byId.has(key)) {
      return {
        ok: false,
        error: `the comparison violin "${key}" is missing; a fleet needs one per comparison task (${PANEL_ROLES.join(', ')})`,
      }
    }
  }

  return { ok: true, value: { version: 1, violins } }
}

/**
 * The file's text. `parseFleetGroups(serializeFleetGroups(value))` returns an equal value, and the
 * 2-space indent plus trailing newline is what makes the file hand-editable.
 * @param value - the file to write.
 * @returns the file's text.
 */
export function serializeFleetGroups(value: FleetGroupsFile): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * The catalogue-checked problems in a group set: what the live catalog cannot honour.
 *
 * This is the write-time half of the rule "a route that is not currently usable is
 * **rejected on write**". Every problem names the violin, the selection and
 * what the catalog would accept instead. The overlay validator runs too — it catches a task-side
 * problem this function has no view of — so a document that passes here is not yet a document the
 * host will accept, and {@link toOverlay} plus `validateOverlayAgainstCatalog` is the full gate.
 * @param groups - the group set.
 * @param catalog - the live inventory.
 * @returns every problem found, in violin order.
 */
export function violinProblems(groups: FleetGroupsFile, catalog: RouteCatalog): readonly string[] {
  const problems: string[] = []
  for (const violin of groups.violins) {
    if (violin.selections.length > 1 && !isComparisonViolinId(violin.id)) {
      const scalars = violin.tasks.filter((task) => !isComparisonViolinId(task))
      if (scalars.length > 0) {
        problems.push(
          `violin "${violin.id}" has ${String(violin.selections.length)} model selections and holds ${scalars.map((task) => `"${task}"`).join(', ')}, ` +
            `which may name only one model; only ${PANEL_ROLES.join(', ')} may list several. Keep one selection, or move those tasks to another violin.`,
        )
      }
    }
    for (const [index, entry] of violin.selections.entries()) {
      const at = `violin "${violin.id}" selection ${index + 1} (${entry.provider}/${entry.model})`
      const route = catalog.routes.find(
        (candidate) => candidate.provider === entry.provider && candidate.model === entry.model,
      )
      if (route === undefined) {
        const recorded = catalog.unavailable.find((candidate) => candidate.provider === entry.provider)
        problems.push(
          `${at} is not in the live catalog — ${recorded?.why ?? 'no adapter registered it and no credential was found for it'}. ` +
            'Pick a route from the catalog instead; never write a slug that was not read from the live catalog.',
        )
        continue
      }
      if (entry.reasoningEffort !== undefined && !route.efforts.includes(entry.reasoningEffort)) {
        problems.push(
          `${at} asks for reasoningEffort "${entry.reasoningEffort}" but the route advertises ` +
            `${route.efforts.length === 0 ? 'none' : route.efforts.join(', ')}`,
        )
      }
    }
  }
  return problems
}

/** The model names a violin declares in the overlay: `<id>`, or `<id>-1 … <id>-n` for several. */
export function violinModelNames(violin: Violin): readonly string[] {
  if (violin.selections.length <= 1) return [violin.id]
  return violin.selections.map((_entry, index) => `${violin.id}-${String(index + 1)}`)
}

/** One selection as an overlay model entry. */
function modelEntryOf(entry: ViolinSelection): OverlayModel {
  return {
    provider: entry.provider,
    model: entry.model,
    ...(entry.reasoningEffort === undefined ? {} : { reasoningEffort: entry.reasoningEffort }),
    ...(entry.description === undefined ? {} : { description: entry.description }),
  }
}

/**
 * Project the groups onto the overlay the spawn path reads.
 *
 * The rules, all of them:
 *
 * 1. a violin with no selection declares no model, and its tasks point at `inherit-parent` — the
 *    honest degradation, because a name with no assignment is a file the parser refuses;
 * 2. a violin with selections declares one model entry per selection, named by
 *    {@link violinModelNames};
 * 3. every task key in `taskKeys` gets an entry: the names of its violin, or `["general"]` when the
 *    task is in no violin (the fallback the human asked for), or `["inherit-parent"]` when no
 *    violin can serve it at all;
 * 4. a task key a violin holds that is not in `taskKeys` is still written — the parser must not
 *    silently drop a hand-written key;
 * 5. the order of `taskKeys` is the order of the file, so a diff is readable.
 *
 * @param groups - the group set.
 * @param taskKeys - every task key the build knows, in `ROLE_KEYS` order.
 * @returns the version 2 overlay.
 */
export function toOverlay(groups: FleetGroupsFile, taskKeys: readonly string[]): OverlayFileV2 {
  const models: Record<string, OverlayModel> = {}
  const owner = new Map<string, Violin>()
  for (const violin of groups.violins) {
    for (const task of violin.tasks) if (!owner.has(task)) owner.set(task, violin)
    for (const [index, entry] of violin.selections.entries()) {
      const name = violinModelNames(violin)[index]
      if (name !== undefined) models[name] = modelEntryOf(entry)
    }
  }

  // A comparison violin answers to its own key: the key names the task, and the violin's model list is
  // what that task runs — one child per name for a fan-out, one chosen name for a pool. So the key is
  // written from the violin, and no `tasks` entry ever points a comparison task at itself.
  for (const violin of groups.violins) {
    if (!isComparisonViolinId(violin.id)) continue
    if (violin.selections.length === 0) continue
    owner.set(violin.id, violin)
  }

  const general = groups.violins.find((violin) => violin.id === 'general')
  const fallback = general !== undefined && general.selections.length > 0 ? [general.id] : ['inherit-parent']

  const tasks: Record<string, readonly string[]> = {}
  const keys = [...taskKeys]
  for (const key of PANEL_ROLES) if (!keys.includes(key)) keys.push(key)
  for (const violin of groups.violins) {
    for (const task of violin.tasks) if (!keys.includes(task)) keys.push(task)
  }
  for (const key of keys) {
    const violin = owner.get(key)
    if (violin === undefined) {
      tasks[key] = [...fallback]
      continue
    }
    if (violin.selections.length === 0) {
      tasks[key] = ['inherit-parent']
      continue
    }
    tasks[key] = [...violinModelNames(violin)]
  }

  return { version: 2, models, tasks }
}

/**
 * Every task key in `taskKeys` that is in no violin **and has no violin of its own**.
 *
 * A comparison key is never listed: `arena-runners` is served by the violin named `arena-runners`,
 * so calling it unassigned would be the page telling a person to assign a task that is already
 * routed. "Unassigned" here means exactly "runs on `general` because nobody chose otherwise".
 * @param groups - the group set.
 * @param taskKeys - every task key the build knows.
 * @returns the unassigned keys, in `taskKeys` order.
 */
export function unassignedTasks(groups: FleetGroupsFile, taskKeys: readonly string[]): readonly string[] {
  const assigned = new Set<string>()
  for (const violin of groups.violins) {
    for (const task of violin.tasks) assigned.add(task)
    // The violin's own key is served by the violin, whether or not it lists any task.
    if (violin.selections.length > 0) assigned.add(violin.id)
  }
  return taskKeys.filter((key) => !assigned.has(key))
}

/** The violin holding a task, or `undefined`. */
export function violinOfTask(groups: FleetGroupsFile, task: string): Violin | undefined {
  return groups.violins.find((violin) => violin.tasks.includes(task))
}

/**
 * A violin id for a name a person typed: lowercased, spaces and punctuation to hyphens.
 *
 * The id is a model name in the overlay, so it must be stable and readable; `My Reviewer!` becomes
 * `my-reviewer`. An empty result falls back to `violin`, and {@link withViolin} makes it unique.
 * @param name - the typed name.
 * @returns the slug.
 */
export function slugifyViolinId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length === 0 ? 'violin' : slug
}

/**
 * Add a violin, with an id that is free.
 *
 * The id is the typed name slugged, then `-2`, `-3`, … until it collides with nothing. A typed
 * name that slugs onto a predefined id (`Fast`) or a comparison id (`arena-runners`) is numbered
 * rather than allowed to shadow it — a predefined violin cannot be replaced by a custom one, and
 * the page would otherwise show two violins with one key between them.
 * @param groups - the current group set.
 * @param name - the typed name.
 * @param selections - the selections to start from; empty is legal.
 * @returns the next group set and the new violin's id.
 */
export function withViolin(
  groups: FleetGroupsFile,
  name: string,
  selections: readonly ViolinSelection[] = [],
): { readonly groups: FleetGroupsFile; readonly id: string } {
  const taken = new Set(groups.violins.map((violin) => violin.id))
  const base = slugifyViolinId(name)
  let id = base
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}-${String(suffix)}`
  const violin: Violin = { id, name: name.trim().length === 0 ? id : name.trim(), origin: 'custom', selections, tasks: [] }
  return { groups: { version: 1, violins: [...groups.violins, violin] }, id }
}

/**
 * Replace one violin's selections. Predefined violins may be edited; none may be deleted.
 * @param groups - the current group set.
 * @param id - the violin to edit.
 * @param selections - the next selections.
 * @returns the next group set.
 */
export function withSelections(
  groups: FleetGroupsFile,
  id: string,
  selections: readonly ViolinSelection[],
): FleetGroupsFile {
  return {
    version: 1,
    violins: groups.violins.map((violin) => (violin.id === id ? { ...violin, selections } : violin)),
  }
}

/**
 * Move a task into a violin, taking it out of whichever violin held it.
 *
 * Removing a predefined violin is impossible ({@link withoutViolin} refuses), so the target of a
 * move always exists; this function does not invent one. A task key may be moved to the violin that
 * already holds it, which is a no-op.
 * @param groups - the current group set.
 * @param task - the task key.
 * @param id - the violin to move it to.
 * @returns the next group set.
 */
export function withTask(groups: FleetGroupsFile, task: string, id: string): FleetGroupsFile {
  return {
    version: 1,
    violins: groups.violins.map((violin) => {
      const without = violin.tasks.filter((entry) => entry !== task)
      return violin.id === id ? { ...violin, tasks: [...without, task] } : { ...violin, tasks: without }
    }),
  }
}

/**
 * Take a task out of every violin, so it is unassigned and runs on `general`.
 * @param groups - the current group set.
 * @param task - the task key.
 * @returns the next group set.
 */
export function withoutTask(groups: FleetGroupsFile, task: string): FleetGroupsFile {
  return {
    version: 1,
    violins: groups.violins.map((violin) =>
      violin.tasks.includes(task) ? { ...violin, tasks: violin.tasks.filter((entry) => entry !== task) } : violin,
    ),
  }
}

/**
 * Remove a custom violin, releasing its tasks to `general`.
 *
 * A predefined or comparison violin is returned unchanged: the page offers no way to delete one,
 * and a hand-edited file that lost `general` would have no fallback left to write. The caller sees
 * which of the two happened through the returned `removed` flag rather than having to compare.
 * @param groups - the current group set.
 * @param id - the violin to remove.
 * @returns the next group set, and whether anything was removed.
 */
export function withoutViolin(groups: FleetGroupsFile, id: string): { readonly groups: FleetGroupsFile; readonly removed: boolean } {
  const target = groups.violins.find((violin) => violin.id === id)
  if (target === undefined || target.origin !== 'custom') return { groups, removed: false }
  return { groups: { version: 1, violins: groups.violins.filter((violin) => violin.id !== id) }, removed: true }
}

/** Rename a violin's label. The id stays: the overlay's model names hang off it. */
export function withViolinName(groups: FleetGroupsFile, id: string, name: string): FleetGroupsFile {
  const trimmed = name.trim()
  if (trimmed.length === 0) return groups
  return {
    version: 1,
    violins: groups.violins.map((violin) => (violin.id === id ? { ...violin, name: trimmed } : violin)),
  }
}

/**
 * Read a group set back out of an overlay: the one-time import that keeps an existing setup.
 *
 * The mapping is the inverse of {@link toOverlay} for everything that survives it, and it is
 * deliberately generous, because the alternative to importing a name is losing it:
 *
 * 1. start from {@link defaultGroups}, so the predefined and comparison violins exist;
 * 2. every name the overlay declares (`models`) whose id matches a predefined or comparison violin
 *    **replaces** that violin's selections — the file a person wrote wins over the heuristic;
 * 3. every other declared name becomes a custom violin carrying its assignment;
 * 4. a task naming exactly one name joins that name's violin; a task naming several joins its own
 *    comparison violin (created when the file uses a key outside `PANEL_ROLES`, which the parser
 *    refuses anyway, so this is the hand-built-file case);
 * 5. `inherit-parent`, an unknown name, and a task with no entry stay unassigned.
 *
 * @param overlay - the parsed overlay, or `undefined` when there is no file.
 * @param options - the live catalog and the session's default route.
 * @returns the imported groups, plus the names that could not be placed.
 */
export function fromOverlay(
  overlay: OverlayFile | undefined,
  options: DefaultGroupsOptions,
): { readonly groups: FleetGroupsFile; readonly dropped: readonly string[] } {
  const base = defaultGroups(options)
  if (overlay === undefined || overlay.version !== 2) return { groups: base, dropped: [] }

  const declared = overlay.models
  const names = new Set<string>([...Object.keys(declared)])
  for (const list of Object.values(overlay.tasks)) for (const name of list) names.add(name)

  const assignmentOf = (name: string): ViolinSelection | undefined => {
    const entry = declared[name]
    if (entry === undefined) return undefined
    return {
      provider: entry.provider,
      model: entry.model,
      ...(entry.reasoningEffort === undefined ? {} : { reasoningEffort: entry.reasoningEffort }),
      ...(entry.description === undefined ? {} : { description: entry.description }),
    }
  }

  let violins: Violin[] = base.violins.map((violin) => {
    if (violin.id === 'inherit-parent') return violin
    const entry = assignmentOf(violin.id)
    return entry === undefined ? violin : { ...violin, selections: [entry] }
  })
  const dropped: string[] = []

  for (const name of names) {
    if (name === 'inherit-parent') continue
    const entry = assignmentOf(name)
    if (entry === undefined) {
      // A built-in name the file never declared: it resolves, but nothing was written for it, so
      // there is no assignment to import. Reported rather than invented.
      dropped.push(name)
      continue
    }
    if (violins.some((violin) => violin.id === name)) continue
    violins.push({ id: name, name, origin: 'custom', selections: [entry], tasks: [] })
  }

  const taskKeys = Object.keys(overlay.tasks)
  for (const key of taskKeys) {
    const list = overlay.tasks[key] ?? []
    const settled = list.filter((name) => name !== 'inherit-parent')
    if (settled.length === 0) continue
    if (settled.length === 1) {
      const only = settled[0]
      if (only === undefined) continue
      const target = violins.find((violin) => violin.id === only)
      if (target === undefined) continue
      violins = violins.map((violin) =>
        violin.id === target.id
          ? { ...violin, tasks: [...violin.tasks, key] }
          : { ...violin, tasks: violin.tasks.filter((task) => task !== key) },
      )
      continue
    }
    const selections = settled
      .map((name) => assignmentOf(name))
      .filter((entry): entry is ViolinSelection => entry !== undefined)
    const existing = violins.find((violin) => violin.id === key)
    if (existing !== undefined) {
      violins = violins.map((violin) =>
        violin.id === key ? { ...violin, selections, tasks: [key], origin: 'comparison' } : { ...violin, tasks: violin.tasks.filter((task) => task !== key) },
      )
      continue
    }
    violins = [
      ...violins.map((violin) => ({ ...violin, tasks: violin.tasks.filter((task) => task !== key) })),
      { id: key, name: key, origin: 'comparison', selections, tasks: [key] },
    ]
  }

  return { groups: { version: 1, violins: dedupeIds(violins) }, dropped }
}

/** Keep the first violin per id, so a hand-built overlay cannot produce two violins with one key. */
function dedupeIds(violins: readonly Violin[]): readonly Violin[] {
  const seen = new Set<string>()
  const out: Violin[] = []
  for (const violin of violins) {
    if (seen.has(violin.id)) continue
    seen.add(violin.id)
    out.push(violin)
  }
  return out
}

/**
 * Repair a group set into one this build can write: the predefined and comparison violins present,
 * no duplicate ids, no task in two violins.
 *
 * Used on load for a file that {@link parseFleetGroups} refused, so the page has something to show
 * and save rather than an empty screen. The repairs are the same ones the parser names in its
 * errors; this function performs them instead of reporting them.
 * @param groups - a group set, possibly incomplete.
 * @returns a complete group set.
 */
export function repairedGroups(groups: FleetGroupsFile): { readonly groups: FleetGroupsFile; readonly repairs: readonly string[] } {
  const repairs: string[] = []
  const seen = new Set<string>()
  const kept: Violin[] = []
  for (const violin of groups.violins) {
    if (seen.has(violin.id)) {
      repairs.push(`dropped a second violin with the id "${violin.id}"`)
      continue
    }
    seen.add(violin.id)
    kept.push(violin)
  }
  const taskOwner = new Set<string>()
  const dedupedTasks = kept.map((violin) => {
    const tasks = violin.tasks.filter((task) => {
      if (taskOwner.has(task)) {
        repairs.push(`unassigned "${task}" from "${violin.id}" because another violin already holds it`)
        return false
      }
      taskOwner.add(task)
      return true
    })
    return { ...violin, tasks }
  })
  const withPredefined: Violin[] = [...dedupedTasks]
  for (const id of [...PREDEFINED_VIOLIN_IDS, ...PANEL_ROLES]) {
    if (seen.has(id)) continue
    repairs.push(`added the missing violin "${id}"`)
    withPredefined.push({
      id,
      name: id,
      origin: isPredefinedViolinId(id) ? 'predefined' : 'comparison',
      selections: [],
      tasks: isComparisonViolinId(id) && !taskOwner.has(id) ? [id] : [],
    })
  }
  return { groups: { version: 1, violins: withPredefined }, repairs }
}
