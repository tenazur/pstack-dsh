/**
 * The self-check skill cannot drift from the plugin it describes.
 *
 * `skills/pstack-self-check/SKILL.md` is the one file a model loads to answer "is this plugin
 * actually live", so a stale boot line or a stale field list in it makes a cold agent conclude
 * the Host is broken — which is exactly the defect this file exists to prevent. Text cannot be
 * kept honest by review alone, so the claims are extracted and checked against their sources:
 *
 * - the quoted boot line's fields, against the template `apply()` really logs (`../src/index.ts`)
 * - the quoted JSON field names, against `createPstackStatusTool().output.schema.properties`
 * - the quoted `bootMarker` value, against the exported `BOOT_MARKER` constant
 * - the presence of a groups-file / violins step, and the fields it must name
 *
 * Behaviour is what is asserted, not wording: a skill may rephrase freely, but it may not quote a
 * field the plugin does not have, nor omit one it always returns.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BOOT_MARKER } from '../src/index.ts'
import { createPstackStatusTool } from '../src/tools/status.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_PATH = join(HERE, '..', 'skills', 'pstack-self-check', 'SKILL.md')

/** The skill, read fresh — a drift test that caches its subject proves nothing. */
async function readSkill(): Promise<string> {
  return readFile(SKILL_PATH, 'utf8')
}

/** The skill's fenced blocks, in order, as `[info string, body]`. */
function fencedBlocks(markdown: string): [string, string][] {
  const blocks: [string, string][] = []
  const lines = markdown.split('\n')
  let open: { info: string; body: string[] } | undefined
  for (const line of lines) {
    const fence = /^```(\S*)\s*$/.exec(line)
    if (fence === null) {
      if (open !== undefined) open.body.push(line)
      continue
    }
    if (open === undefined) open = { info: fence[1] ?? '', body: [] }
    else {
      blocks.push([open.info, open.body.join('\n')])
      open = undefined
    }
  }
  assert.equal(open, undefined, 'every fence in the skill is closed')
  return blocks
}

/** The `pstack_status` example JSON quoted in the skill. */
function quotedStatusExample(markdown: string): Record<string, unknown> {
  let found: string[] = []
  for (const [info, body] of fencedBlocks(markdown)) {
    if (info !== 'json') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      continue
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && 'bootMarker' in parsed) {
      found.push(body)
    }
  }
  assert.equal(found.length, 1, 'the skill quotes exactly one pstack_status example JSON block')
  return JSON.parse(found[0] as string) as Record<string, unknown>
}

/**
 * The template `apply()` logs: the one fenced block that opens with the marker and continues with
 * `overlay=`. Anchored at the line start so the marker inside the example JSON's `bootMarker`
 * string value is not mistaken for a second boot line.
 */
function quotedBootLine(markdown: string): string {
  const candidates = fencedBlocks(markdown)
    .map(([, body]) => body)
    .map((body) => body.split('\n').find((line) => line.startsWith(`${BOOT_MARKER} `)))
    .filter((line): line is string => line !== undefined)
  assert.equal(candidates.length, 1, 'the skill quotes exactly one boot line')
  return candidates[0] as string
}

/** `name=` fields in a log template, in order. */
function bootFieldsOf(line: string): string[] {
  return [...line.matchAll(/([A-Za-z][A-Za-z0-9]*)=/g)].map((match) => match[1] as string)
}

/**
 * The fields `apply()` really logs, in source order.
 *
 * The line is written as several concatenated template literals, so the delimiters and the ` + `
 * joins are removed before the fields are read — only what lands in the log survives.
 */
async function realBootFields(): Promise<string[]> {
  const source = await readFile(join(HERE, '..', 'src', 'index.ts'), 'utf8')
  const start = source.indexOf('${BOOT_MARKER} overlay=')
  assert.notEqual(start, -1, 'src/index.ts still logs a line starting with the boot marker')
  // The statement ends at the `,` that closes the logger call; the literal pieces are on one line each.
  const end = source.indexOf('ctx.logger', start)
  const statement = source.slice(start, end === -1 ? undefined : end)
  return bootFieldsOf(statement.replaceAll('`', '').replaceAll(' +', ' '))
}

test('the skill quotes the boot line the plugin really logs', async () => {
  const quoted = bootFieldsOf(quotedBootLine(await readSkill()))
  const real = await realBootFields()
  // Same fields, same order: the log reads as a registration ledger, and a field silently dropped
  // between source and skill is the drift this test exists for.
  assert.deepEqual(quoted, real, 'the skill quotes every boot field, in source order')
})

test('the skill quotes the real pstack_status field set', async () => {
  const example = quotedStatusExample(await readSkill())
  const schema = createPstackStatusTool({
    bootMarker: BOOT_MARKER,
    overlayPath: '/nonexistent/pstack.json',
    groupsPath: '/nonexistent/pstack-fleet.json',
    skillsDir: '/nonexistent',
    pluginName: 'pstack',
  }).output.schema as { properties?: Record<string, unknown>; required?: string[] }
  const real = Object.keys(schema.properties ?? {}).sort()
  assert.deepEqual(Object.keys(example).sort(), real, 'the skill quotes exactly the declared fields')
  assert.deepEqual([...(schema.required ?? [])].sort(), real, 'every declared field is required')
})

test('the skill quotes the real boot marker constant', async () => {
  const example = quotedStatusExample(await readSkill())
  assert.equal(example['bootMarker'], BOOT_MARKER)
})

test('the skill has a groups-file / violins step naming the real fields', async () => {
  const markdown = await readSkill()
  assert.match(markdown, /groups file|pstack-fleet\.json/i, 'a step names the groups file')
  assert.match(markdown, /violin/i, 'a step names violins')
  for (const field of ['groupsPath', 'groupsViolins', 'general']) {
    assert.ok(markdown.includes(field), `the groups step names ${field}`)
  }
})
