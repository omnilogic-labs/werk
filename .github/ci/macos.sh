#!/usr/bin/env bash
# Suite runner for the macOS probe. One suite per invocation, so a workflow
# step can carry `continue-on-error` and the job still reaches every suite.
#
#   .github/ci/macos.sh suite <id>     runs one suite, always exits 0..1
#   .github/ci/macos.sh summarize      writes ci-result-macos.json
#
# Each suite leaves $WP_CI_RESULTS/<id>.json behind and appends a row to
# $GITHUB_STEP_SUMMARY. `summarize` collects those in suite order.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
POC="$ROOT/packages/werk-poc"
RESULTS="${WP_CI_RESULTS:-$ROOT/ci-results}"
LOGS="$RESULTS/logs"
mkdir -p "$LOGS"

SUITE_ORDER="install typecheck test-pure build-web build codesign test-full m0 m2 m3 ops diff"

# --- helpers ---------------------------------------------------------------

# BSD `date` has no %N, so the clock comes from python3, which every macOS
# runner image carries.
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

# The one line that best explains a failure: the first line that looks like an
# error, else the last non-empty line.
detail_from_log() {
  local log="$1"
  local line
  line="$(grep -a -m1 -E '^(error|Error|ERROR|.*[Ee]rror:|FAIL|fail |# fail|.*not found|.*Cannot find|.*panic)' "$log" | head -1)"
  if [ -z "$line" ]; then
    line="$(grep -a -v '^[[:space:]]*$' "$log" | tail -1)"
  fi
  printf '%s' "${line:0:400}"
}

record() {
  local id="$1" status="$2" ms="$3" detail="$4"
  # jq builds the object, so whatever the detail contains — backslashes,
  # quotes, control characters — lands as a valid JSON string.
  jq -n --arg id "$id" --arg status "$status" --argjson ms "$ms" --arg detail "$detail" \
    '{id: $id, name: $id, status: $status, ms: $ms, detail: $detail}' >"$RESULTS/$id.json"
  echo "=== SUITE $id: $status (${ms} ms) :: $detail"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    local icon="x"
    [ "$status" = pass ] && icon="ok"
    [ "$status" = skip ] && icon="-"
    printf '| `%s` | %s %s | %s ms | %s |\n' \
      "$id" "$icon" "$status" "$ms" "$(printf '%s' "$detail" | tr '|' '/' | tr -d '\n' | cut -c1-200)" \
      >>"$GITHUB_STEP_SUMMARY"
  fi
}

# Runs a command, times it, records the verdict, and streams the output so the
# run log has everything. Never lets the caller's shell die on failure.
run_suite() {
  local id="$1"
  shift
  local log="$LOGS/$id.log"
  local t0 t1 rc
  t0=$(now_ms)
  ( "$@" ) 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}
  t1=$(now_ms)
  local ms=$((t1 - t0))
  local verdict
  verdict="$(summary_for "$id" "$log")"
  if [ "$rc" -eq 0 ]; then
    record "$id" pass "$ms" "$verdict"
    return 0
  fi
  record "$id" fail "$ms" "${verdict:-exit $rc}${verdict:+ | }$(detail_from_log "$log")"
  return 1
}

# A one-line verdict for a suite, pass or fail; the interesting number rather
# than whatever happened to be printed last.
summary_for() {
  local id="$1" log="$2"
  case "$id" in
    test-pure | test-full)
      # The counts, plus the names of the tests that failed — the gate reads
      # those names to tell a real regression from the known slow-client
      # scenario, so a bare pass/fail count is not enough.
      counts="$(grep -a -E '^[[:space:]]*[0-9]+ (pass|fail)$' "$log" | tr -d '\n' | tr -s ' ')"
      fails="$(grep -aE '^\(fail\) ' "$log" | sort -u | head -3 | paste -sd';' - | cut -c1-200)"
      printf '%s%s' "$counts" "${fails:+ - failing: $fails}" | cut -c1-400
      ;;
    m0)
      grep -a -E '^\| [0-9]{2}-' "$log" |
        sed -E 's/^\| *([^ |]+) *\|/\1=/; s/ *\|//g; s/  +/ /g' |
        tr '\n' ' ' | cut -c1-300
      ;;
    codesign)
      # The signature the binary now carries, and what --verify made of it.
      printf '%s; %s' \
        "$(grep -am1 -E '^(Signature|CodeDirectory)' "$log" | cut -c1-160)" \
        "$(grep -am1 -E 'valid on disk|satisfies its Designated|invalid|not signed|modified' "$log" | cut -c1-160)"
      ;;
    m2)
      grep -a -E '^\| .* \| (pass|FAIL) \|' "$log" |
        sed -E 's/^\| (.*) \| (pass|FAIL) \| .*/\2/' | sort | uniq -c |
        tr -d '\n' | tr -s ' ' | cut -c1-200
      ;;
    diff)
      # The engine-agreement table, as a count of verdicts, so the JSON says
      # something a reader can compare against another platform's run.
      awk '/^\| case +\| ghostty-wasm/ { t = 1; next }
           /^\| case +\| engine/ { t = 0; next }
           t && /^\| [a-z0-9]/ {
             n = split($0, f, "|")
             for (i = 3; i < n; i++) { gsub(/^ +| +$/, "", f[i]); if (f[i] != "") c[f[i] ~ /^agree/ ? "agree" : "differ"]++ }
           }
           END { printf "engine-pair verdicts: %d agree, %d differ", c["agree"], c["differ"] }' "$log"
      ;;
    *)
      tail -1 "$log" | cut -c1-200
      ;;
  esac
}

# --- suites ----------------------------------------------------------------

s_install() { cd "$ROOT" && bun install --frozen-lockfile; }
s_typecheck() { cd "$POC" && bun run typecheck; }
s_test_pure() { cd "$POC" && bun test src/engine src/protocol; }
s_build_web() { cd "$POC" && bun run build:web; }
# Appending the JavaScript bundle invalidates whatever signature the Bun
# executable arrived with, so a fresh `bun build --compile` output never
# verifies (findings/platforms.md). An ad-hoc signature repairs it in one
# step, and is what a macOS release would do on the way out of the build.
s_build() {
  cd "$POC" || return 1
  bun run build || return 1
  codesign --force --sign - ./dist/wp || return 1
  ./dist/wp --help || return 1
  ./dist/wp caps || return 1
}
s_codesign() {
  cd "$POC" || return 1
  test -f dist/wp || {
    echo "no dist/wp (did the build step run?)"
    return 1
  }
  codesign -dvv ./dist/wp 2>&1
  codesign --verify --strict --verbose=2 ./dist/wp 2>&1
}
s_test_full() { cd "$POC" && bun test; }
# `run-all.ts` prints a table and exits 0 whatever the probes said, so the
# verdict has to come out of the results file it leaves behind.
s_m0() {
  cd "$POC" || return 1
  bun run m0
  python3 - "$POC/dist/m0/results.json" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
bad = []
for probe, cells in sorted(d["results"].items()):
    for col, cell in cells.items():
        if cell["status"] != "pass":
            bad.append(f'{probe} [{col}]: {cell["status"]} - {cell["summary"]}')
for line in bad:
    print("m0 not pass:", line)
sys.exit(1 if bad else 0)
EOF
}
s_m2() { cd "$POC" && bun run m2; }
s_m3() { cd "$POC" && bun run m3; }
s_ops() { cd "$POC" && bun run bench/ops.ts --quick --no-compile; }
s_diff() { cd "$POC" && bun run bench/differential.ts; }

# --- entry point -----------------------------------------------------------

case "${1:-}" in
  suite)
    id="${2:?suite id}"
    fn="s_${id//-/_}"
    if ! declare -F "$fn" >/dev/null; then
      echo "unknown suite: $id" >&2
      exit 2
    fi
    run_suite "$id" "$fn"
    exit $?
    ;;
  summarize)
    out="${2:-$ROOT/ci-result-macos.json}"
    # One verdict per suite, in suite order. A suite that left no file did
    # not run to the point of recording one (killed by `timeout-minutes`, or
    # the job was cancelled) and is recorded as a skip; one that left a file
    # jq cannot read is recorded as an error. Neither is a pass, so both are
    # red below.
    entries="$RESULTS/.entries.json"
    : >"$entries"
    for id in $SUITE_ORDER; do
      f="$RESULTS/$id.json"
      if [ ! -f "$f" ]; then
        jq -n --arg id "$id" '{id: $id, name: $id, status: "skip", ms: 0, detail: "did not run"}' >>"$entries"
      elif jq -e . "$f" >/dev/null 2>&1; then
        cat "$f" >>"$entries"
      else
        jq -n --arg id "$id" '{id: $id, name: $id, status: "error", ms: 0, detail: "the recorded verdict is not valid JSON"}' >>"$entries"
      fi
    done
    jq -n \
      --arg os "macos-latest" \
      --arg runner "${WP_CI_RUNNER:-unknown}" \
      --arg bun "$(bun --version 2>/dev/null || echo unknown)" \
      --arg commit "${GITHUB_SHA:-unknown}" \
      --slurpfile suites "$entries" \
      '{os: $os, runner: $runner, bun: $bun, commit: $commit, suites: $suites}' >"$out"
    cat "$out"
    # Fail closed: a report the gate cannot read must not read as green.
    if ! jq -e '.suites | type == "array"' "$out" >/dev/null 2>&1; then
      echo "$out is not valid JSON; refusing to gate on it" >&2
      exit 1
    fi

    # Red overall when a suite that passes on this platform stops passing, so
    # the job's conclusion means "something regressed" rather than "macOS
    # gives a unix socket an 8 KiB buffer". Every suite in SUITE_ORDER has to
    # have recorded a pass; a skip or an unreadable verdict is as red as a
    # fail, so a hang cannot turn the job green.
    #
    # `m2` and `test-full` may fail, and only for one reason: under M2's 4 MB
    # burst the daemon short-writes after about 8 KB where Linux manages
    # about 218 KB, so a client that never lags on Linux is dropped and
    # re-rendered here. findings/platforms.md records the sysctl and the
    # numbers.
    #
    # The excuse is deliberately narrow: each is forgiven only when the set
    # of things its log reports failing is exactly that scenario (for
    # `test-full`, the one test that runs it). Anything else failing
    # alongside it is a real regression and turns the job red.
    KNOWN_M2_FAIL='slow client: one wp attach SIGSTOPped under yes | head -c 4M'
    KNOWN_TEST_FULL_FAIL='reattach fidelity: every scenario passes (spikes/m2/run-all.ts)'
    failing_tests() { grep -aE '^\(fail\) ' "$1" 2>/dev/null | sed -E 's/^\(fail\) //; s/ \[[0-9.]+m?s\]$//' | sort -u; }
    failing_scenarios() { grep -aE '^FAIL  ' "$1" 2>/dev/null | sed 's/^FAIL  //' | sort -u; }

    gate=0
    red() {
      echo "$1" >&2
      gate=1
    }
    for id in $SUITE_ORDER; do
      status="$(jq -r --arg id "$id" '.suites[] | select(.id == $id) | .status' "$out")"
      case "$status" in
      pass) ;;
      fail)
        case "$id" in
        test-full)
          got="$(failing_tests "$LOGS/test-full.log")"
          known="$KNOWN_TEST_FULL_FAIL"
          ;;
        m2)
          got="$(failing_scenarios "$LOGS/m2.log")"
          known="$KNOWN_M2_FAIL"
          ;;
        *)
          red "$id should pass on macOS and failed"
          continue
          ;;
        esac
        if [ "$got" = "$known" ]; then
          echo "$id failed only on the known slow-client scenario; forgiven"
        else
          red "$id failed for something other than the m2 slow-client scenario: $(printf '%s' "$got" | paste -sd';' -)"
        fi
        ;;
      *) red "$id has no usable verdict (${status:-missing}): its step was killed, never ran, or left nothing readable" ;;
      esac
    done
    [ "$gate" -eq 0 ] || exit 1
    ;;
  *)
    echo "usage: macos.sh suite <id> | macos.sh summarize [out]" >&2
    exit 2
    ;;
esac
