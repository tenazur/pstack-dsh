/**
 * `pstack_spawn_panel` — the Phase 5 fan-out tool: **one child per route entry**.
 *
 * `pstack_spawn` is deliberately left alone. Its single-child contract is frozen and
 * live-verified (`scratch/p4-spawn/live2.log`), so the widening is a *second tool* with its own
 * schema and its own tests rather than a `width` argument on the first one. A caller that wants
 * one child keeps the contract it already had; a caller that wants a panel says so by name.
 *
 * ## How the fan-out reuses `pstack_spawn` instead of copying it
 *
 * The per-child work is done by the **real** single-child tool:
 * {@link createPstackSpawnTool} is called with a resolver that answers from this call's own
 * resolution list, and each child is started through that tool's `execute`. So argument
 * validation, {@link buildSpawnRequest} (the request builder the brief requires be reused),
 * `agentOptions` construction, `ctx.subagents.start`, run settling, disposal and the assignment
 * sink are all the *same code object* as `pstack_spawn` — not a re-implementation. The one thing
 * this module owns is which resolution each child gets.
 *
 * That is also why `src/tools/spawn.ts` needed **no change**. Its private `startChild`/`settleRun`
 * are not exported, but they do not have to be: the exported factory is the seam.
 *
 * ## Same-route panels are reported, not implied
 *
 * An inheriting panel role spawns N children **all inheriting** — "same
 * route, separate reads… a weaker panel", and the arena skill's own rule is *"Say so rather than
 * implying parity."* So the canonical value carries {@link PanelOutcome.allInherited},
 * {@link PanelOutcome.distinctRoutes} and a {@link PanelOutcome.note}, and the weaker cases get a
 * sentence that cannot be read as family diversity. The same machinery covers the one-route
 * install where a route list names the *same* route twice: `distinctRoutes` is 1 and the note says
 * so.
 *
 * ## Concurrency: sequential, and that is a decision
 *
 * Children start **one at a time**, and child `i+1` is not started until child `i` has settled.
 *
 * - **Attribution is the contract.** "Never let a fan-out failure hide a child" is only meaningful
 *   if a failure can be *localised*. With one child in flight, a start failure or a rejected run
 *   belongs unambiguously to that index; a concurrent start would have to reason about which of
 *   several in-flight starts a provider error came from.
 * - **One route means shared limits.** This install has one route
 *   on most installs). Concurrent children contend for the same
 *   adapter and the same credential, so a rate limit or a transient provider error can fail the
 *   whole panel at once — turning a partial failure into a total one and destroying exactly the
 *   signal a panel exists to produce.
 * - **Width is tiny.** A panel is 2–4 children. The cost of sequential is wall-clock
 *   (sum of the children's latencies, not the maximum); the cost of concurrent is a result whose
 *   failures are harder to attribute and easier to correlate.
 *
 * Aborting the run context propagates (`throwIfAborted`) instead of returning a partial panel: a
 * cancelled fan-out must not read as a completed one with fewer children. A child that *fails* is
 * a different thing, and every failed child still appears in
 * {@link PanelOutcome.children} with its index and its route.
 */
import { PANEL_ROLES, canonicalRole, isPanelRole, normaliseRoleKey, resolvePanel } from '../roles/overlay.ts'
import type { OverlayFile } from '../roles/overlay.ts'
import type { RouteCatalog } from '../roles/catalog.ts'
import { createPstackSpawnTool, parseSpawnArgs, PSTACK_SPAWN_TOOL, SpawnArgsError } from './spawn.ts'
import type { ResolvedRoleLike, RoleAssignmentSink, SpawnArgs, SpawnOutcome, SubagentServiceLike } from './spawn.ts'
import type { ToolDefinitionLike, ToolRunContext } from './status.ts'

/** Model-facing tool name. Snake_case, like `pstack_spawn` and `pstack_status`. */
export const PSTACK_SPAWN_PANEL_TOOL = 'pstack_spawn_panel'

/**
 * How many children an **inheriting** panel role spawns when the caller does not say.
 *
 * Not 1: a caller who reaches for the panel tool has already asked for a panel, and width 1 is
 * what `pstack_spawn` is for. Not more than 2 by default: same-route
 * fan-out is something the human opts into, and this default is
 * the smallest widening that can produce any independent-read signal at all.
 */
export const DEFAULT_INHERIT_WIDTH = 2

/**
 * Hard ceiling on {@link PSTACK_SPAWN_PANEL_PARAMETERS}'s `count`.
 *
 * The unit's own rule is "never spawn more than 4 children" per call in this one-route install,
 * and every child is a real model call. A caller that wants a wider panel must widen the overlay's
 * route list, which is a deliberate act on a file a human edits.
 */
export const MAX_PANEL_WIDTH = 4

/**
 * Resolve a role to its panel entries, one per route. The panel counterpart of
 * `RoleResolverLike`, injected so this tool is testable with no Host.
 *
 * The production implementation is {@link createPanelResolver}, which calls the frozen
 * `resolvePanel` from `src/roles/overlay.ts`. A role with no entry, `inherit: true`, an empty
 * route list, or a route list that resolves to nothing usable comes back as a **single**
 * inheriting entry — which is the case the tool expands to `count` children.
 */
export interface PanelResolverLike {
  resolvePanel(role: string): readonly ResolvedRoleLike[] | Promise<readonly ResolvedRoleLike[]>
}

/** What {@link createPanelResolver} needs: the live catalog, and a fresh overlay read per resolve. */
interface PanelResolverSources {
  /** The live route inventory (`RoleResolver.catalog`). */
  readonly catalog: () => Promise<RouteCatalog>
  /**
   * Read the overlay for one resolve. Called per panel resolve, not cached: it is a file a person
   * hand-edits (`src/roles/resolver.ts:9-14`).
   */
  readonly readOverlay: () => Promise<OverlayFile | undefined>
}

/**
 * Build the production panel resolver over `resolvePanel`.
 *
 * `resolvePanel` already enumerates one entry per route with its own `routeIndex`, so the tool
 * never indexes the route list itself and cannot disagree with the resolver about which route is
 * entry `i`.
 * @param sources - the catalog reader and the overlay reader.
 * @returns a resolver for {@link createPstackSpawnPanelTool}.
 */
export function createPanelResolver(sources: PanelResolverSources): PanelResolverLike {
  return {
    async resolvePanel(role: string): Promise<readonly ResolvedRoleLike[]> {
      const [catalog, overlay] = await Promise.all([sources.catalog(), sources.readOverlay()])
      return resolvePanel(role, overlay, catalog)
    },
  }
}

/** Validated arguments, in the spelling the tool body uses. */
interface PanelArgs {
  readonly role: string
  readonly prompt: string
  readonly description?: string
  /**
   * Children to spawn when the role resolves to `inherit`; absent when the caller did not ask.
   * Optional rather than defaulted, so the value can distinguish "the caller asked for 2" from
   * "the caller said nothing" — the difference between a stated width and an ignored one.
   */
  readonly count?: number
}

/** One child's canonical outcome. One entry per child, never fewer than the fan-out width. */
export interface PanelChildOutcome {
  /** Position in this fan-out, 0-based. `plans[index]` is the resolution this child ran on. */
  readonly index: number
  /** The resolution's `routeIndex`, or `-1` when it inherited (or had none). */
  readonly routeIndex: number
  /** True when this child inherited the parent's route and sent no `agentOptions`. */
  readonly inherited: boolean
  /** `inherits parent`, or `provider/model`. The one field a human reads first. */
  readonly route: string
  /** `''` when inherited. */
  readonly routeProvider: string
  /** `''` when inherited. */
  readonly routeModel: string
  /** `''` when no effort was sent. */
  readonly routeEffort: string
  /** The resolver's reason for this entry, verbatim (may start with `unavailable:`). */
  readonly reason: string
  /** `error` when the child failed to start, or settled with a diagnostic / `stopReason: error`. */
  readonly status: 'ok' | 'error'
  /** `''` when the child never started. */
  readonly childId: string
  /** `''` when there is no result. */
  readonly stopReason: string
  /** The child's final assistant text, joined. `''` when it produced none. */
  readonly output: string
  /** The failure detail, or `''`. Never empty for a `status: error` child. */
  readonly diagnostic: string
}

/**
 * The canonical value `execute` returns; `PANEL_VALUE_SCHEMA` describes exactly this shape.
 *
 * Flat scalars plus one array of objects, fully required, `additionalProperties: false`
 * everywhere: the enforced subset validates this value against the schema on every return
 * (`dsh-tools/lib/index.js:3417`), so an extra key is a runtime error, not a silent addition.
 */
export interface PanelOutcome {
  readonly role: string
  /** Children attempted: the route list's length, or `count` for an inheriting panel. */
  readonly width: number
  /** Children whose start succeeded (they have a `childId` unless the provider returned none). */
  readonly started: number
  /** Children with `status: ok`. */
  readonly succeeded: number
  /** `width - succeeded`. Every failed child is named in {@link children} and in {@link failureIndices}. */
  readonly failed: number
  /** The indices that failed, in order. Empty when the panel is clean. */
  readonly failureIndices: readonly number[]
  /** True when every child inherited the parent's route (no mapping was applied at all). */
  readonly allInherited: boolean
  /** Distinct `provider/model` routes among the children. `0` when every child inherited. */
  readonly distinctRoutes: number
  /** The honest sentence: weaker panels say they are weaker. See the file comment. */
  readonly note: string
  /** One entry per child, in fan-out order. */
  readonly children: readonly PanelChildOutcome[]
}

interface PstackSpawnPanelToolOptions {
  /** Role -> panel-entry resolution. Injected, so the tool is testable with no Host. */
  readonly panelResolver: PanelResolverLike
  /** The subagent runtime, taken from `ctx.subagents`. */
  readonly subagents: SubagentServiceLike
  /** Provider name to start children on. Defaults to `SPAWN_PROVIDER_NAME`, via `pstack_spawn`. */
  readonly providerName?: string
  /** The same assignment sink `pstack_spawn` uses, so panel children route effort like any other. */
  readonly assignments?: RoleAssignmentSink
}

/**
 * A role that is not a panel role. Thrown, not returned: a refusal is not a panel of width 1.
 *
 * Carries the role and the panel roles as fields as well as in the message, so a caller (or a
 * test) can act on the refusal without parsing prose.
 */
export class PanelRoleError extends Error {
  readonly role: string
  readonly panelRoles: readonly string[]
  constructor(role: string, panelRoles: readonly string[]) {
    super(
      `pstack_spawn_panel cannot fan out "${role}": it is not a panel role. Panel roles are ` +
        `${panelRoles.join(', ')}. Use ${PSTACK_SPAWN_TOOL} to spawn a single child as "${role}".`,
    )
    this.name = 'PanelRoleError'
    this.role = role
    this.panelRoles = panelRoles
  }
}

/**
 * The model-facing parameters.
 *
 * `count` is the one parameter the brief did not name, and it exists because the inheriting case
 * needs a width from somewhere: the rule is that panel
 * roles "run at width 1 unless the human explicitly asks for more, in which case they fan out
 * same-route and the result is labelled seed diversity" — this parameter *is* that explicit ask.
 * It is optional and capped at {@link MAX_PANEL_WIDTH}.
 *
 * `route_index` is deliberately absent: a panel fans out over *every* entry, so a per-call index
 * would be meaningless. {@link parsePanelArgs} refuses it by name rather than ignoring it.
 */
export const PSTACK_SPAWN_PANEL_PARAMETERS: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    role: {
      type: 'string',
      description:
        'The panel role to fan out: one of ' +
        PANEL_ROLES.join(', ') +
        '. One child is spawned per entry of the role\'s route list. Any other role is refused — ' +
        `use ${PSTACK_SPAWN_TOOL} for a single child.`,
    },
    prompt: {
      type: 'string',
      description:
        'The complete, self-contained task for every child; all children get this same prompt. ' +
        'They do not see this conversation.',
    },
    description: {
      type: 'string',
      description: 'A short (3-5 word) label for the children, shown in the transcript. Defaults to the role key.',
    },
    count: {
      type: 'integer',
      description:
        `Children to spawn when the role inherits the parent's route (no usable mapping), 1-${MAX_PANEL_WIDTH}. ` +
        `Defaults to ${DEFAULT_INHERIT_WIDTH}. Ignored when the role has a usable route list, whose length sets the width.`,
    },
  },
  required: ['role', 'prompt'],
}

/** The child entry schema, in the enforced subset. Every object declares `additionalProperties`. */
const PANEL_CHILD_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    index: { type: 'integer', description: 'Position in this fan-out, 0-based.' },
    routeIndex: { type: 'integer', description: "The resolution's routeIndex, or -1 when inherited." },
    inherited: { type: 'boolean', description: "True when this child inherited the parent's route." },
    route: { type: 'string', description: '"inherits parent", or "provider/model".' },
    routeProvider: { type: 'string', description: "Provider sent to agentOptions; '' when inherited." },
    routeModel: { type: 'string', description: "Model sent to agentOptions; '' when inherited." },
    routeEffort: { type: 'string', description: "Reasoning effort sent to agentOptions; '' when none." },
    reason: { type: 'string', description: 'The resolver\'s reason for this entry, verbatim.' },
    status: { type: 'string', enum: ['ok', 'error'], description: 'Whether this child succeeded.' },
    childId: { type: 'string', description: "The published child's id, or '' when it never started." },
    stopReason: { type: 'string', description: "The child's stop reason, or ''." },
    output: { type: 'string', description: "The child's final assistant text, joined." },
    diagnostic: { type: 'string', description: "Failure detail; never '' for a status: error child." },
  },
  required: [
    'index',
    'routeIndex',
    'inherited',
    'route',
    'routeProvider',
    'routeModel',
    'routeEffort',
    'reason',
    'status',
    'childId',
    'stopReason',
    'output',
    'diagnostic',
  ],
}

/** The canonical value's schema, in the enforced subset (`assertSupportedJsonSchema`). */
export const PANEL_VALUE_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    role: { type: 'string', description: 'The panel role that was fanned out.' },
    width: { type: 'integer', description: 'Children attempted.' },
    started: { type: 'integer', description: 'Children whose start succeeded.' },
    succeeded: { type: 'integer', description: 'Children that produced a clean result.' },
    failed: { type: 'integer', description: 'Children that failed to start or settled as errors.' },
    failureIndices: {
      type: 'array',
      items: { type: 'integer' },
      description: 'Which children failed, by index. Empty when the panel is clean.',
    },
    allInherited: { type: 'boolean', description: "True when every child inherited the parent's route." },
    distinctRoutes: { type: 'integer', description: 'Distinct mapped routes among the children; 0 when all inherited.' },
    note: { type: 'string', description: 'The honest summary, including the weaker-panel sentence when it applies.' },
    children: { type: 'array', items: PANEL_CHILD_SCHEMA, description: 'One entry per child, in fan-out order.' },
  },
  required: [
    'role',
    'width',
    'started',
    'succeeded',
    'failed',
    'failureIndices',
    'allInherited',
    'distinctRoutes',
    'note',
    'children',
  ],
}

/** True for a value JSON Schema calls an integer: a safe integer, not a float. */
function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

/**
 * Validate model-generated arguments against {@link PSTACK_SPAWN_PANEL_PARAMETERS}.
 *
 * The three keys both spawn tools share (`role`, `prompt`, `description`) are validated by
 * `parseSpawnArgs` — reused, not copied, so the two tools cannot drift on what a role or a prompt
 * is. This function adds `count` and refuses `route_index` by name.
 *
 * @param raw - arguments, however malformed.
 * @returns the validated arguments, with `count` resolved to its default.
 * @throws SpawnArgsError naming every violation, the way `validateJsonSchemaValue` reports them.
 */
export function parsePanelArgs(raw: unknown): PanelArgs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SpawnArgsError(['arguments must be an object'])
  }
  const record = raw as Record<string, unknown>
  const { count, route_index: routeIndex, ...shared } = record

  const violations: string[] = []
  if (routeIndex !== undefined) {
    violations.push(
      `arguments.route_index is not a parameter of ${PSTACK_SPAWN_PANEL_TOOL}; a panel fans out over every entry of the role's route list`,
    )
  }
  if (count !== undefined && (!isInteger(count) || count < 1 || count > MAX_PANEL_WIDTH)) {
    violations.push(`arguments.count must be an integer between 1 and ${MAX_PANEL_WIDTH}`)
  }

  let base: SpawnArgs | undefined
  try {
    base = parseSpawnArgs(shared)
  } catch (error) {
    if (!(error instanceof SpawnArgsError)) throw error
    violations.push(...error.violations)
  }
  if (violations.length > 0 || base === undefined) {
    throw new SpawnArgsError(violations.length > 0 ? violations : ['arguments could not be validated'])
  }

  return {
    role: base.role,
    prompt: base.prompt,
    ...(base.description === undefined ? {} : { description: base.description }),
    ...(isInteger(count) ? { count } : {}),
  }
}

/** Render an error without ever throwing on an odd value. */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  const text = String(error)
  return text.length > 0 ? text : 'unknown error'
}

/** The route a plan names, in the one-string form a human reads. */
function routeLabel(plan: ResolvedRoleLike): string {
  if (plan.inherit || plan.route === undefined) return 'inherits parent'
  return `${plan.route.provider}/${plan.route.model}`
}

/**
 * Turn a child's canonical `pstack_spawn` value into this panel's entry for it.
 *
 * `error` means the child failed: a non-empty `diagnostic`, or `stopReason: 'error'`. A child that
 * stopped for any other reason (`max_tokens`, a refusal-to-continue) is `ok` — it started, ran on
 * its route, and said what it said, which is what a panel compares.
 */
function entryFor(index: number, plan: ResolvedRoleLike, value: SpawnOutcome): PanelChildOutcome {
  return {
    index,
    routeIndex: value.routeIndex,
    inherited: value.inherited,
    route: routeLabel(plan),
    routeProvider: value.routeProvider,
    routeModel: value.routeModel,
    routeEffort: value.routeEffort,
    reason: value.reason,
    status: value.diagnostic.length > 0 || value.stopReason === 'error' ? 'error' : 'ok',
    childId: value.childId,
    stopReason: value.stopReason,
    output: value.output,
    diagnostic: value.diagnostic,
  }
}

/**
 * The entry for a child that never started. It still names its index and its route: a fan-out
 * failure must not hide a child, and "which route was it supposed to be on" is the first question
 * a partial failure raises.
 */
function unstartedEntry(index: number, plan: ResolvedRoleLike, diagnostic: string): PanelChildOutcome {
  return {
    index,
    routeIndex: plan.routeIndex ?? -1,
    inherited: plan.inherit,
    route: routeLabel(plan),
    routeProvider: plan.inherit ? '' : (plan.route?.provider ?? ''),
    routeModel: plan.inherit ? '' : (plan.route?.model ?? ''),
    routeEffort: plan.inherit ? '' : (plan.route?.reasoningEffort ?? ''),
    reason: plan.reason,
    status: 'error',
    childId: '',
    stopReason: '',
    output: '',
    diagnostic,
  }
}

/**
 * The honest summary sentence. Exported because it is the part of the value the menu repeats, so
 * it is worth asserting on directly.
 *
 * Three cases, and the first two are weaker panels that must be labelled as such:
 * every child inherits; a route list that names one distinct route (including the same route
 * listed twice, which is what a one-route install's only legal panel looks like); and a genuinely
 * multi-route panel.
 *
 * @param options - the fan-out's shape.
 * @returns the note.
 */
export function panelNote(options: {
  readonly width: number
  readonly allInherited: boolean
  readonly distinctRoutes: number
  /** `provider/model` of the single distinct route, when there is exactly one. */
  readonly onlyRoute?: string | undefined
  /** Set when the caller passed `count` for a role whose route list set the width itself. */
  readonly ignoredCount?: number | undefined
}): string {
  const { width, allInherited, distinctRoutes, onlyRoute, ignoredCount } = options
  const children = width === 1 ? '1 child' : `${width} children`
  let note: string
  if (allInherited) {
    note = `all ${children} inherit the parent's route: same route, separate reads — seed diversity only, not family diversity`
  } else if (distinctRoutes <= 1) {
    note =
      `the route list names 1 distinct route${onlyRoute === undefined ? '' : ` (${onlyRoute})`}, so all ${children} ran ` +
      'same-route: seed diversity only, not family diversity'
  } else {
    note = `${children} ran on ${distinctRoutes} distinct routes`
  }
  if (ignoredCount !== undefined) {
    note += `; count=${ignoredCount} was ignored because the role's route list sets the panel width (${width})`
  }
  return note
}

/** The distinct `provider/model` routes among a plan list, in first-seen order. */
function distinctMappedRoutes(plans: readonly ResolvedRoleLike[]): readonly string[] {
  const distinct = new Set<string>()
  for (const plan of plans) {
    if (!plan.inherit && plan.route !== undefined) distinct.add(`${plan.route.provider}/${plan.route.model}`)
  }
  return [...distinct]
}

/**
 * Create the registry-ready `pstack_spawn_panel` definition.
 *
 * `execute` resolves the panel, builds the child resolution list, then runs the **real**
 * `pstack_spawn` tool once per child with `route_index` = that child's position. See the file
 * comment for the reuse argument and for why the children start sequentially.
 *
 * @param options - panel resolver, subagent service, provider name, optional assignment sink.
 * @returns a definition for `ctx.tools.register`, validated by the registry at registration.
 */
export function createPstackSpawnPanelTool(options: PstackSpawnPanelToolOptions): ToolDefinitionLike {
  return {
    name: PSTACK_SPAWN_PANEL_TOOL,
    description:
      'Fan out one task to several child agents, one per route entry of a panel role (see the role\'s ' +
      'route list). Use this instead of ' +
      PSTACK_SPAWN_TOOL +
      ' when the work is wide exploration that benefits from independent reads: each child gets the same ' +
      'prompt and cannot see the others. With one route available the panel is same-route, which is seed ' +
      'diversity only — the result says so in its note. A role that is not a panel role is refused.',
    parameters: PSTACK_SPAWN_PANEL_PARAMETERS,
    output: {
      schema: PANEL_VALUE_SCHEMA,
      render: (_args, value) => {
        const outcome = value as PanelOutcome
        const lines = outcome.children.map(
          (child) =>
            `[${child.index}] ${child.route}${child.routeEffort.length > 0 ? ` (effort ${child.routeEffort})` : ''} ` +
            `-> ${child.status}${child.status === 'error' ? `: ${child.diagnostic}` : ''}`,
        )
        const header =
          `${PSTACK_SPAWN_PANEL_TOOL} role=${outcome.role} width=${outcome.width} ` +
          `ok=${outcome.succeeded} failed=${outcome.failed} distinctRoutes=${outcome.distinctRoutes}\n` +
          `${outcome.note}`
        return [{ type: 'text', text: `${header}\n\n${lines.join('\n')}\n\n${JSON.stringify(outcome, null, 2)}` }]
      },
    },
    execute: async (rawArgs: unknown, exec: ToolRunContext): Promise<unknown> => {
      const args = parsePanelArgs(rawArgs)
      const roleKey = normaliseRoleKey(args.role)
      if (!isPanelRole(roleKey)) throw new PanelRoleError(canonicalRole(args.role), PANEL_ROLES)
      exec.signal?.throwIfAborted()

      const resolved = await options.panelResolver.resolvePanel(args.role)
      const first = resolved[0]
      if (first === undefined) {
        throw new Error(
          `${PSTACK_SPAWN_PANEL_TOOL}: the panel resolver returned no resolution for "${args.role}"; ` +
            'a panel cannot be spawned from nothing',
        )
      }

      // The width rule, both halves: an inheriting panel spawns N
      // children all inheriting; a route list spawns exactly one child per entry.
      const inheriting = resolved.length === 1 && first.inherit
      const plans: readonly ResolvedRoleLike[] = inheriting
        ? Array.from({ length: args.count ?? DEFAULT_INHERIT_WIDTH }, () => first)
        : resolved
      // A `count` the route list overrode is stated, never silently dropped.
      const ignoredCount = inheriting ? undefined : args.count

      const childTool = createPstackSpawnTool({
        // The one thing this module owns: which resolution each child gets. `route_index` is the
        // child's position in the fan-out, and this resolver maps it to that child's own entry —
        // so the route applied is by construction the route reported.
        resolver: {
          resolve: (_role: string, routeIndex?: number): ResolvedRoleLike => {
            const plan = plans[routeIndex ?? 0]
            if (plan === undefined) {
              throw new Error(
                `${PSTACK_SPAWN_PANEL_TOOL}: internal error — no resolution for child index ${routeIndex ?? 0}`,
              )
            }
            return plan
          },
        },
        subagents: options.subagents,
        ...(options.providerName === undefined ? {} : { providerName: options.providerName }),
        ...(options.assignments === undefined ? {} : { assignments: options.assignments }),
      })

      const children: PanelChildOutcome[] = []
      let started = 0
      for (const [index, plan] of plans.entries()) {
        // Sequential by decision (see the file comment). Checked before each start so an aborted
        // panel stops promptly rather than after the last child.
        exec.signal?.throwIfAborted()
        const childArgs = {
          role: args.role,
          prompt: args.prompt,
          ...(args.description === undefined ? {} : { description: args.description }),
          route_index: index,
        }
        try {
          const value = (await childTool.execute(childArgs, exec)) as SpawnOutcome
          started += 1
          children.push(entryFor(index, plan, value))
        } catch (error) {
          // An abort is not a child failure: let it propagate instead of inventing an entry for
          // it. (A partial *failure* still gets an entry — that is the next line.)
          exec.signal?.throwIfAborted()
          children.push(unstartedEntry(index, plan, `child ${index} did not start: ${describeError(error)}`))
        }
      }

      const succeeded = children.filter((child) => child.status === 'ok').length
      const failureIndices = children.filter((child) => child.status === 'error').map((child) => child.index)
      const allInherited = plans.every((plan) => plan.inherit)
      const mappedRoutes = distinctMappedRoutes(plans)

      return {
        role: canonicalRole(args.role),
        width: plans.length,
        started,
        succeeded,
        failed: plans.length - succeeded,
        failureIndices,
        allInherited,
        distinctRoutes: mappedRoutes.length,
        note: panelNote({
          width: plans.length,
          allInherited,
          distinctRoutes: mappedRoutes.length,
          onlyRoute: mappedRoutes.length === 1 ? mappedRoutes[0] : undefined,
          ignoredCount,
        }),
        children,
      } satisfies PanelOutcome
    },
  }
}
