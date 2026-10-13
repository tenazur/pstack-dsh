/**
 * The overlay file and the rules that turn it into a spawn target.
 *
 * ## The question this file answers
 *
 * *Which model does what.* The old question — one route per role — was the wrong one, and the
 * settings page built on it rendered a flat role table that never said what anything resolved to.
 * The file now has **two levels**:
 *
 * 1. **Models.** A friendly name maps to *one concrete assignment*: one provider, one model, one
 *    reasoning effort. `off` is a legitimate effort, not the absence of one. The name is what a
 *    person reads; `provider/model · effort` is the detail behind it.
 * 2. **Tasks.** A task key (`feature`, `arena-runners`, …) maps to the **named model(s)** it may
 *    run on. Tasks point at names and never at raw routes.
 *
 * ## Two file versions, and what v1 means
 *
 * `version: 2` is this shape ({@link OverlayFileV2}). `version: 1` — `{version, roles}` with
 * `{inherit: true}` / `{routes: [...]}` entries — keeps parsing, and is read as **every role
 * inherits the parent**. That is deliberate and not a silent reinterpretation: v1's keys are
 * *role* keys and its values are *routes*, while v2's keys are *task* keys and its values are
 * *model names*; the two are different things and folding one into the other would invent a
 * mapping nobody wrote. What v1 loses is stated plainly instead: {@link overlayVersionNote} is the
 * sentence the page and the report print, and it names the routes v1 carried and no longer
 * applies. A v2 file with an unknown `version` is refused by name.
 *
 * ## Two spellings, one vocabulary
 *
 * The frozen ported skills in `plugin/skills/**` spell their spawn call sites as prose values —
 * `generalPurpose` 9 times, `comment-sicko` once, `poteto-agent` twice — while the role keys here are kebab-case, and upstream's own overlay keys are space-separated prose (`judgment and prose`,
 * `arena cross-judge pool`, `swarm workers`). {@link normaliseRoleKey} reconciles them: keys are
 * normalised on the way in (parse) and on the way out (lookup), so a file written by hand in
 * either spelling works.
 *
 * `generalPurpose` is **not** folded into `poteto-agent`. A Phase 1 scratch artifact did that
 * (`scratch/p1-port-assess/probe/src/roles.ts:53`), and that folding is wrong:
 * `generalPurpose` is the generic delegate with no agent file, `poteto-agent` is the routing
 * target that reads `poteto-mode` in full. Collapsing them makes `poteto-agent.md`'s own warning
 * self-defeating. {@link canonicalRole} preserves the three spawn role values verbatim.
 *
 * ## What resolveRole does with a bad assignment
 *
 * Never throws, and never silently drops: an assignment whose route is not in the live catalog,
 * whose credential is missing, or that names an effort the adapter does not advertise comes back
 * as `inherit: true` with a `reason` starting {@link UNAVAILABLE_REASON_PREFIX}. The child runs on
 * the parent's route — which is the honest single-route default — but the menu can say
 * `unavailable (was: X)` because the reason still names what was asked for.
 */
import type { ResolvedRole, RoleRoute, RouteCatalog } from './catalog.ts'
import { findRoute, unavailableReason } from './catalog.ts'

/** The three spawn role values the frozen ported skills use verbatim. */
export const SPAWN_ROLE_VALUES = ['generalPurpose', 'poteto-agent', 'comment-sicko'] as const

/** Roles that take a route list and spawn one child per entry. */
export const PANEL_ROLES = [
  'arena-runners',
  'arena-cross-judge-pool',
  'architect-runners',
  'interrogate-reviewers',
] as const

/**
 * Every kebab-case role key, in the canonical documented order.
 *
 * These are the **task keys** of a version 2 file: the task container a named model is assigned
 * to. A key outside this list is accepted (the parser must not invent a role vocabulary) but is
 * reported by the page rather than being absorbed into a table built from this list.
 */
export const ROLE_KEYS = [
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
] as const

/**
 * Stable prefix on every {@link ResolvedRole.reason} that reports a route the caller asked for
 * and did not get. The menu keys on it to print `unavailable (was: X)` rather than "inherits
 * parent", so a dropped route can never read as a deliberate default.
 */
export const UNAVAILABLE_REASON_PREFIX = 'unavailable:'

/** One concrete assignment: provider, model, and the effort that is part of it. */
export interface OverlayModelRoute {
  readonly provider: string
  readonly model: string
  /** Omit only when the route advertises no efforts; otherwise one the route advertises. */
  readonly reasoningEffort?: string
}

/** One named model: its assignment plus the one line of prose the page shows next to the name. */
export interface OverlayModel {
  readonly provider: string
  readonly model: string
  /**
   * The effort that is part of this assignment. `off` is a value, not an omission: writing it
   * means "run with reasoning off", while omitting it means "let the adapter materialise its
   * default".
   */
  readonly reasoningEffort?: string
  /** One line of prose the page shows next to the name. */
  readonly description?: string
}

/**
 * The version 2 file: named models and the tasks that point at them.
 *
 * Every field is optional on disk. `models` may be absent entirely, in which case
 * {@link BUILT_IN_MODEL_NAMES} resolve against the live catalog; `tasks` may be absent, in which
 * case every task inherits the parent.
 */
export interface OverlayFileV2 {
  readonly version: 2
  /** Friendly name -> one concrete route. Effort is part of the assignment. */
  readonly models: Record<string, OverlayModel>
  /** Task container -> the named models it may run on. One name, or several for comparison. */
  readonly tasks: Record<string, readonly string[]>
}

/** The version 1 entry shapes, kept exactly as they were so an old file still parses. */
export type OverlayRoleEntry = { readonly inherit: true } | { readonly routes: readonly RoleRoute[] }

/** The version 1 file: role keys to either `inherit` or a route list. */
export interface OverlayFileV1 {
  readonly version: 1
  readonly roles: Record<string, OverlayRoleEntry>
}

/** Either file the parser accepts. */
export type OverlayFile = OverlayFileV1 | OverlayFileV2

/** The file this build writes. */
export type WritableOverlayFile = OverlayFileV2

/** Parse result. `error` is written to be shown to the person who hand-edited the file. */
export type ParseOverlayResult = { ok: true; value: OverlayFile } | { ok: false; error: string }

/**
 * The built-in names, in the order the page lists them.
 *
 * A hand-written file therefore needs no boilerplate: `{"version": 2}` alone makes all four
 * resolve against the live catalog. `main` is first because it is the one name a task points at
 * when it wants the default, and `inherit-parent` last because it is not a route at all.
 */
export const BUILT_IN_MODEL_NAMES = ['main', 'smart', 'fast', 'vision', 'inherit-parent'] as const

/** One built-in name. */
export type BuiltInModelName = (typeof BUILT_IN_MODEL_NAMES)[number]

/** True for a name that resolves with no `models` block: a built-in, or the inherit sentinel. */
export function isBuiltInModelName(name: string): name is BuiltInModelName {
  return (BUILT_IN_MODEL_NAMES as readonly string[]).includes(name)
}

/**
 * The conventional name for "this task's children run wherever the parent runs".
 *
 * Not a model, and never a member of `models`: it is the sentinel a task points at to state the
 * one-route default explicitly. Present in {@link BUILT_IN_MODEL_NAMES} so a task naming it is
 * not an unknown name.
 */
export const INHERIT_PARENT_MODEL = 'inherit-parent'

/**
 * The built-in assignments, from the adapter's own catalogue of what each model suits
 * (`dsh-llm-deepseek/lib/index.js:1843-1869`). The route ids are the adapter's; the prose is
 * paraphrased from the `description` it ships for that model.
 *
 * `main` is `deepseek-flash` with `off` because the adapter ships it as the default route and the
 * route's parent session runs it that way; the other three carry the effort that makes them the
 * "smart"/"fast" name they claim to be. Only a catalog that actually advertises `off` can honour
 * `main` — a catalog that does not makes `main` resolve to `inherit` with an `unavailable:` reason
 * rather than quietly dropping the effort.
 */
const BUILT_IN_ASSIGNMENTS: Record<Exclude<BuiltInModelName, typeof INHERIT_PARENT_MODEL>, OverlayModel> = {
  main: {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'off',
    description: 'the default; most tasks',
  },
  smart: {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'max',
    description: 'planning and hard reasoning',
  },
  fast: {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'low',
    description: 'cheap parallel work',
  },
  vision: {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash-vision-exp',
    description: 'the only route advertising image input',
  },
}

/**
 * The assignment a built-in name means, or `undefined` for `inherit-parent` (which is not a
 * route) and for anything that is not a built-in at all.
 * @param name - the friendly name as written.
 * @returns the assignment, or `undefined`.
 */
export function builtInModel(name: string): OverlayModel | undefined {
  const trimmed = name.trim()
  if (!isBuiltInModelName(trimmed) || trimmed === INHERIT_PARENT_MODEL) return undefined
  const assignment = BUILT_IN_ASSIGNMENTS[trimmed]
  return assignment === undefined ? undefined : { ...assignment }
}

/**
 * Normalise a role key: trim, collapse whitespace, lowercase, spaces -> hyphens.
 *
 * `judgment and prose` → `judgment-and-prose`, `  Arena  Cross-Judge Pool ` →
 * `arena-cross-judge-pool`, and an already-kebab key passes through unchanged.
 * @param raw - the key as written, in either spelling.
 * @returns the canonical key.
 */
export function normaliseRoleKey(raw: string): string {
  return raw.trim().replace(/\s+/g, '-').toLowerCase()
}

/**
 * The role name to report back: one of the three spawn role values verbatim when the input means
 * one of them (in either spelling), otherwise the normalised kebab-case key.
 * `generalPurpose` → `generalPurpose` (never `poteto-agent`); `judgment and prose` →
 * `judgment-and-prose`.
 * @param raw - the role as the caller spelled it.
 * @returns the value for {@link ResolvedRole.role}.
 */
export function canonicalRole(raw: string): string {
  const key = normaliseRoleKey(raw)
  for (const value of SPAWN_ROLE_VALUES) {
    if (normaliseRoleKey(value) === key) return value
  }
  return key
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

/** The wording used wherever a route has to be written down exactly: `provider/model`. */
export function routeLabel(provider: string, model: string): string {
  return `${provider}/${model}`
}

/**
 * Whether the live catalog can honour one assignment, and why not when it cannot.
 *
 * The single decision {@link resolveRole} and the write-time validator both read, so the
 * read-time `unavailable (was: X)` and the write-time rejection cannot drift apart.
 */
export type RouteHonour =
  | {
      readonly ok: true
      readonly route: RoleRoute
      readonly provider: string
      readonly model: string
      readonly efforts: readonly string[]
      readonly defaultEffort?: string
    }
  | {
      readonly ok: false
      /** The sentence naming the offender and what the catalog would accept instead. */
      readonly why: string
      /** Which of the two rejections this was, so a caller can word it differently. */
      readonly kind: 'not-in-catalog' | 'unadvertised-effort'
      /** The route as written, always present so a caller can name it. */
      readonly provider: string
      readonly model: string
      /** What the route does advertise; empty for `not-in-catalog` and for a route with no efforts. */
      readonly advertised: readonly string[]
      /** The effort as written, for `unadvertised-effort`. */
      readonly effort?: string
    }

/**
 * Judge one assignment against the live catalog.
 *
 * Two rejections, each naming the offender:
 *
 * - the route is not in the catalog — with the catalog's own recorded reason attached when it has
 *   one (`no adapter registered it` vs `its credential is not configured` are different facts);
 * - the route advertises reasons of its own and does not include the asked-for effort. `off` is
 *   checked exactly like any other id, so a route that advertises it accepts it and a route that
 *   does not refuses it.
 *
 * @param catalog - the live inventory from `enumerateRoutes`.
 * @param wanted - the assignment as written.
 * @returns whether it can be honoured, and the reason when it cannot.
 */
export function describeRoute(catalog: RouteCatalog, wanted: OverlayModelRoute): RouteHonour {
  const usable = findRoute(catalog, wanted.provider, wanted.model)
  if (usable === undefined) {
    const recorded = unavailableReason(catalog, wanted.provider, wanted.model)
    return {
      ok: false,
      kind: 'not-in-catalog',
      provider: wanted.provider,
      model: wanted.model,
      advertised: [],
      why:
        `${routeLabel(wanted.provider, wanted.model)} is not in the live catalog — ` +
        (recorded ??
          'no adapter registered it and no credential was found for it; never write a slug that was not read from the live catalog'),
    }
  }
  if (wanted.reasoningEffort !== undefined && !usable.efforts.includes(wanted.reasoningEffort)) {
    return {
      ok: false,
      kind: 'unadvertised-effort',
      provider: usable.provider,
      model: usable.model,
      advertised: usable.efforts,
      effort: wanted.reasoningEffort,
      why:
        `${routeLabel(usable.provider, usable.model)} does not advertise reasoningEffort ` +
        `"${wanted.reasoningEffort}" (advertises: ${usable.efforts.length === 0 ? 'none' : usable.efforts.join(', ')})`,
    }
  }
  return {
    ok: true,
    route: {
      provider: usable.provider,
      model: usable.model,
      ...(wanted.reasoningEffort === undefined ? {} : { reasoningEffort: wanted.reasoningEffort }),
    },
    provider: usable.provider,
    model: usable.model,
    efforts: usable.efforts,
    ...(usable.defaultEffort === undefined ? {} : { defaultEffort: usable.defaultEffort }),
  }
}

/**
 * The one-line note a version 1 file earns, naming what it loses.
 *
 * v1's `roles` values were routes. This build reads a v1 file as "everything inherits", which is
 * the honest single-route behaviour — but it does mean a route a person set is no longer applied,
 * and pretending otherwise is the failure mode this program keeps finding. `undefined` for a v2
 * file, which has nothing to warn about.
 * @param overlay - the parsed file, or `undefined` when there is none.
 * @returns the sentence to print, or `undefined`.
 */
export function overlayVersionNote(overlay: OverlayFile | undefined): string | undefined {
  if (overlay === undefined || overlay.version !== 1) return undefined
  const keys = Object.keys(overlay.roles)
  const mapped = keys.filter((key) => {
    const entry = overlay.roles[key]
    return entry !== undefined && 'routes' in entry && entry.routes.length > 0
  })
  const lost =
    mapped.length === 0
      ? 'it carries no routes, so nothing was set and nothing is lost'
      : `it carries routes for ${mapped.map((key) => `"${key}"`).join(', ')}, and those routes are NOT applied`
  return (
    `this is a version 1 overlay: v1 keys are role keys and its values are routes, which version 2 ` +
    `cannot read as named models, so everything inherits the parent. ${lost}. ` +
    'Write a version 2 file — named models under "models", tasks pointing at those names — to assign a route.'
  )
}

/**
 * Validate one assignment object, for either file version.
 * @param where - what to call this object in an error message.
 * @param raw - the value as written.
 * @param extraKeys - keys this context allows on top of `provider`/`model`/`reasoningEffort`
 *   (a named model also allows `description`; a version 1 route does not).
 */
function parseRoute(
  where: string,
  raw: unknown,
  extraKeys: readonly string[] = [],
): { ok: true; value: OverlayModelRoute } | { ok: false; error: string } {
  if (!isRecord(raw)) {
    return { ok: false, error: `${where} must be an object like {"provider": "...", "model": "..."}, got ${show(raw)}` }
  }

  const allowed = ['provider', 'model', 'reasoningEffort', ...extraKeys]
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

  if (raw['reasoningEffort'] === undefined) return { ok: true, value: { provider, model } }
  const effort = readText(raw['reasoningEffort'])
  if (effort === undefined) {
    return {
      ok: false,
      error: `${where} has a malformed "reasoningEffort" (${show(raw['reasoningEffort'])}); expected a non-empty effort id such as "high"`,
    }
  }
  return { ok: true, value: { provider, model, reasoningEffort: effort } }
}

/** Validate one version 1 route entry against the version-1 shape. */
function parseV1Route(
  roleKey: string,
  index: number,
  raw: unknown,
): { ok: true; value: RoleRoute } | { ok: false; error: string } {
  const where = `overlay role "${roleKey}" route ${index + 1}`
  const parsed = parseRoute(where, raw)
  return parsed.ok ? { ok: true, value: parsed.value } : parsed
}

/** Validate one version 1 role entry: `{inherit: true}`, `{routes: [...]}`, or why it is neither. */
function parseV1Entry(roleKey: string, raw: unknown): { ok: true; value: OverlayRoleEntry } | { ok: false; error: string } {
  const where = `overlay role "${roleKey}"`
  if (!isRecord(raw)) {
    return {
      ok: false,
      error: `${where} must be {"inherit": true} or {"routes": [...]}, got ${show(raw)}`,
    }
  }

  const hasInherit = Object.hasOwn(raw, 'inherit')
  const hasRoutes = Object.hasOwn(raw, 'routes')
  if (hasInherit && hasRoutes) {
    return { ok: false, error: `${where} has both "inherit" and "routes"; use exactly one` }
  }
  if (!hasInherit && !hasRoutes) {
    return {
      ok: false,
      error: `${where} must be {"inherit": true} or {"routes": [...]}, got ${show(raw)}`,
    }
  }

  if (hasInherit) {
    if (raw['inherit'] !== true) {
      return { ok: false, error: `${where} "inherit" must be true (got ${show(raw['inherit'])}); omit the role instead to inherit` }
    }
    for (const key of Object.keys(raw)) {
      if (key !== 'inherit') return { ok: false, error: `${where} has unknown key ${show(key)} next to "inherit"` }
    }
    return { ok: true, value: { inherit: true } }
  }

  const rawRoutes = raw['routes']
  if (!Array.isArray(rawRoutes)) {
    return { ok: false, error: `${where} "routes" must be an array of {provider, model} objects, got ${show(rawRoutes)}` }
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'routes') return { ok: false, error: `${where} has unknown key ${show(key)} next to "routes"` }
  }

  const routes: RoleRoute[] = []
  for (const [index, rawRoute] of rawRoutes.entries()) {
    const route = parseV1Route(roleKey, index, rawRoute)
    if (!route.ok) return route
    routes.push(route.value)
  }
  // An empty list is legal and means inherit.
  return { ok: true, value: { routes } }
}

/** Validate one version 2 named-model entry. */
function parseNamedModel(
  name: string,
  raw: unknown,
): { ok: true; value: OverlayModel } | { ok: false; error: string } {
  const where = `overlay model "${name}"`
  if (!isRecord(raw)) {
    return { ok: false, error: `${where} must be an object like {"provider": "...", "model": "..."}, got ${show(raw)}` }
  }

  for (const key of Object.keys(raw)) {
    if (key !== 'provider' && key !== 'model' && key !== 'reasoningEffort' && key !== 'description') {
      return {
        ok: false,
        error: `${where} has unknown key ${show(key)}; allows provider, model, reasoningEffort, description`,
      }
    }
  }

  const assignment = parseRoute(where, raw, ['description'])
  if (!assignment.ok) return assignment

  if (raw['description'] === undefined) return { ok: true, value: assignment.value }
  const description = readText(raw['description'])
  if (description === undefined) {
    return {
      ok: false,
      error: `${where} has a malformed "description" (${show(raw['description'])}); expected a non-empty line of prose, or omit it`,
    }
  }
  return { ok: true, value: { ...assignment.value, description } }
}

/**
 * Parse a version 2 file.
 *
 * Every rejection names the offender: a duplicate name, a model that is not an object, and — the
 * one this unit exists for — a task pointing at a name that is neither built-in nor declared.
 * That last case can never fall back to "inherit", because a task silently inheriting a route
 * nobody assigned is exactly the failure mode the whole program keeps finding.
 */
function parseV2(raw: Record<string, unknown>): ParseOverlayResult {
  const rawModels = raw['models'] === undefined ? {} : raw['models']
  if (!isRecord(rawModels)) {
    return { ok: false, error: `overlay "models" must be an object mapping names to {provider, model}, got ${show(rawModels)}` }
  }

  const models: Record<string, OverlayModel> = {}
  for (const [rawName, rawEntry] of Object.entries(rawModels)) {
    const name = rawName.trim()
    if (name.length === 0) {
      return { ok: false, error: `overlay has a model name that is empty after trimming: ${show(rawName)}` }
    }
    if (Object.hasOwn(models, name)) {
      return { ok: false, error: `overlay names the model "${name}" twice; keep one` }
    }
    const entry = parseNamedModel(name, rawEntry)
    if (!entry.ok) return entry
    models[name] = entry.value
  }

  const declared = new Set(Object.keys(models))
  const unknown = (name: string): boolean => !declared.has(name) && !isBuiltInModelName(name)

  const rawTasks = raw['tasks'] === undefined ? {} : raw['tasks']
  if (!isRecord(rawTasks)) {
    return { ok: false, error: `overlay "tasks" must be an object mapping task keys to model names, got ${show(rawTasks)}` }
  }

  const tasks: Record<string, readonly string[]> = {}
  const spellings = new Map<string, string>()
  for (const [rawKey, rawNames] of Object.entries(rawTasks)) {
    const key = normaliseRoleKey(rawKey)
    if (key.length === 0) {
      return { ok: false, error: `overlay has a task key that is empty after normalisation: ${show(rawKey)}` }
    }
    const previous = spellings.get(key)
    if (previous !== undefined) {
      return { ok: false, error: `overlay keys ${show(previous)} and ${show(rawKey)} are the same task "${key}"; keep one` }
    }
    if (!Array.isArray(rawNames)) {
      return {
        ok: false,
        error: `overlay task "${key}" must be an array of model names such as ["main"], got ${show(rawNames)}`,
      }
    }
    if (rawNames.length > 1 && !isPanelRole(key)) {
      return {
        ok: false,
        error:
          `overlay task "${key}" lists ${String(rawNames.length)} model names but "${key}" is not a panel role; ` +
          `only ${PANEL_ROLES.join(', ')} may list more than one name. Keep one name, or move the comparison to a panel task.`,
      }
    }

    const names: string[] = []
    for (const rawName of rawNames) {
      const name = readText(rawName)
      if (name === undefined) {
        return { ok: false, error: `overlay task "${key}" has a malformed model name (${show(rawName)}); expected a non-empty string` }
      }
      if (unknown(name)) {
        const known = [...BUILT_IN_MODEL_NAMES, ...declared].join(', ')
        return {
          ok: false,
          error:
            `overlay task "${key}" names the model "${name}", which is neither built-in nor declared under "models" ` +
            `(built-in: ${BUILT_IN_MODEL_NAMES.join(', ')}; declared: ${declared.size === 0 ? 'none' : [...declared].join(', ')}; known: ${known}). ` +
            'Add it under "models" or use a known name; a task never silently inherits.',
        }
      }
      names.push(name)
    }
    tasks[key] = names
    spellings.set(key, rawKey)
  }

  return { ok: true, value: { version: 2, models, tasks } }
}

/**
 * Parse an overlay file. Never throws; every rejection carries a message written for the person
 * who edited the file.
 *
 * `version: 2` is the shape this build writes. `version: 1` still parses, and
 * {@link overlayVersionNote} says what reading it as "everything inherits" costs.
 * Task keys are normalised, so `judgment and prose` and `judgment-and-prose` land on the same key —
 * and two spellings of one task in one file is an error, not a silent last-one-wins.
 * @param text - the file's contents.
 * @returns the parsed file, or the reason it was rejected.
 */
export function parseOverlay(text: string): ParseOverlayResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `overlay is not valid JSON: ${message}` }
  }

  if (!isRecord(raw)) {
    return { ok: false, error: `overlay must be a JSON object with "version" and either "models"/"tasks" or "roles", got ${show(raw)}` }
  }
  if (raw['version'] === 2) {
    for (const key of Object.keys(raw)) {
      if (key !== 'version' && key !== 'models' && key !== 'tasks') {
        return {
          ok: false,
          error: `overlay version 2 has unknown top-level key ${show(key)}; allows version, models, tasks`,
        }
      }
    }
    return parseV2(raw)
  }
  if (raw['version'] !== 1) {
    return { ok: false, error: `overlay version must be 1 or 2, got ${show(raw['version'])}` }
  }

  const rawRoles = raw['roles'] === undefined ? {} : raw['roles']
  if (!isRecord(rawRoles)) {
    return { ok: false, error: `overlay "roles" must be an object mapping role keys to entries, got ${show(rawRoles)}` }
  }

  const roles: Record<string, OverlayRoleEntry> = {}
  const spellings = new Map<string, string>()
  for (const [rawKey, rawEntry] of Object.entries(rawRoles)) {
    const key = normaliseRoleKey(rawKey)
    if (key.length === 0) {
      return { ok: false, error: `overlay has a role key that is empty after normalisation: ${show(rawKey)}` }
    }
    const previous = spellings.get(key)
    if (previous !== undefined) {
      return {
        ok: false,
        error: `overlay keys ${show(previous)} and ${show(rawKey)} are the same role "${key}"; keep one`,
      }
    }
    const entry = parseV1Entry(key, rawEntry)
    if (!entry.ok) return entry
    roles[key] = entry.value
    spellings.set(key, rawKey)
  }

  return { ok: true, value: { version: 1, roles } }
}

/**
 * Write an overlay file. `parseOverlay(serializeOverlay(value))` returns an equal value, and the
 * 2-space indent plus trailing newline is what makes the file hand-editable.
 * @param value - the file to write.
 * @returns the file's text.
 */
export function serializeOverlay(value: OverlayFile): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** Look a role/task key up in a v1 overlay, normalising hand-built keys too (not just parsed ones). */
function findV1Entry(overlay: OverlayFileV1, key: string): OverlayRoleEntry | undefined {
  const direct = overlay.roles[key]
  if (direct !== undefined) return direct
  for (const [rawKey, entry] of Object.entries(overlay.roles)) {
    if (normaliseRoleKey(rawKey) === key) return entry
  }
  return undefined
}

/** Look a task key up in a v2 overlay, normalising hand-built keys too. */
function findTask(overlay: OverlayFileV2, key: string): readonly string[] | undefined {
  const direct = overlay.tasks[key]
  if (direct !== undefined) return direct
  for (const [rawKey, names] of Object.entries(overlay.tasks)) {
    if (normaliseRoleKey(rawKey) === key) return names
  }
  return undefined
}

/** True when the key names a panel role: the tasks that may list more than one name. */
export function isPanelRole(key: string): boolean {
  return (PANEL_ROLES as readonly string[]).includes(key)
}

/**
 * The assignment one named model means, declared entries first and built-ins second.
 *
 * A declared entry **overrides** a built-in of the same name; a built-in is used when the file
 * says nothing. `inherit-parent` is never a route, so it answers `undefined` here — callers check
 * {@link INHERIT_PARENT_MODEL} before asking.
 * @param name - the friendly name as a task wrote it.
 * @param overlay - the parsed overlay, when there is one.
 * @returns the assignment, or `undefined` when the name is neither declared nor built-in.
 */
export function namedModelAssignment(name: string, overlay: OverlayFile | undefined): OverlayModel | undefined {
  const key = name.trim()
  if (overlay !== undefined && overlay.version === 2 && Object.hasOwn(overlay.models, key)) {
    return overlay.models[key]
  }
  return builtInModel(key)
}

/** An inherit result with its reason. */
function inherit(role: string, reason: string): ResolvedRole {
  return { role, inherit: true, reason }
}

/** The effort half of a reason string: `effort off`, or what the adapter will do instead. */
function effortNote(wanted: OverlayModelRoute, catalog: RouteCatalog): string {
  if (wanted.reasoningEffort !== undefined) return `effort ${wanted.reasoningEffort}`
  const route = findRoute(catalog, wanted.provider, wanted.model)
  return route?.defaultEffort === undefined
    ? 'no effort set'
    : `no effort set, adapter default ${route.defaultEffort}`
}

/**
 * Resolve one named model to a route, or explain why it cannot be one.
 *
 * Never returns a route the live catalog did not enumerate, and never passes an effort the route
 * does not advertise: both come back as `inherit` with an {@link UNAVAILABLE_REASON_PREFIX} reason
 * that still names what was asked for.
 * @param role - the role name to report on the resolution.
 * @param name - the friendly model name from the task.
 * @param assignment - the assignment that name means.
 * @param catalog - the live route inventory.
 * @param where - the task-side context for the reason, e.g. `task "feature"`.
 * @returns the resolution.
 */
function resolveNamedModel(
  role: string,
  name: string,
  assignment: OverlayModel,
  catalog: RouteCatalog,
  where: string,
): { readonly ok: true; readonly resolution: ResolvedRole; readonly label: string } | { readonly ok: false; readonly reason: string } {
  const honoured = describeRoute(catalog, assignment)
  if (!honoured.ok) {
    return { ok: false, reason: `${where} names the model "${name}", whose route ${honoured.why}; inherits the parent's route` }
  }
  const wanted: OverlayModelRoute = {
    provider: assignment.provider,
    model: assignment.model,
    ...(assignment.reasoningEffort === undefined ? {} : { reasoningEffort: assignment.reasoningEffort }),
  }
  return {
    ok: true,
    label: routeLabel(honoured.provider, honoured.model),
    resolution: {
      role,
      inherit: false,
      route: honoured.route,
      reason: `${where} names the model "${name}" — ${routeLabel(honoured.provider, honoured.model)} (${effortNote(wanted, catalog)})`,
    },
  }
}

/**
 * Resolve one task to the route its child should run on.
 *
 * The rules the overlay is held to, plus the version 2 shape:
 *
 * 1. no overlay entry → inherit the parent;
 * 2. `version: 1` → inherit the parent for every key (see {@link overlayVersionNote});
 * 3. a task with no `tasks` entry, `inherit: true`'s v2 equivalent (an empty list), or the name
 *    `inherit-parent` → inherit the parent;
 * 4. a scalar task → its single named model's full route, effort included, `routeIndex` absent;
 * 5. a panel task → the named model at `entryIndex`, `routeIndex` set, one distinct index per name;
 * 6. an assignment the catalog cannot honour → `inherit: true` and a reason prefixed
 *    {@link UNAVAILABLE_REASON_PREFIX}, never a route that was not read from the live catalog;
 * 7. an effort the route does not advertise — **including `off`** — the same treatment.
 *
 * The route's own `defaultEffort` is **not** copied into the resolved route when the assignment
 * omits an effort: an omitted effort means the adapter materialises its default
 * (`dsh-llm/lib/types/types.d.ts:321-328`), and this module does not invent values. The reason
 * names the default so the menu can show it.
 *
 * @param role - the role as the caller spelled it, kebab-case or a spawn role value.
 * @param overlay - the parsed overlay, or `undefined` when there is no file.
 * @param catalog - the live route inventory from `enumerateRoutes`.
 * @param entryIndex - which name of a panel task to resolve. Ignored for scalar tasks; a panel's
 *   spawn loop passes 0, 1, 2, ... so each child gets a distinct `routeIndex`.
 * @returns the resolved target, and the reason it resolved that way.
 */
export function resolveRole(
  role: string,
  overlay: OverlayFile | undefined,
  catalog: RouteCatalog,
  entryIndex = 0,
): ResolvedRole {
  const key = normaliseRoleKey(role)
  const name = canonicalRole(role)
  if (key.length === 0) return inherit(name, 'role name is empty; inherits the parent\'s route')
  if (overlay === undefined) return inherit(name, `no overlay entry for "${key}"; inherits the parent's route`)
  if (overlay.version === 1) {
    return inherit(name, `overlay is version 1; every task inherits the parent's route`)
  }

  const names = findTask(overlay, key)
  if (names === undefined) return inherit(name, `no overlay entry for "${key}"; inherits the parent's route`)
  if (names.length === 0) {
    return inherit(name, `overlay entry for "${key}" lists no models; inherits the parent's route`)
  }

  const panel = isPanelRole(key)
  if (panel && (entryIndex < 0 || entryIndex >= names.length)) {
    return inherit(
      name,
      `panel entry index ${entryIndex} is out of range for "${key}" (${names.length} model name(s)); inherits the parent's route`,
    )
  }
  const index = panel ? entryIndex : 0
  const modelName = names[index]
  if (modelName === undefined) return inherit(name, `overlay entry for "${key}" has no model name at index ${index}`)
  if (modelName === INHERIT_PARENT_MODEL) {
    return inherit(name, `overlay entry for "${key}" names "${INHERIT_PARENT_MODEL}"; inherits the parent's route`)
  }

  const assignment = namedModelAssignment(modelName, overlay)
  if (assignment === undefined) {
    // Unreachable through `parseOverlay`, which refuses an unknown name and names the task. Kept
    // because a hand-built overlay can reach here, and a resolver that throws is worse than one
    // that explains itself.
    return inherit(
      name,
      `${UNAVAILABLE_REASON_PREFIX} "${key}" names the model "${modelName}", which is neither built-in nor declared; inherits the parent's route`,
    )
  }

  const resolved = resolveNamedModel(name, modelName, assignment, catalog, `overlay entry for "${key}"`)
  if (!resolved.ok) return inherit(name, `${UNAVAILABLE_REASON_PREFIX} ${resolved.reason}`)

  if (!panel) {
    const ignored = names.length - 1
    const tail = ignored === 0 ? 'the only model listed' : `${ignored} further model name(s) ignored: "${key}" is not a panel role`
    return { ...resolved.resolution, reason: `${resolved.resolution.reason}; ${tail}` }
  }

  return { ...resolved.resolution, routeIndex: index }
}

/**
 * Resolve every entry of a panel task, one child per named model. A task
 * that inherits returns a single entry, because "spawn N children all inheriting" is a fan-out
 * decision the caller makes, not a route list.
 * @param role - the role as the caller spelled it.
 * @param overlay - the parsed overlay, or `undefined`.
 * @param catalog - the live route inventory.
 * @returns one resolution per name, each with its own `routeIndex`.
 */
export function resolvePanel(
  role: string,
  overlay: OverlayFile | undefined,
  catalog: RouteCatalog,
): readonly ResolvedRole[] {
  const key = normaliseRoleKey(role)
  if (!isPanelRole(key) || overlay === undefined || overlay.version !== 2) {
    return [resolveRole(role, overlay, catalog)]
  }
  const names = findTask(overlay, key)
  if (names === undefined || names.length === 0) return [resolveRole(role, overlay, catalog)]
  return names.map((_name, index) => resolveRole(role, overlay, catalog, index))
}
