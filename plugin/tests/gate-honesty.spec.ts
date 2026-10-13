/**
 * gate-honesty — the build gate must fail when the build fails.
 *
 * WHY THIS SPEC EXISTS
 *
 * Two sibling units independently reported that `npm run verify` printed
 * `sh: line 1: tsc: command not found` in a fresh clone and **still exited 0**, and the
 * coordinator had already confirmed the general mechanism once: a gate whose command ends in
 * `|| true` reports a problem and exits 0. On this machine (npm 12.0.2, node 26.8.1) `verify`
 * exits 127 for the missing compiler and 2 for a real type error, so that report is wrong about
 * today's tree — but nobody had written the property down where a failure would be visible.
 *
 * This spec asserts the property, not today's state. It builds a **fake repo in a temp dir**:
 * a `package.json` whose gate is `npm run build || true && npm run check || true`, and a
 * `plugin/` that has no compiler, no `src/`, no `tests/` and no tsconfig. Then it requires that
 * gate to exit non-zero. Today it exits 0.
 *
 * It never writes inside the real plugin: not `package.json`, not `src/`, not `lib/` (the
 * committed bundle the human's live Host serves). A spec that moved the real `src/` aside would
 * break every other spec in the same `node --test` process — Node runs spec files concurrently,
 * and the sibling spec then dies with ERR_MODULE_NOT_FOUND. The probe that found that is why
 * this file builds a fake tree instead of hiding the real one.
 *
 * KNOWN FAILING, DELIBERATELY. The fix is a follow-up unit: it owns `plugin/package.json`, which
 * this unit is forbidden to write (standing order 12 — a verifier does not write the diff it
 * verifies).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Whether to run the spec that fails on purpose.
 *
 * It asserts a property the real gate already satisfies, against a stand-in gate that does not.
 * Left in the default suite it makes `npm run verify` red for a defect that is not in this tree,
 * and a suite that is always red is a suite nobody reads — the opposite of this spec's purpose.
 * So it is opt-in: the failure stays one command away and cannot be forgotten, because this file
 * names it. The follow-up unit that owns `plugin/package.json` folds the assertion in properly.
 */
const RUN_DELIBERATELY_FAILING = process.env.PSTACK_GATE_HONESTY === '1'

/** The one place the gate-under-test's defect is stated. */
const SWALLOWING_VERIFY = 'npm run build || true && npm run check || true'

/**
 * A throwaway repo whose gate ends in `|| true` and whose every input is missing.
 * Returns its root; the caller removes it.
 */
function makeDefectiveRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'gate-honesty-'))
  const plugin = join(root, 'plugin')
  mkdirSync(plugin, { recursive: true })

  // The real gate's shape — `npm run build && npm run check` — with each link able to swallow
  // its own failure. `tsc` is used deliberately: this machine has no global tsc, so the build
  // genuinely cannot run, exactly as in the fresh clone the sibling units reported.
  writeFileSync(
    join(plugin, 'package.json'),
    JSON.stringify(
      {
        name: 'gate-honesty-harness',
        version: '0.0.0',
        private: true,
        scripts: {
          build: 'tsc -p tsconfig.json && tsc -p tsconfig.client.json',
          typecheck: 'tsc -p tsconfig.typecheck.json',
          test: 'node --experimental-strip-types --test tests/*.spec.ts',
          check: 'npm run typecheck && npm run test',
          verify: SWALLOWING_VERIFY,
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )

  // No node_modules, no src/, no tests/, no tsconfig*.json. Nothing to compile, nothing to run.
  return root
}

test(
  'a gate that ends in || true reports a broken build as success (the reported hole)',
  { skip: RUN_DELIBERATELY_FAILING ? false : 'set PSTACK_GATE_HONESTY=1 to run the on-purpose failure' },
  () => {
  const root = makeDefectiveRepo()
  try {
    // Precondition: the harness really is missing everything. If this is false the spec would
    // pass for the wrong reason, which is the failure mode this whole unit is about.
    assert.equal(existsSync(join(root, 'plugin', 'tsconfig.json')), false)
    assert.equal(existsSync(join(root, 'plugin', 'src')), false)
    assert.equal(existsSync(join(root, 'plugin', 'node_modules')), false)

    const run = spawnSync('npm', ['--prefix', 'plugin', 'run', 'verify'], {
      cwd: root,
      encoding: 'utf8',
      shell: false,
      env: { ...process.env, npm_config_omit: '' },
    })
    const transcript = `${run.stdout}${run.stderr}`

    // Evidence the build genuinely failed, whatever the exit code says.
    assert.match(transcript, /command not found/, 'the build did not actually fail')

    assert.notEqual(
      run.status,
      0,
      'the gate reported success on a build that never ran: ' +
        `verify exited ${String(run.status)} while its own output says ` +
        '"tsc: command not found". A gate that cannot fail is not a gate, and CI ' +
        'goes green on an uncompiled tree. ' +
        `\n--- transcript ---\n${transcript}`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  },
)

test('the harness is a temp dir and touches no file in the real plugin', () => {
  const root = makeDefectiveRepo()
  rmSync(root, { recursive: true, force: true })

  assert.equal(existsSync(root), false, 'temp harness left behind')
  assert.ok(
    root.startsWith(tmpdir()),
    'the harness must live outside the repo, so no concurrent spec can see it move',
  )
})
