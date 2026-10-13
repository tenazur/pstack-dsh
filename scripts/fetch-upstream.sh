#!/usr/bin/env bash
# Reconstitute the pinned upstream checkout that Phase 3 diffs against.
#
# The checkout itself is gitignored: a clone tracks `main` and drifts, and a diff gate
# against a moving target verifies nothing. This script is the durable artifact — the pin
# lives here and in the README's pin table; either can rebuild the other.
#
# Usage: scripts/fetch-upstream.sh [dest]
#   dest defaults to <repo>/.upstream/cursor-plugins
#
# Idempotent: re-running re-fetches the same commit and reports whether the checkout was
# already at the pin. Safe to run repeatedly; deletes nothing outside its own dest.
set -euo pipefail

PIN=5bf2b1544db739998121a306340631963c2ff3de
REPO=https://github.com/cursor/plugins.git

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
dest=${1:-"$repo_root/.upstream/cursor-plugins"}

if [ -d "$dest/.git" ]; then
  have=$(git -C "$dest" rev-parse HEAD)
  if [ "$have" = "$PIN" ]; then
    echo "already at pin $PIN"
    exit 0
  fi
  echo "checkout at $have, re-fetching pin"
else
  mkdir -p "$dest"
  git init -q "$dest"
  git -C "$dest" remote add origin "$REPO" 2>/dev/null || \
    git -C "$dest" remote set-url origin "$REPO"
fi

# eol=lf is load-bearing: Phase 3's gate is a byte diff, and a CRLF checkout fails it
# spuriously. The repo's .gitattributes already pins LF; this covers clones made without it.
git -C "$dest" config core.autocrlf false
git -C "$dest" fetch --depth 1 origin "$PIN"
git -C "$dest" checkout -q FETCH_HEAD

now=$(git -C "$dest" rev-parse HEAD)
[ "$now" = "$PIN" ] || { echo "FATAL: expected $PIN, got $now" >&2; exit 1; }

echo "pinned upstream ready: $dest"
echo "  commit:      $now"
echo "  pstack files: $(git -C "$dest" ls-files pstack | wc -l)"
echo "  skill dirs:   $(find "$dest/pstack/skills" -maxdepth 1 -mindepth 1 -type d | wc -l)"
echo "  principles:   $(find "$dest/pstack/skills" -maxdepth 1 -mindepth 1 -type d -name 'principle-*' | wc -l)"
echo "  playbooks:    $(find "$dest/pstack/skills/poteto-mode/playbooks" -maxdepth 1 -name '*.md' | wc -l)"
