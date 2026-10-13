#!/usr/bin/env bash
#
# Prove the layout gate can fail.
#
# `scripts/check-page-layout.mjs` had never been observed to fail, and a check that cannot fail is
# not a check. This witness seeds a real layout defect into a *scratch* copy of the harness, runs the
# untouched gate source against it, and asserts the gate refuses. It then seeds a break in a selector
# the gate matches on and asserts the gate refuses that too, instead of passing vacuously.
#
# Nothing under `plugin/` is written: `plugin/lib/client.js` is the file a live Host serves. The seed
# enters through a scratch copy of the tokens the gate splices into its own page, and the bundle is
# read from a scratch copy, so the real tree is never modified. The only file the gate itself writes
# is `scripts/page-harness/layout-page.html`, which it regenerates on every run and which is
# gitignored; this script's scratch lives under `scripts/page-harness/.witness/`, also gitignored.
#
# Exits 0 when every case behaves (the gate fails when it should) and 1 otherwise, so it can be a CI
# gate itself. Prints one PASS/FAIL line per case.
#
#   ./scripts/check-layout-witness.sh
set -uo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
gate="$repo/scripts/check-page-layout.mjs"
harness="$repo/scripts/page-harness"
work="$harness/.witness"
bundle="$repo/plugin/lib/client.js"
fixture="$repo/plugin/tests/fixtures/fleet-view.live.json"

failures=0

say() { printf '%s\n' "$*"; }
pass() { say "PASS: $*"; }
bad() { say "FAIL: $*"; failures=$((failures + 1)); }

if [[ ! -x /usr/bin/chromium ]]; then
  say "SKIP: /usr/bin/chromium is not installed, so the gate cannot be witnessed"
  exit 0
fi
if [[ ! -f "$bundle" ]]; then
  say "FAIL: $bundle is missing; run 'npm --prefix plugin run build' first"
  exit 1
fi
if [[ ! -f "$harness/react-from-shell.js" ]]; then
  say "FAIL: $harness/react-from-shell.js is missing; run 'node scripts/page-harness/extract-react.mjs' first"
  exit 1
fi

mkdir -p "$work"
stash="$work/stash"
rm -rf "$stash"
mkdir -p "$stash"

# A copy of the bundle and the fixture, so the gate under test can be pointed away from the real ones.
cp "$bundle" "$stash/client.js"
cp "$fixture" "$stash/fleet-view.live.json"
# The page the gate writes is served from this directory, so React must sit beside it.
cp "$harness/react-from-shell.js" "$stash/react-from-shell.js"

# The gate is driven through a copy whose three path constants are redirected: the page it writes,
# the browser profile it uses, and the tokens it splices. Its logic is byte-identical.
cat > "$stash/gate-under-test.mjs" <<'GATE'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// here = <repo>/scripts/page-harness/.witness/stash
// The gate derives everything (`repo`, `harness`, `tokens`, `react`) from its own module URL. Pinning
// `repo` to the real repository root leaves its harness inputs pointing at the real files, and the
// three redirects below move only the page it writes, the browser profile, and the bundle it reads.
const repo = resolve(here, '..', '..', '..', '..')
const seedCss = process.env.SEED_CSS ?? ''
let src = readFileSync(resolve(repo, 'scripts/check-page-layout.mjs'), 'utf8')
src = src.replace(
  "const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')",
  `const repo = ${JSON.stringify(repo)}`,
)
src = src.replace(
  'const page = join(harness,',
  `const page = ${JSON.stringify(resolve(here, 'layout-page.html'))}; const __unusedPage = join(harness,`,
)
src = src.replace(
  'const profile = join(harness,',
  `const profile = ${JSON.stringify(resolve(here, 'profile'))}; const __unusedProfile = join(harness,`,
)
src = src.replace(
  "const tokens = readFileSync(join(harness, 'tokens.css'), 'utf8')",
  `const tokens = readFileSync(join(harness, 'tokens.css'), 'utf8') + ${JSON.stringify('\n' + seedCss + '\n')}`,
)
src = src.replace(
  "const bundle = join(repo, 'plugin/lib/client.js')",
  `const bundle = ${JSON.stringify(resolve(here, 'client.js'))}`,
)
src = src.replace(
  "const payloadPath = process.argv[2] ?? join(repo, 'plugin/tests/fixtures/fleet-view.live.json')",
  `const payloadPath = process.argv[2] ?? ${JSON.stringify(resolve(here, 'fleet-view.live.json'))}`,
)
const patched = resolve(here, 'gate-patched.mjs')
writeFileSync(patched, src)
const r = spawnSync(process.execPath, [patched, ...process.argv.slice(2)], { encoding: 'utf8', cwd: repo })
process.stdout.write(r.stdout)
process.stderr.write(r.stderr)
console.log('GATE_EXIT=' + String(r.status))
GATE

# Run the gate once with a seeded stylesheet appended to the tokens it splices in.
run_case() {
  local name="$1" css="$2" want="$3" out rc
  out="$(SEED_CSS="$css" node "$stash/gate-under-test.mjs" 2>&1)"
  rc="$(printf '%s\n' "$out" | sed -n 's/^GATE_EXIT=//p' | tail -1)"
  printf '%s\n' "$out" | grep -v '^GATE_EXIT=' | sed 's/^/    /'
  # No exit code means the harness itself broke, which is not evidence about the gate. Treating it
  # as a refusal would let a witness pass on a crash — a dead check inside the check that hunts them.
  if [[ -z "$rc" ]]; then
    bad "$name: the gate harness did not run to completion, so this case proves nothing"
    return
  fi
  if [[ "$want" == "fail" ]]; then
    if [[ "$rc" == "0" ]]; then
      bad "$name: the gate reported success on a broken page (exit $rc)"
    else
      pass "$name: the gate refused (exit $rc)"
    fi
  else
    if [[ "$rc" == "0" ]]; then
      pass "$name: the gate reports OK (exit 0)"
    else
      bad "$name: the gate failed on a healthy page (exit $rc)"
    fi
  fi
}

say "== layout gate witness =="
say "gate: $gate"
say ""

# Baseline first: if the untouched page is not green, every later result is meaningless.
run_case "baseline, no seed" "" pass

# (a) a control genuinely wider than its card — the defect the gate exists for.
run_case "(a) a select wider than its card" \
  '[data-pviolin="general"] select{width:900px !important; flex:0 0 auto !important}' fail

# (b) a chip whose label is squeezed to zero width.
run_case "(b) a chip label with no box" \
  '[data-pviolin="planning"] [data-pchip-label]{display:none !important}' fail

# (c) a page that forces horizontal scroll.
run_case "(c) a page that scrolls sideways" \
  'body{min-width:1600px !important}' fail

# (d) the vacuous pass: break a selector the gate matches on, by renaming the attribute in a COPY of
# the bundle. Before the fix this printed LAYOUT OK and exited 0.
node -e '
const { readFileSync, writeFileSync } = require("node:fs")
const [src, out] = process.argv.slice(1)
const text = readFileSync(src, "utf8")
const renamed = text.replace(/data-pchip-label/g, "data-pchip-label-RENAMED")
if (renamed === text) { console.error("no data-pchip-label in the bundle to rename"); process.exit(1) }
writeFileSync(out, renamed)
' "$bundle" "$stash/client.js"
run_case "(d) a renamed chip-label selector (vacuous pass)" "" fail
cp "$bundle" "$stash/client.js"

# (d2) the same vacuity one level up: no cards match at all.
node -e '
const { readFileSync, writeFileSync } = require("node:fs")
const [src, out] = process.argv.slice(1)
const text = readFileSync(src, "utf8")
const renamed = text.replace(/data-pviolin/g, "data-pviolinX")
if (renamed === text) { console.error("no data-pviolin in the bundle to rename"); process.exit(1) }
writeFileSync(out, renamed)
' "$bundle" "$stash/client.js"
run_case "(d2) a renamed card selector, no cards match" "" fail
cp "$bundle" "$stash/client.js"

# The harness guard: a page that never laid out must refuse, not measure pre-layout boxes.
run_case "(e) a page that never laid out" 'body{display:none !important}' fail

# Clean up, so the tree is exactly as it was found.
rm -rf "$work"

say ""
if [[ "$failures" -gt 0 ]]; then
  say "WITNESS FAIL: $failures case(s) did not behave"
  exit 1
fi
say "WITNESS PASS: the layout gate fails when the page is broken, and refuses to pass vacuously"
exit 0
