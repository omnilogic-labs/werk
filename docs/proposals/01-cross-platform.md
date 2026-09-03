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

| Target            | Runner             | wasm engine, differential | Daemon from a cross-compiled binary | PoC suites                                                         |
| ----------------- | ------------------ | ------------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| linux-x64-glibc   | `ubuntu-24.04`     | reference                 | starts, answers `ls`                | all pass but the slow-client scenario                              |
| linux-arm64-glibc | `ubuntu-24.04-arm` | identical                 | starts, answers `ls`                | same                                                               |
| linux-x64-musl    | Alpine 3.22        | identical                 | starts, answers `ls`                | same; the binary needs `libstdc++` and `libgcc_s` there            |
| linux-arm64-musl  | Alpine 3.22 on arm | identical                 | starts, answers `ls`                | same                                                               |
| darwin-arm64      | `macos-latest`     | identical                 | starts, answers `ls`                | same as Linux                                                      |
| darwin-x64        | `macos-15-intel`   | identical                 | starts, answers `ls`                | same; no ffi prebuild exists, so ffi tests fail                    |
| win32-x64         | `windows-latest`   | identical                 | starts, answers `ls` (§3)           | reattach fidelity holds; `ops`, `m0-probes`, `test-full` fail (§3) |
| win32-arm64       | `windows-11-arm`   | identical                 | starts, answers `ls`; no `bun:ffi`  | as x64, plus no ffi engine at all in Bun 1.3.14                    |

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

| Concern              | POSIX                                                                                      | Windows                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `lock(dir)`          | `flock(LOCK_EX\|LOCK_NB)` via `bun:ffi`                                                    | `CreateFileW` + `LockFileEx` via `bun:ffi`; where `bun:ffi` is absent, an exclusive named pipe     |
| `runtimeDir()`       | `$XDG_RUNTIME_DIR` → `$TMPDIR/werk-$UID`, mode checked                                     | `%LOCALAPPDATA%\werk`; mode and uid checks skipped (Bun reports `40666` and no uid)                |
| `stateDir()`         | `$XDG_STATE_HOME` → `~/.local/state/werk`                                                  | `%LOCALAPPDATA%\werk\state`                                                                        |
| `listen()`           | `AF_UNIX` under `runtimeDir()`, bind-and-rename, `chmod 0600`                              | `AF_UNIX` works for a Bun client; a stale socket has to be unlinked first, and has no mode (§3)    |
| `spawnDaemon()`      | `detached: true` (`setsid`), `cwd: /`                                                      | `detached: true, windowsHide: true`, stdio ignored, `cwd` the home directory                       |
| readiness            | connect and complete `hello` within a deadline                                             | the same; the failure reason comes from the daemon's log file                                      |
| `compiled`           | `import.meta.path` starts `/$bunfs/`                                                       | the virtual drive `B:\~BUN\`, and the path arrives with backslashes                                |
| `isAlive(pid)`       | `kill(pid, 0)`, then `/proc/<pid>/stat` — `ps -o state=` on macOS — so a zombie reads dead | `kill(pid, 0)` (works in Bun on Windows); there are no zombies to exclude                          |
| `rss(pid)`           | `/proc/<pid>/status`, or `ps -o rss=` on macOS                                             | `process.memoryUsage()`, so only for this process                                                  |
| `cpuModel()`         | `machdep.cpu.brand_string` on macOS, `/proc/cpuinfo` on Linux                              | libuv's own `os.cpus()`                                                                            |
| `shutdown()`         | `SIGTERM`/`SIGINT`/`SIGHUP` → grace → `SIGKILL`                                            | no signal reaches a detached daemon at all; a protocol message → grace → `TerminateProcess`        |
| `interrupt(session)` | _not implemented:_ `SIGINT` to the foreground group                                        | _not implemented:_ write `0x03` to the ConPTY; what dies of it is up to the child's runtime        |
| `killTree(session)`  | _not implemented:_ the process group                                                       | _not implemented:_ a Job Object with `KILL_ON_JOB_CLOSE`, via `bun:ffi` where present              |
| socket buffers       | Linux default 208 KiB; macOS 8 KiB, raised via `setsockopt` on the listener's `fd`         | unmeasured, so the kernel's own figure stands                                                      |
| `defaultShell()`     | _not implemented:_ `$SHELL` → `/bin/sh`                                                    | _not implemented:_ probably config → `pwsh` → Windows PowerShell → `%COMSPEC%`; nobody has decided |

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

**Shutdown is a protocol message on all three.** A detached Windows daemon
has no console, so no console-control event can reach it and every
`proc.kill(signal)` is `TerminateProcess` regardless of the name passed —
Bun still reports the requested `signalCode`, which is misleading. Making
graceful shutdown a message is the only portable design and is probably the
better one anyway.

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
- **Kill semantics.** `kill` through the protocol is `TerminateProcess`, exit
  code 1, no signal name; a test that waits for a signal to be reported times
  out. This is the `shutdown()`/`interrupt()` row of §2 as a design item.
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
- Two harness problems that are not platform facts: a running daemon pins
  `wp.exe` so the M2 harness cannot rebuild it, and `bench/ops.ts` has its own
  POSIX-shaped launcher.

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
- On `windows-11-arm` in Bun 1.3.14, `bun:ffi` does not exist at all
  ("TinyCC is disabled"; fixed upstream after 1.3.14). Anything Windows does
  through ffi needs a non-ffi fallback there; the lock falls back to an
  exclusive `\\.\pipe\` name, which is the lock the `win32-arm64` lane's
  daemon holds (run 33696944598). Its refusal of a second taker is verified
  on x64 by forcing the pipe lock, not yet on arm64.

**The socket, beyond Bun.** A Windows `AF_UNIX` socket is reachable from Bun
and from little else werk cares about: Node reaches only `\\.\pipe\` names,
and Win32-OpenSSH forwards neither sockets nor pipes in either direction, and
has no ControlMaster. So if a Windows client ever needs `ssh -L` to a Windows
daemon, or a Node-based tool ever needs to talk to it, the daemon probably
wants to listen on `127.0.0.1:<port>` with the port and a random token in a
file only the user can read — which is what
[`../research/09-remote-transport.md`](../research/09-remote-transport.md)
already expected. That is a lean; the `AF_UNIX` socket works today for a
Bun-only client, and nothing forces the choice yet.

**What a Windows host would still cost** after the seam: ConPTY latency
(p50 15.7 ms against 59–95 µs, which bounds how a Windows-hosted session
feels through any client) and its throughput (about 20 KiB/s, which bounds
what a session can pour through one), the re-encoding above, logoff killing
the daemon (a service or Run-key relaunch is the only cure), the shell
question, and the Job Object work for tree kill. None of these looks like a
stopper; all of them are work that the WSL2 answer avoids. §6 says what that
does to the open question.

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
out — the `poc` lane gates a `codesign` suite on it (run 33703344148), and
the matrix lanes check the natively built binary and the cross-compiled one,
which arrives from a Linux job that can sign nothing (run 33703355321). That
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
`qemu-user` is known-broken. So the release shape this proposes is the one
several Bun-compiled CLIs already use and the matrix spike
([PR #5](https://github.com/omnilogic-labs/werk/pull/5)) exercised: one Linux
job builds all eight targets (about a minute each; every one compiled), each
native lane downloads its own binary and smokes it (`--help`, `caps`, a
daemon start and `ls`), a macOS lane runs `codesign -v` to catch Bun's
recurring signer regressions, and a Windows lane exists only to sign.

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
  `AF_UNIX` is not one of them, and neither, as it turns out, is reattach
  fidelity: the cells the same input leaves are identical run after run even
  where the bytes carrying them are not (§3). The lean towards client-first
  with WSL2 as the documented placement probably still holds on effort
  grounds — the seam is small but the ConPTY semantics behind it are real
  work — but nothing measured says the platform blocks native hosting.
- **Windows transport** ([`../research/09-remote-transport.md`](../research/09-remote-transport.md)
  open question 3) is narrowed: unix-socket forwarding is confirmed absent on
  both sides of Win32-OpenSSH, so a Windows client of a remote daemon
  probably forwards to a loopback TCP port, and that shapes the client.
- **The ffi prebuild matrix** ([`../research/07-packaging.md`](../research/07-packaging.md)
  open question 6) now has a measured hole on two of eight targets and a
  measured speed deficit on the one where both engines ran. Carrying it is a
  cost with no measured benefit. Whether to keep the vendored win32 DLL and
  the shim as reference or drop them is for whoever builds the product.

## 7. How to measure, and the runs so far

Every "measured" in §1 points at one of these; each run uploads a
`ci-result-<lane>.json` that is the record, and artefacts are kept 14 days
so re-running is the way to check anything older.

| What                                                               | Where                                                                      | Run                                                                                                                                                            |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The three lanes on `main` with every spike merged                  | [`poc.yml`](../../.github/workflows/poc.yml)                               | [33696942295](https://github.com/omnilogic-labs/werk/actions/runs/33696942295)                                                                                 |
| The eight-target matrix on that same `main`                        | [`matrix.yml`](../../.github/workflows/matrix.yml)                         | [33696944598](https://github.com/omnilogic-labs/werk/actions/runs/33696944598)                                                                                 |
| The Windows lane once its daemon suite is gated                    | `poc.yml`                                                                  | [33697939359](https://github.com/omnilogic-labs/werk/actions/runs/33697939359)                                                                                 |
| The eight-target matrix once Windows uploads its result            | `matrix.yml`                                                               | [33698568476](https://github.com/omnilogic-labs/werk/actions/runs/33698568476)                                                                                 |
| The three lanes with §2's seam in place                            | `poc.yml`                                                                  | [33702171963](https://github.com/omnilogic-labs/werk/actions/runs/33702171963)                                                                                 |
| The eight targets with §2's seam in place                          | `matrix.yml`                                                               | [33702173764](https://github.com/omnilogic-labs/werk/actions/runs/33702173764), [33702588265](https://github.com/omnilogic-labs/werk/actions/runs/33702588265) |
| The eight targets on `main`, run against those two                 | `matrix.yml`                                                               | [33702822069](https://github.com/omnilogic-labs/werk/actions/runs/33702822069)                                                                                 |
| The Linux lanes with the musl and AVX records                      | `matrix.yml`                                                               | [33701438138](https://github.com/omnilogic-labs/werk/actions/runs/33701438138)                                                                                 |
| The Windows lane before the daemon had `win32` branches            | `poc.yml`                                                                  | [33686941407](https://github.com/omnilogic-labs/werk/actions/runs/33686941407)                                                                                 |
| Lane gates made fail-closed                                        | [PR #4](https://github.com/omnilogic-labs/werk/pull/4)                     | [33688264859](https://github.com/omnilogic-labs/werk/actions/runs/33688264859)                                                                                 |
| Eight targets built on Linux, smoked on native runners             | [PR #5](https://github.com/omnilogic-labs/werk/pull/5), `matrix.yml`       | [33689751325](https://github.com/omnilogic-labs/werk/actions/runs/33689751325)                                                                                 |
| macOS socket buffers, signing, process lifecycle probes            | [PR #2](https://github.com/omnilogic-labs/werk/pull/2), `macos-probes.yml` | [33688130745](https://github.com/omnilogic-labs/werk/actions/runs/33688130745)                                                                                 |
| The daemon with buffers raised, on the macOS lane                  | PR #2, `poc.yml`                                                           | [33688537937](https://github.com/omnilogic-labs/werk/actions/runs/33688537937)                                                                                 |
| Both darwin lanes verifying a signed binary, each M2 sink measured | `poc.yml` and `matrix.yml`                                                 | [33703344148](https://github.com/omnilogic-labs/werk/actions/runs/33703344148), [33703355321](https://github.com/omnilogic-labs/werk/actions/runs/33703355321) |
| Windows primitives probed directly                                 | [PR #3](https://github.com/omnilogic-labs/werk/pull/3), `win32-spike.yml`  | [33691536664](https://github.com/omnilogic-labs/werk/actions/runs/33691536664)                                                                                 |
| The Windows lane with the three blockers stepped over              | PR #3, `poc.yml`                                                           | [33690884893](https://github.com/omnilogic-labs/werk/actions/runs/33690884893)                                                                                 |
| ConPTY's re-encoding, compared as bytes and as cells               | `poc.yml`'s `probes` suite                                                 | [33706788925](https://github.com/omnilogic-labs/werk/actions/runs/33706788925)                                                                                 |
| The Windows lane with the fidelity oracle on the grid              | `poc.yml`                                                                  | [33706788925](https://github.com/omnilogic-labs/werk/actions/runs/33706788925)                                                                                 |

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

2. **Shutdown and kill through the protocol.** Replace the daemon's
   signal-based shutdown and the session kill path's `proc.kill(signal)` with
   protocol messages; on Windows, put each session's child in a Job Object
   with `KILL_ON_JOB_CLOSE` via `bun:ffi` so a kill takes the tree. _Proves_
   teardown does not depend on a signal reaching a detached process. _Done
   when_ `kill signals the child; ls reports the signal; attached clients
hear exited` in `src/daemon/daemon.test.ts` passes on the `windows` lane
   and stays green on `ubuntu-latest` and `macos-latest`. _Wrong if_ a
   ConPTY child cannot be placed in a Job Object from Bun — then tree kill
   needs a native helper, a cost for §10.

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

4. **The harness items.** The running daemon pins `wp.exe`, so the M2
   harness cannot rebuild it (`EPERM`): build to a per-run path or stop the
   daemon first. `bench/ops.ts` spawns its own POSIX-shaped daemon; route it
   through the seam's `spawnDaemon()`. _Done when_ `m2` and `ops` report
   scenario verdicts on `win32-x64` rather than a launcher error. Harness
   shape; no stop condition.

5. **Windows arm64 gated like x64.** The `\\.\pipe\` lock already holds on
   `win32-arm64` (run 33696944598: `x-ls` passes); contend it — a second
   `wp __daemon` against a live one must be refused — and gate the lane on
   what `win32-x64` passes. _Done when_ the contention probe passes on
   `win32-arm64` and `ops` reaches the daemon there. _Wrong if_ a second
   daemon can take the pipe name while the first holds it — then Windows
   arm64 needs a lock primitive that is neither ffi nor a pipe.

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

8. **The release shape.** One build job producing all eight binaries, one
   native smoke lane per target, with `matrix.yml` folded into `poc.yml` or
   kept alongside it — measure both and take the cheaper.
   _Done when_ one dispatch yields eight binaries and a `ci-result-<lane>.json`
   per lane. No stop condition beyond runner limits.

9. **Transport.** Run the M5 spike on macOS. For a Windows client of a remote
   daemon, forward to loopback TCP through `ssh -L`; for the Windows daemon's
   own socket, measure both `AF_UNIX` and loopback TCP with a token file and
   record both, since §10 leaves that choice open. _Done when_ M5's RTT table
   exists for macOS and a Windows `wp` completes `hello` with a remote daemon
   through the forward. _Wrong if_ the forwarded loopback port coalesces or
   drops frames where the Linux forward in
   [`m5.md`](../../packages/werk-poc/findings/m5.md) did not.

**Done** is every lane in `poc.yml` and `matrix.yml` green with no forgiven
suites except the slow-client scenario, on a pinned Bun, with a
`ci-result-<lane>.json` per lane that says so.

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
