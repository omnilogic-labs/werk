#!/usr/bin/env bash
# One lane of the matrix experiment: the werk proof of concept on a platform
# the main workflow does not cover (linux-arm64, musl, macOS Intel, Windows
# arm64), plus a smoke of the binaries cross-compiled on Linux.
#
#   .github/ci/matrix.sh machine        record the runner; write the summary header
#   .github/ci/matrix.sh suite <id>     run one suite, record its verdict
#   .github/ci/matrix.sh report         merge the verdicts into ci-result-<lane>.json
#   .github/ci/matrix.sh cleanup        stop leftover daemons and remove their sockets
#
# A suite writes $MATRIX_OUT/suites/<n>-<id>.json, appends a row to
# $GITHUB_STEP_SUMMARY, and exits with the suite's own status; every caller
# sets `continue-on-error`, so one run reports every verdict. Everything here
# is plain bash plus the tools every runner has (no jq, no python, no GNU
# date), because the lanes include Alpine, BSD userland and Git Bash.
#
# Environment, set by the workflow:
#   MATRIX_LANE    linux-arm64-glibc, linux-x64-musl, darwin-x64, win32-arm64, ...
#   MATRIX_OS      linux | alpine | darwin | win32
#   MATRIX_TARGET  the `bun build --compile --target` this lane runs natively
#   MATRIX_OUT     where suites/, logs/ and the result JSON go
#   MATRIX_XBIN    directory holding the cross-compiled `wp` for this target
#   MATRIX_REF     directory holding the Linux x64 diff-summary.json
#   MATRIX_M0      full (bun run m0) | probes (one probe file at a time)

set -uo pipefail

CMD="${1:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
POC="$ROOT/packages/werk-poc"
LANE="${MATRIX_LANE:-unknown}"
OS="${MATRIX_OS:-linux}"
OUT="${MATRIX_OUT:-$ROOT/.matrix-out}"
XBIN_DIR="${MATRIX_XBIN:-$OUT/xbin}"
REF_DIR="${MATRIX_REF:-$OUT/ref}"
# Git Bash: the workflow hands over `D:\a\_temp/...`, which bash can cd into
# but cannot glob (a backslash escapes the next character). Bun and wp get
# Windows paths back through native_path when a path goes in an env var.
if command -v cygpath >/dev/null 2>&1; then
  OUT="$(cygpath -u "$OUT")"
  XBIN_DIR="$(cygpath -u "$XBIN_DIR")"
  REF_DIR="$(cygpath -u "$REF_DIR")"
fi
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
mkdir -p "$OUT/suites" "$OUT/logs"

# The order the suites appear in the artefact and the step summary. Anything
# else that ran is appended after these.
ORDER=(x-help x-caps x-ls x-ldd x-codesign install test-pure build native-codesign diff m0 m3 ops test-full)

# ------------------------------------------------------------------ helpers

# Milliseconds since the epoch. GNU date has %N; BSD date prints a literal N.
now_ms() {
  local n
  n="$(date +%s%N 2>/dev/null)"
  case "$n" in
  *[!0-9]* | "") n="$(($(date +%s) * 1000))" ;;
  *) n=$((n / 1000000)) ;;
  esac
  echo "$n"
}
pretty_ms() { if [ "$1" -lt 1000 ]; then echo "$1 ms"; else echo "$(($1 / 1000)).$((($1 % 1000) / 100)) s"; fi; }

# A JSON string body (no quotes) from stdin: CR and control characters go,
# newlines and tabs become spaces, backslash and quote are escaped.
json_str() {
  tr -d '\r' | tr '\n\t' '  ' | LC_ALL=C tr -d '\000-\010\013-\037\177' |
    LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/[[:space:]]*$//' | tr -d '\n'
}

summary() { if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$1" >>"$GITHUB_STEP_SUMMARY"; fi; }

# Runs a command under a deadline. GNU timeout where it exists (Linux, Alpine,
# Git Bash, brew coreutils); otherwise perl's alarm, which every macOS has.
with_timeout() {
  local secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout -k 10 "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout -k 10 "$secs" "$@"
  else
    perl -e 'my $s = shift; $SIG{ALRM} = sub { kill "TERM", $pid; sleep 5; kill "KILL", $pid; exit 124 }; $pid = fork; if ($pid == 0) { exec @ARGV } alarm $s; waitpid $pid, 0; exit(($? >> 8) || ($? & 127 ? 128 + ($? & 127) : 0))' "$secs" "$@"
  fi
}

# Strip CRs and ANSI escapes so a detail line survives the JSON round trip.
clean_log() {
  local esc
  esc="$(printf '\033')"
  tr -d '\r' <"$1" | LC_ALL=C sed -e "s/$esc\[[0-9;?]*[A-Za-z]//g"
}

# The first line of the log matching a pattern, trimmed to one summary line.
pick() { grep -am1 -E "$1" "$CLEAN" | cut -c1-240; }
count() { grep -acE "$1" "$CLEAN"; }

# What to say about a failure with no better idea: the first line that names
# an error, else the last non-empty line. Skips Bun's code frames.
why() {
  local body d
  body="$(grep -av -e '^[[:space:]]*$' -e '^[[:space:]]*[0-9][0-9]*[[:space:]]*|' -e '^[[:space:]]*\^*$' "$CLEAN")"
  d="$(printf '%s\n' "$body" | grep -m1 -aE '^(error|[A-Za-z]*Error|[A-Z][A-Z]+):|^[[:space:]]*(error|[A-Za-z]*Error):|(EBADF|ENOENT|EPERM|ENOTSUP|EINVAL|EAGAIN|EACCES|ENOSYS|not found|No such file)')"
  if [ -z "$d" ]; then d="$(printf '%s\n' "$body" | grep -m1 -aE 'error|Error|panic|[Ff]ailed|[Cc]annot|not supported|[Uu]nsupported|not available|not implemented|Segmentation|Illegal instruction|Killed')"; fi
  if [ -z "$d" ]; then d="$(printf '%s\n' "$body" | tail -1)"; fi
  printf '%s' "$d" | sed 's/^[[:space:]]*//' | cut -c1-300
}

# `bun test`: the count line, plus the names of the tests that failed.
bun_test_detail() {
  local ran fails
  ran="$(pick 'Ran [0-9]+ tests')"
  if [ -z "$ran" ]; then ran="$(grep -aE '^[[:space:]]*[0-9]+ (pass|fail)$' "$CLEAN" | tr -s ' \n' ' ')"; fi
  fails="$(grep -aE '^\(fail\) ' "$CLEAN" | sort -u | head -3 | paste -sd';' - | cut -c1-200)"
  printf '%s%s' "$ran" "${fails:+ — failing: $fails}"
}

# The cross-compiled binary for this lane, wherever download-artifact put it.
xbin() {
  local d="$XBIN_DIR" f
  for f in "$d/wp.exe" "$d/wp" "$d"/*/wp.exe "$d"/*/wp; do
    if [ -f "$f" ]; then
      chmod +x "$f" 2>/dev/null
      echo "$f"
      return 0
    fi
  done
  return 1
}

native_bin() {
  if [ -f "$POC/dist/wp.exe" ]; then echo "$POC/dist/wp.exe"; else echo "$POC/dist/wp"; fi
}

# The daemon a `wp ls` autostarted, found by the pid its log records, and
# the socket it leaves behind. A daemon on Windows takes no signal — Git
# Bash's `kill` did nothing to it — so it is `taskkill` there, followed by
# any other `wp.exe` still running (the native suites autostart their own).
# The socket matters as much as the process: a Winsock AF_UNIX socket is a
# reparse point that `stat` refuses with EACCES, and upload-artifact refuses
# the whole output directory over one, so every `wp.sock` under the runtime
# dir goes too. Prints what it stopped and removed.
stop_daemon() {
  local dir="$1" pid s
  pid="$(grep -aoE '\(pid [0-9]+' "$dir/werk-poc/wp.log" 2>/dev/null | head -1 | grep -oE '[0-9]+')"
  if [ "$OS" = win32 ]; then
    if [ -n "$pid" ]; then
      MSYS_NO_PATHCONV=1 taskkill /F /PID "$pid" 2>&1 | head -1
    fi
    if MSYS_NO_PATHCONV=1 tasklist /FI "IMAGENAME eq wp.exe" /NH 2>/dev/null | grep -aq wp.exe; then
      MSYS_NO_PATHCONV=1 tasklist /FI "IMAGENAME eq wp.exe" /NH 2>/dev/null | grep -a wp.exe | tr -s ' ' | cut -d' ' -f1-2
      MSYS_NO_PATHCONV=1 taskkill /F /IM wp.exe 2>&1 | head -3
    fi
  elif [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null && echo "stopped daemon pid $pid"
  fi
  for s in "$dir"/werk-poc/wp.sock "$dir"/werk-poc/.wp.sock.*; do
    remove_socket "$s"
  done
}

# A socket file, gone. `-e` and `rm`'s exit status cannot be trusted on the
# Windows reparse point, so the directory listing is what decides.
socket_present() { ls -A "$(dirname "$1")" 2>/dev/null | grep -qxF "$(basename "$1")"; }
remove_socket() {
  local s="$1"
  socket_present "$s" || return 0
  rm -f "$s" 2>/dev/null
  if socket_present "$s" && [ "$OS" = win32 ]; then
    MSYS_NO_PATHCONV=1 cmd /c "del /f /q \"$(native_path "$s")\"" 2>&1 | head -1
  fi
  if socket_present "$s"; then echo "could not remove $s"; else echo "removed $s"; fi
}

# What a musl host has to have before the binary starts: the shared
# libraries it is linked against that are not musl itself, each with its
# size, plus the Alpine packages they come in. The musl loader prints
# "name => path (0xaddr)", so the paths come out of the arrow.
musl_extras() {
  local bin="$1" lib
  ldd "$bin" 2>/dev/null | sed -nE 's/.*=> (\/[^ ]+).*/\1/p' | sort -u |
    while read -r lib; do
      case "$lib" in *musl*) continue ;; esac
      printf 'needs %s (%s bytes)\n' "$lib" "$(wc -c <"$lib" | tr -d ' ')"
    done
  apk info -s libstdc++ libgcc 2>/dev/null | tr '\n' ' '
  echo
}

# codesign, twice: describe, then verify. The verdict is the verify.
codesign_check() {
  local bin="$1"
  echo "\$ codesign -dvv $bin"
  codesign -dvv "$bin" 2>&1
  echo "\$ codesign --verify --strict --verbose=2 $bin"
  codesign --verify --strict --verbose=2 "$bin" 2>&1
  local rc=$?
  echo "codesign --verify exit $rc"
  return $rc
}

# The re-sign a macOS release does, and what it leaves behind. Appending the
# JavaScript bundle invalidates whatever signature the Bun executable arrived
# with, so a fresh `bun build --compile` output never verifies; an ad-hoc
# signature repairs it in one step (findings/platforms.md). Describes the
# binary as it arrived first, so the run records both states.
codesign_sign() {
  local bin="$1"
  echo "\$ codesign -dvv $bin   # as it arrived"
  codesign -dvv "$bin" 2>&1
  echo "\$ codesign --force --sign - $bin"
  codesign --force --sign - "$bin" 2>&1
  local rc=$?
  echo "codesign --force --sign - exit $rc"
  return $rc
}

codesign_detail() {
  local sig verify
  sig="$(grep -am1 -E '^(Signature|Identifier|CodeDirectory)' "$CLEAN" | cut -c1-120)"
  if grep -aq 'code object is not signed' "$CLEAN"; then sig="not signed at all"; fi
  if grep -aq 'Signature=adhoc' "$CLEAN"; then sig="adhoc signature ($(grep -am1 'CodeDirectory' "$CLEAN" | cut -c1-80))"; fi
  verify="$(grep -am1 -E 'valid on disk|satisfies its Designated|invalid|not signed|modified|verify exit' "$CLEAN" | cut -c1-120)"
  printf '%s; verify: %s' "${sig:-?}" "${verify:-?}"
}

# ------------------------------------------------------------------ machine

if [ "$CMD" = "machine" ]; then
  cpus="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo '?')"
  uname_a="$(uname -a 2>/dev/null)"
  case "$OS" in
  alpine) libc="alpine $(cat /etc/alpine-release 2>/dev/null); $(ldd --version 2>&1 | head -1)" ;;
  linux) libc="$(ldd --version 2>&1 | head -1)" ;;
  darwin) libc="macOS $(sw_vers -productVersion 2>/dev/null) (libSystem)" ;;
  win32) libc="windows nt $(bun -e 'console.log(require("node:os").release())' 2>/dev/null || echo '?')" ;;
  esac
  bunv="$(bun --version 2>&1 | head -1 || echo absent)"
  bunarch="$(bun -e 'console.log(process.platform + "-" + process.arch + " " + process.execPath)' 2>&1 | head -1)"
  extra=""
  if [ "$OS" = darwin ]; then
    avx2="$(sysctl -a 2>/dev/null | grep -i avx2 | tr -s ' ' | paste -sd';' - | cut -c1-200)"
    send="$(sysctl net.local.stream.sendspace net.local.stream.recvspace 2>&1 | tr '\n' ' ')"
    extra="avx2: ${avx2:-none reported}; $send; TMPDIR=${TMPDIR:-unset}"
  fi
  if [ "$OS" = alpine ]; then extra="bun from ${BUN_SOURCE:-?}"; fi
  if [ "$OS" = linux ] || [ "$OS" = alpine ]; then
    # Bun's x64 build after 1.3.8 is reported to die with "illegal
    # instruction" on CPUs without AVX2, in the `-baseline` binary too
    # (oven-sh/bun#26353, #27090). Record what this lane's CPU offers, so
    # what the fleet has actually run on is on the record.
    simd="$(grep -m1 -aE '^(flags|Features)[[:space:]]*:' /proc/cpuinfo 2>/dev/null | tr ' ' '\n' | grep -axE 'avx|avx2|avx512f' | paste -sd, -)"
    extra="${extra:+$extra; }cpu simd: ${simd:-no avx, avx2 or avx512f in /proc/cpuinfo}"
  fi
  {
    printf '{"lane":"%s","os":"%s","target":"%s","runner":"%s","image":"%s","cpus":"%s","uname":"%s","libc":"%s","bun":"%s","bunProcess":"%s","extra":"%s"}' \
      "$(printf '%s' "$LANE" | json_str)" "$OS" "$(printf '%s' "${MATRIX_TARGET:-}" | json_str)" \
      "$(printf '%s' "${RUNNER_NAME:-?} ${RUNNER_OS:-?}/${RUNNER_ARCH:-?}" | json_str)" \
      "$(printf '%s' "${ImageOS:-?}/${ImageVersion:-?}" | json_str)" \
      "$(printf '%s' "$cpus" | json_str)" "$(printf '%s' "$uname_a" | json_str)" "$(printf '%s' "$libc" | json_str)" \
      "$(printf '%s' "$bunv" | json_str)" "$(printf '%s' "$bunarch" | json_str)" "$(printf '%s' "$extra" | json_str)"
  } >"$OUT/machine.json"
  cat "$OUT/machine.json"
  echo
  summary "## $LANE (\`${MATRIX_TARGET:-}\`)"
  summary ""
  summary "\`$uname_a\`"
  summary ""
  summary "cpus $cpus · $libc · bun $bunv ($bunarch)${extra:+ · $extra}"
  summary ""
  summary "| Suite | Result | Time | Detail |"
  summary "| --- | --- | --- | --- |"
  exit 0
fi

# ------------------------------------------------------------------- report

if [ "$CMD" = "report" ]; then
  result="$OUT/ci-result-$LANE.json"
  {
    printf '{"lane":"%s","os":"%s","target":"%s","bun":"%s","commit":"%s","machine":' \
      "$(printf '%s' "$LANE" | json_str)" "$OS" "$(printf '%s' "${MATRIX_TARGET:-}" | json_str)" \
      "$(bun --version 2>/dev/null | head -1 | json_str)" "${GITHUB_SHA:-unknown}"
    if [ -f "$OUT/machine.json" ]; then cat "$OUT/machine.json"; else printf 'null'; fi
    printf ',"suites":['
    first=1
    seen=""
    for id in "${ORDER[@]}"; do
      f="$(ls "$OUT/suites/"*"-$id.json" 2>/dev/null | head -1)"
      if [ -z "$f" ]; then continue; fi
      [ $first -eq 1 ] || printf ','
      first=0
      cat "$f"
      seen="$seen $id"
    done
    for f in "$OUT/suites/"*.json; do
      [ -f "$f" ] || continue
      id="$(basename "$f" .json | sed 's/^[0-9]*-//')"
      case " $seen " in *" $id "*) continue ;; esac
      [ $first -eq 1 ] || printf ','
      first=0
      cat "$f"
    done
    printf ']}\n'
  } >"$result"
  echo "--- $(basename "$result")"
  cat "$result"
  # A JSON that does not parse is worse than a red step.
  if command -v bun >/dev/null 2>&1; then
    bun -e 'const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); console.log(`ok: ${j.suites.length} suites`)' "$result" || exit 1
  fi
  {
    echo
    echo "<details><summary>$(basename "$result")</summary>"
    echo
    echo '```json'
    cat "$result"
    echo '```'
    echo
    echo '</details>'
  } >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 0
fi

# ------------------------------------------------------------------ cleanup

# Before the upload: whatever daemon a suite left running, and any socket
# under the output directory, which upload-artifact cannot even stat on
# Windows. Says what it found; exits 0 either way.
if [ "$CMD" = "cleanup" ]; then
  stop_daemon "$OUT/xrt"
  for s in $(find "$OUT" \( -name 'wp.sock' -o -name '.wp.sock.*' \) 2>/dev/null); do
    remove_socket "$s"
  done
  if [ "$OS" = win32 ] && MSYS_NO_PATHCONV=1 tasklist /FI "IMAGENAME eq wp.exe" /NH 2>/dev/null | grep -aq wp.exe; then
    echo "wp.exe still running after cleanup"
  fi
  echo "cleanup done"
  exit 0
fi

# ------------------------------------------------------------------- suites

if [ "$CMD" != "suite" ] || [ -z "${2:-}" ]; then
  echo "usage: matrix.sh machine | suite <id> | report | cleanup" >&2
  exit 2
fi
SUITE="$2"
LOG="$OUT/logs/$SUITE.log"
CLEAN="$OUT/logs/$SUITE.clean"
: >"$LOG"
NAME="$SUITE"
DETAIL=""
SECS=600
DIR="$POC"

# What each suite runs, as a shell command string, so the deadline wraps it
# whole. The verdict logic below reads the log afterwards.
case "$SUITE" in
x-help)
  NAME="cross-compiled wp --help"
  SECS=60
  DIR="$OUT"
  BIN="$(xbin)" || true
  SCRIPT="test -n '$BIN' || { echo 'no cross-compiled binary downloaded for ${MATRIX_TARGET:-?}'; exit 1; }; ls -l '$BIN'; '$BIN' --help"
  ;;
x-caps)
  NAME="cross-compiled wp caps"
  SECS=120
  DIR="$OUT"
  BIN="$(xbin)" || true
  SCRIPT="test -n '$BIN' || exit 1; '$BIN' caps"
  ;;
x-ls)
  NAME="cross-compiled wp ls (autostarts a daemon)"
  SECS=90
  DIR="$OUT"
  BIN="$(xbin)" || true
  mkdir -p "$OUT/xrt" "$OUT/xst"
  XDG_RUNTIME_DIR="$(native_path "$OUT/xrt")"
  WP_STATE_DIR="$(native_path "$OUT/xst")"
  export XDG_RUNTIME_DIR WP_STATE_DIR
  # When `ls` could not even reach a daemon log, start the daemon directly so
  # its own first error is on record rather than the client's.
  SCRIPT="test -n '$BIN' || exit 1; $(declare -f with_timeout); '$BIN' ls; rc=\$?; echo '--- wp.log'; if ! cat '$OUT/xrt/werk-poc/wp.log' 2>/dev/null; then echo '(no wp.log; starting the daemon directly)'; mkdir -p '$OUT/xrt/werk-poc'; with_timeout 20 '$BIN' __daemon --dir='$(native_path "$OUT/xrt/werk-poc")'; echo \"__daemon exit \$?\"; fi; exit \$rc"
  ;;
x-ldd)
  NAME="ldd on the cross-compiled wp, and what it needs beyond musl"
  SECS=60
  DIR="$OUT"
  BIN="$(xbin)" || true
  SCRIPT="test -n '$BIN' || exit 1; file '$BIN' 2>/dev/null; ldd '$BIN'; echo '--- beyond musl'; $(declare -f musl_extras); musl_extras '$BIN'"
  ;;
x-codesign)
  NAME="ad-hoc re-sign of the cross-compiled wp, then codesign --verify"
  SECS=60
  DIR="$OUT"
  BIN="$(xbin)" || true
  # The binary arrives from a Linux job that cannot sign anything, so this
  # lane does what a release would do on the macOS side and verifies that.
  SCRIPT="test -n '$BIN' || exit 1; $(declare -f codesign_sign); $(declare -f codesign_check); codesign_sign '$BIN' || exit 1; codesign_check '$BIN'"
  ;;
native-codesign)
  NAME="codesign on the natively compiled wp"
  SECS=60
  BIN="$(native_bin)"
  SCRIPT="test -f '$BIN' || { echo 'no native dist/wp (build failed?)'; exit 1; }; $(declare -f codesign_check); codesign_check '$BIN'"
  ;;
install)
  NAME="bun install --frozen-lockfile (packages/werk-poc)"
  SECS=300
  SCRIPT="bun install --frozen-lockfile"
  ;;
test-pure)
  NAME="bun test src/engine src/protocol"
  SECS=300
  SCRIPT="bun test src/engine src/protocol"
  ;;
build)
  NAME="bun run build, then wp --help and wp caps (native)"
  SECS=600
  # macOS: the compiled binary is re-signed on the way out of the build, so
  # `native-codesign` verifies what a release would ship rather than what
  # `bun build --compile` happens to leave behind.
  SIGN=""
  if [ "$OS" = darwin ]; then SIGN="$(declare -f codesign_sign); codesign_sign \"\$WP\" || exit 1;"; fi
  SCRIPT="bun run build || exit 1; ls -l dist; WP=dist/wp; test -f dist/wp.exe && WP=dist/wp.exe; echo \"binary: \$WP (\$(wc -c <\"\$WP\") bytes)\"; $SIGN \"./\$WP\" --help || exit 1; echo '--- caps ---'; \"./\$WP\" caps"
  ;;
diff)
  NAME="differential corpus + fuzz 200/seed 11, normalised summary diffed against linux-x64"
  SECS=600
  SCRIPT="bun '$ROOT/.github/ci/matrix-summary.ts' '$OUT/diff-summary.json'"
  ;;
m0)
  if [ "${MATRIX_M0:-full}" = probes ]; then
    NAME="m0 PTY probes, one file at a time (M0_LAT_N=200)"
    SECS=600
    export M0_LAT_N=200
    SCRIPT='rc=0; for p in spikes/m0/0*.ts; do echo "===== $p"; bun run "$p" || rc=1; done; echo "--- verdicts ---"; exit $rc'
  else
    NAME="bun run m0 (PTY probes, interpreted and compiled)"
    SECS=900
    SCRIPT="bun run m0"
  fi
  ;;
m3)
  NAME="bun run m3 (snapshot cost, cross-commit decode)"
  SECS=600
  SCRIPT="bun run m3"
  ;;
ops)
  NAME="bun run bench/ops.ts --quick --no-compile"
  SECS=300
  SCRIPT="bun run bench/ops.ts --quick --no-compile"
  ;;
test-full)
  NAME="bun test (whole package), 10-minute deadline"
  SECS=600
  SCRIPT="bun test"
  ;;
*)
  echo "matrix.sh: unknown suite '$SUITE'" >&2
  exit 2
  ;;
esac

echo "::group::$SUITE — $NAME (cwd ${DIR#"$ROOT"/}, ${SECS}s)"
T0="$(now_ms)"
(cd "$DIR" && with_timeout "$SECS" bash -c "$SCRIPT") >"$LOG" 2>&1
CODE=$?
MS=$(($(now_ms) - T0))
clean_log "$LOG" >"$CLEAN"
cat "$CLEAN"
echo "::endgroup::"
STATUS=pass
[ "$CODE" -eq 0 ] || STATUS=fail

# ------------------------------------------------------ verdict per suite

case "$SUITE" in
x-help)
  if [ "$CODE" -eq 0 ]; then DETAIL="usage printed, $(grep -ac '' "$CLEAN") lines; binary is $(wc -c <"$BIN" | tr -d ' ') bytes"; else DETAIL="$(why)"; fi
  ;;
x-caps | build)
  if [ "$CODE" -eq 0 ] && grep -aq 'did not load' "$CLEAN"; then
    STATUS=fail
    DETAIL="caps: $(pick 'did not load')"
  elif [ "$CODE" -eq 0 ]; then
    DETAIL="caps lists $(grep -acE '^\| `' "$CLEAN") matrix rows; engines: $(grep -am1 -E '^\| Capability' "$CLEAN" | grep -oE '`[a-z-]+`' | tr -d '`' | paste -sd',' -)"
    if [ "$SUITE" = build ]; then DETAIL="dist/wp built; $DETAIL"; fi
  else
    DETAIL="$(why)"
  fi
  ;;
x-ls)
  if [ "$CODE" -eq 0 ]; then
    DETAIL="daemon started; ls printed: $(head -1 "$CLEAN" | tr -s ' ' | cut -c1-80); $(grep -am1 'listening on' "$CLEAN" | sed 's/^[^ ]* //' | cut -c1-120)"
  else
    DETAIL="$(why)"
    d2="$(sed -n '/^(no wp.log/,$p' "$CLEAN" | grep -av -e '^[[:space:]]*$' -e '^[[:space:]]*[0-9][0-9]*[[:space:]]*|' -e '^[[:space:]]*\^*$' -e '^(no wp.log' -e '^__daemon exit' -e '^ *at ' | head -2 | paste -sd';' - | cut -c1-200)"
    [ -z "$d2" ] || DETAIL="$DETAIL | __daemon directly: $d2"
  fi
  stop_daemon "$OUT/xrt" | tee -a "$LOG"
  ;;
x-ldd)
  if [ "$CODE" -eq 0 ]; then
    DETAIL="ldd: $(grep -a -E '=>|statically|not a dynamic|ld-musl|Not a valid' "$CLEAN" | grep -av '^/' | sed -E 's/ \(0x[0-9a-f]+\)//' | tr -s ' \t' ' ' | paste -sd';' - | cut -c1-220); beyond musl: $(grep -a '^needs ' "$CLEAN" | sed 's/^needs //' | paste -sd';' - | cut -c1-160); file: $(grep -am1 'ELF' "$CLEAN" | sed -E 's/^[^:]*: //; s/, BuildID.*//' | cut -c1-120)"
  else
    DETAIL="ldd exit $CODE: $(grep -av '^[[:space:]]*$' "$CLEAN" | tail -2 | paste -sd';' - | cut -c1-300)"
  fi
  ;;
x-codesign | native-codesign)
  DETAIL="$(codesign_detail)"
  ;;
install)
  DETAIL="$(pick '[0-9]+ packages installed|Checked [0-9]+ package')"
  [ -n "$DETAIL" ] || DETAIL="$(why)"
  ;;
test-pure | test-full)
  DETAIL="$(bun_test_detail)"
  if [ "$CODE" -eq 124 ] || [ "$CODE" -eq 137 ]; then DETAIL="timed out after ${SECS}s; ${DETAIL:-last: $(why)}"; fi
  [ -n "$DETAIL" ] || DETAIL="$(why)"
  ;;
diff)
  ref="$REF_DIR/diff-summary.json"
  [ -f "$ref" ] || ref="$(ls "$REF_DIR"/*/diff-summary.json 2>/dev/null | head -1)"
  engines="$(pick '^SUMMARY:' | sed 's/^SUMMARY: //')"
  if [ "$CODE" -ne 0 ]; then
    DETAIL="$(why)"
  elif [ -z "$ref" ] || [ ! -f "$ref" ]; then
    STATUS=fail
    DETAIL="no linux-x64 reference summary to compare against; $engines"
  elif diff -u "$ref" "$OUT/diff-summary.json" >"$OUT/diff-summary.diff" 2>&1; then
    DETAIL="identical to linux-x64: $engines"
  else
    STATUS=fail
    n="$(grep -cE '^[-+][^-+]' "$OUT/diff-summary.diff")"
    firstline="$(grep -aE '^[-+][^-+]' "$OUT/diff-summary.diff" | head -2 | tr -s ' ' | paste -sd' ' - | cut -c1-160)"
    DETAIL="differs from linux-x64 in $n lines ($engines); first: $firstline"
    echo "--- diff against linux-x64 summary (first 60 lines)" | tee -a "$LOG"
    head -60 "$OUT/diff-summary.diff" | tee -a "$LOG"
  fi
  ;;
m0)
  if [ "${MATRIX_M0:-full}" = probes ]; then
    total="$(count '^RESULT ')"
    passed="$(grep -a '^RESULT ' "$CLEAN" | grep -ac '"status":"pass"')"
    bad="$(grep -a '^RESULT ' "$CLEAN" | grep -av '"status":"pass"' | sed -e 's/.*"probe":"\([^"]*\)".*"status":"\([^"]*\)".*"summary":"\([^"]*\)".*/\1 \2: \3/' | head -3 | paste -sd';' - | cut -c1-200)"
    DETAIL="$passed/$total probes pass (interpreted only)${bad:+; not passing: $bad}"
    [ "$total" -gt 0 ] || DETAIL="$(why)"
  else
    RESULTS="$POC/dist/m0/results.json"
    if [ "$CODE" -eq 0 ] && [ -f "$RESULTS" ]; then
      parsed="$(bun -e '
        const d = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
        let total = 0, pass = 0; const bad = [];
        for (const [p, cells] of Object.entries(d.results)) for (const [c, v] of Object.entries(cells)) {
          total++; if (v.status === "pass") pass++; else bad.push(`${p} [${c}]: ${v.status} — ${v.summary}`);
        }
        console.log(`${pass}/${total} probe cells pass across ${d.columns.join(", ")}` + (bad.length ? `; first problem: ${bad[0]}` : ""));
        process.exit(bad.length ? 1 : 0);
      ' "$RESULTS" 2>&1)"
      rc=$?
      DETAIL="$parsed"
      [ $rc -eq 0 ] || STATUS=fail
    elif [ "$CODE" -eq 0 ]; then
      STATUS=fail
      DETAIL="run-all.ts exited 0 but wrote no dist/m0/results.json"
    else
      DETAIL="$(why)"
    fi
  fi
  ;;
m3)
  if [ "$CODE" -eq 0 ]; then
    DETAIL="snapshot-cost and cross-commit ran; $(count 'not on disk') ghostty tip builds not on disk"
  else
    DETAIL="$(why)"
  fi
  ;;
ops)
  awk '/^## Platform matrix/{f = 1; print; next} /^## /{f = 0} f' "$CLEAN" >"$OUT/ops-platforms.txt"
  if [ "$CODE" -eq 0 ]; then
    ffi="$(grep -am1 '^| ghostty-ffi' "$OUT/ops-platforms.txt" | cut -d'|' -f3 | xargs)"
    DETAIL="toolchain, platform matrix and cold start reported; ghostty-ffi prebuilds: ${ffi:-none found}"
  else
    DETAIL="$(why)"
  fi
  ;;
esac

if [ "$CODE" -eq 124 ] || [ "$CODE" -eq 137 ]; then
  case "$DETAIL" in "timed out"*) ;; *) DETAIL="timed out after ${SECS}s; ${DETAIL:-$(why)}" ;; esac
fi
DETAIL="$(printf '%s' "${DETAIL:-(no output)}" | tr '\n' ' ' | cut -c1-400)"

idx=99
for i in "${!ORDER[@]}"; do
  if [ "${ORDER[$i]}" = "$SUITE" ]; then idx=$i; fi
done
printf '{"id":"%s","name":"%s","status":"%s","ms":%s,"exit":%s,"detail":"%s"}' \
  "$SUITE" "$(printf '%s' "$NAME" | json_str)" "$STATUS" "$MS" "$CODE" "$(printf '%s' "$DETAIL" | json_str)" \
  >"$OUT/suites/$(printf '%02d' "$idx")-$SUITE.json"

echo
echo "==> $SUITE: $STATUS in ${MS} ms (exit $CODE) — $DETAIL"
mark=$([ "$STATUS" = pass ] && echo ':white_check_mark: pass' || echo ':x: fail')
summary "| \`$SUITE\` | $mark | $(pretty_ms "$MS") | $(printf '%s' "$DETAIL" | sed -e 's/|/\\|/g' -e 's/`/'"'"'/g' | cut -c1-300) |"

[ "$STATUS" = pass ]
