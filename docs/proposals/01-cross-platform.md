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

| Target            | Runner             | wasm engine, differential | Daemon from a cross-compiled binary | PoC suites                                              |
| ----------------- | ------------------ | ------------------------- | ----------------------------------- | ------------------------------------------------------- |
| linux-x64-glibc   | `ubuntu-24.04`     | reference                 | starts, answers `ls`                | all pass but the slow-client scenario                   |
| linux-arm64-glibc | `ubuntu-24.04-arm` | identical                 | starts, answers `ls`                | same, plus one test that hard-codes x64                 |
| linux-x64-musl    | Alpine 3.22        | identical                 | starts, answers `ls`                | same; binary needs `libstdc++` and `libgcc_s` installed |
| linux-arm64-musl  | Alpine 3.22 on arm | identical                 | starts, answers `ls`                | same                                                    |
| darwin-arm64      | `macos-latest`     | identical                 | starts, answers `ls`                | same as Linux                                           |
| darwin-x64        | `macos-15-intel`   | identical                 | starts, answers `ls`                | same; no ffi prebuild exists, so ffi tests fail         |
| win32-x64         | `windows-latest`   | identical                 | fails at the lock (§3)              | six suites fail, all from three daemon-layer causes     |
| win32-arm64       | `windows-11-arm`   | identical                 | fails at the lock; no `bun:ffi`     | as x64, plus no ffi engine at all in Bun 1.3.14         |

Three things the table says that the research did not expect:

- **The optional ffi engine is the only part with a platform matrix**, and it
  is missing on two of the eight targets (`darwin-x64` does not build without
  a macOS SDK; `win32-arm64` has no `bun:ffi` in Bun 1.3.14). Since the wasm
  engine was faster than the ffi one on the only machine both were measured
  on ([`m6.md`](../../packages/werk-poc/findings/m6.md)), the matrix is a cost
  without a measured benefit. This proposal treats wasm as the engine on every
  target and the ffi build as reference material.
- **The musl Bun is not static.** Both Alpine lanes show the compiled binary
  linked against `libstdc++.so.6` and `libgcc_s.so.1`, which matters if werk
  runs inside containers it provisions: the image has to carry them, or the
  binary has to be a glibc one on a glibc base.
- **Windows is blocked by three small things, not by the PTY.** §3 records
  what happens once they are stepped over.

## 2. The seam: a platform layer the daemon goes through

The proof of concept reached each platform difference with an inline
`process.platform === "darwin" ? … : …` at the call site. A review of those
commits found the same `alive()` copied three times with the same darwin
branch, two different definitions of "am I running compiled" (one of which is
wrong on Windows, where the embedded path uses backslashes), and `/proc`
reads that return `false` for every live process on any other OS. Fine for a
PoC; the product probably wants one module — call it `platform/` — with one
implementation per OS behind a common interface, and nothing else touching
`process.platform`. The surface, from what the PoC and the spikes actually
needed:

| Concern              | POSIX                                                                              | Windows                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `lock(dir)`          | `flock(LOCK_EX\|LOCK_NB)` via `bun:ffi`                                            | `CreateFileW` + `LockFileEx` via `bun:ffi`; where `bun:ffi` is absent, an exclusive named pipe |
| `runtimeDir()`       | `$XDG_RUNTIME_DIR` → `$TMPDIR/werk-$UID`, mode checked                             | `%LOCALAPPDATA%\werk`; mode and uid checks skipped (Bun reports `40666` and no uid)            |
| `listen()`           | `AF_UNIX` under `runtimeDir()`, bind-and-rename                                    | `AF_UNIX` works for a Bun client; probably loopback TCP plus a token file for anyone else (§3) |
| `spawnDaemon()`      | `detached: true` (`setsid`), `cwd: /`                                              | `detached: true, windowsHide: true`, stdio ignored, `cwd` the home directory                   |
| readiness            | connect and complete `hello` within a deadline                                     | the same; the failure reason comes from the daemon's log file                                  |
| `isAlive(pid)`       | `kill(pid, 0)`                                                                     | `kill(pid, 0)` (works in Bun on Windows)                                                       |
| `rss()`              | `/proc/self/status`, or `ps` on macOS                                              | `process.memoryUsage()`                                                                        |
| `shutdown()`         | `SIGTERM` → grace → `SIGKILL`                                                      | a protocol message → grace → `TerminateProcess`; signals never reach a detached daemon         |
| `interrupt(session)` | `SIGINT` to the foreground group                                                   | write `0x03` to the ConPTY; what dies of it is up to the child's runtime                       |
| `killTree(session)`  | the process group                                                                  | a Job Object with `KILL_ON_JOB_CLOSE`, via `bun:ffi` where present                             |
| socket buffers       | Linux default 208 KiB; macOS 8 KiB, raised via `setsockopt` on the listener's `fd` | unmeasured                                                                                     |
| `defaultShell()`     | `$SHELL` → `/bin/sh`                                                               | probably config → `pwsh` → Windows PowerShell → `%COMSPEC%`; nobody has decided                |

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

A spike ([PR #3](https://github.com/omnilogic-labs/werk/pull/3)) added the
Windows rows of §2 to the proof of concept as `win32` branches and re-ran the
Windows lane. Before it, `wp.exe ls` died at the lock; after it, `wp.exe ls`
starts a daemon and prints its header, the orphan-survival probe passes, and
the test suite runs far enough to hit questions rather than blockers:

- **The render prologue differs.** ConPTY does not start a session with
  `ESC[H ESC[2J`, so a test asserting that exact prefix fails. ConPTY
  re-encodes output rather than passing bytes through — semantically
  equivalent, not byte-identical — which was known from
  [`../research/07-packaging.md`](../research/07-packaging.md) §4 and is now
  measured. Reattach fidelity on a Windows host would need its own oracle.
- **Kill semantics.** `kill` through the protocol is `TerminateProcess`, exit
  code 1, no signal name; a test that waits for a signal to be reported times
  out. This is the `shutdown()`/`interrupt()` row of §2 as a design item.
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
  through ffi needs a non-ffi fallback there; the spike's lock falls back to
  an exclusive `\\.\pipe\` name, verified on x64 and not yet on arm64.

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
feels through any client), the re-encoding above, logoff killing the daemon
(a service or Run-key relaunch is the only cure), the shell question, and
the Job Object work for tree kill. None of these looks like a stopper; all
of them are work that the WSL2 answer avoids. §6 says what that does to the
open question.

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
loss, and the remaining loss is downstream of the socket, most likely in the
fast client's own PTY path in the test harness. The buffer raise is cheap and
best-effort and probably worth keeping; whether the slow-client scenario
should gate anything on macOS is a separate question that this does not
answer. Every peer that streams terminal output over a local socket — tmux,
wezterm, mosh — ignores the kernel buffer and puts the drop-and-redraw policy
in user space, which is what the daemon's bounded queue plus snapshot
re-render already is. A small upstream change exposing the buffer size on
`Bun.listen` would remove the ffi call.

**Signing: every fresh binary is invalid.** A `bun build --compile` output
fails `codesign --verify` on both architectures with "code or signature have
been modified": on arm64 Bun leaves the linker's ad-hoc signature, on Intel
the cross-compiled binary carries Bun's own Developer ID signature, and in
both cases the appended bundle invalidates it. It still runs locally because
nothing has quarantined it. `codesign --force --sign -` repairs it in one
step and the result passes `--strict`. So the first macOS release step is a
re-sign, and `codesign -v` on every Bun bump is the first CI step this
proposes. Beyond that, the path is Developer ID with Bun's JIT entitlement
set, and notarising the zipped binary (a bare executable cannot be stapled,
so first run does an online check, or ship a `.pkg`). The wasm-only engine
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
  assembler, so the wasm engine is implicated). Both hosted x64 runners have
  AVX2, so the fleet cannot measure this. Bun 1.4 ships one x64 binary with
  runtime dispatch; whether that is trustworthy is unverified.
- **musl runtime deps.** `libstdc++.so.6` and `libgcc_s.so.1`, as above.
- **Prebuild lookup on non-x64 compiled binaries.** The libghostty-vt
  binding's own loader fails to find its prebuild inside a compiled binary on
  `linux-arm64` and both musl targets (`Bundled libghostty-vt missing at
/$bunfs/prebuilds/linux-arm64-glibc/…`) while the PoC's shim finds it. Only
  relevant if the ffi engine ships; recorded because it is the kind of thing
  that reads as "arm64 is broken" when it is not.

The slow-client scenario fails on every 4-vCPU hosted Linux lane for the
reason [`platforms.md`](../../packages/werk-poc/findings/platforms.md)
records — the fast client's own queue crosses the drop bound on shared
CPUs — and the lanes forgive exactly that one failure. Whether it should be
a gate at all, be scaled to the machine, or be split into a deterministic
fidelity check and a recorded headroom number, is open; "measured, not
gated" is what the lanes do today and probably the right default.

## 6. What the measurements do to the open questions

- **Windows as host** ([`../product/04-open-questions.md`](../product/04-open-questions.md) §4).
  The measured costs of hosting on Windows are output re-encoding, kill
  being `TerminateProcess` with graceful teardown moved into the protocol,
  ConPTY latency, and WSL2 teardown if that is the placement; `AF_UNIX` is
  not one of them. The lean towards client-first with WSL2 as the documented
  placement probably still holds on effort grounds — the seam is small but
  the ConPTY semantics behind it are real work — but nothing measured says
  the platform blocks native hosting.
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

| What                                                    | Where                                                                      | Run                                                                            |
| ------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| The three original lanes, on `main`, Windows re-run     | [`poc.yml`](../../.github/workflows/poc.yml)                               | [33686941407](https://github.com/omnilogic-labs/werk/actions/runs/33686941407) |
| Lane gates made fail-closed                             | [PR #4](https://github.com/omnilogic-labs/werk/pull/4)                     | [33688264859](https://github.com/omnilogic-labs/werk/actions/runs/33688264859) |
| Eight targets built on Linux, smoked on native runners  | [PR #5](https://github.com/omnilogic-labs/werk/pull/5), `matrix.yml`       | [33689751325](https://github.com/omnilogic-labs/werk/actions/runs/33689751325) |
| macOS socket buffers, signing, process lifecycle probes | [PR #2](https://github.com/omnilogic-labs/werk/pull/2), `macos-probes.yml` | [33688130745](https://github.com/omnilogic-labs/werk/actions/runs/33688130745) |
| The daemon with buffers raised, on the macOS lane       | PR #2, `poc.yml`                                                           | [33688537937](https://github.com/omnilogic-labs/werk/actions/runs/33688537937) |
| Windows primitives probed directly                      | [PR #3](https://github.com/omnilogic-labs/werk/pull/3), `win32-spike.yml`  | [33691536664](https://github.com/omnilogic-labs/werk/actions/runs/33691536664) |
| The Windows lane with the three blockers stepped over   | PR #3, `poc.yml`                                                           | [33690884893](https://github.com/omnilogic-labs/werk/actions/runs/33690884893) |

The cheap way to ask any further question is the same: a branch, a workflow
with a `push` trigger scoped to it (or `gh workflow run poc.yml --ref
<branch>` for a workflow already on `main`), and a probe that prints one
verdict line per question and never throws. Nothing needs to land on `main`
to be measured.

## 8. What would change the answer

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

## 9. What this does not settle

Whether Windows is a host. Whether the daemon should ever be supervised by
launchd or a Windows service. Which Windows shell is the default. Whether
the ffi engine ships at all. Whether `darwin-x64` ships at all. Whether the
slow-client scenario gates CI or only records. Whether the Windows socket is
`AF_UNIX` or loopback TCP. Each is named where it comes up and left open.
