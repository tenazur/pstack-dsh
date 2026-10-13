import type { OverlayFile } from '../roles/overlay.ts';
import type { RouteCatalog } from '../roles/catalog.ts';
import type { ResolvedRoleLike, RoleAssignmentSink, SubagentServiceLike } from './spawn.ts';
import type { ToolDefinitionLike } from './status.ts';
/** Model-facing tool name. Snake_case, like `pstack_spawn` and `pstack_status`. */
export declare const PSTACK_SPAWN_PANEL_TOOL = "pstack_spawn_panel";
/**
 * How many children an **inheriting** panel role spawns when the caller does not say.
 *
 * Not 1: a caller who reaches for the panel tool has already asked for a panel, and width 1 is
 * what `pstack_spawn` is for. Not more than 2 by default: same-route
 * fan-out is something the human opts into, and this default is
 * the smallest widening that can produce any independent-read signal at all.
 */
export declare const DEFAULT_INHERIT_WIDTH = 2;
/**
 * Hard ceiling on {@link PSTACK_SPAWN_PANEL_PARAMETERS}'s `count`.
 *
 * The unit's own rule is "never spawn more than 4 children" per call in this one-route install,
 * and every child is a real model call. A caller that wants a wider panel must widen the overlay's
 * route list, which is a deliberate act on a file a human edits.
 */
export declare const MAX_PANEL_WIDTH = 4;
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
    resolvePanel(role: string): readonly ResolvedRoleLike[] | Promise<readonly ResolvedRoleLike[]>;
}
/** What {@link createPanelResolver} needs: the live catalog, and a fresh overlay read per resolve. */
interface PanelResolverSources {
    /** The live route inventory (`RoleResolver.catalog`). */
    readonly catalog: () => Promise<RouteCatalog>;
    /**
     * Read the overlay for one resolve. Called per panel resolve, not cached: it is a file a person
     * hand-edits (`src/roles/resolver.ts:9-14`).
     */
    readonly readOverlay: () => Promise<OverlayFile | undefined>;
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
export declare function createPanelResolver(sources: PanelResolverSources): PanelResolverLike;
/** Validated arguments, in the spelling the tool body uses. */
interface PanelArgs {
    readonly role: string;
    readonly prompt: string;
    readonly description?: string;
    /**
     * Children to spawn when the role resolves to `inherit`; absent when the caller did not ask.
     * Optional rather than defaulted, so the value can distinguish "the caller asked for 2" from
     * "the caller said nothing" — the difference between a stated width and an ignored one.
     */
    readonly count?: number;
}
/** One child's canonical outcome. One entry per child, never fewer than the fan-out width. */
export interface PanelChildOutcome {
    /** Position in this fan-out, 0-based. `plans[index]` is the resolution this child ran on. */
    readonly index: number;
    /** The resolution's `routeIndex`, or `-1` when it inherited (or had none). */
    readonly routeIndex: number;
    /** True when this child inherited the parent's route and sent no `agentOptions`. */
    readonly inherited: boolean;
    /** `inherits parent`, or `provider/model`. The one field a human reads first. */
    readonly route: string;
    /** `''` when inherited. */
    readonly routeProvider: string;
    /** `''` when inherited. */
    readonly routeModel: string;
    /** `''` when no effort was sent. */
    readonly routeEffort: string;
    /** The resolver's reason for this entry, verbatim (may start with `unavailable:`). */
    readonly reason: string;
    /** `error` when the child failed to start, or settled with a diagnostic / `stopReason: error`. */
    readonly status: 'ok' | 'error';
    /** `''` when the child never started. */
    readonly childId: string;
    /** `''` when there is no result. */
    readonly stopReason: string;
    /** The child's final assistant text, joined. `''` when it produced none. */
    readonly output: string;
    /** The failure detail, or `''`. Never empty for a `status: error` child. */
    readonly diagnostic: string;
}
/**
 * The canonical value `execute` returns; `PANEL_VALUE_SCHEMA` describes exactly this shape.
 *
 * Flat scalars plus one array of objects, fully required, `additionalProperties: false`
 * everywhere: the enforced subset validates this value against the schema on every return
 * (`dsh-tools/lib/index.js:3417`), so an extra key is a runtime error, not a silent addition.
 */
export interface PanelOutcome {
    readonly role: string;
    /** Children attempted: the route list's length, or `count` for an inheriting panel. */
    readonly width: number;
    /** Children whose start succeeded (they have a `childId` unless the provider returned none). */
    readonly started: number;
    /** Children with `status: ok`. */
    readonly succeeded: number;
    /** `width - succeeded`. Every failed child is named in {@link children} and in {@link failureIndices}. */
    readonly failed: number;
    /** The indices that failed, in order. Empty when the panel is clean. */
    readonly failureIndices: readonly number[];
    /** True when every child inherited the parent's route (no mapping was applied at all). */
    readonly allInherited: boolean;
    /** Distinct `provider/model` routes among the children. `0` when every child inherited. */
    readonly distinctRoutes: number;
    /** The honest sentence: weaker panels say they are weaker. See the file comment. */
    readonly note: string;
    /** One entry per child, in fan-out order. */
    readonly children: readonly PanelChildOutcome[];
}
interface PstackSpawnPanelToolOptions {
    /** Role -> panel-entry resolution. Injected, so the tool is testable with no Host. */
    readonly panelResolver: PanelResolverLike;
    /** The subagent runtime, taken from `ctx.subagents`. */
    readonly subagents: SubagentServiceLike;
    /** Provider name to start children on. Defaults to `SPAWN_PROVIDER_NAME`, via `pstack_spawn`. */
    readonly providerName?: string;
    /** The same assignment sink `pstack_spawn` uses, so panel children route effort like any other. */
    readonly assignments?: RoleAssignmentSink;
}
/**
 * A role that is not a panel role. Thrown, not returned: a refusal is not a panel of width 1.
 *
 * Carries the role and the panel roles as fields as well as in the message, so a caller (or a
 * test) can act on the refusal without parsing prose.
 */
export declare class PanelRoleError extends Error {
    readonly role: string;
    readonly panelRoles: readonly string[];
    constructor(role: string, panelRoles: readonly string[]);
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
export declare const PSTACK_SPAWN_PANEL_PARAMETERS: Readonly<Record<string, unknown>>;
/** The canonical value's schema, in the enforced subset (`assertSupportedJsonSchema`). */
export declare const PANEL_VALUE_SCHEMA: Readonly<Record<string, unknown>>;
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
export declare function parsePanelArgs(raw: unknown): PanelArgs;
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
export declare function panelNote(options: {
    readonly width: number;
    readonly allInherited: boolean;
    readonly distinctRoutes: number;
    /** `provider/model` of the single distinct route, when there is exactly one. */
    readonly onlyRoute?: string | undefined;
    /** Set when the caller passed `count` for a role whose route list set the width itself. */
    readonly ignoredCount?: number | undefined;
}): string;
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
export declare function createPstackSpawnPanelTool(options: PstackSpawnPanelToolOptions): ToolDefinitionLike;
export {};
