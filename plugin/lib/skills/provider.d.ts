import type { SkillInvocationPolicy } from './frontmatter.ts';
/**
 * Rank for packaged providers, copied from `BUNDLED_SKILL_RANK`
 * (`dsh-skill/lib/index.js:23`). Lower wins a duplicate name.
 */
export declare const BUNDLED_SKILL_RANK = 600;
/** Provider name registered on `ctx.skills`, unique within the registry. */
export declare const PSTACK_SKILL_PROVIDER = "pstack";
/** Origin bucket for a bundled skill (`SkillSource` in `dsh-skill`). */
export declare const BUNDLED_SKILL_SOURCE = "bundled";
/** Caller context for cwd-sensitive and abortable provider work. */
interface SkillLookupOptions {
    /** Workspace selector for the current lookup. */
    readonly cwd?: string | undefined;
    /** Abort discovery or loading work for the current caller. */
    readonly signal?: AbortSignal | undefined;
}
/** Registration-scoped lifecycle handed to the provider factory by the registry. */
export interface SkillProviderControl {
    /** Aborts when this exact provider registration is disposed. */
    readonly signal: AbortSignal;
    /** Invalidate completed catalogs while the registration remains active. */
    readonly invalidate: () => void;
}
/** Provider-specific base used by loaded skill bodies to resolve relative resources. */
interface SkillResourceBase {
    readonly kind: 'directory';
    readonly path: string;
}
/** Invocation-neutral summary, as returned by `ctx.skills.list()`. */
interface SkillSummary {
    readonly name: string;
    readonly description: string;
    readonly whenToUse?: string;
    readonly invocation: SkillInvocationPolicy;
    readonly source: string;
    readonly provider: string;
    readonly resourceBase?: SkillResourceBase;
}
/** A catalog entry the registry merges and later loads. */
interface SkillCandidate extends SkillSummary {
    readonly rank: number;
    readonly locator: unknown;
    readonly path?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
}
/** A complete skill, including the body loaded by `ctx.skills.get()`. */
interface SkillDefinition extends SkillSummary {
    readonly content: string;
    readonly path?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
}
/** One source of skills, registered on `ctx.skills`. */
export interface SkillProvider {
    readonly name: string;
    readonly list: (options: SkillLookupOptions) => Promise<readonly SkillCandidate[]>;
    readonly get: (candidate: SkillCandidate, options: SkillLookupOptions) => Promise<SkillDefinition | undefined>;
}
/** Minimal logger surface; the DSH context's `logger` is a superset. */
interface ProviderLogger {
    warn?: (message: string) => void;
}
interface BundledSkillProviderOptions {
    /** Absolute path of the directory holding one subdirectory per skill. */
    readonly skillsDir: string;
    /** Logger for "this file was skipped and why" lines. */
    readonly logger?: ProviderLogger;
    /**
     * Registry registration control; its abort signal cancels work on disposal.
     * `control.invalidate` is deliberately unused: this provider watches nothing, and the
     * registry already re-reads a body through `get()` on every load, so there is no cached
     * catalogue here to invalidate.
     */
    readonly control?: SkillProviderControl;
}
/**
 * Create the provider the registry calls during discovery.
 * @param options - skill root, logger, and the registration control.
 * @returns a `SkillProvider` for `ctx.skills.registerProvider`.
 */
export declare function createBundledSkillProvider(options: BundledSkillProviderOptions): SkillProvider;
export {};
