# Session libraries

The workspace provides private Bun packages with built JavaScript, declarations
and explicit exports. `@werk/session` implements the portable protocol and client
with an injected duplex transport. `@werk/terminal` owns terminal interpretation,
snapshots and replicas; its core takes WASM explicitly, `./bun` loads embedded
assets and `./dom` mounts the bundled renderer. `@werk/terminal-beamterm` supplies
an optional renderer through the same factory. `@werk/session-daemon` owns PTYs,
checkpoints, local transport and detached startup. `@werk/palette` is Catppuccin's four
flavours mapped to the uses werk puts colour to, and is the one place any colour
is named.

The CLI and browser example consume public package entry points. Closing either
consumer leaves the process with its daemon. Shutting down that daemon ends its
processes and retains screen checkpoints; reopening the state directory recovers
read-only records, not live processes. Protocol compatibility is separate from
snapshot compatibility. Daemon capabilities report native operations available
on the running platform.

## Package boundaries

The dependency direction runs one way. `@werk/palette` is at the bottom of it: it
holds the colours and what each is for, has no dependencies of its own, and knows
nothing about terminals, sessions or the DOM. Everything that paints depends on
it — the replica for the colours a child's output is painted in, the CLI for the
roles its own output is written in, the browser example for the page — so that
none of them names a colour itself. Which flavour to wear is nobody's business
but the consumer's: the package exports no resolved flavour of its own, so a
choice cannot be fixed by importing one.

`@werk/terminal` is the terminal core: it
takes WASM bytes or a compiled module explicitly, carries no DOM code, and knows
nothing about daemons, sockets, PTYs or product state. `./dom` is its only entry
that touches the DOM, and `@wterm/dom` is a dependency for that entry alone.
`createColourReader` is the same artefact without a terminal: it reads ghostty's
colour syntax, which is what a terminal answers `OSC 11` in, and needs no grid,
size or snapshot, so a caller that only wants to know what colour a terminal is
does not build a terminal to find out. The CLI's theme probe is its only caller
today.
`@werk/session` carries session identity, the client, ordered attachment events,
the daemon-wide subscription and the framing, over an injected transport and
with no Bun or native imports; it moves snapshot bytes without interpreting
them. `@werk/session-daemon` is the only package that needs Bun, and it depends
on the other two. Nothing depends from the session client back to the daemon,
which is what lets a browser reach the same daemon through a different
transport.

A transport is a duplex byte stream with close and backpressure and nothing
more, so a Unix socket, a named pipe, a loopback TCP connection with a token, a
socket forwarded over ssh and a WebSocket all satisfy it; framing lives in
`@werk/session/protocol` above it. The browser example speaks the protocol to
the daemon over a WebSocket that its bridge relays onto the local transport,
so there is no second wire between the bridge and the page. Something that fanned
several daemons into one browser connection would be a client of each daemon
and, towards the browser, an implementer of the daemon side of the same
protocol, applying its access policy before relaying; nothing does that today.

Workspace and repository management, remote placement, fleet aggregation,
browser routes, presentation, sharing policy and attention heuristics live in
consumers. They can use session labels, metadata and events without the session
packages understanding git branches, accounts or invitations.

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
and `never` otherwise. `claimSize()` makes the same request after attach, and a holder can pass the
size to another attachment on the same session with `transferSize()`. When a
holder's attachment ends the size goes to whichever remaining attachment is
likeliest to be driving the terminal: one that can type, then one that asked to
claim, then the most recent, and it becomes free where nobody qualifies.
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

## Sessions, attachments and permissions

A session carries a name and a set of string labels supplied by whoever created
it, persisted in its record and its checkpoint envelope, returned on every
listing and filtered on by `list`. The library stores them and never interprets
them, so a workspace name, a placement, a checkout kind or a parent session are
the consumer's to define, and a consumer that has lost track of a daemon can
rebuild its view from what that daemon already holds without a second store
beside it. `SessionInfo` also summarises the process tree the daemon owns — the
foreground process and how many children it has — beside the last output and
input times, the last title, the reported working directory, the last effect,
the exit outcome, the attachments, the checkpoint and the scrollback budget the
session got.

Every connection has a principal, assigned by whoever accepted it: a local
socket takes the owner, and a bridge presents whoever it authenticated. Every
attachment inherits that principal and every listing shows it, so being watched
is visible on the owner's screen while it happens. What an attachment may do —
`list`, `read` and `input` — is requested by the client and granted or refused
by the daemon through its `authorize` hook; the library records principals and
permissions and does not decide them. Every attachment holding `input` feeds the
one PTY in the order the daemon receives it and every attachment sees the same
output, as if two people sat at one keyboard. A consumer may end an attachment
it did not make with `endAttachment`, which is how a grant is taken back.

Each attachment has its own identity and generation, even where it replaces an
attachment to the same session, and every event carries the attachment id, that
generation and a stream position, so a replica can reject a stale event and
recognise a gap. An invalidated handle cannot send input, resize or detach its
replacement. An attachment ends with a stated reason — `detached`,
`session-ended`, `connection-closed` or `revoked` — as its last event.

Effect kinds are open: an effect is a kind, a payload and a time, and a kind a
consumer does not know is passed through rather than dropped, so a new OSC
sequence is a terminal-package change rather than a protocol change. Effects
reach both the ordered stream of an attachment and the daemon-wide watch.
Sequences that demand a reply into the PTY, such as device attribute and status
queries, are answered inside the daemon and never forwarded, because a consumer
cannot answer them in time and a program waiting on one hangs.

## Terminal engine and renderers

Terminal interpretation is separate from painting. `@werk/terminal` holds the
engine, the snapshot envelope, the replica and the render-consumer seam: a
`Frame` of changed rows, a `Renderer` that paints it and a `RendererFactory`
that mounts one. The bundled renderer behind `./dom` is a wterm adapter painting
real DOM rows. What a child's output is painted in comes from `@werk/palette`: one foreground,
one background, and the first sixteen indexed colours, taken from whichever
flavour the replica was constructed with. Only the sixteen entries the child has
left as the engine gave them are replaced, so a program that sets its own with
`OSC 4` keeps them, and the 240 above the sixteen are the child's throughout.
`@werk/terminal-beamterm` sits behind the same factory over
WebGL2 and fetches its own 1.4 MB of WASM only when a page selects it; it is
maintained to keep the seam honest rather than offered as the default. The seam
serves a consumer that is neither a browser nor the daemon just as well: a
preview pane inside a TUI, or a terminal client carrying a replica, paints
frames from the same core.

Engine state is allocated through a session-scoped factory, so each session gets
its own WASM instance and no consumer holds a raw WASM handle or shares
allocator lifetime. Separate memories contain allocator corruption; they do not
by themselves prevent a CPU stall or a process-wide OOM.

### An appended grapheme does not dirty its row

The pinned engine build has a defect. A combining mark or a zero width joiner
that attaches to a cell already holding a codepoint changes that cell — its
content tag becomes `CODEPOINT_GRAPHEME` and its grapheme list grows — but
`ghostty_render_state_update` leaves the global dirty state at
`GHOSTTY_RENDER_STATE_DIRTY_FALSE`, no row reports itself dirty, and the render
state does not re-copy the row, so its own view of that cell stays at the old
value until something else dirties the row. That last part is what makes it hard
to handle from outside: the stale row is inside the render state, so a caller
cannot notice the change by re-reading the state it already has. An ordinary
write is the control and behaves as documented, dirtying the row it touched and
the row the cursor left.

The build is `ghostty-vt-small.wasm` from ghostty commit
`3c1ef5b32fc5ea6b93d28493fabf193f595139cf`, which is
`packages/terminal/assets/terminal.wasm` here. Only the render state C ABI is
involved, so the behaviour restates against a native build or in Zig: write `e`,
update and clean a long-lived render state, write U+0301, and the next update
reports `FALSE` while a render state created fresh after that write shows both
codepoints in the cell. What is established is that a combining mark and a zero
width joiner appended to an existing cell each leave the row clean. Whether
other cell mutations that do not move the cursor are affected is not, though
scripts covering insert and delete of characters and lines, scroll regions, tabs
and backspace, alt screen, hyperlinks, underline colours and OSC 4/10/11 found
nothing else. Where the omission sits in the Zig source is unknown, and the
behaviour has not been reported to
<https://github.com/ghostty-org/ghostty/issues>, which is where it belongs.

`packages/terminal/src/engine.ts` works around it with a `wrote` flag set on
every `ghostty_terminal_vt_write`. Where a frame follows a write and the dirty
walk did not deliver the cursor's row and the row above it — two rows, because a
write can wrap the cursor — those rows are decoded from a throwaway render state
created and freed for that frame alone. It costs 0.02 to 0.05 ms on the frames
that need it and nothing on the rest, and a frame after a write that produced no
dirty rows at all, an SGR-only write for instance, pays a render state
allocation for nothing. The fallback and the flag can both go once the engine
dirties those rows.

## Run the consumers

```sh
packages/werk/dist/werk create --detach --name demo --scrollback 2000000 -- /bin/sh
packages/werk/dist/werk list
packages/werk/dist/werk watch
packages/werk/dist/werk attach SESSION_ID
packages/werk/dist/werk logs SESSION_ID
packages/werk/dist/werk kill SESSION_ID --intent force
packages/werk/dist/werk remove SESSION_ID
packages/werk/dist/werk info
packages/werk/dist/werk doctor
```

Ctrl-] detaches. Every command renders for a person by default and answers with
the same record under `--json`; [cli.md](cli.md) is the reference for the
command surface, the two output registers, exit codes, configuration and shell
completion. What follows here is what the CLI shows about the session library in
particular.

`create` sends the invoking shell's environment minus terminal
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
the daemon refuses. `--follow` and `--claim-size` cannot be combined. The CLI
spends the bottom local row on a status line of its own, naming the session, the
key that detaches and whether the attachment is read-only; the session grid gets
the window less that row, and only a window one row tall gives it up. Whenever
the attachment is not the one setting the grid, the CLI clips the session grid
to that area, clears on any change of either grid, and the status line also
names both sizes and what would take the size for as long as they differ. Input
is pipelined: stdin pauses once 32 unacknowledged input requests or 64 KiB are
in flight and resumes as that window drains.

`logs --history` reads retained history; it is not a complete durable output
log. `info` prints the resolved paths, the lock mechanism, the recorded daemon
pid and boot identifier, and the daemon's identity and capabilities when one
answers. `doctor` adds runtime-directory, state-directory, lock and terminfo
checks and the tail of `$stateDir/daemon.log` with its last error line; both are
read-only. The daemon logs a fixed event vocabulary to that file at
`--log-level` or `WERK_LOG_LEVEL` (`error`, `warn`, `info`, `debug`), rotating
at 5 MB and keeping three files; environment values, input bytes and
credentials are never written. `--runtime-dir PATH` and `--state-dir PATH` are
accepted on every command, before or after the command name. The CLI supplies
its own `daemon serve` command to the detached launcher, and
`werk daemon serve` runs one in the foreground for an operator who would rather
supervise it.

For the local browser consumer, start a daemon with an explicit runtime
directory — any command starts one, or `werk daemon serve` holds it in the
foreground — then run:

```sh
bun examples/session-web/dist/server.js /absolute/runtime/endpoint.json 4319
```

Open `http://127.0.0.1:4319`. The example supports listing, attachment, input,
a strip of `preview` tiles and renderer selection. Its bridge is a local owner
surface; see the [browser README](../examples/session-web/README.md) for its
access boundary. Package asset directories retain licence and provenance records
beside their pins.

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
time limit. That runner has never been provisioned, so the lane has never run and
these budgets have never been enforced by CI. The 60-second `test:soak` step that
does run on every pull request passes no `SOAK_BASELINE`, so it exercises
liveness, framing, backpressure and cleanup and asserts none of the budgets above.
What the routine step should assert is
[open question 1 in docs/ci.md](ci.md#1-what-should-the-routine-soak-step-assert).
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

## What could still change

Two assumptions are worth naming, because changing either would move code
between packages rather than inside one.

The packages assume one daemon per machine owning many sessions, with fault
containment coming from the session-scoped engine instance. One daemon per
session, discovered by scanning a directory, remains possible; it would change
discovery, which lives in the daemon package, more than it would change the
client or the terminal core.

A live process surviving replacement or failure of its owning daemon is the more
consequential one. Nothing asks for it and nothing provides it. If it were
wanted, a separate PTY owner or supervisor is the likely shape, and keeping
daemon discovery, session identity, client transport and process ownership
separate probably keeps that a daemon implementation change; uninterrupted
attachment and upgrade semantics would still need design and proof.
