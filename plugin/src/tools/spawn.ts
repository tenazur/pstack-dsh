/**
 * `pstack_spawn` — the Phase 4 tool that makes role routing real.
 *
 * The constraint everything follows from: DSH's model-facing `subagent` tool carries no
 * `model` and no `reasoning_effort` unless a Host-owned user preference is on
 * (`plugin/HARNESS.md` §Rules 1; `dsh-tool-subagent/lib/index.js:412-425` adds those fields
 * only on a model-selection-enabled instance). Role routing therefore cannot ride on the
 * stock tool. This tool bridges to the same programmatic API the stock tool uses —
 * `ctx.subagents.start(name, request)` (`dsh-subagent/lib/types/index.d.ts:296`) — and puts
 * the role's route into `SubagentStartRequest.agentOptions`
 * (`dsh-subagent/lib/types/types.d.ts:162`).
 *
 * Two properties are the point of the unit, and both are testable without a Host:
 *
 * 1. A mapped role sends `agentOptions: { provider, model, reasoningEffort? }`.
 * 2. An **inheriting** role sends **no `agentOptions` key at all**. Omitting means inherit
 *    (`dsh-subagent/lib/index.js:468-484` merges the overrides over the parent's options);
 *    sending the parent's own route back would look like a mapping that does not exist.
 *
 * Everything DSH-shaped is declared structurally here, never imported, because this package
 * typechecks, tests and installs with no dependencies at all — the same choice
 * `src/skills/provider.ts` and `src/roles/catalog.ts` make. The one exception is the shared
 * `ToolDefinitionLike` contract, which lives in `./status.ts` so there is exactly one copy.
 *
 * ## Merge-extensible `agentOptions` — do not narrow it
 *
 * `AgentOptions` (`dsh-agent/lib/types/runtime-types.d.ts:21-30`) declares four base fields
 * and its doc comment says "Merge-extensible agent creation options"; `subagentDepth?` is
 * declaration-merged in from a *different* package (`dsh-subagent/lib/types/depth.d.ts:10`).
 * `AgentOptionsLike` below therefore carries an index signature: a closed four-field copy
 * would be a narrowing that a later DSH release silently invalidates.
 */
import type { ToolDefinitionLike, ToolRunContext } from './status.ts'

/** Model-facing tool name. Snake_case, like `pstack_status` and DSH's own `run_code`. */
export const PSTACK_SPAWN_TOOL = 'pstack_spawn'

/**
 * Subagent provider name this tool starts children on.
 * `dsh-subagent-spawn-in-process` registers under `providerName` defaulting to `"spawn"`
 * (`dsh-subagent-spawn-in-process/lib/index.js:14`), and it advertises
 * `capabilities.agentOptions: true` (`:24-30`) — which is what makes this tool possible.
 */
export const SPAWN_PROVIDER_NAME = 'spawn'

/** One route a role can run on. Mirrors `RoleRoute` in `src/roles/catalog.ts:50`. */
interface RoleRouteLike {
  readonly provider: string
  readonly model: string
  /** Only an effort id the route actually advertises; never a cross-vendor guess. */
  readonly reasoningEffort?: string
}

/** A role's resolved target: a specific route, or the parent. Mirrors `ResolvedRole`. */
export interface ResolvedRoleLike {
  readonly role: string
  readonly inherit: boolean
  readonly route?: RoleRouteLike
  readonly routeIndex?: number
  /** Why this resolution happened. Surface it verbatim — `unavailable: …` is meaningful. */
  readonly reason: string
}

/**
 * The narrow resolver face this tool consumes.
 *
 * The real seam is `resolveRole(role, overlay, catalog, entryIndex = 0)` exported by
 * `src/roles/catalog.ts`; `plugin/src/index.ts` adapts it to this one-method object. Taking
 * the resolver as a parameter rather than importing a module is what lets the tool be
 * tested against a fake mapping with no Host, no llm service and no credentials.
 *
 * `resolve` may be asynchronous because the production adapter lazily enumerates the live
 * route catalog on first use. `undefined` for `routeIndex` means "the role's own default",
 * which the adapter maps to `entryIndex = 0`.
 */
export interface RoleResolverLike {
  resolve(role: string, routeIndex?: number): ResolvedRoleLike | Promise<ResolvedRoleLike>
}

/**
 * The `ctx.subagents` slice this tool uses, deliberately no wider than one method.
 * `start` is the only real side effect in this file; typing it as `unknown`-in/`unknown`-out
 * keeps every provider-specific field out of this module's contract.
 */
export interface SubagentServiceLike {
  start(name: string, request: unknown): Promise<unknown>
}

/**
 * `AgentOptions` with its extension point intact (`dsh-agent/.../runtime-types.d.ts:21-30`
 * plus `dsh-subagent/.../depth.d.ts:10`). The index signature is the point, not decoration.
 */
interface AgentOptionsLike {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
  readonly [extension: string]: unknown
}

/** One model-facing content block (`dsh-llm/lib/types/types.d.ts:100-102`), text only. */
interface ContentBlockLike {
  readonly type: 'text'
  readonly text: string
}

/** The calling agent as this tool reads it (`Agent`: `id`, `options`). */
export interface SpawnAgentLike {
  readonly id?: string
  readonly options?: AgentOptionsLike
}

/** Run context: `ToolRunContext` plus the calling agent a spawn needs. */
export interface SpawnRunContext extends ToolRunContext {
  /** The agent that called this tool; `SubagentStartRequest.parent`. */
  readonly agent?: SpawnAgentLike | undefined
}

/** Validated arguments, in the spelling the tool body uses. */
export interface SpawnArgs {
  readonly role: string
  readonly prompt: string
  readonly description?: string
  readonly routeIndex?: number
}

/** The request parts this module owns. `parent`/`signal` are added by `execute`. */
interface SpawnRequestParts {
  readonly label: string
  readonly prompt: readonly ContentBlockLike[]
  /**
   * Present **only** for a mapped route. An inheriting role must produce a parts object with
   * no such key, so `{ ...parts }` cannot smuggle one in.
   */
  readonly agentOptions?: AgentOptionsLike
}

/**
 * The canonical value `execute` returns; `SPAWN_VALUE_SCHEMA` describes exactly this shape.
 *
 * Flat and fully required on purpose: `output.schema` is enforced against every canonical
 * value (`dsh-tools/lib/index.js:2773`, `assertSupportedJsonSchema` `:322`), and the enforced
 * subset has no optional properties and no `type` arrays (`:235-237`). `-1`/`''` are the
 * "absent" spellings; `inherited` and `reason` carry the meaning.
 *
 * `reason` is passed through **verbatim**, including the `unavailable:` prefix
 * (`UNAVAILABLE_REASON_PREFIX` in `src/roles/catalog.ts`). A refusal is exactly what a caller
 * needs to see; collapsing it into "nothing configured" would hide a broken mapping.
 */
export interface SpawnOutcome {
  readonly role: string
  readonly inherited: boolean
  readonly reason: string
  /** `''` when the role inherited. */
  readonly routeProvider: string
  /** `''` when the role inherited. */
  readonly routeModel: string
  /** `''` when the route names no effort. */
  readonly routeEffort: string
  /** The resolver's `routeIndex`, or `-1`. */
  readonly routeIndex: number
  /** What the caller asked for, or `-1`. */
  readonly requestedRouteIndex: number
  readonly subagentProvider: string
  /** `''` when the provider returned no id. */
  readonly childId: string
  /** The child's stop reason, or `''` when it produced no result. */
  readonly stopReason: string
  /** The child's final assistant text, joined. */
  readonly output: string
  /** The provider's failure detail, or `''`. */
  readonly diagnostic: string
}

interface PstackSpawnToolOptions {
  /** Role -> route resolution. Injected, so the tool is testable with no Host. */
  readonly resolver: RoleResolverLike
  /** The subagent runtime, taken from `ctx.subagents`. */
  readonly subagents: SubagentServiceLike
  /** Provider name to start children on. Defaults to {@link SPAWN_PROVIDER_NAME}. */
  readonly providerName?: string
  /**
   * Optional sink recording which role/effort a published child runs, keyed by child id.
   * The `agent/request` listener in `src/effort.ts` reads it. Optional so the tool can be
   * exercised on its own.
   */
  readonly assignments?: RoleAssignmentSink
}

/**
 * The write half of `RoleAssignmentStore` (`src/effort.ts`). Declared here as a one-method
 * structural type rather than imported, so the tool does not depend on the listener module.
 */
export interface RoleAssignmentSink {
  set(childId: string, assignment: { readonly role: string; readonly effort: string }): void
}

/** Invalid model-generated arguments. Mirrors DSH's `ToolArgsError` (`dsh-tools/lib/index.js:828`). */
export class SpawnArgsError extends Error {
  readonly violations: readonly string[]
  constructor(violations: readonly string[]) {
    super(`invalid arguments: ${violations.join('; ')}`)
    this.name = 'SpawnArgsError'
    this.violations = violations
  }
}

/**
 * The four model-facing parameters, as raw JSON Schema.
 *
 * `defineTool` compiles a per-property spec into exactly this shape
 * (`parameterSchemaSpecToJsonSchema`, `dsh-tools/lib/index.js:802`), and this package cannot
 * import `defineTool` (no DSH dependency), so the raw schema is written out. Because the
 * registry does **not** validate `parameters` the way it validates `output.schema`
 * (`dsh-tools/lib/index.js:2773`), the same contract is re-implemented in
 * {@link parseSpawnArgs} — re-implemented, not skipped:
 * `defineTool` wraps `execute` in `validateJsonSchemaValue` (`:846`-`:860`) and a raw
 * definition gets no such wrapper.
 */
export const PSTACK_SPAWN_PARAMETERS: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    role: {
      type: 'string',
      description:
        'The pstack role to run this child as: a role key from the overlay (for example "architect"), ' +
        'or one of the spawn role values. Resolved against the live route catalog; a role with no ' +
        'usable mapping inherits the parent.',
    },
    prompt: {
      type: 'string',
      description: 'The complete, self-contained task for the child. It does not see this conversation.',
    },
    description: {
      type: 'string',
      description: 'A short (3-5 word) label for the child, shown in the transcript. Defaults to the role key.',
    },
    route_index: {
      type: 'integer',
      description:
        "For a panel role (one with a list of routes), which entry of that list to use. Omit for the " +
        "role's first entry. Ignored by a scalar role.",
    },
  },
  required: ['role', 'prompt'],
}

/**
 * The canonical value's schema, in the enforced subset.
 *
 * Every object declares `additionalProperties`, as `checkSchemaNode` requires for explicit
 * object nodes (`dsh-tools/lib/index.js:196-205`), and `required` names only declared
 * properties (`checkObjectSchemaTail` `:151-162`).
 */
export const SPAWN_VALUE_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    role: { type: 'string', description: 'The role key this child was resolved for.' },
    inherited: { type: 'boolean', description: "True when the child inherited the parent's route." },
    reason: { type: 'string', description: 'The resolver\'s reason, verbatim (may start with "unavailable:").' },
    routeProvider: { type: 'string', description: "Provider sent to agentOptions; '' when inherited." },
    routeModel: { type: 'string', description: "Model sent to agentOptions; '' when inherited." },
    routeEffort: { type: 'string', description: "Reasoning effort sent to agentOptions; '' when none." },
    routeIndex: { type: 'integer', description: "The resolver's routeIndex, or -1." },
    requestedRouteIndex: { type: 'integer', description: 'The route_index argument, or -1.' },
    subagentProvider: { type: 'string', description: 'Provider name this tool started the child on.' },
    childId: { type: 'string', description: "The published child's id, or ''." },
    stopReason: { type: 'string', description: "The child's stop reason, or '' when it produced no result." },
    output: { type: 'string', description: "The child's final assistant text, joined." },
    diagnostic: { type: 'string', description: "Provider failure detail, or ''." },
  },
  required: [
    'role',
    'inherited',
    'reason',
    'routeProvider',
    'routeModel',
    'routeEffort',
    'routeIndex',
    'requestedRouteIndex',
    'subagentProvider',
    'childId',
    'stopReason',
    'output',
    'diagnostic',
  ],
}

/** True for a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** True for a value JSON Schema calls an integer: a safe integer, not a float. */
function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

/**
 * Validate model-generated arguments against {@link PSTACK_SPAWN_PARAMETERS}.
 *
 * The four rules are the schema's: `role` and `prompt` are required non-empty strings,
 * `description` is an optional string, `route_index` is an optional non-negative integer, and
 * no other key is accepted (`additionalProperties: false`). Violations are path-qualified, the
 * way `validateJsonSchemaValue` reports them, so the model can act on the message.
 *
 * @param raw - arguments, however malformed.
 * @returns the validated arguments.
 * @throws SpawnArgsError naming every violation.
 */
export function parseSpawnArgs(raw: unknown): SpawnArgs {
  const violations: string[] = []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SpawnArgsError(['arguments must be an object'])
  }
  const record = raw as Record<string, unknown>
  const declared = new Set(['role', 'prompt', 'description', 'route_index'])
  for (const key of Object.keys(record)) {
    if (!declared.has(key)) violations.push(`arguments.${key} is not a declared parameter`)
  }

  const role = record['role']
  if (!isNonEmptyString(role)) violations.push('arguments.role must be a non-empty string')
  const prompt = record['prompt']
  if (!isNonEmptyString(prompt)) violations.push('arguments.prompt must be a non-empty string')

  const description = record['description']
  if (description !== undefined && typeof description !== 'string') {
    violations.push('arguments.description must be a string')
  }

  const routeIndex = record['route_index']
  if (routeIndex !== undefined && (!isInteger(routeIndex) || routeIndex < 0)) {
    violations.push('arguments.route_index must be a non-negative integer')
  }

  if (violations.length > 0) throw new SpawnArgsError(violations)

  return {
    role: role as string,
    prompt: prompt as string,
    ...(typeof description === 'string' ? { description } : {}),
    ...(isInteger(routeIndex) ? { routeIndex } : {}),
  }
}

/**
 * Build the role-derived part of a `SubagentStartRequest`. Pure: no clock, no I/O, no Host.
 *
 * The whole mapping decision is here, which is what makes ACCEPTANCE 2 testable and what makes
 * "remove the mapping" a one-line edit that the test then fails on.
 *
 * @param resolved - the resolver's answer for the requested role.
 * @param args - validated tool arguments.
 * @returns `{ label, prompt }` plus `agentOptions` **only** when the role maps to a route.
 */
export function buildSpawnRequest(resolved: ResolvedRoleLike, args: SpawnArgs): SpawnRequestParts {
  const label = isNonEmptyString(args.description) ? args.description : resolved.role
  const prompt: readonly ContentBlockLike[] = [{ type: 'text', text: args.prompt }]

  const route = resolved.inherit ? undefined : resolved.route
  if (route === undefined) return { label, prompt }

  const agentOptions: Record<string, unknown> = { provider: route.provider, model: route.model }
  if (isNonEmptyString(route.reasoningEffort)) agentOptions['reasoningEffort'] = route.reasoningEffort
  return { label, prompt, agentOptions }
}

/** Turn the canonical outcome of a resolution into the flat canonical value. */
function outcomeFor(
  resolved: ResolvedRoleLike,
  args: SpawnArgs,
  providerName: string,
): Omit<SpawnOutcome, 'childId' | 'stopReason' | 'output' | 'diagnostic'> {
  const route = resolved.inherit ? undefined : resolved.route
  return {
    role: resolved.role,
    inherited: resolved.inherit,
    reason: resolved.reason,
    routeProvider: route?.provider ?? '',
    routeModel: route?.model ?? '',
    routeEffort: route?.reasoningEffort ?? '',
    routeIndex: resolved.routeIndex ?? -1,
    requestedRouteIndex: args.routeIndex ?? -1,
    subagentProvider: providerName,
  }
}

/** Read a property off an unknown value without throwing on a hostile object. */
function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/** Flatten a child's content-block output to text. Never throws on odd shapes. */
function flattenOutput(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const block of value) {
    const text = readProperty(block, 'text')
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('\n')
}

/**
 * Add the two fields a `SubagentStartRequest` needs from the run context and call the service.
 *
 * Kept separate from {@link buildSpawnRequest} so the mapping logic stays pure: this is the
 * only function here that touches the real service.
 */
async function startChild(
  subagents: SubagentServiceLike,
  providerName: string,
  parts: SpawnRequestParts,
  exec: SpawnRunContext,
): Promise<unknown> {
  if (exec.agent === undefined) {
    throw new Error(`${PSTACK_SPAWN_TOOL}: no calling agent (exec.agent was undefined), so there is no parent to delegate from`)
  }
  const request = { ...parts, parent: exec.agent, signal: exec.signal }
  return await subagents.start(providerName, request)
}

/** Await a run's result and dispose it, reporting whatever the provider actually gave us. */
async function settleRun(run: unknown): Promise<{ childId: string; stopReason: string; output: string; diagnostic: string }> {
  const childId = isNonEmptyString(readProperty(run, 'id')) ? (readProperty(run, 'id') as string) : ''
  const resultPromise = readProperty(run, 'result')
  let result: unknown
  try {
    result = resultPromise instanceof Promise ? await resultPromise : resultPromise
  } catch (error) {
    return { childId, stopReason: 'error', output: '', diagnostic: `child run rejected: ${String(error)}` }
  } finally {
    const dispose = readProperty(run, 'dispose')
    if (typeof dispose === 'function') {
      try {
        await (dispose as () => Promise<void>).call(run)
      } catch {
        // Disposal is best-effort here: the child has already settled and the caller's
        // result is what matters. A failed dispose must not erase an otherwise usable run.
      }
    }
  }
  return {
    childId,
    stopReason: isNonEmptyString(readProperty(result, 'stopReason')) ? (readProperty(result, 'stopReason') as string) : '',
    output: flattenOutput(readProperty(result, 'output')),
    diagnostic: isNonEmptyString(readProperty(result, 'diagnostic')) ? (readProperty(result, 'diagnostic') as string) : '',
  }
}

/**
 * Create the registry-ready `pstack_spawn` definition.
 *
 * `execute` is a thin wrapper: validate, resolve, build the request, start the child, report.
 * All the mapping logic lives in {@link buildSpawnRequest}, which is why this file can be
 * tested end to end with a fake service and no Host.
 *
 * @param options - resolver, subagent service, provider name, optional assignment sink.
 * @returns a definition for `ctx.tools.register`, validated by the registry at registration.
 */
export function createPstackSpawnTool(options: PstackSpawnToolOptions): ToolDefinitionLike {
  const providerName = options.providerName ?? SPAWN_PROVIDER_NAME
  return {
    name: PSTACK_SPAWN_TOOL,
    description:
      'Delegate one task to a child agent running as a pstack role. The role is resolved against the ' +
      "live route catalog: a mapped role runs the child on that role's provider, model and reasoning " +
      'effort, while a role with no usable mapping inherits the parent\'s route. Prefer this over the ' +
      'stock subagent tool whenever the task has a pstack role, so the route is auditable from the ' +
      'transcript. The child does not see this conversation; the prompt must be self-contained.',
    parameters: PSTACK_SPAWN_PARAMETERS,
    output: {
      schema: SPAWN_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (rawArgs: unknown, exec: ToolRunContext): Promise<unknown> => {
      const args = parseSpawnArgs(rawArgs)
      const runContext: SpawnRunContext = exec
      exec.signal?.throwIfAborted()

      const resolved = await options.resolver.resolve(args.role, args.routeIndex)
      const parts = buildSpawnRequest(resolved, args)
      const outcome = outcomeFor(resolved, args, providerName)

      exec.signal?.throwIfAborted()
      const run = await startChild(options.subagents, providerName, parts, runContext)
      const settled = await settleRun(run)

      // Record the child's role/effort for the `agent/request` listener. Best-effort by
      // design: the effort also rides in `agentOptions` (the race-free channel), so a child
      // whose first request beats this line is still correct.
      if (options.assignments !== undefined && settled.childId.length > 0 && outcome.routeEffort.length > 0) {
        options.assignments.set(settled.childId, { role: resolved.role, effort: outcome.routeEffort })
      }

      return { ...outcome, ...settled } satisfies SpawnOutcome
    },
  }
}
