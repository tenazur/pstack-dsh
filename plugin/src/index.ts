/**
 * dsh-pstack — the DSH half of pstack.
 *
 * The methodology (playbooks, principles, poteto-mode) is upstream's, from
 * cursor/plugins pstack/. This package supplies only the harness call layer:
 * how a role becomes a spawn, how a route and reasoning effort are applied, and
 * how the user picks them.
 *
 * STATUS: Phase 4. `apply()` registers one skill provider (the bundled `skills/` tree), the
 * `pstack_status` diagnostic, and `pstack_spawn` — the tool that makes role routing real — and
 * subscribes the per-role effort listener to the `agent/request` waterfall. On a web composition
 * it also registers `GET`/`PUT /api/pstack/overlay` (`src/settings/http.ts`), the data route
 * behind the `settings.section` page whose browser half builds to `lib/client.js`. Nothing here is
 * silently stubbed: a stub that returns undefined is how a boot check passes while nothing works.
 *
 * The context and registry types are declared structurally in `skills/provider.ts`,
 * `tools/status.ts`, `tools/spawn.ts`, `effort.ts` and `roles/*` rather than imported from
 * `@deepseek-ai/dsh-*`, because this package must typecheck, test and install with no dependencies
 * at all. The real Host passes its own context, which is a superset, and the boot itself is the
 * check on the copy.
 */
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { createBundledSkillProvider, PSTACK_SKILL_PROVIDER } from './skills/provider.ts'
import type { SkillProvider, SkillProviderControl } from './skills/provider.ts'
import { createPstackStatusTool } from './tools/status.ts'
import type { ToolDefinitionLike } from './tools/status.ts'
import { createPstackSpawnTool, SPAWN_PROVIDER_NAME } from './tools/spawn.ts'
import type { RoleResolverLike, SubagentServiceLike } from './tools/spawn.ts'
import { createPanelResolver, createPstackSpawnPanelTool } from './tools/spawn-panel.ts'
import type { PanelResolverLike } from './tools/spawn-panel.ts'
import { createEffortListener, createRoleAssignments, EFFORT_WATERFALL_EVENT } from './effort.ts'
import type { AgentRequestListener, LlmCallConfigLike } from './effort.ts'
import { createRoleResolver, loadOverlayFile } from './roles/resolver.ts'
import type { RoleResolver } from './roles/resolver.ts'
import type { OverlayFile } from './roles/overlay.ts'
import type { LlmCatalogLike, RouteCatalog } from './roles/catalog.ts'
import { OVERLAY_ROUTE_PATH, readSettingsNamespace, registerOverlayRoute } from './settings/http.ts'
import { FLEET_ROUTE_PATH, registerFleetRoute } from './settings/fleet-http.ts'
import type { FleetHttpSources } from './settings/fleet-http.ts'
import type { SessionDefaultRoute } from './roles/fleet-groups.ts'
import type { OverlayHttpSources, SettingsLike, WebServerLike } from './settings/http.ts'

/**
 * Phase 4's role data layer, re-exported so the spawn tool (and Phase 5's menu) import from the
 * package entry rather than reaching into `src/roles/`. `plugin/src/roles/**` is the one writer's
 * scope; these names are the fixed interface the parallel spawn-tool unit codes against.
 */
import { enumerateRoutes, findRoute, unavailableReason } from './roles/catalog.ts'
export { enumerateRoutes, findRoute, unavailableReason }
export type {
  LlmCatalogLike,
  LlmModelInfoLike,
  LlmProviderInfoLike,
  LlmResolvedModelInfoLike,
  ResolvedRole,
  RoleRoute,
  RouteCatalog,
  RouteEnumerationOptions,
  UsableRoute,
} from './roles/catalog.ts'
export {
  BUILT_IN_MODEL_NAMES,
  builtInModel,
  canonicalRole,
  describeRoute,
  INHERIT_PARENT_MODEL,
  isBuiltInModelName,
  isPanelRole,
  namedModelAssignment,
  normaliseRoleKey,
  overlayVersionNote,
  PANEL_ROLES,
  parseOverlay,
  resolvePanel,
  resolveRole,
  ROLE_KEYS,
  routeLabel,
  serializeOverlay,
  SPAWN_ROLE_VALUES,
  UNAVAILABLE_REASON_PREFIX,
} from './roles/overlay.ts'
export type {
  BuiltInModelName,
  OverlayFile,
  OverlayFileV1,
  OverlayFileV2,
  OverlayModel,
  OverlayModelRoute,
  OverlayRoleEntry,
  ParseOverlayResult,
  RouteHonour,
  WritableOverlayFile,
} from './roles/overlay.ts'
export { createRoleResolver, loadOverlayFile } from './roles/resolver.ts'
export type { LoadOverlayResult, RoleResolver, RoleResolverSources } from './roles/resolver.ts'

/**
 * Phase 4's settings-page host half: the HTTP route the page reads and writes through.
 * `plugin/src/settings/http.ts` is the only writer of that path; these names are re-exported so
 * the page's tests and any future surface import from the package entry.
 */
export {
  buildOverlayView,
  createOverlayRoute,
  handleOverlayGet,
  MAX_OVERLAY_BODY_BYTES,
  MODEL_SELECTION_NAMESPACE,
  OVERLAY_DIR_MODE,
  OVERLAY_FILE_MODE,
  OVERLAY_ROUTE_PATH,
  readBody,
  readModelSelection,
  registerOverlayRoute,
  validateOverlayAgainstCatalog,
  writeTextAtomic,
} from './settings/http.ts'
export type {
  HttpRequestLike,
  HttpResult,
  HttpResponseLike,
  ModelSelectionView,
  NamedModelRouteView,
  NamedModelView,
  OverlayHttpSources,
  OverlayLoad,
  OverlayView,
  TaskModelView,
  TaskView,
  WebRouteLike,
  WebServerLike,
} from './settings/http.ts'

/**
 * The violin page's host half: the groups file, and the overlay derived from it.
 *
 * `plugin/src/settings/fleet-http.ts` owns every write; the overlay route above is read-only
 * because a write to the projection alone would be reverted by the next reconciliation.
 */
export {
  createFleetRoute,
  FLEET_ROUTE_PATH,
  GROUPS_FILE_MODE,
  handleFleetGet,
  handleFleetPut,
  MAX_FLEET_BODY_BYTES,
  registerFleetRoute,
} from './settings/fleet-http.ts'
export type { FleetHttpSources, FleetOrigin, FleetView } from './settings/fleet-http.ts'
export {
  defaultGroups,
  fromOverlay,
  isComparisonViolinId,
  isPredefinedViolinId,
  parseFleetGroups,
  PREDEFINED_VIOLIN_IDS,
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
} from './roles/fleet-groups.ts'
export type {
  DefaultGroupsOptions,
  FleetGroupsFile,
  ParseGroupsResult,
  PredefinedViolinId,
  SessionDefaultRoute,
  Violin,
  ViolinOrigin,
  ViolinSelection,
} from './roles/fleet-groups.ts'

export const name = 'pstack'

/** Boot marker. Deliberately a stable literal so a check can grep the source and the log. */
export const BOOT_MARKER = '[dsh-pstack] loaded'

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
 * probe registered exactly that way — `scratch/p1-effort-path/plugin-effort-probe/index.js`).
 */
export const inject = ['skills', 'tools', 'subagents', 'llm']

/** The slice of the DSH plugin context this package uses. */
export interface PluginContext {
  readonly logger?: PluginLogger
  readonly skills: SkillRegistryLike
  readonly tools: ToolRegistryLike
  /** The subagent runtime, for `pstack_spawn`. */
  readonly subagents: SubagentServiceLike
  /**
   * Route inventory service (`ctx.llm`).
   *
   * Prepared by the role-catalog unit as optional, while `apply()` did not read it; the
   * integration promotes it to required, because {@link inject} now names `llm` and Cordis
   * therefore guarantees it. An optional field here would only move the absence to a `ctx.llm!` at
   * every use site — a runtime `undefined` if the injection were ever wrong, instead of a compiler
   * error.
   */
  readonly llm: LlmCatalogLike
  /**
   * The settings service, read through {@link optionalSettings} rather than off this field.
   *
   * Declared **optional** on purpose, and not named in {@link inject}: it seeds the `general` violin
   * from the session's default model, and a composition without it falls back to the catalog's first
   * route. A `ctx.settings` read on an undeclared service is a Cordis throw, which is why the
   * accessor exists and why this field is not the path anything takes.
   */
  readonly settings?: SettingsLike | undefined
  /** Cordis event registration. An untagged listener is global, which is what we want. */
  readonly on: (event: typeof EFFORT_WATERFALL_EVENT, listener: AgentRequestListener) => () => void
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
  readonly inject?: (deps: readonly string[], callback: (ctx: PluginContext) => void) => unknown
  /**
   * Read one service without Cordis's activation gate (`ctx.get`). Used inside the
   * {@link inject} callback, where the service is guaranteed by construction.
   */
  readonly get?: (name: string) => unknown
  /**
   * Bind a disposable side effect to this plugin's lifecycle (`ctx.effect`). The route
   * registration is wired through it so unloading the plugin removes the route
   * (`dsh-usage-stats/lib/index.js:474` does the same).
   */
  readonly effect?: (callback: () => (() => void) | void) => unknown
}

/** The registry half of `SkillRegistry` (`dsh-skill/lib/types/index.d.ts:249`). */
interface SkillRegistryLike {
  registerProvider: (create: (control: SkillProviderControl) => SkillProvider) => () => void
}

/** The registration half of `ToolRuntime` (`dsh-tools/lib/index.js:2773`). */
interface ToolRegistryLike {
  register: (definition: ToolDefinitionLike) => () => void
}

/** The logger surface used here; `ctx.logger` in Cordis is `LoggerService`. */
interface PluginLogger {
  info?: (message: string) => void
  warn?: (message: string) => void
}

export interface Config {
  /** Overlay file for role -> route mapping. Defaults to $DSH_HOME/pstack.json. */
  overlayPath?: string
  /** Fleet groups file the violin page edits. Defaults to $DSH_HOME/pstack-fleet.json. */
  groupsPath?: string
  /** Register the bundled SKILL.md set. Off only for an isolated test. */
  registerSkills?: boolean
  /** Bundled skill root. Defaults to `<package root>/skills`. */
  skillsDir?: string
  /**
   * Role resolver override. Production leaves this unset and `apply()` builds the live one through
   * `createRoleResolver` (`roles/resolver.ts`); a test injects a fake so no Host is needed.
   */
  resolver?: RoleResolverLike
  /**
   * Panel resolution override for `pstack_spawn_panel`. Production leaves this unset, so the
   * panel resolves through the production catalog and a fresh overlay read; a test injects a
   * fake so no Host is needed.
   */
  panelResolver?: PanelResolverLike
  /**
   * Register the settings page's HTTP route. On by default; a test that only wants the tool
   * registrations turns it off rather than faking a web server.
   */
  registerHttp?: boolean
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const overlayPath = config.overlayPath ?? defaultOverlayPath()
  const groupsPath = config.groupsPath ?? defaultGroupsPath()
  const skillsDir = config.skillsDir ?? defaultSkillsDir()
  const registerSkills = config.registerSkills !== false
  const registerHttp = config.registerHttp !== false

  if (registerSkills) {
    ctx.skills.registerProvider((control) =>
      createBundledSkillProvider({
        skillsDir,
        control,
        ...(ctx.logger === undefined ? {} : { logger: ctx.logger }),
      }),
    )
  }

  const statusTool = createPstackStatusTool({ bootMarker: BOOT_MARKER, overlayPath, groupsPath, skillsDir, pluginName: name })
  ctx.tools.register(statusTool)

  // One assignment store, shared by the tool that records which role a child runs and the listener
  // that applies that role's effort. Two instances would be a silent no-op, which is why exactly
  // one is created here and handed to both.
  const assignments = createRoleAssignments()
  // Hoisted rather than inlined twice: the single-child resolver and the panel resolver read the
  // same file by the same rule, and two copies of that rule drift. Re-read per resolve rather than
  // cached, because this is a file a person hand-edits (`roles/resolver.ts:9-14`). An unusable file
  // is reported and then treated as absent, which is the one-route behaviour `plugin/HARNESS.md`
  // §Rules 3 asks for.
  const readOverlay = async (): Promise<OverlayFile | undefined> => {
    const loaded = await loadOverlayFile(overlayPath)
    if (!loaded.ok) {
      ctx.logger?.warn?.(`pstack: ${loaded.error}; every role inherits the parent's route`)
      return undefined
    }
    return loaded.value
  }
  const resolver =
    config.resolver ??
    createRoleResolver({
      llm: ctx.llm,
      readOverlay,
    })
  const spawnTool = createPstackSpawnTool({ resolver, subagents: ctx.subagents, assignments })
  ctx.tools.register(spawnTool)

  // Phase 5: the panel tool — one child per route entry of a panel role. It resolves through
  // `resolvePanel`, which needs the enumerated catalog, so it borrows the production resolver's
  // `catalog()` and the same overlay read above.
  const catalogForPanel = (): Promise<RouteCatalog> => {
    const full = resolver as Partial<RoleResolver>
    if (typeof full.catalog !== 'function') {
      return Promise.reject(
        new Error('the injected role resolver cannot enumerate a catalog, so a panel cannot be resolved'),
      )
    }
    return full.catalog()
  }
  const panelResolver =
    config.panelResolver ?? createPanelResolver({ catalog: catalogForPanel, readOverlay })
  const spawnPanelTool = createPstackSpawnPanelTool({
    panelResolver,
    subagents: ctx.subagents,
    assignments,
  })
  ctx.tools.register(spawnPanelTool)

  // The effort half. Outermost by construction: this listener is registered at boot, so every
  // listener the Host adds later is inner to it. See `effort.ts` §"Why await next() comes first"
  // for why that ordering is defensive rather than mandatory on the headless surface.
  ctx.on(
    EFFORT_WATERFALL_EVENT,
    createEffortListener({
      assignments,
      advertisedEfforts: createAdvertisedEffortLookup({
        llm: ctx.llm,
        ...(ctx.logger === undefined ? {} : { logger: ctx.logger }),
      }),
      ...(ctx.logger === undefined ? {} : { logger: ctx.logger }),
    }),
  )

  // The settings page's data route. Registered before the marker line so its intended path can be
  // named there; the registration itself runs when `webServer` is provided, which may be later.
  const httpRoute = registerHttp ? `${OVERLAY_ROUTE_PATH},${FLEET_ROUTE_PATH}` : 'none'
  registerSettingsHttp({ ctx, overlayPath, groupsPath, resolver, enabled: registerHttp })

  // One line, after every registration: the marker says this plugin ran, and the fields say what it
  // registered, so a Host log with this line is evidence and not just a heartbeat.
  ctx.logger?.info?.(
    `${BOOT_MARKER} overlay=${overlayPath} skillProvider=${registerSkills ? PSTACK_SKILL_PROVIDER : 'none'} ` +
      `tool=${statusTool.name} spawn=${spawnTool.name} spawnPanel=${spawnPanelTool.name} ` +
      `spawnProvider=${SPAWN_PROVIDER_NAME} ` +
      `effortListener=${EFFORT_WATERFALL_EVENT} httpRoute=${httpRoute} skillsDir=${skillsDir}`,
  )
}

/**
 * Register the settings page's data route, when this composition has a web server.
 *
 * `webServer` is a web-plane-only service, so it is requested through `ctx.inject`'s optional form
 * rather than named in {@link inject}; see {@link PluginContext.inject}. A headless profile simply
 * never runs the callback, which is the honest outcome: no HTTP surface, no page.
 *
 * @param options - the context, the overlay path of record, the resolver and the kill switch.
 */
function registerSettingsHttp(options: {
  readonly ctx: PluginContext
  readonly overlayPath: string
  readonly resolver: RoleResolverLike
  readonly groupsPath: string
  readonly enabled: boolean
}): void {
  const { ctx, overlayPath, groupsPath, resolver, enabled } = options
  if (!enabled || typeof ctx.inject !== 'function') return

  // One catalog accessor for both routes: the resolver caches, `refresh` is the page's "read it
  // again" and every write's mandatory re-read. An injected test resolver may not enumerate at all,
  // which is reported as a 500 rather than as an empty catalog.
  const catalog = (refresh?: boolean): Promise<RouteCatalog> => {
    const full = resolver as Partial<RoleResolver>
    if (typeof full.catalog !== 'function') {
      return Promise.reject(new Error('the injected role resolver cannot enumerate a catalog'))
    }
    return refresh === true && typeof full.refresh === 'function' ? full.refresh() : full.catalog()
  }

  const sources: OverlayHttpSources = {
    overlayPath,
    loadOverlay: () => loadOverlayFile(overlayPath),
    readOverlayText: async () => {
      try {
        return await readFile(overlayPath, 'utf8')
      } catch {
        // No file, or unreadable: the page starts from an empty overlay rather than a lie.
        return null
      }
    },
    catalog,
    ...(optionalSettings(ctx) === undefined ? {} : { settings: optionalSettings(ctx) }),
    ...(ctx.logger === undefined ? {} : { logger: ctx.logger }),
  }

  const fleetSources: FleetHttpSources = {
    groupsPath,
    overlayPath,
    catalog,
    // `general` defaults to the route this session itself runs, when the settings say so. Read per
    // call rather than cached: a person can change their default model while the page is open.
    sessionDefault: () => readSessionDefault(optionalSettings(ctx)),
    ...(optionalSettings(ctx) === undefined ? {} : { settings: optionalSettings(ctx)! }),
    ...(ctx.logger === undefined ? {} : { logger: ctx.logger }),
  }

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get?.('webServer') as WebServerLike | undefined
    if (webServer === undefined) {
      ctx.logger?.warn?.(
        'pstack: webServer is provided but could not be read; the settings page has no data route',
      )
      return
    }
    const register = (): (() => void) => {
      const disposeOverlay = registerOverlayRoute(webServer, sources)
      const disposeFleet = registerFleetRoute(webServer, fleetSources)
      return () => {
        disposeOverlay()
        disposeFleet()
      }
    }
    if (typeof ctx.effect === 'function') ctx.effect(register)
    else register()
    ctx.logger?.info?.(
      `${BOOT_MARKER} http registered paths=${OVERLAY_ROUTE_PATH},${FLEET_ROUTE_PATH} overlay=${overlayPath} groups=${groupsPath}`,
    )
  })
}

/**
 * Build the effort listener's advertised-effort lookup out of `ctx.llm`.
 *
 * `resolveModelInfo(provider, model).reasoning.efforts` is the authority
 * (`dsh-llm/lib/index.js:2043-2049`; `LlmModelReasoningInfo.efforts`
 * `dsh-llm/lib/types/types.d.ts:304-312`). Memoized per exact route, because the waterfall fires
 * on every turn of every agent.
 *
 * A lookup failure returns `undefined`, which the listener reads as "unknown" and does **not**
 * treat as a refusal: resolution already gated the effort against the same catalog, and turning a
 * transient llm error into "silently stop routing effort" is exactly the failure mode this unit
 * exists to avoid.
 *
 * @param options - the llm face and a warn sink.
 * @returns the `advertisedEfforts` callback for {@link createEffortListener}.
 */
function createAdvertisedEffortLookup(options: {
  readonly llm: LlmCatalogLike
  readonly logger?: PluginLogger
}): (config: LlmCallConfigLike, signal: AbortSignal | undefined) => Promise<readonly string[] | undefined> {
  const cache = new Map<string, readonly string[]>()
  return async (config, signal) => {
    const provider = config.provider
    const model = config.model
    if (typeof provider !== 'string' || typeof model !== 'string') return undefined
    const key = `${provider}/${model}`
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    try {
      const info = await options.llm.resolveModelInfo(provider, model, signal)
      const efforts: string[] = []
      for (const effort of info.reasoning?.efforts ?? []) {
        if (typeof effort.id === 'string' && effort.id.length > 0) efforts.push(effort.id)
      }
      cache.set(key, efforts)
      return efforts
    } catch (error) {
      options.logger?.warn?.(
        `pstack: could not read advertised efforts for ${key} (${String(error)}); leaving this child's effort unchanged`,
      )
      return undefined
    }
  }
}

/**
 * $DSH_HOME, else ~/.dsh.
 * Kept local and dependency-free; see HARNESS.md.
 */
export function defaultOverlayPath(): string {
  const home = process.env.DSH_HOME ?? `${process.env.HOME ?? ''}/.dsh`
  return `${home}/pstack.json`
}

/**
 * `ctx.settings`, read without Cordis's activation gate.
 *
 * `settings` is deliberately **not** in {@link inject}: it is consulted only to seed the `general`
 * violin from the session's default model, and the defaults fall back to the catalog's first route
 * when it is absent. Naming it in `inject` would make a cosmetic default a reason for the whole
 * plugin to be held inactive.
 *
 * That has a consequence the obvious `ctx.settings` field read does not survive: Cordis throws
 * `cannot get property "settings" without inject` (`cordis/lib/index.js`), so an undeclared service
 * must go through `ctx.get(name)`. The route gate caught exactly this — the plugin failed to
 * activate and the Host never answered.
 *
 * @param ctx - the plugin context.
 * @returns the settings face, or `undefined` when this composition has none.
 */
function optionalSettings(ctx: PluginContext): SettingsLike | undefined {
  const read = ctx.get?.('settings')
  return read as SettingsLike | undefined
}

/**
 * The session's own default route, as `agent-default-model` holds it.
 *
 * Read only to seed `general` in {@link defaultGroupsPath}'s file, and only when the settings
 * service answers with the three strings in the shape the DSH row uses. Anything else — no
 * namespace, a different shape, a value this build cannot read — answers `undefined`, which makes
 * the defaults fall back to the catalog's first route rather than inventing one.
 * @param settings - `ctx.settings`, when the composition has one.
 * @returns the route, or `undefined`.
 */
function readSessionDefault(settings: SettingsLike | undefined): SessionDefaultRoute | undefined {
  if (settings === undefined) return undefined
  // Through `describe()`, the only settings read on this API; `settings.get` does not exist, which
  // made this read silently answer `undefined` for every install. See `roles/catalog.ts`
  // §"There is no `settings.get`".
  const value = readSettingsNamespace(settings, 'agent-default-model')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const provider = record['provider']
  const model = record['model']
  const effort = record['reasoningEffort']
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return {
    provider,
    model,
    ...(typeof effort === 'string' && effort.length > 0 ? { reasoningEffort: effort } : {}),
  }
}

/**
 * The fleet groups file: the violin page's source of truth, beside the overlay it projects.
 * A second file rather than a second shape in the first one, because the overlay is read by the
 * spawn path on every resolve and must stay the small, stable document it is.
 */
export function defaultGroupsPath(): string {
  const home = process.env.DSH_HOME ?? `${process.env.HOME ?? ''}/.dsh`
  return `${home}/pstack-fleet.json`
}

/**
 * `<package root>/skills`, resolved from this module rather than from `process.cwd()`.
 * The built entry lives at `<package root>/lib/index.js`, and the sources at
 * `<package root>/src/index.ts`, so `..` is the package root in both cases — which is what
 * keeps the tests (running the sources) and a Host (running `lib/`) scanning the same tree.
 */
export function defaultSkillsDir(): string {
  return fileURLToPath(new URL('../skills/', import.meta.url))
}
