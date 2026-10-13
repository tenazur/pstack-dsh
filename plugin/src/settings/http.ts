/**
 * The host HTTP surface behind the settings page: read the named-model view, and write it.
 *
 * This is the first HTTP surface in the package, so the contract is stated here once.
 *
 * ## Why a route and not a settings namespace
 *
 * The file of record is the **groups** file, `$DSH_HOME/pstack-fleet.json` (decision 0005); the
 * overlay `$DSH_HOME/pstack.json` — the path `plugin/src/index.ts` names
 * (`defaultOverlayPath()`) — is the projection derived from it on every write.
 * Registering a second store (a `ctx.settings` namespace) would give the mapping two owners and
 * two truths, so this unit deliberately registers no settings namespace at all. The page reads
 * and writes the same file `pstack_spawn` reads on every resolve.
 *
 * ## The payload is the two-level view
 *
 * The page's question is *which model does what*, so `GET` answers both levels in one payload: the
 * named models (friendly name, the route it resolves to, whether it is built-in or declared, and
 * which tasks use it) and the tasks (each key and the name(s) it points at). The live catalog
 * travels too, because every option a picker offers has to come from it — the page never holds a
 * hard-coded slug.
 *
 * ## The DSH route contract, mirrored
 *
 * `ctx.webServer.register(route)` takes a `WebRoute` that is **path + handler only**
 * (`dsh-host-webserver/lib/types/index.d.ts:33-39`): there is no per-method registration, so
 * {@link createOverlayRoute}'s handler checks `req.method` itself and answers `405` otherwise.
 * The working example does exactly that (`dsh-usage-stats/lib/index.js:494-501`). The types here
 * are declared structurally rather than imported from `@deepseek-ai/dsh-*`, because this package
 * typechecks, tests and installs with no dependencies at all — the same choice as
 * `src/roles/catalog.ts` and `src/skills/provider.ts`.
 *
 * ## What a write is allowed to contain
 *
 * `parseOverlay` rejects every key outside the schema, and {@link validateOverlayAgainstCatalog}
 * then requires every assignment's `provider`/`model` to be a route the live catalog enumerated,
 * every `reasoningEffort` to be one that route advertises (`off` included, and checked like any
 * other id), and every task name to be a built-in or a declared model. There is no field left in
 * which a credential **value** could survive a write; the only credential-shaped thing the file
 * may hold is a route name. A rejected write never reaches the filesystem.
 *
 * The body **is** the overlay document, and this build writes `version: 2`. A version 1 body is
 * still accepted and still written — refusing it would delete a file a person wrote — but the view
 * says what reading it costs (`overlayVersionNote`).
 *
 * ## Atomicity and permissions
 *
 * {@link writeTextAtomic} mirrors the DSH precedent
 * (`dsh-atomic-write/lib/index.js` `writeFileAtomic`): a random-suffix sibling created `wx` with
 * the caller's mode, then `rename` over the target, temp removed on failure. Parent directories
 * are created `0o700` and the file is `0o600`, which is what every DSH_HOME document uses
 * (`dsh-settings-file/lib/index.js:166-174` writes mode `0o600`/dirMode `0o700`; the live
 * `~/.dsh/settings.yaml` and `~/.dsh/.credentials.yaml` are both `600`).
 */
import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { findRoute } from '../roles/catalog.ts'
import type { ResolvedRole, RouteCatalog } from '../roles/catalog.ts'
import {
  BUILT_IN_MODEL_NAMES,
  builtInModel,
  describeRoute,
  INHERIT_PARENT_MODEL,
  isPanelRole,
  isBuiltInModelName,
  namedModelAssignment,
  overlayVersionNote,
  PANEL_ROLES,
  parseOverlay,
  resolvePanel,
  resolveRole,
  ROLE_KEYS,
  routeLabel,
  serializeOverlay,
  UNAVAILABLE_REASON_PREFIX,
} from '../roles/overlay.ts'
import type { OverlayFile, OverlayFileV2, OverlayModel } from '../roles/overlay.ts'

/** The one route this unit registers. Namespaced under `/api/pstack/` like every other surface. */
export const OVERLAY_ROUTE_PATH = '/api/pstack/overlay'

/** Largest overlay body accepted, in bytes. A model/task table is small; anything larger is a mistake. */
export const MAX_OVERLAY_BODY_BYTES = 64 * 1024

/** File mode for the overlay document: owner read/write, the DSH_HOME document precedent. */
export const OVERLAY_FILE_MODE = 0o600

/** Directory mode for the overlay's parent, matching the same precedent. */
export const OVERLAY_DIR_MODE = 0o700

/** A parent-resolved settings namespace holding one preference this page only *reports*. */
export const MODEL_SELECTION_NAMESPACE = 'subagent-model-selection'

/** The registry half of `WebServer` (`dsh-host-webserver/lib/types/index.d.ts:90`). */
export interface WebServerLike {
  register(route: WebRouteLike): () => void
}

/** Path + handler only; the handler owns HTTP semantics (`:33-39`). */
export interface WebRouteLike {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: HttpRequestLike, res: HttpResponseLike) => void | Promise<void>
}

/** The request fields the handler reads. Node's `IncomingMessage` is a superset. */
export interface HttpRequestLike {
  readonly method?: string | undefined
  readonly url?: string | undefined
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown
  on(event: 'end', listener: () => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
}

/** The response fields the handler writes. Node's `ServerResponse` is a superset. */
export interface HttpResponseLike {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}

/** `loadOverlayFile`'s result, structurally (`roles/resolver.ts:26`). */
export type OverlayLoad =
  | { readonly ok: true; readonly value: OverlayFile | undefined }
  | { readonly ok: false; readonly error: string }

/** Everything the handlers read. Injected, so the whole surface is testable without a Host. */
export interface OverlayHttpSources {
  /** The overlay path of record (`defaultOverlayPath()`). */
  readonly overlayPath: string
  /** Read + parse the overlay. A missing file is `{ ok: true, value: undefined }`. */
  readonly loadOverlay: () => Promise<OverlayLoad>
  /**
   * The overlay file exactly as it is on disk, or `null` when there is no readable file. An editor
   * shows this, so a file the parser rejected can be repaired instead of replaced.
   */
  readonly readOverlayText?: (() => Promise<string | null>) | undefined
  /** The live route catalog; `refresh` re-enumerates instead of using the resolver's cache. */
  readonly catalog: (refresh?: boolean) => Promise<RouteCatalog>
  /**
   * The settings face, read **only** to report the stock subagent model-selection preference
   * Nothing here ever writes it.
   */
  readonly settings?: SettingsLike | undefined
  /** Warn sink for a write that failed after the body was accepted. */
  readonly logger?: { readonly warn?: (message: string) => void } | undefined
}

/** The route one named model resolves to, as the live catalog enumerated it. */
export interface NamedModelRouteView {
  readonly provider: string
  readonly model: string
  /** The effort that is part of the assignment; absent means the adapter materialises its default. */
  readonly reasoningEffort: string | null
  /** What the route advertises, so a picker offers exactly these ids — `off` included. */
  readonly efforts: readonly string[]
  readonly defaultEffort: string | null
  /**
   * The adapter's own description of this model (`UsableRoute.description`). The page shows it;
   * absent means the adapter declares none, and the page says so rather than inventing prose.
   */
  readonly description: string | null
}

/** One named model, resolved against the live catalog. */
export interface NamedModelView {
  /** The friendly name the user reads and a task points at. */
  readonly name: string
  /** True when the name would resolve with no `models` block at all. */
  readonly builtIn: boolean
  /** True when the file declares this name, overriding a built-in of the same name. */
  readonly declared: boolean
  /**
   * True for the `inherit-parent` sentinel, which is a legitimate name a task may point at but is
   * not a route and therefore carries no {@link route}.
   */
  readonly inheritsParent: boolean
  /** The resolved route, or `null` for `inherit-parent` and for an assignment the catalog refuses. */
  readonly route: NamedModelRouteView | null
  /** Why there is no route, when there is none: the catalog's own reason. */
  readonly unavailable: string | null
  /** The one line of prose the file writes next to this name, when it writes one. */
  readonly overlayDescription: string | null
  /** Every task key that points at this name, sorted. */
  readonly usedBy: readonly string[]
}

/** One model name inside a task's list. */
export interface TaskModelView {
  readonly name: string
  /** False when the name is neither built-in nor declared; the parser refuses this, the view reports it. */
  readonly known: boolean
}

/** One task container and the name(s) it points at. */
export interface TaskView {
  /** The normalised task key. */
  readonly key: string
  /** True for the four tasks that may list more than one name. */
  readonly panel: boolean
  /** What the file holds for this key. */
  readonly entry: 'absent' | 'inherit' | 'models'
  /**
   * The name(s) as written. Empty for `absent`, and for `inherit` when the file omits the key.
   */
  readonly models: readonly TaskModelView[]
  /** One resolution per name for a panel task; exactly one for every other task. */
  readonly resolved: readonly ResolvedRole[]
  /** The `inherit-parent` sentinel or an empty list was written: stated, not inferred. */
  readonly inheritsParent: boolean
}

/** The stock preference this page must surface and never set. */
export interface ModelSelectionView {
  /** The namespace read (`subagent-model-selection`). */
  readonly namespace: string
  /** False when the namespace is not registered in this composition. */
  readonly present: boolean
  /** The preference's value, or `null` when the namespace is absent or says nothing. */
  readonly enabled: boolean | null
}

/** The GET/PUT payload. Identical for both, so the page renders one shape. */
export interface OverlayView {
  readonly overlayPath: string
  /** The parsed overlay, or `null` when no file exists or the file was rejected. */
  readonly overlay: OverlayFile | null
  /** The file text exactly as it is on disk, for the editor; `null` when no readable file exists. */
  readonly overlayText: string | null
  /** The parser's own message when the file on disk was rejected. */
  readonly overlayError: string | null
  /**
   * Which file version answered. `null` when there is no parsed file. The page uses this to show
   * the version 1 story instead of a task table that would otherwise look complete.
   */
  readonly overlayVersion: 1 | 2 | null
  /**
   * The version 1 sentence, naming the routes that version carried and this build does not apply.
   * `null` for v2 or no file.
   */
  readonly versionNote: string | null
  readonly catalog: RouteCatalog
  /** Everything the catalog could not use, repeated from `catalog.unavailable` for convenience. */
  readonly unavailable: RouteCatalog['unavailable']
  /** Level 1: one entry per named model, declared first and built-ins filled in. */
  readonly models: readonly NamedModelView[]
  /** Level 2: one entry per task key that matters, in `ROLE_KEYS` order. */
  readonly tasks: readonly TaskView[]
  /** Every version 2 task key, in `ROLE_KEYS` order. */
  readonly taskKeys: readonly string[]
  /** Kept as the name of the same list, for a caller that still says "role". */
  readonly roleKeys: readonly string[]
  readonly panelRoles: readonly string[]
  /** Reported, never written. */
  readonly modelSelection: ModelSelectionView
}

/** The result of one request, before it is turned into HTTP. */
export interface HttpResult {
  readonly status: number
  readonly body: unknown
  /** Extra response headers, e.g. `Allow` on a 405. */
  readonly headers?: Readonly<Record<string, string>>
}

/** True for a JSON object that is not an array and not null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  readonly ns: string
  /** The namespace's **resolved** config: schema defaults, then base, then user. */
  readonly value?: unknown
}

/**
 * The `ctx.settings` slice this module reads.
 *
 * `describe()` is the **only** read on this API: `SettingsForms` has no `get(ns)` on 0.2.0-rc.2, and
 * calling one is how the model-selection row used to report `present: false` for every install.
 * Each descriptor carries both the registration proof and the resolved `value`.
 */
export interface SettingsLike {
  describe(): readonly SettingsDescriptorLike[]
}

/**
 * The resolved value of one settings namespace, read the only way this API allows.
 * @param settings - the settings face, which a minimal composition may not have.
 * @param ns - the namespace to read.
 * @returns the resolved value, or `undefined` when the face is absent, the namespace is
 *   unregistered, or the read threw. Callers treat `undefined` uniformly.
 */
export function readSettingsNamespace(settings: SettingsLike | undefined, ns: string): unknown {
  if (settings === undefined || typeof settings.describe !== 'function') return undefined
  try {
    const described = settings.describe()
    if (!Array.isArray(described)) return undefined
    for (const descriptor of described) {
      const row = descriptor as SettingsDescriptorLike | undefined
      if (row?.ns === ns) return row.value
    }
    return undefined
  } catch {
    return undefined
  }
}

export function readModelSelection(settings: SettingsLike | undefined): ModelSelectionView {
  const namespace = MODEL_SELECTION_NAMESPACE
  if (settings === undefined) return { namespace, present: false, enabled: null }
  // Read through `describe()`, the only settings read on this API. The old `settings.get(namespace)`
  // never existed, so this row reported `present: false` for every install — a settings namespace
  // that was in fact present and readable. See `roles/catalog.ts` §"There is no `settings.get`".
  const value = readSettingsNamespace(settings, namespace)
  if (!isRecord(value)) return { namespace, present: false, enabled: null }
  return { namespace, present: true, enabled: typeof value['enabled'] === 'boolean' ? value['enabled'] : null }
}

/** Every name the view lists: declared names in file order, then the built-ins the file does not override. */
function listedModelNames(overlay: OverlayFile | null): readonly string[] {
  const declared = overlay !== null && overlay.version === 2 ? Object.keys(overlay.models) : []
  const builtIns = BUILT_IN_MODEL_NAMES.filter((name) => !declared.includes(name))
  return [...declared, ...builtIns]
}

/** Which tasks point at a name, over both the declared and the built-in assignments. */
function tasksUsingName(overlay: OverlayFileV2, name: string): readonly string[] {
  const users: string[] = []
  for (const [key, names] of Object.entries(overlay.tasks)) {
    if (names.includes(name)) users.push(key)
  }
  return users.sort((left, right) => left.localeCompare(right))
}

/** Resolve one name against the live catalog, or explain why there is no route. */
function namedModelView(name: string, overlay: OverlayFileV2, catalog: RouteCatalog): NamedModelView {
  const declaredEntry: OverlayModel | undefined = Object.hasOwn(overlay.models, name) ? overlay.models[name] : undefined
  const assignment = declaredEntry ?? builtInModel(name)
  const overlayDescription =
    declaredEntry?.description === undefined ? null : declaredEntry.description
  const usedBy = tasksUsingName(overlay, name)

  if (name === INHERIT_PARENT_MODEL) {
    return {
      name,
      builtIn: true,
      declared: declaredEntry !== undefined,
      inheritsParent: true,
      route: null,
      unavailable: null,
      overlayDescription,
      usedBy,
    }
  }
  if (assignment === undefined) {
    // Unreachable through the parser (an unknown name is a parse error) but reachable through a
    // hand-built overlay, and the page must report rather than assume.
    return {
      name,
      builtIn: isBuiltInModelName(name),
      declared: declaredEntry !== undefined,
      inheritsParent: false,
      route: null,
      unavailable: 'neither built-in nor declared under "models"',
      overlayDescription,
      usedBy,
    }
  }

  const honoured = describeRoute(catalog, assignment)
  if (!honoured.ok) {
    return {
      name,
      builtIn: isBuiltInModelName(name),
      declared: declaredEntry !== undefined,
      inheritsParent: false,
      route: null,
      unavailable: honoured.why,
      overlayDescription,
      usedBy,
    }
  }
  return {
    name,
    builtIn: isBuiltInModelName(name),
    declared: declaredEntry !== undefined,
    inheritsParent: false,
    route: {
      provider: honoured.provider,
      model: honoured.model,
      reasoningEffort: assignment.reasoningEffort ?? null,
      efforts: honoured.efforts,
      defaultEffort: honoured.defaultEffort ?? null,
      description: findRoute(catalog, honoured.provider, honoured.model)?.description ?? null,
    },
    unavailable: null,
    overlayDescription,
    usedBy,
  }
}

/** The task-level view for one key. */
function taskView(key: string, overlay: OverlayFile | null, catalog: RouteCatalog): TaskView {
  const panel = isPanelRole(key)
  const v2 = overlay !== null && overlay.version === 2 ? overlay : null
  const names = v2 === null ? undefined : (v2.tasks[key] ?? undefined)

  if (v2 === null) {
    // A version 1 file has no tasks. Reporting `inherit` for every key is what the resolver does,
    // and `versionNote` is where the file says why.
    return {
      key,
      panel,
      entry: 'inherit',
      models: [],
      resolved: [resolveRole(key, overlay ?? undefined, catalog)],
      inheritsParent: true,
    }
  }
  if (names === undefined) {
    return {
      key,
      panel,
      entry: 'absent',
      models: [],
      resolved: [resolveRole(key, v2, catalog)],
      inheritsParent: true,
    }
  }
  if (names.length === 0) {
    return { key, panel, entry: 'inherit', models: [], resolved: [resolveRole(key, v2, catalog)], inheritsParent: true }
  }

  const models: TaskModelView[] = names.map((name) => ({
    name,
    known: namedModelAssignment(name, v2) !== undefined || name === INHERIT_PARENT_MODEL,
  }))
  return {
    key,
    panel,
    entry: 'models',
    models,
    resolved: panel ? resolvePanel(key, v2, catalog) : [resolveRole(key, v2, catalog)],
    inheritsParent: names.length === 1 && names[0] === INHERIT_PARENT_MODEL,
  }
}

/**
 * Build the payload both routes answer with: the file, the live catalog, and the two-level view.
 * @param sources - the injected faces.
 * @param refresh - re-enumerate the catalog instead of using the resolver's cache.
 * @returns the view.
 */
export async function buildOverlayView(sources: OverlayHttpSources, refresh = false): Promise<OverlayView> {
  const [loaded, catalog] = await Promise.all([sources.loadOverlay(), sources.catalog(refresh)])
  const overlayText = sources.readOverlayText === undefined ? null : await sources.readOverlayText()
  const overlay = loaded.ok ? (loaded.value ?? null) : null
  const overlayError = loaded.ok ? null : loaded.error
  // An unusable file is treated as absent for resolution, which is the one-route behaviour
  // `plugin/HARNESS.md` §Rules 3 asks for; `overlayError` is what tells the reader why.
  const effective = overlay ?? undefined
  const v2 = overlay !== null && overlay.version === 2 ? overlay : null

  const models: NamedModelView[] =
    v2 === null
      ? []
      : listedModelNames(overlay).map((name) => namedModelView(name, v2, catalog))

  return {
    overlayPath: sources.overlayPath,
    overlay,
    overlayText,
    overlayError,
    overlayVersion: overlay === null ? null : overlay.version,
    versionNote: overlayVersionNote(effective) ?? null,
    catalog,
    unavailable: catalog.unavailable,
    models,
    tasks: ROLE_KEYS.map((key) => taskView(key, overlay, catalog)),
    taskKeys: [...ROLE_KEYS],
    roleKeys: [...ROLE_KEYS],
    panelRoles: [...PANEL_ROLES],
    modelSelection: readModelSelection(sources.settings),
  }
}

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
export function validateOverlayAgainstCatalog(
  overlay: OverlayFile,
  catalog: RouteCatalog,
): { readonly ok: true } | { readonly ok: false; readonly problems: readonly string[] } {
  const problems: string[] = []

  if (overlay.version === 1) {
    for (const [key, entry] of Object.entries(overlay.roles)) {
      if ('inherit' in entry) continue
      for (const [index, route] of entry.routes.entries()) {
        const honoured = describeRoute(catalog, route)
        if (!honoured.ok) problems.push(`role "${key}" route ${index + 1}: ${honoured.why}`)
      }
    }
    return problems.length === 0 ? { ok: true } : { ok: false, problems }
  }

  for (const [name, assignment] of Object.entries(overlay.models)) {
    const honoured = describeRoute(catalog, assignment)
    if (!honoured.ok) problems.push(`model "${name}": ${honoured.why}`)
  }

  for (const [key, names] of Object.entries(overlay.tasks)) {
    if (names.length > 1 && !isPanelRole(key)) {
      problems.push(
        `task "${key}": lists ${String(names.length)} model names but "${key}" is not a panel role; ` +
          `only ${PANEL_ROLES.join(', ')} may list more than one name`,
      )
    }
    for (const name of names) {
      if (name === INHERIT_PARENT_MODEL) continue
      const assignment = namedModelAssignment(name, overlay)
      if (assignment === undefined) {
        problems.push(
          `task "${key}": names the model "${name}", which is neither built-in nor declared under "models" ` +
            `(built-in: ${BUILT_IN_MODEL_NAMES.join(', ')})`,
        )
        continue
      }
      const honoured = describeRoute(catalog, assignment)
      if (!honoured.ok) problems.push(`task "${key}": model "${name}" — ${honoured.why}`)
    }
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems }
}

/**
 * Replace `path` with `text` in one atomic step: a random-suffix `wx` sibling carrying the mode,
 * then a rename over the target. Mirrors `dsh-atomic-write/lib/index.js` so a half-written overlay
 * can never land, and so replacing a wider-permission file narrows it without a chmod race.
 * @param path - the file to replace.
 * @param text - the complete next content.
 * @param options - permission bits; defaults to the DSH_HOME document precedent.
 */
export async function writeTextAtomic(
  path: string,
  text: string,
  options: { readonly mode?: number; readonly dirMode?: number } = {},
): Promise<void> {
  const mode = options.mode ?? OVERLAY_FILE_MODE
  const dirMode = options.dirMode ?? OVERLAY_DIR_MODE
  await mkdir(dirname(path), { recursive: true, mode: dirMode })
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, text, { mode, flag: 'wx' })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** The GET half, as a status + body. Pure with respect to the injected faces. */
export async function handleOverlayGet(sources: OverlayHttpSources, refresh = false): Promise<HttpResult> {
  return { status: 200, body: await buildOverlayView(sources, refresh) }
}

/**
 * Collect a request body up to `maxBytes`, draining the stream either way.
 *
 * A body over the limit is reported rather than truncated-and-accepted: `tooLarge` makes the PUT
 * answer 413 and write nothing.
 * @param req - the request.
 * @param maxBytes - the cap.
 * @returns the text, and whether the cap was passed.
 */
export function readBody(req: HttpRequestLike, maxBytes = MAX_OVERLAY_BODY_BYTES): Promise<{ text: string; tooLarge: boolean }> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        tooLarge = true
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), tooLarge }))
    req.on('error', () => resolve({ text: '', tooLarge }))
  })
}

/** Write one JSON response with the no-store policy the other API routes use. */
export function sendJson(res: HttpResponseLike, result: HttpResult): void {
  res.statusCode = result.status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value)
  res.end(`${JSON.stringify(result.body)}\n`)
}

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
export function createOverlayRoute(sources: OverlayHttpSources): WebRouteLike {
  return {
    kind: 'exact',
    path: OVERLAY_ROUTE_PATH,
    handler: async (req, res) => {
      const method = (req.method ?? 'GET').toUpperCase()
      if (method === 'GET') {
        const raw = req.url ?? ''
        const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : ''
        const refresh = new URLSearchParams(query).get('refresh') === '1'
        try {
          sendJson(res, await handleOverlayGet(sources, refresh))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          sources.logger?.warn?.(`pstack: GET ${OVERLAY_ROUTE_PATH} failed: ${message}`)
          sendJson(res, { status: 500, body: { ok: false, error: message } })
        }
        return
      }
      sendJson(res, {
        status: 405,
        headers: { allow: 'GET' },
        body: {
          ok: false,
          error:
            `${method} is not supported on ${OVERLAY_ROUTE_PATH}; this route reads the overlay the spawn path ` +
            `resolves. Writes go to /api/pstack/fleet (FLEET_ROUTE_PATH in src/settings/fleet-http.ts), which ` +
            'derives this file from the fleet groups file — ' +
            'a write here would be reverted by the next reconciliation.',
        },
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
export function registerOverlayRoute(webServer: WebServerLike, sources: OverlayHttpSources): () => void {
  return webServer.register(createOverlayRoute(sources))
}

/** `UNAVAILABLE_REASON_PREFIX` re-exported so the client half and its tests share one literal. */
export { UNAVAILABLE_REASON_PREFIX }
