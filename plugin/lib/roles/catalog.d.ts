/**
 * The live route inventory: what this DSH install currently has registered.
 *
 * The catalog is the source of truth for what a role can run on. A role menu that names a model
 * slug from memory ships a config that lies, so nothing here is hardcoded: the catalog is enumerated from the running Host
 * through one injected service face, `ctx.llm`.
 *
 * The face is declared structurally instead of imported. This package typechecks, tests and
 * installs with no dependencies at all (`plugin/HARNESS.md` §Rules, and the same choice as
 * `src/skills/provider.ts`), so `LlmCatalogLike` is a copy of the shape the real service exposes,
 * and the boot is the check on the copy:
 *
 * - `listProviders(): LlmProviderInfo[]` — `dsh-llm/lib/types/index.d.ts:267`; each entry is
 *   `{id, name}` only (`dsh-llm/lib/types/types.d.ts:180-185`).
 * - `listModels(provider): Promise<LlmModelInfo[]>` — `:344`; entries carry `{provider, id, name}`
 *   (`types.d.ts:277-288`).
 * - `resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>` — `:354`; the
 *   reasoning block is `{efforts: readonly {id, name}[], defaultEffort?}`
 *   (`types.d.ts:295-312`, `:321-328`). Note `efforts` entries are **objects**, so the ids this
 *   module reports come from `effort.id`, not from the array itself.
 * - `listConfigurableProviders()` — `:281`; `{provider, displayName, settingsNs, settingsPath}`
 *   (`types.d.ts:193-215`). Used only to name a provider an adapter declares but has not
 *   registered. That list is deliberately **not** treated as a route list: on this machine it
 *   omits providers that *are* registered, so treating it as authoritative would hide them.
 *
 * ## What "enumerated" means here, and what it stopped meaning
 *
 * A route in `routes` is one this install has **registered**. It is not a claim that the route can
 * authenticate, and the name was changed from `UsableRoute` internally because that word promised
 * more than this can know: the adapter validates its key at request time, and `resolveModelInfo`'s
 * own doc says catalog membership "is advisory and never changes routing or request validation"
 * (`dsh-llm/lib/types/index.d.ts:339-341`).
 *
 * An earlier version tried to make the stronger claim, by resolving each provider's declared
 * `apiKeyEnv` from a guessed settings namespace and omitting anything that looked unconfigured.
 * That is gone. It cost ~280 lines of name heuristics and a retry ladder, it depended on a
 * settings API DSH has since removed, and when the guess lost it returned an **empty catalog on a
 * correctly configured install** — silently, so every role inherited the parent. Listing what is
 * registered, and letting the adapter report a missing key at spawn time in its own words, is both
 * smaller and more accurate. See `plugin/HARNESS.md` and `enumerateRoutes` below.
 *
 * The one thing still worth reporting is **registration**: a provider an adapter declares but has
 * not registered, and a model whose `resolveModelInfo` throws. Both are the adapter's own words,
 * in `RouteCatalog.unavailable`.
 */
/** One route a role can run on. */
export interface RoleRoute {
    readonly provider: string;
    readonly model: string;
    /** Only an effort id the adapter actually advertises for this route. */
    readonly reasoningEffort?: string;
}
/** A role's resolved target: either a specific route, or the parent. */
export interface ResolvedRole {
    /** kebab-case role key, or one of the three spawn role values. */
    readonly role: string;
    /** true when the role inherits the parent's route. */
    readonly inherit: boolean;
    /** Present when inherit is false. */
    readonly route?: RoleRoute;
    /** Index within a panel role's route list. Absent for scalar roles. */
    readonly routeIndex?: number;
    /** Why this resolution happened, for the menu and the settings page. */
    readonly reason: string;
}
/** Live route inventory. Built from ctx.llm + ctx.credentials; never hardcoded. */
export interface RouteCatalog {
    readonly routes: readonly UsableRoute[];
    /**
     * Providers and models that are **not registered**, with the adapter's own reason. This is a fact
     * about registration, not about credentials: a dormant provider an adapter declares, or a model
     * whose `resolveModelInfo` threw. Nothing here is omitted for want of a credential.
     */
    readonly unavailable: readonly {
        readonly provider: string;
        readonly model?: string;
        readonly why: string;
    }[];
}
export interface UsableRoute {
    readonly provider: string;
    readonly model: string;
    /** From resolveModelInfo(provider, model).reasoning.efforts. */
    readonly efforts: readonly string[];
    readonly defaultEffort?: string;
    /**
     * The adapter's own one-line description of what this model suits, verbatim
     * (`dsh-llm-deepseek/lib/index.js:1849-1860`). Absent when the adapter declares none — the page
     * shows the absence rather than inventing prose, which is why a name with no description reads
     * as "the adapter describes it not at all" and never as a hand-written claim.
     */
    readonly description?: string;
}
/** One registered provider route, as `listProviders()` reports it (`types.d.ts:180-185`). */
export interface LlmProviderInfoLike {
    readonly id: string;
    readonly name: string;
}
/** One model of a provider, as `listModels()` reports it (`types.d.ts:277-288`). */
export interface LlmModelInfoLike {
    readonly provider: string;
    readonly id: string;
    readonly name: string;
}
/** One advertised reasoning effort (`types.d.ts:295-302`). Only `id` is read here. */
interface LlmReasoningEffortInfoLike {
    readonly id: string;
    readonly name: string;
}
/** The resolved-model slice this module reads (`types.d.ts:319-328`). */
export interface LlmResolvedModelInfoLike {
    /** The adapter's own prose about what this model suits; optional in the adapter contract. */
    readonly description?: string;
    readonly reasoning?: {
        readonly efforts: readonly LlmReasoningEffortInfoLike[];
        readonly defaultEffort?: string;
    };
}
/** A provider an adapter can activate through configuration (`types.d.ts:193-215`). */
export interface LlmConfigurableProviderLike {
    readonly provider: string;
    readonly displayName: string;
    readonly settingsNs: string;
    readonly settingsPath: readonly string[];
}
/** The `ctx.llm` slice this module uses. A superset of it is what the Host passes. */
export interface LlmCatalogLike {
    listProviders(): readonly LlmProviderInfoLike[];
    listModels(provider: string): Promise<readonly LlmModelInfoLike[]>;
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfoLike>;
    /** Optional: declared-but-dormant providers, reported as unavailable rather than hidden. */
    listConfigurableProviders?(): readonly LlmConfigurableProviderLike[];
}
/**
 * How {@link enumerateRoutes} behaves. Cancellation only: this module reads what the LLM service
 * already has registered and makes no judgement about whether a route can authenticate.
 */
export interface RouteEnumerationOptions {
    /** Cancellation for adapter-owned asynchronous lookup. */
    readonly signal?: AbortSignal | undefined;
    /** Warn sink for a provider skipped without failing the whole enumeration. */
    readonly logger?: {
        readonly warn?: (message: string) => void;
    } | undefined;
}
/**
 * Enumerate every model this install currently has registered.
 *
 * ## What this deliberately does not do
 *
 * It does not ask whether a route has a credential. An earlier version did: it resolved each
 * provider's declared `apiKeyEnv` by guessing settings namespaces (`llm-<vendor>`, …) and fell back
 * to a derived `${PROVIDER}_API_KEY`, then **omitted** every model whose ref looked unconfigured.
 * That was ~280 lines of namespace heuristics and an 8-attempt retry ladder, and it produced a
 * catalog that could be *empty on a correctly configured install* whenever the guess lost — which
 * is exactly what happened when DSH moved its settings API out from under it.
 *
 * The user cannot run a model before the client starts anyway, and a credential that is missing
 * reports itself at spawn time with the adapter's own `MISSING_CREDENTIAL` message, which is more
 * accurate than anything derivable here. So this lists what `ctx.llm` reports and leaves
 * authentication to the layer that owns it.
 *
 * ## What it still reports
 *
 * `unavailable` survives for the one case that is a fact about *registration* rather than about
 * credentials: a provider an adapter declares but that is not registered, and a model whose
 * `resolveModelInfo` throws. Both are reported in the adapter's own words.
 *
 * Pure with respect to its service face: no module state, no environment, no clock, no `process`.
 *
 * @param llm - the `ctx.llm` face.
 * @param options - cancellation and a warn sink.
 * @returns routes in adapter order, plus registration failures and why.
 */
export declare function enumerateRoutes(llm: LlmCatalogLike, options?: RouteEnumerationOptions): Promise<RouteCatalog>;
/**
 * Find a route in a catalog by exact provider and model. The one lookup every caller needs, kept
 * here so `resolveRole` and the spawn tool cannot disagree about what "in the catalog" means.
 * @param catalog - the enumerated inventory.
 * @param provider - exact provider route id.
 * @param model - exact model id.
 * @returns the usable route, or `undefined`.
 */
export declare function findRoute(catalog: RouteCatalog, provider: string, model: string): UsableRoute | undefined;
/**
 * The reason a route is unusable, as the catalog recorded it. A provider-level entry (no model)
 * matches any model on that provider.
 * @param catalog - the enumerated inventory.
 * @param provider - exact provider route id.
 * @param model - exact model id.
 * @returns the recorded reason, or `undefined` when the catalog never mentioned this route.
 */
export declare function unavailableReason(catalog: RouteCatalog, provider: string, model: string): string | undefined;
export {};
