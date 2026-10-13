/**
 * The tool-parameter contract: skill prose may not name a parameter the tool does not declare.
 *
 * A ported skill is a program that a model executes, so a parameter name in `plugin/skills/**`
 * is a call site. The port translated the *tool* names (`Task` -> `pstack_spawn`) and left the
 * *parameter* names behind, so `swarm` told a model to pass `run_in_background: true` to a tool
 * whose schema is `additionalProperties: false` over four properties
 * (`src/tools/spawn.ts:220-247`). `parseSpawnArgs` refuses the extra key by name
 * (`:319-322`), so every such call site is a guaranteed failure.
 *
 * ## Why this reads the schemas instead of restating them
 *
 * A copy of the property list here would be a second source of truth that drifts from the tool
 * silently — the exact defect this test exists to catch, one level up. The schema objects are
 * imported, so adding a parameter to `spawn.ts` immediately legalises it in the skills and
 * removing one immediately forbids it.
 *
 * ## What counts as a parameter reference
 *
 * Two shapes, both of which are call sites rather than prose:
 *
 *   1. inline — the tool's own name, then arguments: `` `pstack_spawn`, `role: x`, `run_in_background: true` ``
 *      (`swarm/SKILL.md:29` before the fix). The argument name must carry its own backticks, as
 *      it does at every real call site in this tree.
 *   2. a backticked list item `` - `key`: value `` in a config block naming the tool in the same
 *      line range (`why/SKILL.md:82` before the fix).
 *
 * Shape 2 is scoped to the section the tool is named in, never the whole file: otherwise
 * `setup-pstack/SKILL.md`, which names the tool once and then quotes a wall of overlay JSON,
 * reports `hillclimb:` and `prose:` as parameters. Running prose is left alone on purpose — a
 * sentence like "for each: description" is not a call, and a linter that guesses will be
 * ignored. The defect this test exists for was always a backticked argument name.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { PSTACK_SPAWN_TOOL, PSTACK_SPAWN_PARAMETERS } from '../src/tools/spawn.ts'
import { PSTACK_SPAWN_PANEL_TOOL, PSTACK_SPAWN_PANEL_PARAMETERS } from '../src/tools/spawn-panel.ts'

const skillsDir = fileURLToPath(new URL('../skills', import.meta.url))

/**
 * Every `SKILL.md` under `plugin/skills/`, at any depth. Nested skills are real here: the
 * provider walks the tree, so a `SKILL.md` in a subdirectory is just as model-facing as a
 * top-level one.
 */
function skillFiles(dir: string = skillsDir): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...skillFiles(path))
    else if (entry.name === 'SKILL.md') found.push(path)
  }
  return found.sort()
}

/** The declared parameter names of one tool schema, read out of the real schema object. */
function declaredParameters(schema: Readonly<Record<string, unknown>>): Set<string> {
  const properties = schema['properties']
  assert.ok(
    typeof properties === 'object' && properties !== null,
    'the imported schema carries no properties object — the import is not the schema',
  )
  return new Set(Object.keys(properties as Record<string, unknown>))
}

/**
 * Names a skill may mention that are not that tool's parameters, with the reason. Each is a
 * deliberate ruling, not a wildcard: `run_in_background` on the `bash` tool is real
 * (`dsh-tool-bash/lib/index.js:281`) and the playbooks say so in the same sentence.
 */
const NOT_A_PARAMETER: Readonly<Record<string, string>> = {
  model:
    'a real parameter of the stock DSH `subagent` tool (dsh-tool-subagent/lib/index.js:412-425, ' +
    'and only on a model-selection-enabled instance) that `pstack_spawn` deliberately does not ' +
    "carry: a role's model comes from the route catalog, and spawn.ts:1-30 says why. The " +
    'routed skills keep saying `model` as configuration shorthand for the role line.',
}

/** One parameter-shaped name, and where it was found. */
interface Reference {
  readonly tool: string
  readonly name: string
  readonly file: string
  readonly line: number
  readonly text: string
}

/**
 * Parameter-shaped `key: value` names in one file, filtered to the tool the file names.
 *
 * Line-oriented by design: a paragraph-level rule would have to decide which prose is a call
 * site, which is the model's job. The cost is that a call site written without backticks around
 * the argument name is invisible here — stated in the header, not hidden.
 */
function referencesIn(file: string, text: string): Reference[] {
  const tools = [
    { name: PSTACK_SPAWN_TOOL, declared: declaredParameters(PSTACK_SPAWN_PARAMETERS) },
    { name: PSTACK_SPAWN_PANEL_TOOL, declared: declaredParameters(PSTACK_SPAWN_PANEL_PARAMETERS) },
  ]

  const references: Reference[] = []
  const lines = text.split('\n')
  // Which tools the enclosing section names. Reset at every heading, so `how/SKILL.md` naming
  // both tools in two different sections never attributes one section's list to the other.
  let scope: typeof tools = []

  for (const [index, line] of lines.entries()) {
    if (/^#{1,6}\s/.test(line)) scope = []
    const namedHere = tools.filter((tool) => line.includes(tool.name))
    if (namedHere.length > 0) scope = namedHere

    // The candidate tools for this line: those named on it, or the section's scope, so a config
    // list can sit a few lines under the sentence that introduces the tool.
    const candidates = namedHere.length > 0 ? namedHere : scope
    if (candidates.length === 0) continue

    const inline = namedHere.length > 0
    // Shape 1: a backticked `key: value` on a line that names the tool. `https://…` and prose
    // colons are excluded by requiring the key to be a bare identifier and the value to be
    // backtick-terminated *and* the line to be short enough to be a call site rather than a
    // paragraph of body text.
    // Shape 2: a backticked list item whose whole left side is the key.
    const pattern = inline
      ? /`([a-z][a-z0-9_]*)\s*:\s*[^`\s][^`]*`/g
      : /^\s*[-*]\s+`([a-z][a-z0-9_]*)\s*`\s*:\s*\S/g

    for (const match of line.matchAll(pattern)) {
      const name = match[1]
      if (name === undefined) continue
      // A URL scheme (`https://…`) is the one identifier-shaped false positive this pattern
      // admits; body prose that mentions the tool alongside a backticked pair is the other.
      if (match[0].includes('://')) continue

      // A name legal for every tool in scope is not this test's business: each schema's
      // `additionalProperties` is the tool's own affair, and `role` is legal for both tools.
      const undeclared = candidates.filter((tool) => !tool.declared.has(name))
      if (undeclared.length === 0) continue

      references.push({
        tool: undeclared.map((tool) => tool.name).join(' + '),
        name,
        file: file.slice(skillsDir.length + 1),
        line: index + 1,
        text: line.trim().slice(0, 120),
      })
    }
  }
  return references
}

test('the extraction covers the ported tree, so a silent empty scan cannot pass', () => {
  const files = skillFiles()
  assert.ok(files.length >= 40, `expected the full ported tree, found ${files.length} SKILL.md files`)

  const withSpawn = files.filter((file) => readFileSync(file, 'utf8').includes(PSTACK_SPAWN_TOOL))
  assert.ok(withSpawn.length >= 5, `expected several skills to name ${PSTACK_SPAWN_TOOL}, found ${withSpawn.length}`)

  // The sweep has to see real call sites, not just files, and it has to see the ones that are
  // legal as well: `role: generalPurpose` is a call site that must extract clean.
  const seen = withSpawn.flatMap((file) => referencesIn(file, readFileSync(file, 'utf8')))
  assert.ok(
    seen.some((reference) => reference.name === 'model'),
    'no `model:` call site was extracted — the extractor or the tool-name filter is broken',
  )
  assert.ok(
    seen.length >= 3,
    `expected the tree to yield several call-site names, found ${seen.length}`,
  )
})

for (const [tool, schema] of [
  [PSTACK_SPAWN_TOOL, PSTACK_SPAWN_PARAMETERS],
  [PSTACK_SPAWN_PANEL_TOOL, PSTACK_SPAWN_PANEL_PARAMETERS],
] as const) {
  test(`every ${tool} parameter named in a skill is declared in its schema`, () => {
    const declared = declaredParameters(schema)
    const violations: string[] = []

    for (const file of skillFiles()) {
      for (const reference of referencesIn(file, readFileSync(file, 'utf8'))) {
        if (NOT_A_PARAMETER[reference.name] !== undefined) continue
        if (declared.has(reference.name)) continue
        violations.push(
          `${reference.file}:${reference.line} passes \`${reference.name}\` to ${reference.tool} — ` +
            `declared: ${[...declared].sort().join(', ')} | ${reference.text}`,
        )
      }
    }

    assert.deepEqual(
      violations,
      [],
      `these skills name a parameter the tool does not declare, so the call fails validation:\n  ` +
        violations.join('\n  '),
    )
  })
}

test('the allowlist entries are still needed, so it cannot rot into a blanket exemption', () => {
  const all = skillFiles().flatMap((file) => referencesIn(file, readFileSync(file, 'utf8')))
  const stale = Object.keys(NOT_A_PARAMETER).filter(
    (name) => !all.some((reference) => reference.name === name),
  )
  assert.deepEqual(
    stale,
    [],
    'these allowlist entries no longer match anything in the tree — delete them so the next ' +
      'unexpected name fails loudly: ' + stale.join(', '),
  )
})
