#!/usr/bin/env bash
# Worktree lifecycle for the night-shift pipeline. One subcommand per hook.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/lib.sh"

root="$(git rev-parse --show-toplevel)"
base="$(sed -n 's/^base_branch: *//p' "$root/.claude/night-shift.md" | head -1)"
base="${base:-main}"

slug_path() { printf '%s/.claude/worktrees/%s' "$root" "$1"; }

case "${1:-}" in
new)
  slug="${2:?slug required}"
  path="$(slug_path "$slug")"
  branch="$slug"
  if [ -e "$path" ]; then echo "worktree already exists: $path" >&2; exit 1; fi
  git -C "$root" worktree add -b "$branch" "$path" "$base" >&2
  (cd "$path" && bun install >&2)
  echo "WORKTREE=$path"
  echo "BRANCH=$branch"
  echo "BASE=$base"
  echo "PORT=$(slug_port "$slug")"
  # Nothing is implemented in a fresh worktree, so a server started now would be
  # stale before anyone wanted it. The unit starts its own with the start hook.
  echo "SERVER=not-started"
  # A unix socket path has a 103 byte limit and a worktree path blows it. Every
  # daemon a unit starts belongs under here instead, and teardown removes it.
  echo "RUNTIME_DIR=/tmp/w-$slug/rt"
  echo "STATE_DIR=/tmp/w-$slug/st"
  ;;

remove)
  slug="${2:?slug required}"
  path="$(slug_path "$slug")"
  # Refusing because something is still running is correct. sweep is the remedy.
  git -C "$root" worktree remove "$path" >&2
  git -C "$root" branch -D "$slug" >&2 || true
  rm -rf "/tmp/w-$slug"
  ;;

integrate)
  slug="${2:?slug required}"
  message="${3:?commit message required}"
  cd "$root"
  git checkout "$base" >&2
  if ! git merge --squash "$slug" >&2; then
    echo "conflict integrating $slug onto $base" >&2
    git diff --name-only --diff-filter=U >&2
    git merge --abort >&2 || true
    exit 3
  fi
  git commit -q -m "$message"
  git rev-parse --short HEAD
  ;;

*)
  echo "usage: wt.sh {new|remove|integrate} <slug> [message]" >&2
  exit 2
  ;;
esac
