#!/usr/bin/env bash
# How often a `bun test` process on Windows prints a clean tally and then does
# not exit, one file at a time, many times, under the lane's own `timeout`.
#
#   .github/ci/step10-exit-hang.sh <phase> <runs> <file>...
#
# Run from packages/werk-poc. `<phase>` names where the process's stdout
# goes, which is the one thing the lane's harness does that a developer's
# terminal does not:
#
#   file     `>one.log 2>&1`, what `windows-test-full.sh` does
#   pipe     `2>&1 | cat >one.log`, a pipe rather than a file
#   inherit  no redirect at all: the step's own stdout
#
# One `PROBE <file>-<n>: exit=<code> <ms>ms pass=<p> fail=<q> sink=<phase>`
# line per run, with `$TAG` appended when the caller set one (the name of
# whatever else the environment carries, such as a `BUN_JSC_*` option). A
# run that printed a tally with no failures and was then killed by
# `timeout` (124, or 137 after the -k) is the hang this measures; its output
# is kept as `$OUT/hang-<phase>-<file>-<n>.log`.

set -uo pipefail

phase="$1"
runs="$2"
shift 2

: "${OUT:=$RUNNER_TEMP/exit-hang}"
: "${PER_RUN:=60}"
mkdir -p "$OUT"

hung=0
total=0
for f in "$@"; do
  base=$(basename "$f" .test.ts)
  fhung=0
  for n in $(seq 1 "$runs"); do
    one="$OUT/one.log"
    start=$(date +%s%N)
    case "$phase" in
      file) timeout -k 5 "$PER_RUN" bun test "$f" >"$one" 2>&1 ;;
      pipe) timeout -k 5 "$PER_RUN" bun test "$f" 2>&1 | cat >"$one" ;;
      inherit)
        timeout -k 5 "$PER_RUN" bun test "$f"
        : >"$one"
        ;;
      *)
        echo "unknown phase $phase" >&2
        exit 2
        ;;
    esac
    code=$?
    end=$(date +%s%N)
    ms=$(((end - start) / 1000000))
    p=$(tr -d '\r' <"$one" | grep -aoE '^[[:space:]]*[0-9]+ pass' | tail -1 | tr -dc '0-9')
    q=$(tr -d '\r' <"$one" | grep -aoE '^[[:space:]]*[0-9]+ fail' | tail -1 | tr -dc '0-9')
    verdict=""
    if [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then
      verdict=" HUNG"
      fhung=$((fhung + 1))
      cp "$one" "$OUT/hang-$phase-$base-$n.log" 2>/dev/null || true
    fi
    echo "PROBE $base-$n: exit=$code ${ms}ms pass=${p:-?} fail=${q:-?} sink=$phase${TAG:+ $TAG}$verdict"
    total=$((total + 1))
  done
  hung=$((hung + fhung))
  echo "RATE $base sink=$phase${TAG:+ $TAG}: $fhung/$runs did not exit"
done
echo "RATE all sink=$phase${TAG:+ $TAG}: $hung/$total did not exit"
