#!/usr/bin/env bash
# Structural check for decision 0000: home is a sanctuary.
# Encode Lessons in Structure: a rule that lives only in an agent's judgement is not a rule.
#
# Usage: scripts/home-check.sh [--baseline FILE] [--write-baseline FILE]
# Exit: 0 = no new top-level entries, 1 = new entries found, 2 = usage error.
set -uo pipefail

KNOWN_DEFAULT=(
  .agents Apps .bash_history .bash_logout .bash_profile .bash_profile.bak .bashrc
  .bundle .cache .claude .codex .config Documents Downloads .dsh .gemini .hermes
  .java .junie kc-audit-report.md knowledge .local logs Music .npm .nv .okf
  okf-skill-audit.md .pi Pictures .profile Projects src .ssh Videos Work .XCompose
  # permitted top-level entries, each with a reason under decision 0000:
  tmp            # user's general-purpose temp (amendment 2026-09-16)
)

baseline_file=""
write_to=""
while (($#)); do
  case "$1" in
    --baseline) baseline_file="${2:-}"; shift 2 ;;
    --write-baseline) write_to="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

list_current() { ls -A "$HOME" 2>/dev/null | sort; }

if [[ -n $write_to ]]; then
  list_current > "$write_to"
  echo "baseline written: $write_to ($(wc -l < "$write_to") entries)"
  exit 0
fi

if [[ -n $baseline_file ]]; then
  [[ -r $baseline_file ]] || { echo "unreadable baseline: $baseline_file" >&2; exit 2; }
  expected=$(sort "$baseline_file")
else
  expected=$(printf '%s\n' "${KNOWN_DEFAULT[@]}" | sort)
fi

new=$(comm -13 <(echo "$expected") <(list_current))

if [[ -z $new ]]; then
  echo "clean: no new top-level entries in \$HOME"
  exit 0
fi

echo "NEW top-level entries in \$HOME:"
echo "$new" | sed 's/^/  /'
echo
echo "Each needs a reason under decision 0000: user-requested, project management,"
echo "or a tool's documented path the tool itself created."
echo "Scratch work belongs in ~/.dsh/tmp/<purpose>-<date>/, never at \$HOME top level."
exit 1
