#!/usr/bin/env bash
# Stop what a unit left running in its own worktree. Selects by working
# directory and by the unit's own port, never by command name: matching on a
# name reaches into other lanes and kills the app another unit is verifying.
set -uo pipefail

root="$(git rev-parse --show-toplevel)"
slug="${1:?slug required}"
dry=""
[ "${2:-}" = "--dry-run" ] && dry=1
path="$root/.claude/worktrees/$slug"
acted=0

for p in /proc/[0-9]*; do
  pid="${p##*/}"
  cwd="$(readlink "$p/cwd" 2>/dev/null)" || continue
  case "$cwd" in
    "$path"|"$path"/*)
      [ "$pid" = "$$" ] && continue
      pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')" || continue
      echo "pid $pid pgid $pgid cwd $cwd"
      acted=1
      # The pid a launch reports is often a wrapper; the port is held by a
      # child. Signalling the group is what actually frees it.
      [ -z "$dry" ] && kill -TERM "-$pgid" 2>/dev/null
      ;;
  esac
done

[ -n "$dry" ] && { echo "dry run, nothing signalled"; exit 0; }
sleep 1

survivors=0
for p in /proc/[0-9]*; do
  cwd="$(readlink "$p/cwd" 2>/dev/null)" || continue
  case "$cwd" in "$path"|"$path"/*) [ "${p##*/}" = "$$" ] || survivors=1 ;; esac
done

if [ "$survivors" = 1 ]; then echo "verdict: something survived"; exit 4; fi
[ "$acted" = 0 ] && echo "verdict: nothing was running"
[ "$acted" = 1 ] && echo "verdict: worktree clear"
exit 0
