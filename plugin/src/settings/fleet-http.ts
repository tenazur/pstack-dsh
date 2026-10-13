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
import { findRoute } from '../roles/catalog.ts'
import type { RouteCatalog } from '../roles/catalog.ts'
import {
  PANEL_ROLES,
  ROLE_KEYS,
  parseOverlay,
  serializeOverlay,
} from '../roles/overlay.ts'
import type { OverlayFileV2 } from '../roles/overlay.ts'
import {
  defaultGroups,
  fromOverlay,
  parseFleetGroups,
  repairedGroups,
  serializeFleetGroups,
  toOverlay,
  unassignedTasks,
  violinProblems,
} from '../roles/fleet-groups.ts'
import type { DefaultGroupsOptions, FleetGroupsFile, SessionDefaultRoute } from '../roles/fleet-groups.ts'
import { readBody, readModelSelection, sendJson, validateOverlayAgainstCatalog, writeTextAtomic } from './http.ts'
import type { SettingsLike } from './http.ts'
import type { HttpRequestLike, HttpResponseLike, HttpResult, ModelSelectionView, WebRouteLike } from './http.ts'

/** The route this module registers. */
export const FLEET_ROUTE_PATH = '/api/pstack/fleet'

/** `0o600`, the mode every DSH_HOME document uses; see `writeTextAtomic`. */
export const GROUPS_FILE_MODE = 0o600

/** A body larger than this is refused rather than parsed; a fleet is a few kilobytes. */
export const MAX_FLEET_BODY_BYTES = 256 * 1024

/** Everything this module reads; all of it injected, so the route is testable without a Host. */
export interface FleetHttpSources {
  /** The groups file of record (`$DSH_HOME/pstack-fleet.json`). */
  readonly groupsPath: string
  /** The overlay of record (`$DSH_HOME/pstack.json`), written as a projection of the groups. */
  readonly overlayPath: string
  /** The live route inventory; `refresh` re-enumerates instead of using the resolver's cache. */
  readonly catalog: (refresh?: boolean) => Promise<RouteCatalog>
  /** The session's own default route, read from `agent-default-model`; the `general` default. */
  readonly sessionDefault?: (() => SessionDefaultRoute | undefined) | undefined
  /** The settings face, read **only** to report the stock subagent model-selection preference. */
  readonly settings?: SettingsLike | undefined
  /** Warn sink for a failure after the body was accepted. */
  readonly logger?: { readonly warn?: (message: string) => void } | undefined
}

/** How the view that was answered came to be. */
export type FleetOrigin = 'file' | 'imported' | 'defaults'

/**
 * The page's whole payload. Frozen by the brief the client half was written against: every field is
 * present on `GET` and on a `PUT`'s answer, so the page renders one shape.
 */
export interface FleetView {
  readonly groupsPath: string
  readonly overlayPath: string
  readonly origin: FleetOrigin
  /** What this load changed on disk, in sentences; empty when the files already agreed. */
  readonly repairs: readonly string[]
  /** The groups file's own parse error, when the file on disk was rejected. */
  readonly groupsError: string | null
  readonly groups: FleetGroupsFile
  /** What the live catalog or the rules cannot honour, each naming the offender. */
  readonly problems: readonly string[]
  readonly catalog: RouteCatalog
  /** Every task key this build knows, in `ROLE_KEYS` order. */
  readonly taskKeys: readonly string[]
  readonly panelRoles: readonly string[]
  /** Tasks in no violin; they run on `general` (`toOverlay` rule 3). */
  readonly unassigned: readonly string[]
  /** Reported, never written. */
  readonly modelSelection: ModelSelectionView
}

/** Read one file as text, `null` when it does not exist or cannot be read. */
async function readTextFile(path: string): Promise<string | null> {
  const { readFile } = await import('node:fs/promises')
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** The options {@link defaultGroups} and {@link fromOverlay} both take, read from the sources. */
function groupOptions(sources: FleetHttpSources, catalog: RouteCatalog): DefaultGroupsOptions {
  const sessionDefault = sources.sessionDefault?.()
  return { catalog, ...(sessionDefault === undefined ? {} : { sessionDefault }) }
}

/**
 * The groups to serve, and what it took to get them.
 *
 * The order is the design: the file wins, the overlay is imported once, and defaults are the last
 * resort. A file that exists but does not parse is treated as an import too — with its error kept
 * for the page — because the alternative is showing an empty fleet and overwriting whatever the
 * person wrote on the first edit.
 */
async function resolveGroups(
  sources: FleetHttpSources,
  catalog: RouteCatalog,
): Promise<{ groups: FleetGroupsFile; origin: FleetOrigin; groupsError: string | null; repairs: string[] }> {
  const text = await readTextFile(sources.groupsPath)
  if (text !== null) {
    const parsed = parseFleetGroups(text)
    if (parsed.ok) return { groups: parsed.value, origin: 'file', groupsError: null, repairs: [] }
    const overlayText = await readTextFile(sources.overlayPath)
    const overlay = overlayText === null ? undefined : parseOverlay(overlayText)
    const imported = fromOverlay(overlay?.ok === true ? overlay.value : undefined, groupOptions(sources, catalog))
    const repaired = repairedGroups(imported.groups)
    return {
      groups: repaired.groups,
      origin: 'file',
      groupsError: parsed.error,
      repairs: [`the groups file was rejected and has been rebuilt: ${parsed.error}`, ...repaired.repairs],
    }
  }

  const overlayText = await readTextFile(sources.overlayPath)
  const overlay = overlayText === null ? undefined : parseOverlay(overlayText)
  if (overlay !== undefined && overlay.ok && overlay.value.version === 2) {
    const imported = fromOverlay(overlay.value, groupOptions(sources, catalog))
    const repairs = [`no fleet groups file existed; imported the overlay at ${sources.overlayPath}`]
    if (imported.dropped.length > 0) {
      repairs.push(
        `these names resolved against the catalog but had nothing written for them, so they were not imported: ${imported.dropped.join(', ')}`,
      )
    }
    return { groups: imported.groups, origin: 'imported', groupsError: null, repairs }
  }
  if (overlay !== undefined && !overlay.ok) {
    return {
      groups: defaultGroups(groupOptions(sources, catalog)),
      origin: 'defaults',
      groupsError: null,
      repairs: [`the overlay at ${sources.overlayPath} was rejected and is being ignored: ${overlay.error}`],
    }
  }
  return {
    groups: defaultGroups(groupOptions(sources, catalog)),
    origin: 'defaults',
    groupsError: null,
    repairs: [`no fleet groups file and no overlay existed; wrote the default fleet to ${sources.groupsPath}`],
  }
}

/**
 * Every problem a group set and its projection have, in one vocabulary.
 *
 * The violin report is the reader's vocabulary — it names the violin and the selection — and it
 * covers everything a fleet document can get wrong, so it is what a refusal shows. The overlay
 * validator runs too, as the backstop that guards the file the spawn path actually reads: when the
 * violin report is silent and the validator is not, the document has found a hole in the report,
 * and the validator's own sentences are the honest thing to show rather than a claim that the fleet
 * is fine. Two wordings of one fact would be noise, so they are never shown together.
 */
function allProblems(groups: FleetGroupsFile, overlay: OverlayFileV2, catalog: RouteCatalog): readonly string[] {
  const fromViolins = [...violinProblems(groups, catalog)]
  if (fromViolins.length > 0) return fromViolins
  const validated = validateOverlayAgainstCatalog(overlay, catalog)
  return validated.ok ? [] : [...validated.problems]
}

/** Assemble the payload from parts that are already in memory. */
function buildView(options: {
  readonly sources: FleetHttpSources
  readonly catalog: RouteCatalog
  readonly groups: FleetGroupsFile
  readonly overlay: OverlayFileV2
  readonly origin: FleetOrigin
  readonly repairs: readonly string[]
  readonly groupsError: string | null
  readonly problems: readonly string[]
}): FleetView {
  return {
    groupsPath: options.sources.groupsPath,
    overlayPath: options.sources.overlayPath,
    origin: options.origin,
    repairs: options.repairs,
    groupsError: options.groupsError,
    groups: options.groups,
    problems: options.problems,
    catalog: options.catalog,
    taskKeys: [...ROLE_KEYS],
    panelRoles: [...PANEL_ROLES],
    unassigned: unassignedTasks(options.groups, ROLE_KEYS),
    modelSelection: readModelSelection(options.sources.settings),
  }
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
export async function handleFleetGet(sources: FleetHttpSources, refresh = false): Promise<HttpResult> {
  const catalog = await sources.catalog(refresh)
  const resolved = await resolveGroups(sources, catalog)
  const overlay = toOverlay(resolved.groups, ROLE_KEYS)
  const problems = allProblems(resolved.groups, overlay, catalog)
  const repairs = [...resolved.repairs]

  const groupsText = serializeFleetGroups(resolved.groups)
  const onDiskGroups = await readTextFile(sources.groupsPath)
  if (onDiskGroups !== groupsText) {
    await writeTextAtomic(sources.groupsPath, groupsText, { mode: GROUPS_FILE_MODE })
  }

  const overlayText = serializeOverlay(overlay)
  const onDiskOverlay = await readTextFile(sources.overlayPath)
  if (onDiskOverlay !== overlayText) {
    if (problems.length === 0) {
      await writeTextAtomic(sources.overlayPath, overlayText, { mode: GROUPS_FILE_MODE })
      if (resolved.origin === 'file' && onDiskOverlay !== null) {
        repairs.push(`rewrote ${sources.overlayPath} from the fleet groups file; the two had disagreed`)
      }
    } else {
      repairs.push(
        `did not rewrite ${sources.overlayPath}: the fleet groups file cannot be honoured by the live catalog yet (see the problems above)`,
      )
    }
  }

  // The view reports the files as they now are, not as they were read: a repair the page cannot see
  // is a repair nobody can trust.
  const served = parseFleetGroups(groupsText)
  const groups = served.ok ? served.value : resolved.groups
  return {
    status: 200,
    body: buildView({
      sources,
      catalog,
      groups,
      overlay,
      origin: resolved.origin,
      repairs,
      groupsError: resolved.groupsError,
      problems,
    }),
  }
}

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
export async function handleFleetPut(
  sources: FleetHttpSources,
  text: string,
  tooLarge = false,
): Promise<HttpResult> {
  if (tooLarge) {
    return {
      status: 413,
      body: { ok: false, error: `the fleet document is larger than ${String(MAX_FLEET_BODY_BYTES)} bytes` },
    }
  }
  const parsed = parseFleetGroups(text)
  if (!parsed.ok) {
    return { status: 400, body: { ok: false, error: parsed.error, problems: [parsed.error] } }
  }
  const catalog = await sources.catalog(true)
  const overlay = toOverlay(parsed.value, ROLE_KEYS)
  const problems = allProblems(parsed.value, overlay, catalog)
  if (problems.length > 0) {
    return {
      status: 400,
      body: {
        ok: false,
        error: 'the fleet was refused: the live catalog cannot honour it, and nothing was written',
        problems: [...problems],
      },
    }
  }

  try {
    await writeTextAtomic(sources.groupsPath, serializeFleetGroups(parsed.value), { mode: GROUPS_FILE_MODE })
    await writeTextAtomic(sources.overlayPath, serializeOverlay(overlay), { mode: GROUPS_FILE_MODE })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sources.logger?.warn?.(`pstack: writing the fleet failed: ${message}`)
    return { status: 500, body: { ok: false, error: `the fleet could not be written: ${message}` } }
  }

  return {
    status: 200,
    body: buildView({
      sources,
      catalog,
      groups: parsed.value,
      overlay,
      origin: 'file',
      repairs: [],
      groupsError: null,
      problems: [],
    }),
  }
}

/**
 * The route. `GET` answers the fleet view (`?refresh=1` re-enumerates the catalog first); `PUT`
 * takes the whole groups document. Every other method is `405` with an `Allow` header.
 * @param sources - the injected faces.
 * @returns the route for `webServer.register`.
 */
export function createFleetRoute(sources: FleetHttpSources): WebRouteLike {
  return {
    kind: 'exact',
    path: FLEET_ROUTE_PATH,
    handler: async (req: HttpRequestLike, res: HttpResponseLike) => {
      const method = (req.method ?? 'GET').toUpperCase()
      try {
        if (method === 'GET') {
          const raw = req.url ?? ''
          const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : ''
          sendJson(res, await handleFleetGet(sources, new URLSearchParams(query).get('refresh') === '1'))
          return
        }
        if (method === 'PUT') {
          const { text, tooLarge } = await readBody(req, MAX_FLEET_BODY_BYTES)
          sendJson(res, await handleFleetPut(sources, text, tooLarge))
          return
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sources.logger?.warn?.(`pstack: ${method} ${FLEET_ROUTE_PATH} failed: ${message}`)
        sendJson(res, { status: 500, body: { ok: false, error: message } })
        return
      }
      sendJson(res, {
        status: 405,
        headers: { allow: 'GET, PUT' },
        body: { ok: false, error: `${method} is not supported on ${FLEET_ROUTE_PATH}; use GET or PUT` },
      })
    },
  }
}

/**
 * Register the route and return the disposer `webServer.register` answered with.
 * @param webServer - `ctx.webServer`.
 * @param sources - the injected faces.
 * @returns the registration disposer.
 */
export function registerFleetRoute(
  webServer: { register: (route: WebRouteLike) => () => void },
  sources: FleetHttpSources,
): () => void {
  return webServer.register(createFleetRoute(sources))
}

/** `findRoute` re-exported so a caller reporting on a violin can use the same lookup the host does. */
export { findRoute }
