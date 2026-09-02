#!/usr/bin/env bash
# Runs one probe suite on the Windows runner and records its verdict.
#
#   .github/ci/windows.sh <id> <workdir> <shell command...>
#
# The workdir is relative to $GITHUB_WORKSPACE. Everything after it is joined
# and handed to `bash -c`, so pipes and `&&` work. The suite's stdout and
# stderr go to the step log and to a per-suite file; the status, duration and
# a one-line detail land in $SUITE_DIR for the assembling step to turn into
# ci-result-windows.json. Exits with the suite's own status so the step shows
# the truth; every caller sets continue-on-error, because running suites that
# are expected to fail is the entire point of this workflow.

set -uo pipefail

id="$1"
wd="$2"
shift 2
cmd="$*"

SUITE_DIR="${SUITE_DIR:-$RUNNER_TEMP/suites}"
mkdir -p "$SUITE_DIR"
log="$SUITE_DIR/$id.log"

: "${SUITE_TIMEOUT:=300}"

echo "::group::$id — $cmd (cwd $wd)"

start=$(date +%s%N)
if command -v timeout >/dev/null 2>&1; then
  (cd "$GITHUB_WORKSPACE/$wd" && timeout -k 15 "$SUITE_TIMEOUT" bash -c "$cmd") >"$log" 2>&1
else
  (cd "$GITHUB_WORKSPACE/$wd" && bash -c "$cmd") >"$log" 2>&1
fi
rc=$?
end=$(date +%s%N)
ms=$(((end - start) / 1000000))

# Strip CRs and ANSI so the detail line survives a JSON round trip.
clean="$SUITE_DIR/$id.clean"
tr -d '\r' <"$log" | sed -e 's/\x1b\[[0-9;?]*[A-Za-z]//g' -e 's/\x1b][^\x07]*\x07//g' >"$clean"

cat "$log"
echo "::endgroup::"

if [ "$rc" -eq 0 ]; then
  status=pass
  detail=$(grep -av '^[[:space:]]*$' "$clean" | tail -1)
else
  status=fail
  detail=$(grep -m1 -aE 'error|Error|ERROR|panic|Panic|[Ff]ailed|[Ff]ailure|[Cc]annot|not supported|[Uu]nsupported|not available|not implemented|ENOENT|EPERM|ENOTSUP|EINVAL|EAGAIN|Segmentation' "$clean")
  if [ -z "$detail" ]; then
    detail=$(grep -av '^[[:space:]]*$' "$clean" | tail -1)
  fi
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    detail="timed out after ${SUITE_TIMEOUT}s; last line: $detail"
  fi
fi
detail=$(printf '%s' "$detail" | cut -c1-400)
[ -n "$detail" ] || detail="(no output)"

printf '%s' "$status" >"$SUITE_DIR/$id.status"
printf '%s' "$ms" >"$SUITE_DIR/$id.ms"
printf '%s' "$detail" >"$SUITE_DIR/$id.detail"

echo "SUITE $id: $status in ${ms}ms (exit $rc)"
echo "SUITE $id detail: $detail"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  mark="pass"
  [ "$status" = pass ] || mark="**fail**"
  esc=$(printf '%s' "$detail" | sed -e 's/|/\\|/g' -e 's/`/'"'"'/g')
  printf '| `%s` | %s | %s | `%s` |\n' "$id" "$mark" "$ms" "$esc" >>"$GITHUB_STEP_SUMMARY"
fi

exit "$rc"
