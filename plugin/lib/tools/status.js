/**
 * `pstack_status` — the Phase 2 tool-registration proof.
 *
 * It is deliberately a *diagnostic*, not the Phase 4 spawn tool: it answers a real question
 * ("is this plugin live in this Host, and what does it see on disk?") using only reads, so a
 * Host session calling it proves three things at once — the plugin's `apply()` ran, the tool
 * registry accepted our definition, and the same skills directory the provider scans is
 * readable.
 *
 * `defineTool` (`@deepseek-ai/dsh-tools/lib/types/schema.d.ts:239`) is a DSH internal this
 * package must not depend on, so the definition is written as the raw shape the registry
 * validates. Registration checks `output { schema, render }`
 * (`dsh-tools/lib/index.js:2773`) against the supported JSON Schema subset
 * (`assertSupportedJsonSchema` :322, object tail :151) — which is why `required` below is the
 * JSON-Schema array and not `defineTool`'s per-property `required: true`. `parameters` mirrors
 * what `defineTool` compiles for an empty parameter map
 * (`parameterSchemaSpecToJsonSchema` :802).
 *
 * The one thing this trades away: `defineTool` also wraps `execute` in
 * `validateJsonSchemaValue` (`dsh-tools/lib/index.js:846`-`:860`). With no parameters there is
 * nothing to validate, so the wrapper would be inert here. A tool with arguments would need
 * that validation re-implemented, not skipped.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFleetGroups } from "../roles/fleet-groups.js";
import { isSkillName } from "../skills/frontmatter.js";
/** Model-facing tool name. */
export const PSTACK_STATUS_TOOL = 'pstack_status';
/**
 * The output schema, in the enforced subset. Object roots use a JSON-Schema `required` array;
 * every object declares `additionalProperties` (mandatory for explicit object nodes).
 */
const STATUS_VALUE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        plugin: { type: 'string', description: 'Plugin that produced this report.' },
        bootMarker: { type: 'string', description: 'Literal the plugin logs when apply() runs.' },
        overlayPath: { type: 'string', description: 'Overlay file the plugin resolved at boot.' },
        overlayPresent: { type: 'boolean', description: 'Whether that overlay file exists.' },
        overlayRoles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Top-level keys of the overlay, empty when absent or not a JSON object.',
        },
        groupsPath: {
            type: 'string',
            description: 'Fleet groups file the plugin resolved at boot; empty when the caller configured none.',
        },
        groupsViolins: {
            type: 'array',
            items: { type: 'string' },
            description: 'Violin ids in the groups file, in file order; an id is the model name in the overlay. ' +
                'Empty when the file is absent or was rejected.',
        },
        skillsDirectory: { type: 'string', description: 'Directory scanned for bundled skills.' },
        skillNames: {
            type: 'array',
            items: { type: 'string' },
            description: 'Kebab-case names of the bundled skills found there.',
        },
        notes: { type: 'array', items: { type: 'string' }, description: 'Anything worth flagging.' },
    },
    required: [
        'plugin',
        'bootMarker',
        'overlayPath',
        'overlayPresent',
        'overlayRoles',
        'groupsPath',
        'groupsViolins',
        'skillsDirectory',
        'skillNames',
        'notes',
    ],
};
/** Read the overlay's top-level keys. Never throws: a broken overlay is a `note`, not an error. */
async function readOverlay(overlayPath) {
    try {
        await stat(overlayPath);
    }
    catch (error) {
        const code = error?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR')
            return { present: false, roles: [] };
        return { present: true, roles: [], note: `overlay unreadable: ${String(error)}` };
    }
    try {
        const parsed = JSON.parse(await readFile(overlayPath, 'utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return { present: true, roles: [], note: 'overlay is not a JSON object; no roles read' };
        }
        return { present: true, roles: Object.keys(parsed) };
    }
    catch (error) {
        return { present: true, roles: [], note: `overlay is not valid JSON: ${String(error)}` };
    }
}
/**
 * Read the violin ids the groups file declares. Never throws: a missing file is absent with no note,
 * a broken one is a note.
 *
 * The judge is `parseFleetGroups`, the same parser the settings page loads with, so this report can
 * never call a file usable that the page would refuse — or refuse one the page would serve. That is
 * why the file is read once as text rather than stat'ed first: the parser needs the text anyway.
 */
async function readGroups(groupsPath) {
    // No path at all: a caller that reports on the overlay alone. Nothing is read, so nothing is claimed.
    if (groupsPath.length === 0)
        return { present: false, violins: [] };
    let text;
    try {
        text = await readFile(groupsPath, 'utf8');
    }
    catch (error) {
        const code = error?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR')
            return { present: false, violins: [] };
        return { present: true, violins: [], note: `fleet groups file unreadable: ${String(error)}` };
    }
    const parsed = parseFleetGroups(text);
    if (!parsed.ok)
        return { present: true, violins: [], note: `fleet groups file rejected: ${parsed.error}` };
    return { present: true, violins: parsed.value.violins.map((violin) => violin.id) };
}
/** Scan the bundled skill directory for kebab-case names. Never throws. */
async function readSkillNames(skillsDir) {
    let entries;
    try {
        entries = await readdir(skillsDir, { withFileTypes: true });
    }
    catch (error) {
        return { names: [], note: `skill directory unreadable: ${String(error)}` };
    }
    const names = [];
    const notes = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        if (!isSkillName(entry.name)) {
            notes.push(`skill directory "${entry.name}" is not kebab-case and would be skipped`);
            continue;
        }
        names.push(entry.name);
    }
    return { names: names.sort(), ...(notes.length === 0 ? {} : { note: notes.join('; ') }) };
}
/**
 * Build the report value. Pure reads; safe to call from a Host session.
 * @param options - paths and the boot marker to report.
 * @param exec - tool run context, used only to honour cancellation.
 * @returns the status value declared by {@link STATUS_VALUE_SCHEMA}.
 */
export async function describePstackStatus(options, exec = {}) {
    exec.signal?.throwIfAborted();
    const groupsPath = options.groupsPath ?? '';
    const overlay = await readOverlay(options.overlayPath);
    const groups = await readGroups(groupsPath);
    const skills = await readSkillNames(options.skillsDir);
    exec.signal?.throwIfAborted();
    const notes = [overlay.note, groups.note, skills.note].filter((note) => note !== undefined);
    if (overlay.present)
        notes.unshift('overlay parsing reads top-level keys only; role semantics are not defined yet');
    // An install with an overlay but no groups file is not broken: the overlay is then the whole truth,
    // and the violin page writes the groups file the first time it loads. Worth saying, so a reader does
    // not go looking for a second file's contents.
    if (groupsPath.length > 0 && !groups.present && overlay.present) {
        notes.push('fleet groups file is absent; the overlay is the whole truth, and the violin page writes the groups file on its first load');
    }
    return {
        plugin: options.pluginName,
        bootMarker: options.bootMarker,
        overlayPath: options.overlayPath,
        overlayPresent: overlay.present,
        overlayRoles: overlay.roles,
        groupsPath,
        groupsViolins: groups.violins,
        skillsDirectory: options.skillsDir,
        skillNames: skills.names,
        notes,
    };
}
/**
 * Create the registry-ready tool definition.
 * @param options - paths and the boot marker to report.
 * @returns a definition for `ctx.tools.register`, validated by the registry at registration.
 */
export function createPstackStatusTool(options) {
    return {
        name: PSTACK_STATUS_TOOL,
        description: 'Report whether the dsh-pstack plugin is live in this Host: its boot marker, the overlay file it resolved, ' +
            'the fleet groups file the violin page edits, and the bundled skills it can see on disk. ' +
            'Read-only; takes no arguments.',
        parameters: { type: 'object', properties: {} },
        output: {
            schema: STATUS_VALUE_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        execute: (args, exec) => describePstackStatus(options, exec),
    };
}
