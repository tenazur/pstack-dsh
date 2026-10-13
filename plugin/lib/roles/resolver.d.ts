import type { LlmCatalogLike, ResolvedRole, RouteCatalog } from './catalog.ts';
import type { OverlayFile } from './overlay.ts';
/** The overlay at `path`, `undefined` when there is no file, or the reason it was rejected. */
export type LoadOverlayResult = {
    ok: true;
    value: OverlayFile | undefined;
} | {
    ok: false;
    error: string;
};
/**
 * Read and parse the overlay file.
 *
 * A missing file is **not** an error: `plugin/HARNESS.md` §Rules 3 makes "no overlay" the correct
 * one-route behaviour, not a degraded one. Anything else the file can be — unreadable, invalid
 * JSON, a version this build does not know — comes back as an error string for a user.
 * @param path - the overlay path of record (`defaultOverlayPath()`, `$DSH_HOME/pstack.json`).
 * @returns the parsed overlay or `undefined`, or the reason it could not be used.
 */
export declare function loadOverlayFile(path: string): Promise<LoadOverlayResult>;
/** Everything the resolver reads. All of it injected, so the resolver is testable without a Host. */
export interface RoleResolverSources {
    /** Route inventory (`ctx.llm`). */
    readonly llm: LlmCatalogLike;
    /** Read the overlay for one resolve. Called per resolve on purpose; see the file comment. */
    readonly readOverlay: () => Promise<OverlayFile | undefined>;
    /** A catalog the caller already enumerated, instead of enumerating one here. */
    readonly catalog?: RouteCatalog | undefined;
}
/** What `pstack_spawn` consumes: `RoleResolverLike` in `src/tools/spawn.ts`, structurally. */
export interface RoleResolver {
    resolve(role: string, routeIndex?: number): Promise<ResolvedRole>;
    /** The catalog in use, enumerating it on first call. */
    catalog(): Promise<RouteCatalog>;
    /** Drop the cached catalog and enumerate again; call after a provider or credential change. */
    refresh(): Promise<RouteCatalog>;
}
/**
 * Build the production resolver.
 *
 * `routeIndex` is passed straight through: `undefined` means the role's own default, which for a
 * panel role is entry 0 (`src/tools/spawn.ts:73-74`).
 * @param sources - the service faces and the overlay reader.
 * @returns a resolver for `createPstackSpawnTool`.
 */
export declare function createRoleResolver(sources: RoleResolverSources): RoleResolver;
