/**
 * The seam between the role data layer and the spawn tool.
 *
 * `src/tools/spawn.ts` deliberately takes a one-method resolver
 * (`RoleResolverLike.resolve(role, routeIndex?)`) rather than importing a module, so the tool can
 * be tested with a fake mapping. This file is the production adapter it was written against: it
 * enumerates the live catalog once, lazily, and re-reads the overlay on every resolve.
 *
 * Why the overlay is not cached: the overlay is a hand-edited file, and the house rule for a body
 * that a user edits is "re-read, do not cache"
 * (`src/skills/provider.ts:13-14`). A spawn happens rarely enough that one small read per call is
 * the cheap side of that trade. The catalog **is** cached, because enumerating it calls
 * `resolveModelInfo` once per model and the adapter registry does not change between spawns; call
 * {@link RoleResolver.refresh} after a provider change.
 *
 * Kept separate from `overlay.ts` so that file stays pure (no `node:fs`, no `node:process`) and
 * its tests need no temporary directory.
 *
 * One injected face, `ctx.llm`. An earlier version also took `ctx.credentials` and `ctx.settings`
 * so the catalog could judge whether a route had a key; that judgement is gone (see
 * `catalog.ts` §"What enumerated means here"), and with it the two extra services — which were
 * also two more names that could hold this plugin inactive.
 */
import { readFile } from 'node:fs/promises'
import { enumerateRoutes } from './catalog.ts'
import type { LlmCatalogLike, ResolvedRole, RouteCatalog } from './catalog.ts'
import { parseOverlay, resolveRole } from './overlay.ts'
import type { OverlayFile } from './overlay.ts'

/** The overlay at `path`, `undefined` when there is no file, or the reason it was rejected. */
export type LoadOverlayResult = { ok: true; value: OverlayFile | undefined } | { ok: false; error: string }

/**
 * Read and parse the overlay file.
 *
 * A missing file is **not** an error: `plugin/HARNESS.md` §Rules 3 makes "no overlay" the correct
 * one-route behaviour, not a degraded one. Anything else the file can be — unreadable, invalid
 * JSON, a version this build does not know — comes back as an error string for a user.
 * @param path - the overlay path of record (`defaultOverlayPath()`, `$DSH_HOME/pstack.json`).
 * @returns the parsed overlay or `undefined`, or the reason it could not be used.
 */
export async function loadOverlayFile(path: string): Promise<LoadOverlayResult> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: true, value: undefined }
    return { ok: false, error: `overlay ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
  const parsed = parseOverlay(text)
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, error: `overlay ${path}: ${parsed.error}` }
}

/** Everything the resolver reads. All of it injected, so the resolver is testable without a Host. */
export interface RoleResolverSources {
  /** Route inventory (`ctx.llm`). */
  readonly llm: LlmCatalogLike
  /** Read the overlay for one resolve. Called per resolve on purpose; see the file comment. */
  readonly readOverlay: () => Promise<OverlayFile | undefined>
  /** A catalog the caller already enumerated, instead of enumerating one here. */
  readonly catalog?: RouteCatalog | undefined
}

/** What `pstack_spawn` consumes: `RoleResolverLike` in `src/tools/spawn.ts`, structurally. */
export interface RoleResolver {
  resolve(role: string, routeIndex?: number): Promise<ResolvedRole>
  /** The catalog in use, enumerating it on first call. */
  catalog(): Promise<RouteCatalog>
  /** Drop the cached catalog and enumerate again; call after a provider or credential change. */
  refresh(): Promise<RouteCatalog>
}

/**
 * Build the production resolver.
 *
 * `routeIndex` is passed straight through: `undefined` means the role's own default, which for a
 * panel role is entry 0 (`src/tools/spawn.ts:73-74`).
 * @param sources - the service faces and the overlay reader.
 * @returns a resolver for `createPstackSpawnTool`.
 */
export function createRoleResolver(sources: RoleResolverSources): RoleResolver {
  const enumerate = (): Promise<RouteCatalog> => {
    if (sources.catalog !== undefined) return Promise.resolve(sources.catalog)
    return enumerateRoutes(sources.llm)
  }

  let cached: Promise<RouteCatalog> | undefined
  const catalog = (): Promise<RouteCatalog> => (cached ??= enumerate())

  return {
    catalog,
    refresh() {
      cached = undefined
      return catalog()
    },
    async resolve(role, routeIndex) {
      const [routes, overlay] = await Promise.all([catalog(), sources.readOverlay()])
      return resolveRole(role, overlay, routes, routeIndex ?? 0)
    },
  }
}
