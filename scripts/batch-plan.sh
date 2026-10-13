#!/usr/bin/env bash
# Phase 3 fan-out plan: partition the pinned skill set into per-writer batches.
#
# The partition is by *path*, so no two writers ever share a directory and no worktree is
# needed. Batch boundaries follow the natural seams -- the playbook bundle stays with its
# parent skill, the principles split across writers -- rather than an arbitrary count.
#
# Usage: scripts/batch-plan.sh        # prints the batches and a per-batch count
#        scripts/batch-plan.sh --tsv  # id<TAB>skill-dir, for a brief-generating loop
#
# This script plans; it never writes into plugin/. Porting is a worker's job.
set -uo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
up="$repo_root/.upstream/cursor-plugins/pstack/skills"

[ -d "$up" ] || { echo "setup: run scripts/fetch-upstream.sh first" >&2; exit 2; }

# The one deliberate exclusion. Cursor-only; dropping it is recorded, not silent.
EXCLUDE='make-bot-ui'

all=$(find "$up" -maxdepth 1 -mindepth 1 -type d -printf '%f\n' | sort)
principles=$(printf '%s\n' "$all" | grep '^principle-' || true)
others=$(printf '%s\n' "$all" | grep -v '^principle-' | grep -v "^${EXCLUDE}$" || true)

# Split the principles across two writers, alphabetically so the split is reproducible.
p_count=$(printf '%s\n' "$principles" | grep -c . || true)
p_half=$(( (p_count + 1) / 2 ))

p_a=$(printf '%s\n' "$principles" | head -n "$p_half")
p_b=$(printf '%s\n' "$principles" | tail -n +"$((p_half + 1))")

# The other skills: the playbook bundle and its parent must travel together, because the
# playbooks reference ../ and each other, and a half-ported bundle is unverifiable.
# poteto-mode is the heavy one (23 playbooks + 14 references + scripts), so it anchors a
# batch of its own.
heavy=$(printf '%s\n' "$others" | grep -E '^(poteto-mode)$' || true)
light=$(printf '%s\n' "$others" | grep -vE '^(poteto-mode)$' || true)

l_count=$(printf '%s\n' "$light" | grep -c . || true)
l_third=$(( (l_count + 2) / 3 ))
l_a=$(printf '%s\n' "$light" | head -n "$l_third")
l_b=$(printf '%s\n' "$light" | tail -n +"$((l_third + 1))" | head -n "$l_third")
l_c=$(printf '%s\n' "$light" | tail -n +"$((2 * l_third + 1))")

emit() { # id, list
  local id=$1 list=$2
  printf '%s\n' "$list" | grep . | sed "s|^|${id}\t|"
}

if [ "${1:-}" = "--tsv" ]; then
  emit p3-a-principles-1 "$p_a"
  emit p3-b-principles-2 "$p_b"
  emit p3-c-poteto-mode  "$heavy"
  emit p3-d-workflows-1  "$l_a"
  emit p3-e-workflows-2  "$l_b"
  emit p3-f-workflows-3  "$l_c"
  exit 0
fi

for pair in "p3-a-principles-1:$p_a" "p3-b-principles-2:$p_b" "p3-c-poteto-mode:$heavy" \
            "p3-d-workflows-1:$l_a" "p3-e-workflows-2:$l_b" "p3-f-workflows-3:$l_c"; do
  id=${pair%%:*}; list=${pair#*:}
  n=$(printf '%s\n' "$list" | grep -c . || true)
  # Sum file bytes with find, not a paste/pipe chain: the pipe version died on SIGPIPE and
  # printed '?' for every batch, which is exactly the kind of silent hole a plan should not have.
  bytes=0
  while IFS= read -r s; do
    [ -n "$s" ] || continue
    b=$(find "$up/$s" -type f -printf '%s\n' 2>/dev/null | awk '{t+=$1} END{print t+0}')
    bytes=$((bytes + b))
  done <<< "$list"
  printf '%-20s %2d dirs  %8d bytes\n' "$id" "$n" "$bytes"
  printf '%s\n' "$list" | grep . | sed 's/^/    /'
done

echo
echo "excluded: ${EXCLUDE} (Cursor-only, documented)"
echo "total to port: $(( p_count + $(printf '%s\n' "$others" | grep -c . || true) ))"
