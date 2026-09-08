# Session libraries

A daemon owns pseudo-terminals and saved screens on one machine. A client
connects to that daemon over any duplex byte stream and lists, creates, watches
and attaches to its sessions. A terminal core interprets a session's output and
rebuilds its screen anywhere, in a terminal or in a browser, with no process
behind it.

This document is the map: what the packages are, how they depend on each other,
how to build and validate them, and how to run the two consumers. Each package
README is the reference for its own API.

| Package                   | Reference                                                             |
| ------------------------- | --------------------------------------------------------------------- |
| `@werk/palette`           | [packages/palette](../packages/palette/README.md)                     |
| `@werk/terminal`          | [packages/terminal](../packages/terminal/README.md)                   |
| `@werk/terminal-beamterm` | [packages/terminal-beamterm](../packages/terminal-beamterm/README.md) |
| `@werk/session`           | [packages/session](../packages/session/README.md)                     |
| `@werk/session-daemon`    | [packages/session-daemon](../packages/session-daemon/README.md)       |
| `@werk/workspace`         | [packages/workspace](../packages/workspace/README.md)                 |
| `@werk/cli`               | [packages/werk](../packages/werk/README.md)                           |
| Browser example           | [examples/session-web](../examples/session-web/README.md)             |

## Words used in this file

| Word                   | What it means                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **record**             | The daemon's on-disk file for one session, live or finished: its metadata and a snapshot of its screen                                                                          |
| **checkpoint**         | Writing a record, and the saved snapshot inside it                                                                                                                              |
| **replica**            | `TerminalReplica` in `packages/terminal/src/replica.ts`. A client-side copy of a session's screen, rebuilt from snapshot bytes and attachment events, with no process behind it |
| **transport**          | A duplex byte stream with close and backpressure, and nothing more                                                                                                              |
| **attachment**         | One client's ordered event stream onto one session, with its own identity, generation and permissions                                                                           |
| **principal**          | Who a connection is acting as, assigned by whoever accepted the connection                                                                                                      |
| **effect**             | A side-channel event from the terminal, such as a bell or an OSC notification                                                                                                   |
| **preview tile**       | A small read-only text picture of a screen, refreshed on a timer                                                                                                                |
| **free size**          | No attachment holds the session's dimensions, so `resize` is refused until one claims them                                                                                      |
| **resync placeholder** | A marker queued in a stream's place, turned into a snapshot only when it reaches the front of the queue                                                                         |
| **engine factory**     | `TerminalEngineFactory`: one compiled WASM module, handing out one independent WASM instance per terminal                                                                       |

## How the packages depend on each other

The dependency direction runs one way.

`@werk/palette` is at the bottom of it. It holds the colours and what each is
for, has no dependencies of its own, and knows nothing about terminals, sessions
or the DOM. Everything that paints depends on it: the replica for the colours a
child's output is painted in, the CLI for the roles its own output is written
in, the browser example for the page. None of them names a colour itself. Which
colour scheme to use is the consumer's choice, and the package exports no
resolved flavour of its own, so a choice cannot be fixed by importing one.

`@werk/terminal` is the terminal core. It takes WASM bytes or a compiled module
explicitly, carries no DOM code, and knows nothing about daemons, sockets, PTYs
or product state. `./dom` is its only entry that touches the DOM, and
`@wterm/dom` is a dependency for that entry alone. `createColourReader` is a
reader for ghostty's colour syntax over the same artefact with no terminal
behind it. That syntax is what a terminal answers `OSC 11` in, and reading it
needs no grid, size or snapshot, so a caller that only wants to know what colour
a terminal is does not build a terminal to find out. The CLI's theme probe is
its only caller today.

`@werk/session` carries session identity, the client, ordered attachment events,
the daemon-wide subscription and the framing, over an injected transport and
with no Bun or native imports. It moves snapshot bytes without interpreting
them.

`@werk/session-daemon` is the only package that needs Bun, and it depends on the
other two. Nothing depends from the session client back to the daemon, which is
what lets a browser reach the same daemon through a different transport.

Workspace and repository management, remote placement, fleet aggregation,
browser routes, presentation, sharing policy and attention heuristics live in
consumers. They can use session labels, metadata and events without the session
packages understanding git branches, accounts or invitations.

### The protocol two packages implement

Protocol version 2 is binary and framed the same way in both directions.
`@werk/session/protocol` defines the frames, the framing and `FramedTransport`;
`@werk/session-daemon` implements the daemon side of the same protocol. The byte
layout and the transport obligations are in
[packages/session](../packages/session/README.md#the-wire-protocol).

The receive allocation bound is the fact the two packages negotiate: 32 MiB
towards a client and 1 MiB towards the daemon, each peer advertising its own cap
as `hello.maxFrameBytes`.

A transport is a duplex byte stream with close and backpressure and nothing
more, so a Unix socket, a named pipe, a loopback TCP connection with a token, a
socket forwarded over ssh and a WebSocket all satisfy it. Framing lives above
it.

The browser example speaks the protocol to the daemon over a WebSocket that its
bridge relays onto the local transport, so there is no second protocol between
the bridge and the page. Something that multiplexed several daemons into one
browser connection would be a client of each daemon. Towards the browser it
would implement the daemon side of the same protocol, applying its access policy
before relaying. Nothing does that today.

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

`build` orders library builds before consumers and compiles
`packages/werk/dist/werk` with its terminal WASM. `test:artefacts` checks built
exports and declarations, portable browser bundles and both renderer assets,
then copies the executable to a temporary directory outside the checkout. It
exercises detached ownership, input, resize, reconnect, saved-screen recovery
and removal there. The CLI renders a replica as ANSI cells in a TTY; external
terminal display fidelity still depends on that terminal's fonts and supported
attributes.

The artefact test uses a portable Bun child and executes its native PTY
lifecycle checks on Linux, macOS and Windows x64. It kills the copied daemon
abruptly after a running-state checkpoint, then verifies a `lost` record and its
saved screen. The native CI matrix also runs screen and process lifecycle tests
on each OS. Local Linux evidence does not establish native macOS or Windows
success; those results require the corresponding CI runners.

## Sessions, attachments and permissions

A session carries a name and a set of string labels supplied by whoever created
it, persisted in its record and its checkpoint envelope, returned on every
listing and filtered on by `list`. The library stores them and never interprets
them, so a workspace name, a placement, a checkout kind or a parent session are
the consumer's to define. A consumer that has lost track of a daemon can rebuild
its view from what that daemon already holds, without a second store beside it.

`SessionInfo` is what a listing returns.

| Field                                      | What it is                                                            |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `id`, `daemonId`, `name`, `labels`         | Identity, and what the creator called it                              |
| `state`, `exit`                            | Where the session is, and how it ended                                |
| `argv`, `cwd`, `reportedCwd`, `title`      | What is running, where it was started, and what it says about itself  |
| `size`, `scrollbackBytes`                  | The grid, and the page-memory budget the daemon gave it               |
| `createdAt`, `lastOutputAt`, `lastInputAt` | When it started and when it last did anything                         |
| `lastEffect`                               | The most recent effect                                                |
| `attachments`                              | Every attachment on it, with its principal, grants and size ownership |
| `checkpoint`                               | When the record was last written, and whether its snapshot decodes    |
| `processTree`                              | The foreground process and how many children it has                   |

Every connection has a principal, assigned by whoever accepted it: a local
socket takes the owner, and a bridge presents whoever it authenticated. Every
attachment inherits that principal and every listing shows it, so being watched
is visible on the owner's screen while it happens.

What an attachment may do, meaning `list`, `read` and `input`, is requested by
the client and granted or refused by the daemon through its `authorize` hook.
The library records principals and permissions and does not decide them. Every
attachment holding `input` feeds the one PTY in the order the daemon receives
it, and every attachment sees the same output, as if two people sat at one
keyboard. A consumer may end an attachment it did not make with
`endAttachment`, which is how a grant is taken back.

Effect kinds are open: an effect is a kind, a payload and a time, and a kind a
consumer does not know is passed through rather than dropped. So a new OSC
sequence is a change to `@werk/terminal` rather than a protocol change. Effects
reach both the ordered stream of an attachment and the daemon-wide watch.
Sequences that demand a reply into the PTY, such as device attribute and status
queries, are answered inside the daemon and never forwarded, because a consumer
cannot answer them in time and a program waiting on one hangs.

Attachment ordering, size ownership, preview tiles, scrollback budgets and the
environment rules are in
[packages/session](../packages/session/README.md). The daemon's queues, limits,
checkpoint rule and locking are in
[packages/session-daemon](../packages/session-daemon/README.md).

## Terminal interpretation is separate from painting

`@werk/terminal` holds the engine, the snapshot envelope, the replica, and the
interface a renderer implements: a `Frame` of changed rows, a `Renderer` that
paints it, and a `RendererFactory` that mounts one. The bundled renderer behind
`./dom` is a wterm adapter painting real DOM rows.

What a child's output is painted in comes from `@werk/palette`: one foreground,
one background, and the first sixteen indexed colours, taken from whichever
flavour the replica was constructed with. Only the sixteen entries the child has
left as the engine gave them are replaced, so a program that sets its own with
`OSC 4` keeps them, and the 240 above the sixteen are the child's throughout.

`@werk/terminal-beamterm` implements the same `RendererFactory` type over
WebGL2, and fetches its own 1.4 MB of WASM only when a page selects it. It
exists to prove that a renderer can be written against that interface alone,
rather than to be the default. A consumer that is neither a browser nor the
daemon is served by the same interface: a preview pane inside a TUI, or a
terminal client carrying a replica, paints frames from the same core.

Engine state is allocated through a session-scoped factory, so each session gets
its own WASM instance and no consumer holds a raw WASM handle or shares
allocator lifetime. Separate memories contain allocator corruption. They do not
by themselves prevent a CPU stall or a process-wide OOM.

The pinned engine has one known defect that the library works around, described
in [terminal-engine-defects.md](terminal-engine-defects.md).

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

`werk create` also makes a workspace for the session: a git worktree of the
repository you are standing in, on a new branch, under `$stateDir/workspaces`,
and the session runs in that worktree rather than in your checkout.
`--workspace NAME` names it and its branch. See
[packages/workspace](../packages/workspace/README.md) for what the interface
does and what it deliberately leaves open.

Ctrl-] detaches. Every command renders for a person by default and answers with
the same record under `--json`. [cli.md](cli.md) is the reference for the
command set, the two output modes, exit codes, configuration and shell
completion, and [packages/werk](../packages/werk/README.md) for what the client
does with a session: the status row, grid clipping, input pipelining and the
environment it sends.

For the local browser consumer, start a daemon with an explicit runtime
directory. Any command starts one, or `werk daemon serve` holds it in the
foreground. Then run:

```sh
bun examples/session-web/dist/server.js /absolute/runtime/endpoint.json 4319
```

Open `http://127.0.0.1:4319`. The example supports listing, attachment, input, a
strip of preview tiles and renderer selection. Its bridge is a local owner
bridge; see the [browser README](../examples/session-web/README.md) for its
access boundary. Package asset directories retain licence and provenance records
beside their pins.

## The soak harness, and what it has and has not measured

`bun run test:soak` exercises a steady PTY, repeated create, attach, terminate
and remove cycles, and an independently delayed viewer. The injected transport
fragments both u32 frame header lengths into single bytes and bodies into 4 KiB
chunks. A two-millisecond frame delay represents an artificial remote path; the
slow viewer uses 200 ms. This measures framing and backpressure under injected
latency, not a real SSH, container or wide-area network deployment. Viewer
resynchronisations must occur. The harness samples RSS, event-loop lag and
daemon queue diagnostics every 100 ms, and measures attachment completion
latency and retained-state cleanup. Linux also counts `/proc/self/fd` before and
after; other platforms report that measurement as unavailable rather than
substituting an invented native handle count.

```sh
SOAK_SECONDS=60 SOAK_REPORT=soak.json bun run test:soak
SOAK_SECONDS=86400 SOAK_BASELINE=docs/session-library/linux-x64-baseline.json SOAK_REPORT=soak.json bun run test:soak
```

The duration accepts 10 through 86,400 seconds. `SOAK_BASELINE` enables
regression budgets: peak RSS at most twice the baseline, and p99 attachment and
event-loop latency at most three times the baseline with a 100 ms floor. These
initial thresholds provide investigation triggers, not capacity promises. The
harness configures a 32 KiB output queue per connection and expects output
queues to stay within it and control queues within 64 MiB plus eight bytes per
connection. After cleanup there must be no sessions, connections or attachments;
Linux descriptors may increase by at most four for runtime bookkeeping.

The checked-in [Linux x64 baseline](session-library/linux-x64-baseline.json) ran
on Bun 1.3.14 on Linux x64 for **60.057 seconds**, with 327 churn sessions and
237 slow-viewer resynchronisations. Peak RSS was 117,551,104 bytes, p99
attachment latency 5.87 ms and p99 event-loop lag 2.29 ms. Aggregate output
queue peak was 33,255 bytes over two connections. File descriptors returned from
13 to 13, and all diagnostic resource counts returned to zero. Command:
`SOAK_REPORT=docs/session-library/linux-x64-baseline.json bun scripts/session-soak.ts`.

This is a short baseline, not a 24-hour soak result. The manual CI workflow
offers a full-day run on a self-hosted Linux x64 runner because hosted jobs have
a shorter time limit. That runner has never been provisioned, so the lane has
never run and these budgets have never been enforced by CI. The 60-second
`test:soak` step that does run on every pull request passes no `SOAK_BASELINE`,
so it exercises liveness, framing, backpressure and cleanup and asserts none of
the budgets above. What the routine step should assert is
[open question 1 in docs/ci.md](ci.md#1-what-should-the-routine-soak-step-assert).
Regressions should retain the JSON report and be investigated before updating
the baseline; changing the reference should identify the runtime, platform and
workload.

## Compatibility and upgrades

The packages remain private and should be built and deployed together. The
handshake carries the protocol version independently of the engine build and the
snapshot format version. A protocol mismatch refuses the connection. An engine
or snapshot mismatch permits the connection and listing, but a saved screen may
be undecodable. Consumers should inspect `checkpoint.decodable` and its reason,
and should not read a successful connection as proof of snapshot support.

Before replacing a daemon, inspect the active sessions and save the state
directory. A planned shutdown terminates its processes and retains checkpoints.
An abrupt death can recover the last persisted screen as a `lost` read-only
record; it does not revive the process or recover output newer than that
checkpoint. There is no uninterrupted process-preserving daemon upgrade
contract.

Undecodable checkpoint files are preserved for diagnosis or use with a
compatible engine. Keep a copy of those files before removing a record or
changing engines. A daemon that serves a lower `scrollbackMaxBytes` than a
record was created with restores that record at the lower budget and prunes its
oldest pages.

Creation and input timeouts have an unknown remote outcome. Consumers should
reconcile session listings and must not automatically replay those operations.

Where the daemon keeps its socket, its lock and its record, how the lock is
held on each platform, and how it recovers a lost endpoint are in
[packages/session-daemon](../packages/session-daemon/README.md#paths-locking-and-recovery).

## Two assumptions that could still change

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
separate probably keeps that a daemon implementation change. Uninterrupted
attachment and upgrade semantics would still need design and proof.
