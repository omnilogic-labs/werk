#!/usr/bin/env bash
# Who holds this unit's port, and what to signal to stop it. Changes nothing.
set -uo pipefail

root="$(git rev-parse --show-toplevel)"
slug="${1:?slug required}"
path="$root/.claude/worktrees/$slug"
port=$(( 4300 + $(printf '%s' "$slug" | cksum | cut -d' ' -f1) % 200 ))

line="$(ss -lntp 2>/dev/null | grep -w ":$port" || true)"
if [ -z "$line" ]; then echo "port $port: no listener"; exit 0; fi

pid="$(printf '%s' "$line" | grep -oP 'pid=\K[0-9]+' | head -1)"
cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || echo unknown)"
pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
owner=other
case "$cwd" in "$path"|"$path"/*) owner=this-unit ;; esac

echo "port $port: held by pid $pid (pgid $pgid), cwd $cwd, owner $owner, signal TERM to -$pgid"
