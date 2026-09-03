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
# The tests' verdict and the process's exit are recorded separately. On
# `windows-latest` a `bun test` process that has run the wasm engine prints
# its whole tally and then, about one time in a hundred, never exits — 11
# of 2,340 such processes in run 33745611845, none of 1,200 that compiled
# the module without running it. Bun 1.3.14's `ExitProcess` terminates
# JSC's helper threads, and the exit can then wait on one of them forever
# (oven-sh/bun#40513 is the same shape on arm64, fixed after 1.3.14). With
# JSC's concurrent JIT off the compiles run on the JS thread, there is no
# such thread to lose, and the same files did not hang once in 1,200 runs;
# with the concurrent collector off they hung 36 times. So the `bun test`
# below runs with `BUN_JSC_useConcurrentJIT=false`, which costs an engine
# file about half a second of synchronous compilation. Bun refuses a
# `BUN_JSC_*` name its JSC does not know, so a Bun that drops the option
# fails every file here rather than quietly running without it.
#
# In case a process still does not exit, the script watches each file's
# output for Bun's closing `Ran N tests` line and gives the process
# EXIT_GRACE seconds after it to be gone; one that is not is killed, listed
# under `did not exit`, and counted as what its tally says, since it is past
# its last test. A file with no tally at all, or a failing one, is red as
# before.
#
# Run from packages/werk-poc. The roll-up at the end is the suite's verdict:
# the files that failed, the files whose process died without a tally, and
# the files whose process passed and did not exit. TEST_FILES overrides the
# file list, for probes.

set -uo pipefail

: "${FILE_TIMEOUT:=180}"
: "${EXIT_GRACE:=15}"
: "${GITHUB_WORKSPACE:=$(git rev-parse --show-toplevel)}"
export BUN_JSC_useConcurrentJIT=false

log="${1:-full.log}"
: >"$log"
rc=0
failed=()
crashed=()
hung=()
total_pass=0
total_fail=0

files=${TEST_FILES:-$(git ls-files '*.test.ts' | grep -v '^vendor/' | sort)}

# Runs one file with its output on $2. Sets `code` to the process's exit
# status, or 124 when this script had to kill it, and `late` to 1 when the
# kill came after a complete tally.
run_file() {
  local f="$1" one="$2" pid started=$SECONDS tally=
  code=
  late=0
  bun test "$f" >"$one" 2>&1 &
  pid=$!
  while :; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"
      code=$?
      return
    fi
    if [ -z "$tally" ] && grep -aqE '^Ran [0-9]+ tests? across' "$one"; then
      tally=$SECONDS
    fi
    if [ -n "$tally" ] && [ $((SECONDS - tally)) -ge "$EXIT_GRACE" ]; then
      late=1
      break
    fi
    [ $((SECONDS - started)) -lt "$FILE_TIMEOUT" ] || break
    sleep 0.25
  done
  # MSYS's `kill` reaches the process it started and nothing under it; the
  # Windows pid reaches the tree. Neither is waited on: a process stuck in
  # its own exit can outlive both.
  local winpid
  winpid=$(cat "/proc/$pid/winpid" 2>/dev/null || true)
  [ -z "$winpid" ] || taskkill //F //T //PID "$winpid" >/dev/null 2>&1 || true
  kill -9 "$pid" 2>/dev/null || true
  code=124
}

for f in $files; do
  echo "::group::$f"
  one="$(dirname "$log")/one.log"
  run_file "$f" "$one"
  tr -d '\r' <"$one" | tee -a "$log"
  echo "::endgroup::"

  # `N pass` / `N fail` is Bun's own tally. A file whose process died before
  # printing one has no verdict at all, which is red; one that printed a
  # clean tally and then stayed passed its tests and did not exit, which is
  # recorded and is not.
  p=$(grep -aoE '^[[:space:]]*[0-9]+ pass' "$one" | tail -1 | tr -dc '0-9')
  q=$(grep -aoE '^[[:space:]]*[0-9]+ fail' "$one" | tail -1 | tr -dc '0-9')
  total_pass=$((total_pass + ${p:-0}))
  total_fail=$((total_fail + ${q:-0}))
  note=""
  if [ -z "$p" ] && [ -z "$q" ]; then
    crashed+=("$f($code)")
    rc=1
  elif [ "${q:-0}" -eq 0 ] && [ "$late" -eq 1 ]; then
    hung+=("$f")
    note=" (passed, did not exit; killed ${EXIT_GRACE}s after its tally)"
  elif [ "$code" -ne 0 ]; then
    failed+=("$f")
    rc=1
  fi
  echo "FILE $f exit=$code pass=${p:-0} fail=${q:-0}$note"

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
