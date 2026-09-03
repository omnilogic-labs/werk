#!/usr/bin/env bash
# `windows-test-full.sh` itself, over a short file list, many times: what a
# passed-but-did-not-exit process costs the suite once the harness watches
# for the tally, and what the roll-up says about it.
#
#   .github/ci/step10-exit-hang-harness.sh <runs> <file>...
#
# Run from packages/werk-poc. One `HARNESS <n>: rc=<rc> <ms>ms <DETAIL>`
# line per run.

set -uo pipefail

runs="$1"
shift

: "${OUT:=$RUNNER_TEMP/exit-hang}"
mkdir -p "$OUT/harness"

late=0
for n in $(seq 1 "$runs"); do
  log="$OUT/harness/full-$n.log"
  start=$(date +%s%N)
  TEST_FILES="$*" bash "$GITHUB_WORKSPACE/.github/ci/windows-test-full.sh" "$log" >"$OUT/harness/out-$n.log" 2>&1
  rc=$?
  end=$(date +%s%N)
  ms=$(((end - start) / 1000000))
  detail=$(tr -d '\r' <"$OUT/harness/out-$n.log" | grep -a '^DETAIL: ' | tail -1 | sed 's/^DETAIL: //')
  case "$detail" in
    *"did not exit: none"*) ;;
    *) late=$((late + 1)) ;;
  esac
  echo "HARNESS $n: rc=$rc ${ms}ms $detail"
  tr -d '\r' <"$OUT/harness/out-$n.log" | grep -a '^FILE .*did not exit' | sed 's/^/  /'
done
echo "RATE harness: $late/$runs runs had a file that passed and did not exit"
# What the harness's kill left behind, if anything.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | Select-Object ProcessId,ParentProcessId,ThreadCount,CommandLine | Format-Table -AutoSize -Wrap | Out-String -Width 300" 2>/dev/null | tr -d '\r' | sed 's/^/  LEFT /' | grep -av '^  LEFT *$' || true
