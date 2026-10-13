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
/** One line of "why", never empty; `undefined`/`''` messages are made readable here. */
function describeError(error) {
    if (error instanceof Error && error.message.length > 0)
        return error.message;
    const text = String(error);
    return text.length > 0 ? text : 'unknown error';
}
/** Quote a value for a user-facing reason without ever throwing on odd input. */
function quote(value) {
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch {
        return String(value);
    }
}
/** Pull the advertised effort ids out of a resolved model, ignoring malformed entries. */
function effortIds(info) {
    const efforts = info.reasoning?.efforts;
    if (!Array.isArray(efforts))
        return [];
    const ids = [];
    for (const effort of efforts) {
        const id = effort?.id;
        if (typeof id === 'string' && id.length > 0)
            ids.push(id);
    }
    return ids;
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
export async function enumerateRoutes(llm, options = {}) {
    const { signal, logger } = options;
    signal?.throwIfAborted();
    const routes = [];
    const unavailable = [];
    const providers = llm.listProviders();
    const registered = new Set(providers.map((provider) => provider.id));
    for (const provider of providers) {
        signal?.throwIfAborted();
        let models;
        try {
            models = await llm.listModels(provider.id);
        }
        catch (error) {
            unavailable.push({ provider: provider.id, why: `cannot list models: ${describeError(error)}` });
            continue;
        }
        signal?.throwIfAborted();
        for (const model of models) {
            signal?.throwIfAborted();
            try {
                const info = await llm.resolveModelInfo(provider.id, model.id, signal);
                const description = typeof info.description === 'string' && info.description.trim().length > 0
                    ? info.description.trim()
                    : undefined;
                routes.push({
                    provider: provider.id,
                    model: model.id,
                    efforts: effortIds(info),
                    ...(description === undefined ? {} : { description }),
                    ...(typeof info.reasoning?.defaultEffort === 'string' && info.reasoning.defaultEffort.length > 0
                        ? { defaultEffort: info.reasoning.defaultEffort }
                        : {}),
                });
            }
            catch (error) {
                unavailable.push({
                    provider: provider.id,
                    model: model.id,
                    why: `resolveModelInfo failed: ${describeError(error)}`,
                });
            }
        }
    }
    // Declared-but-dormant providers: they exist in the directory the settings page offers, so the
    // menu says "unavailable and why" instead of pretending the install has one route fewer.
    if (typeof llm.listConfigurableProviders === 'function') {
        let declared;
        try {
            declared = llm.listConfigurableProviders();
        }
        catch (error) {
            logger?.warn?.(`listConfigurableProviders failed: ${describeError(error)}`);
            declared = [];
        }
        for (const entry of declared) {
            if (registered.has(entry.provider))
                continue;
            unavailable.push({
                provider: entry.provider,
                why: `declared by an adapter (settings namespace ${quote(entry.settingsNs)}) but not registered; configure it to make this route usable`,
            });
        }
    }
    return { routes, unavailable };
}
/**
 * Find a route in a catalog by exact provider and model. The one lookup every caller needs, kept
 * here so `resolveRole` and the spawn tool cannot disagree about what "in the catalog" means.
 * @param catalog - the enumerated inventory.
 * @param provider - exact provider route id.
 * @param model - exact model id.
 * @returns the usable route, or `undefined`.
 */
export function findRoute(catalog, provider, model) {
    return catalog.routes.find((route) => route.provider === provider && route.model === model);
}
/**
 * The reason a route is unusable, as the catalog recorded it. A provider-level entry (no model)
 * matches any model on that provider.
 * @param catalog - the enumerated inventory.
 * @param provider - exact provider route id.
 * @param model - exact model id.
 * @returns the recorded reason, or `undefined` when the catalog never mentioned this route.
 */
export function unavailableReason(catalog, provider, model) {
    const exact = catalog.unavailable.find((entry) => entry.provider === provider && entry.model === model);
    const providerLevel = catalog.unavailable.find((entry) => entry.provider === provider && entry.model === undefined);
    return exact?.why ?? providerLevel?.why;
}
