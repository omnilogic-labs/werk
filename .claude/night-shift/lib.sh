#!/usr/bin/env bash
# Host differences, in one place. Linux and macOS answer these questions with
# different tools, and a hook that silently cannot answer is worse than one that
# refuses, so every helper here fails loudly rather than returning nothing.

# Prints "pid<TAB>cwd" for every process the caller can see. Exit 9 if the host
# offers no way to ask.
list_cwds() {
  if [ -d /proc ]; then
    local p pid cwd
    for p in /proc/[0-9]*; do
      pid="${p##*/}"
      cwd="$(readlink "$p/cwd" 2>/dev/null)" || continue
      printf '%s\t%s\n' "$pid" "$cwd"
    done
  elif command -v lsof >/dev/null 2>&1; then
    lsof -a -d cwd -Fpn 2>/dev/null |
      awk '/^p/{pid=substr($0,2)} /^n/{print pid "\t" substr($0,2)}'
  else
    echo "cannot enumerate process working directories: no /proc and no lsof" >&2
    return 9
  fi
}

# Prints the pid listening on a port, or nothing when the port is free. Exit 9
# only when the host offers no way to ask, which is a different answer from "no
# listener" and must not be confused with it.
port_pid() {
  local out
  if command -v ss >/dev/null 2>&1; then
    out="$(ss -lntp 2>/dev/null | { grep -w ":$1" || true; } | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)"
  elif command -v lsof >/dev/null 2>&1; then
    out="$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  else
    echo "cannot identify the holder of port $1: no ss and no lsof" >&2
    return 9
  fi
  printf '%s' "$out"
}

# The port a slug owns. Stable, so every hook derives the same one.
slug_port() {
  local n
  n=$(printf '%s' "$1" | cksum | cut -d' ' -f1)
  printf '%s' $((4300 + n % 200))
}

pgid_of() { ps -o pgid= -p "$1" 2>/dev/null | tr -d ' '; }
