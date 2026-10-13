/**
 * Frontmatter parser contract, checked against the shapes the real corpus uses.
 *
 * The corpus is the 47 upstream pstack skills at the pinned commit (see scripts/fetch-upstream.sh);
 * every shape asserted below was counted from that tree, not invented. The parser's job is to
 * agree with `@deepseek-ai/dsh-skill-filesystem`, which uses a full YAML parser
 * (`dsh-skill-filesystem/lib/index.js:765`), on everything those files contain — and to fail
 * loud rather than half-understand anything else.
 *
 * These are rung 4 checks: they call the real parser and fail loud.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isSkillName,
  parseFrontmatter,
  parseInvocationPolicy,
  readSkillFrontmatter,
  SkillFrontmatterError,
} from '../src/skills/frontmatter.ts'

test('parses a plain scalar block, the shape 47/47 skills use', () => {
  const block = parseFrontmatter('---\nname: unslop\ndescription: Cut AI tells from any writing.\n---\n# Body\n')
  assert.ok(block)
  assert.deepEqual(block.data, { name: 'unslop', description: 'Cut AI tells from any writing.' })
  assert.equal(block.body, '# Body\n')
})

test('unquotes double-quoted scalars with escaped quotes (architect, how, recall, tdd)', () => {
  const raw = [
    '---',
    'name: how',
    'description: "Use for \\"how does X work\\", code walkthroughs."',
    '---',
    '',
  ].join('\n')
  const block = parseFrontmatter(raw)
  assert.equal(block?.data['description'], 'Use for "how does X work", code walkthroughs.')
})

test('unquotes single-quoted scalars, where the only escape is a doubled quote', () => {
  const block = parseFrontmatter("---\nname: x\ndescription: 'it''s fine'\n---\n")
  assert.equal(block?.data['description'], "it's fine")
})

test('parses a one-line flow sequence (typescript-best-practices paths)', () => {
  const block = parseFrontmatter('---\nname: x\ndescription: d\npaths: ["**/*.ts", "**/*.tsx"]\n---\n')
  assert.deepEqual(block?.data['paths'], ['**/*.ts', '**/*.tsx'])
})

test('folds >- into one line (make-bot-ui description)', () => {
  const raw = [
    '---',
    'name: make-bot-ui',
    'description: >-',
    '  Use when building a custom UI (page, dashboard, buttons) that should wake a',
    '  Grok Bot over a webhook, when the user must provide a webhook sender key, or',
    '  when exposing that UI on Tailscale.',
    'disable-model-invocation: true',
    '---',
    '',
  ].join('\n')
  const block = parseFrontmatter(raw)
  assert.equal(
    block?.data['description'],
    'Use when building a custom UI (page, dashboard, buttons) that should wake a Grok Bot over ' +
      'a webhook, when the user must provide a webhook sender key, or when exposing that UI on Tailscale.',
  )
  assert.equal(block?.data['disable-model-invocation'], true)
})

test('literal | keeps newlines and - strips the trailing one', () => {
  const stripped = parseFrontmatter('---\nname: x\ndescription: |-\n  one\n  two\n---\n')
  assert.equal(stripped?.data['description'], 'one\ntwo')
  const kept = parseFrontmatter('---\nname: x\ndescription: |\n  one\n  two\n---\n')
  assert.equal(kept?.data['description'], 'one\ntwo\n')
})

test('reads one level of nested mapping for the metadata object', () => {
  const block = parseFrontmatter('---\nname: x\ndescription: d\nmetadata:\n  owner: pstack\n  tier: 2\n---\n')
  // `tier` is typed by the core schema, so a nested number stays a number.
  assert.deepEqual(block?.data['metadata'], { owner: 'pstack', tier: 2 })
})

test('types plain scalars the way YAML does, and quoting forces a string', () => {
  const block = parseFrontmatter(
    '---\nname: x\ndescription: d\na: true\nb: 12\nc: 1.5\nd: null\ne: "true"\nf: ~\n---\n',
  )
  assert.equal(block?.data['a'], true)
  assert.equal(block?.data['b'], 12)
  assert.equal(block?.data['c'], 1.5)
  assert.equal(block?.data['d'], null)
  assert.equal(block?.data['e'], 'true')
  assert.equal(block?.data['f'], null)
})

test('skips blank lines and full-line comments without touching values', () => {
  const block = parseFrontmatter('---\n# a comment\n\nname: x\ndescription: has a # inside\n---\n')
  assert.deepEqual(block?.data, { name: 'x', description: 'has a # inside' })
})

test('tolerates CRLF line endings', () => {
  const block = parseFrontmatter('---\r\nname: x\r\ndescription: d\r\n---\r\nbody\r\n')
  assert.deepEqual(block?.data, { name: 'x', description: 'd' })
  assert.equal(block?.body, 'body\r\n')
})

test('no frontmatter block is undefined, matching the filesystem provider', () => {
  assert.equal(parseFrontmatter('# just markdown\n'), undefined)
  assert.equal(parseFrontmatter(''), undefined)
  // An unterminated block is "missing frontmatter" in DSH too, which returns void 0 rather
  // than throwing (dsh-skill-filesystem/lib/index.js:776).
  assert.equal(parseFrontmatter('---\nname: x\ndescription: d\n'), undefined)
})

test('a malformed block throws instead of being half-understood', () => {
  assert.throws(
    () => parseFrontmatter('---\nname: x\n- a list item where a mapping was expected\n---\n'),
    (error: unknown) => error instanceof SkillFrontmatterError,
  )
  assert.throws(
    () => parseFrontmatter('---\nname: x\nname: y\ndescription: d\n---\n'),
    /duplicate frontmatter key "name"/,
  )
  assert.throws(
    () => parseFrontmatter('---\nname: "unterminated\ndescription: d\n---\n'),
    /unterminated double-quoted value/,
  )
  assert.throws(() => parseFrontmatter('---\nname: x\npaths: ["a", "b"\n---\n'), /unterminated flow sequence/)
})

test('an indented line with no parent key is malformed', () => {
  assert.throws(() => parseFrontmatter('---\n  orphan: value\n---\n'), /unexpected indented line/)
})

test('resolves invocation defaults exactly as DSH does', () => {
  const absent = parseInvocationPolicy({}, 'test')
  assert.deepEqual(absent, { modelInvocable: true, userInvocable: true })
  const disabled = parseInvocationPolicy({ 'disable-model-invocation': true }, 'test')
  assert.deepEqual(disabled, { modelInvocable: false, userInvocable: true })
  const userOff = parseInvocationPolicy({ 'user-invocable': false }, 'test')
  assert.deepEqual(userOff, { modelInvocable: true, userInvocable: false })
  const reEnabled = parseInvocationPolicy({ 'user-invocable': true }, 'test')
  assert.equal(reEnabled.userInvocable, true)
})

test('a non-boolean invocation flag drops the whole skill rather than defaulting', () => {
  // DSH throws here too (frontmatterBoolean -> TypeError,
  // dsh-skill-filesystem/lib/index.js:855-869); defaulting would silently widen access.
  assert.throws(
    () => parseInvocationPolicy({ 'disable-model-invocation': 'maybe' }, 'test'),
    /must be a boolean/,
  )
})

test('the retired camelCase invocation keys are rejected loudly', () => {
  assert.throws(
    () => parseInvocationPolicy({ disableModelInvocation: true }, 'test'),
    /"disableModelInvocation" is unsupported; use "disable-model-invocation"/,
  )
  assert.throws(() => parseInvocationPolicy({ userInvocable: false }, 'test'), /is unsupported/)
  assert.throws(() => parseInvocationPolicy({ modelInvocable: false }, 'test'), /is unsupported/)
})

test('readSkillFrontmatter enforces name, description and the kebab-case grammar', () => {
  assert.throws(() => readSkillFrontmatter({ name: 'x' }, 'f'), /requires name and description/)
  assert.throws(() => readSkillFrontmatter({ name: 'x', description: '' }, 'f'), /requires name/)
  // Upstream spellings that Phase 3 must translate, not accept:
  assert.throws(
    () => readSkillFrontmatter({ name: 'Poteto Mode', description: 'd' }, 'f'),
    /invalid skill name "Poteto Mode"/,
  )
  const ok = readSkillFrontmatter({ name: 'pstack-self-check', description: 'd' }, 'f')
  assert.equal(ok.name, 'pstack-self-check')
  assert.deepEqual(ok.invocation, { modelInvocable: true, userInvocable: true })
  const withMeta = readSkillFrontmatter(
    { name: 'x', description: 'd', whenToUse: 'now', metadata: { owner: 'pstack' } },
    'f',
  )
  assert.equal(withMeta.whenToUse, 'now')
  assert.deepEqual(withMeta.metadata, { owner: 'pstack' })
})

test('metadata that is not a mapping is rejected, not dropped', () => {
  assert.throws(
    () => readSkillFrontmatter({ name: 'x', description: 'd', metadata: ['a'] }, 'f'),
    /"metadata" must be a mapping/,
  )
})

test('isSkillName matches the registry grammar', () => {
  assert.equal(isSkillName('pstack-self-check'), true)
  assert.equal(isSkillName('Poteto Mode'), false)
  assert.equal(isSkillName('a--b'), false)
  assert.equal(isSkillName(''), false)
})
