/**
 * The bundled-skill provider: `skills/<name>/SKILL.md` inside this package.
 *
 * This package must typecheck, test and load without a dependency on a DSH internal, so the
 * provider contract is declared structurally here instead of imported. The shapes are copied
 * from `@deepseek-ai/dsh-skill/lib/types/index.d.ts` (`SkillProvider` :168, `SkillCandidate`
 * :61, `SkillDefinition` :72, `SkillProviderControl` :190, `BUNDLED_SKILL_RANK` :16) and the
 * candidate/definition validators in `@deepseek-ai/dsh-skill/lib/index.js`
 * (`validateCandidate` :453, `validateDefinition` :478). If DSH changes those, this file is
 * what has to change with it — the boot-time registration proof lives in `tests/` and in the
 * route gate, which boots a real Host (`scripts/check-route.sh`), because TypeScript cannot
 * check a structural copy.
 *
 * Bodies are never cached: the registry re-reads through `get()` on every load
 * (`dsh-skill/lib/index.js:256`), so an edited SKILL.md is picked up without a restart.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { SkillFrontmatterError, parseFrontmatter, readSkillFrontmatter } from './frontmatter.ts'
import type { SkillFrontmatter, SkillInvocationPolicy } from './frontmatter.ts'

/**
 * Rank for packaged providers, copied from `BUNDLED_SKILL_RANK`
 * (`dsh-skill/lib/index.js:23`). Lower wins a duplicate name.
 */
export const BUNDLED_SKILL_RANK = 600

/** Provider name registered on `ctx.skills`, unique within the registry. */
export const PSTACK_SKILL_PROVIDER = 'pstack'

/** Origin bucket for a bundled skill (`SkillSource` in `dsh-skill`). */
export const BUNDLED_SKILL_SOURCE = 'bundled'

/** Caller context for cwd-sensitive and abortable provider work. */
interface SkillLookupOptions {
  /** Workspace selector for the current lookup. */
  readonly cwd?: string | undefined
  /** Abort discovery or loading work for the current caller. */
  readonly signal?: AbortSignal | undefined
}

/** Registration-scoped lifecycle handed to the provider factory by the registry. */
export interface SkillProviderControl {
  /** Aborts when this exact provider registration is disposed. */
  readonly signal: AbortSignal
  /** Invalidate completed catalogs while the registration remains active. */
  readonly invalidate: () => void
}

/** Provider-specific base used by loaded skill bodies to resolve relative resources. */
interface SkillResourceBase {
  readonly kind: 'directory'
  readonly path: string
}

/** Invocation-neutral summary, as returned by `ctx.skills.list()`. */
interface SkillSummary {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicy
  readonly source: string
  readonly provider: string
  readonly resourceBase?: SkillResourceBase
}

/** A catalog entry the registry merges and later loads. */
interface SkillCandidate extends SkillSummary {
  readonly rank: number
  readonly locator: unknown
  readonly path?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** A complete skill, including the body loaded by `ctx.skills.get()`. */
interface SkillDefinition extends SkillSummary {
  readonly content: string
  readonly path?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** One source of skills, registered on `ctx.skills`. */
export interface SkillProvider {
  readonly name: string
  readonly list: (options: SkillLookupOptions) => Promise<readonly SkillCandidate[]>
  readonly get: (candidate: SkillCandidate, options: SkillLookupOptions) => Promise<SkillDefinition | undefined>
}

/** Minimal logger surface; the DSH context's `logger` is a superset. */
interface ProviderLogger {
  warn?: (message: string) => void
}

interface BundledSkillProviderOptions {
  /** Absolute path of the directory holding one subdirectory per skill. */
  readonly skillsDir: string
  /** Logger for "this file was skipped and why" lines. */
  readonly logger?: ProviderLogger
  /**
   * Registry registration control; its abort signal cancels work on disposal.
   * `control.invalidate` is deliberately unused: this provider watches nothing, and the
   * registry already re-reads a body through `get()` on every load, so there is no cached
   * catalogue here to invalidate.
   */
  readonly control?: SkillProviderControl
}

/** Locator the provider hands the registry and gets back in `get()`. */
interface BundledSkillLocator {
  readonly path: string
  readonly directory: string
}

/** True for the plain `ENOENT`/`ENOTDIR` cases that mean "no such skill root". */
function isAbsentPathError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Read and parse one `SKILL.md`, or `undefined` when it is absent or individually invalid. */
async function readSkillFile(
  path: string,
  directory: string,
  logger: ProviderLogger | undefined,
): Promise<{ frontmatter: SkillFrontmatter; body: string } | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (isAbsentPathError(error)) return undefined
    // Not an absence and not a parse problem: a permission or I/O failure must be loud.
    throw error
  }
  try {
    const block = parseFrontmatter(raw)
    if (block === undefined) {
      logger?.warn?.(`skill file ${path} ignored: missing YAML frontmatter`)
      return undefined
    }
    return { frontmatter: readSkillFrontmatter(block.data, path), body: block.body.trim() }
  } catch (error) {
    if (!(error instanceof SkillFrontmatterError)) throw error
    logger?.warn?.(`skill file ${path} ignored: ${error.message}`)
    return undefined
  }
}

/** Project validated frontmatter plus its location into a registry candidate. */
function toCandidate(
  frontmatter: SkillFrontmatter,
  locator: BundledSkillLocator,
  provider: string,
): SkillCandidate {
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    ...(frontmatter.whenToUse === undefined ? {} : { whenToUse: frontmatter.whenToUse }),
    invocation: frontmatter.invocation,
    source: BUNDLED_SKILL_SOURCE,
    provider,
    rank: BUNDLED_SKILL_RANK,
    locator,
    path: locator.path,
    resourceBase: { kind: 'directory', path: locator.directory },
    ...(frontmatter.metadata === undefined ? {} : { metadata: frontmatter.metadata }),
  }
}

/** Project validated frontmatter into a loaded definition, keeping the candidate's location. */
function toDefinition(
  frontmatter: SkillFrontmatter,
  candidate: SkillCandidate,
  locator: BundledSkillLocator,
  content: string,
): SkillDefinition {
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    ...(frontmatter.whenToUse === undefined ? {} : { whenToUse: frontmatter.whenToUse }),
    invocation: frontmatter.invocation,
    source: candidate.source,
    provider: candidate.provider,
    resourceBase: { kind: 'directory', path: locator.directory },
    content,
    path: locator.path,
    ...(frontmatter.metadata === undefined ? {} : { metadata: frontmatter.metadata }),
  }
}

/** Narrow an opaque registry locator back to ours. */
function asLocator(candidate: SkillCandidate): BundledSkillLocator | undefined {
  const locator: unknown = candidate.locator
  if (typeof locator !== 'object' || locator === null) return undefined
  const { path, directory } = locator as Partial<BundledSkillLocator>
  if (typeof path !== 'string' || typeof directory !== 'string') return undefined
  return { path, directory }
}

/**
 * Create the provider the registry calls during discovery.
 * @param options - skill root, logger, and the registration control.
 * @returns a `SkillProvider` for `ctx.skills.registerProvider`.
 */
export function createBundledSkillProvider(options: BundledSkillProviderOptions): SkillProvider {
  const { skillsDir, logger, control } = options

  /** Resolve the caller's signal together with this registration's own lifetime. */
  const signalFor = (lookup: SkillLookupOptions): AbortSignal | undefined => {
    const mine = control?.signal
    if (mine === undefined) return lookup.signal
    if (lookup.signal === undefined || lookup.signal === mine) return mine
    return AbortSignal.any([mine, lookup.signal])
  }

  return {
    name: PSTACK_SKILL_PROVIDER,

    async list(lookup) {
      const signal = signalFor(lookup)
      signal?.throwIfAborted()
      let entries
      try {
        entries = await readdir(skillsDir, { withFileTypes: true })
      } catch (error) {
        if (isAbsentPathError(error)) return []
        throw error
      }
      const candidates: SkillCandidate[] = []
      for (const entry of entries) {
        signal?.throwIfAborted()
        if (!entry.isDirectory()) continue
        const directory = join(skillsDir, entry.name)
        const path = join(directory, 'SKILL.md')
        const parsed = await readSkillFile(path, directory, logger)
        if (parsed === undefined) continue
        candidates.push(toCandidate(parsed.frontmatter, { path, directory }, PSTACK_SKILL_PROVIDER))
      }
      // Sorted by codepoint so two runs of the same tree report the same order; the registry
      // sorts summaries itself, but a stable provider order keeps test output readable.
      return candidates.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    },

    async get(candidate, lookup) {
      const signal = signalFor(lookup)
      signal?.throwIfAborted()
      const locator = asLocator(candidate)
      if (locator === undefined) return undefined
      // Re-read rather than cache: the registry calls this on every load, and an edited body
      // must win without a restart (`dsh-skill/lib/index.js:251`).
      const parsed = await readSkillFile(locator.path, locator.directory, logger)
      if (parsed === undefined) return undefined
      return toDefinition(parsed.frontmatter, candidate, locator, parsed.body)
    },
  }
}
