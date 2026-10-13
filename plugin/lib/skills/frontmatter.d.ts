/**
 * A minimal YAML frontmatter reader for `SKILL.md` files.
 *
 * DSH parses skill frontmatter with a full YAML parser
 * (`@deepseek-ai/dsh-skill-filesystem/lib/index.js:765` `parseFrontmatter`; field handling at
 * `:838` `parseInvocationPolicy` and `:872` `optionalMetadata`). This module implements the
 * subset the skill corpus actually uses — counted over all 47 upstream pstack skills at the
 * pinned commit (the pin lives in `scripts/fetch-upstream.sh`):
 *
 *   - `key: value` plain scalars, including `Poteto Mode`-style values with spaces;
 *   - double-quoted scalars with `\"` escapes (`architect`, `how`, `recall`, `tdd`);
 *   - one-line flow sequences (`typescript-best-practices`: `paths: ["**\/*.ts", ...]`);
 *   - the folded block scalar `>-` (`make-bot-ui`'s description), plus the other
 *     `|`, `|-`, `|+`, `>`, `>+` headers;
 *   - one level of indented `key: value` children, for the `metadata:` object the contract
 *     allows (`SkillCandidate.metadata`);
 *   - YAML core-schema scalar typing for plain scalars (`true`, `2`, `1.5`, `null`), so the
 *     parsed `data` agrees with what DSH's YAML parser hands its own validators.
 *
 * Two deliberate differences from a full YAML parser, both chosen to fail loud rather than
 * silently truncate:
 *
 *   1. `#` opens a comment only when it is the first non-space character of a line. YAML would
 *      also strip ` # ...` mid-value. No skill in the corpus does that, and silently cutting a
 *      description at a `#` is the worse failure.
 *   2. A malformed block throws {@link SkillFrontmatterError} instead of being partially
 *      understood. Callers that scan a directory catch it per file and skip that skill, which
 *      is the same observable outcome DSH gets from its own warnings
 *      (`dsh-skill-filesystem/lib/index.js:672`-`:694`).
 */
/** Invocation controls, matching `SkillInvocationPolicy` in `dsh-skill`. */
export interface SkillInvocationPolicy {
    /** Whether model-facing catalogs and loaders include this skill. */
    readonly modelInvocable: boolean;
    /** Whether human-facing command catalogs and loaders include this skill. */
    readonly userInvocable: boolean;
}
/** The validated frontmatter of one skill file. */
export interface SkillFrontmatter {
    /** Kebab-case identifier used to address the skill. */
    readonly name: string;
    /** Short routing description shown by discovery consumers. */
    readonly description: string;
    /** Optional extra routing guidance. */
    readonly whenToUse?: string;
    /** Parsed optional metadata object from provider-specific frontmatter. */
    readonly metadata?: Readonly<Record<string, unknown>>;
    /** Resolved model and user invocation controls. */
    readonly invocation: SkillInvocationPolicy;
}
/** A raw frontmatter block: parsed data plus the untouched Markdown body. */
interface FrontmatterBlock {
    /** Every key in the block, with unknown keys kept verbatim. */
    readonly data: Readonly<Record<string, unknown>>;
    /** Everything after the closing delimiter, untrimmed. */
    readonly body: string;
}
/** Raised for a malformed or contract-violating skill file. Never swallowed silently. */
export declare class SkillFrontmatterError extends Error {
    constructor(message: string);
}
/**
 * Return whether a string is a valid kebab-case skill name.
 * @param name - candidate skill name to validate.
 * @returns whether the name matches the public skill-name grammar.
 */
export declare function isSkillName(name: string): boolean;
/**
 * Read the leading `---` block of a skill file.
 *
 * Mirrors `dsh-skill-filesystem/lib/index.js:765`-`:785`: the file must start with a line that
 * is exactly `---`, and the block ends at the next such line. No block, or an unterminated one,
 * is `undefined` (DSH logs "missing YAML frontmatter"); anything malformed inside a closed
 * block throws.
 *
 * @param raw - complete file text.
 * @returns parsed data and the raw body, or `undefined` when the file has no frontmatter block.
 * @throws {SkillFrontmatterError} when the block is present but malformed.
 */
export declare function parseFrontmatter(raw: string): FrontmatterBlock | undefined;
/**
 * Parse a frontmatter block and validate the fields DSH requires.
 *
 * Order and messages follow `dsh-skill-filesystem/lib/index.js:679`-`:705` and `:838`-`:850`
 * so a dropped skill reads the same in either implementation.
 *
 * @param data - the parsed block.
 * @param source - file path, used in error messages only.
 * @returns the validated frontmatter.
 * @throws {SkillFrontmatterError} when a required field is missing or a field is malformed.
 */
export declare function readSkillFrontmatter(data: Readonly<Record<string, unknown>>, source: string): SkillFrontmatter;
/**
 * Resolve the invocation policy, rejecting DSH's retired key spellings.
 * @param data - the parsed block.
 * @param source - file path, used in error messages only.
 * @returns the resolved model and user invocation controls.
 * @throws {SkillFrontmatterError} on a legacy key or a non-boolean value.
 */
export declare function parseInvocationPolicy(data: Readonly<Record<string, unknown>>, source: string): SkillInvocationPolicy;
export {};
