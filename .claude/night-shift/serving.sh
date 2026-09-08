#!/usr/bin/env bash
# Who holds this unit's port, and what to signal to stop it. Changes nothing.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/lib.sh"

root="$(git rev-parse --show-toplevel)"
slug="${1:?slug required}"
path="$root/.claude/worktrees/$slug"
port="$(slug_port "$slug")"

pid="$(port_pid "$port")" || exit 9
if [ -z "$pid" ]; then echo "port $port: no listener"; exit 0; fi

cwd="$(list_cwds 2>/dev/null | awk -F'\t' -v p="$pid" '$1==p{print $2; exit}')"
: "${cwd:=unknown}"
pgid="$(pgid_of "$pid")"
owner=other
case "$cwd" in "$path"|"$path"/*) owner=this-unit ;; esac

echo "port $port: held by pid $pid (pgid ${pgid:-unknown}), cwd $cwd, owner $owner, signal TERM to -${pgid:-?}"
