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
import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { findRoute } from "../roles/catalog.js";
import { BUILT_IN_MODEL_NAMES, builtInModel, describeRoute, INHERIT_PARENT_MODEL, isPanelRole, isBuiltInModelName, namedModelAssignment, overlayVersionNote, PANEL_ROLES, parseOverlay, resolvePanel, resolveRole, ROLE_KEYS, routeLabel, serializeOverlay, UNAVAILABLE_REASON_PREFIX, } from "../roles/overlay.js";
/** The one route this unit registers. Namespaced under `/api/pstack/` like every other surface. */
export const OVERLAY_ROUTE_PATH = '/api/pstack/overlay';
/** Largest overlay body accepted, in bytes. A model/task table is small; anything larger is a mistake. */
export const MAX_OVERLAY_BODY_BYTES = 64 * 1024;
/** File mode for the overlay document: owner read/write, the DSH_HOME document precedent. */
export const OVERLAY_FILE_MODE = 0o600;
/** Directory mode for the overlay's parent, matching the same precedent. */
export const OVERLAY_DIR_MODE = 0o700;
/** A parent-resolved settings namespace holding one preference this page only *reports*. */
export const MODEL_SELECTION_NAMESPACE = 'subagent-model-selection';
/** True for a JSON object that is not an array and not null. */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * The resolved value of one settings namespace, read the only way this API allows.
 * @param settings - the settings face, which a minimal composition may not have.
 * @param ns - the namespace to read.
 * @returns the resolved value, or `undefined` when the face is absent, the namespace is
 *   unregistered, or the read threw. Callers treat `undefined` uniformly.
 */
export function readSettingsNamespace(settings, ns) {
    if (settings === undefined || typeof settings.describe !== 'function')
        return undefined;
    try {
        const described = settings.describe();
        if (!Array.isArray(described))
            return undefined;
        for (const descriptor of described) {
            const row = descriptor;
            if (row?.ns === ns)
                return row.value;
        }
        return undefined;
    }
    catch {
        return undefined;
    }
}
export function readModelSelection(settings) {
    const namespace = MODEL_SELECTION_NAMESPACE;
    if (settings === undefined)
        return { namespace, present: false, enabled: null };
    // Read through `describe()`, the only settings read on this API. The old `settings.get(namespace)`
    // never existed, so this row reported `present: false` for every install — a settings namespace
    // that was in fact present and readable. See `roles/catalog.ts` §"There is no `settings.get`".
    const value = readSettingsNamespace(settings, namespace);
    if (!isRecord(value))
        return { namespace, present: false, enabled: null };
    return { namespace, present: true, enabled: typeof value['enabled'] === 'boolean' ? value['enabled'] : null };
}
/** Every name the view lists: declared names in file order, then the built-ins the file does not override. */
function listedModelNames(overlay) {
    const declared = overlay !== null && overlay.version === 2 ? Object.keys(overlay.models) : [];
    const builtIns = BUILT_IN_MODEL_NAMES.filter((name) => !declared.includes(name));
    return [...declared, ...builtIns];
}
/** Which tasks point at a name, over both the declared and the built-in assignments. */
function tasksUsingName(overlay, name) {
    const users = [];
    for (const [key, names] of Object.entries(overlay.tasks)) {
        if (names.includes(name))
            users.push(key);
    }
    return users.sort((left, right) => left.localeCompare(right));
}
/** Resolve one name against the live catalog, or explain why there is no route. */
function namedModelView(name, overlay, catalog) {
    const declaredEntry = Object.hasOwn(overlay.models, name) ? overlay.models[name] : undefined;
    const assignment = declaredEntry ?? builtInModel(name);
    const overlayDescription = declaredEntry?.description === undefined ? null : declaredEntry.description;
    const usedBy = tasksUsingName(overlay, name);
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
        };
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
        };
    }
    const honoured = describeRoute(catalog, assignment);
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
        };
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
    };
}
/** The task-level view for one key. */
function taskView(key, overlay, catalog) {
    const panel = isPanelRole(key);
    const v2 = overlay !== null && overlay.version === 2 ? overlay : null;
    const names = v2 === null ? undefined : (v2.tasks[key] ?? undefined);
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
        };
    }
    if (names === undefined) {
        return {
            key,
            panel,
            entry: 'absent',
            models: [],
            resolved: [resolveRole(key, v2, catalog)],
            inheritsParent: true,
        };
    }
    if (names.length === 0) {
        return { key, panel, entry: 'inherit', models: [], resolved: [resolveRole(key, v2, catalog)], inheritsParent: true };
    }
    const models = names.map((name) => ({
        name,
        known: namedModelAssignment(name, v2) !== undefined || name === INHERIT_PARENT_MODEL,
    }));
    return {
        key,
        panel,
        entry: 'models',
        models,
        resolved: panel ? resolvePanel(key, v2, catalog) : [resolveRole(key, v2, catalog)],
        inheritsParent: names.length === 1 && names[0] === INHERIT_PARENT_MODEL,
    };
}
/**
 * Build the payload both routes answer with: the file, the live catalog, and the two-level view.
 * @param sources - the injected faces.
 * @param refresh - re-enumerate the catalog instead of using the resolver's cache.
 * @returns the view.
 */
export async function buildOverlayView(sources, refresh = false) {
    const [loaded, catalog] = await Promise.all([sources.loadOverlay(), sources.catalog(refresh)]);
    const overlayText = sources.readOverlayText === undefined ? null : await sources.readOverlayText();
    const overlay = loaded.ok ? (loaded.value ?? null) : null;
    const overlayError = loaded.ok ? null : loaded.error;
    // An unusable file is treated as absent for resolution, which is the one-route behaviour
    // `plugin/HARNESS.md` §Rules 3 asks for; `overlayError` is what tells the reader why.
    const effective = overlay ?? undefined;
    const v2 = overlay !== null && overlay.version === 2 ? overlay : null;
    const models = v2 === null
        ? []
        : listedModelNames(overlay).map((name) => namedModelView(name, v2, catalog));
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
    };
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
export function validateOverlayAgainstCatalog(overlay, catalog) {
    const problems = [];
    if (overlay.version === 1) {
        for (const [key, entry] of Object.entries(overlay.roles)) {
            if ('inherit' in entry)
                continue;
            for (const [index, route] of entry.routes.entries()) {
                const honoured = describeRoute(catalog, route);
                if (!honoured.ok)
                    problems.push(`role "${key}" route ${index + 1}: ${honoured.why}`);
            }
        }
        return problems.length === 0 ? { ok: true } : { ok: false, problems };
    }
    for (const [name, assignment] of Object.entries(overlay.models)) {
        const honoured = describeRoute(catalog, assignment);
        if (!honoured.ok)
            problems.push(`model "${name}": ${honoured.why}`);
    }
    for (const [key, names] of Object.entries(overlay.tasks)) {
        if (names.length > 1 && !isPanelRole(key)) {
            problems.push(`task "${key}": lists ${String(names.length)} model names but "${key}" is not a panel role; ` +
                `only ${PANEL_ROLES.join(', ')} may list more than one name`);
        }
        for (const name of names) {
            if (name === INHERIT_PARENT_MODEL)
                continue;
            const assignment = namedModelAssignment(name, overlay);
            if (assignment === undefined) {
                problems.push(`task "${key}": names the model "${name}", which is neither built-in nor declared under "models" ` +
                    `(built-in: ${BUILT_IN_MODEL_NAMES.join(', ')})`);
                continue;
            }
            const honoured = describeRoute(catalog, assignment);
            if (!honoured.ok)
                problems.push(`task "${key}": model "${name}" — ${honoured.why}`);
        }
    }
    return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
/**
 * Replace `path` with `text` in one atomic step: a random-suffix `wx` sibling carrying the mode,
 * then a rename over the target. Mirrors `dsh-atomic-write/lib/index.js` so a half-written overlay
 * can never land, and so replacing a wider-permission file narrows it without a chmod race.
 * @param path - the file to replace.
 * @param text - the complete next content.
 * @param options - permission bits; defaults to the DSH_HOME document precedent.
 */
export async function writeTextAtomic(path, text, options = {}) {
    const mode = options.mode ?? OVERLAY_FILE_MODE;
    const dirMode = options.dirMode ?? OVERLAY_DIR_MODE;
    await mkdir(dirname(path), { recursive: true, mode: dirMode });
    const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
        await writeFile(temp, text, { mode, flag: 'wx' });
        await rename(temp, path);
    }
    catch (error) {
        await rm(temp, { force: true });
        throw error;
    }
}
/** The GET half, as a status + body. Pure with respect to the injected faces. */
export async function handleOverlayGet(sources, refresh = false) {
    return { status: 200, body: await buildOverlayView(sources, refresh) };
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
export function readBody(req, maxBytes = MAX_OVERLAY_BODY_BYTES) {
    return new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        let tooLarge = false;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                tooLarge = true;
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), tooLarge }));
        req.on('error', () => resolve({ text: '', tooLarge }));
    });
}
/** Write one JSON response with the no-store policy the other API routes use. */
export function sendJson(res, result) {
    res.statusCode = result.status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    for (const [name, value] of Object.entries(result.headers ?? {}))
        res.setHeader(name, value);
    res.end(`${JSON.stringify(result.body)}\n`);
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
export function createOverlayRoute(sources) {
    return {
        kind: 'exact',
        path: OVERLAY_ROUTE_PATH,
        handler: async (req, res) => {
            const method = (req.method ?? 'GET').toUpperCase();
            if (method === 'GET') {
                const raw = req.url ?? '';
                const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
                const refresh = new URLSearchParams(query).get('refresh') === '1';
                try {
                    sendJson(res, await handleOverlayGet(sources, refresh));
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    sources.logger?.warn?.(`pstack: GET ${OVERLAY_ROUTE_PATH} failed: ${message}`);
                    sendJson(res, { status: 500, body: { ok: false, error: message } });
                }
                return;
            }
            sendJson(res, {
                status: 405,
                headers: { allow: 'GET' },
                body: {
                    ok: false,
                    error: `${method} is not supported on ${OVERLAY_ROUTE_PATH}; this route reads the overlay the spawn path ` +
                        `resolves. Writes go to /api/pstack/fleet (FLEET_ROUTE_PATH in src/settings/fleet-http.ts), which ` +
                        'derives this file from the fleet groups file — ' +
                        'a write here would be reverted by the next reconciliation.',
                },
            });
        },
    };
}
/**
 * Register the route and return the disposer `webServer.register` answered with.
 * @param webServer - `ctx.webServer`.
 * @param sources - the injected faces.
 * @returns the registration disposer.
 */
export function registerOverlayRoute(webServer, sources) {
    return webServer.register(createOverlayRoute(sources));
}
/** `UNAVAILABLE_REASON_PREFIX` re-exported so the client half and its tests share one literal. */
export { UNAVAILABLE_REASON_PREFIX };
