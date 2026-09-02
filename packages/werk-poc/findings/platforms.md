# platforms

What the proof of concept does on macOS and Windows, measured on GitHub's
hosted runners, next to the same suites on Linux.

Every other file in this directory records one machine: linux-x64-glibc under
WSL2. This one records three, none of them that machine. It is written to be
audited rather than believed: every claim below names the run, the artefact
and the file it came from, and the section at the end says what to re-run to
check any of it.

## What this is not

No decision is recorded here. Where a measurement suggests something about
werk's design, the suggestion is left open and labelled as one. Several rows
below are single observations on a single image, and a few are the first
measurement anyone has taken of the thing at all.

## How it was run

Four branches off `main`, one per workstream, each carrying a workflow with a
`push` trigger scoped to its own branch — `workflow_dispatch` needs the
workflow file on the default branch, and nothing was to reach `main` until it
had been run. Each branch was iterated against real runners, then merged into
`ci/matrix`, then folded into `.github/workflows/poc.yml`.

| Branch          | Runner           | Final run                                                                      | Job      |
| --------------- | ---------------- | ------------------------------------------------------------------------------ | -------- |
| `ci/os-linux`   | `ubuntu-latest`  | [33671844640](https://github.com/omnilogic-labs/werk/actions/runs/33671844640) | 118 s    |
| `ci/os-macos`   | `macos-latest`   | [33672982212](https://github.com/omnilogic-labs/werk/actions/runs/33672982212) | 2 m 24 s |
| `ci/os-windows` | `windows-latest` | [33681043114](https://github.com/omnilogic-labs/werk/actions/runs/33681043114) | 2 m 09 s |
| `ci/vt-win32`   | both             | [33671709842](https://github.com/omnilogic-labs/werk/actions/runs/33671709842) | 1 m      |

Every suite step carries `continue-on-error`, so a run reports every suite's
verdict rather than stopping at the first red one, and each job uploads a
`ci-result-<os>.json`. The tables below are that JSON, not a retelling of it.

The merged form of all three ran together as
[33684207403](https://github.com/omnilogic-labs/werk/actions/runs/33684207403),
green on every lane. Green there does not mean every suite passed: each lane
gates on the suites that platform already passes, so that a red lane means
something regressed. That run records 2 non-passing suites on Linux, 2 on
macOS and 7 on Windows, and the artefacts carry all of them. Read the JSON
rather than the badge.

Bun is pinned to 1.3.14 on all three, matching the `bun-types` pin and the
version the rest of `findings/` was measured on. Nothing needs the network
beyond `bun install`. No runner needed a package installed: the ubuntu image
already carries vim, top, tmux and jq.

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

`X64/Windows win25-vs2026 20260824.214.3 nt-10.0.26100` · Bun 1.3.14 · commit `e6e891a` · [run 33681043114](https://github.com/omnilogic-labs/werk/actions/runs/33681043114)

| Suite       | Result | Time   | What the run recorded                                                                                                |
| ----------- | ------ | ------ | -------------------------------------------------------------------------------------------------------------------- |
| `install`   | pass   | 2.0 s  | 18 packages installed [1.87s]                                                                                        |
| `typecheck` | pass   | 7.8 s  | $ tsc --noEmit && tsc --noEmit -p src/web/client                                                                     |
| `test-pure` | fail   | 1.8 s  | error: libghostty-vt could not open its library: No bundled libghostty-vt for win32-x64. Supported: darwin-arm64, l… |
| `build-web` | pass   | 0.2 s  | web bundle: 104626 B in 13 ms -> D:\a\werk\werk\packages\werk-poc\src\web\bundle\app.js                              |
| `build`     | pass   | 1.0 s  | \| `encodeMouse` \| yes \| no \|                                                                                     |
| `diff`      | pass   | 26.7 s | \| sequences \| xterm-oracle \| 200/200 \|                                                                           |
| `ops`       | fail   | 10.4 s | error: daemon did not answer on C:\Users\RUNNER~1\AppData\Local\Temp\wp-ops-cold-0jekWS\run-interpreted-bun-run-src… |
| `probes`    | pass   | 0.5 s  | PROBE daemon-run: ok — session {"id":"a37a43"}                                                                       |
| `m0-probes` | fail   | 26.9 s | m0 probes not passing: 01-pty-basic 02-sigint 05-daemon-survives 06-raw-mode                                         |
| `daemon`    | fail   | 0.2 s  | error: cannot dlopen libc for flock: Error: Failed to open library "libc.so": error code 126                         |
| `wp-cli`    | fail   | 0.2 s  | wp: EBADF: bad file descriptor, read                                                                                 |
| `test-full` | fail   | 18.6 s | EBADF: bad file descriptor, read                                                                                     |
| `m2`        | fail   | 1.8 s  | threw: Error: wp run failed (1): wp: EBADF: bad file descriptor, read                                                |
| `m3`        | pass   | 4.8 s  | \| 3c1ef5b3 \| 3c1ef5b3 (same bytes) \| **identical** \| 1092 \| 1.46 ms \| 0.26 ms, 0 pages \| \|                   |

## macOS

### The controlling terminal question is answered, and the answer is no

`m0.md` records an open Bun issue saying the PTY is not made the child's
controlling terminal, notes that it does not reproduce on Linux, and says it
"may be macOS-specific or fixed; nothing here says which". It does not
reproduce on macOS either.

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
test agrees.

### The `darwin-arm64` ffi prebuild, measured rather than claimed

`m6.md` calls the ffi adapter's four non-Linux platforms "claims not
measurements". One of them is now a measurement. A compiled `wp` extracts the
pair to `$TMPDIR/werk-poc-libghostty-vt-0.6.3/darwin-arm64/` at mode 0755 and
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
is 8192 on the runner against 212992 on Linux, and the daemon does not ask for
more, so it begins short-writing after about 8 KB rather than about 218 KB.

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
received then fails. A diagnostic step raising both buffers to Linux's figure
moves the short-write threshold to 213,391 B and cuts the lag episodes from
24 to 6 — but the scenario still fails and the fast client still loses about
6 MB. So the socket buffer looks like most of the cause and not all of it,
with the remainder somewhere downstream of the socket in the attached
client's own PTY. Whether werk should set `SO_SNDBUF` on its client sockets,
or accept that a macOS client lags sooner and leans harder on the re-render
path, is not settled here and nobody has decided it.

`TMPDIR` was expected to matter, because `sun_path` is 104 bytes on macOS
against 108 on Linux and the runner's own `$TMPDIR` is a 49-character
`/var/folders/…/T/` path. A run on the runner's own `$TMPDIR` reaches
identical verdicts — sockets land around 80 characters — so the margin is
there on this image. The job sets `TMPDIR=/tmp` anyway, for a deeper
temporary directory than this one.

## Windows

The proposal and Bun's own types both say the PTY is the hard floor here:
`bun-types@1.3.14/bun.d.ts:7019` documents `Bun.Terminal` as _"Only available
on POSIX systems (Linux, macOS)"_. The run does not agree with the
documentation, and the layer that stops first is somewhere else.

### The cascade, in the order the run found it

**1. `bun:ffi` works.** `dlopen("kernel32.dll", { GetCurrentProcessId })` loads
and the call returns the process id.

**2. `flock` fails on the library name, not the mechanism.**

```
error: cannot dlopen libc for flock: Error: Failed to open library "libc.so": error code 126
      at loadLibc (packages\werk-poc\src\daemon\flock.ts:34:13)
      at daemonMain (packages\werk-poc\src\daemon\main.ts:66:16)
```

Error 126 is `ERROR_MOD_NOT_FOUND`, which is the expected answer to the
question the code asks — `flock.ts` names POSIX libraries and has a darwin
branch but no win32 one. `main.ts:66` treats a lock it cannot take as fatal,
so `wp __daemon` refuses to start. Since `dlopen` itself works, a Windows
branch would probably reach for `LockFileEx`/`UnlockFileEx` out of
`kernel32.dll`, by the mechanism the file already uses; nobody has written or
measured one.

**3. `Bun.listen({ unix })` works, with a caveat worth keeping.** Both probes
round-tripped bytes:

```
PROBE unix-socket-fs-path:    ok — listen and connect round-tripped "ping" (address on disk: no)
PROBE unix-socket-named-pipe: ok — listen and connect round-tripped "ping" (address on disk: yes)
```

A listener on a filesystem path under the temp directory works, but **no file
appears at that path**, which is consistent with libuv mapping the name onto a
named pipe rather than with a true `AF_UNIX` socket. Windows 10 and later do
carry `AF_UNIX`; which of the two this is has not been established here, and
it probably bears on whether an `ssh -L` forward of the kind `m5.md` measures
would work.

**4. The readiness pipe is the first thing that actually breaks.**
`src/daemon/launch.ts` spawns the daemon with a fourth stdio pipe and reads
the child's readiness report off it with `fs.readSync`. On Windows
`proc.stdio[3]` comes back as a number that `fs.readSync` will not take:

```
EBADF: bad file descriptor, read
      fd: 744, syscall: "read", errno: -9, code: "EBADF"
      at readPipe (packages\werk-poc\src\daemon\launch.ts:100:14)
      at ensureDaemon (packages\werk-poc\src\daemon\launch.ts:133:25)
```

This single error is what `wp.exe ls`, all eight M2 scenarios and five whole
test files die of.

**5. `Bun.Terminal` is documented POSIX-only and works anyway.** A real
ConPTY, from the probe output:

```
PROBE spawn-terminal: ok — the child wrote 102 bytes to the terminal:
  "\u001b[?9001h\u001b[?1004h\u001b[?25l\u001b[2J\u001b[m\u001b[Hhello-from-…
```

`ESC[?9001h` is win32-input-mode. `stty size` returns the requested `24 80`,
`data` and `exit` callbacks fire, and the behaviour is identical compiled and
interpreted. `03-sigwinch` and `04-exit-contract` pass outright. `01-pty-basic`
is scored fail only because it asserts a `/dev/pts/N` slave name.

Two gaps are real. Signal semantics differ: `0x03` reaches a bash trap, but a
plain `sleep` exits 0, which is what one would expect if a ConPTY is not a
controlling terminal in the POSIX sense. And orphan survival has no analogue —
`setsid` does not exist, and the detached parent "died on PTY close".

Latency is the other cost: `07-latency` passes at **p50 15.7 ms, p99 24.1 ms**,
against 59–95 µs on Linux — roughly 200× slower. The socket relay adds
nothing measurable, so on this image the cost appears to be ConPTY itself.

**6. No `win32-x64` prebuild in the npm package.** `ffiPlatform()` returns
`win32-x64` and the tarball ships none, which is the whole of the `test-pure`
shortfall (104 of 106; the two are `caps.test.ts` and `ffi.test.ts`). This is
what the vendored build below addresses.

### The differential corpus agrees with Linux exactly

All 23 `ghostty-wasm` ↔ `xterm-oracle` case verdicts and all 10 reattach rows
are byte-identical to the Linux run, and the fuzz on seed 7 matches exactly
(`193/200` plainText, `91/200` cells, `200/200` split-invariant). The seven
disagreements are the engine differences the corpus already documents,
unchanged by platform.

### With the lock and the launcher stepped over, the daemon runs

A probe that starts `startServer()` in-process — skipping `flock` and the
`launch.ts` readiness pipe — and then connects the real client:

```
PROBE daemon-listen: ok — listening on C:\Users\RUNNER~1\AppData\Local\Temp\wp-probe-daemon-nwE6Q4\wp.sock
PROBE daemon-hello:  ok — the client handshake completed
PROBE daemon-ls:     ok — 0 sessions
PROBE daemon-run:    ok — session {"id":"a37a43"}
```

The daemon, the wire protocol and a PTY session run on Windows in that
configuration. What that implies for a Windows port, if anyone wants one, is
not worked out here.

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

**This does not make werk run on Windows.** The layers in the cascade above
are untouched by a VT library. `ghostty-wasm` already runs on every
`bun build --compile` target, so Windows was not without an engine before
this.

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
pass — and weighted to fail.

`WP_QUEUE_BOUND` is not a lever here: the M2 harness builds a minimal
environment, so it never reaches the daemon, and raising it would change what
the scenario measures. Whether CI should gate on this scenario is an open
question; the run records it red rather than retrying or skipping it.

Note that the Linux and macOS failures of this same scenario have different
causes — CPU headroom here, an 8 KiB socket buffer there — and only the Linux
one is nondeterministic.

## What changed in the proof of concept

Ten commits, each guarded so that the Linux path is unchanged. Every one is
`process.platform === "darwin" ? … : …` or a `win32` branch, never a
replacement. After the last of them, on linux-x64-glibc under WSL2:
`bun test` 168 pass 0 fail, `bun run m0` 28 of 28 cells, `bun run m2` 8 of 8,
`tsc --noEmit` clean, `prettier --check .` clean.

| Commit               | What                                                                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4450de9`            | `alive()`, `readRss()` and `cpuModel()` read `ps` and `sysctl` where there is no `/proc`. The liveness one had been returning `false` for every live process on macOS — a silent wrong answer, not an exception |
| `19dd7c1`            | BSD `ps` has no `sid` keyword; the probe derives it from the session-leader flag, and says so where it cannot                                                                                                   |
| `b35397b`, `5af155c` | the pty slave is `/dev/ttysNNN`, and BSD `stty` takes `-f` where GNU takes `-F`                                                                                                                                 |
| `2a20099`            | BSD `script(1)` takes its command after the typescript file rather than through `-qc`                                                                                                                           |
| `a95937c`            | `top -s` for the refresh delay, and `head -c 4194304` — BSD `head` rejects `4M`                                                                                                                                 |
| `5b2b01e`            | the compiled-binary test expects the host platform's extracted prebuild rather than `linux-x64-glibc`                                                                                                           |
| `7760e0f`            | the detached-daemon session check reads what BSD `ps` reports                                                                                                                                                   |
| `d3fdc37`, `d0121b0` | the vendored win32 DLL, and the load path that finds it                                                                                                                                                         |

Windows needed no change to `packages/werk-poc/` at all.

## What was not taken

- **One machine per platform, one image, one Bun version.** Where a row reads
  "works", it works there. Nobody has looked at Windows 10, at Windows on
  arm64, at an Intel Mac, at Bun 1.4 on either, or at a Windows machine
  without Git for Windows on the path — `sh` resolving to
  `C:\Program Files\Git\usr\bin\sh.exe` is a property of the runner image.
- **`darwin-x64` and the ffi adapter's remaining platforms.** `linux-arm64`,
  both musl targets and `darwin-x64` are still claims rather than
  measurements.
- **The M5 transport spike** on any of the three. It needs Docker and
  `NET_ADMIN` for `tc netem`, so it did not run in CI; whether the `ssh -L`
  forward it measures works over whatever Bun's Windows `unix:` option
  actually is, is untested.
- **The soak**, on any platform, and `bench/perf.ts` as anything but
  information — timings on a shared runner are not comparable with `m6.md`'s.
- **Whether the Windows `unix:` listener is `AF_UNIX` or a named pipe**, which
  the "no file on disk" result raises but does not answer.
- **Any port.** The `flock` Windows branch, the readiness-pipe replacement and
  a `setsid` analogue are described where the run found them and were not
  written.

## Auditing this

The workflow is `.github/workflows/poc.yml` — it runs when a pull request is
given the `ci:poc` label, and from the Actions tab or `gh workflow run`. The
win32 build has its own, `.github/workflows/vt-win32.yml`. Neither runs on an
ordinary commit.

```console
$ gh workflow run poc.yml --ref <branch> -f os=all
$ gh run download <id> -n ci-result-macos     # the table above, as JSON
```

Each job uploads `ci-result-<os>.json` plus the raw suite logs, and the
per-probe M0 logs quoted here are in the macOS artefact under
`packages/werk-poc/dist/m0/`. Artefacts are kept 14 days; the runs named above
predate that window, so re-running is the way to check them now.

To re-derive the vendored DLL, `vendor/ghostty-vt-ffi/build.md` has the zig
version and the command line. The sha256 in `PIN` matches the committed file
but not necessarily a fresh link, for the reason given above.
