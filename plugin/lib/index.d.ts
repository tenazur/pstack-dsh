import type { SkillProvider, SkillProviderControl } from './skills/provider.ts';
import type { ToolDefinitionLike } from './tools/status.ts';
import type { RoleResolverLike, SubagentServiceLike } from './tools/spawn.ts';
import type { PanelResolverLike } from './tools/spawn-panel.ts';
import { EFFORT_WATERFALL_EVENT } from './effort.ts';
import type { AgentRequestListener } from './effort.ts';
import type { LlmCatalogLike } from './roles/catalog.ts';
import type { SettingsLike } from './settings/http.ts';
/**
 * Phase 4's role data layer, re-exported so the spawn tool (and Phase 5's menu) import from the
 * package entry rather than reaching into `src/roles/`. `plugin/src/roles/**` is the one writer's
 * scope; these names are the fixed interface the parallel spawn-tool unit codes against.
 */
import { enumerateRoutes, findRoute, unavailableReason } from './roles/catalog.ts';
export { enumerateRoutes, findRoute, unavailableReason };
export type { LlmCatalogLike, LlmModelInfoLike, LlmProviderInfoLike, LlmResolvedModelInfoLike, ResolvedRole, RoleRoute, RouteCatalog, RouteEnumerationOptions, UsableRoute, } from './roles/catalog.ts';
export { BUILT_IN_MODEL_NAMES, builtInModel, canonicalRole, describeRoute, INHERIT_PARENT_MODEL, isBuiltInModelName, isPanelRole, namedModelAssignment, normaliseRoleKey, overlayVersionNote, PANEL_ROLES, parseOverlay, resolvePanel, resolveRole, ROLE_KEYS, routeLabel, serializeOverlay, SPAWN_ROLE_VALUES, UNAVAILABLE_REASON_PREFIX, } from './roles/overlay.ts';
export type { BuiltInModelName, OverlayFile, OverlayFileV1, OverlayFileV2, OverlayModel, OverlayModelRoute, OverlayRoleEntry, ParseOverlayResult, RouteHonour, WritableOverlayFile, } from './roles/overlay.ts';
export { createRoleResolver, loadOverlayFile } from './roles/resolver.ts';
export type { LoadOverlayResult, RoleResolver, RoleResolverSources } from './roles/resolver.ts';
/**
 * Phase 4's settings-page host half: the HTTP route the page reads and writes through.
 * `plugin/src/settings/http.ts` is the only writer of that path; these names are re-exported so
 * the page's tests and any future surface import from the package entry.
 */
export { buildOverlayView, createOverlayRoute, handleOverlayGet, MAX_OVERLAY_BODY_BYTES, MODEL_SELECTION_NAMESPACE, OVERLAY_DIR_MODE, OVERLAY_FILE_MODE, OVERLAY_ROUTE_PATH, readBody, readModelSelection, registerOverlayRoute, validateOverlayAgainstCatalog, writeTextAtomic, } from './settings/http.ts';
export type { HttpRequestLike, HttpResult, HttpResponseLike, ModelSelectionView, NamedModelRouteView, NamedModelView, OverlayHttpSources, OverlayLoad, OverlayView, TaskModelView, TaskView, WebRouteLike, WebServerLike, } from './settings/http.ts';
/**
 * The violin page's host half: the groups file, and the overlay derived from it.
 *
 * `plugin/src/settings/fleet-http.ts` owns every write; the overlay route above is read-only
 * because a write to the projection alone would be reverted by the next reconciliation.
 */
export { createFleetRoute, FLEET_ROUTE_PATH, GROUPS_FILE_MODE, handleFleetGet, handleFleetPut, MAX_FLEET_BODY_BYTES, registerFleetRoute, } from './settings/fleet-http.ts';
export type { FleetHttpSources, FleetOrigin, FleetView } from './settings/fleet-http.ts';
export { defaultGroups, fromOverlay, isComparisonViolinId, isPredefinedViolinId, parseFleetGroups, PREDEFINED_VIOLIN_IDS, repairedGroups, serializeFleetGroups, slugifyViolinId, toOverlay, unassignedTasks, violinModelNames, violinOfTask, violinProblems, withSelections, withTask, withViolin, withViolinName, withoutTask, withoutViolin, } from './roles/fleet-groups.ts';
export type { DefaultGroupsOptions, FleetGroupsFile, ParseGroupsResult, PredefinedViolinId, SessionDefaultRoute, Violin, ViolinOrigin, ViolinSelection, } from './roles/fleet-groups.ts';
export declare const name = "pstack";
/** Boot marker. Deliberately a stable literal so a check can grep the source and the log. */
export declare const BOOT_MARKER = "[dsh-pstack] loaded";
/**
 * Services `apply()` registers on, and nothing else.
 *
 * Declared as required injections, which is how every first-party plugin declares them
 * (`dsh-skill-filesystem/lib/index.js:30` `inject = ["skills"]`,
 * `dsh-tool-subagent/lib/index.js:246-252`
 * `inject = ["tools","subagents","systemPrompt","sessionProjections"]`): Cordis reads the array
 * off the plugin module (`cordis/lib/index.js:1635`, `Inject.resolve` `:1491`) and holds the plugin
 * inactive until every one is provided. Reaching for them with `ctx.get()` instead would silently
 * register nothing when this plugin happens to apply first — and activation order is not bundle
 * order, which is the failure mode this rule exists to end.
 *
 * Why each name is here. One name too many is a way for the plugin to be held inactive, so none of
 * these is speculative:
 *
 * - `skills` — the bundled skill provider.
 * - `tools` — `pstack_status` and `pstack_spawn`.
 * - `subagents` — `ctx.subagents.start`, the spawn tool's only side effect
 *   (`dsh-subagent/lib/types/index.d.ts:296`).
 * - `llm` — `enumerateRoutes` reads `listProviders`/`listModels`/`resolveModelInfo`, and the
 *   effort listener's advertised-effort gate reads `resolveModelInfo`
 *   (`dsh-llm/lib/types/index.d.ts:267`, `:344`, `:354`).
 *
 * `credentials` and `settings` were named here until 2026-10-13, for a credential gate that resolved
 * each provider's declared `apiKeyEnv` through a guessed settings namespace. That gate is gone (see
 * `roles/catalog.ts` §"What enumerated means here"), so both names went with it. Dropping them is
 * not merely tidiness: every name here is a service Cordis waits for, so a name the composition
 * does not provide holds the whole plugin inactive. Fewer names, fewer ways to be dead.
 *
 * `settings` is still **read**, but not through this array: {@link PluginContext.settings} is
 * consulted only to seed the `general` violin from the session's default model, and its absence is
 * handled (the defaults fall back to the catalog's first route). Making it required would be a way
 * to be held inactive for a cosmetic default.
 *
 * The effort listener adds **no** name: it touches only `ctx.on('agent/request', …)`, and an
 * untagged listener is global without any service behind it (`dsh-scope/README.md`; the Phase 1
 * probe registered exactly that way, and `tests/effort.spec.ts` reproduces it.)
 */
export declare const inject: string[];
/** The slice of the DSH plugin context this package uses. */
export interface PluginContext {
    readonly logger?: PluginLogger;
    readonly skills: SkillRegistryLike;
    readonly tools: ToolRegistryLike;
    /** The subagent runtime, for `pstack_spawn`. */
    readonly subagents: SubagentServiceLike;
    /**
     * Route inventory service (`ctx.llm`).
     *
     * Prepared by the role-catalog unit as optional, while `apply()` did not read it; the
     * integration promotes it to required, because {@link inject} now names `llm` and Cordis
     * therefore guarantees it. An optional field here would only move the absence to a `ctx.llm!` at
     * every use site — a runtime `undefined` if the injection were ever wrong, instead of a compiler
     * error.
     */
    readonly llm: LlmCatalogLike;
    /**
     * The settings service, read through {@link optionalSettings} rather than off this field.
     *
     * Declared **optional** on purpose, and not named in {@link inject}: it seeds the `general` violin
     * from the session's default model, and a composition without it falls back to the catalog's first
     * route. A `ctx.settings` read on an undeclared service is a Cordis throw, which is why the
     * accessor exists and why this field is not the path anything takes.
     */
    readonly settings?: SettingsLike | undefined;
    /** Cordis event registration. An untagged listener is global, which is what we want. */
    readonly on: (event: typeof EFFORT_WATERFALL_EVENT, listener: AgentRequestListener) => () => void;
    /**
     * Cordis's optional-dependency form (`cordis/lib/types/registry.d.ts:181`): the callback runs
     * when every named service is provided, and the plugin is **not** held inactive meanwhile.
     *
     * This is how the settings page's `webServer` route is registered. `webServer` cannot go into
     * {@link inject} — that array is the *required* list, and naming a web-only service there would
     * hold the whole plugin, spawn tool included, inactive on every headless profile. Reading it
     * with `ctx.get('webServer')` inside `apply()` would be the other failure mode
     * (`src/index.ts`'s `inject` comment): whichever of the two plugins loads first silently wins.
     * Optional here because a unit test's fake context may provide neither.
     */
    readonly inject?: (deps: readonly string[], callback: (ctx: PluginContext) => void) => unknown;
    /**
     * Read one service without Cordis's activation gate (`ctx.get`). Used inside the
     * {@link inject} callback, where the service is guaranteed by construction.
     */
    readonly get?: (name: string) => unknown;
    /**
     * Bind a disposable side effect to this plugin's lifecycle (`ctx.effect`). The route
     * registration is wired through it so unloading the plugin removes the route
     * (`dsh-usage-stats/lib/index.js:474` does the same).
     */
    readonly effect?: (callback: () => (() => void) | void) => unknown;
}
/** The registry half of `SkillRegistry` (`dsh-skill/lib/types/index.d.ts:249`). */
interface SkillRegistryLike {
    registerProvider: (create: (control: SkillProviderControl) => SkillProvider) => () => void;
}
/** The registration half of `ToolRuntime` (`dsh-tools/lib/index.js:2773`). */
interface ToolRegistryLike {
    register: (definition: ToolDefinitionLike) => () => void;
}
/** The logger surface used here; `ctx.logger` in Cordis is `LoggerService`. */
interface PluginLogger {
    info?: (message: string) => void;
    warn?: (message: string) => void;
}
export interface Config {
    /** Overlay file for role -> route mapping. Defaults to $DSH_HOME/pstack.json. */
    overlayPath?: string;
    /** Fleet groups file the violin page edits. Defaults to $DSH_HOME/pstack-fleet.json. */
    groupsPath?: string;
    /** Register the bundled SKILL.md set. Off only for an isolated test. */
    registerSkills?: boolean;
    /** Bundled skill root. Defaults to `<package root>/skills`. */
    skillsDir?: string;
    /**
     * Role resolver override. Production leaves this unset and `apply()` builds the live one through
     * `createRoleResolver` (`roles/resolver.ts`); a test injects a fake so no Host is needed.
     */
    resolver?: RoleResolverLike;
    /**
     * Panel resolution override for `pstack_spawn_panel`. Production leaves this unset, so the
     * panel resolves through the production catalog and a fresh overlay read; a test injects a
     * fake so no Host is needed.
     */
    panelResolver?: PanelResolverLike;
    /**
     * Register the settings page's HTTP route. On by default; a test that only wants the tool
     * registrations turns it off rather than faking a web server.
     */
    registerHttp?: boolean;
}
export declare function apply(ctx: PluginContext, config?: Config): void;
/**
 * $DSH_HOME, else ~/.dsh.
 * Kept local and dependency-free; see HARNESS.md.
 */
export declare function defaultOverlayPath(): string;
/**
 * The fleet groups file: the violin page's source of truth, beside the overlay it projects.
 * A second file rather than a second shape in the first one, because the overlay is read by the
 * spawn path on every resolve and must stay the small, stable document it is.
 */
export declare function defaultGroupsPath(): string;
/**
 * `<package root>/skills`, resolved from this module rather than from `process.cwd()`.
 * The built entry lives at `<package root>/lib/index.js`, and the sources at
 * `<package root>/src/index.ts`, so `..` is the package root in both cases — which is what
 * keeps the tests (running the sources) and a Host (running `lib/`) scanning the same tree.
 */
export declare function defaultSkillsDir(): string;
