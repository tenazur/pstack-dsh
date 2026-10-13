/**
 * Provider contract, checked against a real temporary skill tree and the real bundled tree.
 *
 * The provider must return candidates that survive the registry's own validators —
 * `validateCandidate` (`dsh-skill/lib/index.js:453`) and `validateDefinition` (`:478`) — and
 * those live in a package this one cannot import. So the invariants are mirrored here with the
 * citation, and the *real* check is the boot harness in `../../scratch/p2-boot/`, where the
 * actual registry accepts or rejects them. A mirror test is rung 4 for our code and rung 3 for
 * the claim "the registry will accept it"; the harness is what closes that gap.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLED_SKILL_RANK, createBundledSkillProvider, PSTACK_SKILL_PROVIDER } from '../src/skills/provider.ts'

const pkgDir = fileURLToPath(new URL('..', import.meta.url))

/** Write one skill directory into `root`. */
async function writeSkill(root: string, dir: string, body: string): Promise<void> {
  await mkdir(join(root, dir), { recursive: true })
  await writeFile(join(root, dir, 'SKILL.md'), body, 'utf8')
}

const VALID_A = '---\nname: alpha-skill\ndescription: The first skill.\n---\n\nBody A.\n'
const VALID_B = '---\nname: beta-skill\ndescription: The second skill.\nwhenToUse: when testing\n---\n\nBody B.\n'

/** Build a temp skill root, run `body`, and always clean up. */
async function withTempSkills<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pstack-provider-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('list() returns one candidate per valid skill and skips the invalid ones', async () => {
  await withTempSkills(async (root) => {
    await writeSkill(root, 'alpha-skill', VALID_A)
    await writeSkill(root, 'beta-skill', VALID_B)
    // Skipped, each for a different reason, and none of them may abort the scan:
    await writeSkill(root, 'no-frontmatter', '# no frontmatter here\n')
    await writeSkill(root, 'legacy-flags', '---\nname: legacy-flags\ndescription: d\ndisableModelInvocation: true\n---\n')
    await writeSkill(root, 'Bad Name', '---\nname: Bad Name\ndescription: d\n---\n')
    await writeFile(join(root, 'not-a-directory.md'), 'loose file\n')

    const warned: string[] = []
    const provider = createBundledSkillProvider({ skillsDir: root, logger: { warn: (m) => warned.push(m) } })
    const candidates = await provider.list({})

    assert.deepEqual(
      candidates.map((candidate) => candidate.name),
      ['alpha-skill', 'beta-skill'],
    )
    assert.equal(warned.length, 3, `expected 3 skip warnings, got: ${warned.join(' | ')}`)
    assert.ok(warned.some((line) => line.includes('disableModelInvocation')))
  })
})

test('a candidate carries every field the registry validates', async () => {
  await withTempSkills(async (root) => {
    await writeSkill(root, 'alpha-skill', VALID_A)
    const provider = createBundledSkillProvider({ skillsDir: root })
    const [candidate] = await provider.list({})
    assert.ok(candidate)

    // Mirrors validateCandidate (dsh-skill/lib/index.js:453-471).
    assert.match(candidate.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert.equal(typeof candidate.description, 'string')
    assert.ok(candidate.description.length > 0)
    assert.equal(typeof candidate.invocation.modelInvocable, 'boolean')
    assert.equal(typeof candidate.invocation.userInvocable, 'boolean')
    assert.equal(candidate.source, 'bundled')
    assert.equal(candidate.provider, PSTACK_SKILL_PROVIDER)
    assert.equal(candidate.rank, BUNDLED_SKILL_RANK)
    assert.equal(typeof candidate.path, 'string')
    assert.deepEqual(candidate.resourceBase, { kind: 'directory', path: join(root, 'alpha-skill') })
    // The locator is opaque to the registry and must round-trip through ours.
    assert.deepEqual(candidate.locator, {
      path: join(root, 'alpha-skill', 'SKILL.md'),
      directory: join(root, 'alpha-skill'),
    })
  })
})

test('get() loads the body, trims it, and re-reads the file every time', async () => {
  await withTempSkills(async (root) => {
    await writeSkill(root, 'alpha-skill', VALID_A)
    const provider = createBundledSkillProvider({ skillsDir: root })
    const [candidate] = await provider.list({})
    assert.ok(candidate)

    const first = await provider.get(candidate, {})
    assert.equal(first?.content, 'Body A.')
    assert.equal(first?.name, 'alpha-skill')
    assert.equal(first?.provider, PSTACK_SKILL_PROVIDER)

    // No body cache: an edited SKILL.md must win without a restart, because the registry
    // calls get() on every load (dsh-skill/lib/index.js:251-257).
    await writeSkill(root, 'alpha-skill', '---\nname: alpha-skill\ndescription: Edited.\n---\n\nBody A2.\n')
    const second = await provider.get(candidate, {})
    assert.equal(second?.content, 'Body A2.')
    assert.equal(second?.description, 'Edited.')
  })
})

test('get() returns undefined when the file has gone away', async () => {
  await withTempSkills(async (root) => {
    await writeSkill(root, 'alpha-skill', VALID_A)
    const provider = createBundledSkillProvider({ skillsDir: root })
    const [candidate] = await provider.list({})
    assert.ok(candidate)
    await rm(join(root, 'alpha-skill'), { recursive: true })

    assert.equal(await provider.get(candidate, {}), undefined)
  })
})

test('list() on a missing skills root is empty, not an error', async () => {
  const provider = createBundledSkillProvider({ skillsDir: join(tmpdir(), 'pstack-does-not-exist-000') })
  assert.deepEqual(await provider.list({}), [])
})

test('an aborted lookup stops discovery instead of returning a partial catalogue', async () => {
  await withTempSkills(async (root) => {
    await writeSkill(root, 'alpha-skill', VALID_A)
    const provider = createBundledSkillProvider({ skillsDir: root })
    const aborted = AbortSignal.abort()
    await assert.rejects(() => provider.list({ signal: aborted }), /abort/i)
  })
})

test('a valid disable-model-invocation reaches the candidate as modelInvocable: false', async () => {
  // The registry filters the model-facing catalogue with isModelInvocable, so a flag that the
  // provider drops or misreads silently widens who can invoke a skill. Verified end to end in a
  // real session catalogue: a bundled skill carrying this flag is listed by ctx.skills.list()
  // and absent from <available_skills>.
  await withTempSkills(async (root) => {
    await writeSkill(
      root,
      'quiet-skill',
      '---\nname: quiet-skill\ndescription: d\ndisable-model-invocation: true\n---\nbody\n',
    )
    const provider = createBundledSkillProvider({ skillsDir: root })
    const [candidate] = await provider.list({})
    assert.ok(candidate)
    assert.equal(candidate.invocation.modelInvocable, false)
    assert.equal(candidate.invocation.userInvocable, true)
  })
})

test('the provider name is the one DSH will register and echo back', () => {
  const provider = createBundledSkillProvider({ skillsDir: '/nonexistent' })
  assert.equal(provider.name, 'pstack')
  assert.equal(PSTACK_SKILL_PROVIDER, 'pstack')
})

test('the skill bundled with this package validates through the real provider', async () => {
  // ACCEPTANCE 2: plugin/skills/<name>/SKILL.md must parse, be kebab-case, and describe itself.
  // This reads the real shipped tree, not a fixture.
  const provider = createBundledSkillProvider({ skillsDir: join(pkgDir, 'skills') })
  const candidates = await provider.list({})
  const names = candidates.map((candidate) => candidate.name)
  assert.ok(names.includes('pstack-self-check'), `bundled skills were: ${names.join(', ') || '(none)'}`)

  const selfCheck = candidates.find((candidate) => candidate.name === 'pstack-self-check')
  assert.ok(selfCheck)
  assert.ok(selfCheck.description.length > 20, 'the bundled skill needs a real description')
  assert.equal(selfCheck.invocation.modelInvocable, true)

  const definition = await provider.get(selfCheck, {})
  assert.ok(definition)
  assert.equal(definition.name, 'pstack-self-check')
  assert.ok(definition.content.includes('pstack_status'), 'the body must name the real tool')
})
