# Session libraries

The workspace provides private Bun packages with built JavaScript, declarations
and explicit exports. `@werk/session` implements the portable protocol and client
with an injected duplex transport. `@werk/terminal` owns terminal interpretation,
snapshots and replicas; its core takes WASM explicitly, `./bun` loads embedded
assets and `./dom` mounts the bundled renderer. `@werk/terminal-beamterm` supplies
an optional renderer through the same factory. `@werk/session-daemon` owns PTYs,
checkpoints, local transport and detached startup.

The CLI and browser example consume public package entry points. Closing either
consumer leaves the process with its daemon. Shutting down that daemon ends its
processes and retains screen checkpoints; reopening the state directory recovers
read-only records, not live processes. Protocol compatibility is separate from
snapshot compatibility. Daemon capabilities report native operations available
on the running platform.

## Build and validate

From the repository root:

```sh
bun install
bun run build
bun run typecheck
bun run test
bun run test:browser
bun run test:artefacts
bun run format:check
```

`build` orders library builds before consumers and compiles `packages/werk/dist/werk`
with its terminal WASM. `test:artefacts` checks built exports and declarations,
portable browser bundles and both renderer assets, then copies the executable to
a temporary directory outside the checkout. It exercises detached ownership,
input, resize, reconnect, saved-screen recovery and removal there. The CLI renders
a snapshot replica as ANSI cells in a TTY; external terminal display fidelity
still depends on that terminal's fonts and supported attributes.

The artefact test uses a portable Bun child and executes its native PTY lifecycle
checks on Linux, macOS and Windows x64. It kills the copied daemon abruptly after
a running-state checkpoint, then verifies a `lost` record and its saved screen.
The native CI matrix also runs screen and process lifecycle tests on each OS.
Local Linux evidence does not establish native macOS/Windows success; those
results require the corresponding CI runners.

## Wire and scheduling

The protocol is version 2 and binary. A frame is a big-endian u32 body length, a
u32 JSON header length, the UTF-8 JSON header, then u32-length-prefixed raw
blobs; a reserved `{"$b":i}` singleton in the header references blob `i`.
Decoded byte arrays are views into the frame body and should be treated as
read-only. The receive allocation bound applies to the whole raw body: 32 MiB
towards a client and 1 MiB towards the daemon, each peer advertising its own cap
as `hello.maxFrameBytes`. Input is chunked to at most 64 KiB, reduced for the
peer's advertised cap. The daemon encodes each message once and queues the
bytes.

Each attachment has one ordered stream on its connection, holding pre-encoded
frames. Only output is droppable. When a connection's output budget
(`limits.outputQueueBytes`) is exceeded, the stream with the largest output
backlog loses that backlog and gets a resync placeholder that reserves its
stream position immediately and is snapshotted only when it reaches the head, so
a slow viewer costs one snapshot rather than one per event. A resize also
invalidates, because the pinned engine's reflow of a restored wrapped line can
disagree with a replica's. Nothing else does: effects, exits and size-holder
changes ride the stream as control frames. `limits.resyncIntervalMs` (250 ms) is
the minimum spacing between resyncs on one stream, so a persistently slow viewer
cannot pay for a snapshot on every send. Streams are served round-robin after
the connection's control queue, and `ended` is always delivered.

Watch events carry the full record. `activity` and `effect` coalesce per session
and per kind — leading edge, then at most one more per `limits.notifyIntervalMs`
(250 ms), latest payload winning — and what is pending is drained before a state
change, so nothing trails `exited`. An attachment still receives every effect on
its own stream.

`limits.sessions` (128) bounds live processes and in-flight creates, so a
retained record never refuses a new session; `limits.retainedSessions` (512)
bounds exited, failed and lost records and evicts the oldest through the same
path as `remove`, notifying `removed`. Startup keeps as many retained files as
the cap allows and leaves the rest on disk untouched.

A record is checkpointed when it has something new to save — output, a resize,
an effect, a state change, and once more on exit. `limits.checkpointIntervalMs`
(5 s) is how often the daemon looks rather than how often it writes; restored
and `lost` records are never rewritten, so the `checkpoint` watch event reports
a file that changed rather than daemon liveness. Startup validates a saved
snapshot's header instead of decoding it, and `checkpoint.decodable` reports
that check, so a daemon holding hundreds of retained records builds a terminal
for none of them. A screen is decoded the first time something in the daemon
needs it; an attachment that replicates the terminal is sent the checkpoint
bytes and decodes them on the client. A record with no live process gives its
terminal back once its screen is safely on disk and nothing has read it for
`limits.terminalIdleMs` (60 s).

`limits.scrollbackMaxBytes` (10,000,000) bounds the page-memory budget a
session's scrollback may have. The daemon always passes an explicit budget, so a
session never runs on the engine's own default; `create({ scrollbackBytes })`
above the cap is a `LIMIT` error rather than a silent clamp, the value the
session got is on `SessionInfo` and the cap is advertised as
`capabilities.scrollbackMaxBytes`. Bytes are page memory rather than text and
the engine retains whole pages, so a budget buys an approximate row count that
depends on grid width: at the cap and 120 columns, roughly 9,200 rows and a
snapshot of about 0.7 MB. Nothing bounds the sum across sessions.

At most one attachment holds a session's size, and the size may be free.
`attach` takes `holdSize`: `never` never takes it and is never a successor,
`if-free` takes it when nobody holds it, `claim` also takes it from the current
holder subject to the daemon's `claimSize` action, degrading to attaching
without it rather than failing. The default is `if-free` where input was granted
and `never` otherwise. `claimSize()` makes the same request after attach.
`AttachmentInfo` carries `representation` and `holdSize` beside `holdsSize`, so
a listing can tell a tile from a terminal.

A `preview` attachment is a tile rather than a terminal: read-only, holding no
size, receiving `preview`, `exit` and `ended` and nothing else. A record formats
its active screen once per interval for each distinct format its tiles asked for
and sends the same text to all of them, so twenty tiles on one session cost one
formatter call per interval. Preview viewers sit outside the output broadcast
and the resync machinery, and a newer frame replaces one that has not been sent.
Measured on one Linux machine at 120x40, a text frame costs about 0.11 ms and
6.7 KB against about 0.53 ms and 287 KB for a snapshot of the same screen.

Replica paints are coalesced to one per scheduler tick —
`requestAnimationFrame` in browsers, `setTimeout(0)` elsewhere, injectable
through `options.schedulePaint` — and `frame()` walks only the rows the engine's
render state reports dirty, so an idle or one-cell frame costs a fraction of a
millisecond at any grid size. `flush()` paints pending state synchronously.

## Run the consumers

```sh
packages/werk/dist/werk create --name demo --scrollback 2000000 -- /bin/sh
packages/werk/dist/werk list
packages/werk/dist/werk watch
packages/werk/dist/werk attach SESSION_ID
packages/werk/dist/werk logs SESSION_ID
packages/werk/dist/werk kill SESSION_ID --intent force
packages/werk/dist/werk remove SESSION_ID
packages/werk/dist/werk info
packages/werk/dist/werk doctor
```

Ctrl-] detaches. `create` sends the invoking shell's environment minus terminal
identity, multiplexer markers, shell bookkeeping and `GPG_TTY`; the daemon
applies it over a minimal base and owns `TERM`, `COLORTERM`, `TERM_PROGRAM`,
`TERM_PROGRAM_VERSION`, `WERK_SESSION` and `WERK_DAEMON`.

Attaching to a session that has already finished paints its saved screen and
returns, reporting the outcome on stderr — the exit status where there is one,
and for a `lost` record the fact that the daemon has none. Stdout carries only
the screen, so a piped attachment stays clean. Such an attachment registers no
viewer, and input and resize on a record with no live process are refused as
`CONFLICT`.

`attach --read-only` requests no input permission and leaves the session grid
alone; `attach --follow` declines the grid even with input, and
`attach --claim-size` takes it from whoever holds it, attaching without it when
the daemon refuses. `--follow` and `--claim-size` cannot be combined. Whenever
the attachment is not the one setting the grid, the CLI clips the session grid
to the local window, clears on any change of either, and spends the bottom row
on a status line naming both sizes for as long as they differ. Input is
pipelined: stdin pauses once 32 unacknowledged input requests or 64 KiB are in
flight and resumes as that window drains.

`logs --history` reads retained history; it is not a complete durable output
log. `info` prints the resolved paths, the lock mechanism, the recorded daemon
pid and boot identifier, and the daemon's identity and capabilities when one
answers. `doctor` adds runtime-directory, state-directory, lock and terminfo
checks and the tail of `$stateDir/daemon.log` with its last error line; both are
read-only. The daemon logs a fixed event vocabulary to that file at
`--log-level` or `WERK_LOG_LEVEL` (`error`, `warn`, `info`, `debug`), rotating
at 5 MB and keeping three files; environment values, input bytes and
credentials are never written. All commands accept explicit `--runtime-dir PATH`
and `--state-dir PATH`. The CLI supplies its own `session-daemon` command to the
detached launcher.

For the local browser consumer, start a daemon via a CLI command with an explicit
runtime directory, then run:

```sh
bun examples/session-web/dist/server.js /absolute/runtime/endpoint.json 4319
```

Open `http://127.0.0.1:4319`. The example supports listing, attachment, input,
a strip of `preview` tiles and renderer selection. Its bridge is a local owner
surface; see the [browser README](../examples/session-web/README.md) for its
access boundary. Package asset directories retain licence and provenance records
beside their pins. No library or consumer imports PoC source.

## Operational measurements

`bun run test:soak` exercises a steady PTY, repeated create/attach/terminate/remove
cycles and an independently delayed viewer. The injected transport fragments
both u32 frame header lengths into single bytes and bodies into 4 KiB chunks. A two-millisecond
frame delay represents an artificial remote path; the slow viewer uses 200 ms.
This measures framing and backpressure under injected latency, not a real SSH,
container or wide-area network deployment. Viewer resynchronisations must occur.
The harness samples RSS, event-loop lag and daemon queue diagnostics every 100 ms,
and measures attachment completion latency and retained-state cleanup. Linux also
counts `/proc/self/fd` before and after; other platforms report that measurement
as unavailable rather than substituting an invented native handle count.

```sh
SOAK_SECONDS=60 SOAK_REPORT=soak.json bun run test:soak
SOAK_SECONDS=86400 SOAK_BASELINE=docs/session-library/linux-x64-baseline.json SOAK_REPORT=soak.json bun run test:soak
```

The duration accepts 10 through 86,400 seconds. `SOAK_BASELINE` enables regression
budgets: peak RSS at most twice the baseline, and p99 attachment/event-loop latency
at most three times the baseline with a 100 ms floor. These initial thresholds
provide investigation triggers, not capacity promises. The harness configures a
32 KiB output queue per connection and expects output queues to stay within it
and control queues within 64 MiB plus eight bytes per connection. After cleanup
there must be no sessions, connections or attachments; Linux descriptors may
increase by at most four for runtime bookkeeping.

The checked-in [Linux x64 baseline](session-library/linux-x64-baseline.json) ran
on Bun 1.3.14 on Linux x64 for **60.057 seconds**, with 327 churn sessions and
237 slow-viewer resynchronisations. Peak RSS was 117,551,104 bytes, p99
attachment latency 5.87 ms and p99 event-loop lag 2.29 ms. Aggregate output
queue peak was 33,255 bytes over two connections. File descriptors returned from
13 to 13, and all diagnostic resource counts returned to zero. Command:
`SOAK_REPORT=docs/session-library/linux-x64-baseline.json bun scripts/session-soak.ts`.
This is a short baseline, not a 24-hour soak result. The manual CI workflow offers
a full-day run on a self-hosted Linux x64 runner because hosted jobs have a shorter
time limit. Its runner must be provisioned before that evidence can be collected.
Regressions should retain the JSON report and be investigated before updating the
baseline; changing the reference should identify the runtime, platform and workload.

## Compatibility and upgrades

The packages remain private and should be built and deployed together. The
handshake carries the protocol version independently of the engine build and
snapshot format version. A protocol mismatch refuses the connection. An engine
or snapshot mismatch permits the connection and listing, but a saved screen may
be undecodable. Consumers should inspect `checkpoint.decodable` and its reason;
they should not interpret successful connection as proof of snapshot support.

Before replacing a daemon, inspect the active sessions and save the state
directory. A planned shutdown terminates its processes and retains checkpoints.
An abrupt death can recover the last persisted screen as a `lost` read-only
record; it does not revive the process or recover output newer than that
checkpoint. There is no uninterrupted process-preserving daemon upgrade contract.
Undecodable checkpoint files are preserved for diagnosis or use with a compatible
engine. Keep a copy of those files before removing a record or changing engines.
A daemon that serves a lower `scrollbackMaxBytes` than a record was created with
restores that record at the lower budget and prunes its oldest pages.
Creation and input timeouts have an unknown remote outcome; consumers should
reconcile session listings and must not automatically replay those operations.

The CLI runtime directory defaults to `/tmp/werk-UID` on POSIX and
`%LOCALAPPDATA%\werk\run` on Windows. Set `WERK_RUNTIME_DIR` or pass
`--runtime-dir` to override it (the flag wins). Existing POSIX runtime
directories must belong to the current user and have mode `0700`; the client
checks this and the 103-byte Unix socket path limit before starting a daemon.

The exclusive lock lives at `$stateDir/daemon.lock`, so at most one daemon runs
per state directory whatever runtime directory it is given; where the state
directory cannot hold a lock the daemon falls back to `$runtimeDir/daemon.lock`
and the guarantee narrows to one daemon per runtime directory. `$stateDir/daemon.json`
records the pid, a boot identifier, the runtime directory, the endpoint and the
start time, and `ensureSessionDaemon` reads it rather than spawning a second
daemon beside a live one. The daemon compares its socket's inode with the one it
bound every five seconds and on `SIGUSR1`, recreating the runtime directory, the
socket, `endpoint.json` and the lock file when they vanish; running sessions and
established connections are unaffected.
