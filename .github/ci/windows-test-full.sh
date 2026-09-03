#!/usr/bin/env bash
# `bun test`, one file per process, on the Windows runner.
#
# Everywhere else the suite is a single `bun test`. On Windows Bun 1.3.14
# panics with a segmentation fault partway through the run — after
# `src/daemon/daemon.test.ts`, at the point where a test that timed out
# leaves the runner killing the daemon it started — and takes the process
# down with it, so every file the runner had not reached yet reports nothing
# at all. A process per file means one file's crash costs that file's
# verdict and no other's.
#
# Run from packages/werk-poc. The roll-up at the end is the suite's verdict:
# the files that failed, and the files whose process died without a tally.

set -uo pipefail

: "${FILE_TIMEOUT:=180}"
: "${GITHUB_WORKSPACE:=$(git rev-parse --show-toplevel)}"

log="${1:-full.log}"
: >"$log"
rc=0
failed=()
crashed=()
hung=()
total_pass=0
total_fail=0

files=$(git ls-files '*.test.ts' | grep -v '^vendor/' | sort)

for f in $files; do
  echo "::group::$f"
  one="$(dirname "$log")/one.log"
  if command -v timeout >/dev/null 2>&1; then
    timeout -k 15 "$FILE_TIMEOUT" bun test "$f" >"$one" 2>&1
  else
    bun test "$f" >"$one" 2>&1
  fi
  code=$?
  tr -d '\r' <"$one" | tee -a "$log"
  echo "::endgroup::"

  # `N pass` / `N fail` is Bun's own tally. A file whose process died before
  # printing one has no verdict at all; one that printed a clean tally and
  # then sat until the deadline passed its tests and did not exit. Both are
  # red, and neither is the same thing as a test failing.
  p=$(grep -aoE '^[[:space:]]*[0-9]+ pass' "$one" | tail -1 | tr -dc '0-9')
  q=$(grep -aoE '^[[:space:]]*[0-9]+ fail' "$one" | tail -1 | tr -dc '0-9')
  total_pass=$((total_pass + ${p:-0}))
  total_fail=$((total_fail + ${q:-0}))
  if [ -z "$p" ] && [ -z "$q" ]; then
    crashed+=("$f($code)")
    rc=1
  elif [ "${q:-0}" -eq 0 ] && { [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; }; then
    hung+=("$f")
    rc=1
  elif [ "$code" -ne 0 ]; then
    failed+=("$f")
    rc=1
  fi
  echo "FILE $f exit=$code pass=${p:-0} fail=${q:-0}"

  # A daemon an earlier file left running holds `dist/wp.exe` open and
  # answers on the default socket; neither belongs to the next file.
  # (its own DETAIL line is renamed, so the roll-up below stays the last one)
  bun run "$GITHUB_WORKSPACE/.github/ci/windows-daemon.ts" stop 2>&1 |
    sed 's/^DETAIL: /stopped: /' || true
done

echo "--- files and failures ---"
grep -aE '^FILE |^\(fail\)' "$log"

n=$(printf '%s\n' $files | wc -l | tr -d ' ')
echo "DETAIL: ${total_pass} pass ${total_fail} fail across $n files;" \
  "failing: ${failed[*]:-none};" \
  "passed but did not exit: ${hung[*]:-none};" \
  "no verdict: ${crashed[*]:-none}"

exit "$rc"
