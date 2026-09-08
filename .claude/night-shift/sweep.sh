#!/usr/bin/env bash
# Stop what a unit left running in its own worktree. Selects by working
# directory, never by command name: matching on a name reaches into other lanes
# and kills the app another unit is verifying.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/lib.sh"

root="$(git rev-parse --show-toplevel)"
slug="${1:?slug required}"
dry=""
[ "${2:-}" = "--dry-run" ] && dry=1
path="$root/.claude/worktrees/$slug"
acted=0
# Never signal the group this script is running in. An agent that calls sweep
# from inside the worktree it is sweeping would otherwise stop its own shell,
# which the hook contract forbids and which looks exactly like a crash.
own_pgid="$(pgid_of $$)"

cwds="$(list_cwds)" || { echo "verdict: could not look; nothing swept"; exit 9; }

while IFS=$'\t' read -r pid cwd; do
  [ -z "${pid:-}" ] && continue
  [ "$pid" = "$$" ] && continue
  case "$cwd" in
    "$path"|"$path"/*) ;;
    *) continue ;;
  esac
  pgid="$(pgid_of "$pid")"
  if [ -n "$pgid" ] && [ "$pgid" = "$own_pgid" ]; then
    echo "pid $pid: skipped, it is the caller's own process group"
    continue
  fi
  echo "pid $pid pgid ${pgid:-unknown} cwd $cwd"
  acted=1
  # The pid a launch reports is often a wrapper and a child holds the port, so
  # signalling the group is what actually frees it.
  [ -z "$dry" ] && [ -n "$pgid" ] && kill -TERM "-$pgid" 2>/dev/null
done <<<"$cwds"

[ -n "$dry" ] && { echo "dry run, nothing signalled"; exit 0; }
sleep 1

survivors=0
cwds="$(list_cwds)" || { echo "verdict: swept, but could not confirm"; exit 9; }
while IFS=$'\t' read -r pid cwd; do
  [ -z "${pid:-}" ] && continue
  [ "$pid" = "$$" ] && continue
  [ "$(pgid_of "$pid")" = "$own_pgid" ] && continue
  case "$cwd" in "$path"|"$path"/*) survivors=1 ;; esac
done <<<"$cwds"

if [ "$survivors" = 1 ]; then echo "verdict: something survived"; exit 4; fi
[ "$acted" = 0 ] && echo "verdict: nothing was running"
[ "$acted" = 1 ] && echo "verdict: worktree clear"
exit 0
