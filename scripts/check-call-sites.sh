#!/usr/bin/env bash
# Phase 3 gate, scripted: no Cursor or Grok leftovers survive the port.
#
# The port's rule is "at call sites only". A mechanical diff proves what changed; this
# proves nothing that should have changed was missed. Two halves:
#
#   --baseline   run against the pinned upstream tree to show what the rules catch there.
#                Upstream is *supposed* to fail this: it is Cursor's plugin.
#   (default)    run against plugin/skills and plugin/agents, which must be clean.
#
# Usage: scripts/check-call-sites.sh [--baseline]
# Exit 0 = clean (or baseline mode), 1 = leftovers found, 2 = setup problem.
set -uo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
up="$repo_root/.upstream/cursor-plugins/pstack"

mode=ours
[ "${1:-}" = "--baseline" ] && mode=baseline

if [ "$mode" = baseline ]; then
  [ -d "$up/skills" ] || { echo "setup: run scripts/fetch-upstream.sh first" >&2; exit 2; }
  roots=("$up/skills" "$up/agents")
  echo "=== baseline: the pinned upstream tree (expected to be dirty) ==="
else
  roots=("$repo_root/plugin/skills" "$repo_root/plugin/agents")
  echo "=== ours: plugin/skills + plugin/agents (must be clean) ==="
fi

present=()
for r in "${roots[@]}"; do [ -d "$r" ] && present+=("$r"); done
if [ "${#present[@]}" -eq 0 ]; then
  echo "  no skill or agent dirs yet — Phase 3 has not run. Not a failure."
  exit 0
fi

fail=0

# Pattern | why it is a leftover | what ours should say instead.
# Kept in one table so the rule and its replacement cannot drift apart.
rules=(
  'Task tool|the Cursor delegation tool|the `subagent` tool (or pstack'"'"'s own spawn tool)'
  'AskQuestion|Cursor'"'"'s question tool|`ask_user_question`'
  'TodoWrite|Cursor'"'"'s todo tool|`todo_write`'
  'subagent_type|not a DSH field|`role` on our spawn tool, or `subagent_type` dropped'
  'cursor-team-kit|a Cursor-only plugin|our bundled equivalent'
  '\.cursor/rules|Cursor'"'"'s rule files|`$DSH_HOME/pstack.json`'
  # The dot is escaped. Unescaped, this matched `~/xcursor` too — found by the Phase 5
  # same-route panel experiment, which is the only reason it is fixed: a rule that flags the
  # wrong line teaches the reader to skim the output.
  '~/\.cursor|Cursor home|`$DSH_HOME`'
  'make-bot-ui|the deliberate Cursor-only exclusion|nothing — it must not be ported'
  '\.cursor/skills|Cursor'"'"'s project skill root|`.dsh/skills` (rank 100) or `$DSH_HOME/skills`'
  'create-skill|Cursor'"'"'s built-in skill authoring tool, which DSH does not ship|state plainly that the skill is authored directly'
  # Slug prefixes. Only three vendors appear in this pin, so an unlisted vendor's slug passes
  # silently. That is a known limit, stated rather than hidden: before Phase 3 the rules are
  # checked against the pin, which is what `--baseline` is for.
  'grok-|an upstream model slug that does not exist here|a route read from the live catalog'
  'claude-|an upstream model slug that does not exist here|a route read from the live catalog'
  'gpt-[0-9]|an upstream model slug that does not exist here|a route read from the live catalog'
)

# Slug rules are the one class with a deliberate exception, and the exception is structural
# rather than textual: a Cursor slug inside a fenced code block is a *documented example* —
# `setup-pstack` keeps exactly that table so a Cursor user can see how their slugs map, and
# deleting it removes the only such map. A slug in prose is a real leftover. So slug rules
# ignore content inside fences; every other rule still scans the whole file, fences included.
# Which rules ignore fenced code. Kept in one place with the table above, because changing a
# pattern here without changing this matcher silently disables fence handling for it — which is
# exactly how `gpt-[0-9]` first shipped, flagging six lines the old `gpt-5` rule had correctly
# skipped. A slug in a fenced example is documentation; a slug in prose is a leftover.
is_slug_rule() { case "$1" in grok-|claude-|gpt-5|gpt-\[0-9\]) return 0 ;; *) return 1 ;; esac; }

# Print hitting lines that are NOT inside a fenced code block.
unfenced_hits() {
  local pattern=$1; shift
  awk -v pat="$pattern" '
    FNR == 1 { fence = 0 }
    /^[[:space:]]*(```|~~~)/ { fence = !fence; next }
    !fence && $0 ~ pat { printf "%s:%d:%s\n", FILENAME, FNR, $0 }
  ' "$@" 2>/dev/null
}

# One transparent false positive, exempted by its exact prose rather than by weakening a rule.
# `reflect/references/synthesizer.md:28` illustrates a *bad edit*: it quotes an SDK rename of a
# function name, which is not a model route. That file is byte-identical to the pin, so there is
# nothing to translate. Exempting the phrase keeps `gpt-4o` flagged everywhere it would mean an
# invented route, which a whole-file exemption would lose.
slug_exempt() {
  grep -vF 'we renamed `gpt-4` to `gpt-4o` in `encodingForModel`'
}

# The lint scans *ported content* only. A README that documents the Cursor-to-DSH mapping
# necessarily names Cursor's tools, so scanning it makes the lint cry wolf and trains the
# reader to ignore it. These are the files that carry methodology text a model loads.
mapfile -t content < <(
  for r in "${present[@]}"; do
    find "$r" -type f -name '*.md' ! -name 'README.md' 2>/dev/null
  done | sort -u
)
if [ "${#content[@]}" -eq 0 ]; then
  echo "  no ported content files yet (only READMEs) — Phase 3 has not run. Not a failure."
  exit 0
fi
echo "  scanning ${#content[@]} content file(s); READMEs excluded as documentation"

for entry in "${rules[@]}"; do
  pattern=${entry%%|*}
  rest=${entry#*|}
  why=${rest%%|*}
  instead=${rest##*|}

  if is_slug_rule "$pattern"; then
    # Skip fenced examples and the one documented false positive; report a slug that survives
    # outside a fence, because that is where an invented route lives.
    hits=$(unfenced_hits "$pattern" "${content[@]}" | slug_exempt | wc -l)
    if [ "$hits" -eq 0 ]; then
      printf '  ok    %-22s no hits outside a code fence\n' "$pattern"
      continue
    fi
    printf '  HIT   %-22s %s hit(s) in prose — %s; ours should use %s\n' "$pattern" "$hits" "$why" "$instead"
    unfenced_hits "$pattern" "${content[@]}" | slug_exempt | head -5 | sed 's/^/          /'
    fail=1
    continue
  fi

  hits=$(grep -InE "$pattern" "${content[@]}" 2>/dev/null | wc -l)
  if [ "$hits" -eq 0 ]; then
    printf '  ok    %-22s no hits\n' "$pattern"
    continue
  fi

  printf '  HIT   %-22s %s hit(s) — %s; ours should use %s\n' "$pattern" "$hits" "$why" "$instead"
  grep -InE "$pattern" "${content[@]}" 2>/dev/null | head -5 | sed 's/^/          /'
  fail=1
done

echo
if [ "$mode" = baseline ]; then
  # A real contract instead of a label. Upstream is *supposed* to be dirty, so exiting non-zero
  # on hits would make this mode useless — but exiting 0 unconditionally makes it a check that
  # cannot fail, which is worse: it would stay green if the rules stopped matching anything at
  # all. So dirty is the expected success and **clean is the failure**, because it means the
  # rules no longer catch the thing they were written to catch. Phase 5's same-route experiment
  # found this by pointing a panel at the script; it is a better contract than the one I wrote.
  if [ "$fail" = 0 ]; then
    echo "baseline CLEAN — the rules caught nothing upstream, so they are probably broken"
    echo "  (upstream is Cursor's own plugin and must trip these rules)"
    exit 1
  fi
  echo "baseline OK — the rules catch upstream as intended"
  exit 0
fi
if [ "$fail" = 0 ]; then echo "CALL SITES CLEAN"; else echo "CALL SITES DIRTY"; fi
exit "$fail"
