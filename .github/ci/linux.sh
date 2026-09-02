#!/usr/bin/env bash
# One suite of the werk proof of concept, on a Linux CI runner.
#
#   .github/ci/linux.sh <suite-id>   run one suite and record its verdict
#   .github/ci/linux.sh report       merge the verdicts into ci-result-linux.json
#
# A suite writes $CI_OUT_DIR/suites/<n>-<id>.json, appends a row to
# $GITHUB_STEP_SUMMARY, and exits non-zero when it failed — the workflow step
# goes red while `continue-on-error` keeps the rest of the job running, so one
# run reports on every suite.

set -uo pipefail

SUITE="${1:-}"
if [ -z "$SUITE" ]; then
  echo "usage: linux.sh <suite-id>|report" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
POC="$ROOT/packages/werk-poc"
OUT="${CI_OUT_DIR:-$ROOT/.ci-out}"
mkdir -p "$OUT/suites" "$OUT/logs"
LOG="$OUT/logs/$SUITE.log"
: >"$LOG"

# The order the suites appear in the artefact and the step summary.
ORDER=(install format typecheck test-pure build-web build test-full m0 m2 m3 ops diff)

# `date +%3N` is not universally honoured; nanoseconds always are.
now_ms() { echo $(($(date +%s%N) / 1000000)); }

summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$1" >>"$GITHUB_STEP_SUMMARY"; fi
}

# run <dir> <cmd...> — echo the command, run it, tee everything into the log.
run() {
  local dir="$1"
  shift
  printf '$ (cd %s && %s)\n' "${dir#"$ROOT"/}" "$*" | tee -a "$LOG"
  (cd "$dir" && "$@") 2>&1 | tee -a "$LOG"
  return "${PIPESTATUS[0]}"
}

# The first line of the log matching a pattern, trimmed to one summary line.
pick() { grep -am1 -E "$1" "$LOG" | tr -d '\r' | cut -c1-240; }
count() { grep -acE "$1" "$LOG"; }

# What to say about a failure with no better idea: the first `error:` line, or
# failing that the last thing the command printed.
why() {
  local d
  d="$(pick '^error')"
  if [ -z "$d" ]; then d="$(grep -av '^[[:space:]]*$' "$LOG" | tail -1 | tr -d '\r' | cut -c1-240)"; fi
  printf '%s' "$d"
}

# `bun test`: the count line, plus the names of the tests that failed.
bun_test_detail() {
  local ran fails
  ran="$(pick 'Ran [0-9]+ tests')"
  fails="$(grep -aE '^\(fail\) ' "$LOG" | sort -u | head -3 | paste -sd';' - | cut -c1-200)"
  printf '%s%s' "$ran" "${fails:+ — failing: $fails}"
}

# ------------------------------------------------------------------ report

if [ "$SUITE" = "report" ]; then
  jq -s '.' "$OUT"/suites/*.json >"$OUT/suites.json" 2>/dev/null || echo '[]' >"$OUT/suites.json"
  runner="$(uname -srm)"
  if [ -n "${ImageOS:-}" ]; then runner="$runner, image ${ImageOS}${ImageVersion:+/$ImageVersion}"; fi
  if [ -n "${RUNNER_ARCH:-}" ]; then runner="$runner, runner arch ${RUNNER_ARCH}"; fi
  # A note the coordinator should not have to rediscover: the one scenario
  # that wants more CPU headroom than a 4-vCPU hosted runner has.
  notes=""
  if grep -aq '^FAIL  slow client' "$OUT/logs/m2.log" 2>/dev/null; then
    notes="m2's 'slow client' scenario asserts that the fast client never lags while a stopped one floods 4 MB through the daemon. On a 4-vCPU hosted runner the fast client's own queue crosses the daemon's 256 KiB drop bound, so it lags and loses bytes; it reproduces locally when the box is pinned to two cores. test-full fails for the same reason, through spikes/m2/fidelity.test.ts."
  fi
  jq -n \
    --arg os "ubuntu-latest" \
    --arg runner "$runner" \
    --arg bun "$(bun --version 2>/dev/null || echo unknown)" \
    --arg commit "${GITHUB_SHA:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)}" \
    --arg caps "$(cat "$OUT/caps.txt" 2>/dev/null)" \
    --arg opsPlatforms "$(cat "$OUT/ops-platforms.txt" 2>/dev/null)" \
    --arg notes "$notes" \
    --slurpfile suites "$OUT/suites.json" \
    '{os: $os, runner: $runner, bun: $bun, commit: $commit, suites: $suites[0], caps: $caps, opsPlatforms: $opsPlatforms, notes: $notes}' \
    >"$OUT/ci-result-linux.json"
  echo "--- ci-result-linux.json"
  cat "$OUT/ci-result-linux.json"
  summary ""
  summary "### Engine capability matrix (\`wp caps\`)"
  summary ""
  summary '```'
  cat "$OUT/caps.txt" 2>/dev/null >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
  summary '```'
  summary ""
  summary "### Platform matrix (\`wp bench ops\`)"
  summary ""
  summary '```'
  cat "$OUT/ops-platforms.txt" 2>/dev/null >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
  summary '```'
  # Red overall when any suite failed, so the job's conclusion means something.
  if jq -e '.suites | map(select(.status == "fail")) | length > 0' "$OUT/ci-result-linux.json" >/dev/null; then
    echo "one or more suites failed" >&2
    exit 1
  fi
  exit 0
fi

# ------------------------------------------------------------------- suites

T0="$(now_ms)"
STATUS=pass
DETAIL=""

case "$SUITE" in
install)
  NAME="bun install --frozen-lockfile (repo root)"
  run "$ROOT" bun install --frozen-lockfile
  CODE=$?
  DETAIL="$(pick '[0-9]+ packages installed|Checked [0-9]+ package')"
  ;;

format)
  NAME="bun run format:check (prettier, repo root)"
  run "$ROOT" bun run format:check
  CODE=$?
  if [ $CODE -eq 0 ]; then
    DETAIL="all matched files use Prettier code style"
  else
    DETAIL="$(pick '\[warn\]')"
  fi
  ;;

typecheck)
  NAME="bun run typecheck (tsc, package + web client)"
  run "$POC" bun run typecheck
  CODE=$?
  if [ $CODE -eq 0 ]; then
    DETAIL="tsc --noEmit clean for both tsconfigs"
  else
    DETAIL="$(pick 'error TS')"
  fi
  ;;

test-pure)
  NAME="bun test src/engine src/protocol"
  run "$POC" bun test src/engine src/protocol
  CODE=$?
  DETAIL="$(bun_test_detail)"
  ;;

build-web)
  NAME="bun run build:web"
  run "$POC" bun run build:web
  CODE=$?
  if [ $CODE -eq 0 ]; then
    DETAIL="src/web/bundle/app.js is $(stat -c %s "$POC/src/web/bundle/app.js" 2>/dev/null || echo '?') bytes"
  else
    DETAIL="$(why)"
  fi
  ;;

build)
  NAME="bun run build, then wp --help and wp caps"
  run "$POC" bun run build
  CODE=$?
  if [ $CODE -eq 0 ]; then
    run "$POC" ./dist/wp --help
    CODE=$?
  fi
  if [ $CODE -eq 0 ]; then
    (cd "$POC" && ./dist/wp caps) >"$OUT/caps.txt" 2>&1
    CODE=$?
    cat "$OUT/caps.txt" | tee -a "$LOG"
    if [ $CODE -eq 0 ] && grep -qE 'did not load' "$OUT/caps.txt"; then
      CODE=1
      DETAIL="wp caps: $(grep -m1 -E 'did not load' "$OUT/caps.txt")"
    fi
  fi
  if [ $CODE -eq 0 ]; then
    DETAIL="dist/wp is $(stat -c %s "$POC/dist/wp" 2>/dev/null || echo '?') bytes; caps lists $(grep -cE '^\| ' "$OUT/caps.txt" 2>/dev/null || echo 0) matrix rows"
  else
    DETAIL="${DETAIL:-$(why)}"
  fi
  ;;

test-full)
  NAME="bun test (whole package; runs build --compile transitively)"
  run "$POC" bun test
  CODE=$?
  DETAIL="$(bun_test_detail)"
  ;;

m0)
  NAME="bun run m0 (PTY probes, interpreted and compiled)"
  run "$POC" bun run m0
  CODE=$?
  RESULTS="$POC/dist/m0/results.json"
  if [ $CODE -eq 0 ] && [ -f "$RESULTS" ]; then
    bad="$(jq -r '[.results | to_entries[] | .key as $p | .value | to_entries[] | select(.value.status != "pass") | "\($p) [\(.key)]: \(.value.status) — \(.value.summary)"] | .[]' "$RESULTS")"
    total="$(jq -r '[.results | to_entries[] | .value | to_entries[]] | length' "$RESULTS")"
    passed="$(jq -r '[.results | to_entries[] | .value | to_entries[] | select(.value.status == "pass")] | length' "$RESULTS")"
    if [ -n "$bad" ]; then
      CODE=1
      DETAIL="$passed/$total probe cells pass; first problem: $(printf '%s' "$bad" | head -1 | cut -c1-200)"
      printf 'non-passing probe cells:\n%s\n' "$bad" | tee -a "$LOG"
    else
      DETAIL="$passed/$total probe cells pass across $(jq -r '.columns | join(", ")' "$RESULTS")"
    fi
  elif [ $CODE -eq 0 ]; then
    CODE=1
    DETAIL="run-all.ts exited 0 but wrote no dist/m0/results.json"
  else
    DETAIL="$(why)"
  fi
  ;;

m2)
  NAME="bun run m2 (reattach fidelity scenarios)"
  run "$POC" bun run m2
  CODE=$?
  pass="$(count '^PASS  ')"
  fail="$(count '^FAIL  ')"
  DETAIL="$pass scenarios pass, $fail fail"
  if [ "$fail" -gt 0 ]; then
    DETAIL="$DETAIL — $(grep -aE '^FAIL  ' "$LOG" | sed 's/^FAIL  //' | paste -sd'; ' - | cut -c1-200)"
  fi
  ;;

m3)
  NAME="bun run m3 (snapshot cost, cross-commit decode)"
  run "$POC" bun run m3
  CODE=$?
  skipped="$(count 'not on disk')"
  if [ $CODE -eq 0 ]; then
    DETAIL="snapshot-cost and cross-commit ran; $skipped ghostty tip builds not on disk (only the pinned one is committed)"
  else
    DETAIL="$(why)"
  fi
  ;;

ops)
  NAME="bun run bench/ops.ts --quick --no-compile"
  run "$POC" bun run bench/ops.ts --quick --no-compile
  CODE=$?
  awk '/^## Platform matrix/{f=1} /^## Cold start/{f=0} f' "$LOG" >"$OUT/ops-platforms.txt"
  if [ $CODE -eq 0 ]; then
    DETAIL="toolchain, platform matrix and cold start reported; ghostty-ffi prebuilds: $(grep -am1 -oE '(linux|darwin|windows)-[a-z0-9-]+(, [a-z0-9-]+)*' "$OUT/ops-platforms.txt" | cut -c1-120)"
  else
    DETAIL="$(why)"
  fi
  ;;

diff)
  NAME="bun run bench/differential.ts (24-case corpus, three engines)"
  run "$POC" bun run bench/differential.ts
  CODE=$?
  if [ $CODE -eq 0 ] && grep -qE 'did not load' "$LOG"; then
    CODE=1
    DETAIL="$(pick 'did not load')"
  elif [ $CODE -eq 0 ]; then
    agree="$(count '\| agree ')"
    differ="$(count '\| differ:')"
    DETAIL="$agree pairwise comparisons agree, $differ differ (differences are reported, never scored)"
  else
    DETAIL="$(why)"
  fi
  ;;

*)
  echo "linux.sh: unknown suite '$SUITE'" >&2
  exit 2
  ;;
esac

MS=$(($(now_ms) - T0))
if [ "${CODE:-1}" -ne 0 ]; then STATUS=fail; fi
DETAIL="$(printf '%s' "${DETAIL:-}" | tr '\n' ' ' | cut -c1-300)"

idx=0
for i in "${!ORDER[@]}"; do
  if [ "${ORDER[$i]}" = "$SUITE" ]; then idx=$i; fi
done

jq -n \
  --arg id "$SUITE" --arg name "$NAME" --arg status "$STATUS" \
  --argjson ms "$MS" --arg detail "$DETAIL" \
  '{id: $id, name: $name, status: $status, ms: $ms, detail: $detail}' \
  >"$OUT/suites/$(printf '%02d' "$idx")-$SUITE.json"

echo
echo "==> $SUITE: $STATUS in ${MS} ms — $DETAIL"
mark=$([ "$STATUS" = pass ] && echo ':white_check_mark: pass' || echo ':x: fail')
summary "| \`$SUITE\` | $mark | $((MS / 1000)) s | $NAME | ${DETAIL//|/\\|} |"

exit "${CODE:-1}"
