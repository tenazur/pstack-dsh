/**
 * The invocation policy every ported skill must carry.
 *
 * A live session settled this: DSH filters a skill out of the
 * model-facing catalog when its frontmatter sets `disable-model-invocation: true`
 * (`dsh-tool-skill/lib/index.js:217`), **and** refuses a named `skill` call for it with
 * `Error: skill "<name>" is not available for model invocation` (`:147`, `:150`), before
 * `ctx.skills.get()` is reached. 46 of the 47 upstream skills carry that key, and our ported
 * text tells the model to load principles by name — so a ported skill that keeps the key is
 * unreachable, and the failure is silent.
 *
 * This test is the guard. It runs the same provider the plugin registers, against the real
 * bundled tree, so a porting mistake fails here instead of in a session where nobody notices.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createBundledSkillProvider } from '../src/skills/provider.ts'

const skillsDir = fileURLToPath(new URL('../skills', import.meta.url))

function provider() {
  return createBundledSkillProvider({
    skillsDir,
    logger: { warn: () => {} },
  })
}

test('every skill in the bundled tree is model-invocable', async () => {
  const p = provider()
  const listed = await p.list({})
  const candidates = Array.isArray(listed) ? listed : listed.candidates

  assert.ok(candidates.length > 0, `the bundled tree at ${skillsDir} holds no discoverable skills`)

  const blocked = candidates
    .filter((c) => c.invocation.modelInvocable !== true)
    .map((c) => c.name)

  assert.deepEqual(
    blocked,
    [],
    'these skills carry modelInvocable: false, so the model cannot list or load them — ' +
      'drop `disable-model-invocation: true` from their frontmatter: ' +
      blocked.join(', '),
  )
})

test('every skill in the bundled tree is user-invocable too, so /name still works', async () => {
  const p = provider()
  const listed = await p.list({})
  const candidates = Array.isArray(listed) ? listed : listed.candidates

  // The human `/name` gesture is gated on userInvocable alone, and it is the only remaining
  // path once a skill is filtered from the model catalog. A skill that is neither
  // model-invocable nor user-invocable is dead weight, so this asserts the floor.
  const unreachable = candidates
    .filter((c) => c.invocation.userInvocable !== true && c.invocation.modelInvocable !== true)
    .map((c) => c.name)

  assert.deepEqual(unreachable, [], `these skills are reachable by neither surface: ${unreachable.join(', ')}`)
})

test('every skill name is valid kebab-case, so none is silently skipped', async () => {
  const p = provider()
  const listed = await p.list({})
  const candidates = Array.isArray(listed) ? listed : listed.candidates

  // The provider skips a non-conforming name with a warning rather than throwing, so a bad
  // name is a *missing* skill, not a failed boot. Upstream spells one as `Poteto Mode`; the
  // port renames it. This asserts the rename happened for every directory that needs one.
  const bad = candidates.map((c) => c.name).filter((n) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n))
  assert.deepEqual(bad, [], `these ported names are not kebab-case and would be dropped: ${bad.join(', ')}`)
})
