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

SUITE_ORDER="install typecheck test-pure build-web build test-full m0 m2 m3 ops diff"

# --- helpers ---------------------------------------------------------------

# BSD `date` has no %N, so the clock comes from python3, which every macOS
# runner image carries.
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

json_escape() {
  # stdin -> a JSON string body (no surrounding quotes)
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])'
}

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
  local esc
  esc="$(printf '%s' "$detail" | json_escape)"
  cat >"$RESULTS/$id.json" <<EOF
{"id":"$id","name":"$id","status":"$status","ms":$ms,"detail":"$esc"}
EOF
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
      grep -a -E '^[[:space:]]*[0-9]+ (pass|fail)$' "$log" | tr -d '\n' | tr -s ' ' | cut -c1-200
      ;;
    m0)
      grep -a -E '^\| [0-9]{2}-' "$log" |
        sed -E 's/^\| *([^ |]+) *\|/\1=/; s/ *\|//g; s/  +/ /g' |
        tr '\n' ' ' | cut -c1-300
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
s_build() {
  cd "$POC" || return 1
  bun run build || return 1
  ./dist/wp --help || return 1
  ./dist/wp caps || return 1
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
    {
      printf '{"os":"macos-latest","runner":"%s","bun":"%s","commit":"%s","suites":[' \
        "${WP_CI_RUNNER:-unknown}" "$(bun --version 2>/dev/null || echo unknown)" "${GITHUB_SHA:-unknown}"
      first=1
      for id in $SUITE_ORDER; do
        f="$RESULTS/$id.json"
        if [ ! -f "$f" ]; then
          esc="$(printf '%s' "did not run" | json_escape)"
          f_content="{\"id\":\"$id\",\"name\":\"$id\",\"status\":\"skip\",\"ms\":0,\"detail\":\"$esc\"}"
        else
          f_content="$(cat "$f")"
        fi
        [ $first -eq 1 ] || printf ','
        first=0
        printf '%s' "$f_content"
      done
      printf ']}'
    } >"$out"
    python3 -m json.tool "$out" >"$out.pretty" && mv "$out.pretty" "$out"
    cat "$out"
    ;;
  *)
    echo "usage: macos.sh suite <id> | macos.sh summarize [out]" >&2
    exit 2
    ;;
esac
