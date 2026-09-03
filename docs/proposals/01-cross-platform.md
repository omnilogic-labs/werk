# 01 — One binary on three operating systems

> **Status:** a proposal for how the stack that
> [`00-stack-proof-of-concept.md`](00-stack-proof-of-concept.md) tested —
> TypeScript on Bun, one `bun build --compile` binary, libghostty-vt embedded
> as upstream's WebAssembly build — gets to run on macOS, Windows and Linux.
> It is prescriptive about the mechanisms in §2 and about what to measure
> before believing anything in §1. It does not settle whether Windows is a
> host; that is [`../product/04-open-questions.md`](../product/04-open-questions.md)
> §4, and §6 here only says what the measurements do to it. Where a
> statement is a measurement it names the run; where it is a lean it says so.

## What this exists to decide

The proof of concept found that the stack holds on linux-x64-glibc.
[`../../packages/werk-poc/findings/platforms.md`](../../packages/werk-poc/findings/platforms.md)
then ran the same suites on hosted macOS and Windows runners, and a set of
spikes ran them on every other target Bun can compile for. The shape of the
result is what makes this proposal short: **the terminal engine is not where
the platform work is.** The wasm engine produced byte-identical differential
reports on all eight targets where it ran, the daemon runs from a
cross-compiled binary on every non-Windows one, and on Windows the PTY works.
What differs per platform is the thin layer around the daemon — how it locks,
how it announces readiness, how it detaches, where its socket lives, what a
signal means — and the wrapper around the binary: signing, socket buffers,
the C++ runtime a musl host has to carry.

So the proposal is: keep one codebase and one engine, isolate the daemon's
platform layer behind a small seam, build every target from one Linux job,
and prove each target on its own native hosted runner rather than by
argument. Everything below is that seam, that matrix, or what is still
unknown.

---

## 1. Where the platform work actually is

Every "measured" cell names a run in §7. A cell is a claim until it does.

| Target            | Runner             | wasm engine, differential | Daemon from a cross-compiled binary                         | PoC suites                                                           |
| ----------------- | ------------------ | ------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| linux-x64-glibc   | `ubuntu-24.04`     | reference                 | starts, answers `ls`                                        | all pass but the slow-client scenario                                |
| linux-arm64-glibc | `ubuntu-24.04-arm` | identical                 | starts, answers `ls`                                        | same                                                                 |
| linux-x64-musl    | Alpine 3.22        | identical                 | starts, answers `ls`                                        | same; the binary needs `libstdc++` and `libgcc_s` there              |
| linux-arm64-musl  | Alpine 3.22 on arm | identical                 | starts, answers `ls`                                        | same                                                                 |
| darwin-arm64      | `macos-latest`     | identical                 | starts, answers `ls`                                        | same as Linux                                                        |
| darwin-x64        | `macos-15-intel`   | identical                 | starts, answers `ls`                                        | same; no ffi prebuild exists, so ffi tests fail                      |
| win32-x64         | `windows-latest`   | identical                 | starts, answers `ls` (§3)                                   | reattach fidelity holds; `m0-probes`, `test-full` and `m2` fail (§3) |
| win32-arm64       | `windows-11-arm`   | identical                 | starts, answers `ls`, refuses a second daemon; no `bun:ffi` | as x64, plus no ffi engine at all in Bun 1.3.14                      |

Three things the table says that the research did not expect:

- **The optional ffi engine is the only part with a platform matrix**, and it
  is missing on two of the eight targets (`darwin-x64` does not build without
  a macOS SDK; `win32-arm64` has no `bun:ffi` in Bun 1.3.14). Since the wasm
  engine was faster than the ffi one on the only machine both were measured
  on ([`m6.md`](../../packages/werk-poc/findings/m6.md)), the matrix is a cost
  without a measured benefit. This proposal treats wasm as the engine on every
  target and the ffi build as reference material.
- **The musl Bun is not static.** Both Alpine lanes show the compiled binary
  linked against `libstdc++.so.6` and `libgcc_s.so.1`, and on a bare
  `alpine:3.22` it never reaches its own code. That matters if werk runs
  inside containers it provisions: the image has to carry them, or the
  release has to carry them beside the binary, or the binary has to be a
  glibc one on a glibc base. §5 has the sizes.
- **Windows is not blocked by the PTY.** Three small things in the daemon
  layer stood in the way; §3 records where the lane stands with them done
  the Windows way.

## 2. The seam: a platform layer the daemon goes through

Every platform difference the daemon reaches for goes through one module,
[`src/platform/`](../../packages/werk-poc/src/platform), with one
implementation per OS — `posix.ts` and `win32.ts` — behind a common
interface. Nothing outside that directory reads `process.platform`; a call
site that needs a difference asks for a method, and a difference with no
method is a missing row rather than a branch to write inline. That is what
the module buys: before it, the same `alive()` was copied three times with
the same darwin branch, there were two different definitions of "am I running
compiled" (one wrong on Windows, where the embedded path uses backslashes),
and `/proc` reads returned `false` for every live process on any other OS.

The surface, from what the PoC and the spikes actually needed. The rows with
no implementation yet are marked; they are what §8's later steps fill in:

| Concern              | POSIX                                                                                      | Windows                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `lock(dir)`          | `flock(LOCK_EX\|LOCK_NB)` via `bun:ffi`                                                    | `CreateFileW` + `LockFileEx` via `bun:ffi`; where `bun:ffi` is absent, an exclusive named pipe       |
| `runtimeDir()`       | `$XDG_RUNTIME_DIR` → `$TMPDIR/werk-$UID`, mode checked                                     | `%LOCALAPPDATA%\werk`; mode and uid checks skipped (Bun reports `40666` and no uid)                  |
| `stateDir()`         | `$XDG_STATE_HOME` → `~/.local/state/werk`                                                  | `%LOCALAPPDATA%\werk\state`                                                                          |
| `listen()`           | `AF_UNIX` under `runtimeDir()`, bind-and-rename, `chmod 0600`                              | `AF_UNIX` works for a Bun client; a stale socket has to be unlinked first, and has no mode (§3)      |
| the socket's reach   | anything that can open the path                                                            | Bun only, unless the daemon also lands on `127.0.0.1:<port>` with a token file — measured, open (§3) |
| `spawnDaemon()`      | `detached: true` (`setsid`), `cwd: /`                                                      | `detached: true, windowsHide: true`, stdio ignored, `cwd` the home directory                         |
| readiness            | connect and complete `hello` within a deadline                                             | the same; the failure reason comes from the daemon's log file                                        |
| `compiled`           | `import.meta.path` starts `/$bunfs/`                                                       | the virtual drive `B:\~BUN\`, and the path arrives with backslashes                                  |
| `isAlive(pid)`       | `kill(pid, 0)`, then `/proc/<pid>/stat` — `ps -o state=` on macOS — so a zombie reads dead | `kill(pid, 0)` (works in Bun on Windows); there are no zombies to exclude                            |
| `rss(pid)`           | `/proc/<pid>/status`, or `ps -o rss=` on macOS                                             | `process.memoryUsage()`, so only for this process                                                    |
| `cpuModel()`         | `machdep.cpu.brand_string` on macOS, `/proc/cpuinfo` on Linux                              | libuv's own `os.cpus()`                                                                              |
| `onShutdownSignal()` | `SIGTERM`/`SIGINT`/`SIGHUP`, each ending in the same graceful shutdown                     | nothing to register: no console-control event reaches a detached daemon                              |
| `terminate(pid)`     | `SIGKILL`, when the `shutdown` message's grace has run out                                 | `TerminateProcess`, for the same reason                                                              |
| `signalsExits`       | true: an exit status names the signal that ended a process                                 | false: Bun echoes back the name `proc.kill` was passed, and reports it for a `TerminateProcess`      |
| `adoptTree(child)`   | the child's process group, which the inline `terminal` makes it the leader of              | a Job Object with `KILL_ON_JOB_CLOSE`, joined by inheritance; the child alone where there is no ffi  |
| tree `interrupt()`   | `SIGINT` to that group                                                                     | `0x03` into the ConPTY; what dies of it is up to the child's runtime                                 |
| tree `kill()`        | `SIGTERM` or `SIGKILL` to that group                                                       | `TerminateJobObject`, which takes the descendants with it                                            |
| socket buffers       | Linux default 208 KiB; macOS 8 KiB, raised via `setsockopt` on the listener's `fd`         | unmeasured, so the kernel's own figure stands                                                        |
| `defaultShell()`     | _not implemented:_ `$SHELL` → `/bin/sh`                                                    | _not implemented:_ probably config → `pwsh` → Windows PowerShell → `%COMSPEC%`; nobody has decided   |

Two things the table does not say. The environment overrides that name a
directory outright — `XDG_RUNTIME_DIR`, `XDG_STATE_HOME`, `WP_STATE_DIR`,
`WP_SNDBUF` — are read once, portably, above the seam, so a directory named
in the environment is honoured wherever werk runs and only the fallback is a
row. And the two implementations are POSIX and Windows, so a difference
_within_ POSIX has no column: BSD against GNU `ps` keywords, `script(1)`'s
flags, `/dev/pts/N` against `/dev/ttysNNN`. Those live inside whichever
method needs them, and in the M0 probes, which exist to measure exactly those
primitives and so cannot go through an abstraction of them.

Two rows are worth a sentence each.

**Readiness is the same on all three.** The PoC's launcher already treated
"connect and complete `hello` within a deadline" as the authority, and the
fourth-stdio-slot pipe was only a faster route to the failure reason. On
Windows the parent's end of that pipe is a raw HANDLE that nothing in Bun
1.3.14 can read (every method was tried; see §3). Dropping the pipe
everywhere and sending the failure reason through the daemon's log makes the
three OSes identical and costs nothing measurable. The spike used a ready
file instead of the pipe, which also works; either is fine, and one of them
should be the same on all three.

**Teardown is a protocol message on all three.** A detached Windows daemon
has no console, so no console-control event can reach it and every
`proc.kill(signal)` is `TerminateProcess` regardless of the name passed —
Bun still reports the requested `signalCode` (run 33704743713), which is
misleading. So the `shutdown` message is the way in on every platform, and a
`kill` carries a mode — interrupt, terminate or force — rather than a signal
name. Signals stay a second route into the daemon's shutdown on POSIX,
because `kill` typed at a shell is a real thing and the snapshot suite sends
one; nothing on Windows registers a handler, since nothing could fire it. A
POSIX signal name on a `kill` still says what it always said and is still
the signal that gets sent; on Windows it names a mode and nothing else.

## 3. Windows, specifically

The proof of concept carries the Windows rows of §2 as `win32` branches
([PR #3](https://github.com/omnilogic-labs/werk/pull/3)). With them, on the
Windows lane of `main` (run 33696942295), `wp.exe ls` starts a daemon and
prints its header, the orphan-survival probe passes, and the test suite runs
far enough to hit questions rather than blockers:

- **The stream is re-encoded, so the oracle has to be the grid.** ConPTY
  rewrites what a child writes rather than passing the bytes on, which
  [`../research/07-packaging.md`](../research/07-packaging.md) §4 expected and
  the `probes` suite now measures on every run. A shell that echoes `echo hi`
  sends it back wrapped in bracketed-paste toggles and an OSC 0 title, never
  as the `echo hi CR LF hi CR LF` a POSIX pty sends, so a PoC assertion
  naming a byte sequence cannot hold. Six sessions of the same input leave
  identical cells and an identical cursor, the same hash across separate
  jobs, while their byte streams are usually but not always identical: one
  session in six put the bracketed-paste toggles before the echoed line
  rather than after it, at the same length. A recorded prologue therefore
  could not carry the fidelity guarantee and the grid can, which is what the
  PoC's assertions compare.
- **Kill semantics.** Nothing is delivered as a signal, so the daemon reports
  none: a `kill` is a mode, a session records how the platform carried it out,
  and a Windows exit says `exitCode` 1 with no `signalCode`. The tree comes
  from a Job Object — see below.
- **A ConPTY carries about 20 KiB/s.** A 4 MiB flood does not finish inside a
  minute: 1.0–1.3 MiB of it reaches the reader in 60 s, against about
  99 MiB/s through a session on Linux. Every PoC assertion that pushes
  megabytes through a session — the daemon's slow-client rule, the
  snapshot lag-resume — times out on that alone, and it bounds what a
  Windows-hosted session can do under load as firmly as the latency does.
- **A timed-out test takes `bun test` down.** When a test in `daemon.test.ts`
  times out, Bun 1.3.14 kills the daemon the file started ("killed 1 dangling
  process"), the client's next request rejects with "connection closed", and
  the process then panics with a segmentation fault. In a single `bun test`
  that costs every file the runner had not reached yet, so the Windows lane
  runs the files one process at a time; with the timing-out test filtered
  out, the same file reaches a verdict.
- **A socket path can be too long for Winsock.** `bench/ops.ts` named a
  runtime directory after the target it was timing, which put the daemon's
  socket 116 characters under `%TEMP%`; the daemon exited 1 saying it had
  failed to listen, and the seam's readiness detail is what carried that back
  (run 33704932420). At 75 characters it binds. An AF_UNIX path is bounded at
  108 bytes on Linux and 104 on macOS; nobody has measured where Winsock's
  bound falls.

Three verdicts the Windows lane's suites report are artefacts of how the
suites measure, not platform facts; the spike measured each directly:

- The socket file **does** exist. `Bun.listen({ unix })` on Windows is a
  Winsock `AF_UNIX` socket whose path is a reparse point; Bun's `existsSync`,
  `lstat` and `stat` all fail on it (`EACCES`), while a directory listing
  shows it as a symlink. A stale one refuses rebinding until unlinked, and
  the lock is probably what should prove it stale.
- The detached daemon **does** survive its parent's ConPTY closing. The old
  scenario judged liveness by MSYS `ps` reporting `sid == pid`, which it
  never does for a native process. Judged by a tick file and `kill(pid, 0)`,
  the daemon is alive six seconds after `terminal.close()`; the parent
  itself dies of the close, with exit code 58.
- `sleep` **does** die of `0x03`. MSYS reports signal death as
  `signal << 8` (0x200) and Bun truncates the exit status to a byte, so it
  reads as 0. `GetExitCodeProcess` via ffi says 512. A bash trap fires; a
  `pwsh -c Start-Sleep` ignores `0x03` for at least six seconds.

Four Bun-on-Windows facts the spike found the hard way, recorded so nobody
finds them again:

- A `u32` argument in `bun:ffi` given a negative JavaScript number arrives
  as 0. `GENERIC_READ | GENERIC_WRITE` is negative in JavaScript; use
  `FILE_GENERIC_READ | FILE_GENERIC_WRITE` (0x12019F).
- `_get_osfhandle` from `ucrtbase.dll` on a Bun file descriptor kills the
  process with exit 9 and no message; Bun's CRT is not `ucrtbase`. Open files
  with `CreateFileW` directly when a HANDLE is needed.
- `import.meta.path` inside a compiled Windows binary is `B:\~BUN\root\…`
  with backslashes. A check for `B:/~BUN/` makes `wp.exe` believe it is
  interpreted and relaunch its daemon the wrong way.
- On `windows-11-arm` in Bun 1.3.14 the `bun:ffi` module imports and every
  `dlopen` through it throws "bun:ffi dlopen() is not available in this
  build (TinyCC is disabled)"; it is fixed upstream after 1.3.14. Anything
  Windows does through ffi needs a non-ffi fallback there, so the lock falls
  back to an exclusive `\\.\pipe\` name, which is the lock the `win32-arm64`
  lane's daemon holds (run 33696944598), and the session tree falls back to
  the child alone. **The pipe refuses a second taker on the platform that
  has no alternative.** A second `wp __daemon` against a live one exits 1
  saying another daemon holds the lock, the socket is still the first
  daemon's, and the name comes back about 100 ms after the holder is killed
  — from the source and from the compiled binary alike, natively on
  `win32-arm64` and with the pipe forced on `win32-x64` (runs 33712812822
  and 33713142782, reproduced). The `lock` suite asks it on every matrix
  run rather than once.
- One `expect(promise).rejects` hangs under `bun test` on Windows. The same
  request answers in under a millisecond when its rejection is caught, and
  hangs to the test's timeout when it is asserted that way; `bun test` then
  kills the daemon, so every later test in the file says `connection closed`
  (run 33707210922). Other `expect().rejects` in the same suites pass, so
  this is not a blanket "`rejects` is broken"; what separates them is not
  known. That one line was all of the kill test's five seconds.

**A session's tree is a Job Object.** A ConPTY child can be assigned to one
from Bun, and `TerminateJobObject` — or dropping the last handle to a job
carrying `KILL_ON_JOB_CLOSE` — takes the child and its descendants in two or
three milliseconds. The daemon is itself already inside a job on a hosted
runner and the nested assign still succeeds. So tree kill on Windows needs no
native helper on `win32-x64`; on `win32-arm64` there is no `bun:ffi` and the
kill is `TerminateProcess` on the child alone, which loses anything that has
left the ConPTY behind. Both are run 33706263111.

**The socket, beyond Bun.** A Windows `AF_UNIX` socket is reachable from Bun
and from little else werk cares about: Node reaches only `\\.\pipe\` names,
and Win32-OpenSSH forwards neither sockets nor pipes in either direction —
its client refuses the spelling outright, `Bad local forwarding
specification`, before it opens a connection — and has no ControlMaster. So a
Windows client of a remote daemon, or a Node-based tool talking to a local
one, needs the daemon to be listening on `127.0.0.1:<port>` as well, with the
port and a random token in a file the runtime directory keeps to this user.

Both now exist and both are measured
([`../../packages/werk-poc/findings/m5.md`](../../packages/werk-poc/findings/m5.md),
run 33713970573): the daemon carries the loopback landing behind
`WP_TCP_LISTEN`, off by default, and the two transports are within noise of
each other on the same machine — 0.01 against 0.02 ms per round trip, 2.1
against 2.6 GiB/s one way, the same 128 KiB before the first short write. So
the choice is not about speed. It is about who can reach the daemon (`ssh
-L` and Node can reach a port and cannot reach the socket; anything else on
the machine can reach the port too), what does the access control (the
directory's permissions against a token in a file), and what a stale one
leaves behind. §10 leaves it open, and neither the measurement nor this
proposal picks.

**What a Windows host would still cost** after the seam: ConPTY latency
(p50 15.7 ms against 59–95 µs, which bounds how a Windows-hosted session
feels through any client) and its throughput (about 20 KiB/s, which bounds
what a session can pour through one), the re-encoding above, logoff killing
the daemon (a service or Run-key relaunch is the only cure), the shell
question, and an `arm64` build with no `bun:ffi`, which has no job to hold a
session's tree — its lock is a pipe name and that much holds. None of these
looks like a stopper; all of
them are work that the WSL2 answer avoids. §6 says what that does to the open
question.

## 4. macOS, specifically

**Back-pressure is settable, and it is not the whole story.** The 8 KiB
`net.local.stream.sendspace` is XNU's default, measured identical on the
arm64 and Intel runners. Bun 1.3.14 documents no way to set socket buffers,
but the listener returned by `Bun.listen` and every accepted socket expose a
numeric `fd`, and one `setsockopt(SO_SNDBUF)` on the listener via `bun:ffi`
before the first accept is inherited by every connection
([PR #2](https://github.com/omnilogic-labs/werk/pull/2)). Raising the client's
receive buffer alone does nothing; the sender's buffer is the bound. In the
compiled daemon on the real macOS lane:

|                                          | buffers at default | buffers at 212992 |
| ---------------------------------------- | ------------------ | ----------------- |
| bytes taken before the first short write | 8,560              | 213,412           |
| fast-client lag episodes                 | 20–22              | 3–4               |
| fast-client bytes lost                   | 6.4–6.6 MB         | 6.3–6.9 MB        |
| slow-client bytes received before cutoff | 11 KB              | 264 KB            |
| slow-client scenario                     | fail               | fail              |

So the kernel buffer accounts for most of the lag episodes and none of the
loss, and neither does the fast client's sink. `spikes/m2/pty-cat.ts` will
put that client behind a PTY, a pipe, or a plain file it writes itself, and run
33703344148 measured all three on the one runner: 5.8 M, 5.8 M and 6.4 M
bytes lost, six to eight lag episodes each. A file sink cannot apply
back-pressure and asks nothing of the harness, so what is left is upstream of
the client's fd 1: the daemon delivers 1.5–1.9 MB in about three seconds to a
client that cannot be blocking, and the queue for that client sits at its
262,144 B bound throughout. The same scenario delivers 4.2–5.9 MB in
1.2–1.6 s on the four-vCPU `ubuntu-latest` lane, losing 2.1 M and 0.4 M bytes
on two attempts an hour apart, and all 6.29 MB in about 700 ms on the
eight-core machine M2 was measured on, losing none. Where the macOS
difference goes is unmeasured — Bun's socket write on XNU, the client's read
loop, the daemon's event loop with the wasm engine on it, or CPU share on a
hosted runner are all still open — but it is not the harness, and across
three machines the loss tracks how fast the bytes move rather than anything a
client did.

The buffer raise is cheap and best-effort and probably worth keeping;
whether the slow-client scenario should gate anything on macOS is a separate
question that this does not answer, and §5's reading of it — measured, not
gated, until the bound is either larger or expressed in time — probably wants
to cover macOS as well as the hosted Linux lanes. Every peer that streams
terminal output over a local socket — tmux, wezterm, mosh — ignores the
kernel buffer and puts the drop-and-redraw policy in user space, which is
what the daemon's bounded queue plus snapshot re-render already is. A small
upstream change exposing the buffer size on `Bun.listen` would remove the ffi
call.

**Signing: every fresh binary is invalid.** A `bun build --compile` output
fails `codesign --verify` on both architectures with "code or signature have
been modified": on arm64 Bun leaves the linker's ad-hoc signature, on Intel
the cross-compiled binary carries Bun's own Developer ID signature, and in
both cases the appended bundle invalidates it. It still runs locally because
nothing has quarantined it. `codesign --force --sign -` repairs it in one
step and the result passes `--strict`. So the first macOS release step is a
re-sign: the macOS build steps do it, and both darwin lanes verify what comes
out — a `codesign` suite on the natively built binary, gated on
`darwin-arm64` (run 33703344148), and an `x-codesign` suite on the
cross-compiled one, which arrives from a Linux job that can sign nothing
(run 33703355321). That
is also what would catch a Bun signer regression on a version bump. Beyond
that, the path is Developer ID with Bun's JIT entitlement set, and notarising
the zipped binary (a bare executable cannot be stapled, so first run does an
online check, or ship a `.pkg`). The wasm-only engine
makes this one signature: no extracted dylib, no library-validation
entitlement. The ffi engine on macOS would cost exactly those things; the
extracted prebuilds are already linker-signed and verify clean, so it is
extra ceremony rather than a blocker.

**Persistence.** A detached daemon's "responsible process" for TCC purposes
is its ancestor — on the runner, the runner agent; on a developer's machine,
the terminal — so it inherits that terminal's grants. A LaunchAgent would
survive reboot but be its own responsible process, get no grants, and fail
silently on `~/Documents`. The default is probably the detached daemon, with
an opt-in `werk daemon install` that writes a LaunchAgent and documents the
cost. Whether a detached daemon survives logout is unverified either way. The
spurious-`exit` Bun issue for detached children on macOS (#40289) did not
reproduce in 100 attempts on 1.3.14.

**darwin-x64.** macOS 26 is the last Intel release. The wasm engine, the
daemon and the suites all work on the Intel runner (M0 takes 42 s there
against about 24 s elsewhere). It probably wants to be a best-effort target
with a sunset tied to macOS 26, and the ffi prebuild for it never built and
probably never needs to.

## 5. Linux, and the build matrix

Every target werk cares about has a free native hosted runner for a public
repository: `ubuntu-24.04-arm`, Alpine in a container on x64 and via
`docker exec` on arm64 (GitHub's container jobs are x64-only), `macos-15-intel`,
`windows-11-arm`. QEMU is never needed, which matters because Bun under
`qemu-user` is known-broken. So the release shape is the one several
Bun-compiled CLIs already use, and
[`poc.yml`](../../.github/workflows/poc.yml) is it: one `ubuntu-24.04` job
builds all eight targets and the reference differential summary in under a
minute, and eight native lanes each download their own binary, smoke it
(`--help`, `caps`, a daemon start and `ls`, plus `ldd` on Alpine, the ad-hoc
re-sign and `codesign --verify` a macOS release would do, and a contended
lock on Windows) and diff their own normalised summary against the
reference. One dispatch is nine jobs, eight binaries and a
`ci-result-<lane>.json` per lane.

Three of the eight lanes — `linux-x64-glibc`, `darwin-arm64` and
`win32-x64` — are also where the PoC suites run natively, so the smoke and
the suites share a job rather than each claiming a runner of its own.

Three Linux-side risks the matrix should keep measuring:

- **AVX2.** Bun 1.3.x after 1.3.8 crashes on CPUs without AVX2 even in the
  `-baseline` build (an open upstream tracker; one trace is inside JSC's
  assembler, so the wasm engine is implicated). Every Linux lane records
  what its CPU offers: both x64 lanes report `avx` and `avx2`, both arm64
  ones have no such extension, and the Intel Mac reports
  `hw.optional.avx2_0: 1`. So the fleet has never run the x64 build on a CPU
  without AVX2 and cannot measure this. Bun 1.4 ships one x64 binary with
  runtime dispatch; whether that is trustworthy is unverified.
- **musl runtime deps.** `libstdc++.so.6` and `libgcc_s.so.1`, as above: the
  `x-ldd` suite records them at 2.77 MB and 174 KB on x64, 2.75 MB and 133 KB
  on arm64, and the Alpine lanes `apk add libstdc++ libgcc` so the binary
  starts at all. Carrying the pair instead was measured on x64 — copied
  beside the binary with either `LD_LIBRARY_PATH` or an `$ORIGIN` rpath, a
  bare `alpine:3.22` runs `wp ls` and its daemon
  ([`platforms.md`](../../packages/werk-poc/findings/platforms.md)) — so the
  choice between requiring the pair and shipping it is a live one, and
  nobody has taken it.
- **Prebuild lookup on non-x64 compiled binaries.** The libghostty-vt
  binding's own loader fails to find its prebuild inside a compiled binary on
  `linux-arm64` and both musl targets (`Bundled libghostty-vt missing at
/$bunfs/prebuilds/linux-arm64-glibc/…`) while the PoC's shim finds it, which
  `spikes/m6/compiled.test.ts` checks on whatever platform it runs on.
  Only relevant if the ffi engine ships; recorded because it is the kind of
  thing that reads as "arm64 is broken" when it is not.

The slow-client scenario fails on most attempts on every 4-vCPU hosted
Linux lane, for the reason
[`platforms.md`](../../packages/werk-poc/findings/platforms.md) records —
the fast client's own queue crosses the drop bound on shared CPUs — and the
lanes forgive exactly that one failure. It is nondeterministic: roughly two
attempts in seven pass, so a green lane is not evidence that it is fixed.
Whether it should be a gate at all, be scaled to the machine, or be split
into a deterministic
fidelity check and a recorded headroom number, is open; "measured, not
gated" is what the lanes do today and probably the right default.

## 6. What the measurements do to the open questions

- **Windows as host** ([`../product/04-open-questions.md`](../product/04-open-questions.md) §4).
  The measured costs of hosting on Windows are output re-encoding, kill
  being `TerminateProcess` with graceful teardown moved into the protocol,
  ConPTY latency and throughput, and WSL2 teardown if that is the placement;
  `AF_UNIX` is not one of them, nor tree kill, which a Job Object handles
  wherever `bun:ffi` exists, and neither, as it turns out, is reattach
  fidelity: the cells the same input leaves are identical run after run even
  where the bytes carrying them are not (§3). The lean towards client-first
  with WSL2 as the documented placement probably still holds on effort
  grounds — the seam is small but the ConPTY semantics behind it are real
  work — but nothing measured says the platform blocks native hosting.
- **Windows transport** ([`../research/09-remote-transport.md`](../research/09-remote-transport.md)
  open question 3) is narrowed to one question. Unix-socket forwarding is
  absent on both sides of Win32-OpenSSH and its client refuses the spelling
  before it connects, so a Windows client of a remote daemon forwards to a
  loopback TCP port — and a `wp.exe` has now completed `hello` with a daemon
  it did not start that way, with the daemon's frames arriving whole (§3, and
  [`../../packages/werk-poc/findings/m5.md`](../../packages/werk-poc/findings/m5.md)).
  What is left of the question is multiplexing, which the port does not
  answer: `ControlMaster` is still absent on Windows, so a client that wants
  one connection per host has to carry its own multiplexer or open an `ssh -L`
  per host and live with that.
- **The ffi prebuild matrix** ([`../research/07-packaging.md`](../research/07-packaging.md)
  open question 6) now has a measured hole on two of eight targets and a
  measured speed deficit on the one where both engines ran. Carrying it is a
  cost with no measured benefit. Whether to keep the vendored win32 DLL and
  the shim as reference or drop them is for whoever builds the product.

## 7. How to measure, and the runs so far

Every "measured" in §1 points at one of these; each run uploads a
`ci-result-<lane>.json` that is the record, and artefacts are kept 14 days
so re-running is the way to check anything older. A row naming `matrix.yml`
is a run of the eight smoke lanes in a workflow of their own; the lanes, the
suites and the artefact names are the same ones `poc.yml` runs.

| What                                                                      | Where                                                                      | Run                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The three lanes on `main` with every spike merged                         | [`poc.yml`](../../.github/workflows/poc.yml)                               | [33696942295](https://github.com/omnilogic-labs/werk/actions/runs/33696942295)                                                                                                                                                                                                                                                 |
| The eight-target matrix on that same `main`                               | `matrix.yml`                                                               | [33696944598](https://github.com/omnilogic-labs/werk/actions/runs/33696944598)                                                                                                                                                                                                                                                 |
| The Windows lane once its daemon suite is gated                           | `poc.yml`                                                                  | [33697939359](https://github.com/omnilogic-labs/werk/actions/runs/33697939359)                                                                                                                                                                                                                                                 |
| The eight-target matrix once Windows uploads its result                   | `matrix.yml`                                                               | [33698568476](https://github.com/omnilogic-labs/werk/actions/runs/33698568476)                                                                                                                                                                                                                                                 |
| The three lanes with §2's seam in place                                   | `poc.yml`                                                                  | [33702171963](https://github.com/omnilogic-labs/werk/actions/runs/33702171963)                                                                                                                                                                                                                                                 |
| The eight targets with §2's seam in place                                 | `matrix.yml`                                                               | [33702173764](https://github.com/omnilogic-labs/werk/actions/runs/33702173764), [33702588265](https://github.com/omnilogic-labs/werk/actions/runs/33702588265)                                                                                                                                                                 |
| The eight targets on `main`, run against those two                        | `matrix.yml`                                                               | [33702822069](https://github.com/omnilogic-labs/werk/actions/runs/33702822069)                                                                                                                                                                                                                                                 |
| The Linux lanes with the musl and AVX records                             | `matrix.yml`                                                               | [33701438138](https://github.com/omnilogic-labs/werk/actions/runs/33701438138)                                                                                                                                                                                                                                                 |
| The Windows lane before the daemon had `win32` branches                   | `poc.yml`                                                                  | [33686941407](https://github.com/omnilogic-labs/werk/actions/runs/33686941407)                                                                                                                                                                                                                                                 |
| Lane gates made fail-closed                                               | [PR #4](https://github.com/omnilogic-labs/werk/pull/4)                     | [33688264859](https://github.com/omnilogic-labs/werk/actions/runs/33688264859)                                                                                                                                                                                                                                                 |
| Eight targets built on Linux, smoked on native runners                    | [PR #5](https://github.com/omnilogic-labs/werk/pull/5), `matrix.yml`       | [33689751325](https://github.com/omnilogic-labs/werk/actions/runs/33689751325)                                                                                                                                                                                                                                                 |
| macOS socket buffers, signing, process lifecycle probes                   | [PR #2](https://github.com/omnilogic-labs/werk/pull/2), `macos-probes.yml` | [33688130745](https://github.com/omnilogic-labs/werk/actions/runs/33688130745)                                                                                                                                                                                                                                                 |
| The daemon with buffers raised, on the macOS lane                         | PR #2, `poc.yml`                                                           | [33688537937](https://github.com/omnilogic-labs/werk/actions/runs/33688537937)                                                                                                                                                                                                                                                 |
| Both darwin lanes verifying a signed binary, each M2 sink measured        | `poc.yml` and `matrix.yml`                                                 | [33703344148](https://github.com/omnilogic-labs/werk/actions/runs/33703344148), [33703355321](https://github.com/omnilogic-labs/werk/actions/runs/33703355321)                                                                                                                                                                 |
| Windows primitives probed directly                                        | [PR #3](https://github.com/omnilogic-labs/werk/pull/3), `win32-spike.yml`  | [33691536664](https://github.com/omnilogic-labs/werk/actions/runs/33691536664)                                                                                                                                                                                                                                                 |
| The Windows lane with the three blockers stepped over                     | PR #3, `poc.yml`                                                           | [33690884893](https://github.com/omnilogic-labs/werk/actions/runs/33690884893)                                                                                                                                                                                                                                                 |
| The Windows lane with the M2 and `ops` harness items done                 | `step/04-harness`, `poc.yml`                                               | [33705813223](https://github.com/omnilogic-labs/werk/actions/runs/33705813223), [33706143058](https://github.com/omnilogic-labs/werk/actions/runs/33706143058)                                                                                                                                                                 |
| ConPTY's re-encoding, compared as bytes and as cells                      | `poc.yml`'s `probes` suite                                                 | [33706788925](https://github.com/omnilogic-labs/werk/actions/runs/33706788925)                                                                                                                                                                                                                                                 |
| The Windows lane with the fidelity oracle on the grid                     | `poc.yml`                                                                  | [33706788925](https://github.com/omnilogic-labs/werk/actions/runs/33706788925)                                                                                                                                                                                                                                                 |
| The three lanes with every Windows step of §8 merged                      | `poc.yml`                                                                  | [33710644108](https://github.com/omnilogic-labs/werk/actions/runs/33710644108)                                                                                                                                                                                                                                                 |
| The three lanes with teardown through the protocol                        | `poc.yml`                                                                  | [33707334391](https://github.com/omnilogic-labs/werk/actions/runs/33707334391)                                                                                                                                                                                                                                                 |
| A runner as its own ssh remote, on both platforms                         | [`step9-probes.yml`](../../.github/workflows/step9-probes.yml)             | [33712964081](https://github.com/omnilogic-labs/werk/actions/runs/33712964081), [33713528169](https://github.com/omnilogic-labs/werk/actions/runs/33713528169)                                                                                                                                                                 |
| A Windows `wp` through `ssh -L`, and its socket as `AF_UNIX` and as TCP   | `step9-probes.yml`                                                         | [33713970573](https://github.com/omnilogic-labs/werk/actions/runs/33713970573), [33714217277](https://github.com/omnilogic-labs/werk/actions/runs/33714217277)                                                                                                                                                                 |
| M5 on macOS, with the runner as its own remote                            | `step9-probes.yml`                                                         | [33714324454](https://github.com/omnilogic-labs/werk/actions/runs/33714324454), [33714139719](https://github.com/omnilogic-labs/werk/actions/runs/33714139719)                                                                                                                                                                 |
| The three lanes with the daemon's loopback landing in the tree            | `poc.yml`                                                                  | [33714561163](https://github.com/omnilogic-labs/werk/actions/runs/33714561163)                                                                                                                                                                                                                                                 |
| Job Objects, the kill path and `expect().rejects` on both Windows runners | `step2-probes.yml`                                                         | [33704743713](https://github.com/omnilogic-labs/werk/actions/runs/33704743713), [33706263111](https://github.com/omnilogic-labs/werk/actions/runs/33706263111), [33707210922](https://github.com/omnilogic-labs/werk/actions/runs/33707210922)                                                                                 |
| The daemon's lock contended on both Windows runners                       | `step5-probes.yml`                                                         | [33712812822](https://github.com/omnilogic-labs/werk/actions/runs/33712812822), [33713142782](https://github.com/omnilogic-labs/werk/actions/runs/33713142782)                                                                                                                                                                 |
| The eight targets with steps 1–4, 6 and 7 merged                          | `matrix.yml`                                                               | [33712817886](https://github.com/omnilogic-labs/werk/actions/runs/33712817886)                                                                                                                                                                                                                                                 |
| The two Windows matrix lanes once they are gated                          | `matrix.yml`                                                               | [33713887366](https://github.com/omnilogic-labs/werk/actions/runs/33713887366), [33714530862](https://github.com/omnilogic-labs/werk/actions/runs/33714530862), [33715134773](https://github.com/omnilogic-labs/werk/actions/runs/33715134773), [33715705924](https://github.com/omnilogic-labs/werk/actions/runs/33715705924) |
| The eight lanes side by side in two workflows, for §8's eighth step       | `poc.yml` and `matrix.yml`                                                 | [33716396025](https://github.com/omnilogic-labs/werk/actions/runs/33716396025), [33716397542](https://github.com/omnilogic-labs/werk/actions/runs/33716397542)                                                                                                                                                                 |
| The eight lanes folded into one workflow, one dispatch                    | `poc.yml`                                                                  | [33716828853](https://github.com/omnilogic-labs/werk/actions/runs/33716828853)                                                                                                                                                                                                                                                 |

The cheap way to ask any further question is the same: a branch, a workflow
with a `push` trigger scoped to it (or `gh workflow run poc.yml --ref
<branch>` for a workflow already on `main`), and a probe that prints one
verdict line per question and never throws. Nothing needs to land on `main`
to be measured.

## 8. Order of work to a proof of concept that runs everywhere

This is the sequence this proposal proposes, from where
[`platforms.md`](../../packages/werk-poc/findings/platforms.md) says the lanes
stand today to every lane green. Each step names what to change, what a
green result proves, the measurement that says it is done, and the result
that would mean the approach is wrong. Steps 1–5 are Windows, where the
suites stop; 6 and 7 the platforms that already pass; 8 and 9 shape.

1. **The platform seam — done.** `src/platform/` holds the §2 interface with
   `posix.ts` and `win32.ts` behind it, and nothing in the daemon, the bench,
   the M2 harness or the Windows probe scripts branches on `process.platform`
   at a call site. Nothing moved behaviour with it: run 33702171963 records
   the same verdicts on the three `poc.yml` lanes as the runs above, and run
   33702588265's eight `matrix.yml` lanes are verdict for verdict identical
   to the `main` run of the same hour (33702822069) — including that lane's
   own flaky `test-full`, which fails on the slow-client scenario on `main`
   too. Four differences had no row in §2 and now have one: `stateDir()`,
   `compiled`, `cpuModel()`, and the zombie check inside `isAlive(pid)`.
   What still reads `process.platform` outside `platform/` is the ffi
   engine's target-triple lookup — an engine concern, not the daemon's — the
   M0 probes, which measure the primitives the seam abstracts and so cannot
   go through it, and two within-POSIX differences with no column in §2's
   table: BSD against GNU `ps` keywords in `launch.test.ts` and
   `script(1)`/`head` flags in `spikes/m2/scenarios.ts`.

2. **Shutdown and kill through the protocol — done.** The `shutdown` message
   is the way in on all three; POSIX keeps its signal handlers as a second
   route, since a `kill` typed at a shell is a real thing and
   `snapshot.test.ts` sends one. A `kill` carries a mode — interrupt,
   terminate or force — and the seam carries out what a mode means:
   `adoptTree(child)` takes hold of a session's child as it is spawned, and
   the tree it returns is the child's process group on POSIX and a Job Object
   with `KILL_ON_JOB_CLOSE` on Windows. A POSIX signal name still names a
   mode and is still the signal that gets sent where signals exist;
   `signalCode` is reported only where an exit status has one, which is not
   Windows. The named test passes on the `windows` lane as a suite of its
   own (`kill`, on the `EXPECTED_PASS` list), and `ubuntu-latest` and
   `macos-latest` record verdict for verdict what run 33702171963 did — the
   slow-client scenario and nothing else (run 33707334391). Two Windows rows
   moved with it: `m3` hit the non-exit it hits about one run in four, and
   `test-full` now runs past the kill test rather than aborting there, which
   takes it past its step's 180 s. Neither is gated; both are step 3's to
   settle. A Job Object holds a ConPTY child on `win32-x64` and
   `TerminateJobObject` takes the tree in 2–3 ms even though the daemon is
   already inside a job; `win32-arm64` has no `bun:ffi` at all, so its kill
   is `TerminateProcess` on the child alone and anything that has left the
   ConPTY behind survives it (runs 33704743713, 33706263111). The five
   seconds the kill test used to spend was one assertion — an
   `expect(promise).rejects` that hangs on Windows where catching the same
   rejection answers at once (run 33707210922) — and with it caught, the
   whole of `daemon.test.ts` reaches a verdict on both Windows runners: 10
   pass and the slow-client scenario on `win32-x64`, 9 pass and the render
   prologue as well on `win32-arm64` (run 33707978762). That prologue test
   passes on `win32-x64` run on its own and fails in the same commit's
   `test-full`, so whatever fails it there is not simply ConPTY's opening
   bytes; step 3 is where that goes.

3. **A ConPTY-aware fidelity oracle — done.** The daemon tests and M2 ask
   the grid rather than the stream. `src/daemon/_grid.ts` replays everything
   one attached client received into a fresh terminal of the session's size
   and holds the result against the daemon's own screen, cell for cell and
   cursor included; M2 judges a render by whether what reached a resumed
   client redraws the whole screen on its own, which is what a render is and
   what a replay of ordinary output could not be. The measurement that chose
   between the grid and a recorded prologue is in §3: six sessions of the
   same input leave the same cells and the same cursor, run after run and
   job after job, while the bytes carrying them are usually but not always
   identical — so a recorded prologue could not have carried the guarantee.
   On the `windows` lane, `run, attach, see output; input is echoed back`
   passes in 234 ms and `m2` passes outright, its reattach scenarios agreeing
   with the daemon's screen through a ConPTY (run 33706788925).

   `test-full` there now runs every file to a verdict — 146 pass, 11 fail
   across 22 files — because the lane runs one `bun test` process per file.
   The abort it used to die of was Bun panicking after step 2's kill test
   timed out, which took the seventeen files it had not reached with it;
   `daemon.test.ts` is still the one file with no verdict, and with that one
   test filtered out it reaches `9 pass 1 fail` (run 33705737351), so step 2
   is what closes it. The failing set is wider than "steps 4 and 5", because
   most of these tests had never run at all: besides `bench/ops.ts` and the
   M2 harness, `launch.test.ts` calls `stat` on the socket's reparse point
   and `pgrep`, `snapshot.test.ts` waits for a SIGTERM a detached Windows
   daemon never sees, `attach-snapshot.test.ts` waits out a 4 MiB flood
   against 20 KiB/s of ConPTY and takes an output frame before its snapshot,
   `m1`/`m6` name `/$bunfs/` where Windows has `B:/~BUN/`, and M2's
   vim-resize scenario counts the file rows vim redraws into a taller window,
   which is 28 through a pty that passes bytes on and 23 through a ConPTY —
   a number both screens agree on. None of them is a fidelity failure, and
   each is a row for whoever takes it.

4. **The harness items — done.** The M2 harness compiles to
   `dist/m2/wp-<pid>` rather than over `dist/wp`, so no daemon running an
   earlier build can pin the file it writes, and `bench/ops.ts` spawns
   through the seam's `spawnDaemon()` with runtime directories short enough
   for Winsock to bind under. Both suites report on `win32-x64` rather than
   dying in a launcher (runs 33705813223 and 33706143058): `ops` passes in
   about 1.3 s with its cold-start table, and `m2` reports all eight scenario
   verdicts, of which five or six pass. `m2` reported them on the lane
   before too, because the lane stops every daemon it can find before the
   suites that build; what it no longer needs is that housekeeping. Its
   stable failures are the alternate-screen scenario, which is step 3's
   ConPTY oracle, and the `SIGSTOP` slow client, which Windows has no signal
   for; a third scenario fails on some runs where an assertion reads the PTY
   buffer before ConPTY has finished delivering into it. `ops` is gated on
   the Windows lane now; `m2` is recorded rather than gated, since a suite
   that reports two failures is not one to gate on.

5. **Windows arm64 gated like x64 — done.** The `\\.\pipe\` lock holds
   under contention on the one platform with no alternative to it: a second
   `wp __daemon` against a live one exits 1 saying another daemon holds the
   lock, the socket is still the first daemon's, and the name comes back
   about 100 ms after the holder is killed — from the source and from the
   compiled binary, natively on `win32-arm64` and with the pipe forced on
   `win32-x64` (runs 33712812822 and 33713142782). It is a `lock` suite
   rather than a one-off probe, so every run of either lane asks it again.
   `ops`
   reaches the daemon there too: what stopped it was step 4's socket path,
   and with the runtime directories shortened it passes in 1.5 s with its
   cold-start table — `wp __daemon` to a first `hello` at 124–128 ms, `wp
ls` against a live daemon at 79–82 ms (runs 33712817886, 33712812822).

   The lane is gated on `x-help`, `x-ls`, `install`, `lock` and `ops`, and
   `win32-x64` on the same plus `x-caps`, `test-pure`, `build` and `diff` —
   there across two gate lists, since that lane runs `install`, `test-pure`,
   `build` and `ops` through the PoC's own suite runner. Both lanes are
   green over their own list, and every other lane with them
   (four runs, 33713887366 through 33715705924). Those four are the difference, and
   they are recorded on arm64 rather than gated: there is no `bun:ffi` there
   and libghostty-vt ships no prebuild for the target, so the ffi engine
   cannot load and every suite that counts it is red for a reason nothing in
   this step changes. Three more are recorded on both runners. `m0`: three
   or four of seven PTY probes pass, and which ones moves — `03-sigwinch`
   and `06-raw-mode` swap places on both runners between runs 33712817886
   and 33714530862. `m3`: every snapshot it encodes decodes identically, and
   then the process does not exit, on some runs on either runner.
   `test-full`: the ConPTY costs §3 records. Gating any of those would gate
   on something already understood, which is worse than not gating it.

6. **macOS.** The listener buffer raise stays, now a row of the
   seam rather than a file of its own, the macOS
   build steps re-sign the binary and both darwin lanes verify it, and the
   fast client in M2 (`spikes/m2/pty-cat.ts`) can be sunk into a PTY, a pipe
   or a plain file. Signing is settled: `codesign -v` is green on both lanes
   (§4). The sinks answered the question they were asked and opened a larger
   one — §4 has the figures — so what is left here is to find where a macOS
   client's delivery rate goes, which none of these runs separates: the
   daemon's write path, the client's read path, the wasm engine sharing the
   daemon's event loop, or CPU share on a hosted runner. A probe that streams
   the same 4 MB through each of those in isolation would say. Until it does,
   the slow-client scenario is measuring throughput as much as the drop
   policy on macOS, which is the same doubt §5 records for the hosted Linux
   lanes, and §10's question about whether it gates or only records is the
   one to answer first.

7. **Linux and musl.** `test-full` on `linux-arm64-glibc` and both musl
   lanes fails only on the slow-client scenario (run 33701438138, where the
   arm64 glibc lane passed even that), `spikes/m6/compiled.test.ts` derives
   the prebuild it expects from the host rather than naming one target, and
   the PoC's shim finds its prebuild on all four Linux targets — so prebuild
   lookup inside a compiled binary is a quirk of the binding's own loader,
   not a problem of the approach. What is left is the choice §5 records and
   nobody has taken: whether a musl host is required to have
   `libstdc++.so.6` and `libgcc_s.so.1`, or the release carries them. The
   AVX2 exposure is recorded per lane and nothing is decided about it.

8. **The release shape — done.** `poc.yml` is one build job producing all
   eight binaries and one native smoke lane per target, and the three lanes
   that also run the PoC suites do both in the same job. One dispatch is
   nine jobs, eight binaries and a `ci-result-<lane>.json` per lane
   (run 33716828853). A lane that runs two suite runners writes two records
   and `.github/ci/lane-result.ts` merges them, so the file the docs cite
   holds every suite the lane ran.

   Folded and side by side were both built and dispatched on the same
   commit, seven minutes apart: nine jobs against twelve
   (run 33716828853, against 33716396025 and 33716397542 together). Six of
   the nine jobs are the same job in both shapes, so what the fold changes
   is the three targets that had a lane each in two workflows:
   `linux-x64-glibc` 2.2 minutes against 2.0 + 1.9, `darwin-arm64` 2.5
   against 2.6 + 2.0, and `win32-x64` 8.0 against 6.8 + 4.1 — 12.7
   runner-minutes against 19.4, and three fewer runners to wait on. What it
   costs is wall clock on the critical path: a folded lane runs both suite
   runners in series and starts behind `build-all`, so the folded run
   finishes about two minutes later.

   The two runs' totals do not show that, because the lane that bounds them
   both is `win32-arm64`, which is the same job in either shape and takes
   either about 5 or about 15 minutes depending on whether `m3` and
   `test-full` exit or wait out their deadlines: 37.9 runner-minutes and 16.0
   of wall clock folded, against 34.9 and 6.9 side by side, with that lane
   at 15.1 and 5.3 minutes respectively. Hold it equal and the comparison is
   22.8 runner-minutes against 29.6, and 8.9 minutes of wall clock against
   6.9. The minutes are raw and unweighted, because a public repository is
   billed nothing and the timing API returns zero for every job; on
   private-repo multipliers the macOS and Windows savings would count for
   ten and two times as much again.

   Every gate survives the fold. `win32-x64` is held to the same nine
   suites, across two lists because it runs two suite runners:
   `x-help`, `x-caps`, `x-ls`, `lock` and `diff` under
   `MATRIX_EXPECTED_PASS`, and `install`, `test-pure`, `build` and `ops`
   under the lane's own `EXPECTED_PASS`, which held them already. Both gates
   run after the artefact is uploaded, so a red gate never costs the record.

9. **Transport — done.** M5 has an RTT table on macOS and a Windows `wp.exe`
   completes `hello` with a daemon it did not start, through a forward.
   Both halves needed an arrangement rather than a machine, and both
   arrangements are what a hosted runner can be talked into.

   **macOS.** A hosted macOS runner has no Docker, so M5's remote end cannot
   be its container. `spikes/m5/self.ts` makes the runner its own remote — a
   private `sshd` on a high port with a throwaway key, a second daemon in a
   runtime directory of its own, `ssh -N -L` between them — with pf's
   dummynet supplying the RTT that `tc netem` supplies in the container:
   `sshd`'s banner goes from 5.5 ms to 112.5 ms with two 25 ms pipes and
   back. The tables are in
   [`m5.md`](../../packages/werk-poc/findings/m5.md) (run 33714324454). The
   applied RTT lands (`stats` through the forward at 6.9, 58.2 and 213.4 ms
   p50 for 0, 50 and 200 ms), a keystroke settles in one round trip at every
   RTT, every frame of a 5 fps animation arrives one per read, a 30 MiB
   flood is delivered through the forward with nothing dropped at any RTT,
   and a killed forward costs the view alone. Two things differ from Linux
   and neither is the forward: a keystroke over `-N` costs one round trip
   here where it cost two there, so the Nagle penalty is a property of that
   path rather than of `-N`; and the daemon reads a `yes` flood in tens of
   bytes at a time on macOS, sending 750,000 frames where the Linux daemon
   sent 2,200, which is what caps the flood at 1.7 MiB/s.

   **Windows.** Win32-OpenSSH refuses a Unix path in a `-L` spelling before
   it opens a connection, so the daemon carries a loopback landing behind
   `WP_TCP_LISTEN` — off by default, the `AF_UNIX` socket and everything
   about it unchanged — with the port and a random token in `wp.tcp` in the
   runtime directory, and a client that arrives over the port names the
   token in its `hello` or is closed. On `windows-latest`, with the runner
   as its own ssh remote,
   `wp.exe --socket tcp:127.0.0.1:<port> ls` completed `hello` through
   `ssh -N -L` in 94 ms against a daemon started in another runtime
   directory, and the same command without the token is refused (run
   33713970573). That arrangement exercises the Windows ssh client's `-L`, a
   Windows sshd's side of it and a client with only a port; it does not
   exercise a real network, a non-Windows sshd, or any RTT.

   **The stop condition did not fire.** Asked in the regime `m5.md` measured
   on Linux — 200 frames sent 20 ms apart — both the macOS Unix-socket
   forward and the Windows loopback-TCP forward delivered 200 frames in 200
   reads, one frame per read. Asked with 20,000 stamped frames back to back,
   all 20,000 arrived complete and in order through both, and the reads they
   arrived in matched what the same server gives with no ssh in the path on
   macOS (7.8–8.2 KB either way) and exceeded it on Windows (448 KiB through the
   forward against 128 KiB direct) — aggregation of a saturated stream, with
   nothing lost or reordered (run 33714217277).

   **Both Windows transports are recorded and neither is chosen.** On the
   same machine they are within noise of each other — 0.01 against 0.02 ms
   per round trip, 2.1 against 2.6 GiB/s one way, the same 128 KiB before
   the first short write, and 2.04 against 2.27 ms for a `stats` round trip
   against the real daemon. What separates them is §3's list, and §10 still
   holds the choice.

**Done** is every lane in `poc.yml` green with no forgiven suites except the
slow-client scenario, on a pinned Bun, with a `ci-result-<lane>.json` per
lane that says so.

## 9. What would change the answer

- Bun exposing socket buffer sizes, reading the parent's end of an extra
  stdio pipe on Windows, or shipping `bun:ffi` on Windows arm64 — each
  removes a row or a fallback from §2. Pin Bun, and re-run the matrix on each
  bump.
- The AVX2 crash being fixed upstream, or Bun 1.4's runtime dispatch proving
  trustworthy, would settle the x64 baseline question.
- A decision that Windows is a host would turn §3's cost list into a work
  plan, starting with a ConPTY oracle for the differential corpus.
- The ffi engine winning on some measured metric would bring the prebuild
  matrix, the dylib signing and the `darwin-x64` build problem back.

## 10. What this does not settle

Whether Windows is a host. Whether the daemon should ever be supervised by
launchd or a Windows service. Which Windows shell is the default. Whether
the ffi engine ships at all. Whether `darwin-x64` ships at all. Whether the
slow-client scenario gates CI or only records. Whether the Windows socket is
`AF_UNIX` or loopback TCP. Each is named where it comes up and left open.
