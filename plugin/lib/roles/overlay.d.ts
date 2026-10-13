/**
 * The overlay file and the rules that turn it into a spawn target.
 *
 * ## The question this file answers
 *
 * *Which model does what.* The old question — one route per role — was the wrong one, and the
 * settings page built on it rendered a flat role table that never said what anything resolved to.
 * The file now has **two levels**:
 *
 * 1. **Models.** A friendly name maps to *one concrete assignment*: one provider, one model, one
 *    reasoning effort. `off` is a legitimate effort, not the absence of one. The name is what a
 *    person reads; `provider/model · effort` is the detail behind it.
 * 2. **Tasks.** A task key (`feature`, `arena-runners`, …) maps to the **named model(s)** it may
 *    run on. Tasks point at names and never at raw routes.
 *
 * ## Two file versions, and what v1 means
 *
 * `version: 2` is this shape ({@link OverlayFileV2}). `version: 1` — `{version, roles}` with
 * `{inherit: true}` / `{routes: [...]}` entries — keeps parsing, and is read as **every role
 * inherits the parent**. That is deliberate and not a silent reinterpretation: v1's keys are
 * *role* keys and its values are *routes*, while v2's keys are *task* keys and its values are
 * *model names*; the two are different things and folding one into the other would invent a
 * mapping nobody wrote. What v1 loses is stated plainly instead: {@link overlayVersionNote} is the
 * sentence the page and the report print, and it names the routes v1 carried and no longer
 * applies. A v2 file with an unknown `version` is refused by name.
 *
 * ## Two spellings, one vocabulary
 *
 * The frozen ported skills in `plugin/skills/**` spell their spawn call sites as prose values —
 * `generalPurpose` 9 times, `comment-sicko` once, `poteto-agent` twice — while the role keys here are kebab-case, and upstream's own overlay keys are space-separated prose (`judgment and prose`,
 * `arena cross-judge pool`, `swarm workers`). {@link normaliseRoleKey} reconciles them: keys are
 * normalised on the way in (parse) and on the way out (lookup), so a file written by hand in
 * either spelling works.
 *
 * `generalPurpose` is **not** folded into `poteto-agent`. A Phase 1 scratch artifact did that
 * (`scratch/p1-port-assess/probe/src/roles.ts:53`), and that folding is wrong:
 * `generalPurpose` is the generic delegate with no agent file, `poteto-agent` is the routing
 * target that reads `poteto-mode` in full. Collapsing them makes `poteto-agent.md`'s own warning
 * self-defeating. {@link canonicalRole} preserves the three spawn role values verbatim.
 *
 * ## What resolveRole does with a bad assignment
 *
 * Never throws, and never silently drops: an assignment whose route is not in the live catalog,
 * whose credential is missing, or that names an effort the adapter does not advertise comes back
 * as `inherit: true` with a `reason` starting {@link UNAVAILABLE_REASON_PREFIX}. The child runs on
 * the parent's route — which is the honest single-route default — but the menu can say
 * `unavailable (was: X)` because the reason still names what was asked for.
 */
import type { ResolvedRole, RoleRoute, RouteCatalog } from './catalog.ts';
/** The three spawn role values the frozen ported skills use verbatim. */
export declare const SPAWN_ROLE_VALUES: readonly ["generalPurpose", "poteto-agent", "comment-sicko"];
/** Roles that take a route list and spawn one child per entry. */
export declare const PANEL_ROLES: readonly ["arena-runners", "arena-cross-judge-pool", "architect-runners", "interrogate-reviewers"];
/**
 * Every kebab-case role key, in the canonical documented order.
 *
 * These are the **task keys** of a version 2 file: the task container a named model is assigned
 * to. A key outside this list is accepted (the parser must not invent a role vocabulary) but is
 * reported by the page rather than being absorbed into a table built from this list.
 */
export declare const ROLE_KEYS: readonly ["feature", "refactoring", "bug-fix", "perf-issue", "hillclimb", "judgment-and-prose", "hardest-tasks", "how-explorer", "how-explainer", "why-investigators", "why-synthesizer", "reflect-tooling", "reflect-judgment", "swarm-workers", "arena-runners", "arena-cross-judge-pool", "architect-runners", "interrogate-reviewers", "independent-verifier", "poteto-agent", "comment-sicko"];
/**
 * Stable prefix on every {@link ResolvedRole.reason} that reports a route the caller asked for
 * and did not get. The menu keys on it to print `unavailable (was: X)` rather than "inherits
 * parent", so a dropped route can never read as a deliberate default.
 */
export declare const UNAVAILABLE_REASON_PREFIX = "unavailable:";
/** One concrete assignment: provider, model, and the effort that is part of it. */
export interface OverlayModelRoute {
    readonly provider: string;
    readonly model: string;
    /** Omit only when the route advertises no efforts; otherwise one the route advertises. */
    readonly reasoningEffort?: string;
}
/** One named model: its assignment plus the one line of prose the page shows next to the name. */
export interface OverlayModel {
    readonly provider: string;
    readonly model: string;
    /**
     * The effort that is part of this assignment. `off` is a value, not an omission: writing it
     * means "run with reasoning off", while omitting it means "let the adapter materialise its
     * default".
     */
    readonly reasoningEffort?: string;
    /** One line of prose the page shows next to the name. */
    readonly description?: string;
}
/**
 * The version 2 file: named models and the tasks that point at them.
 *
 * Every field is optional on disk. `models` may be absent entirely, in which case
 * {@link BUILT_IN_MODEL_NAMES} resolve against the live catalog; `tasks` may be absent, in which
 * case every task inherits the parent.
 */
export interface OverlayFileV2 {
    readonly version: 2;
    /** Friendly name -> one concrete route. Effort is part of the assignment. */
    readonly models: Record<string, OverlayModel>;
    /** Task container -> the named models it may run on. One name, or several for comparison. */
    readonly tasks: Record<string, readonly string[]>;
}
/** The version 1 entry shapes, kept exactly as they were so an old file still parses. */
export type OverlayRoleEntry = {
    readonly inherit: true;
} | {
    readonly routes: readonly RoleRoute[];
};
/** The version 1 file: role keys to either `inherit` or a route list. */
export interface OverlayFileV1 {
    readonly version: 1;
    readonly roles: Record<string, OverlayRoleEntry>;
}
/** Either file the parser accepts. */
export type OverlayFile = OverlayFileV1 | OverlayFileV2;
/** The file this build writes. */
export type WritableOverlayFile = OverlayFileV2;
/** Parse result. `error` is written to be shown to the person who hand-edited the file. */
export type ParseOverlayResult = {
    ok: true;
    value: OverlayFile;
} | {
    ok: false;
    error: string;
};
/**
 * The built-in names, in the order the page lists them.
 *
 * A hand-written file therefore needs no boilerplate: `{"version": 2}` alone makes all four
 * resolve against the live catalog. `main` is first because it is the one name a task points at
 * when it wants the default, and `inherit-parent` last because it is not a route at all.
 */
export declare const BUILT_IN_MODEL_NAMES: readonly ["main", "smart", "fast", "vision", "inherit-parent"];
/** One built-in name. */
export type BuiltInModelName = (typeof BUILT_IN_MODEL_NAMES)[number];
/** True for a name that resolves with no `models` block: a built-in, or the inherit sentinel. */
export declare function isBuiltInModelName(name: string): name is BuiltInModelName;
/**
 * The conventional name for "this task's children run wherever the parent runs".
 *
 * Not a model, and never a member of `models`: it is the sentinel a task points at to state the
 * one-route default explicitly. Present in {@link BUILT_IN_MODEL_NAMES} so a task naming it is
 * not an unknown name.
 */
export declare const INHERIT_PARENT_MODEL = "inherit-parent";
/**
 * The assignment a built-in name means, or `undefined` for `inherit-parent` (which is not a
 * route) and for anything that is not a built-in at all.
 * @param name - the friendly name as written.
 * @returns the assignment, or `undefined`.
 */
export declare function builtInModel(name: string): OverlayModel | undefined;
/**
 * Normalise a role key: trim, collapse whitespace, lowercase, spaces -> hyphens.
 *
 * `judgment and prose` → `judgment-and-prose`, `  Arena  Cross-Judge Pool ` →
 * `arena-cross-judge-pool`, and an already-kebab key passes through unchanged.
 * @param raw - the key as written, in either spelling.
 * @returns the canonical key.
 */
export declare function normaliseRoleKey(raw: string): string;
/**
 * The role name to report back: one of the three spawn role values verbatim when the input means
 * one of them (in either spelling), otherwise the normalised kebab-case key.
 * `generalPurpose` → `generalPurpose` (never `poteto-agent`); `judgment and prose` →
 * `judgment-and-prose`.
 * @param raw - the role as the caller spelled it.
 * @returns the value for {@link ResolvedRole.role}.
 */
export declare function canonicalRole(raw: string): string;
/** The wording used wherever a route has to be written down exactly: `provider/model`. */
export declare function routeLabel(provider: string, model: string): string;
/**
 * Whether the live catalog can honour one assignment, and why not when it cannot.
 *
 * The single decision {@link resolveRole} and the write-time validator both read, so the
 * read-time `unavailable (was: X)` and the write-time rejection cannot drift apart.
 */
export type RouteHonour = {
    readonly ok: true;
    readonly route: RoleRoute;
    readonly provider: string;
    readonly model: string;
    readonly efforts: readonly string[];
    readonly defaultEffort?: string;
} | {
    readonly ok: false;
    /** The sentence naming the offender and what the catalog would accept instead. */
    readonly why: string;
    /** Which of the two rejections this was, so a caller can word it differently. */
    readonly kind: 'not-in-catalog' | 'unadvertised-effort';
    /** The route as written, always present so a caller can name it. */
    readonly provider: string;
    readonly model: string;
    /** What the route does advertise; empty for `not-in-catalog` and for a route with no efforts. */
    readonly advertised: readonly string[];
    /** The effort as written, for `unadvertised-effort`. */
    readonly effort?: string;
};
/**
 * Judge one assignment against the live catalog.
 *
 * Two rejections, each naming the offender:
 *
 * - the route is not in the catalog — with the catalog's own recorded reason attached when it has
 *   one (`no adapter registered it` vs `its credential is not configured` are different facts);
 * - the route advertises reasons of its own and does not include the asked-for effort. `off` is
 *   checked exactly like any other id, so a route that advertises it accepts it and a route that
 *   does not refuses it.
 *
 * @param catalog - the live inventory from `enumerateRoutes`.
 * @param wanted - the assignment as written.
 * @returns whether it can be honoured, and the reason when it cannot.
 */
export declare function describeRoute(catalog: RouteCatalog, wanted: OverlayModelRoute): RouteHonour;
/**
 * The one-line note a version 1 file earns, naming what it loses.
 *
 * v1's `roles` values were routes. This build reads a v1 file as "everything inherits", which is
 * the honest single-route behaviour — but it does mean a route a person set is no longer applied,
 * and pretending otherwise is the failure mode this program keeps finding. `undefined` for a v2
 * file, which has nothing to warn about.
 * @param overlay - the parsed file, or `undefined` when there is none.
 * @returns the sentence to print, or `undefined`.
 */
export declare function overlayVersionNote(overlay: OverlayFile | undefined): string | undefined;
/**
 * Parse an overlay file. Never throws; every rejection carries a message written for the person
 * who edited the file.
 *
 * `version: 2` is the shape this build writes. `version: 1` still parses, and
 * {@link overlayVersionNote} says what reading it as "everything inherits" costs.
 * Task keys are normalised, so `judgment and prose` and `judgment-and-prose` land on the same key —
 * and two spellings of one task in one file is an error, not a silent last-one-wins.
 * @param text - the file's contents.
 * @returns the parsed file, or the reason it was rejected.
 */
export declare function parseOverlay(text: string): ParseOverlayResult;
/**
 * Write an overlay file. `parseOverlay(serializeOverlay(value))` returns an equal value, and the
 * 2-space indent plus trailing newline is what makes the file hand-editable.
 * @param value - the file to write.
 * @returns the file's text.
 */
export declare function serializeOverlay(value: OverlayFile): string;
/** True when the key names a panel role: the tasks that may list more than one name. */
export declare function isPanelRole(key: string): boolean;
/**
 * The assignment one named model means, declared entries first and built-ins second.
 *
 * A declared entry **overrides** a built-in of the same name; a built-in is used when the file
 * says nothing. `inherit-parent` is never a route, so it answers `undefined` here — callers check
 * {@link INHERIT_PARENT_MODEL} before asking.
 * @param name - the friendly name as a task wrote it.
 * @param overlay - the parsed overlay, when there is one.
 * @returns the assignment, or `undefined` when the name is neither declared nor built-in.
 */
export declare function namedModelAssignment(name: string, overlay: OverlayFile | undefined): OverlayModel | undefined;
/**
 * Resolve one task to the route its child should run on.
 *
 * The rules the overlay is held to, plus the version 2 shape:
 *
 * 1. no overlay entry → inherit the parent;
 * 2. `version: 1` → inherit the parent for every key (see {@link overlayVersionNote});
 * 3. a task with no `tasks` entry, `inherit: true`'s v2 equivalent (an empty list), or the name
 *    `inherit-parent` → inherit the parent;
 * 4. a scalar task → its single named model's full route, effort included, `routeIndex` absent;
 * 5. a panel task → the named model at `entryIndex`, `routeIndex` set, one distinct index per name;
 * 6. an assignment the catalog cannot honour → `inherit: true` and a reason prefixed
 *    {@link UNAVAILABLE_REASON_PREFIX}, never a route that was not read from the live catalog;
 * 7. an effort the route does not advertise — **including `off`** — the same treatment.
 *
 * The route's own `defaultEffort` is **not** copied into the resolved route when the assignment
 * omits an effort: an omitted effort means the adapter materialises its default
 * (`dsh-llm/lib/types/types.d.ts:321-328`), and this module does not invent values. The reason
 * names the default so the menu can show it.
 *
 * @param role - the role as the caller spelled it, kebab-case or a spawn role value.
 * @param overlay - the parsed overlay, or `undefined` when there is no file.
 * @param catalog - the live route inventory from `enumerateRoutes`.
 * @param entryIndex - which name of a panel task to resolve. Ignored for scalar tasks; a panel's
 *   spawn loop passes 0, 1, 2, ... so each child gets a distinct `routeIndex`.
 * @returns the resolved target, and the reason it resolved that way.
 */
export declare function resolveRole(role: string, overlay: OverlayFile | undefined, catalog: RouteCatalog, entryIndex?: number): ResolvedRole;
/**
 * Resolve every entry of a panel task, one child per named model. A task
 * that inherits returns a single entry, because "spawn N children all inheriting" is a fan-out
 * decision the caller makes, not a route list.
 * @param role - the role as the caller spelled it.
 * @param overlay - the parsed overlay, or `undefined`.
 * @param catalog - the live route inventory.
 * @returns one resolution per name, each with its own `routeIndex`.
 */
export declare function resolvePanel(role: string, overlay: OverlayFile | undefined, catalog: RouteCatalog): readonly ResolvedRole[];
