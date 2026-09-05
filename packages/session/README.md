# @werk/session

Private portable session client and protocol. Build with `bun run build`. Both
public entries expose built JavaScript and declarations; neither imports a
runtime, sockets, filesystem or terminal engine.

Supply a `Transport` with readable/writable byte streams and an idempotent close
operation. `connectSessionClient` negotiates protocol version 1. Engine build
differences do not refuse a connection. The daemon assigns the principal and
grants permissions; requested grants are never treated as authority by the client.

`create`, `list`, `get`, `readScreen`, `readHistory`, `terminate`, `remove`,
`daemonInfo` and `endAttachment` work without attachment. `watch(callback)` returns
an idempotent stop function with a `ready` promise for subscription acceptance.
Watch and attachment callback errors are isolated and optionally reported via
`onCallbackError`.

Attachments have unique identities and generations. Their first event is a
snapshot; subsequent positions increase by one. A resync may advance across a
gap. A stale generation or duplicate position is ignored; a gap without resync
closes the connection. Every event, including the final `ended`, identifies its
recipient attachment. Size-holder events update that recipient's authority.
Closing a client ends its attachments and never requests session termination.

Requests default to a five-second deadline with at most 128 pending requests.
Timeout and cancellation errors explicitly mark remote outcomes unknown. No
operation is automatically retried. Cancellation or timeout during attach closes
the connection to release any grant whose response was lost. Other timeouts leave
the connection usable. Cancellation before sending has a known local outcome.

`@werk/session/protocol` exports the wire types, framing and `FramedTransport`
for daemon, bridge and transport implementers. Framing uses a four-byte big-endian
JSON byte length; byte arrays use the reserved singleton `{"$bytes":[...]}`
encoding. Individual encoded bodies are limited to 8 MiB and outgoing queues to
16 MiB by default. Transport close must promptly release its underlying resource;
stream abort promises are not awaited behind stalled writes. Output prioritisation
and per-viewer resynchronisation belong to the server's queue scheduler.
