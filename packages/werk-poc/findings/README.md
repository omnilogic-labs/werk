# findings

One file per milestone recording what was run and what happened, in the
present tense. These are the PoC's output; the code is only how they were
obtained. Two files cut across the milestones:
[platforms.md](./platforms.md), the same suites on macOS, Windows and every
other target Bun compiles for, and
[where-the-poc-falls-short.md](./where-the-poc-falls-short.md), what the PoC
does not yet do well, what is broken in it, and what nobody has measured.

## What the proof of concept found

The proposal's §8 wrote down, before any measurement, what would change the
answer. Here is what the PoC actually measured against each row. "Not hit"
means the finding that would move the design did not appear; the number or
the mechanism behind each is in the milestone file linked in the last
column. Speculative wording is deliberate where the measurement does not
settle the question — a single machine, one kernel, WSL2, and 1.3.14 is not
the whole world, and the rows that were **not taken** say so. The rows below
are that machine; [platforms.md](./platforms.md) is the same suites on
macOS and Windows.

| §8 finding (what it implies)                                                                                 | What the PoC measured                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Where                                    |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `Bun.Terminal` fails under `--compile` → inherit VibeTunnel's forked node-pty                                | **Not hit.** `Bun.Terminal` works identically interpreted and compiled, on 1.3.14 and 1.4.0. The daemon, the PTY and all three engines survive `bun build --compile`.                                                                                                                                                                                                                                                                                                                                                                                                                                         | [m0](./m0.md), [m6](./m6.md)             |
| Ctrl+C or `SIGWINCH` cannot be made to work → blocking                                                       | **Not hit.** `0x03` delivers `SIGINT` (the PTY is the child's controlling terminal), `resize()` delivers `SIGWINCH` and `vim` redraws, but only when the terminal is passed as inline options rather than a pre-made `Bun.Terminal`.                                                                                                                                                                                                                                                                                                                                                                          | [m0](./m0.md), [m2](./m2.md)             |
| The WASM ABI cannot be marshalled reliably → `bun:ffi` becomes primary                                       | **Not hit.** Every offset, size and enum came from `ghostty_type_json`; the binding was confirmed against the headers, not transcribed from them. The ffi route exists too, as the second adapter.                                                                                                                                                                                                                                                                                                                                                                                                            | [m1](./m1.md), [m6](./m6.md)             |
| VT throughput below ~20 MiB/s → moves the fan-out design                                                     | **Not hit.** ghostty-wasm parses the recorded corpus at 139–161 MiB/s (plain text 430–580, SGR-heavy 104); the ffi at 91–95 (SGR-heavy 43–69). Both clear 20 MiB/s several times over at 80×24 and 200×50. (The oracle, not a session engine, sits at 27–31.)                                                                                                                                                                                                                                                                                                                                                 | [m6](./m6.md#vt-throughput)              |
| Per-session memory materially above ~5 MiB idle → bounds the fleet                                           | **Not hit.** An idle `sh` session adds 0.7–0.9 MiB of daemon RSS (fifty of them: 110 MiB total); a session that has scrolled a megabyte through and holds its 2,000-line cap adds about 1.1 MiB. One caveat found on the way: a terminal that scrolled far past its cap can leave ~64 KiB in the wasm instance when freed, linear over eight rounds of churn — small, but it is the one growth the PoC saw.                                                                                                                                                                                                   | [m6](./m6.md#daemon-memory)              |
| RSS grows without bound over the 24-hour soak → the daemon cannot be long-lived in Bun                       | **Not hit at 30 minutes; 24 hours not taken.** Twenty sessions held for 30 minutes: RSS fills to 105 MiB in the first minute (the noisy sessions' scrollback) and then sits at 105–109 MiB; the second-half slope is −1.6 MiB/h, event-loop lag never exceeds 12.4 ms, attach latency is the same at the end as at the start. The 24-hour run the proposal names is not taken; the runner and its exact command are ready.                                                                                                                                                                                    | [m6](./m6.md#the-soak)                   |
| A wasm trap in one session poisons the shared instance → instance-per-session at ~450 KiB each               | **Partly confirmed — the mitigation is warranted.** A single trap does **not** poison the shared instance: the other terminals and freshly created ones keep working. But seven repeated traps leak the module's shadow stack and poison it, a double free poisons it at once, and an unchecked resize grows it to 3 GiB before failing — and the daemon runs every wasm session in one instance. Parsing arbitrary PTY bytes never traps (the whole fuzz corpus agrees), so the exposure is werk's own handle-management bugs, not session output. Instance-per-session is the safe answer to that exposure. | [m6](./m6.md#trap-isolation)             |
| A lagging client cannot be detected before its queue passes the threshold → Bun's write signal is unusable   | **Not hit.** `socket.write`'s return value plus `drain` catch the lag the instant the daemon's own queue would cross the bound; the max queued never crossed it, and the fast client shared nothing with the slow one.                                                                                                                                                                                                                                                                                                                                                                                        | [m2](./m2.md), [m6](./m6.md#slow-client) |
| Snapshots do not decode across adjacent `tip` commits → state transfer works only within one werk version    | **Not hit for the builds measured.** The pin was the head of `main`, so no later `tip` build existed; the pin and the three nearest earlier `tip` builds (one byte-identical to the pin) decoded each other's snapshots identically in both directions. The daemon's mismatch rule handles the case where they would not.                                                                                                                                                                                                                                                                                     | [m3](./m3.md)                            |
| Rebasing `ghostty-web` costs more than writing a renderer → the renderer is werk's own from the start        | **Not hit.** The rebase did not cost more than the rest of the PoC combined; no line of the feared 1,620-line patch was needed, and what remained was the ordinary long tail of a terminal renderer.                                                                                                                                                                                                                                                                                                                                                                                                          | [m4](./m4.md)                            |
| The forwarded socket coalesces or drops frames at modest RTT → the remote transport needs framing of its own | **Not hit on Linux, macOS or Windows; loss and reorder not taken.** A TUI at 50 ms RTT paints in one round trip on macOS and, with `TCP_NODELAY`, on Linux; 200 frames sent 20 ms apart arrive in 200 reads through a macOS Unix-socket forward and a Windows loopback-TCP one, and 20,000 back to back arrive complete and in order through both. The forward did not drop under a 30 MiB flood. Real-network loss and reordering were not exercised.                                                                                                                                                        | [m5](./m5.md)                            |

**Not taken, and worth saying plainly.** The 24-hour soak (a 30-minute run
stands in, with the command for the full one recorded); the ffi adapter's
`darwin-x64` target, which has no build to measure (its `linux-arm64` and musl
targets are measured in [platforms.md](./platforms.md)); and **loss or
reordering** on the remote transport, which
`netem` latency alone does not exercise. Where a row above reads "not hit",
it is not hit _here_, on this machine, with these versions.

The other seven targets are taken separately, on hosted runners, in
[platforms.md](./platforms.md). What it settles that bears on the rows above:
the PTY is the controlling terminal on macOS as on Linux; the `darwin-arm64`
and vendored `win32-x64` ffi builds agree with this one on the differential
corpus byte for byte, and the wasm engine's report is byte-identical on all
eight targets. What it opens: macOS gives a unix stream socket an 8 KiB
buffer against Linux's 208 KiB, which changes when a client lags — raising it
on the listener's fd removes most of the lag episodes and none of the bytes
lost; and on Windows the PTY works while the daemon's readiness pipe does
not, the opposite of the order everyone expected — with a ready file and a
Windows lock in its place the daemon runs, and ConPTY's re-encoded output and
`TerminateProcess` kill semantics are the next questions.

The one row the PoC does not simply clear is trap isolation, and it clears in
werk's favour differently than feared: the shared instance is robust to
everything a session's own output can do to it, and fragile only to a
control-flow bug in werk's handle management — which instance-per-session, or
a supervised worker, would contain.

## What the platform work found

[platforms.md](./platforms.md) runs the same suites on hosted runners for all
eight `bun build --compile` targets. As plain findings:

- The wasm engine's differential report is byte-identical on all eight
  targets ([the other five targets](./platforms.md#the-other-five-targets)).
- The daemon starts from a cross-compiled binary and answers `ls` on every
  non-Windows target, and on both Windows targets through the package's
  `win32` branches (same section).
- On Windows the PTY works: `Bun.Terminal` is a real ConPTY, documented
  POSIX-only. With the lock done as `LockFileEx`, readiness as a polled file
  and the daemon spawned detached, `wp.exe ls` starts it; the suite then
  stops at ConPTY's re-encoded prologue and `TerminateProcess` kill
  semantics, at p50 15.6 ms in-process latency against 59–95 µs on Linux
  ([where each layer stands](./platforms.md#where-each-layer-stands),
  [where the Windows lane stands on `main`](./platforms.md#where-the-windows-lane-stands-on-main)).
- macOS gives a unix stream socket 8 KiB against Linux's 208 KiB.
  `setsockopt(SO_SNDBUF)` on the listener's fd is inherited by every accepted
  socket and cuts fast-client lag episodes from 20–22 to 3–4 without moving
  the bytes lost (about 6 MB either way), and neither does taking the fast
  client's sink out of the path: a pipe and a plain file lose as much as a
  PTY. The daemon delivers 1.5–1.9 MB there to a client that cannot be
  blocking, against 4.2–5.9 MB on a four-vCPU hosted Linux lane and all
  6.29 MB on the eight-core machine M2 was measured on — a loss that tracks
  the machine rather than anything the client did
  ([back-pressure](./platforms.md#back-pressure-an-8-kib-socket-buffer-against-linuxs-208-kib)).
- Every fresh `bun build --compile` binary fails `codesign --verify` on both
  macOS architectures until `codesign --force --sign -`, which the macOS
  build steps now do and both darwin lanes verify
  ([codesign](./platforms.md#every-fresh-compiled-binary-fails-codesign---verify)).
- The musl Bun is not static: both Alpine lanes need `libstdc++.so.6` and
  `libgcc_s.so.1` — 2.9 MB of them — before the binary runs at all, and a
  probe off the runners shows the release could carry the pair beside the
  binary instead
  ([what a musl host has to carry](./platforms.md#what-a-musl-host-has-to-carry)).
- `bun:ffi` imports on Windows arm64 but every `dlopen` through it throws
  "TinyCC is disabled" in Bun 1.3.14, so the daemon there locks through an
  exclusive named pipe instead — and a second daemon is refused while the
  first holds the name, on the compiled binary as well as the interpreted one
  ([the pipe lock, contended](./platforms.md#the-pipe-lock-contended)).
