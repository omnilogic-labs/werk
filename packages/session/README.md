# @werk/session

Private portable session client and protocol. Build with `bun run build`. Both
public entries expose built JavaScript and declarations; neither imports a
runtime, sockets, filesystem or terminal engine.

Supply a `Transport` with readable/writable byte streams and an idempotent close
operation. `connectSessionClient` negotiates protocol version 2. Engine build
differences do not refuse a connection. The daemon assigns the principal and
grants permissions; requested grants are never treated as authority by the client.

## Sessions and watching

`create`, `list`, `get`, `readScreen`, `readHistory`, `terminate`, `remove`,
`daemonInfo` and `endAttachment` work without attachment. `watch(callback)`
returns an idempotent stop function with a `ready` promise for subscription
acceptance. Await `watch().ready` before loading the initial list to avoid a
subscription gap, and reconcile events received during that request. Watch and
attachment callback errors are isolated and optionally reported via
`onCallbackError`.

Watch events contain the current session metadata, including principals, grants
and size ownership. `attachments-updated`, `resized` and `checkpoint` report
changes without requiring a terminal attachment. `checkpoint` arrives only when
a saved screen is written, so it says a record changed rather than that the
daemon is alive. `removed` deletes the row and carries its final metadata, and
arrives for a record the daemon evicts to stay within its retention limit as
well as for an explicit `remove`. `activity` and `effect` are coalesced by the
daemon per session and per kind, so a busy session reports a rate rather than
every occurrence, and the daemon drains what it holds before a state change, so
no notification follows `exited`; an attachment still receives every effect on
its own stream. Per-session list authorisation also gates events, and list
label/state filters should be applied to incoming metadata when maintaining a
filtered view.

## Attachments

Attachments have unique identities and generations. Their first event carries
authoritative state: a snapshot, or a `preview` frame for a preview attachment.
Subsequent positions increase by one. A resync may advance across a gap. A stale
generation or duplicate position is ignored; a gap without resync closes the
connection. Every event, including the final `ended`, identifies its recipient
attachment. Size-holder events update that recipient's authority. Closing a
client ends its attachments and never requests session termination.

Attaching to a session with no live process succeeds and delivers the saved
screen, then the recorded outcome as an `exit` when the daemon has one, then
`ended` with reason `session-ended`. Such an attachment holds no size, never
appears among the session's attachments, and refuses input and resize; a `lost`
record ends without an `exit` because its outcome is unknown, and its state is
read from `get` or the watch stream.

`inputChunkBytes(attachmentId)` reports the largest input chunk the peer's
advertised frame cap allows, which is what `write` splits against.

## Size ownership

At most one attachment on a session holds the size, and the size may be free.
`attach` takes `holdSize`: `never` never takes it and is never a successor,
`if-free` takes it when nobody holds it, and `claim` also takes it from the
current holder where the daemon allows the takeover. The default is `if-free`
when input is granted and `never` otherwise, so a watcher leaves the size with
whoever is typing. A refused claim attaches without the size rather than
failing, and the attach response says what happened. `claimSize()` makes the
same request afterwards; it needs input, and the daemon's permission whenever
someone else holds the size. `transferSize(target)` hands the size on from the
holder to any attachment that did not ask for `never`. When a holder leaves,
the size passes to an input-capable attachment, then to one that asked to
claim, then to the most recent; where nobody qualifies no attachment holds it
and `resize` is refused until one claims it. `AttachmentInfo` carries
`representation` and `holdSize` beside `holdsSize`, so a listing distinguishes
a watcher from a terminal and shows who could take the size.

## Preview attachments

A `preview` attachment is a tile rather than a terminal: it is read-only, holds
no size, and receives `preview`, `exit` and `ended` and nothing else. Its first
event is a `preview` frame in place of a snapshot. A frame carries the whole
active screen as text, the grid it was formatted at, the cursor and the time
the screen last changed, so a consumer paints it without a replica, a snapshot
or a terminal engine; `vt` keeps colour and styles and `plain` drops them.
Frames go out only after the screen changes and at most once per interval.
`attach({ preview: { intervalMs, format } })` asks for a rate, which the daemon
clamps to its own bounds. A newer frame replaces one that has not been sent, so
a slow consumer sees the current screen rather than every screen it missed.
Input is never granted to a preview attachment whatever the daemon's grant
callback allows, and `resize` is refused because it holds no size; a daemon
whose engine cannot format a screen refuses `preview` with `UNSUPPORTED`.

## Requests

Requests default to a five-second deadline with at most 128 pending requests.
Timeout and cancellation errors explicitly mark remote outcomes unknown. No
operation is automatically retried. Cancellation or timeout during attach closes
the connection to release any grant whose response was lost. Other timeouts leave
the connection usable. Cancellation before sending has a known local outcome.

## Protocol

`@werk/session/protocol` exports the wire types, framing and `FramedTransport`
for daemon, bridge and transport implementers. Protocol version 2 uses a big-endian
u32 body length, a u32 JSON header length, the UTF-8 header, then u32-length-prefixed
raw byte blobs. The reserved singleton `{"$b":i}` references a blob. Decoded byte
arrays are views into the frame body and should be treated as read-only.

The receive allocation bound applies to the entire raw body, including JSON and
blob lengths: 32 MiB towards clients and 1 MiB towards the daemon. Both peers
advertise their receive cap as `hello.maxFrameBytes`; `connectSessionClient` accepts
a `maxFrameBytes` override. The daemon's `limits.maxFrameBytes` bounds outgoing
frames and `limits.maxInputFrameBytes` bounds incoming frames. Input is sent in
sequential chunks of at most 64 KiB, reduced for the peer's advertised cap.
Outgoing and browser buffers allow two maximum-sized frames, including outer
lengths. The daemon queues encoded bytes and `sendFrame` sends them without
re-encoding. Transport close must promptly release its underlying resource;
stream abort promises are not awaited behind stalled writes. Output prioritisation
and per-viewer resynchronisation belong to the server's queue scheduler.

## Scrollback

`create({ scrollbackBytes })` asks for a page-memory budget for the session's
scrollback. Omitting it takes the daemon's cap, which
`daemonInfo().capabilities.scrollbackMaxBytes` reports; asking for more is a
`LIMIT` error rather than a silent clamp, and `SessionInfo.scrollbackBytes`
carries what the session got. The unit is page memory rather than text, and the
engine retains whole pages, so a budget buys an approximate row count that
depends on the grid width; `@werk/terminal`'s `scrollback()` reports the rows a
decoded screen actually holds. A daemon that restarts may serve a lower cap
than a record was created with, in which case the record comes back with the
lower one and its oldest pages are pruned.

## Environment

`create({ env })` treats the supplied environment as a complete caller
configuration, over a minimal daemon base (`PATH`, `HOME`, `USER`, `LOGNAME`,
`SHELL`, `LANG`, plus Windows system and profile variables). Omitting `env`
inherits the daemon environment, excluding its `WERK_*`, `LINES` and `COLUMNS`.
In both modes the daemon owns `TERM=xterm-256color`, `COLORTERM=truecolor`,
`TERM_PROGRAM=werk`, `TERM_PROGRAM_VERSION`, `WERK_SESSION` and `WERK_DAEMON`.
Windows variable names merge case-insensitively. Environment values are never
stored in session metadata or checkpoints.

Environment requests are limited to 1,024 entries, 256 UTF-8 bytes per key,
128 KiB per value, and 1 MiB total including `=` and terminating NUL bytes.
Empty keys, keys containing `=` or NUL, and values containing NUL are rejected
with `LIMIT`, as are exceeded bounds; non-string values return
`INVALID_ARGUMENT`.
