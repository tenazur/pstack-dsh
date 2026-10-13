/**
 * The host HTTP surface behind the violin page: read the fleet, edit the fleet, keep the overlay
 * in step.
 *
 * ## Two files, one writer
 *
 * `plugin/src/roles/fleet-groups.ts` states why the groups file exists. This module is where that
 * becomes an operation, and the operation has exactly one shape:
 *
 * 1. **load** reconciles the two files. The groups file (`$DSH_HOME/pstack-fleet.json`) is the
 *    source of truth; the overlay (`$DSH_HOME/pstack.json`) is the projection the spawn path reads.
 *    A missing groups file is filled from the overlay when there is one (**import**) and from
 *    {@link defaultGroups} when there is not (**setup**), and in both cases the fleet is written
 *    out at once — the human's words are "own setup model creates default file structure". A
 *    groups file that parses while the overlay on disk disagrees causes the overlay to be rewritten
 *    from the groups, and the repair is reported rather than performed silently.
 * 2. **write** refuses before it touches anything: a groups document the live catalog cannot honour
 *    (or that breaks the one-task-one-violin rule) is answered with the offending sentences and
 *    nothing is written. When it is accepted, the groups file is written first and the overlay
 *    second, each as its own atomic rename.
 *
 * Because the overlay is derived, a crash between the two renames cannot leave the fleet lying: the
 * next load sees the groups file, re-derives, and writes the overlay again. That is what makes the
 * pair safe to write in sequence instead of needing a transaction.
 *
 * ## Why the older route lost its `PUT`
 *
 * `/api/pstack/overlay` still answers `GET` — it is the plain read of the file the spawn path uses,
 * and `pstack_status` reports the same path. Its `PUT` is gone: with the groups file as the source
 * of truth, a write to the overlay alone would be **reverted by the next load's reconciliation**,
 * so the route would answer `200` and silently lose the edit. A `405` that names the fleet route is
 * the honest version of the same refusal, and it keeps the write path single.
 *
 * ## The DSH route contract, mirrored
 *
 * As in `src/settings/http.ts`: `WebRoute` is path + handler only, so the handler checks
 * `req.method` itself. The types are declared structurally, because this package has no
 * dependencies.
 */
import { findRoute } from '../roles/catalog.ts';
import type { RouteCatalog } from '../roles/catalog.ts';
import type { FleetGroupsFile, SessionDefaultRoute } from '../roles/fleet-groups.ts';
import type { SettingsLike } from './http.ts';
import type { HttpResult, ModelSelectionView, WebRouteLike } from './http.ts';
/** The route this module registers. */
export declare const FLEET_ROUTE_PATH = "/api/pstack/fleet";
/** `0o600`, the mode every DSH_HOME document uses; see `writeTextAtomic`. */
export declare const GROUPS_FILE_MODE = 384;
/** A body larger than this is refused rather than parsed; a fleet is a few kilobytes. */
export declare const MAX_FLEET_BODY_BYTES: number;
/** Everything this module reads; all of it injected, so the route is testable without a Host. */
export interface FleetHttpSources {
    /** The groups file of record (`$DSH_HOME/pstack-fleet.json`). */
    readonly groupsPath: string;
    /** The overlay of record (`$DSH_HOME/pstack.json`), written as a projection of the groups. */
    readonly overlayPath: string;
    /** The live route inventory; `refresh` re-enumerates instead of using the resolver's cache. */
    readonly catalog: (refresh?: boolean) => Promise<RouteCatalog>;
    /** The session's own default route, read from `agent-default-model`; the `general` default. */
    readonly sessionDefault?: (() => SessionDefaultRoute | undefined) | undefined;
    /** The settings face, read **only** to report the stock subagent model-selection preference. */
    readonly settings?: SettingsLike | undefined;
    /** Warn sink for a failure after the body was accepted. */
    readonly logger?: {
        readonly warn?: (message: string) => void;
    } | undefined;
}
/** How the view that was answered came to be. */
export type FleetOrigin = 'file' | 'imported' | 'defaults';
/**
 * The page's whole payload. Frozen by the brief the client half was written against: every field is
 * present on `GET` and on a `PUT`'s answer, so the page renders one shape.
 */
export interface FleetView {
    readonly groupsPath: string;
    readonly overlayPath: string;
    readonly origin: FleetOrigin;
    /** What this load changed on disk, in sentences; empty when the files already agreed. */
    readonly repairs: readonly string[];
    /** The groups file's own parse error, when the file on disk was rejected. */
    readonly groupsError: string | null;
    readonly groups: FleetGroupsFile;
    /** What the live catalog or the rules cannot honour, each naming the offender. */
    readonly problems: readonly string[];
    readonly catalog: RouteCatalog;
    /** Every task key this build knows, in `ROLE_KEYS` order. */
    readonly taskKeys: readonly string[];
    readonly panelRoles: readonly string[];
    /** Tasks in no violin; they run on `general` (`toOverlay` rule 3). */
    readonly unassigned: readonly string[];
    /** Reported, never written. */
    readonly modelSelection: ModelSelectionView;
}
/**
 * Load the fleet, reconcile the two files, and answer the view.
 *
 * Reconciliation, in one place: the groups file is written out whenever it did not already hold
 * what this build means to serve (`setup` and `import` always do; a `file` load does not), and the
 * overlay is written whenever the derivation differs from what is on disk. A projection the
 * catalog cannot honour is **not** written — the page shows the sentences and the person fixes it —
 * but the groups file still is, because that is where their edit lives.
 * @param sources - the injected faces.
 * @param refresh - re-enumerate the catalog instead of using the resolver's cache.
 * @returns the view, with the HTTP status this load earns.
 */
export declare function handleFleetGet(sources: FleetHttpSources, refresh?: boolean): Promise<HttpResult>;
/**
 * Validate and write a groups document, or refuse it whole.
 *
 * Nothing reaches the filesystem until every check has passed: the document must parse, the rules
 * must hold (one task in one violin; more than one selection only on a comparison violin), and the
 * derived overlay must be honourable by the live catalog — a route that is not enumerated, or an
 * effort the route does not advertise, is refused **by name**. Then groups first, overlay second,
 * each atomic; see the module comment for why the order cannot lose the fleet.
 * @param sources - the injected faces.
 * @param text - the request body, which is the groups document.
 * @param tooLarge - the body exceeded the cap, from `readBody`.
 * @returns the view on success, or the refusal.
 */
export declare function handleFleetPut(sources: FleetHttpSources, text: string, tooLarge?: boolean): Promise<HttpResult>;
/**
 * The route. `GET` answers the fleet view (`?refresh=1` re-enumerates the catalog first); `PUT`
 * takes the whole groups document. Every other method is `405` with an `Allow` header.
 * @param sources - the injected faces.
 * @returns the route for `webServer.register`.
 */
export declare function createFleetRoute(sources: FleetHttpSources): WebRouteLike;
/**
 * Register the route and return the disposer `webServer.register` answered with.
 * @param webServer - `ctx.webServer`.
 * @param sources - the injected faces.
 * @returns the registration disposer.
 */
export declare function registerFleetRoute(webServer: {
    register: (route: WebRouteLike) => () => void;
}, sources: FleetHttpSources): () => void;
/** `findRoute` re-exported so a caller reporting on a violin can use the same lookup the host does. */
export { findRoute };
