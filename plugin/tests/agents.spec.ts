/**
 * The two ported agent definitions are shipped content that nothing else reads: a renamed or
 * de-kebabed file would only surface when a skill's `role:` call site stopped resolving, long
 * after the port. This is the cheap rot check — files exist, frontmatter parses, names are
 * kebab-case — not a frontmatter framework.
 *
 * The names are the invariant the sibling skills' call sites use (`role: comment-sicko` in
 * `no-comments/SKILL.md`, `role: "poteto-agent"` in `poteto-mode/SKILL.md`), and DSH validates a
 * candidate name against `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` (`dsh-skill/lib/index.js:17`).
 *
 * These are rung 4 checks: they read the real files and fail loud.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isSkillName, parseFrontmatter } from '../src/skills/frontmatter.ts'

const agentsDir = fileURLToPath(new URL('../agents/', import.meta.url))

/** The pin's two agents; each is a `role` value in ours, named after its file stem. */
const roles = ['poteto-agent', 'comment-sicko']

test('both pinned roles exist as agents/<name>.md with a parsing frontmatter block', () => {
  const found = readdirSync(agentsDir).filter((f) => f.endsWith('.md') && f !== 'README.md')
  assert.deepEqual(found.sort(), roles.map((r) => `${r}.md`).sort())

  for (const role of roles) {
    const block = parseFrontmatter(readFileSync(`${agentsDir}${role}.md`, 'utf8'))
    assert.ok(block, `agents/${role}.md has no frontmatter block`)
    assert.equal(block.data['name'], role)
    assert.equal(isSkillName(block.data['name'] as string), true)
    assert.equal(typeof block.data['description'], 'string')
    // `is_background` is a Cursor agent field with no DSH meaning; it must not creep back in.
    assert.equal('is_background' in block.data, false)
  }
})

test('the upstream mixed-case name is not accepted, so the file cannot regress silently', () => {
  assert.equal(isSkillName('Comment Sicko'), false)
})
