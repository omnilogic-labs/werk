# platforms

What the proof of concept does on macOS and Windows, measured on GitHub's
hosted runners, next to the same suites on Linux — and what a cross-compiled
binary does on every other target Bun can build for.

Every other file in this directory records one machine: linux-x64-glibc under
WSL2. This one records eight, none of them that machine. It is written to be
audited rather than believed: every claim below names the run, the artefact
and the file it came from, and the section at the end says what to re-run to
check any of it.

## What this is not

No decision is recorded here. Where a measurement suggests something about
werk's design, the suggestion is left open and labelled as one. Several rows
below are single observations on a single image, and a few are the first
measurement anyone has taken of the thing at all.
[`../../../docs/proposals/01-cross-platform.md`](../../../docs/proposals/01-cross-platform.md)
is where the measurements are turned into a proposal.

## How it was run

`.github/workflows/poc.yml` runs the PoC's suites on one lane per operating
system. Every suite step carries `continue-on-error`, so a run reports every
suite's verdict rather than stopping at the first red one, and each job
uploads a `ci-result-<os>.json`. The tables below are that JSON, not a
retelling of it.

| Lane           | Runner           | Commit    | Run                                                                            | Job      |
| -------------- | ---------------- | --------- | ------------------------------------------------------------------------------ | -------- |
| Linux          | `ubuntu-latest`  | `fddf0a7` | [33671844640](https://github.com/omnilogic-labs/werk/actions/runs/33671844640) | 118 s    |
| macOS          | `macos-latest`   | `f791183` | [33672982212](https://github.com/omnilogic-labs/werk/actions/runs/33672982212) | 2 m 24 s |
| Windows        | `windows-latest` | `0265837` | [33696942295](https://github.com/omnilogic-labs/werk/actions/runs/33696942295) | 6 m 18 s |
| win32 VT build | both             | —         | [33671709842](https://github.com/omnilogic-labs/werk/actions/runs/33671709842) | 1 m      |

The three lanes together ran as
[33696942295](https://github.com/omnilogic-labs/werk/actions/runs/33696942295)
on commit `0265837`, the head of `main`, green on every lane. Green does not
mean every suite passed: each lane gates on the suites that platform already
passes, so that a red lane means something regressed. Read the JSON rather
than the badge. On `main` the Windows lane records 5 non-passing suites (four
fail, one skip); Linux and macOS record 2 each.

The Linux and macOS tables below are from runs before the daemon's `win32`
branches and the macOS socket-buffer raise landed; the merged run's Linux and
macOS JSON record the same verdicts, suite for suite, so the earlier tables
stand. The Windows table is the merged run.

Bun is pinned to 1.3.14 on all three, matching the `bun-types` pin and the
version the rest of `findings/` was measured on. Nothing needs the network
beyond `bun install`. No runner needed a package installed: the ubuntu image
already carries vim, top, tmux and jq.

Further runs, on the branches that have since merged into `main`, are cited
below by number:

| Run                                                                            | Branch                                                 | What                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [33686941407](https://github.com/omnilogic-labs/werk/actions/runs/33686941407) | `main` at `55cee97`                                    | the Windows lane before the daemon had `win32` branches; the "before" column of the Windows table below                                                                                                                                                                                                                                                                        |
| [33688130745](https://github.com/omnilogic-labs/werk/actions/runs/33688130745) | [PR #2](https://github.com/omnilogic-labs/werk/pull/2) | macOS probes: socket buffers, `codesign`, process lifecycle, on `macos-latest` and `macos-15-intel`                                                                                                                                                                                                                                                                            |
| [33688537937](https://github.com/omnilogic-labs/werk/actions/runs/33688537937) | PR #2                                                  | the macOS lane with the daemon's socket buffers raised; [33688881377](https://github.com/omnilogic-labs/werk/actions/runs/33688881377) is the same image with them left at default                                                                                                                                                                                             |
| [33691536664](https://github.com/omnilogic-labs/werk/actions/runs/33691536664) | [PR #3](https://github.com/omnilogic-labs/werk/pull/3) | Windows primitives probed directly, `windows-latest`                                                                                                                                                                                                                                                                                                                           |
| [33690884893](https://github.com/omnilogic-labs/werk/actions/runs/33690884893) | PR #3                                                  | the Windows lane with `win32` branches in the daemon's lock, launcher and paths                                                                                                                                                                                                                                                                                                |
| [33689751325](https://github.com/omnilogic-labs/werk/actions/runs/33689751325) | [PR #5](https://github.com/omnilogic-labs/werk/pull/5) | eight targets cross-compiled on one Ubuntu job and run on eight native lanes, before the `win32` branches                                                                                                                                                                                                                                                                      |
| [33696944598](https://github.com/omnilogic-labs/werk/actions/runs/33696944598) | `main` at `0265837`                                    | the same eight lanes on the merged tree                                                                                                                                                                                                                                                                                                                                        |
| [33701438138](https://github.com/omnilogic-labs/werk/actions/runs/33701438138) | `step/07-linux-musl` at `789b481`                      | the same eight lanes with the compiled-binary test host-derived, and the Linux lanes recording what a musl host carries and what AVX the CPU offers                                                                                                                                                                                                                            |
| [33705813223](https://github.com/omnilogic-labs/werk/actions/runs/33705813223) | `step/04-harness` at `9918e71`                         | the Windows lane with the M2 harness building to a path of its own and `ops` spawning through the seam; [33706143058](https://github.com/omnilogic-labs/werk/actions/runs/33706143058) and [33706712733](https://github.com/omnilogic-labs/werk/actions/runs/33706712733) are all three lanes on that tree, verdict for verdict identical to the merged run on Linux and macOS |
| [33705737351](https://github.com/omnilogic-labs/werk/actions/runs/33705737351) | `step/03-conpty-oracle`                                | ConPTY's re-encoding compared six ways, and `daemon.test.ts` with and without the test that times out                                                                                                                                                                                                                                                                          |
| [33706788925](https://github.com/omnilogic-labs/werk/actions/runs/33706788925) | `step/03-conpty-oracle`                                | the Windows lane with the fidelity oracle on the grid and `test-full` run one process per file                                                                                                                                                                                                                                                                                 |
| [33710644108](https://github.com/omnilogic-labs/werk/actions/runs/33710644108) | `main` with every Windows step merged                  | the three lanes with the seam, teardown through the protocol, the grid oracle and the harness items all in place                                                                                                                                                                                                                                                               |

### ubuntu-latest

`Linux 6.17.0-1022-azure x86_64, image ubuntu24/20260823.283.1, runner arch X64` · Bun 1.3.14 · commit `fddf0a7` · [run 33671844640](https://github.com/omnilogic-labs/werk/actions/runs/33671844640)

| Suite       | Result | Time   | What the run recorded                                                                                                |
| ----------- | ------ | ------ | -------------------------------------------------------------------------------------------------------------------- |
| `install`   | pass   | 0.2 s  | 18 packages installed [143.00ms]                                                                                     |
| `format`    | pass   | 5.6 s  | all matched files use Prettier code style                                                                            |
| `typecheck` | pass   | 4.0 s  | tsc --noEmit clean for both tsconfigs                                                                                |
| `test-pure` | pass   | 1.4 s  | Ran 113 tests across 10 files. [1387.00ms]                                                                           |
| `build-web` | pass   | 0.0 s  | src/web/bundle/app.js is 104626 bytes                                                                                |
| `build`     | pass   | 0.4 s  | dist/wp is 103270528 bytes; caps lists 13 matrix rows                                                                |
| `test-full` | fail   | 55.3 s | Ran 168 tests across 22 files. [55.30s] — failing: (fail) reattach fidelity: every scenario passes (spikes/m2/run-a… |
| `m0`        | pass   | 24.2 s | 14/14 probe cells pass across 1.3.14 interpreted, 1.3.14 compiled                                                    |
| `m2`        | fail   | 14.6 s | 7 scenarios pass, 1 fail — slow client: one wp attach SIGSTOPped under yes \| head -c 4M                             |
| `m3`        | pass   | 0.8 s  | snapshot-cost and cross-commit ran; 3 ghostty tip builds not on disk (only the pinned one is committed)              |
| `ops`       | pass   | 0.7 s  | toolchain, platform matrix and cold start reported; ghostty-ffi prebuilds: darwin-arm64, linux-arm64-glibc, linux-a… |
| `diff`      | pass   | 1.5 s  | 23 corpus cases, three engines: 49 of 69 pairwise cells agree, 20 differ (reported, never scored)                    |

### macos-latest

`arm64/macOS-26.5.2` · Bun 1.3.14 · commit `f791183` · [run 33672982212](https://github.com/omnilogic-labs/werk/actions/runs/33672982212)

| Suite       | Result | Time   | What the run recorded                                                                                                |
| ----------- | ------ | ------ | -------------------------------------------------------------------------------------------------------------------- |
| `install`   | pass   | 0.3 s  | 18 packages installed [221.00ms]                                                                                     |
| `typecheck` | pass   | 3.2 s  | $ tsc --noEmit && tsc --noEmit -p src/web/client                                                                     |
| `test-pure` | pass   | 1.1 s  | 113 pass 0 fail                                                                                                      |
| `build-web` | pass   | 0.1 s  | web bundle: 104626 B in 5 ms -> /Users/runner/work/werk/werk/packages/werk-poc/src/web/bundle/app.js                 |
| `build`     | pass   | 0.4 s  | \| `encodeMouse` \| yes \| no \| no \|                                                                               |
| `test-full` | fail   | 67.2 s | 167 pass 1 fail \| xterm.js: Parsing error: {                                                                        |
| `m0`        | pass   | 24.8 s | 01-pty-basic= pass pass 02-sigint= pass pass 03-sigwinch= pass pass 04-exit-contract= pass pass 05-daemon-survives=… |
| `m2`        | fail   | 16.2 s | 1 FAIL 7 pass \| FAIL slow client: one wp attach SIGSTOPped under yes \| head -c 4M                                  |
| `m3`        | pass   | 0.9 s  | \| 3c1ef5b3 \| 3c1ef5b3 (same bytes) \| **identical** \| 1092 \| 0.40 ms \| 0.03 ms, 0 pages \| \|                   |
| `ops`       | pass   | 0.6 s  | \| interpreted (bun run src/cli/main.ts): wp ls, daemon up \| 3 \| 26.6 ms \| 40.6 ms \| 41.9 ms \|                  |
| `diff`      | pass   | 1.5 s  | engine-pair verdicts: 49 agree, 20 differ                                                                            |

### windows-latest

`X64/Windows win25-vs2026 20260824.214.3 nt-10.0.26100` · Bun 1.3.14 · commit `0265837` (`main`) · [run 33696942295](https://github.com/omnilogic-labs/werk/actions/runs/33696942295)

| Suite       | Result | Time    | What the run recorded                                                                                                |
| ----------- | ------ | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `install`   | pass   | 1.8 s   | 18 packages installed [1.72s]                                                                                        |
| `typecheck` | pass   | 7.9 s   | $ tsc --noEmit && tsc --noEmit -p src/web/client                                                                     |
| `test-pure` | pass   | 1.9 s   | Ran 113 tests across 10 files. [1.75s]                                                                               |
| `build-web` | pass   | 0.2 s   | web bundle: 104626 B in 13 ms -> D:\a\werk\werk\packages\werk-poc\src\web\bundle\app.js                              |
| `build`     | pass   | 1.0 s   | \| `encodeMouse` \| yes \| no \| no \|                                                                               |
| `diff`      | pass   | 29.1 s  | \| sequences \| xterm-oracle \| 200/200 \|                                                                           |
| `ops`       | fail   | 10.4 s  | error: daemon did not answer on C:\Users\RUNNER~1\AppData\Local\Temp\wp-ops-cold-aSqjIz\run-interpreted-bun-run-src… |
| `probes`    | pass   | 0.5 s   | 21 probe verdicts, 1 fail: readiness-pipe-read — all on the known-fail list                                          |
| `m0-probes` | fail   | 26.7 s  | m0 probes not passing: 01-pty-basic 02-sigint 06-raw-mode                                                            |
| `daemon`    | skip   | —       | did not run: the step runs `wp __daemon` in the foreground and hits its 2-minute timeout, because the daemon runs    |
| `wp-cli`    | pass   | 0.4 s   | ID COMMAND ENGINE STATUS TITLE AGE SNAPSHOT CLIENTS                                                                  |
| `test-full` | fail   | 133.7 s | error: daemon did not answer on C:\Users\RUNNER~1\AppData\Local\Temp\wp-ops-cold-MPizuq\run-interpreted-bun-run-src… |
| `m2`        | fail   | 0.9 s   | error: build failed: $ bun run build:web && bun build --compile ./src/cli/main.ts --outfile ./dist/wp                |
| `m3`        | pass   | 5.2 s   | \| 3c1ef5b3 \| 3c1ef5b3 (same bytes) \| **identical** \| 1092 \| 0.58 ms \| 0.02 ms, 0 pages \| \|                   |

In that run the `daemon` step ran `wp __daemon` in the foreground and, since
the daemon now keeps running, hit its timeout and was recorded as `skip`. The
step has since become a real suite (`.github/ci/windows-daemon.ts`): it
starts the daemon into a private runtime directory, completes `hello`, `ls`
and `stats`, sends `shutdown`, and waits for the process to go. On
[run 33697939359](https://github.com/omnilogic-labs/werk/actions/runs/33697939359)
it passes in 443 ms — `hello` at 82 ms, `ls` at 83 ms, exited 212 ms after
`shutdown` — and the Windows lane gates on it. The `wp-cli` row is the same
daemon started the way `wp` starts it, answering `ls`. Two stop steps before
`test-full` and `m2` shut down any daemon an earlier suite left, so the
running daemon no longer pins `wp.exe`; `m2` then fails on
`terminal is disposed` rather than `EPERM`.

`m3` sometimes does not exit on Windows — it printed its tables and then hung
to the 180 s step timeout on run 33684207403 and to 600 s on the `win32-arm64`
lane of run 33689751325, and exited normally on all three Windows jobs of the
merged runs — so the Windows lane keeps it out of the gate.

## macOS

### The PTY is the controlling terminal on macOS too

From `dist/m0/1.3.14/02-sigint.interpreted.log` in the run's artefact,
identically in the compiled cell:

```
RESULT {"probe":"02-sigint","status":"pass","bun":"1.3.14","compiled":false,
  "summary":"0x03 delivers SIGINT; PTY is the controlling terminal",
  "details":{"childTty":"000",
    "ps":{"pid":2612,"ppid":2611,"pgid":2612,"sid":2612,"tty":"ttys000","stat":"S<s+"},
    "controllingTerminal":true,"shellTrapFired":true,
    "sleepDiedOfSignal":"SIGINT","sleepExitCode":null,"bunChildTrapFired":true}}
```

`sid == pgid == pid` on `ttys000`, with `STAT` `S<s+` — `s` for session
leader, `+` for foreground process group. Three witnesses agree: a bash trap
on `INT` fires from `0x03`, a plain `sleep` dies of `SIGINT`, and a Bun
child's own handler runs. `03-sigwinch` passes as a fourth, and needed no
macOS-specific change to reach that verdict, which is part of why the verdict
is worth something. `src/daemon/daemon.test.ts`'s `trap 'stty size' WINCH`
test agrees. [`m0.md`](./m0.md) §2 records the same result on Linux and the
Bun issue that neither reproduces.

### The `darwin-arm64` ffi prebuild

A compiled `wp` extracts the pair to
`$TMPDIR/werk-poc-libghostty-vt-0.6.3/darwin-arm64/` at mode 0755 and
dlopens it with no Gatekeeper, codesigning or quarantine trouble, the shim
resolving the main library through `@loader_path`. All eight `ffi.test.ts`
cases pass and `src/daemon/ffi-engine.test.ts` runs a real session on it.

On the differential corpus the `darwin-arm64` build and the
`linux-x64-glibc` one produce reports that are byte-identical: 23 cases, 69
engine-pair verdicts (49 agree, 20 differ), the reattach table, and every
per-cell diff listing. The 20 disagreements are the same 20. Whatever the ffi
adapter's gaps are, they do not appear to be properties of a platform.

### Back-pressure: an 8 KiB socket buffer against Linux's 208 KiB

The one place macOS behaves differently under load. `net.local.stream.sendspace`
and `recvspace` are 8192 — XNU's default, measured identical on the arm64 and
the Intel runner in run 33688130745 — against 212992 on Linux. A daemon that
does not ask for more begins short-writing after about 8 KB rather than about
218 KB:

|                                          | linux-x64              | macOS arm64    |
| ---------------------------------------- | ---------------------- | -------------- |
| `net.local.stream.sendspace`             | 212992                 | 8192           |
| bytes taken before the first short write | 218,143                | 7,919          |
| fast-client lag episodes / bytes dropped | 0 / 0                  | 24 / 7,076,521 |
| fast client received                     | 2,097,152 of 2,097,152 | 228,761        |
| daemon RSS during the flood              | 67.4 MiB               | 124.0 MiB      |

Under M2's 4 MiB burst that is enough for the daemon's queue bound to be
crossed by a client that never lags on Linux; it is dropped and re-rendered
two dozen times, and the fidelity check that replays everything a client
received then fails.

Bun 1.3.14 documents no way to set a socket buffer, but the listener
`Bun.listen` returns and every socket it accepts expose a numeric `fd`
(`Bun.listen({ fd })` itself is refused), and `setsockopt` on that fd through
`bun:ffi` works. The probes in run 33688130745 bound where the limit sits:
raising the client's `SO_RCVBUF` alone, or both ends on the client, leaves
the short-write threshold at 8192; `setsockopt(listener.fd, SO_SNDBUF,
212992)` before the first accept is inherited by every accepted socket and
moves the threshold to 212992, Linux's figure, and setting it on an accepted
socket after the fact has the same effect. The bound is the sender's
`SO_SNDBUF` on the accepted socket.

The daemon makes that call through `src/platform/posix.ts`, best-effort and
darwin only, with `WP_SNDBUF` in the daemon's environment to size it or (`0`)
switch it off. The macOS lane ran with it on (run 33688537937) and off (run
33688881377), the same image both times:

|                                          | buffers at default | buffers at 212992 |
| ---------------------------------------- | ------------------ | ----------------- |
| bytes taken before the first short write | 8,560 / 8,568      | 213,412 / 213,297 |
| fast-client lag episodes                 | 20 / 22            | 4 / 3             |
| fast-client bytes lost                   | 6.44 M / 6.61 M    | 6.30 M / 6.91 M   |
| fast client received                     | 302,448 / 247,032  | 343,180 / 197,032 |
| slow client received before cutoff       | 11,047             | 264,388           |
| daemon RSS                               | —                  | 88–92 MiB         |
| `m2` / `test-full`                       | fail / 167 + 1     | fail / 167 + 1    |

The kernel buffer accounts for most of the lag episodes and none of the bytes
lost. The sink accounts for neither. The fast client's `wp attach` runs under
[`pty-cat.ts`](../spikes/m2/pty-cat.ts), which offers three of them —
`WP_M2_SINK` picks one — and each takes one more thing out of the path
between the client and the bytes on disk: a PTY, as a terminal gives a
client; a pipe, with no line discipline; and a regular file the client writes
itself, which applies no back-pressure and asks nothing of the harness. Run
33703344148 ran the scenario once per sink on the one runner:

| fast client                 | pty sink  | pipe sink | file sink |
| --------------------------- | --------- | --------- | --------- |
| lag episodes                | 8         | 6         | 6         |
| bytes lost                  | 5,794,584 | 5,794,161 | 6,442,096 |
| bytes delivered             | 1,926,716 | 1,816,633 | 1,456,344 |
| lines received of 2,097,152 | 538,540   | 520,462   | 400,028   |
| flood typed to marker seen  | 3,276 ms  | 3,032 ms  | 2,673 ms  |
| short writes / drains       | 8 / 8     | 8 / 8     | 6 / 6     |

So the loss is upstream of the client's own fd 1, and the harness is not what
was losing it. What the three sinks have in common is the rate: the daemon
delivers 1.5–1.9 MB to a client that cannot be blocking, and its queue for
that client sits at the 262,144 B bound with six to eight short writes on a
socket whose send buffer is 212,992 B.

Put beside the same scenario on Linux, that rate looks like the whole story.
The hosted `ubuntu-latest` lane, four vCPUs, delivered 5.9 MB in 1,649 ms and
lost 0.4 MB on one attempt, 4.2 MB in 1,232 ms and lost 2.1 MB on another an
hour later (runs 33702651201 and 33703344148); the eight-core machine
[m2](./m2.md) was measured on loses nothing under any of the three sinks and
reaches the marker in about 700 ms. Three machines, one scenario, a loss that
tracks how fast the bytes move rather than anything a client did, and that
varies from attempt to attempt wherever the CPU is shared.

Where the macOS difference goes — Bun's socket write on XNU, the client's
read loop, the daemon's own event loop with the wasm engine on it, or how
much CPU a three-process scenario gets on a shared runner — is not something
these numbers separate, and nobody has measured it. What they do say is that
the scenario's bound is a time budget rather than a size, which is what
[m2](./m2.md#a-slow-client-does-not-stall-a-fast-one-end-to-end) already
found from the other end: a client that pauses for ~50 ms is a lagging
client, and here nothing is pausing and the budget is still spent. Whether
the bound wants to be larger, expressed in time, or split into a
deterministic fidelity check and a recorded headroom figure is open, as is
whether this scenario should gate macOS at all while it measures the
machine's throughput as much as the drop policy. Whether werk should set
`SO_SNDBUF` on its listener, accept that a macOS client lags sooner and leans
harder on the re-render path, or both, is not settled here either; the raise
is cheap and does what it claims, and that is all this says.

`TMPDIR` was expected to matter, because `sun_path` is 104 bytes on macOS
against 108 on Linux and the runner's own `$TMPDIR` is a 49-character
`/var/folders/…/T/` path. A run on the runner's own `$TMPDIR` reaches
identical verdicts — sockets land around 80 characters — so the margin is
there on this image. The job sets `TMPDIR=/tmp` anyway, for a deeper
temporary directory than this one.

### Every fresh compiled binary fails `codesign --verify`

From run 33688130745, on both architectures. A `bun build --compile` output
on arm64 carries flags `0x20002` (ad hoc, linker-signed); on Intel, `0x10000`
(runtime), which on the cross-compiled binary of run 33689751325 is Bun's own
Developer ID signature. Both fail `codesign --verify` (strict and lax) and
`spctl` with "invalid signature (code or signature have been modified)": the
appended bundle invalidates whatever signature the Bun executable arrived
with. The binary runs anyway on the runner, because nothing has set a
quarantine attribute on it. `codesign --force --sign -` repairs it in one
step; the result passes `--verify --strict` and runs.

So both darwin lanes re-sign and then verify. The `poc` macOS lane signs
`dist/wp` inside its `build` suite and gates a `codesign` suite on
`codesign --verify --strict` (run 33703344148: `flags=0x2(adhoc)`, "valid on
disk"). The matrix lanes verify the natively built binary the same way, and
re-sign the cross-compiled one first, since it arrives from a Linux job that
can sign nothing (run 33703355321, both `darwin-arm64` and `darwin-x64`:
`x-codesign` and `native-codesign` pass, where on run 33696944598 all four
failed). A Bun bump that changes what `--compile` leaves behind is then a red
lane rather than a discovery at release time.

The extracted `darwin-arm64` ffi dylibs are ad hoc linker-signed, verify
clean and carry no quarantine attribute. There is no `darwin-x64` prebuild to
check; `wp caps` on the Intel runner reports
`ghostty-ffi did not load: no embedded libghostty-vt prebuild for darwin-x64`.

### Process lifecycle

Two probes from the same run. The "responsible process" of a detached child,
which is what TCC consults, is the ancestor that launched it — on the runner,
the runner agent — and is readable only under `sudo launchctl procinfo`. A
daemon a user starts from a terminal would inherit that terminal's grants; a
LaunchAgent would be its own responsible process and start with none.

Bun issue #40289, a spontaneous `exit` for detached children on macOS, did
not reproduce: 0 of 50 attempts on each of the arm64 and Intel lanes, with
and without a terminal attached.

## Windows

The proposal and Bun's own types both say the PTY is the hard floor here:
`bun-types@1.3.14/bun.d.ts:7019` documents `Bun.Terminal` as _"Only available
on POSIX systems (Linux, macOS)"_. The run does not agree with the
documentation. The daemon locks, starts, detaches and answers `ls` on `main`
through `win32` branches in its lock, launcher, paths and server; what stops
the suites is above the PTY, in what ConPTY does to the byte stream and what
a kill means.

### Where each layer stands

Everything in this section is `windows-latest`, x64, Bun 1.3.14. The
primitives were measured directly by the probe workflow of run 33691536664,
and the `probes` suite of the Windows lane re-runs them on every run.

**1. `bun:ffi` works.** `dlopen("kernel32.dll", { GetCurrentProcessId })` loads
and the call returns the process id.

**2. The lock is `LockFileEx`.** `src/platform/posix.ts` names POSIX
libraries on Linux and macOS; `src/platform/win32.ts` opens the lock file
with `CreateFileW` and takes one byte at offset 0 with `LockFileEx` out of
`kernel32.dll`. A
second taker gets `ERROR_LOCK_VIOLATION` (33); the lock is released on
`CloseHandle` and on process death, about 7 ms after it. Opening the lock
file with share mode 0 is exclusive too (`ERROR_SHARING_VIOLATION`, 32).
Where `bun:ffi` is absent, the lock is an exclusive
`\\.\pipe\werk-poc-lock-<hash>` listener through `Bun.listen`, which needs no
ffi at all; `WP_WIN32_LOCK=pipe` forces it on x64, and it is the lock the
`win32-arm64` daemon holds (run 33696944598, below). It refuses a second
taker where it has to — see "The pipe lock, contended" below. Asking Windows for
`libc.so` returns error 126, `ERROR_MOD_NOT_FOUND`, which is what the daemon
died of before the branch existed:

```
error: cannot dlopen libc for flock: Error: Failed to open library "libc.so": error code 126
      at loadLibc (packages\werk-poc\src\daemon\flock.ts:34:13)
      at daemonMain (packages\werk-poc\src\daemon\main.ts:66:16)
```

**3. `Bun.listen({ unix })` is a Winsock `AF_UNIX` socket, and the file is
there.** Both a filesystem path and a `\\.\pipe\` name round-trip bytes:

```
PROBE unix-socket-fs-path:    ok — listen and connect round-tripped "ping" (address on disk: no)
PROBE unix-socket-named-pipe: ok — listen and connect round-tripped "ping" (address on disk: yes)
```

"Address on disk: no" is what Bun's `existsSync` says, and it is wrong. The
path is a reparse point (`IO_REPARSE_TAG_AF_UNIX`): `existsSync` returns
false, `lstat` and `stat` fail with `EACCES`, and a directory listing reports
the entry as a symlink. Bun unlinks it on `stop()`. A killed daemon's file
refuses a rebind until it is unlinked; renaming a fresh socket over a stale
one works; a second listen on a live socket is refused. So the daemon's
bind-and-rename holds on Windows provided the stale file is removed first,
which `server.ts` does, and the lock is probably what should prove it stale.
The `EACCES` is not Bun's alone: Node's `stat` fails on the same path, which
is why `actions/upload-artifact` refuses a directory with a live socket in
it (run 33696944598, below). The socket is reachable from Bun and from
little else: Node and libuv reach only `\\.\pipe\` names, and Win32-OpenSSH
forwards neither sockets nor pipes
([`../../../docs/research/09-remote-transport.md`](../../../docs/research/09-remote-transport.md)
§3).

**4. Readiness is a polled file, because the pipe cannot be read.** On POSIX
`src/daemon/launch.ts` spawns the daemon with a fourth stdio pipe and reads
the child's readiness report off it with `fs.readSync`. On Windows
`proc.stdio[3]` comes back as a number that `fs.readSync` will not take:

```
EBADF: bad file descriptor, read
      fd: 744, syscall: "read", errno: -9, code: "EBADF"
      at readPipe (packages\werk-poc\src\daemon\launch.ts:100:14)
      at ensureDaemon (packages\werk-poc\src\daemon\launch.ts:133:25)
```

The number is a raw pipe HANDLE (`GetFileType` says 3), and no method tried
in run 33691536664 reads from the parent's end of it in Bun 1.3.14; the
child's fd 3 writes fine. So on Windows the launcher passes `--ready-file`,
the daemon writes it atomically, and the launcher polls it; the `probes`
suite records `readiness-pipe-read` as a known failure on every run. Before
the ready file, this single error was what `wp.exe ls`, all eight M2
scenarios and five whole test files died of (run 33686941407).

**5. `Bun.Terminal` is documented POSIX-only and works anyway.** A real
ConPTY, from the probe output:

```
PROBE spawn-terminal: ok — the child wrote 102 bytes to the terminal:
  "\u001b[?9001h\u001b[?1004h\u001b[?25l\u001b[2J\u001b[m\u001b[Hhello-from-…
```

`ESC[?9001h` is win32-input-mode. `stty size` returns the requested `24 80`,
`data` and `exit` callbacks fire, and the behaviour is identical compiled and
interpreted. `03-sigwinch` and `04-exit-contract` pass outright. `01-pty-basic`
is scored fail only because it asserts a `/dev/pts/N` slave name;
`06-raw-mode` because the `stty` flags it reads through MSYS do not change
between modes.

Signals under ConPTY: `0x03` reaches a bash trap (exit 42), and a plain MSYS
`sleep` dies of it — its raw exit status is `0x200`, signal number shifted
left eight bits, which Bun truncates to a byte and reports as 0;
`GetExitCodeProcess` via ffi says 512. `02-sigint` reads that 0 as "no
signal" and fails. A `pwsh -c Start-Sleep` ignores `0x03` for at least six
seconds.

Detachment: a child spawned `detached: true` survives its parent exiting and
survives the parent's ConPTY closing, judged by a tick file it keeps writing
and `kill(pid, 0)` six seconds after `terminal.close()`; the parent itself
dies of the close with exit code 58. `05-daemon-survives` judges liveness
that way too, because MSYS `ps` never reports `sid == pid` for a native
process, and passes. `proc.kill(anything)` on a detached child is
`TerminateProcess` with exit code 1: no handler fires, and Bun reports the
requested `signalCode` regardless.

Latency: `07-latency` passes at **p50 15.6 ms, p99 23.4 ms** in process,
against 59–95 µs on Linux — roughly 200× slower. The socket relay adds
nothing measurable (p50 15.6 ms via the relay), so on this image the cost
appears to be ConPTY itself.

**6. `win32-x64` has a prebuild because one was vendored.** The npm tarball
ships none; `ffiPlatform()` returns `win32-x64` and the load path finds the
DLL described below, which is why `test-pure` passes on the Windows lane.

Five Bun-on-Windows facts, recorded so nobody finds them again:

- A `u32` argument in `bun:ffi` given a negative JavaScript number arrives as 0. `GENERIC_READ | GENERIC_WRITE` is negative in JavaScript; use
  `FILE_GENERIC_READ | FILE_GENERIC_WRITE` (`0x12019F`).
- `_get_osfhandle` from `ucrtbase.dll` on a Bun file descriptor kills the
  process with exit 9 and no message; Bun's CRT is not `ucrtbase`. Open with
  `CreateFileW` directly when a HANDLE is needed.
- `import.meta.path` inside a compiled Windows binary is `B:\~BUN\root\…`
  with backslashes. A check for `B:/~BUN/` makes `wp.exe` believe it is
  interpreted.
- On `windows-11-arm`, Bun 1.3.14 has no `bun:ffi` at all
  (`bun:ffi dlopen() is not available in this build (TinyCC is disabled)`).
- One `expect(promise).rejects` hangs under `bun test`.
  `.github/ci/win32-kill.test.ts` asks the daemon for a session it has already
  removed, three ways, on both Windows runners (run 33707210922): caught with
  `catch` the error comes back in under a millisecond, and through
  `expect().rejects` the assertion hangs to the test's timeout — after which
  `bun test` kills the daemon it started and every later test in the file
  says `connection closed`. `expect().rejects` on an already-rejected promise
  is fine in the same file, and so is the `expect().rejects` that
  `daemon.test.ts` uses for an unknown engine, so this is not "`rejects` is
  broken on Windows"; what separates the two is not known. That one line was
  the whole of the kill test's five seconds, and catching the rejection
  instead is what lets the file run to the end.

Three smaller facts from the same probes: `mkdir` reports mode `40666`,
`getuid` is undefined, and `LOCALAPPDATA` is set where `XDG_RUNTIME_DIR` is
not.

### ConPTY re-encodes, and it is the cells that survive it

A ConPTY does not pass a child's bytes on. It keeps a screen of its own and
emits whatever it thinks brings the host terminal to that screen, so the
proof of concept's assertions about what a session sends cannot hold here.
The `probes` suite runs the same scripted session six times and compares the
byte streams and the cell grids the wasm engine ends up with, so the question
is measured rather than argued.

The session `daemon.test.ts` drives — a shell, a prompt, `echo hi` typed in —
comes back as 174 bytes:

```
\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[Hhello\r\n
\x1b]0;C:\Program Files\Git\usr\bin\sh.exe\x07\x1b[?25h
\x1b[?2004hsh-5.3$ echo hi\x1b[?2004l\x1b[?2004h\r\nhi\r\n
sh-5.3$ exit\x1b[?2004l\r\nexit\r\n\x1b[?9001l\x1b[?1004l
```

`echo hi\r\nhi\r\n`, which a POSIX pty sends and which the test used to look
for, is not in there: the bracketed-paste toggles sit between the echoed
command and its output, and an OSC 0 title arrives unasked.

| Same input, six sessions                   | bytes                                                    | cells and cursor                       |
| ------------------------------------------ | -------------------------------------------------------- | -------------------------------------- |
| a script that writes three lines and exits | identical, 131 B, every run                              | identical                              |
| a shell with `echo hi` typed into it       | identical in two runs of the job, five of six in a third | identical in all three runs of the job |

The one session that differed was the same 174 bytes with the toggles moved:
`sh-5.3$ ` then `ESC[?2004l ESC[?2004h` then `echo hi`, where the other five
put `echo hi` first. Its grid is the same grid, down to the hash — and that
hash, `90491758d1d4`, is the same across separate jobs on different machines
([33704865317](https://github.com/omnilogic-labs/werk/actions/runs/33704865317),
[33705104981](https://github.com/omnilogic-labs/werk/actions/runs/33705104981),
[33705737351](https://github.com/omnilogic-labs/werk/actions/runs/33705737351)).

So a recorded ConPTY prologue could not be a fidelity oracle here and the
grid can. `src/daemon/_grid.ts` is that oracle for the daemon tests: it
replays everything one attached client received into a fresh terminal of the
session's size and holds the result against the daemon's own screen, cell
for cell and cursor included. `daemon.test.ts`'s echo test asks the grid for
the command and its output rather than the stream for a byte sequence, and
passes on Windows in 234 ms. M2's slow-client scenario asks whether the bytes
that reached a resumed client redraw the whole screen on their own — which is
what a render is and what ordinary output, with most of the flood missed,
could not be — rather than looking for the clear sequence inside them.

M2 says the same thing at the level the spike exists to test. On the Windows
lane, `vim` reattached at three sizes, a TUI redrawing every 200 ms and
reattached while it counted, and a coloured shell after typing into it all
agree with the daemon's screen and cursor, through a ConPTY, cell for cell.
The suite passes there: eight scenarios run, and the ninth, which makes one
client slow by stopping it, is skipped for want of a SIGSTOP Windows does not
have.

**Throughput is the other half of the ConPTY cost.** `yes | head -c 4M`
through a pseudoconsole does not finish inside a minute: 1.05 MiB and
1.29 MiB of the 4 MiB reached the reader in 60 s on two runs, about
20 KiB/s, against roughly 99 MiB/s through a session on Linux. That, and not
fidelity, is what the two assertions that pour megabytes through a session
fail on — `daemon.test.ts`'s slow-client rule (8 MiB) and
`attach-snapshot.test.ts`'s lag-resume (4 MiB) both time out waiting for the
end of a flood that is still arriving.

### `bun test` panics after a test times out

When a test in `daemon.test.ts` runs past its deadline, Bun 1.3.14 on
Windows kills the daemon the file started — `killed 1 dangling process` — so
the timed-out test's own continuation gets `connection closed` from the
client, and the process then panics:

```
panic(main thread): Segmentation fault at address 0x249A1A2FAA2
```

In one `bun test` that takes down every file the runner has not reached:
`test-full` on `main` reported five files of twenty-two and nothing at all
about the other seventeen. Two measurements pin it to the timeout rather
than to anything the file's other tests do. `bun test src/daemon/daemon.test.ts`
alone panics the same way; the same command with the one timing-out test
filtered out runs to `9 pass 1 fail` and exits (run 33705737351). So the
Windows lane runs the files one process at a time
(`.github/ci/windows-test-full.sh`), which costs the panic one file's verdict
instead of seventeen.

### A session's tree goes in a Job Object

A ConPTY child can be put in a Job Object from Bun, and ending the job takes
everything the child started. Measured on both Windows runners by
`.github/ci/win32-job-probes.ts`, which spawns a child exactly as `Session`
does, assigns it before it starts a grandchild of its own, and then ends the
job each of the ways there are (runs 33704743713, 33706263111):

| Question                                                    | `win32-x64`                                          | `win32-arm64`       |
| ----------------------------------------------------------- | ---------------------------------------------------- | ------------------- |
| `CreateJobObjectW` + `SetInformationJobObject`              | ok, with `KILL_ON_JOB_CLOSE`                         | no `bun:ffi` at all |
| The daemon is itself already in a job                       | yes, and the nested assign still succeeds            | —                   |
| `AssignProcessToJobObject` on a ConPTY child                | assigned                                             | —                   |
| `TerminateJobObject`                                        | child and grandchild gone in 2–3 ms                  | —                   |
| `CloseHandle` on the last job handle                        | the same, in under a millisecond                     | —                   |
| What Bun reports for a child ended by the job               | `exitCode` 1, `signalCode` null                      | —                   |
| What Bun reports for `proc.kill("SIGTERM")` / `("SIGKILL")` | `exitCode` null, `signalCode` the name it was passed | the same            |

So the signal name Bun reports on Windows is the name the caller asked for,
not something the platform said: a `TerminateProcess` reports `SIGTERM`
because `SIGTERM` was passed. That is why the daemon reports no `signalCode`
on Windows at all and carries what it asked for in the session's kill record
instead.

The one place the tree matters and cannot be measured here: the probe's
control case, a plain `proc.kill()` with no job, also took the grandchild
with it — a process inherits its parent's console, and the ConPTY going takes
everything attached to it. A grandchild that detaches itself from the console
would survive, and that is what the job covers; nothing on the runner
produces one. On `win32-arm64` there is no job, so the kill is
`TerminateProcess` on the child alone and whatever survives the console is
left running.

Through the daemon, the whole sequence — connect, run, attach, kill, the
`exited` notice, `ls`, remove — takes about 250 ms on x64 and 450 ms on
arm64 (run 33706263111). x64 reports `exitCode` 1 with the kill delivered as
`job`; arm64 reports `exitCode` null delivered as `terminate`, which is all a
Windows exit can say when the signal name is dropped and no job set the code.

### The pipe lock, contended

Where `bun:ffi` is absent the lock is a `\\.\pipe\` name, and on
`win32-arm64` there is nothing else it could be. `.github/ci/win32-lock-probes.ts`
contends it the way a second `wp` would: a daemon on a runtime directory of
its own, then a second `wp __daemon --dir=` the same directory, then the
holder killed with `taskkill /F` and a third one started. It runs as the
matrix's `lock` suite, so every run asks again rather than the question
having been settled once (runs 33712812822 and 33713142782, then four runs as
a suite, 33713887366 through 33715705924, where it takes 1.1–2.3 s).

| Question                                                   | `win32-arm64`, natively | `win32-x64`, `LockFileEx` | `win32-x64`, pipe forced |
| ---------------------------------------------------------- | ----------------------- | ------------------------- | ------------------------ |
| `bun:ffi` `dlopen`                                         | throws, TinyCC disabled | opens `kernel32.dll`      | not consulted            |
| what `platform.lock` returned                              | `fd` -1, a pipe         | `fd`, a handle            | forced to the pipe       |
| a second `lock()` in the same process                      | refused                 | refused                   | —                        |
| a second `wp __daemon`, interpreted                        | exits 1, refused        | exits 1, refused          | exits 1, refused         |
| a second `wp __daemon`, compiled binary                    | exits 1, refused        | exits 1, refused          | —                        |
| who is still on the socket afterwards                      | the first daemon        | the first daemon          | the first daemon         |
| a third daemon, after the holder is killed with `taskkill` | takes it in 99–105 ms   | takes it in 96–135 ms     | takes it in 105–133 ms   |

The refused daemon says
`wp __daemon: another daemon holds <dir>\wp.lock` on stderr and exits 1,
which is `daemonMain` refusing before it binds anything — the same line on
both runners, so what refuses differs and what a caller sees does not. The
two probe runs agree cell for cell, and the suite has since said the same
twice more.

### The differential corpus agrees with Linux exactly

All 23 `ghostty-wasm` ↔ `xterm-oracle` case verdicts and all 10 reattach rows
are byte-identical to the Linux run, and the fuzz on seed 7 matches exactly
(`193/200` plainText, `91/200` cells, `200/200` split-invariant). The seven
disagreements are the engine differences the corpus already documents,
unchanged by platform.

### The daemon in process, past the lock and the launcher

A probe in the `probes` suite starts `startServer()` in-process — no lock, no
launcher — and then connects the real client:

```
PROBE daemon-listen: ok — listening on C:\Users\RUNNER~1\AppData\Local\Temp\wp-probe-daemon-nwE6Q4\wp.sock
PROBE daemon-hello:  ok — the client handshake completed
PROBE daemon-ls:     ok — 0 sessions
PROBE daemon-run:    ok — session {"id":"a37a43"}
```

The daemon, the wire protocol and a PTY session run on Windows in that
configuration, which is what said the lock and the launcher were the whole
obstacle before the branches below existed.

### Where the Windows lane stands on `main`

What Windows does differently is `src/platform/win32.ts`, one implementation
of the seam's interface, from [PR #3](https://github.com/omnilogic-labs/werk/pull/3):

| Row                        | What it does on Windows                                                                                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lock()`                   | `CreateFileW` + `LockFileEx` via `bun:ffi`; falls back to an exclusive `\\.\pipe\werk-poc-lock-<hash>` listener where `bun:ffi` is absent (forced on x64 via `WP_WIN32_LOCK=pipe`; the lock `win32-arm64` holds) |
| `spawnDaemon()`, readiness | no fourth stdio pipe; a `--ready-file` polled instead, which the daemon writes atomically; `detached: true, windowsHide: true`; `cwd` the home directory                                                         |
| `compiled`                 | accepts the virtual drive `B:\~BUN\`, backslashes and all                                                                                                                                                        |
| `runtimeDir()`             | `%LOCALAPPDATA%\werk-poc`; skips the uid and `0o077` checks                                                                                                                                                      |
| `listen()`                 | unlinks a stale socket before bind-and-rename; no `chmod`                                                                                                                                                        |
| `rss()`                    | `process.memoryUsage()`                                                                                                                                                                                          |
| `onShutdownSignal()`       | installs no signal handlers; the `shutdown` message over the socket is the only way in                                                                                                                           |
| `adoptTree()`              | a Job Object with `KILL_ON_JOB_CLOSE` per session, via `bun:ffi`; the child alone where there is none. An interrupt is `0x03` into the ConPTY                                                                    |
| `signalsExits`             | false: nothing is delivered as a signal, so no `signalCode` is reported                                                                                                                                          |
| `isAlive()`                | `kill(pid, 0)` alone — there are no zombies to exclude; `05-daemon-survives` judges by that and a tick file                                                                                                      |

What the lane records with those in place and the fidelity oracle above,
against the last run without either:

| Suite       | before, run 33686941407              | run 33710644108                                                                                                       |
| ----------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `daemon`    | fail, `flock`                        | pass — `hello` at 141 ms, `ls`, and gone 100 ms after `shutdown`                                                      |
| `wp-cli`    | fail, `EBADF`                        | pass — `wp.exe ls` autostarts a daemon and prints its header                                                          |
| `kill`      | —                                    | pass — a kill reaches the child and the session reports how, in 349 ms                                                |
| `ops`       | fail                                 | pass — the cold-start table, its daemon spawned through the seam                                                      |
| `m0-probes` | 01, 02, 05, 06 fail                  | 01, 02, 06 fail; `05-daemon-survives` passes                                                                          |
| `m2`        | fail, `EBADF`                        | fail — seven of eight scenarios, the vim resize failing; the SIGSTOPped slow client is skipped for want of the signal |
| `test-full` | fail, `EBADF` before any daemon test | 158 pass, 10 fail across 22 files, one process per file; every file reaches a verdict and none is left without one    |

Four of those rows are gated, and a red gate means a regression rather than
"windows still does not run `test-full`": `daemon`, `wp-cli`, `kill` and
`ops`, along with `install`, `typecheck`, `test-pure`, `build-web`, `build`,
`diff` and `probes`. `m0-probes`, `test-full`, `m2` and `m3` are recorded.

`m2`'s reattach fidelity holds through a ConPTY — the scenarios compare cell
grids, not bytes — and the suite passes eighteen runs in eighteen on
`windows-latest` (run 33738702935: six jobs of `bun run m2` three times each,
with the lane's daemon stop between runs, and sixty runs of the resize
scenario alone). One lane run is one sample of a race, so that matrix is the
shape of the evidence: `.github/workflows/step10-m2-vim-probes.yml` prints
one `PROBE` line per run. What the same matrix says about the tree without
the harness's screen-based waits is four failures in eighteen (run
33736946766), and every one of them is a wait on the wrong thing:

- **A ConPTY delivers for a moment after the process it fed has exited.** The
  `:q!` and `ctrl-\` checks wait for `wp` to exit and then look for the
  `[exited]` or `[detached]` line; three runs in eighteen found the exit and
  not the line, which arrived up to 40 ms later. The harness waits for the
  line, not the exit — as the unknown-id scenario already did.
- **vim's redraw after a resize is not slow; it is missing.** The resize
  scenario reattaches at 100×30 and waits for the 28 file rows vim draws into
  a 30-row window. In 55 of 78 samples they are there within about 300 ms of
  the attach, agreeing with the daemon; in the other 23 vim still shows 23
  rows eleven seconds on, and the next resize reaches it in about 190 ms. A
  scenario with vim taken out — a child that parks the cursor in the far
  corner and asks the terminal where it is — has the ConPTY answering the new
  size within 400 ms in every one of 78 runs, and its runtime raising one
  `resize` event per resize. So the resize reaches the pty every time, and
  what is lost is between the console and the MSYS vim that Git for Windows
  ships (`/usr/bin/vim`, 9.2): it learns of the size when it next reads
  input, and a `ctrl-l` then repaints it at 29 rows in a 30-row window and 34
  in 35 — one row too many, whichever the console said. The second resize
  shows the same in 15 of 78. On a re-encoding pty the scenario records what
  vim shows, and what a `ctrl-l` brings, and asserts what the pty answers
  for: the session is resized and the screens agree. On a pty that passes
  bytes through the row count is asserted, after the `SIGWINCH` as well.

The remaining spread is the runner's: across the eighteen the vim scenarios
take 1.3–1.9 s (reattach) and 1.4–4.3 s (resize, the top of the range being
the 3 s the harness waits for a redraw that is not coming), the probe child
1.2–1.4 s, the shell 0.8–5.7 s.

`test-full`'s ten are below. `daemon.test.ts` is in the failing set rather
than the no-verdict set now: teardown through the protocol closed the file
that used to panic, so nothing is hidden behind it any more.

The `m2` and `ops` rows were harness shape, and both suites reach the daemon
with it changed (runs 33705813223 and 33706143058):

- **The M2 harness builds to a path of its own run**, `dist/m2/wp-<pid>`,
  rather than over `dist/wp`. Windows holds an executable's file open while a
  process is running it, so a rebuild over a binary an earlier suite's daemon
  is still running fails with `EPERM`. The lane works around that by stopping
  every daemon it can find before the suites that build, and with it the
  suite reports its verdicts on the merged tree too (run 33704300228); a path
  named after the building process cannot be one anything else is running, so
  the harness no longer depends on that housekeeping, and neither does a
  developer running `bun run m2` beside a daemon of their own. Of the eight
  scenarios, six pass on two of four runs and five on the other two. The
  alternate-screen scenario and the `SIGSTOP` slow client fail on every one;
  the third failure moves — `unknown id` on run 33705813223, the vim resize
  on 33706143058, neither on the two others — where the assertion read the
  PTY's buffer before ConPTY had finished delivering into it.
- **`bench/ops.ts` spawns its daemon through the seam** rather than through a
  launcher of its own, and names its runtime directories in one or two
  characters. The seam's readiness detail is what said why the daemon was
  exiting 1: `failed to listen` at a 116-character socket path under
  `%TEMP%`, which the old label-shaped directory names reached on their own.
  With the path at 75 characters the daemon binds, and the suite passes in
  about 1.3 s, cold start included: `wp --help` at 60–74 ms, `wp __daemon` to
  a first `hello` at 115–137 ms, `wp ls` against a live daemon at 76–89 ms.
  An AF_UNIX path is bounded at 108 bytes on Linux and 104 on macOS; what
  Winsock's bound is has not been measured, only that 116 refuses and 75
  binds. The Windows lane gates on `ops` now.

The ten failing tests, by cause:

| Test                                                       | Why                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `attach-snapshot.test.ts`: lag-resume                      | a 4 MiB flood against 20 KiB/s of ConPTY; the watcher never sees the end of it                   |
| `attach-snapshot.test.ts`: exited session in snapshot mode | an output frame reaches the client before the snapshot, where on Linux the snapshot is first     |
| `launch.test.ts`: four                                     | `stat` on the socket's reparse point (`EACCES`), a stale socket `existsSync` cannot see, `pgrep` |
| `snapshot.test.ts`: a real SIGTERM snapshots every session | signals do not reach a detached Windows daemon                                                   |
| `m1/embedded.test.ts`, `m6/compiled.test.ts`               | both name `/$bunfs/`, which is `B:/~BUN/` here                                                   |
| `m2/fidelity.test.ts`                                      | the vim-resize scenario, the same race the `m2` suite fails on about two runs in three           |
| `daemon.test.ts`                                           | the slow-client scenario, which the hosted Linux and macOS lanes fail too                        |

None of the ten is a fidelity failure. Where the kill path, the snapshot
ordering and the two harness launchers go from here is a design question
rather than a measurement, and it is left to the proposal.

Teardown is the other thing that moved. The `kill` suite runs the one test
that says a kill reaches the child and the session reports what happened to
it, and it passes on the lane in about 350 ms — a kill is a mode the seam
carries out rather than a signal name, and the test's last assertion catches
the missing session's error rather than waiting on it through
`expect().rejects`, which hangs here.

Run on its own, `src/daemon/daemon.test.ts` reaches a verdict on every test
on both Windows runners (run 33707978762):

| Runner        | Result                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------- |
| `win32-x64`   | 10 pass, 1 fail — the slow-client scenario, which fails on the hosted Linux and macOS lanes too |
| `win32-arm64` | 9 pass, 2 fail — the same, plus `run, attach, see output`                                       |

## A win32 `libghostty-vt`, built rather than installed

The npm package ships `darwin-arm64` and `linux-{x64,arm64}-{glibc,musl}` and
no Windows build, so one was built. `vendor/ghostty-vt-ffi/build.md` records
the toolchain and the exact command; `PIN` records the commit and the sha256.

Ghostty at `e88c6c099152dd6d2d7e517516e1f3c183c152f7` — the commit
`libghostty-vt@0.6.3` pins in its own `package.json`, and the one the
binding's `src/internal/generated.ts` offsets were probed from —
cross-compiles for `x86_64-windows-gnu` with zig 0.15.2 in about a minute,
unpatched.

It is one DLL rather than upstream's library-plus-shim pair. The shim finds
the library through `$ORIGIN` on Linux and `@loader_path` on macOS, and
Windows has neither; a dependent DLL resolves from the loading process's
directory rather than from the directory of the DLL that depends on it.
Linking the shim into the same image sidesteps that, and the binding takes an
explicit path for the library and for the shim, so both point at the one file.

The ABI was checked rather than assumed. Windows x64 differs from SysV amd64
in exactly the by-value struct passing `native/shim.c` exists to wrap, so the
calling convention is covered by the shim — but field layout is a separate
question. Every size, alignment, offset and field size the binding's own
layout probe reports was turned into a `_Static_assert` and compiled for
Windows: all 140 pass across 12 structs. The offsets in `generated.ts` are
correct on win32 as they stand.

`.github/workflows/vt-win32.yml` asks three things of a `windows-latest`
runner. `bun:ffi` opens the DLL and round-trips text through a terminal.
`wp caps` lists `ghostty-ffi` with the same capability column as Linux, both
interpreted and from a `wp.exe` compiled on the runner — which exercises the
bunfs extraction path, not only the interpreted one. And the whole
differential corpus runs on ubuntu and on windows in the same workflow with
the two normalised summaries required to match byte for byte: 23 cases across
three engine pairs, the reattach statuses, and 400 fuzz iterations at a fixed
seed. They match. Byte-level agreement with the wasm adapter and the oracle is
what says the ABI is right; a successful `dlopen` on its own says only that
nothing crashed.

A VT library changes nothing above the engine: the daemon's lock, launcher
and kill path are the same code whichever engine loads. `ghostty-wasm`
already runs on every `bun build --compile` target, so this adds a second
engine on Windows rather than a first.

The link is **not byte-reproducible**: the PE timestamp and CodeView build-id
change per run, about 5 KB of 1.6 MB, and `-Wl,/Brepro` does not fix it. The
sha256 in `PIN` identifies the committed artefact rather than one anyone can
re-derive.

`darwin-x64` does not fall out of the same pipeline. Cross-compiling
ghostty's C++ dependencies to macOS from Linux wants the macOS SDK, which is
not redistributable, and without it `simdutf` and `highway` compile against
the host's `/usr/include` and fail on `__float128` and `unsupported machine
mode '__TC__'`. That gap probably wants a macOS runner.

## Linux

Ten of twelve suites pass. The two reds are one cause.

M2's slow-client scenario stops one `wp attach` with `SIGSTOP`, floods 4 MB
through the session, and asserts the _other_ client never lags. On the
four shared vCPUs of a hosted runner the fast client's own queue crosses the
daemon's 256 KiB drop bound, so it lags and loses 300 KB–1 MB; `test-full`
fails through `spikes/m2/fidelity.test.ts`, which asserts the same table.

The evidence that this is the machine rather than the code: it reproduces on a
developer's box under `taskset -c 0-1` with the same failure mode and passes
under `taskset -c 0-3`; across five consecutive CI attempts the peak
fast-client queue was 193–262 KB against the 256 KiB bound, versus 127–156 KB
on the two attempts that passed; and the flood takes about 1.7 s on CI against
about 0.9 s locally. It is nondeterministic — roughly two attempts in seven
pass, and the `linux-x64-glibc` lane of run 33696944598 is one of the passes —
and weighted to fail.

`WP_QUEUE_BOUND` is not a lever here: the M2 harness builds a minimal
environment, so it never reaches the daemon, and raising it would change what
the scenario measures. Whether CI should gate on this scenario is an open
question; the run records it red rather than retrying or skipping it.

Note that the Linux and macOS failures of this same scenario have different
causes — CPU headroom here, an 8 KiB socket buffer there — and only the Linux
one is nondeterministic.

## The other five targets

`.github/workflows/poc.yml` compiles all eight `bun build --compile`
targets on one `ubuntu-24.04` job and hands each binary to a native lane,
which smokes it (`--help`, `caps`, `ls` against an autostarted daemon) and
then runs the PoC suites from source. Three of the eight lanes —
`linux-x64-glibc`, `darwin-arm64` and `win32-x64` — are the same jobs the
tables further up report, with the cross-compiled smoke added at the end;
the five here are the ones with nothing but the smoke and the suites. The
two Windows rows below are read
from [run 33712817886](https://github.com/omnilogic-labs/werk/actions/runs/33712817886),
the workflow on the tree with the seam, teardown through the protocol, the
grid oracle and the harness items all in place;
[run 33701438138](https://github.com/omnilogic-labs/werk/actions/runs/33701438138)
(commit `789b481`) is where the four Linux rows are read from, and
[run 33703355321](https://github.com/omnilogic-labs/werk/actions/runs/33703355321)
the two darwin ones. All six non-Windows lanes report the same verdicts on
33712817886 that they do on 33703355321, suite for suite.
[Run 33689751325](https://github.com/omnilogic-labs/werk/actions/runs/33689751325)
is the same workflow from [PR #5](https://github.com/omnilogic-labs/werk/pull/5),
before the daemon's `win32` branches. All eight targets compile in about a
minute each. `--help` passes on all eight; `caps` on six, because
`darwin-x64` and `win32-arm64` have no ffi prebuild; `ls` against an
autostarted daemon on all eight — on `win32-arm64` through the named-pipe
lock, since that Bun has no `bun:ffi`.

A Windows lane stops its daemons and removes their sockets before the
upload. A Winsock `AF_UNIX` path is a reparse point that `stat` cannot read,
and `actions/upload-artifact` refuses the whole output directory over one
(`EACCES: permission denied, stat 'D:\a\_temp\matrix-out\xrt\werk-poc\wp.sock'`,
`C:\a\…` on arm64), which is what cost run 33696944598 both Windows
artefacts.

The two Windows lanes are also the only ones here that gate. Each names what
it is held to and records the rest, so a red job means one of those
regressed: `x-help`, `x-ls`, `install`, `lock` and `ops` on both, plus
`x-caps`, `test-pure`, `build` and `diff` on x64, which need an ffi engine
`win32-arm64` has no way to load.

| Lane                | Runner                                    | Cross-compiled smoke                                                                                              | `test-pure`          | `diff` vs linux-x64    | `m0`  | `m3`                                                                        | `ops`       | `test-full`                                                                                                 |
| ------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------- | ----- | --------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `linux-x64-glibc`   | `ubuntu-24.04`                            | pass                                                                                                              | pass                 | identical              | 14/14 | pass                                                                        | pass        | fail: reattach fidelity only, and only sometimes — it passes on 33696944598 and fails on the other two runs |
| `linux-arm64-glibc` | `ubuntu-24.04-arm`                        | pass                                                                                                              | pass                 | identical              | 14/14 | pass                                                                        | pass        | pass: all 168 tests, reattach fidelity included                                                             |
| `linux-x64-musl`    | `alpine:3.22` container on `ubuntu-24.04` | pass; `ldd`: `ld-musl`, `libstdc++.so.6`, `libgcc_s.so.1` (below)                                                 | pass                 | identical              | 14/14 | pass                                                                        | pass        | fail: reattach fidelity only                                                                                |
| `linux-arm64-musl`  | `alpine:3.22` via `docker exec` on arm    | pass; same `ldd`                                                                                                  | pass                 | identical              | 14/14 | pass                                                                        | pass        | fail: reattach fidelity only                                                                                |
| `darwin-x64`        | `macos-15-intel` (15.7.9, avx2)           | `--help`, `ls` pass; `caps` no `darwin-x64` prebuild                                                              | fail: 106, ffi tests | differs: no ffi column | 14/14 | pass                                                                        | pass        | fail: ffi tests, reattach fidelity                                                                          |
| `darwin-arm64`      | `macos-latest` (26.5.2)                   | pass                                                                                                              | pass                 | identical              | 14/14 | pass                                                                        | pass        | fail: reattach fidelity only                                                                                |
| `win32-x64`         | `windows-latest` (26100)                  | pass; `ls` autostarts the daemon                                                                                  | pass                 | identical              | 3–4/7 | pass, 4.7 s                                                                 | pass, 1.4 s | fail: 168 tests run, the ConPTY set above                                                                   |
| `win32-arm64`       | `windows-11-arm` (26200), native Bun      | `--help`, `ls` pass, the daemon on the named-pipe lock and a second one refused; `caps` no prebuild; no `bun:ffi` | fail: ffi tests      | differs: no ffi        | 3–4/7 | printed every table and did not exit (600 s); passes in 4.7 s on other runs | pass, 1.5 s | fail: 161 tests run, the same set plus the ffi-dependent ones                                               |

Before the `win32` branches (run 33689751325) both Windows lanes failed `ls`
with `EBADF` in the client and `flock` in the daemon, `m0` reached 3/7 on
both, and `test-full` failed 141 and 134 tests respectively. Three of the
seven M0 probes pass on either runner now, sometimes four, and which ones
moves: on run 33712817886 both runners fail `01-pty-basic`, `02-sigint` and
`03-sigwinch`, and on 33714530862 both fail `01-pty-basic`, `02-sigint` and
`06-raw-mode` instead. That is why neither lane gates on `m0`.

`m0` takes 31–43 s on the Intel Mac across the two runs against about 24 s
on the others. The differential summary is byte-identical on every lane
where all three engines load. Findings that are not platform facts, recorded
so they do not read as one:

- The libghostty-vt binding's own loader does not find its prebuild inside a
  compiled binary on `linux-arm64` or either musl target
  (`Bundled libghostty-vt missing at /$bunfs/prebuilds/linux-arm64-glibc/libghostty-vt.so`);
  the PoC's shim finds it, which is why `caps` passes on those lanes. The
  shim is checked directly by `spikes/m6/compiled.test.ts`, which asks the
  adapter for the host's platform id and then looks for the pair the
  compiled binary extracted: on the four Linux lanes it finds
  `…/werk-poc-libghostty-vt-0.6.3/linux-<arch>-<libc>/libghostty-vt.so.0`
  next to its shim, and the ffi engine loads from it.
- `container: alpine` is refused on arm64 runners (container jobs are x64
  Linux only), hence `docker exec`; `setup-bun` does not detect musl, so the
  lane fetches the musl zip by hand.
- `codesign` on the cross-compiled `darwin-x64` binary: Bun's Developer ID
  signature (runtime flag) invalidated by the appended bundle; `darwin-arm64`:
  ad hoc, linker-signed; both fail `--verify --strict` with "invalid
  signature".

### What a musl host has to carry

The musl Bun is not static, and neither is a binary compiled from it. Both
Alpine lanes' `ldd` reports the same two libraries beyond the musl loader
itself, and the `x-ldd` suite records each one's size (run 33701438138):

| Lane               | Library                   | Size        |
| ------------------ | ------------------------- | ----------- |
| `linux-x64-musl`   | `/usr/lib/libstdc++.so.6` | 2,771,336 B |
| `linux-x64-musl`   | `/usr/lib/libgcc_s.so.1`  | 173,920 B   |
| `linux-arm64-musl` | `/usr/lib/libstdc++.so.6` | 2,754,992 B |
| `linux-arm64-musl` | `/usr/lib/libgcc_s.so.1`  | 133,008 B   |

Both lanes `apk add libstdc++ libgcc` before anything else runs (`libgcc`
14.2.0-r6, 169 KiB installed; `libstdc++` 14.2.0-r6, 2706 KiB), which is a
requirement of the binary rather than a convenience of CI: on a bare
`alpine:3.22` a `bun-linux-x64-musl` binary compiled from this tree prints
`Error loading shared library libstdc++.so.6: No such file or directory`,
and the same for `libgcc_s.so.1`, before reaching any of its own code.

Carrying the pair instead of requiring it was measured on x64 only, and off
the runners: `docker run alpine:3.22` on the WSL2 development machine, with
neither package installed, against a `bun-linux-x64-musl` binary compiled
there from this tree.

| What                                                                        | Result                                                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| the two files copied beside the binary, `LD_LIBRARY_PATH` at that directory | `wp --help`, `wp caps` and `wp ls` (which autostarts the daemon) all run |
| `patchelf --set-rpath '$ORIGIN/muslibs'` on the binary, same two files      | the same, with no wrapper and no environment; the binary grows 8,192 B   |

```console
$ bun build --compile --target=bun-linux-x64-musl ./src/cli/main.ts --outfile wp
$ docker run --rm -v "$PWD:/x" alpine:3.22 /x/wp --help
Error loading shared library libstdc++.so.6: No such file or directory (needed by /x/wp)
Error loading shared library libgcc_s.so.1: No such file or directory (needed by /x/wp)
$ docker run --rm -v "$PWD:/x" alpine:3.22 sh -c 'apk add -q libstdc++ libgcc patchelf &&
    mkdir -p /x/muslibs && cp -L /usr/lib/libstdc++.so.6 /usr/lib/libgcc_s.so.1 /x/muslibs/ &&
    patchelf --set-rpath "\$ORIGIN/muslibs" /x/wp'
$ docker run --rm -v "$PWD:/x" alpine:3.22 /x/wp ls
ID  COMMAND  ENGINE  STATUS  TITLE  AGE  SNAPSHOT  CLIENTS
```

So carrying them costs 2,945,256 B on x64 next to a 101 MB binary, plus one
of those two mechanisms, and the appended Bun bundle survives `patchelf` —
`caps` extracts an ffi prebuild out of the same file afterwards. Nothing
here chooses between requiring the pair on a musl host and carrying it. The
arm64 half of that probe, and whether redistributing libstdc++ under the GCC
runtime library exception is something werk wants to do, are both untouched.
Upstream has the underlying issue open
([oven-sh/bun#29681](https://github.com/oven-sh/bun/issues/29681), and a
`FROM scratch` build requested in
[#23910](https://github.com/oven-sh/bun/issues/23910)).

### What AVX the lanes run on

Bun's x64 build after 1.3.8 is reported to die with "illegal instruction" on
CPUs without AVX2, in the `-baseline` binary too
([oven-sh/bun#26353](https://github.com/oven-sh/bun/issues/26353),
[#27090](https://github.com/oven-sh/bun/issues/27090)); one of the traces in
those reports is inside JSC's assembler. Each Linux and Alpine lane records
what its own CPU offers, from `/proc/cpuinfo` (run 33701438138):

| Lane                                    | avx, avx2, avx512f      |
| --------------------------------------- | ----------------------- |
| `linux-x64-glibc`, `linux-x64-musl`     | `avx`, `avx2`           |
| `linux-arm64-glibc`, `linux-arm64-musl` | none of the three named |

`macos-15-intel` reports `hw.optional.avx2_0: 1` in its own `machine.json`;
the two Windows lanes record no CPU features either way. So no lane whose
CPU is on record has run Bun's x64 build without AVX2, and the arm64 lanes
do not have the extension at all. Nothing here says what to do about that.

## What changed in the proof of concept

Nineteen commits, each guarded so that the Linux path is unchanged. Every
one is `process.platform === "darwin" ? … : …` or a `win32` branch, never a
replacement; the Linux lane of run 33696942295, at the head of the series,
records the same verdicts suite for suite as the Linux table above, and the
first ten were also checked on linux-x64-glibc under WSL2 (`bun test` 168
pass 0 fail, `bun run m0` 28 of 28 cells, `bun run m2` 8 of 8, `tsc --noEmit`
clean, `prettier --check .` clean).

| Commit               | What                                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4450de9`            | `alive()`, `readRss()` and `cpuModel()` read `ps` and `sysctl` where there is no `/proc`. The liveness one had been returning `false` for every live process on macOS — a silent wrong answer, not an exception        |
| `19dd7c1`            | BSD `ps` has no `sid` keyword; the probe derives it from the session-leader flag, and says so where it cannot                                                                                                          |
| `b35397b`, `5af155c` | the pty slave is `/dev/ttysNNN`, and BSD `stty` takes `-f` where GNU takes `-F`                                                                                                                                        |
| `2a20099`            | BSD `script(1)` takes its command after the typescript file rather than through `-qc`                                                                                                                                  |
| `a95937c`            | `top -s` for the refresh delay, and `head -c 4194304` — BSD `head` rejects `4M`                                                                                                                                        |
| `5b2b01e`            | the compiled-binary test expects the host platform's extracted prebuild rather than `linux-x64-glibc`                                                                                                                  |
| `7760e0f`            | the detached-daemon session check reads what BSD `ps` reports                                                                                                                                                          |
| `d3fdc37`, `d0121b0` | the vendored win32 DLL, and the load path that finds it                                                                                                                                                                |
| `d858087`            | `src/daemon/sockopt.ts`: `setsockopt(SO_SNDBUF)` on the listener's fd through `bun:ffi`, darwin only; the M2 harness reports the short-write threshold                                                                 |
| `bf1183b`, `5cf74ee` | `WP_SNDBUF` sizes the raise or switches it off, so one lane can run either way; the default is 212992 on darwin                                                                                                        |
| `c7575ae`            | the `win32` branches: `LockFileEx` in `flock.ts`, a `--ready-file` in place of the readiness pipe in `launch.ts` and `main.ts`, `%LOCALAPPDATA%` in `paths.ts`, stale-socket unlink and `memoryUsage()` in `server.ts` |
| `6f9995e`            | `05-daemon-survives` judges liveness by `kill(pid, 0)` and a tick file where `ps` cannot see a session                                                                                                                 |
| `b1d7b9b`            | the lock file is opened with share mode 0, exclusive on its own; the `LockFileEx` refusal is probed rather than assumed                                                                                                |
| `82a15a1`            | compiled detection accepts `B:\~BUN\` with backslashes, so `wp.exe` knows it is compiled                                                                                                                               |
| `ccae188`            | the lock file is opened with `FILE_GENERIC_READ \| FILE_GENERIC_WRITE`, below 2^31, so `bun:ffi` passes the rights through and `LockFileEx` gets a handle it can lock                                                  |
| `3bb7a30`            | an exclusive `\\.\pipe\werk-poc-lock-<hash>` listener stands in for the lock where `bun:ffi` is absent                                                                                                                 |

## What was not taken

- **One image and one Bun version per platform.** Where a row reads "works",
  it works there. Nobody has looked at Windows 10 (no hosted image exists),
  at Bun 1.4 on any of them, or at a Windows machine without Git for Windows
  on the path — `sh` resolving to `C:\Program Files\Git\usr\bin\sh.exe` is a
  property of the runner image.
- **The M5 transport spike** on any platform but the WSL2 machine. It needs
  Docker and `NET_ADMIN` for `tc netem`, so it did not run in CI. Whether an
  `ssh -L` forward of the kind it measures works against a Windows `AF_UNIX`
  socket is answered by the research rather than by a run: Win32-OpenSSH
  does not forward it.
- **The soak**, on any platform, and `bench/perf.ts` as anything but
  information — timings on a shared runner are not comparable with `m6.md`'s.
- **Logout survival on macOS**, and App Nap's effect on a headless Bun
  daemon; both unverified either way.
- **The rest of the Windows port.** The seam's `win32` side stops where the
  measurements above say it stops: kill through the protocol, the snapshot
  frame's ordering against late ConPTY output, the socket's reparse point
  where a test calls `stat` on it, a `darwin-x64` ffi build.

## Auditing this

The workflow is `.github/workflows/poc.yml` — it runs when a pull request is
given the `ci:poc` label, and from the Actions tab or `gh workflow run`. One
dispatch builds all eight targets and runs all eight lanes. The win32 build
has its own workflow, `.github/workflows/vt-win32.yml`. The macOS probes
(`macos-probes.yml`), the Windows probes (`win32-spike.yml`,
`step2-probes.yml` and `step5-probes.yml`) and the transport probes
(`step9-probes.yml`) are on `main` too; each triggers on pushes to the branch
it was written for. None runs on an ordinary commit.

```console
$ gh workflow run poc.yml --ref <branch> -f lanes=all
$ gh run download <id> -n ci-result-darwin-arm64   # the table above, as JSON
```

Each lane uploads `ci-result-<lane>.json` plus the raw suite logs, and the
per-probe M0 logs quoted here are in the `darwin-arm64` artefact under
`packages/werk-poc/dist/m0/`. Artefacts are kept 14 days; re-running is the
way to check anything older than that.

To re-derive the vendored DLL, `vendor/ghostty-vt-ffi/build.md` has the zig
version and the command line. The sha256 in `PIN` matches the committed file
but not necessarily a fresh link, for the reason given above.
