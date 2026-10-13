#!/usr/bin/env bash
#
# Prove the route gate can fail.
#
# `scripts/check-route.sh` booted a Host and reported ROUTE OK the first time it ran, which is
# exactly the state `scripts/check-layout-witness.sh` was written to distrust: a check that has
# never refused is not yet a check. This witness drives the untouched gate source through its
# failure paths and asserts it refuses every time.
#
# Two cases, both through the gate's own documented seams — no copy of the gate, no patched logic:
#
#   (a) an EMPTY FLEET. The gate is pointed at a scratch home whose `pstack-fleet.json` declares no
#       violins (`ROUTE_GATE_HOME`). The Host boots, the route answers 200, and the payload carries
#       an empty fleet. This is the case the gate exists for: `curl -o /dev/null` calls it healthy.
#       It is also the shape a home with no credential seam produces, which is why the gate asserts
#       the cohort AND the catalog rather than the status code.
#
#   (b) a BUSY PORT. The gate is pointed at a port this witness is already listening on. It must
#       refuse BEFORE the boot and must not kill the listener — a gate that kills what it finds is
#       worse than one that leaks, because the human's own Host is a process it did not start.
#
# Case (b)'s listener is started by this script and killed by this script, so the process table is
# left as it was found. Nothing in the repository is written at all: this script makes a temp
# working directory, hands it to the gate through `ROUTE_GATE_WORKDIR`, and rewrites the throwaway
# home's fleet file inside it between gate runs, restoring it afterwards. The temp directory is
# removed on every exit path, so a run leaves neither files nor processes behind.
#
# Exits 0 when every case behaves (the gate fails when it should) and 1 otherwise, so it can be a CI
# gate itself. Prints one PASS/FAIL line per case and `WITNESS PASS` on success.
#
#   ./scripts/check-route-witness.sh
set -uo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
gate="$repo/scripts/check-route.sh"

# The witness owns the working directory and hands it to the gate, rather than reaching into one
# the gate made. That matters here for a concrete reason: the gate deletes the temp directory it
# creates, so a witness that depended on finding the home afterwards would be racing its own
# cleanup. `ROUTE_GATE_WORKDIR` is the gate's documented way to supply one; supplying it also tells
# the gate not to delete it, because it belongs to this script.
scratch="$(mktemp -d "${TMPDIR:-/tmp}/pstack-route-witness-XXXXXX")"
home="$scratch/home"

failures=0
listener_pid=""

say() { printf '%s\n' "$*"; }
pass() { say "PASS: $*"; }
bad() { say "FAIL: $*"; failures=$((failures + 1)); }

cleanup() {
  local rc=$?
  # Our own workdir, on every exit path including Ctrl-C. The gate leaves it alone because we
  # supplied it; removing it is this script's job.
  [[ -n "${scratch:-}" && -d "${scratch:-}" ]] && rm -rf "$scratch"
  if [[ -n "$listener_pid" ]] && kill -0 "$listener_pid" 2>/dev/null; then
    # Only the listener THIS script started, by pid. Never a pattern, never a port sweep.
    kill -TERM "$listener_pid" 2>/dev/null
    for _ in $(seq 1 20); do
      kill -0 "$listener_pid" 2>/dev/null || break
      sleep 0.25
    done
    kill -KILL "$listener_pid" 2>/dev/null
  fi
  return $rc
}
trap cleanup EXIT

if [[ ! -f "$gate" ]]; then
  say "FAIL: $gate is missing"
  exit 1
fi
if ! command -v dsh >/dev/null 2>&1; then
  say "SKIP: dsh is not on PATH, so the gate cannot be witnessed"
  exit 0
fi

# The witness needs the throwaway home the gate builds. Running the gate once is the honest way to
# create it: it is also the baseline case, so a green gate is verified before anything is seeded.
say "== route gate witness =="
say "gate: $gate"
say ""

# The listener's port. 3122, not the gate's default 3121, so a stale gate run cannot collide.
busy_port="${ROUTE_WITNESS_BUSY_PORT:-3122}"
if [[ "$busy_port" == "3080" ]]; then
  say "FAIL: the witness refuses to listen on 3080, the human's live Host"
  exit 1
fi

say "-- baseline: the untouched gate on a healthy tree"
baseline="$(ROUTE_GATE_WORKDIR="$scratch" ./"${gate#"$repo/"}" 2>&1)"
baseline_rc=$?
printf '%s\n' "$baseline" | sed 's/^/    /'
if [[ "$baseline_rc" -ne 0 ]]; then
  bad "the gate does not pass on a healthy tree (exit $baseline_rc); every case below would prove nothing"
  say ""
  say "WITNESS FAIL: $failures case(s) did not behave"
  exit 1
fi
pass "the gate passes on a healthy tree (exit 0)"
say ""

if [[ ! -f "$home/pstack-fleet.json" ]]; then
  bad "the gate did not leave a throwaway home at $home, so its failure paths cannot be driven"
  say ""
  say "WITNESS FAIL: $failures case(s) did not behave"
  exit 1
fi

# A second, private home for the cases that need a hand-edited fleet file. It is a copy of the one
# the gate just built AND the gate just booted, so its `node_modules` link already points at this
# tree's plugin; the witness supplies it through ROUTE_GATE_HOME, which uses a home verbatim. The
# copy is scratch, deleted at the end, and the gate's own home is left as the gate left it.
broken="$scratch/witness-home"
rm -rf "$broken"
cp -a "$home" "$broken"
cp "$home/pstack-fleet.json" "$scratch/witness-fleet.orig.json"
cp "$home/pstack.json" "$scratch/witness-overlay.orig.json"
# The pristine copies are the two files the gate's own boot just wrote from `defaultGroups`, so every
# case below starts from a document the build accepts and edits exactly one thing in it.
say "-- baseline (home prepared): a healthy fleet with 9 violins and a live catalog"
say "     witness home: $broken"
say ""

# Each case rewrites the fleet file in the witness home, runs the gate against it, and reports what
# the gate did. `want` is the message the gate must refuse with; a refusal for any OTHER reason is
# a FAIL, because that would mean the witness proved something else.
run_fleet_case() {
  local name="$1" body="$2" want="$3" out rc
  node -e "$body" "$broken/pstack-fleet.json" || { bad "$name: the witness could not seed the defect"; return; }
  out="$(ROUTE_GATE_WORKDIR="$scratch" ROUTE_GATE_HOME="$broken" "$gate" 2>&1)"
  rc=$?
  printf '%s\n' "$out" | sed 's/^/    /'
  # Restore before judging, so a later case never inherits this one's defect. The overlay is copied
  # back from the boot that wrote it, not deleted: case (b2) needs a real overlay to hand-edit, and
  # a missing one would turn that case into a fresh-install boot that passes for the wrong reason.
  cp "$scratch/witness-fleet.orig.json" "$broken/pstack-fleet.json"
  cp "$scratch/witness-overlay.orig.json" "$broken/pstack.json"
  if [[ "$rc" -eq 0 ]]; then
    bad "$name: the gate reported ROUTE OK (exit 0) on a fleet that cannot work"
  elif printf '%s\n' "$out" | grep -q "$want"; then
    pass "$name: the gate refused (exit $rc) naming the defect"
  else
    bad "$name: the gate refused (exit $rc) but not for the expected reason ('$want' absent)"
  fi
  say ""
}

say "-- (a) an empty catalog: a build whose routes cannot be enumerated"
# What empties the catalog is the ADAPTERS registering nothing — credentials stopped gating
# enumeration on 2026-10-13, so the old "remove the credential store" seeding can no longer produce
# this state (verified: a home with no store still answers routes=2, problems=[]).
#
# So this case disables the provider rows in the profile patch, which is the loader's own supported
# way to stop an entry (`disabled: true`). No adapter registers, `listProviders()` answers empty, and
# the catalog is empty while everything else — the plugin under test, the fleet file, both routes —
# is exactly the baseline. The gate's only possible objection is the empty route list.
mv "$broken/profiles/rescue/cordis.patch.yml" "$broken/profiles/rescue/cordis.patch.yml.witness"
cat > "$broken/profiles/rescue/cordis.patch.yml" <<'STUB'
# Seeded by check-route-witness.sh case (a): every provider adapter disabled, so no route registers.
- id: llm-deepseek
  disabled: true
- id: llm-deepseek-account
  disabled: true
- id: llm-pi-ai
  disabled: true
STUB
run_fleet_case "(a) an empty catalog (no registered providers)" \
  'const fs=require("node:fs");const p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf8"));for(const v of d.violins)v.tasks=[];fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n")' \
  'catalog.routes'
mv "$broken/profiles/rescue/cordis.patch.yml.witness" "$broken/profiles/rescue/cordis.patch.yml"

say "-- (b) a fleet the live catalog cannot honour: an invented model slug"
# Standing order 4 is "no invented model slugs", and this is what inventing one costs: the write gate
# and the load path both refuse it by name. The catalog's real slugs are never guessed here — the
# witness edits the FIRST selection of the FIRST violin, whatever it is, so no slug is constructed.
run_fleet_case "(b) an invented model slug" \
  'const fs=require("node:fs");const p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf8"));d.violins[0].selections[0].model="witness-invented-slug";fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n")' \
  'witness-invented-slug'

say "-- (b2) a hand-written OVERLAY whose task names a model the catalog does not have"
# The other way in: an overlay but no groups file. `fromOverlay` imports it, the unknown name becomes
# a custom violin, and the view reports it as a problem — the "no fleet groups file existed" origin,
# which is what an install upgrading from a command-line-only `pstack.json` sees.
# Leave the fleet file absent: this case is the overlay-only import path, so the overlay below is
# the only thing in the home for the loader to read. The overlay must be present and must be the one
# this boot wrote; a missing one would silently turn this into a fresh-install case that passes.
if [[ ! -f "$broken/pstack.json" ]]; then
  bad "(b2) the gate's boot left no pstack.json to hand-edit, so this case proves nothing"
fi
rm -f "$broken/pstack-fleet.json"
node -e '
const fs = require("node:fs")
const p = process.argv[1]
const d = JSON.parse(fs.readFileSync(p, "utf8"))
// Edit the FIRST task entry and the FIRST model, whatever they are: no slug is ever constructed by
// this witness, so the case cannot accidentally name a route that happens to exist.
const firstTask = Object.keys(d.tasks)[0]
const firstModel = d.tasks[firstTask][0]
d.models["witness-ghost"] = { provider: d.models[firstModel].provider, model: "witness-ghost-slug" }
d.tasks[firstTask] = ["witness-ghost"]
fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\n")
' "$broken/pstack.json"
out="$(ROUTE_GATE_HOME="$broken" "$gate" 2>&1)"
rc=$?
printf '%s\n' "$out" | sed 's/^/    /'
cp "$scratch/witness-fleet.orig.json" "$broken/pstack-fleet.json"
cp "$scratch/witness-overlay.orig.json" "$broken/pstack.json"
if [[ "$rc" -eq 0 ]]; then
  bad "(b2) the gate reported ROUTE OK on an overlay naming a model that does not exist"
elif printf '%s\n' "$out" | grep -q 'witness-ghost'; then
  pass "(b2) the gate refused (exit $rc) naming the ghost model"
else
  bad "(b2) the gate refused (exit $rc) but not for the expected reason ('witness-ghost' absent)"
fi
say ""

# ------------------------------------------------------------------ (c) a busy port
# A listener this script owns, on a port that is not the gate's default and not 3080.
node -e '
const http = require("node:http")
const port = Number(process.argv[1])
const server = http.createServer((_req, res) => { res.writeHead(200); res.end("witness listener\n") })
server.listen(port, "127.0.0.1", () => { process.stdout.write("LISTENING\n") })
' "$busy_port" > "$scratch/witness-listener.log" 2>&1 &
listener_pid=$!

for _ in $(seq 1 40); do
  grep -q LISTENING "$scratch/witness-listener.log" 2>/dev/null && break
  sleep 0.25
done

if ! kill -0 "$listener_pid" 2>/dev/null; then
  bad "(b) the witness could not start its own listener on port $busy_port; this case proves nothing"
  listener_pid=""
else
  say "-- (c) a port that already answers (ROUTE_GATE_PORT=$busy_port)"
  out="$(ROUTE_GATE_PORT="$busy_port" "$gate" 2>&1)"
  rc=$?
  printf '%s\n' "$out" | sed 's/^/    /'
  if [[ "$rc" -eq 0 ]]; then
    bad "(c) the gate reported ROUTE OK against a port it did not open"
  elif ! printf '%s\n' "$out" | grep -q 'already answers'; then
    bad "(c) the gate refused (exit $rc) but not for the busy-port reason; it refused for something else"
  elif ! kill -0 "$listener_pid" 2>/dev/null; then
    bad "(c) the gate killed a process it did not start — that is the one thing it may never do"
  else
    pass "(c) the gate refused a busy port (exit $rc) and left the listener running"
  fi
fi

# ------------------------------------------------------------------ restore, and check we did
kill -TERM "$listener_pid" 2>/dev/null
for _ in $(seq 1 20); do
  kill -0 "$listener_pid" 2>/dev/null || break
  sleep 0.25
done
if kill -0 "$listener_pid" 2>/dev/null; then kill -KILL "$listener_pid" 2>/dev/null; fi
listener_pid=""

rm -rf "$broken"
rm -f "$scratch/witness-fleet.orig.json" "$scratch/witness-overlay.orig.json" "$scratch/witness-listener.log"
rm -rf "$scratch"

# The tree and the process table must be exactly as they were found.
if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ":$busy_port "; then
  bad "the witness left its own listener on port $busy_port"
fi
if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ":${ROUTE_GATE_PORT:-3121} "; then
  bad "the gate left a Host listening on the gate port"
fi

say ""
if [[ "$failures" -gt 0 ]]; then
  say "WITNESS FAIL: $failures case(s) did not behave"
  exit 1
fi
say "WITNESS PASS: the route gate refuses every seeded defect and left no process behind"
exit 0
