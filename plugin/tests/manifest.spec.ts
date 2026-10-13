/**
 * Installability contract: what a `dsh plugin --profile <name> add` needs to be true.
 *
 * This test exists because the skeleton failed all three checks silently. `main` pointed at
 * `lib/index.js`, `tsconfig.json` had `emitDeclarationOnly: true` so no such file was ever
 * produced, and `package.json` declared no `dsh.bundle` — so DSH installed the package as a
 * plain dependency and printed "not a profile layer" while everything looked fine. A plugin
 * that installs without joining the layer stack is a plugin that never runs.
 *
 * These are rung 4 checks: they read the real manifest and the real filesystem and fail loud.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
  version?: string
  main?: string
  files?: string[]
  exports?: Record<string, unknown>
  dsh?: {
    bundle?: { patch?: string }
    client?: { platform?: string; inject?: readonly string[] }
  }
}

test('dsh.client.inject names the services the client half renders into', () => {
  // This field was wrong until 2026-09-16 and nothing noticed, which is why the test exists.
  // It listed package paths (`@deepseek-ai/dsh-client-ui-slots`, `…-ui-settings`) where the field
  // takes service ids. The comparison that found it: `dsh-dev-git-graph`, a client plugin that
  // demonstrably renders in this GUI, declares `["sessions","slots","betterSidebar"]` — bare ids.
  //
  // A mismatch here is a silent blank tab: the factory requests `slots` by id, and if the
  // contribution's declared injections never resolve, the section is never mounted while its tab
  // still appears. Nothing throws where a user or a log can see it.
  assert.equal(pkg.dsh?.client?.platform, 'web', 'the client half is a web platform module')

  const inject = pkg.dsh?.client?.inject ?? []
  assert.deepEqual(
    [...inject],
    ['slots'],
    'the client half registers one settings.section slot and requests nothing else; list service ids',
  )
  for (const id of inject) {
    assert.doesNotMatch(id, /[/@]/, `"${id}" looks like a package path, not a service id`)
  }
})

test('declares dsh.bundle.patch, so the package joins the profile layer stack', () => {
  // Confirmed against DSH source: lib/plugin-Ddi42qoW.js exportsPatch() returns
  // `manifest.dsh?.bundle?.patch !== undefined`, and only then is the package appended to
  // `dsh.profile.bundles`. Without it, `dsh plugin add` warns
  // "declares no dsh.bundle — installed as a plain dependency, not a profile layer".
  assert.ok(
    pkg.dsh?.bundle?.patch,
    'package.json must declare dsh.bundle.patch pointing at cordis.patch.yml',
  )
  const patchPath = join(pkgDir, pkg.dsh.bundle.patch)
  assert.ok(existsSync(patchPath), `dsh.bundle.patch points at a missing file: ${patchPath}`)

  // The patch must be a top-level array, per the loader's patch-list shape. Comments and
  // blank lines are allowed anywhere; the first real line is what has to be a list.
  const patch = readFileSync(patchPath, 'utf8')
  const body = patch
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  assert.ok(body.length > 0, 'cordis.patch.yml is empty — it must be a top-level list')
  assert.match(body[0] ?? '', /^(-|\[)/, 'cordis.patch.yml must be a top-level YAML list')
})

test('the entry point its own manifest advertises actually exists', () => {
  // `main` is what the loader imports and what `files` ships. A manifest that promises a
  // file the build never emits installs cleanly and fails at load.
  const main = pkg.main
  assert.equal(typeof main, 'string', 'package.json must declare main')
  const mainPath = join(pkgDir, main)
  assert.ok(
    existsSync(mainPath),
    `${main} does not exist — run \`npm run build\`. A plugin is loaded from its built ` +
      'entry, so an unbuilt plugin fails at load, not at install.',
  )
})

test('every relative path in exports resolves on disk', () => {
  const walk = (value: unknown): string[] => {
    if (typeof value === 'string') return value.startsWith('./') ? [value] : []
    if (value && typeof value === 'object') return Object.values(value).flatMap(walk)
    return []
  }
  // No extension is excused here. This test used to skip `.ts` targets on the grounds that
  // "type sources ship in `files`" — but `src/` no longer ships (see the `files` test below),
  // and the declaration target `./lib/index.d.ts` is a `.ts` path that must exist like any
  // other. Seeded to confirm: deleting `lib/index.d.ts` used to leave this test green.
  const missing = walk(pkg.exports).filter((p) => !existsSync(join(pkgDir, p)))
  assert.deepEqual(missing, [], `exports points at missing files: ${missing.join(', ')}`)
})

test('exports `types` resolves, because a `.ts` target is not exempt', () => {
  // The regression the filter above hid: `.d.ts` is a shipped artifact, not a source file.
  const types = (pkg.exports as Record<string, { types?: string } | undefined>)['.']?.types
  assert.equal(typeof types, 'string', 'exports["."] must declare a `types` target')
  assert.ok(existsSync(join(pkgDir, types)), `${types} is declared but does not exist`)
})

test('`files` ships every path the manifest advertises, and nothing it does not', () => {
  // `files` is the publish boundary. An `exports` target outside it installs fine on the
  // author's machine (where the whole repo is present) and is missing for everyone else.
  const files = pkg.files
  assert.ok(Array.isArray(files) && files.length > 0, 'package.json must declare a `files` array')

  // Every `files` entry must exist, or the author believes they ship something they do not.
  const absent = files.filter((entry) => !existsSync(join(pkgDir, entry)))
  assert.deepEqual(absent, [], `files lists paths that do not exist: ${absent.join(', ')}`)

  // `lib` must ship: it is what the loader imports.
  assert.ok(files.includes('lib'), '`lib` must ship — it is the built entry the loader imports')

  // `src` must NOT ship: the runtime never reads it (lib/ is compiled), and shipping it
  // doubles the tarball with TypeScript nothing at install time executes.
  assert.ok(!files.includes('src'), '`src` must not ship; the runtime reads only built `lib/`')
})

test('the version is a real semver, not the 0.0.0 placeholder', () => {
  // 0.0.0 is what `npm init` leaves behind and what npm refuses to treat as a release.
  // Seeded: setting it back to 0.0.0 fails this test.
  const version = pkg.version
  assert.equal(typeof version, 'string', 'package.json must declare a version')
  assert.notEqual(version, '0.0.0', 'the placeholder version is not publishable')
  assert.match(version as string, /^\d+\.\d+\.\d+$/, `not a plain semver release: ${version}`)
})

