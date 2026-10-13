#!/usr/bin/env bash
# Phase 3 gate, scripted. "Encode Lessons in Structure": the counts are read from the tree
# both times, never from a README, so a renamed or dropped skill fails this loudly instead
# of being absorbed into a hand-written claim.
#
#   upstream side: the pinned checkout from scripts/fetch-upstream.sh
#   ours side:     plugin/skills/
#
# Usage: scripts/check-parity.sh
# Exit 0 = parity, 1 = a real difference (printed), 2 = setup problem.
set -uo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
up="$repo_root/.upstream/cursor-plugins/pstack"
ours="$repo_root/plugin/skills"
fail=0

[ -d "$up/skills" ] || { echo "setup: run scripts/fetch-upstream.sh first ($up/skills missing)" >&2; exit 2; }

count_dirs() { find "$1" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l; }
# README.md is a directory index, not content: counting it made the guide read 11 for a
# 10-chapter guide and our own agents/ read 1 before anything was ported.
count_md()   { find "$1" -maxdepth 1 -name '*.md' ! -name 'README.md' 2>/dev/null | wc -l; }

up_skills=$(count_dirs "$up/skills")
up_principles=$(find "$up/skills" -maxdepth 1 -mindepth 1 -type d -name 'principle-*' | wc -l)
up_playbooks=$(count_md "$up/skills/poteto-mode/playbooks")
up_agents=$(count_md "$up/agents")
up_guide=$(count_md "$up/docs/guide")

echo "=== upstream (pinned tree) ==="
printf '  skills      %3d\n  principles  %3d\n  playbooks   %3d\n  agents      %3d\n  guide ch.   %3d\n' \
  "$up_skills" "$up_principles" "$up_playbooks" "$up_agents" "$up_guide"

echo "=== ours (plugin/skills, plugin/agents) ==="
if [ ! -d "$ours" ] || [ "$(count_dirs "$ours")" = 0 ]; then
  echo "  plugin/skills/ holds no skill dirs yet — Phase 3 has not run. This is not a failure."
  echo "  The upstream counts above are the Phase 3 target."
  exit 0
fi

our_skills=$(count_dirs "$ours")
our_principles=$(find "$ours" -maxdepth 1 -mindepth 1 -type d -name 'principle-*' | wc -l)
our_playbooks=$(count_md "$ours/poteto-mode/playbooks")
our_agents=$(count_md "$repo_root/plugin/agents")
printf '  skills      %3d\n  principles  %3d\n  playbooks   %3d\n  agents      %3d\n' \
  "$our_skills" "$our_principles" "$our_playbooks" "$our_agents"

# Both sides of the skills comparison are named, because a bare count cannot tell a faithful
# port from an arithmetic coincidence. `make-bot-ui` is the documented upstream exclusion
# (Cursor-only). `pstack-self-check` is ours: the Phase 2 hand-written skill that proves the
# plugin is live, which lives in the same directory and must not be counted as upstream text.
upstream_excluded='make-bot-ui'
ours_only='pstack-self-check'
expected_skills=$((up_skills - 1))

if [ -d "$ours/$ours_only" ]; then
  expected_skills=$((expected_skills + 1))
else
  printf '  note  %s is absent — the plugin has no self-check skill, which Phase 2 requires\n' "$ours_only"
fi
[ -d "$ours/$upstream_excluded" ] && { printf '  FAIL  %s must NOT be ported (Cursor-only)\n' "$upstream_excluded"; fail=1; }

echo "=== parity ==="
echo "  expected = ${up_skills} upstream − ${upstream_excluded} + ${ours_only} = ${expected_skills}"
check() { # label expected actual
  if [ "$2" = "$3" ]; then printf '  ok    %-12s %s\n' "$1" "$3"
  else printf '  FAIL  %-12s expected %s, got %s\n' "$1" "$2" "$3"; fail=1; fi
}
check skills     "$expected_skills" "$our_skills"
check principles "$up_principles"   "$our_principles"
check playbooks  "$up_playbooks"    "$our_playbooks"
check agents     "$up_agents"       "$our_agents"

# The two the sibling port dropped must exist here. Named, because their absence is exactly
# the defect that made shiwenbin1617/pstack look complete while missing two principles.
for must in principle-attack-the-premise principle-test-behavior-not-implementation; do
  if [ -d "$ours/$must" ]; then printf '  ok    %-12s present\n' "$must"
  else printf '  FAIL  %-12s MISSING (the sibling port dropped this)\n' "$must"; fail=1; fi
done

# The guide is a deliberate omission, so its absence is asserted rather than merely uncounted.
# The upstream count was printed above and nothing checked our side against it, which made
# "we do not ship the guide" a claim no command could fail on. Found by the Phase 6 docs unit.
ship_guide=0
[ -d "$repo_root/plugin/guide" ] && ship_guide=$((ship_guide + 1))
[ -d "$repo_root/plugin/skills/poteto-mode/docs" ] && ship_guide=$((ship_guide + 1))
if [ "$ship_guide" = 0 ]; then
  printf '  ok    %-12s not shipped (deliberate)\n' guide
else
  printf '  FAIL  %-12s the upstream guide is shipped; omitting it is deliberate\n' guide
  fail=1
fi

if [ "$fail" = 0 ]; then echo "PARITY OK"; else echo "PARITY FAILED"; fi
exit "$fail"
