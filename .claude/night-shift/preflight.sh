#!/usr/bin/env bash
# Every precondition a run needs. One line per problem, non-zero if any.
set -uo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
problems=0
say() { echo "$1"; problems=1; }

command -v bun >/dev/null || say "bun is not on PATH"
command -v gh  >/dev/null || say "gh is not on PATH"
gh auth status >/dev/null 2>&1 || say "gh is not authenticated"
[ -n "$(git status --porcelain)" ] && say "the primary checkout has uncommitted changes"
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || say "the primary checkout is not on main"
[ -n "$(git worktree list | tail -n +2)" ] && echo "note: worktrees already exist, which is fine mid-run"
bun install --frozen-lockfile >/dev/null 2>&1 || say "bun install --frozen-lockfile fails; the lockfile is out of step"

[ "$problems" = 0 ] && echo "preflight clean"
exit "$problems"
