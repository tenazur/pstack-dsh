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
import type { ToolDefinitionLike, ToolRunContext } from './status.ts';
/** Model-facing tool name. Snake_case, like `pstack_status` and DSH's own `run_code`. */
export declare const PSTACK_SPAWN_TOOL = "pstack_spawn";
/**
 * Subagent provider name this tool starts children on.
 * `dsh-subagent-spawn-in-process` registers under `providerName` defaulting to `"spawn"`
 * (`dsh-subagent-spawn-in-process/lib/index.js:14`), and it advertises
 * `capabilities.agentOptions: true` (`:24-30`) — which is what makes this tool possible.
 */
export declare const SPAWN_PROVIDER_NAME = "spawn";
/** One route a role can run on. Mirrors `RoleRoute` in `src/roles/catalog.ts:50`. */
interface RoleRouteLike {
    readonly provider: string;
    readonly model: string;
    /** Only an effort id the route actually advertises; never a cross-vendor guess. */
    readonly reasoningEffort?: string;
}
/** A role's resolved target: a specific route, or the parent. Mirrors `ResolvedRole`. */
export interface ResolvedRoleLike {
    readonly role: string;
    readonly inherit: boolean;
    readonly route?: RoleRouteLike;
    readonly routeIndex?: number;
    /** Why this resolution happened. Surface it verbatim — `unavailable: …` is meaningful. */
    readonly reason: string;
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
    resolve(role: string, routeIndex?: number): ResolvedRoleLike | Promise<ResolvedRoleLike>;
}
/**
 * The `ctx.subagents` slice this tool uses, deliberately no wider than one method.
 * `start` is the only real side effect in this file; typing it as `unknown`-in/`unknown`-out
 * keeps every provider-specific field out of this module's contract.
 */
export interface SubagentServiceLike {
    start(name: string, request: unknown): Promise<unknown>;
}
/**
 * `AgentOptions` with its extension point intact (`dsh-agent/.../runtime-types.d.ts:21-30`
 * plus `dsh-subagent/.../depth.d.ts:10`). The index signature is the point, not decoration.
 */
interface AgentOptionsLike {
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
    readonly maxTokens?: number;
    readonly [extension: string]: unknown;
}
/** One model-facing content block (`dsh-llm/lib/types/types.d.ts:100-102`), text only. */
interface ContentBlockLike {
    readonly type: 'text';
    readonly text: string;
}
/** The calling agent as this tool reads it (`Agent`: `id`, `options`). */
export interface SpawnAgentLike {
    readonly id?: string;
    readonly options?: AgentOptionsLike;
}
/** Run context: `ToolRunContext` plus the calling agent a spawn needs. */
export interface SpawnRunContext extends ToolRunContext {
    /** The agent that called this tool; `SubagentStartRequest.parent`. */
    readonly agent?: SpawnAgentLike | undefined;
}
/** Validated arguments, in the spelling the tool body uses. */
export interface SpawnArgs {
    readonly role: string;
    readonly prompt: string;
    readonly description?: string;
    readonly routeIndex?: number;
}
/** The request parts this module owns. `parent`/`signal` are added by `execute`. */
interface SpawnRequestParts {
    readonly label: string;
    readonly prompt: readonly ContentBlockLike[];
    /**
     * Present **only** for a mapped route. An inheriting role must produce a parts object with
     * no such key, so `{ ...parts }` cannot smuggle one in.
     */
    readonly agentOptions?: AgentOptionsLike;
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
    readonly role: string;
    readonly inherited: boolean;
    readonly reason: string;
    /** `''` when the role inherited. */
    readonly routeProvider: string;
    /** `''` when the role inherited. */
    readonly routeModel: string;
    /** `''` when the route names no effort. */
    readonly routeEffort: string;
    /** The resolver's `routeIndex`, or `-1`. */
    readonly routeIndex: number;
    /** What the caller asked for, or `-1`. */
    readonly requestedRouteIndex: number;
    readonly subagentProvider: string;
    /** `''` when the provider returned no id. */
    readonly childId: string;
    /** The child's stop reason, or `''` when it produced no result. */
    readonly stopReason: string;
    /** The child's final assistant text, joined. */
    readonly output: string;
    /** The provider's failure detail, or `''`. */
    readonly diagnostic: string;
}
interface PstackSpawnToolOptions {
    /** Role -> route resolution. Injected, so the tool is testable with no Host. */
    readonly resolver: RoleResolverLike;
    /** The subagent runtime, taken from `ctx.subagents`. */
    readonly subagents: SubagentServiceLike;
    /** Provider name to start children on. Defaults to {@link SPAWN_PROVIDER_NAME}. */
    readonly providerName?: string;
    /**
     * Optional sink recording which role/effort a published child runs, keyed by child id.
     * The `agent/request` listener in `src/effort.ts` reads it. Optional so the tool can be
     * exercised on its own.
     */
    readonly assignments?: RoleAssignmentSink;
}
/**
 * The write half of `RoleAssignmentStore` (`src/effort.ts`). Declared here as a one-method
 * structural type rather than imported, so the tool does not depend on the listener module.
 */
export interface RoleAssignmentSink {
    set(childId: string, assignment: {
        readonly role: string;
        readonly effort: string;
    }): void;
}
/** Invalid model-generated arguments. Mirrors DSH's `ToolArgsError` (`dsh-tools/lib/index.js:828`). */
export declare class SpawnArgsError extends Error {
    readonly violations: readonly string[];
    constructor(violations: readonly string[]);
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
export declare const PSTACK_SPAWN_PARAMETERS: Readonly<Record<string, unknown>>;
/**
 * The canonical value's schema, in the enforced subset.
 *
 * Every object declares `additionalProperties`, as `checkSchemaNode` requires for explicit
 * object nodes (`dsh-tools/lib/index.js:196-205`), and `required` names only declared
 * properties (`checkObjectSchemaTail` `:151-162`).
 */
export declare const SPAWN_VALUE_SCHEMA: Readonly<Record<string, unknown>>;
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
export declare function parseSpawnArgs(raw: unknown): SpawnArgs;
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
export declare function buildSpawnRequest(resolved: ResolvedRoleLike, args: SpawnArgs): SpawnRequestParts;
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
export declare function createPstackSpawnTool(options: PstackSpawnToolOptions): ToolDefinitionLike;
export {};
