import type { ResolvedRole, RouteCatalog } from '../roles/catalog.ts';
import { UNAVAILABLE_REASON_PREFIX } from '../roles/overlay.ts';
import type { OverlayFile } from '../roles/overlay.ts';
/** The one route this unit registers. Namespaced under `/api/pstack/` like every other surface. */
export declare const OVERLAY_ROUTE_PATH = "/api/pstack/overlay";
/** Largest overlay body accepted, in bytes. A model/task table is small; anything larger is a mistake. */
export declare const MAX_OVERLAY_BODY_BYTES: number;
/** File mode for the overlay document: owner read/write, the DSH_HOME document precedent. */
export declare const OVERLAY_FILE_MODE = 384;
/** Directory mode for the overlay's parent, matching the same precedent. */
export declare const OVERLAY_DIR_MODE = 448;
/** A parent-resolved settings namespace holding one preference this page only *reports*. */
export declare const MODEL_SELECTION_NAMESPACE = "subagent-model-selection";
/** The registry half of `WebServer` (`dsh-host-webserver/lib/types/index.d.ts:90`). */
export interface WebServerLike {
    register(route: WebRouteLike): () => void;
}
/** Path + handler only; the handler owns HTTP semantics (`:33-39`). */
export interface WebRouteLike {
    readonly kind: 'exact' | 'prefix';
    readonly path: string;
    readonly handler: (req: HttpRequestLike, res: HttpResponseLike) => void | Promise<void>;
}
/** The request fields the handler reads. Node's `IncomingMessage` is a superset. */
export interface HttpRequestLike {
    readonly method?: string | undefined;
    readonly url?: string | undefined;
    on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
    on(event: 'end', listener: () => void): unknown;
    on(event: 'error', listener: (error: unknown) => void): unknown;
}
/** The response fields the handler writes. Node's `ServerResponse` is a superset. */
export interface HttpResponseLike {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string): void;
}
/** `loadOverlayFile`'s result, structurally (`roles/resolver.ts:26`). */
export type OverlayLoad = {
    readonly ok: true;
    readonly value: OverlayFile | undefined;
} | {
    readonly ok: false;
    readonly error: string;
};
/** Everything the handlers read. Injected, so the whole surface is testable without a Host. */
export interface OverlayHttpSources {
    /** The overlay path of record (`defaultOverlayPath()`). */
    readonly overlayPath: string;
    /** Read + parse the overlay. A missing file is `{ ok: true, value: undefined }`. */
    readonly loadOverlay: () => Promise<OverlayLoad>;
    /**
     * The overlay file exactly as it is on disk, or `null` when there is no readable file. An editor
     * shows this, so a file the parser rejected can be repaired instead of replaced.
     */
    readonly readOverlayText?: (() => Promise<string | null>) | undefined;
    /** The live route catalog; `refresh` re-enumerates instead of using the resolver's cache. */
    readonly catalog: (refresh?: boolean) => Promise<RouteCatalog>;
    /**
     * The settings face, read **only** to report the stock subagent model-selection preference
     * Nothing here ever writes it.
     */
    readonly settings?: SettingsLike | undefined;
    /** Warn sink for a write that failed after the body was accepted. */
    readonly logger?: {
        readonly warn?: (message: string) => void;
    } | undefined;
}
/** The route one named model resolves to, as the live catalog enumerated it. */
export interface NamedModelRouteView {
    readonly provider: string;
    readonly model: string;
    /** The effort that is part of the assignment; absent means the adapter materialises its default. */
    readonly reasoningEffort: string | null;
    /** What the route advertises, so a picker offers exactly these ids — `off` included. */
    readonly efforts: readonly string[];
    readonly defaultEffort: string | null;
    /**
     * The adapter's own description of this model (`UsableRoute.description`). The page shows it;
     * absent means the adapter declares none, and the page says so rather than inventing prose.
     */
    readonly description: string | null;
}
/** One named model, resolved against the live catalog. */
export interface NamedModelView {
    /** The friendly name the user reads and a task points at. */
    readonly name: string;
    /** True when the name would resolve with no `models` block at all. */
    readonly builtIn: boolean;
    /** True when the file declares this name, overriding a built-in of the same name. */
    readonly declared: boolean;
    /**
     * True for the `inherit-parent` sentinel, which is a legitimate name a task may point at but is
     * not a route and therefore carries no {@link route}.
     */
    readonly inheritsParent: boolean;
    /** The resolved route, or `null` for `inherit-parent` and for an assignment the catalog refuses. */
    readonly route: NamedModelRouteView | null;
    /** Why there is no route, when there is none: the catalog's own reason. */
    readonly unavailable: string | null;
    /** The one line of prose the file writes next to this name, when it writes one. */
    readonly overlayDescription: string | null;
    /** Every task key that points at this name, sorted. */
    readonly usedBy: readonly string[];
}
/** One model name inside a task's list. */
export interface TaskModelView {
    readonly name: string;
    /** False when the name is neither built-in nor declared; the parser refuses this, the view reports it. */
    readonly known: boolean;
}
/** One task container and the name(s) it points at. */
export interface TaskView {
    /** The normalised task key. */
    readonly key: string;
    /** True for the four tasks that may list more than one name. */
    readonly panel: boolean;
    /** What the file holds for this key. */
    readonly entry: 'absent' | 'inherit' | 'models';
    /**
     * The name(s) as written. Empty for `absent`, and for `inherit` when the file omits the key.
     */
    readonly models: readonly TaskModelView[];
    /** One resolution per name for a panel task; exactly one for every other task. */
    readonly resolved: readonly ResolvedRole[];
    /** The `inherit-parent` sentinel or an empty list was written: stated, not inferred. */
    readonly inheritsParent: boolean;
}
/** The stock preference this page must surface and never set. */
export interface ModelSelectionView {
    /** The namespace read (`subagent-model-selection`). */
    readonly namespace: string;
    /** False when the namespace is not registered in this composition. */
    readonly present: boolean;
    /** The preference's value, or `null` when the namespace is absent or says nothing. */
    readonly enabled: boolean | null;
}
/** The GET/PUT payload. Identical for both, so the page renders one shape. */
export interface OverlayView {
    readonly overlayPath: string;
    /** The parsed overlay, or `null` when no file exists or the file was rejected. */
    readonly overlay: OverlayFile | null;
    /** The file text exactly as it is on disk, for the editor; `null` when no readable file exists. */
    readonly overlayText: string | null;
    /** The parser's own message when the file on disk was rejected. */
    readonly overlayError: string | null;
    /**
     * Which file version answered. `null` when there is no parsed file. The page uses this to show
     * the version 1 story instead of a task table that would otherwise look complete.
     */
    readonly overlayVersion: 1 | 2 | null;
    /**
     * The version 1 sentence, naming the routes that version carried and this build does not apply.
     * `null` for v2 or no file.
     */
    readonly versionNote: string | null;
    readonly catalog: RouteCatalog;
    /** Everything the catalog could not use, repeated from `catalog.unavailable` for convenience. */
    readonly unavailable: RouteCatalog['unavailable'];
    /** Level 1: one entry per named model, declared first and built-ins filled in. */
    readonly models: readonly NamedModelView[];
    /** Level 2: one entry per task key that matters, in `ROLE_KEYS` order. */
    readonly tasks: readonly TaskView[];
    /** Every version 2 task key, in `ROLE_KEYS` order. */
    readonly taskKeys: readonly string[];
    /** Kept as the name of the same list, for a caller that still says "role". */
    readonly roleKeys: readonly string[];
    readonly panelRoles: readonly string[];
    /** Reported, never written. */
    readonly modelSelection: ModelSelectionView;
}
/** The result of one request, before it is turned into HTTP. */
export interface HttpResult {
    readonly status: number;
    readonly body: unknown;
    /** Extra response headers, e.g. `Allow` on a 405. */
    readonly headers?: Readonly<Record<string, string>>;
}
/**
 * The stock subagent model-selection preference, read and never set.
 *
 * The rule: read the preference and say what you found; never set it.
 * Its namespace is `subagent-model-selection` with `{enabled, allowedModels}`
 * (`dsh-tool-subagent/lib/model-selection-settings.js:45-49`). A composition without that row
 * answers `present: false`, which is a different fact from `enabled: false` and is reported as
 * such.
 * @param settings - the settings face, when the caller has one.
 * @returns what was found.
 */
/**
 * One registered namespace, as `settings.describe()` reports it
 * (`dsh-settings/lib/types/index.d.ts:104-131`).
 */
interface SettingsDescriptorLike {
    readonly ns: string;
    /** The namespace's **resolved** config: schema defaults, then base, then user. */
    readonly value?: unknown;
}
/**
 * The `ctx.settings` slice this module reads.
 *
 * `describe()` is the **only** read on this API: `SettingsForms` has no `get(ns)` on 0.2.0-rc.2, and
 * calling one is how the model-selection row used to report `present: false` for every install.
 * Each descriptor carries both the registration proof and the resolved `value`.
 */
export interface SettingsLike {
    describe(): readonly SettingsDescriptorLike[];
}
/**
 * The resolved value of one settings namespace, read the only way this API allows.
 * @param settings - the settings face, which a minimal composition may not have.
 * @param ns - the namespace to read.
 * @returns the resolved value, or `undefined` when the face is absent, the namespace is
 *   unregistered, or the read threw. Callers treat `undefined` uniformly.
 */
export declare function readSettingsNamespace(settings: SettingsLike | undefined, ns: string): unknown;
export declare function readModelSelection(settings: SettingsLike | undefined): ModelSelectionView;
/**
 * Build the payload both routes answer with: the file, the live catalog, and the two-level view.
 * @param sources - the injected faces.
 * @param refresh - re-enumerate the catalog instead of using the resolver's cache.
 * @returns the view.
 */
export declare function buildOverlayView(sources: OverlayHttpSources, refresh?: boolean): Promise<OverlayView>;
/**
 * Reject an overlay the live catalog cannot honour, and the one shape the parser leaves to this
 * function: a scalar task listing two names.
 *
 * "A route that is not currently usable is **rejected on write**
 * and shown as unavailable, not silently dropped at spawn time", and "`reasoningEffort` is
 * rejected unless the route's own adapter lists that effort id". This is the write-time half of
 * that rule; `resolveRole` is the read-time half, and it reports the same facts as
 * `unavailable (was: X)` — both go through `describeRoute` so they cannot drift.
 *
 * Every problem names the offender: the task, the model name, and the route or effort involved.
 * @param overlay - a parsed overlay.
 * @param catalog - the live inventory, freshly enumerated.
 * @returns every problem found, or `{ ok: true }`.
 */
export declare function validateOverlayAgainstCatalog(overlay: OverlayFile, catalog: RouteCatalog): {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly problems: readonly string[];
};
/**
 * Replace `path` with `text` in one atomic step: a random-suffix `wx` sibling carrying the mode,
 * then a rename over the target. Mirrors `dsh-atomic-write/lib/index.js` so a half-written overlay
 * can never land, and so replacing a wider-permission file narrows it without a chmod race.
 * @param path - the file to replace.
 * @param text - the complete next content.
 * @param options - permission bits; defaults to the DSH_HOME document precedent.
 */
export declare function writeTextAtomic(path: string, text: string, options?: {
    readonly mode?: number;
    readonly dirMode?: number;
}): Promise<void>;
/** The GET half, as a status + body. Pure with respect to the injected faces. */
export declare function handleOverlayGet(sources: OverlayHttpSources, refresh?: boolean): Promise<HttpResult>;
/**
 * Collect a request body up to `maxBytes`, draining the stream either way.
 *
 * A body over the limit is reported rather than truncated-and-accepted: `tooLarge` makes the PUT
 * answer 413 and write nothing.
 * @param req - the request.
 * @param maxBytes - the cap.
 * @returns the text, and whether the cap was passed.
 */
export declare function readBody(req: HttpRequestLike, maxBytes?: number): Promise<{
    text: string;
    tooLarge: boolean;
}>;
/** Write one JSON response with the no-store policy the other API routes use. */
export declare function sendJson(res: HttpResponseLike, result: HttpResult): void;
/**
 * Build the one route this unit registers.
 *
 * `GET` answers the view; `?refresh=1` re-enumerates the catalog first. This route is **read-only**:
 * it is the plain read of the file the spawn path resolves, and writes go to the fleet route, which
 * derives that file from the groups file. Every other method is `405` with an `Allow` header,
 * because a `WebRoute` carries no method.
 * @param sources - the injected faces.
 * @returns the route for `webServer.register`.
 */
export declare function createOverlayRoute(sources: OverlayHttpSources): WebRouteLike;
/**
 * Register the route and return the disposer `webServer.register` answered with.
 * @param webServer - `ctx.webServer`.
 * @param sources - the injected faces.
 * @returns the registration disposer.
 */
export declare function registerOverlayRoute(webServer: WebServerLike, sources: OverlayHttpSources): () => void;
/** `UNAVAILABLE_REASON_PREFIX` re-exported so the client half and its tests share one literal. */
export { UNAVAILABLE_REASON_PREFIX };
