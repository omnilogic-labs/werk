# @werk/session

Talk to a werk daemon over any duplex byte stream. You supply a `Transport`,
the package gives you a client: session listing, creation, termination, a
daemon-wide subscription, and ordered attachment event streams. It imports no
runtime, no sockets, no filesystem and no terminal engine, so the same client
runs under Bun, in a browser over a WebSocket, or over a socket forwarded
through ssh.

This is a private workspace package. Depend on it as `"@werk/session":
"workspace:*"` and import from `@werk/session` or `@werk/session/protocol`.
Build it with `bun run build`.

## Connecting, listing and attaching

This runs under Bun against a daemon's `endpoint.json`, given as the first
argument.

```ts
import net from "node:net";
import { connectSessionClient, type Transport } from "@werk/session";

// A transport is a duplex byte stream with a close. Nothing else.
function socketTransport(socket: net.Socket): Transport {
  return {
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        // Every path here can fire after the reader has already finished, so
        // each one is guarded.
        const settle = (fn: () => void) => {
          try {
            fn();
          } catch {}
        };
        socket.on("data", (d) =>
          settle(() => controller.enqueue(new Uint8Array(d))),
        );
        socket.on("close", () => settle(() => controller.close()));
        socket.on("error", (e) => settle(() => controller.error(e)));
      },
      cancel() {
        socket.destroy();
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise((resolve, reject) =>
          socket.write(chunk, (e) => (e ? reject(e) : resolve())),
        );
      },
      close() {
        socket.end();
      },
      abort() {
        socket.destroy();
      },
    }),
    close() {
      socket.destroy();
    },
  };
}

const endpoint = JSON.parse(await Bun.file(process.argv[2]!).text());
const client = await connectSessionClient({
  transport: socketTransport(net.createConnection({ path: endpoint.path })),
});

// Subscribe before listing, or events that fire during the list call are lost.
const stop = client.watch((event) => console.log("event", event.type));
await stop.ready;

const sessions = await client.list({});
const attachment = await client.attach(sessions[0]!.id, {
  permissions: { read: true, input: false },
  onEvent: (event) => console.log("attachment", event.type),
});

// What you asked for is not what you got. Read the response.
console.log("granted", attachment.permissions, "size", attachment.holdsSize);

await attachment.detach();
stop();
await client.close();
```

## What this package exports

| Export                                                                                                                                                 | Entry                    | What it is                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------- |
| `connectSessionClient(options)`                                                                                                                        | `@werk/session`          | Handshake over a `Transport`, resolve to a `SessionClient`    |
| `SessionClient`                                                                                                                                        | `@werk/session`          | Requests, `watch`, `attach`, `close` and a `closed` promise   |
| `Attachment`                                                                                                                                           | `@werk/session`          | One attachment: `writeInput`, `resize`, `claimSize`, `detach` |
| `SessionError`                                                                                                                                         | `@werk/session`          | Carries `code` and `outcomeUnknown`                           |
| `Transport`                                                                                                                                            | `@werk/session`          | `{ readable, writable, close }`, what you supply              |
| `SessionInfo`, `AttachmentInfo`, `DaemonInfo`, `DaemonEvent`, `AttachmentEvent`, `Permissions`, `Principal`, `HoldSize`, `Representation`, `ErrorCode` | `@werk/session`          | The wire types, in `src/types.ts`                             |
| `FramedTransport`                                                                                                                                      | `@werk/session/protocol` | Frames a `Transport` both ways; what a daemon or bridge needs |
| `encodeFrame`, `decodeBody`, `FrameDecoder`                                                                                                            | `@werk/session/protocol` | The framing itself                                            |
| `PROTOCOL_VERSION`                                                                                                                                     | `@werk/session/protocol` | `2`                                                           |
| `CLIENT_MAX_FRAME_BYTES`, `DAEMON_MAX_FRAME_BYTES`                                                                                                     | `@werk/session/protocol` | 32 MiB and 1 MiB                                              |

`@werk/session/protocol` re-exports everything in `@werk/session`. It exists
for daemon, bridge and transport implementers, who need the framing as well as
the client.

## Principals and grants

The daemon assigns the **principal**, which is who a connection is acting as,
and decides what each attachment may do. Grants a client requests are never
authority: read `attachment.permissions` and `attachment.holdsSize` on the
attach response to find out what was actually granted.

`connectSessionClient` negotiates protocol version 2. A difference in engine
build does not refuse a connection.

## Sessions and watching

`create`, `list`, `get`, `readScreen`, `readHistory`, `terminate`, `remove`,
`daemonInfo` and `endAttachment` all work without an attachment.

`watch(callback)` returns a stop function that is idempotent and that also
carries a `ready` promise. Await `watch().ready` before calling `list()`, or
events that fire during the list call are lost. Reconcile events that arrive
during the request against the list you get back. Errors thrown by a watch or
attachment callback are isolated, and reported through `onCallbackError` if one
was supplied.

Watch events carry the session's current metadata, including principals, grants
and size ownership.

- `attachments-updated`, `resized` and `checkpoint` report changes without any
  terminal attachment.
- `checkpoint` arrives only when a saved screen is written. It says a record
  changed, not that the daemon is alive.
- `removed` deletes the row and carries its final metadata. It arrives both for
  an explicit `remove` and for a record the daemon evicted to stay inside its
  retention limit.
- `activity` and `effect` are coalesced by the daemon per session and per kind,
  so a busy session reports a rate rather than every occurrence. The daemon
  drains what it holds before a state change, so nothing follows `exited`. An
  attachment still receives every effect on its own stream.

Per-session list authorisation also gates events. A consumer keeping a filtered
view should apply its `list` label and state filters to incoming metadata too.

## Attachments

An **effect** is a side-channel event from the terminal, such as a bell or an
OSC notification.

- Every attachment has its own identity and its own generation.
- Its first event carries authoritative state: a `snapshot`, or a `preview`
  frame for a preview attachment.
- Positions after that increase by one. A `resync` may advance across a gap.
- A stale generation or a duplicate position is ignored.
- A gap without a resync closes the connection.
- Every event, `ended` included, names the attachment it is for.
- A `size-holder` event updates that attachment's size authority.
- Closing a client ends its attachments and never asks for the session to be
  terminated.
- `inputChunkBytes(attachmentId)` reports the largest input chunk the peer's
  advertised frame cap allows, which is what `writeInput` splits against.

Attaching to a session with no live process succeeds. It delivers the saved
screen, then the recorded outcome as an `exit` where the daemon has one, then
`ended` with reason `session-ended`. Such an attachment holds no size, never
appears among the session's attachments, and refuses input and resize. A `lost`
record ends without an `exit`, because its outcome is unknown; read its state
from `get` or from the watch stream.

## Size ownership

At most one attachment on a session holds the size. The size may also be
**free**, meaning no attachment holds it at all, in which case `resize` is
refused until something claims it.

`attach` takes `holdSize`:

- `never` never takes the size and is never chosen as a successor.
- `if-free` takes it when nobody holds it.
- `claim` also takes it from the current holder, where the daemon allows the
  takeover.

The default is `if-free` when input is granted and `never` otherwise, so a
watcher leaves the size with whoever is typing. A refused claim attaches
without the size rather than failing, and the attach response says what
happened.

`claimSize()` makes the same request after attaching. It needs input, and it
needs the daemon's permission whenever someone else holds the size.
`transferSize(target)` hands the size from the holder to any attachment that
did not ask for `never`.

When a holder leaves, the size passes to an input-capable attachment, then to
one that asked to claim, then to the most recent. `AttachmentInfo` carries
`representation` and `holdSize` beside `holdsSize`, so a listing can tell a
watcher from a terminal and show who could take the size.

## Preview attachments

A **preview tile** is a small read-only text picture of a screen, refreshed on
a timer. A `preview` attachment delivers one. It is read-only, holds no size,
and receives `preview`, `exit` and `ended` and nothing else. Its first event is
a `preview` frame in place of a snapshot.

A frame carries the whole active screen as text, the grid it was formatted at,
the cursor, and the time the screen last changed. A consumer paints it without a
replica, a snapshot or a terminal engine. Format `vt` keeps colour and styles;
`plain` drops them.

Frames go out only after the screen changes, and at most once per interval.
`attach({ preview: { intervalMs, format } })` asks for a rate, which the daemon
clamps to its own bounds. A newer frame replaces one that has not been sent, so
a slow consumer sees the current screen rather than every screen it missed.

Input is never granted to a preview attachment, whatever the daemon's grant
callback allows, and `resize` is refused because it holds no size. A daemon
whose engine cannot format a screen refuses `preview` with `UNSUPPORTED`.

## Requests

Requests default to a five-second deadline, with at most 128 pending at once.
Timeout and cancellation errors explicitly mark the remote outcome unknown. No
operation is ever retried automatically.

Cancellation or timeout during `attach` closes the connection, to release any
grant whose response was lost. Other timeouts leave the connection usable.
Cancellation before the request was sent has a known local outcome.

## The wire protocol

**Frame layout.** Protocol version 2 is binary: a big-endian u32 body length, a
u32 JSON header length, the UTF-8 header, then u32-length-prefixed raw byte
blobs. The reserved singleton `{"$b":i}` in the header references blob `i`.
Decoded byte arrays are views into the frame body and should be treated as
read-only.

**Size bounds.** The receive allocation bound applies to the entire raw body,
JSON and blob lengths included: 32 MiB towards clients and 1 MiB towards the
daemon. Both peers advertise their receive cap as `hello.maxFrameBytes`, and
`connectSessionClient` accepts a `maxFrameBytes` override. The daemon's
`limits.maxFrameBytes` bounds outgoing frames and `limits.maxInputFrameBytes`
bounds incoming ones. Input is sent in sequential chunks of at most 64 KiB,
reduced for the peer's advertised cap. Outgoing and browser buffers allow two
maximum-sized frames, outer lengths included.

**Transport obligations.** `close` must promptly release the underlying
resource; stream abort promises are not awaited behind stalled writes. The
daemon queues encoded bytes and `sendFrame` sends them without re-encoding.
Output prioritisation and per-attachment resynchronisation belong to the
server's queue scheduler, not to the transport.

## Scrollback

`create({ scrollbackBytes })` asks for a page-memory budget for the session's
scrollback. Omitting it takes the daemon's cap, which
`daemonInfo().capabilities.scrollbackMaxBytes` reports. Asking for more is a
`LIMIT` error rather than a silent clamp, and `SessionInfo.scrollbackBytes`
carries what the session got.

The unit is page memory rather than text, and the engine retains whole pages, so
a budget buys an approximate row count that depends on the grid width.
`@werk/terminal`'s `scrollback()` reports the rows a decoded screen actually
holds. A daemon that restarts may serve a lower cap than a record was created
with, in which case the record comes back with the lower one and its oldest
pages are pruned.

## Environment

`create({ env })` treats the supplied environment as a complete caller
configuration, applied over a minimal daemon base of `PATH`, `HOME`, `USER`,
`LOGNAME`, `SHELL`, `LANG`, plus Windows system and profile variables. Omitting
`env` inherits the daemon's environment instead, minus its `WERK_*`, `LINES` and
`COLUMNS`.

In both modes the daemon owns `TERM=xterm-256color`, `COLORTERM=truecolor`,
`TERM_PROGRAM=werk`, `TERM_PROGRAM_VERSION`, `WERK_SESSION` and `WERK_DAEMON`.
Windows variable names merge case-insensitively. Environment values are never
stored in session metadata or checkpoints.

Environment requests are bounded at 1,024 entries, 256 UTF-8 bytes per key,
128 KiB per value, and 1 MiB in total including `=` and terminating NUL bytes.
Exceeding any of those bounds is a `LIMIT` error, as are an empty key, a key
containing `=` or NUL, and a value containing NUL. A non-string value is
`INVALID_ARGUMENT`.
