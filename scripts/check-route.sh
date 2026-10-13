#!/usr/bin/env bash
#
# Gate 7: the plugin's HTTP surface really answers, on a Host this script booted itself.
#
# This gate used to be two lines of prose — boot a throwaway Host, curl the
# fleet route — and a verifier unit found it was the only gate that had never failed on purpose,
# because prose cannot be invoked by a reviewer or by CI. This file is that prose as an executable.
#
# What it asserts, and why each assertion exists:
#
#   * the port is free before the boot, so a failure is the Host's and not a squatter's;
#   * the Host answers within a bounded window (polled, never a fixed sleep);
#   * `GET /api/pstack/fleet` is 200 with `groups.violins` a non-empty array AND `catalog.routes`
#     non-empty. A 200 with an empty fleet is exactly the failure this gate exists for: it is what
#     a throwaway home without a credential seam answers, and it looks healthy to `curl -o /dev/null`;
#   * `GET /api/pstack/overlay` is 200 and a `PUT` to it is 405 — the single-writer rule,
#     single-writer rule. The overlay is a projection of the fleet file, so a second writer would be
#     silently reverted by the next load's reconciliation.
#
# Three things this script deliberately does NOT do:
#
#   * it never touches port 3080 (the human's live Host) and never kills a process it did not start;
#   * it never writes `$HOME/.dsh`, which is read-only from the sandbox;
#   * it never writes inside the repository at all. Working state goes to a temp directory, and the
#     only tracked thing it reads is the profile fixture under `scripts/host-fixture/`.
#
# Isolation: the throwaway home is a COPY of the tracked fixture. Copying (rather than reusing) is
# what makes the failure branch of `check-route-witness.sh` possible at all — a witness can empty the
# copy's fleet file without touching anything a person cares about.
#
# One thing a copy cannot fix: the `rescue` profile links `dsh-pstack` at the MAIN checkout
# (`../../../../../plugin`), not at the worktree this script lives in. The copy is therefore
# re-pointed at THIS tree's `plugin/`, so the gate measures the working tree it is run from. The
# only generated artifact in the copy is `root.json`, which records that absolute path; the rest of
# `node_modules` is not touched.
#
# No credential seam is needed, and requiring one was a false negative waiting to happen. This gate
# used to insist on it, because the plugin's catalog resolved each provider's declared `apiKeyEnv` and
# withheld any route whose ref looked unconfigured. That judgement is gone (see
# `plugin/src/roles/catalog.ts` §"What enumerated means here"): `enumerateRoutes` lists what the
# adapters registered and consults no credential service at all.
#
# Measured 2026-10-13 on the `rescue` profile, which is why the seam code was deleted rather than
# left in as a precaution: a throwaway home with NO `.credentials.yaml` and NO `settings.yaml` boots
# and answers routes=2 (`deepseek-official/deepseek-flash`, `/deepseek-v4-pro`) with problems=[]. The
# seam is therefore not what makes this gate pass, and a gate that demanded it would fail a healthy
# tree for want of a fixture nothing reads.
#
# Cleanup is a trap on every exit path, including failure and Ctrl-C: the Host this script started
# is killed and its port is asserted free before the script returns. A gate that leaks a server on
# the human's machine is worse than no gate.
#
# Runtime is roughly 15-25 seconds — a real Host boot, so it is slower than the other six gates.
#
#   ./scripts/check-route.sh              # port 3121 (override with ROUTE_GATE_PORT)
#
# Two seams exist so that `scripts/check-route-witness.sh` can drive this script's real failure
# paths instead of a paraphrase of them:
#
#   ROUTE_GATE_HOME    use an already-built throwaway home VERBATIM, instead of building one from
#                      the tracked fixture. The witness uses it to boot a home whose fleet file
#                      declares no violins — a 200 with an empty fleet.
#   ROUTE_GATE_PORT    the port to boot on (default 3121). The witness uses it to aim the gate at a
#                      port something else already answers on.
#   ROUTE_GATE_WORKDIR the directory to build the throwaway home in (default: a fresh mktemp -d).
#                      Supply one and the gate will NOT delete it, because it then belongs to you;
#                      the witness does exactly that, since it needs the home to seed defects in.
set -uo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

port="${ROUTE_GATE_PORT:-3121}"

# Working state goes to a TEMP directory, never inside the repo. A gitignored `scratch/` is still
# on disk and still has to be cleaned by a human; a temp dir costs nothing and leaves the checkout
# exactly as it was. The template this gate boots from IS tracked (`scripts/host-fixture/`), because
# a fresh clone has to be able to run it — that is the distinction: committed inputs, temp outputs.
scratch="${ROUTE_GATE_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/pstack-route-XXXXXX")}"
own_scratch=0
[[ -n "${ROUTE_GATE_WORKDIR:-}" ]] || own_scratch=1
given_home="${ROUTE_GATE_HOME:-}"
home="${given_home:-$scratch/home}"
bootlog="$scratch/boot.log"
fleetjson="$scratch/fleet.json"

# The human's live Host. Not a default, a tripwire: if the chosen port ever equals this, refuse.
HUMAN_PORT=3080

startup_timeout="${ROUTE_GATE_TIMEOUT:-120}"
poll_interval=0.5

host_pid=""
failure=""

say() { printf '%s\n' "$*"; }
refuse() { say "ROUTE GATE FAIL: $*"; failure="$1"; exit 1; }

# ---------------------------------------------------------------- cleanup, on every path
cleanup() {
  local rc=$?
  if [[ -n "$host_pid" ]] && kill -0 "$host_pid" 2>/dev/null; then
    # TERM the whole group: `dsh` is the process we started, but it may have children.
    kill -TERM -- "-$host_pid" 2>/dev/null || kill -TERM "$host_pid" 2>/dev/null
    for _ in $(seq 1 20); do
      kill -0 "$host_pid" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$host_pid" 2>/dev/null; then
      say "route gate: the Host on port $port ignored SIGTERM; sending SIGKILL"
      kill -KILL -- "-$host_pid" 2>/dev/null || kill -KILL "$host_pid" 2>/dev/null
      sleep 0.5
    fi
    host_pid=""
  fi
  if [[ -n "$failure" ]]; then
    say ""
    say "ROUTE GATE FAIL: $failure"
  fi
  # Remove the working directory we made, and only that: a caller-supplied ROUTE_GATE_WORKDIR
  # belongs to the caller, and the witness owns its content.
  if [[ "$own_scratch" == "1" && -n "$scratch" && -d "$scratch" ]]; then
    rm -rf "$scratch"
  fi
  return $rc
}
trap 'cleanup; exit 1' INT TERM
trap cleanup EXIT

# ---------------------------------------------------------------- preconditions
if [[ "$port" == "$HUMAN_PORT" ]]; then
  refuse "port $port is the human's live Host; pick another with ROUTE_GATE_PORT"
fi

if ! command -v dsh >/dev/null 2>&1; then
  refuse "dsh is not on PATH, so a Host cannot be booted"
fi

if ! command -v curl >/dev/null 2>&1; then
  refuse "curl is not on PATH"
fi

# A readiness probe that says "something is listening here". `ss` is the cheap one; the curl probe
# below is the authoritative answer, but this one runs before we own the port and never signals it.
port_busy() {
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$port/" 2>/dev/null
  # curl exits 7 (connection refused) when nothing answers; anything else means a listener.
  local rc=$?
  [[ $rc -ne 7 ]]
}

if port_busy; then
  refuse "port $port already answers; refusing to reuse or to kill a process this script did not start"
fi

# The template home: a TRACKED profile definition, so a fresh clone can run this gate. It is four
# small files (`profiles/rescue/`), not a whole booted home — the gate generates everything else,
# including the `node_modules` link to this tree's plugin, which it re-points below.
template="$repo/scripts/host-fixture"
if [[ ! -d "$template/profiles/rescue" ]]; then
  say "FAIL: the throwaway profile fixture is missing at $template/profiles/rescue."
  say "  It is tracked; a checkout without it is broken, not merely un-provisioned."
  exit 1
fi
say "route gate: host fixture: $template/profiles/rescue (tracked)"

# ---------------------------------------------------------------- the throwaway home
# A home handed in through ROUTE_GATE_HOME is used exactly as it is: it belongs to the caller (the
# witness owns its content), and rebuilding it would replace the very defect under test.
if [[ -n "$given_home" ]]; then
  if [[ ! -d "$home/profiles/rescue" ]]; then
    refuse "ROUTE_GATE_HOME=$home has no profiles/rescue, so it is not a bootable throwaway home"
  fi
  say "route gate: using the supplied home $home verbatim (template not consulted)"
  mkdir -p "$scratch"
else
mkdir -p "$scratch"
if ! cp -a "$template" "$home" 2>"$scratch/copy.err"; then
  say "FAIL: could not copy the host fixture:"
  sed 's/^/    /' "$scratch/copy.err"
  exit 1
fi

# Drop the template's own fleet and overlay. They are leftovers from whatever ran in that home
# before, and the groups file WINS over the defaults on load: a stale placement would make this gate
# report a defect in the build that is really a defect in the working directory. Booting with
# neither file present is the documented "setup" path and rebuilds
# both from `defaultGroups` — which is exactly the fresh-install state this gate is about.
rm -f "$home/pstack-fleet.json" "$home/pstack.json"
say "route gate: dropped the template's own pstack-fleet.json/pstack.json; this boot rebuilds them"

# Reset the template's profile patch layer too, for the same reason — and this one is not cosmetic.
# A stale patch is how this gate failed while the plugin was correct: the scratch template carried
#
#   - id: llm-deepseek
#     name: "@deepseek-ai/dsh-llm-deepseek-api-key"
#     config: { apiKeyEnv: "" }
#
# and that adapter's schema is `apiKeyEnv: z.string().role("credential-ref")
# .default("DEEPSEEK_API_KEY")` (`dsh-llm-deepseek-api-key/lib/index.js:9`). An empty string meant
# "owes no key", so the catalog of the day withheld `deepseek-official`, and the gate reported
# EMPTY_ROUTES — a fixture defect wearing a plugin defect's clothes, which is the failure mode this
# gate exists to catch in the other direction.
#
# The catalog no longer reads `apiKeyEnv` at all, so that particular patch can no longer empty the
# catalog. The reset STAYS regardless: a profile patch from an earlier session shadowing this tree's
# plugin is the general problem, and it is not specific to this one key.
patch_file="$home/profiles/rescue/cordis.patch.yml"
if [[ -f "$patch_file" ]] && ! grep -qE '^[[:space:]]*\[\][[:space:]]*$' "$patch_file"; then
  cp "$patch_file" "$scratch/rescue.cordis.patch.yml.replaced" 2>/dev/null || true
  printf '# Reset by check-route.sh: a profile patch from an earlier session would otherwise decide\n# this gate. The original is kept at scratch/rescue.cordis.patch.yml.replaced.\n[]\n' > "$patch_file"
  say "route gate: reset a stale profile patch at profiles/rescue/cordis.patch.yml (kept a copy)"
fi

# Re-point the rescue profile at THIS tree's plugin, so the gate measures the working tree.
#
# The fixture ships no `node_modules/`, and deliberately so: a directory of symlinks is generated
# state, and a checked-in one would either carry an absolute path (the leak this gate used to have)
# or rot. `mkdir -p` then one link is the whole of what it stood for.
mkdir -p "$home/profiles/rescue/node_modules"
plugin_link="$home/profiles/rescue/node_modules/dsh-pstack"
if [[ -e "$plugin_link" || -L "$plugin_link" ]]; then
  rm -f "$plugin_link"
fi
ln -s "$repo/plugin" "$plugin_link" || { say "FAIL: could not link $plugin_link -> $repo/plugin"; exit 1; }
say "route gate: plugin under test: $repo/plugin"

# ---------------------------------------------------------------- nothing else to seed
#
# This gate used to seed a credential store before booting, because the plugin's catalog resolved
# each provider's declared `apiKeyEnv` and OMITTED any route whose ref looked unconfigured. That
# gate is gone (see `plugin/src/roles/catalog.ts` §"What enumerated means here"): routes are now
# whatever the adapters registered, with no credential consulted at all.
#
# Verified before removing it: a throwaway home with no `.credentials.yaml` and no `settings.yaml`
# boots and answers `routes=2` with `problems=[]`. So requiring a credential store here would not be
# a harmless precaution — it would FAIL a healthy tree for want of a fixture nothing reads.
fi # end: built-from-template home

# ---------------------------------------------------------------- boot, as a managed child
say "route gate: booting a throwaway Host on port $port (DSH_HOME=$home)"
: > "$bootlog"
# setsid gives the Host its own process group, so the trap can kill the whole group by name and no
# orphan survives the shell. It is NOT `( … & )`: the pid is captured and explicitly killed.
setsid env DSH_HOME="$home" dsh --profile rescue --port "$port" --no-open >>"$bootlog" 2>&1 &
host_pid=$!

deadline=$(( $(date +%s) + startup_timeout ))
ready=""
while [[ $(date +%s) -lt $deadline ]]; do
  if ! kill -0 "$host_pid" 2>/dev/null; then
    say "route gate: the Host exited before it answered. Its output:"
    sed 's/^/    /' "$bootlog"
    refuse "the Host died during boot (exit before any HTTP answer on port $port)"
  fi
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$port/api/pstack/overlay" 2>/dev/null)"
  if [[ "$code" == "200" ]]; then ready="yes"; break; fi
  sleep "$poll_interval"
done

if [[ -z "$ready" ]]; then
  say "route gate: no 200 from port $port within ${startup_timeout}s. The Host's output:"
  sed 's/^/    /' "$bootlog"
  refuse "the Host never answered on port $port within ${startup_timeout}s"
fi
say "route gate: the Host is answering (GET /api/pstack/overlay -> 200)"

# ---------------------------------------------------------------- the fleet route
code="$(curl -s -o "$fleetjson" -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/api/pstack/fleet")"
if [[ "$code" != "200" ]]; then
  say "  body: $(head -c 300 "$fleetjson")"
  refuse "GET /api/pstack/fleet answered $code, not 200"
fi

verdict="$(node -e '
const { readFileSync } = require("node:fs")
let d
try { d = JSON.parse(readFileSync(process.argv[1], "utf8")) }
catch (e) { console.log("UNPARSEABLE: " + e.message); process.exit(0) }
const violins = d?.groups?.violins
const routes = d?.catalog?.routes
const problems = d?.problems
const unassigned = d?.unassigned
if (!Array.isArray(violins)) console.log("NO_VIOLINS: groups.violins is not an array")
else if (violins.length === 0) console.log("EMPTY_VIOLINS: groups.violins is an empty array")
else if (!Array.isArray(routes)) console.log("NO_ROUTES: catalog.routes is not an array")
else if (routes.length === 0) console.log("EMPTY_ROUTES: catalog.routes is an empty array")
// The view carries its own verdict rather than only a status code, which is the point: a build whose
// A build whose catalog cannot honour the fleet answers 200 and non-empty, and is still broken —
// the page renders a sentence naming the missing field and the spawn path has nothing to route to.
else if (!Array.isArray(problems)) console.log("NO_PROBLEMS: problems is not an array")
else if (problems.length > 0) console.log("PROBLEMS: the host reports " + problems.length + " problem(s) with the fleet — " + String(problems[0]).slice(0, 160))
// `unassigned` is every task key that resolves only through the `general` fallback. Ten unassigned
// rows is the reported symptom of a build whose default fleet did not place every task.
else if (!Array.isArray(unassigned)) console.log("NO_UNASSIGNED: unassigned is not an array")
else if (unassigned.length > 0) console.log("UNASSIGNED: " + unassigned.length + " task key(s) resolve only through the general fallback — " + unassigned.slice(0, 8).join(" / "))
else console.log("OK violins=" + violins.length + " routes=" + routes.length + " unassigned=0 problems=0")
' "$fleetjson" 2>&1)"

case "$verdict" in
  OK*)
    say "route gate: fleet payload: $verdict"
    ;;
  *)
    say "  payload head: $(head -c 300 "$fleetjson")"
    say "  NOTE: EMPTY_ROUTES is the documented shape of a home with no credential seam"
    say "  EMPTY_ROUTES and PROBLEMS/UNASSIGNED are both real refusals; the shape the page"
    say "  shows as a sentence instead of the violins. Both are 200s, which is why this gate reads"
    say "  the payload and not the status code."
    refuse "GET /api/pstack/fleet returned 200 but the payload is not a usable fleet — $verdict"
    ;;
esac

# ---------------------------------------------------------------- the overlay, and its single writer
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/api/pstack/overlay")"
if [[ "$code" != "200" ]]; then
  refuse "GET /api/pstack/overlay answered $code, not 200"
fi
say "route gate: GET /api/pstack/overlay -> 200"

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X PUT \
  -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$port/api/pstack/overlay")"
if [[ "$code" != "405" ]]; then
  refuse "PUT /api/pstack/overlay answered $code, not 405 — the single-writer rule is not enforced"
fi
say "route gate: PUT /api/pstack/overlay -> 405 (single writer; the fleet route owns every write)"

# ---------------------------------------------------------------- stop the Host here, then verify
# The trap would do this anyway; doing it here means a leaked process is a FAILURE, not a silent
# side effect discovered later by the human's `pgrep`.
kill -TERM -- "-$host_pid" 2>/dev/null || kill -TERM "$host_pid" 2>/dev/null
for _ in $(seq 1 40); do
  kill -0 "$host_pid" 2>/dev/null || break
  sleep 0.25
done
if kill -0 "$host_pid" 2>/dev/null; then
  kill -KILL -- "-$host_pid" 2>/dev/null || kill -KILL "$host_pid" 2>/dev/null
  sleep 0.5
fi
host_pid=""

if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ":$port "; then
  refuse "the Host was killed but port $port is still listening — something survived"
fi
say "route gate: the Host is stopped and port $port is free"

say ""
say "ROUTE OK: /api/pstack/fleet 200 with a non-empty fleet, a live catalog and no problems; /api/pstack/overlay 200, PUT 405"
exit 0
