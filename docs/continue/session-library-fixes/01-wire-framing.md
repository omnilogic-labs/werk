# Wire framing for `@werk/session/protocol`

Research note. Nothing here is decided; leans are marked as leans. The
prototype and a capped benchmark live in `../framing/` (`protocol-v2.ts`,
`bench-small.ts`, output `bench-small.out`). Nothing in the repository was
modified.

Provenance of the numbers: the machine rebooted mid-research and wiped `/tmp`.
The core rows (1.5 MB output stream, 100 KB / 700 KB / 2 MB snapshots, 10,000
control messages, the 8 MiB decoder test) were re-run once afterwards under the
resource caps and are what `bench-small.out` shows. The 4 MB snapshot rows, the
MessagePack and CBOR rows, and the engine snapshot-size measurements come from
the pre-reboot run; their output files were lost and re-running them would
exceed the caps (4 MB payloads, a second `bun add`, dozens of WASM terminal
instances), so they are transcribed from the record of that run and labelled.

## Summary

The current framing (4-byte length, then JSON with byte payloads spelled out as
`{"$bytes":[1,2,3,...]}`) costs 3.58x on the wire for arbitrary bytes and is
slow in both directions: 1.5 MB of output in 32 KB chunks takes 170 ms to encode
and 360 ms to decode; a 2 MB snapshot becomes a 7.5 MB frame (640 ms encode,
1,057 ms decode) and a 4 MB snapshot a 15 MB frame that cannot be sent under the
8 MiB cap at all. The decoder's per-chunk concatenation is quadratic: an 8 MiB
frame delivered in 4 KiB chunks spends 3.6 s buffering before a 1.4 s parse.

The recommendation is a small binary frame with no new dependency: a JSON header
in which every `Uint8Array` is replaced by a placeholder `{"$b":i}`, followed by
the raw blobs, each length-prefixed. The prototype measures 1.00x on the wire,
0.8 ms encode and 0.1 ms decode for the 1.5 MB output stream, 0.6 ms encode and
under 0.1 ms decode for a 2 MB snapshot (1.3 ms for 4 MB pre-reboot), and 4.6 ms
to buffer the 8 MiB frame in 4 KiB chunks (versus 3,580 ms). Control messages
stay JSON and readable, the browser needs only `DataView` and `TextDecoder`, the
bridge keeps passing chunks through untouched, and the message validation code
is unchanged.

Alongside the framing: encode each message once in the daemon and queue the
encoded frame (today an output event is encoded twice and an attach snapshot
three times); keep a frame cap but treat it as a receive-side allocation bound,
probably raised and made directional; and derive the bridge's `maxPayloadLength`
from the protocol constant instead of restating `8 MiB + 4`.

Estimated effort: 10 to 14 hours including tests, docs and a soak re-baseline.

## Current state

Paths are relative to `/home/mike/Development/omnilogic-labs/werk`.

### The framing

| Where                                    | What                                                                                                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/session/src/protocol.ts:35-53` | `encodeFrame`: `JSON.stringify` with a replacer; line 44 turns any `Uint8Array` into `{ $bytes: Array.from(original) }`; line 48 applies the cap to the JSON body                   |
| `protocol.ts:37`, `:57`, `:210`          | `maxFrameBytes` defaults to 8 MiB in three places (encoder, decoder, transport)                                                                                                     |
| `protocol.ts:59-62`                      | `FrameDecoder.push` allocates `buffer + chunk` and copies both on every call: quadratic when a large frame arrives in small chunks                                                  |
| `protocol.ts:73-96`                      | Reviver validates each `$bytes` element and rebuilds with `Uint8Array.from`                                                                                                         |
| `protocol.ts:97-197`                     | Message shape validation, independent of the byte encoding and reusable as is                                                                                                       |
| `protocol.ts:211`, `:216-226`            | `FramedTransport.send` encodes again and enforces `maxQueuedBytes` (16 MiB). A single frame larger than 16 MiB throws `LIMIT "Transport queue is full"` regardless of the frame cap |
| `packages/session/README.md:38-42`       | Documents the 4-byte length, the `$bytes` singleton and the 8 MiB / 16 MiB defaults                                                                                                 |

### Where bytes travel

| Message                                                    | Field                        | Direction        | Typical size                                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ---------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event` `output`                                           | `event.data`                 | daemon to client | one PTY read, up to 64 KB                                                                                                                                                                                                                     |
| `event` `snapshot` / `resync`                              | `event.snapshot`             | daemon to client | 51 KB at the 10 KB scrollback default; 677 KB with 10 MB scrollback after 2.1 MB written (pre-reboot engine measurement)                                                                                                                      |
| `request` `input`                                          | `params.data`                | client to daemon | keystrokes; a paste could be larger                                                                                                                                                                                                           |
| `event` `effect`, `daemon-event`, `SessionInfo.lastEffect` | `effect.payload` (`unknown`) | daemon to client | the engine emits strings, `null` and objects (`packages/terminal/src/engine.ts:133-165`); `reply` bytes are consumed inside the daemon. `session.test.ts:60-72` sends a `Uint8Array` payload, so bytes anywhere in the tree must keep working |

The daemon copies every PTY chunk into a plain `Uint8Array`
(`packages/session-daemon/src/platform/index.ts:33`), so Node `Buffer.toJSON`
(which JSON consults before the replacer) does not run on the output path.

### Consumers of the frame

| Where                                                    | Dependence                                                                                                                                                                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/session-daemon/src/index.ts:117-118`           | `controlQueueBytes` 16 MiB and `limits.maxFrameBytes` 8 MiB defaults                                                                                                                                                               |
| `index.ts:188-225` (`queue`)                             | Line 196 calls `encodeFrame` only to learn `.byteLength`, overwriting the `bytes` parameter; on `LIMIT` it drops the whole connection, which is what a resync over the cap does today                                              |
| `index.ts:245-278` (`flush`)                             | Pops `{ message, bytes }` and calls `c.wire.send(message)`, which encodes again. The lazy resync path builds `stateEvent(v, "resync")` at flush time                                                                               |
| `index.ts:279-304` (`emit`)                              | Line 303 passes `event.data?.byteLength ?? 512` as a size estimate that `queue` discards. Non-droppable events also queue a resync via `queue(..., stateEvent(...))`                                                               |
| `index.ts:787-788` (`attach`)                            | Encodes the initial snapshot purely to check it fits, then `after()` queues the same message (encode 2), and `flush` sends it (encode 3)                                                                                           |
| `index.ts:805-811` (`accept`)                            | `new FramedTransport(transport, limits.maxFrameBytes)`                                                                                                                                                                             |
| `packages/session/src/index.ts:443`                      | Client constructs `FramedTransport(options.transport)` with the default cap; no option to raise it                                                                                                                                 |
| `examples/session-web/src/bridge.ts:79`                  | `maxPayloadLength: 8 * 1024 * 1024 + 4`. Bun applies this to received messages only (its docs: it "closes a WebSocket connection if it receives a message exceeding" it), so it bounds browser-to-daemon frames                    |
| `bridge.ts:87-96`                                        | Daemon-to-browser: forwards each socket read as one `sendBinary`; a frame spans many WebSocket messages and is never subject to `maxPayloadLength`. `backpressureLimit` 16 MiB with `closeOnBackpressureLimit: true` (lines 80-81) |
| `bridge.ts:103-116`                                      | Browser-to-daemon: one WebSocket message per `writer.write`, so one per frame; 16 MiB pending cap                                                                                                                                  |
| `examples/session-web/src/websocket.ts:59-62`, `:74-77`  | Receive queue `highWaterMark` 16 MiB (errors the stream if exceeded), send `bufferedAmount` cap 16 MiB                                                                                                                             |
| `scripts/session-soak.ts:30-35`                          | Splits the first 4 bytes of every write into single bytes and the rest into 4 KiB (`offset < 4 ? 1 : 4096`): assumes a 4-byte header                                                                                               |
| `docs/session-library.md:82-84`                          | Describes that fragmentation                                                                                                                                                                                                       |
| `packages/session/test/session.test.ts:60-88`            | Byte-at-a-time decode of a nested `Uint8Array` effect payload; decoder rejects a length over its cap; `finish()` on a partial header throws                                                                                        |
| `session.test.ts:221-236`                                | A `Uint8Array` subclass with `toJSON` is encoded from the original bytes, not `toJSON`                                                                                                                                             |
| `packages/session-daemon/test/hardening.test.ts:495-509` | `maxFrameBytes: 2048` makes `attach` fail with `LIMIT` before granting                                                                                                                                                             |
| `examples/session-web/test/bridge.test.ts:4`, `:34`      | Uses `FramedTransport` as a fake daemon; independent of the byte encoding                                                                                                                                                          |
| `docs/proposals/01-cross-platform.md:955`                | Notes that `PROTOCOL_VERSION` only helps if bumped when the wire changes                                                                                                                                                           |

### What snapshots actually weigh (pre-reboot engine measurements)

Ghostty engine, 120x40, plain hex text: 51 KB snapshot at the 10 KB scrollback
default regardless of how much is written; 677 KB after 2.1 MB written with
`SCROLLBACK_MAX_BYTES` at 10 MB (9,255 rows), encoding to a 2.1 MB JSON frame in
188 ms. That is about 0.3 snapshot bytes per byte of plain text, so a full
10 MB scrollback of similar content would land near 3 MB. Styled cells, wide
grids and images are likely heavier and nobody has measured them; the 2 MB and
4 MB benchmark rows are plausible upper-middle cases, not a ceiling.

## Options considered

| Option                                                  | Wire  | Speed on blobs                              | Dependency                                                                                               | Browser                                                                                                                                  | Notes                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | ----- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Binary header + raw blobs (prototype)               | 1.00x | 0.6 ms encode for 2 MB, decode under 0.1 ms | none                                                                                                     | `DataView`, `TextEncoder`/`TextDecoder` only                                                                                             | JSON header stays readable; blobs are zero-copy views on decode; bytes anywhere in the tree keep working through the same replacer/reviver shape as today                                                                               |
| (b) base64 inside JSON                                  | 1.34x | 2.8 ms encode / 1.4 ms decode for 2 MB      | none if `Uint8Array.prototype.toBase64` is available                                                     | Bun 1.3.14 has `toBase64`/`fromBase64`; browser support is recent (Firefox 133, Safari 18.2, Chrome later) and probably needs a fallback | Smallest diff, but every limit has to be 1.34x the largest payload, the JSON string is materialised and then decoded (two copies), and the quadratic decoder still needs fixing separately                                              |
| (c) MessagePack (`@msgpack/msgpack`) or CBOR (`cbor-x`) | 1.00x | 2.0 to 2.4 ms encode for 4 MB (pre-reboot)  | one runtime dependency in a package that has none today (`packages/session` "neither imports a runtime") | `@msgpack/msgpack` is browser-clean; `cbor-x` leans on `Buffer` in Node and needs bundler care                                           | Messages are JSON-shaped with at most one or two blobs, so a general binary serialiser buys little beyond (a); the shape validation still has to run; readable headers are lost; the decode figures in the table exclude our validation |

Precedent for (a): socket.io replaces binary values with
`{ _placeholder: true, num: n }` and ships the attachments after the JSON
packet; Connect and gRPC-web put a small binary envelope before a body. The
shape is well trodden.

## Recommendation

Lean strongly towards (a). It removes the whole cost (3.58x to 1.00x, hundreds
of milliseconds to sub-millisecond), adds no dependency, changes about 80 lines
of `protocol.ts`, leaves the message validator untouched, and keeps the bridge
and WebSocket transport as opaque byte pipes.

### Frame layout (prototype `../framing/protocol-v2.ts`)

```
u32 BE  bodyLength     everything after this field; the cap applies here
u32 BE  jsonLength
bytes   JSON header    UTF-8; every Uint8Array in the message is {"$b": i}
repeat  u32 BE blobLength, blob bytes      i = 0, 1, 2 ... in placeholder order
```

- Control messages cost 4 extra bytes over today (the `jsonLength` field).
- Encoding is one `JSON.stringify` with a replacer that pushes each
  `Uint8Array` onto a list (no copy), then one allocation of the final frame and
  one `set` per blob. The `this[key]` trick that sidesteps `toJSON` stays.
- Decoding reads the blob table first, then `JSON.parse` with a reviver that
  swaps `{"$b": i}` for `body.subarray(...)`. Every index must be in range and
  used exactly once; a blob nobody references is rejected. The prototype rejects
  dangling, duplicated and unreferenced references, an over-cap length header,
  and blob lengths past the frame end (`bench-small.out`).
- Decoded blobs alias the frame's buffer: no copy, and a retained 32 KB output
  chunk keeps its ~130-byte header alive, which is fine. Receivers must not
  mutate them (the replica copies into wasm on `write`). Slicing would cost one
  memcpy if that ever becomes a concern.
- `PROTOCOL_VERSION` becomes 2. The protocol is private and both ends ship
  together, so a clean break looks acceptable.
- `$b` is a reserved singleton key exactly as `$bytes` is today. The prototype
  treats `{"$b": <non-integer>}` as malformed; passing it through unchanged is
  the friendlier alternative and is an open choice.

### Linear decoder

The prototype keeps a 4-byte header buffer and, once the length is known,
allocates the body at its final size and copies each chunk straight in. No
concatenation, one allocation per frame, and a frame split at any byte boundary
(including inside the length field) reassembles correctly. Small frames packed
many per chunk decode at today's speed (pre-reboot: 39.6 ms versus 37.9 ms for
20,000 requests in 4 KiB chunks, within noise).

### `FramedTransport`

Add `sendFrame(bytes: Uint8Array)`; `send(message)` becomes
`sendFrame(encodeFrame(message, cap))`. This is what lets the daemon encode once.

## Measurements

Bun 1.3.14, Linux x64. "Current" is the repository's `protocol.ts` imported
directly; "proposed" is `../framing/protocol-v2.ts`. Rows marked (post) are
from the capped re-run in `../framing/bench-small.out`: medians of 3 timed runs
after a warm-up. Rows marked (pre) are from the lost pre-reboot run (medians of 7) and cannot be re-run under the caps. Output-stream results were the same for
text-like and random payloads pre-reboot, so only text is shown. Snapshots are
random bytes.

| Workload                        | Encoding                     | Wire bytes | Ratio | Encode ms | Decode ms | Run  |
| ------------------------------- | ---------------------------- | ---------: | ----: | --------: | --------: | ---- |
| 1.5 MB output, 32 KB chunks     | current JSON `$bytes`        |  5,624,515 | 3.58x |     170.2 |     360.5 | post |
|                                 | base64 in JSON               |  2,104,311 | 1.34x |       2.5 |       1.5 | post |
|                                 | msgpack                      |  1,578,432 | 1.00x |       0.8 |       0.2 | pre  |
|                                 | cbor-x                       |  1,578,745 | 1.00x |       0.4 |       0.1 | pre  |
|                                 | proposed                     |  1,580,199 | 1.00x |       0.8 |       0.1 | post |
| 100 KB snapshot                 | current                      |    366,216 | 3.58x |      14.1 |      29.0 | post |
|                                 | base64                       |    136,778 | 1.34x |       0.2 |       0.1 | post |
|                                 | proposed                     |    102,647 | 1.00x |      <0.1 |      <0.1 | post |
| 700 KB snapshot                 | current                      |  2,559,101 | 3.57x |     139.6 |     270.0 | post |
|                                 | base64                       |    955,978 | 1.33x |       0.8 |       0.3 | post |
|                                 | msgpack                      |    716,994 | 1.00x |       0.5 |      <0.1 | pre  |
|                                 | proposed                     |    717,047 | 1.00x |       0.1 |      <0.1 | post |
| 2 MB snapshot                   | current                      |  7,489,659 | 3.57x |     640.2 |   1,056.9 | post |
|                                 | base64                       |  2,796,446 | 1.33x |       2.8 |       1.4 | post |
|                                 | proposed                     |  2,097,399 | 1.00x |       0.6 |      <0.1 | post |
| 4 MB snapshot                   | current (over the 8 MiB cap) | 14,973,527 | 3.57x |   1,343.7 |   2,511.2 | pre  |
|                                 | base64                       |  5,592,650 | 1.33x |       6.3 |       2.0 | pre  |
|                                 | msgpack                      |  4,194,498 | 1.00x |       2.4 |      <0.1 | pre  |
|                                 | cbor-x                       |  4,194,508 | 1.00x |       2.0 |      <0.1 | pre  |
|                                 | proposed                     |  4,194,551 | 1.00x |       1.3 |      <0.1 | pre  |
| 10,000 small requests (control) | current                      |  1,108,890 |     - |      12.7 |      18.9 | post |
|                                 | base64                       |  1,108,890 |     - |      10.2 |      12.3 | post |
|                                 | proposed                     |  1,148,890 |     - |       7.9 |      15.2 | post |

The review's earlier figures (1.5 MB to 4.5 MB, 2.1 MB to 7.1 MB, 677 KB
snapshot to 2.1 MB in 164 ms) are consistent with these: the ratio depends on
byte values (printable text costs about 3x, arbitrary bytes about 3.6x).

Decoder buffering, one 8 MiB frame delivered in 4 KiB chunks, single run after
the reboot (pre-reboot medians of 3 were 4,070 ms / 1,282 ms and 3.5 ms /
0.1 ms):

| Decoder                              | Frame bytes | Chunks | Buffering ms | Final parse ms |
| ------------------------------------ | ----------: | -----: | -----------: | -------------: |
| current (concatenate on every chunk) |   8,276,202 |  2,021 |      3,580.3 |        1,396.2 |
| proposed (allocate once, copy in)    |   8,388,599 |  2,048 |          4.6 |            0.7 |

Correctness checks in the same run: byte-at-a-time reassembly of a message with
a nested `Uint8Array` effect payload; two blobs in one message including a
`Uint8Array` subclass with `toJSON` and a Node `Buffer`; and `PROTOCOL` errors
for a dangling `$b`, an unreferenced blob, a double reference, an over-cap
length header and a blob length past the frame end.

## The frame cap

The cap still earns its place, but its meaning shifts. With the linear decoder
the receiver allocates `bodyLength` bytes as soon as it reads the header, so the
cap is exactly what bounds a peer's ability to make the receiver allocate. Today
the same peer can make the receiver buffer the same amount, so nothing gets
worse, but the cap should be understood as a receive-side allocation bound, not
a message-size policy.

What has to change, and the open choices:

- **It becomes a raw-bytes cap.** 8 MiB admits an 8 MiB snapshot instead of
  roughly 2.3 MB today. Whether that is enough depends on the scrollback fix:
  about 3 MB for 10 MB of plain text, unknown for styled content. It probably
  wants to rise; 32 MiB is a plausible default for what the client accepts from
  the daemon, and the number should come out of the scrollback work rather than
  be guessed here.
- **It probably wants to be directional.** Client-to-daemon frames are requests
  and input; a much smaller inbound cap on the daemon (1 MiB, say, with large
  pastes chunked by the client) bounds hostile or buggy local clients without
  constraining snapshots. `FramedTransport` takes one cap for both directions
  today; splitting it into a decode cap and an encode cap is a small change.
- **The daemon cannot know the client's cap.** The attach pre-check at
  `index.ts:788` assumes both sides share the default. Advertising
  `maxFrameBytes` in `hello` (client tells the daemon what it will accept)
  makes that check exact and costs one field. Chunking snapshots across frames
  so the cap can stay small is the other way out; it touches replicas and the
  event ordering contract and is left open.
- **Coupled limits must move together.** `FramedTransport.maxQueuedBytes`
  (16 MiB, `protocol.ts:211`) rejects any single frame larger than itself;
  daemon `controlQueueBytes` (16 MiB, `index.ts:117`) drops a connection whose
  queued snapshots exceed it, so two large snapshots for a slow client is fatal;
  `websocket.ts` receive `highWaterMark` and send cap (16 MiB each); bridge
  `backpressureLimit` 16 MiB with close-on-limit. Each needs to be at least the
  largest frame, and the queue ones probably a small multiple of it.
  `checkpointMaxBytes` (32 MiB) is the on-disk base64 JSON and is a separate
  limit on the same snapshot.
- **Bridge `maxPayloadLength`.** It bounds browser-to-daemon WebSocket messages,
  one per frame, so `cap + 4` is the right formula if the cap keeps meaning
  "body after the first u32". It should import the protocol constant (whatever
  the daemon's inbound cap becomes) rather than restate `8 * 1024 * 1024 + 4`.
  Daemon-to-browser traffic is unaffected by it because the bridge forwards
  socket reads, not frames.

## Removing the double encode

`queue()` should take either a `WireMessage` or an already encoded frame:

```
queue(c, item: WireMessage | Uint8Array, attachmentId?: string)
  frame = item instanceof Uint8Array ? item : encodeFrame(item, cap)   // LIMIT still drops the connection
  entry = { frame, bytes: frame.byteLength }
  ... same queue bookkeeping ...
```

`flush()` pops entries and calls `c.wire.sendFrame(entry.frame)`. The lazy
resync it builds itself (`stateEvent(v, "resync")`) is encoded there, once.
`attach` encodes `initial` once for the cap check and hands the frame to `queue`
inside `after()`: three encodes become one. `emit` drops its dead `bytes`
estimate argument (line 303).

Effects:

- The output path goes from two encodes to one; at 0.8 ms per 1.5 MB the encode
  stops mattering either way, but queued memory is now exactly the wire bytes.
- Queue accounting changes meaning: `outputQueueBytes` (256 KiB default, 32 KiB
  in the soak) counted JSON-inflated bytes and will now hold about 3.5x more raw
  output before it declares a viewer dirty. Slow viewers resync less often. The
  soak's `resyncs > 0` assertion still holds comfortably (200 KB/s against a
  32 KiB budget) but the checked-in baseline
  (`docs/session-library/linux-x64-baseline.json`) will move and should be
  regenerated.
- `hardening.test.ts:496` (`maxFrameBytes: 2048` refuses attach) keeps passing:
  a 51 KB snapshot is still over 2048.

## Implementation plan

Ordered so each step builds and tests green on its own.

| Step | Files                                                                                                            | Work                                                                                                                                                                                                                                                                                                         | Tests                                                                                                                                                                                                                                                                                                                                  | Hours |
| ---- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: |
| 1    | `packages/session/src/protocol.ts`                                                                               | Replace `encodeFrame`, add `decodeBody`, rewrite `FrameDecoder` as in the prototype, lift validation into a function, `PROTOCOL_VERSION = 2`, export a `DEFAULT_MAX_FRAME_BYTES` constant, add `FramedTransport.sendFrame`. Decide the directional cap here (two constructor arguments or an options object) | `packages/session/test/session.test.ts`: existing byte-boundary and subclass tests should pass unchanged; add two-blob message, dangling / duplicate / unreferenced reference, blob length past end, header split at every offset, decoded blob is a view, and a linearity check (8 MiB in 4 KiB chunks completes well under a second) |     3 |
| 2    | `packages/session/src/index.ts`                                                                                  | Pass the client's cap through `ConnectOptions` (and advertise it in `hello` if that lean is taken); the client never touches frames otherwise                                                                                                                                                                | Existing tests                                                                                                                                                                                                                                                                                                                         |     1 |
| 3    | `packages/session-daemon/src/index.ts`                                                                           | `queue`/`flush`/`emit`/`attach` as above; `Connection` queues hold `{ frame, bytes }`; `sendFrame`; revisit `limits.maxFrameBytes` and its relation to `controlQueueBytes`; honour a hello-advertised cap in the attach check if step 2 adds it                                                              | `packages/session-daemon/test/hardening.test.ts`: keep 496; add a test that a multi-MB snapshot attaches (fixture engine returning a large snapshot, or raised scrollback once that lands), and that `outputQueueBytes` diagnostics equal encoded frame bytes                                                                          |     3 |
| 4    | `examples/session-web/src/bridge.ts`, `src/websocket.ts`                                                         | `maxPayloadLength` from the protocol constant; review the 16 MiB receive `highWaterMark`, send cap and `backpressureLimit` against the chosen daemon-to-client cap                                                                                                                                           | `examples/session-web/test/bridge.test.ts` unchanged; `bun run test:browser`                                                                                                                                                                                                                                                           |   0.5 |
| 5    | `scripts/session-soak.ts:30-35`, `docs/session-library.md:82-84`, `docs/session-library/linux-x64-baseline.json` | Fragment the first 8 bytes byte-wise (`offset < 8 ? 1 : 4096`) so both length fields cross chunk boundaries; reword the doc; `bun run build` then regenerate the baseline (the harness imports `dist`)                                                                                                       | `bun run test:soak` with `SOAK_BASELINE`                                                                                                                                                                                                                                                                                               |   1.5 |
| 6    | `packages/session/README.md:38-42`                                                                               | Rewrite the framing paragraph for the new layout, the `$b` reservation, protocol version 2 and the new defaults                                                                                                                                                                                              | `bun run format`                                                                                                                                                                                                                                                                                                                       |   0.5 |
| 7    | whole workspace                                                                                                  | `bun run typecheck`, `bun test`, `bun run test:artefacts`, `bun run test:browser`                                                                                                                                                                                                                            |                                                                                                                                                                                                                                                                                                                                        |   0.5 |

Steps 1 to 3 are the fix; 4 to 6 keep the consumers and docs coherent.
`packages/werk` (the CLI) and `examples/session-web/src/client.ts` only use
`connectSessionClient` and do not change.

## Risks and open questions

- **Cap value and direction are unresolved** and depend on the scrollback fix.
  The suggestion is to choose them in that work, with this note's numbers
  (0.3 snapshot bytes per plain-text byte; heavier content unmeasured) as input.
- **Version mismatch is not reported cleanly.** An old daemon reading a v2 hello
  sees a malformed JSON body and drops the connection; the new client then
  reports a hello timeout or `CLOSED` rather than "incompatible". A one-byte
  magic or version in the frame header would let either side say so, at the
  cost of a byte; probably not worth it while both ends ship together, but it
  is the same stale-binary trap `docs/proposals/01-cross-platform.md:955`
  already flags.
- **Up-front allocation from a peer-declared length.** Bounded by the cap and,
  before authentication, by the 5 s hello timeout; no worse than today's
  buffering, but worth stating in the README because it is the reason the cap
  exists.
- **Reserved `$b` key.** A user object `{ "$b": ... }` anywhere in labels or
  effect payloads collides, exactly as `{ "$bytes": ... }` does today. Whether a
  non-integer `$b` should be rejected or passed through is open; the prototype
  rejects.
- **Aliased blobs.** Decoded bytes are views into the frame. Nothing in the
  client or replica mutates received bytes today; a future consumer that does
  would corrupt sibling blobs in the same frame. Documenting "treat as
  read-only" is probably enough; `slice()` is the fallback.
- **Queue accounting semantics change** (3.5x more raw output per queue byte).
  The default `outputQueueBytes` and the soak's 32 KiB might want revisiting,
  and the soak baseline must be regenerated in the same change.
- **The 16 MiB family of limits** in the transport, daemon, bridge and browser
  adapter are independent constants today. If the cap rises above 8 MiB without
  touching them, a large snapshot fails in four different places with four
  different errors.
- **Benchmark caveats.** `msgpack` and `cbor-x` decode times exclude our shape
  validation and any copy of the blob; they are included as a fairness check on
  wire size and encode cost, not as a like-for-like decode comparison. Those
  rows and the 4 MB rows are from the pre-reboot run and could not be
  regenerated within the resource caps.

## Effort

| Part                               |                                                                       Hours |
| ---------------------------------- | --------------------------------------------------------------------------: |
| Framing, decoder, transport, tests |                                                                           3 |
| Client cap plumbing                |                                                                           1 |
| Daemon encode-once, limits, tests  |                                                                           3 |
| Bridge and browser adapter limits  |                                                                         0.5 |
| Soak harness, doc, re-baseline     |                                                                         1.5 |
| README and formatting              |                                                                         0.5 |
| Full validation run                |                                                                         0.5 |
| **Total**                          | **10**, up to 14 with the hello-advertised cap and a large-snapshot fixture |
