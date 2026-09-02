#!/usr/bin/env bash
# The M0 PTY probes, one file at a time.
#
# `spikes/m0/run-all.ts` runs each probe interpreted *and* compiles it and
# runs the compiled copy, under a generous per-cell deadline. On linux that
# costs a couple of minutes; on windows every probe the platform cannot
# answer sits until its deadline expires, and the whole thing took
# twenty-two minutes. Nothing in the compiled column said anything the
# interpreted column had not, so this runs the probes directly and prints a
# roll-up of what each one decided.
#
# Run from packages/werk-poc. `M0_LAT_N` shortens 07-latency's round trips.

set -uo pipefail

log="${1:-m0-probes.log}"
: >"$log"
rc=0

for p in spikes/m0/0*.ts; do
  echo "===== $p"
  bun run "$p" >>"$log" 2>&1 || rc=1
done

cat "$log"

echo "--- verdicts ---"
grep -a '^RESULT ' "$log" |
  sed -e 's/^RESULT //' -e 's/,"details".*//' |
  sed -e 's/[{}"]//g' -e 's/probe://' -e 's/,status:/ -> /' -e 's/,bun:[^,]*//' \
      -e 's/,compiled:[a-z]*//' -e 's/,summary:/: /'

bad=$(grep -a '^RESULT ' "$log" | grep -av '"status":"pass"' |
  sed -e 's/.*"probe":"\([^"]*\)".*/\1/' | tr '\n' ' ')
echo "DETAIL: m0 probes not passing: ${bad:-none}"

exit "$rc"
