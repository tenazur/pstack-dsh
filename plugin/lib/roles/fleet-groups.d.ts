/**
 * The fleet groups file: **violins**, and the projection of them onto the overlay.
 *
 * ## Why a second file exists at all
 *
 * The overlay (`$DSH_HOME/pstack.json`, `plugin/src/roles/overlay.ts`) answers one question and
 * answers it well: *which route does this task run on*. It cannot answer the question a person
 * actually asks when they open the settings page — *what is this group of models for, and which
 * tasks belong to it* — because its `models` block is a flat bag of names and its `tasks` block is
 * a flat bag of pointers. The groups file carries the missing structure:
 *
 * - a **violin** has an identity (`id`), a place in the page (`origin`), **one or more model
 *   selections** (`provider` + `model` + effort), and the **tasks assigned to it**;
 * - predefined violins exist from the first run and cannot be deleted, only edited;
 * - one task belongs to exactly one violin, and a violin may hold many tasks;
 * - a task in no violin is **unassigned**, and runs on the `general` violin.
 *
 * The two files are not two truths: the groups file is the source of truth for everything the page
 * edits, and the overlay is **derived** from it by {@link toOverlay}. That derivation is a pure
 * function, which is what makes "editing settings from the settings UI updates the old-style
 * settings" a property of the code rather than a habit: the spawn path (`resolveRole`,
 * `resolvePanel`, `pstack_spawn`, the ported skills) never learns violins exist.
 *
 * ## Two kinds of violin, and the rule that tells them apart
 *
 * A violin's `id` is the model name the overlay declares. What the violin **is** decides how the
 * overlay reads it:
 *
 * - a **single-model violin** is a place to put tasks: its `tasks` list holds the keys assigned to
 *   it, and it writes `models[id]`;
 * - a **comparison violin** is itself the task. Its id is a panel task key, and
 *   its selections are what that task runs — one child per name for a fan-out
 *   (`arena-runners`, `architect-runners`, `interrogate-reviewers`) or one name chosen from the list
 *   for a pool (`arena-cross-judge-pool`). It therefore holds **no tasks**: a pointer from the task
 *   to itself would say nothing, and the page would show a violin wearing its own name as a chip.
 *
 * A comparison violin with several selections writes `models[id-1] … models[id-n]`, because the
 * overlay's `tasks` values are lists of **names** and the same name twice would state nothing about
 * which selection it meant. Numbers keep the mapping reversible, which is what {@link fromOverlay}
 * relies on.
 *
 * ## What is deliberately heuristic, and what is not
 *
 * {@link defaultGroups} has to put *some* route in each predefined violin, and this package may
 * never write a slug it did not read from the live catalog. So the rule
 * is: choose among enumerated routes only, by matching documented word-hints against the route's
 * model id and the adapter's own description. Nothing is constructed, nothing is remembered, and a
 * violin whose capability the catalog does not offer is left with **no selection** and says so,
 * rather than pointing at a model that cannot do the job. Every heuristic is in one table below,
 * so it can be argued with.
 *
 * ## What the parser refuses, by name
 *
 * Every rejection names the offender: the violin, the task, the route, the effort. A task in two
 * violins, a violin with several models holding a task that may name only one, a selection the live
 * catalog does not have, an effort the route does not advertise, an empty name, a duplicate id.
 * `plugin/src/roles/overlay.ts` re-checks the derived document against the same catalog on write,
 * so a hole here cannot become a file the host would refuse.
 */
import type { RouteCatalog } from './catalog.ts';
import type { OverlayFile, OverlayFileV2 } from './overlay.ts';
/** One `provider + model + effort` a violin can run a child on. */
export interface ViolinSelection {
    readonly provider: string;
    readonly model: string;
    /**
     * The effort that is part of this selection. `off` is a value, not an omission: writing it means
     * "run with reasoning off", while omitting it means "let the adapter materialise its default".
     */
    readonly reasoningEffort?: string;
    /** One line of prose the page shows next to the selection. */
    readonly description?: string;
}
/** Where a violin came from. Predefined violins cannot be deleted; custom ones can. */
export type ViolinOrigin = 'predefined' | 'comparison' | 'custom';
/** One violin: a named group of model selections that owns some tasks. */
export interface Violin {
    /** The model name this violin declares in the overlay. Also the page's key for it. */
    readonly id: string;
    /** The label the page shows. Equal to {@link id} for a predefined violin. */
    readonly name: string;
    readonly origin: ViolinOrigin;
    /** One selection for a plain violin, several for a comparison violin. Empty is legal. */
    readonly selections: readonly ViolinSelection[];
    /** The task keys assigned to this violin. A task appears in at most one violin. */
    readonly tasks: readonly string[];
}
/** The groups file. Every field is written by this build; nothing else is preserved. */
export interface FleetGroupsFile {
    readonly version: 1;
    readonly violins: readonly Violin[];
}
/**
 * The five violins that exist before anyone edits anything, in the order the page lists them.
 *
 * `general` is the fallback every unassigned task runs on, which is why it is first and why it can
 * never be deleted. The other four are the shapes of work a fleet needs: something that works,
 * something that plans, something cheap to fan out, something that can see.
 */
export declare const PREDEFINED_VIOLIN_IDS: readonly ["general", "working", "planning", "fast", "vision"];
/** One predefined violin's identity. */
export type PredefinedViolinId = (typeof PREDEFINED_VIOLIN_IDS)[number];
/** True for a name that is one of the five single-selection violins. */
export declare function isPredefinedViolinId(id: string): id is PredefinedViolinId;
/** True for a violin whose task key is a comparison container. */
export declare function isComparisonViolinId(id: string): boolean;
/** The route the session itself runs, when the caller can read it (`agent-default-model`). */
export interface SessionDefaultRoute {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}
/** Options for {@link defaultGroups}. */
export interface DefaultGroupsOptions {
    /** The live route inventory. Nothing is chosen that is not in here. */
    readonly catalog: RouteCatalog;
    /** The session's own default route, used for `general` before any heuristic is tried. */
    readonly sessionDefault?: SessionDefaultRoute | undefined;
}
/**
 * The default fleet: five single-selection violins and one comparison violin per panel task.
 *
 * The rules, in order, all over enumerated routes only:
 *
 * 1. `general` — the session's own default route when the catalog has it, else the catalog's first
 *    route, at the session's configured effort when that route advertises it. This is the route a
 *    child would inherit anyway, which is what makes `general` the honest fallback.
 * 2. `working` — the same route as `general`, at {@link EFFORT_PREFERENCE}.working. "The model you
 *    are already talking to, thinking harder" is a defensible default for the tasks that write code.
 * 3. `planning`, `fast`, `vision` — {@link routeMatching} with their hint table, avoiding
 *    `general`'s route when another route matches, at their own preferred effort. A capability the
 *    catalog does not offer leaves the violin **empty**: no selection, and the page says so.
 * 4. each of the four comparison violins ({@link PANEL_ROLES}) holds two selections and **no tasks**
 *    — `planning`'s and `working`'s — which is cross-family on a two-family catalog and
 *    same-family here. The page states the fan-out width; what that
 *    means when the routes are the same is stated where the width is chosen.
 * 5. every task in {@link TASK_PLACEMENT} is placed, and the table covers **all** of `ROLE_KEYS`
 *    except the four comparison keys, which belong to their own violins. A fresh fleet therefore has
 *    an empty unassigned band: nothing is left running on a route nobody chose for it.
 *
 * @param options - the live catalog and, optionally, the session's own route.
 * @returns the groups a fresh install starts from.
 */
export declare function defaultGroups(options: DefaultGroupsOptions): FleetGroupsFile;
/** Parse result. `error` is written to be shown to the person who hand-edited the file. */
export type ParseGroupsResult = {
    readonly ok: true;
    readonly value: FleetGroupsFile;
} | {
    readonly ok: false;
    readonly error: string;
};
/**
 * Parse a groups file. Never throws; every rejection carries a message written for the person who
 * edited the file, and every message names the violin or the key that is wrong.
 * @param text - the file's contents.
 * @returns the parsed file, or the reason it was rejected.
 */
export declare function parseFleetGroups(text: string): ParseGroupsResult;
/**
 * The file's text. `parseFleetGroups(serializeFleetGroups(value))` returns an equal value, and the
 * 2-space indent plus trailing newline is what makes the file hand-editable.
 * @param value - the file to write.
 * @returns the file's text.
 */
export declare function serializeFleetGroups(value: FleetGroupsFile): string;
/**
 * The catalogue-checked problems in a group set: what the live catalog cannot honour.
 *
 * This is the write-time half of the rule "a route that is not currently usable is
 * **rejected on write**". Every problem names the violin, the selection and
 * what the catalog would accept instead. The overlay validator runs too — it catches a task-side
 * problem this function has no view of — so a document that passes here is not yet a document the
 * host will accept, and {@link toOverlay} plus `validateOverlayAgainstCatalog` is the full gate.
 * @param groups - the group set.
 * @param catalog - the live inventory.
 * @returns every problem found, in violin order.
 */
export declare function violinProblems(groups: FleetGroupsFile, catalog: RouteCatalog): readonly string[];
/** The model names a violin declares in the overlay: `<id>`, or `<id>-1 … <id>-n` for several. */
export declare function violinModelNames(violin: Violin): readonly string[];
/**
 * Project the groups onto the overlay the spawn path reads.
 *
 * The rules, all of them:
 *
 * 1. a violin with no selection declares no model, and its tasks point at `inherit-parent` — the
 *    honest degradation, because a name with no assignment is a file the parser refuses;
 * 2. a violin with selections declares one model entry per selection, named by
 *    {@link violinModelNames};
 * 3. every task key in `taskKeys` gets an entry: the names of its violin, or `["general"]` when the
 *    task is in no violin (the fallback the human asked for), or `["inherit-parent"]` when no
 *    violin can serve it at all;
 * 4. a task key a violin holds that is not in `taskKeys` is still written — the parser must not
 *    silently drop a hand-written key;
 * 5. the order of `taskKeys` is the order of the file, so a diff is readable.
 *
 * @param groups - the group set.
 * @param taskKeys - every task key the build knows, in `ROLE_KEYS` order.
 * @returns the version 2 overlay.
 */
export declare function toOverlay(groups: FleetGroupsFile, taskKeys: readonly string[]): OverlayFileV2;
/**
 * Every task key in `taskKeys` that is in no violin **and has no violin of its own**.
 *
 * A comparison key is never listed: `arena-runners` is served by the violin named `arena-runners`,
 * so calling it unassigned would be the page telling a person to assign a task that is already
 * routed. "Unassigned" here means exactly "runs on `general` because nobody chose otherwise".
 * @param groups - the group set.
 * @param taskKeys - every task key the build knows.
 * @returns the unassigned keys, in `taskKeys` order.
 */
export declare function unassignedTasks(groups: FleetGroupsFile, taskKeys: readonly string[]): readonly string[];
/** The violin holding a task, or `undefined`. */
export declare function violinOfTask(groups: FleetGroupsFile, task: string): Violin | undefined;
/**
 * A violin id for a name a person typed: lowercased, spaces and punctuation to hyphens.
 *
 * The id is a model name in the overlay, so it must be stable and readable; `My Reviewer!` becomes
 * `my-reviewer`. An empty result falls back to `violin`, and {@link withViolin} makes it unique.
 * @param name - the typed name.
 * @returns the slug.
 */
export declare function slugifyViolinId(name: string): string;
/**
 * Add a violin, with an id that is free.
 *
 * The id is the typed name slugged, then `-2`, `-3`, … until it collides with nothing. A typed
 * name that slugs onto a predefined id (`Fast`) or a comparison id (`arena-runners`) is numbered
 * rather than allowed to shadow it — a predefined violin cannot be replaced by a custom one, and
 * the page would otherwise show two violins with one key between them.
 * @param groups - the current group set.
 * @param name - the typed name.
 * @param selections - the selections to start from; empty is legal.
 * @returns the next group set and the new violin's id.
 */
export declare function withViolin(groups: FleetGroupsFile, name: string, selections?: readonly ViolinSelection[]): {
    readonly groups: FleetGroupsFile;
    readonly id: string;
};
/**
 * Replace one violin's selections. Predefined violins may be edited; none may be deleted.
 * @param groups - the current group set.
 * @param id - the violin to edit.
 * @param selections - the next selections.
 * @returns the next group set.
 */
export declare function withSelections(groups: FleetGroupsFile, id: string, selections: readonly ViolinSelection[]): FleetGroupsFile;
/**
 * Move a task into a violin, taking it out of whichever violin held it.
 *
 * Removing a predefined violin is impossible ({@link withoutViolin} refuses), so the target of a
 * move always exists; this function does not invent one. A task key may be moved to the violin that
 * already holds it, which is a no-op.
 * @param groups - the current group set.
 * @param task - the task key.
 * @param id - the violin to move it to.
 * @returns the next group set.
 */
export declare function withTask(groups: FleetGroupsFile, task: string, id: string): FleetGroupsFile;
/**
 * Take a task out of every violin, so it is unassigned and runs on `general`.
 * @param groups - the current group set.
 * @param task - the task key.
 * @returns the next group set.
 */
export declare function withoutTask(groups: FleetGroupsFile, task: string): FleetGroupsFile;
/**
 * Remove a custom violin, releasing its tasks to `general`.
 *
 * A predefined or comparison violin is returned unchanged: the page offers no way to delete one,
 * and a hand-edited file that lost `general` would have no fallback left to write. The caller sees
 * which of the two happened through the returned `removed` flag rather than having to compare.
 * @param groups - the current group set.
 * @param id - the violin to remove.
 * @returns the next group set, and whether anything was removed.
 */
export declare function withoutViolin(groups: FleetGroupsFile, id: string): {
    readonly groups: FleetGroupsFile;
    readonly removed: boolean;
};
/** Rename a violin's label. The id stays: the overlay's model names hang off it. */
export declare function withViolinName(groups: FleetGroupsFile, id: string, name: string): FleetGroupsFile;
/**
 * Read a group set back out of an overlay: the one-time import that keeps an existing setup.
 *
 * The mapping is the inverse of {@link toOverlay} for everything that survives it, and it is
 * deliberately generous, because the alternative to importing a name is losing it:
 *
 * 1. start from {@link defaultGroups}, so the predefined and comparison violins exist;
 * 2. every name the overlay declares (`models`) whose id matches a predefined or comparison violin
 *    **replaces** that violin's selections — the file a person wrote wins over the heuristic;
 * 3. every other declared name becomes a custom violin carrying its assignment;
 * 4. a task naming exactly one name joins that name's violin; a task naming several joins its own
 *    comparison violin (created when the file uses a key outside `PANEL_ROLES`, which the parser
 *    refuses anyway, so this is the hand-built-file case);
 * 5. `inherit-parent`, an unknown name, and a task with no entry stay unassigned.
 *
 * @param overlay - the parsed overlay, or `undefined` when there is no file.
 * @param options - the live catalog and the session's default route.
 * @returns the imported groups, plus the names that could not be placed.
 */
export declare function fromOverlay(overlay: OverlayFile | undefined, options: DefaultGroupsOptions): {
    readonly groups: FleetGroupsFile;
    readonly dropped: readonly string[];
};
/**
 * Repair a group set into one this build can write: the predefined and comparison violins present,
 * no duplicate ids, no task in two violins.
 *
 * Used on load for a file that {@link parseFleetGroups} refused, so the page has something to show
 * and save rather than an empty screen. The repairs are the same ones the parser names in its
 * errors; this function performs them instead of reporting them.
 * @param groups - a group set, possibly incomplete.
 * @returns a complete group set.
 */
export declare function repairedGroups(groups: FleetGroupsFile): {
    readonly groups: FleetGroupsFile;
    readonly repairs: readonly string[];
};
