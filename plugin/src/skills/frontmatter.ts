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
  readonly modelInvocable: boolean
  /** Whether human-facing command catalogs and loaders include this skill. */
  readonly userInvocable: boolean
}

/** The validated frontmatter of one skill file. */
export interface SkillFrontmatter {
  /** Kebab-case identifier used to address the skill. */
  readonly name: string
  /** Short routing description shown by discovery consumers. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** Parsed optional metadata object from provider-specific frontmatter. */
  readonly metadata?: Readonly<Record<string, unknown>>
  /** Resolved model and user invocation controls. */
  readonly invocation: SkillInvocationPolicy
}

/** A raw frontmatter block: parsed data plus the untouched Markdown body. */
interface FrontmatterBlock {
  /** Every key in the block, with unknown keys kept verbatim. */
  readonly data: Readonly<Record<string, unknown>>
  /** Everything after the closing delimiter, untrimmed. */
  readonly body: string
}

/** Raised for a malformed or contract-violating skill file. Never swallowed silently. */
export class SkillFrontmatterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillFrontmatterError'
  }
}

/**
 * The public skill-name grammar, copied from `dsh-skill/lib/index.js:17` (`SKILL_NAME`).
 * `isSkillName` is the registry's own validator; a mismatch would only surface as a throw
 * from `validateCandidate` (`dsh-skill/lib/index.js:454`), so keep the two in step.
 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Return whether a string is a valid kebab-case skill name.
 * @param name - candidate skill name to validate.
 * @returns whether the name matches the public skill-name grammar.
 */
export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name)
}

/** A `key: value` line. Keys are deliberately narrower than YAML's. */
const KEY_LINE = /^([A-Za-z0-9_.-]+):(.*)$/
/** A block scalar header: `|`, `|-`, `|+`, `>`, `>-`, `>+`. */
const BLOCK_SCALAR_HEADER = /^([|>])([+-]?)$/

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
export function parseFrontmatter(raw: string): FrontmatterBlock | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (trimCr(raw.slice(0, firstLineEnd)) !== '---') return undefined
  const start = firstLineEnd + 1
  const closing = findClosingDelimiter(raw, start)
  if (closing === undefined) return undefined
  return { data: parseBlock(raw.slice(start, closing.start)), body: raw.slice(closing.bodyStart) }
}

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
export function readSkillFrontmatter(data: Readonly<Record<string, unknown>>, source: string): SkillFrontmatter {
  const name = stringField(data, 'name')
  const description = stringField(data, 'description')
  if (name === undefined || description === undefined) {
    throw new SkillFrontmatterError(`${source}: frontmatter requires name and description`)
  }
  if (!isSkillName(name)) {
    throw new SkillFrontmatterError(`${source}: invalid skill name "${name}"`)
  }
  const whenToUse = optionalString(data, 'whenToUse')
  return {
    name,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    ...optionalMetadata(data, source),
    invocation: parseInvocationPolicy(data, source),
  }
}

/**
 * Resolve the invocation policy, rejecting DSH's retired key spellings.
 * @param data - the parsed block.
 * @param source - file path, used in error messages only.
 * @returns the resolved model and user invocation controls.
 * @throws {SkillFrontmatterError} on a legacy key or a non-boolean value.
 */
export function parseInvocationPolicy(
  data: Readonly<Record<string, unknown>>,
  source: string,
): SkillInvocationPolicy {
  rejectLegacyKey(data, 'disableModelInvocation', 'disable-model-invocation', source)
  rejectLegacyKey(data, 'modelInvocable', 'disable-model-invocation', source)
  rejectLegacyKey(data, 'userInvocable', 'user-invocable', source)
  const disableModelInvocation = booleanField(data, 'disable-model-invocation', source)
  const userInvocable = booleanField(data, 'user-invocable', source)
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  }
}

/** Find the closing `---` line, or `undefined` when the block never closes. */
function findClosingDelimiter(raw: string, start: number): { start: number; bodyStart: number } | undefined {
  let lineStart = start
  for (;;) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (trimCr(raw.slice(lineStart, lineEnd)) === '---') {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
}

/** Parse the inside of a frontmatter block into a flat mapping. */
function parseBlock(source: string): Record<string, unknown> {
  const lines = source.split('\n').map(trimCr)
  const data: Record<string, unknown> = {}
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    index += 1
    const bare = line.trim()
    if (bare === '' || bare.startsWith('#')) continue
    if (/^[ \t]/.test(line)) {
      throw new SkillFrontmatterError(`unexpected indented line at the top level: ${JSON.stringify(line)}`)
    }
    const match = KEY_LINE.exec(line)
    if (match === null) {
      throw new SkillFrontmatterError(`not a "key: value" line: ${JSON.stringify(line)}`)
    }
    const key = match[1] ?? ''
    if (Object.hasOwn(data, key)) throw new SkillFrontmatterError(`duplicate frontmatter key "${key}"`)
    const raw = (match[2] ?? '').trim()

    const header = BLOCK_SCALAR_HEADER.exec(raw)
    if (header !== null) {
      const block = readBlockScalar(lines, index, header[1] === '>', header[2] ?? '')
      data[key] = block.value
      index = block.next
      continue
    }
    if (raw === '') {
      const nested = readNestedMapping(lines, index)
      index = nested.next
      data[key] = nested.keys === 0 ? null : nested.value
      continue
    }
    data[key] = parseScalar(raw, key)
  }
  return data
}

/**
 * Read a block scalar's indented body.
 * @param lines - all block lines.
 * @param start - index of the first body line.
 * @param folded - `true` for `>`, which folds newlines into spaces.
 * @param chomp - `''` (clip), `'-'` (strip), or `'+'` (keep).
 * @returns the scalar value and the index of the first unconsumed line.
 */
function readBlockScalar(
  lines: readonly string[],
  start: number,
  folded: boolean,
  chomp: string,
): { value: string; next: number } {
  let first = start
  while (first < lines.length && (lines[first] ?? '').trim() === '') first += 1
  const anchor = lines[first]
  if (anchor === undefined || !/^[ \t]/.test(anchor)) return { value: '', next: start }
  const indent = /^[ \t]*/.exec(anchor)?.[0].length ?? 0

  const content: string[] = []
  let index = start
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      content.push('')
      index += 1
      continue
    }
    if (!/^[ \t]/.test(line) || (/^[ \t]*/.exec(line)?.[0].length ?? 0) < indent) break
    content.push(line.slice(indent))
    index += 1
  }
  return { value: chompScalar(folded ? foldLines(content) : content.join('\n'), chomp), next: index }
}

/** Fold `> `-style lines: single newlines become spaces, blank runs become newlines. */
function foldLines(lines: readonly string[]): string {
  let out = ''
  let pending = 0
  let started = false
  for (const line of lines) {
    if (line === '') {
      pending += 1
      continue
    }
    if (!started) {
      out = line
      started = true
    } else if (pending > 0) {
      out += `${'\n'.repeat(pending)}${line}`
    } else {
      out += ` ${line}`
    }
    pending = 0
  }
  return out + '\n'.repeat(pending)
}

/** Apply block-scalar chomping to the joined text. */
function chompScalar(text: string, chomp: string): string {
  if (chomp === '-') return text.replace(/[\s\n]+$/, '')
  if (chomp === '+') return text === '' ? '' : `${text.replace(/\n*$/, '')}\n`
  const clipped = text.replace(/[\s\n]+$/, '')
  return clipped === '' ? '' : `${clipped}\n`
}

/** Read one level of indented `key: value` children under a key with no inline value. */
function readNestedMapping(
  lines: readonly string[],
  start: number,
): { value: Record<string, unknown>; keys: number; next: number } {
  const value: Record<string, unknown> = {}
  let keys = 0
  let index = start
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      index += 1
      continue
    }
    if (!/^[ \t]/.test(line)) break
    const match = /^[ \t]+([A-Za-z0-9_.-]+):(.*)$/.exec(line)
    if (match === null) throw new SkillFrontmatterError(`not a nested "key: value" line: ${JSON.stringify(line)}`)
    const key = match[1] ?? ''
    if (Object.hasOwn(value, key)) throw new SkillFrontmatterError(`duplicate nested key "${key}"`)
    const raw = (match[2] ?? '').trim()
    if (BLOCK_SCALAR_HEADER.test(raw)) {
      throw new SkillFrontmatterError(`nested key "${key}" cannot use a block scalar`)
    }
    value[key] = raw === '' ? null : parseScalar(raw, key)
    keys += 1
    index += 1
  }
  return { value, keys, next: index }
}

/** Parse one inline scalar: quoted, flow sequence, or plain. */
function parseScalar(raw: string, key: string): unknown {
  if (raw.startsWith('"')) return parseDoubleQuoted(raw, key)
  if (raw.startsWith("'")) return parseSingleQuoted(raw, key)
  if (raw.startsWith('[')) return parseFlowSequence(raw, key)
  return parsePlainScalar(raw)
}

/**
 * Type a plain scalar the way YAML's core schema does: booleans, integers, floats and nulls get
 * their own type, everything else stays a string. Quoting always forces a string, so a skill
 * that means the literal text `true` can say `"true"`. This matters because DSH's own parser
 * (`dsh-skill-filesystem`, a full YAML parser) types these too, and because a required field
 * holding an unquoted number is a mistake worth surfacing as "requires name and description"
 * rather than being silently accepted as `"12345"`.
 */
function parsePlainScalar(raw: string): unknown {
  if (raw === '' || raw === '~' || raw === 'null' || raw === 'Null' || raw === 'NULL') return null
  if (/^(?:true|True|TRUE)$/.test(raw)) return true
  if (/^(?:false|False|FALSE)$/.test(raw)) return false
  if (/^[-+]?[0-9]+$/.test(raw)) return Number.parseInt(raw, 10)
  if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(raw)) return Number.parseFloat(raw)
  return raw
}

/** Unquote a double-quoted scalar, honouring YAML's escapes. */
function parseDoubleQuoted(raw: string, key: string): string {
  if (!raw.endsWith('"') || raw.length < 2) {
    throw new SkillFrontmatterError(`unterminated double-quoted value for "${key}": ${JSON.stringify(raw)}`)
  }
  const inner = raw.slice(1, -1)
  let out = ''
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i] ?? ''
    if (char !== '\\') {
      out += char
      continue
    }
    i += 1
    const escape = inner[i]
    if (escape === undefined) throw new SkillFrontmatterError(`dangling escape in "${key}"`)
    if (escape === 'u') {
      const hex = inner.slice(i + 1, i + 5)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SkillFrontmatterError(`bad \\u escape in "${key}"`)
      out += String.fromCharCode(Number.parseInt(hex, 16))
      i += 4
      continue
    }
    const mapped = DOUBLE_QUOTE_ESCAPES[escape]
    if (mapped === undefined) throw new SkillFrontmatterError(`unsupported escape "\\${escape}" in "${key}"`)
    out += mapped
  }
  return out
}

const DOUBLE_QUOTE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  n: '\n',
  r: '\r',
  t: '\t',
  '0': '\0',
  b: '\b',
  f: '\f',
}

/** Unquote a single-quoted scalar, where `''` is the only escape. */
function parseSingleQuoted(raw: string, key: string): string {
  if (raw.length < 2 || !raw.endsWith("'")) {
    throw new SkillFrontmatterError(`unterminated single-quoted value for "${key}": ${JSON.stringify(raw)}`)
  }
  return raw.slice(1, -1).replaceAll("''", "'")
}

/** Parse a one-line flow sequence of scalars. */
function parseFlowSequence(raw: string, key: string): unknown[] {
  if (!raw.endsWith(']')) {
    throw new SkillFrontmatterError(`unterminated flow sequence for "${key}": ${JSON.stringify(raw)}`)
  }
  const inner = raw.slice(1, -1).trim()
  if (inner === '') return []
  const items: unknown[] = []
  let current = ''
  let quote: string | undefined
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i] ?? ''
    if (quote !== undefined) {
      current += char
      if (char === '\\' && quote === '"') {
        current += inner[i + 1] ?? ''
        i += 1
        continue
      }
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === ',') {
      items.push(parseScalar(current.trim(), key))
      current = ''
      continue
    }
    current += char
  }
  if (quote !== undefined) throw new SkillFrontmatterError(`unterminated quote in flow sequence for "${key}"`)
  items.push(parseScalar(current.trim(), key))
  return items
}

/** A non-empty string field, or `undefined` (mirrors `stringField`). */
function stringField(data: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** An optional non-empty string field (mirrors `optionalString`). */
function optionalString(data: Readonly<Record<string, unknown>>, key: string): string | undefined {
  return stringField(data, key)
}

/** The optional metadata object, if the block declares one (mirrors `optionalMetadata`). */
function optionalMetadata(
  data: Readonly<Record<string, unknown>>,
  source: string,
): { metadata?: Readonly<Record<string, unknown>> } {
  const value = data['metadata']
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SkillFrontmatterError(`${source}: frontmatter field "metadata" must be a mapping`)
  }
  return { metadata: value as Readonly<Record<string, unknown>> }
}

/** Reject a retired key spelling, naming the replacement. */
function rejectLegacyKey(
  data: Readonly<Record<string, unknown>>,
  legacy: string,
  canonical: string,
  source: string,
): void {
  if (Object.hasOwn(data, legacy)) {
    throw new SkillFrontmatterError(`${source}: frontmatter field "${legacy}" is unsupported; use "${canonical}"`)
  }
}

/** Read a boolean field the way DSH accepts it, or `undefined` when absent. */
function booleanField(
  data: Readonly<Record<string, unknown>>,
  key: string,
  source: string,
): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case 'no':
      case 'off':
        return false
      default:
        break
    }
  }
  // DSH throws here too (`frontmatterBoolean`, dsh-skill-filesystem/lib/index.js:869), and the
  // skill is dropped whole rather than defaulted: a policy typo must not silently widen access.
  throw new SkillFrontmatterError(`${source}: frontmatter field "${key}" must be a boolean`)
}

/** Strip a trailing carriage return so CRLF files parse. */
function trimCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}
