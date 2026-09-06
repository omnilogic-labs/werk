# 02: Stream scheduler, activity coalescing, dirty checkpoints, session limits

Research against `packages/session-daemon/src/index.ts` at commit `f87d9c0`.
Nothing in the repository was modified. Prototype and scratch scripts live in
`../proto/` (`scheduler.ts` is the prototype daemon, `baseline.ts` the unmodified
daemon with absolute imports, `scheduler.diff` the difference, `smoke3.ts` the
smoke that produced the "after" numbers, `rebuild.py` regenerates the prototype
from the repository file).

## Summary

The four measured problems are confirmed and all four come from the same shape
of code: the daemon treats "never drop a control event" and "keep the client's
ordering contract" as one problem and solves it by sending a full snapshot
before every control event, and it treats "keep the record safe" and "tell
watchers something happened" as one problem and solves both on a timer and on
every PTY chunk.

The fix that the prototype demonstrates:

1. **One ordered stream per attachment.** Output and control events sit in one
   queue in emission order. Only output is droppable; when a connection's output
   budget is exceeded the stream with the largest backlog loses all of its
   queued output and is marked dirty, and a resync is generated lazily when that
   stream is next sent. Control events never cost a snapshot. The client contract
   (`Attachment.deliver`, the replica gap rule) is untouched.
2. **Coalesced watch notifications.** `activity` and `effect` are throttled per
   session: the first is immediate, then at most one `activity` and one `effect`
   per kind per 250 ms, drained before any state change so an effect never
   arrives after `exited`.
3. **Dirty-driven checkpoints.** A record is checkpointed only after output,
   resize, effect or state change; exited and lost records stop costing a file
   write and a watch event every five seconds.
4. **Live-only session limit** plus a separate retained-record cap with
   oldest-first eviction (the eviction policy is a lean, not a decision).

Measured on the 200-prompt case (each line sets a title and a cwd via OSC): one
viewer went from 402 resyncs, 1.08 MB of snapshot payload and 3.59 MB on the
wire to 0 resyncs, 1.2 KB of snapshot payload and 114 KB on the wire; the watch
connection went from 408 frames (481 KB) to 11 frames (11 KB); the run took
317 ms instead of 3,409 ms. Three exited sessions produced 7 checkpoint events
in 11 s before and none after. The fourth `create` with three exited records
under `sessions: 3` succeeds after.

The wire framing research recommends a binary frame encoded once in the daemon
and queued as bytes. The scheduler below is designed for that: entries hold
pre-encoded frames, the byte budget is exact, and the one thing that cannot be
pre-encoded (the lazy resync) reserves its stream position when the stream goes
dirty and is encoded when it is sent.

Estimated effort: 15 to 21 hours, best landed after the framing change.

## Current state (file:line)

All lines refer to `packages/session-daemon/src/index.ts` unless stated.

| Lines   | What it does today                                                                                                                                                                                                                                                                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 80-91   | `Connection` keeps `control` (never dropped) and `output: Map<attachmentId, entries>` (droppable) plus a `dirty: Set<attachmentId>`.                                                                                                                                                                                                                                              |
| 188-226 | `queue()`: encodes every message with `encodeFrame` just to measure it (a second encode happens in `wire.send`), then either appends to the attachment's output queue, or, if `c.bytes + bytes > outputQueueBytes`, discards that attachment's whole queue and marks it dirty; control overflow (`controlQueueMessages` 1024 or `controlQueueBytes` 16 MiB) drops the connection. |
| 227-244 | `stateEvent()`: full engine snapshot with `position: ++v.position` assigned at build time.                                                                                                                                                                                                                                                                                        |
| 245-278 | `flush()`: control first, then one resync per dirty attachment, then one entry from the first attachment in Map insertion order. A stateEvent failure inside the loop drops the connection.                                                                                                                                                                                       |
| 279-305 | `emit()`: **for every non-droppable event other than `ended`** it discards the viewer's queued output, clears dirty, and queues a fresh `resync` into the control queue, then the event. This is the source of problem 1. `broadcast()` (306-309) defaults to droppable; line 601 passes `false` for effects, 680 for resize.                                                     |
| 310-331 | `notify()`: one `publicInfo(r)` (structuredClone of the record with all attachments) per watching connection per event.                                                                                                                                                                                                                                                           |
| 332-359 | `end()`: discards queued output, and on `session-ended` sends `resync` then `exit` then `ended`; hands the size to the first remaining viewer with a `size-holder` event (which itself costs a resync through `emit`).                                                                                                                                                            |
| 375-432 | `checkpoint()`: serial chain; re-snapshots, base64s, rewrites the file and emits a `checkpoint` watch event for every record it is given. No dirty tracking.                                                                                                                                                                                                                      |
| 433-483 | Restore: `if (records.size >= limits.sessions) continue` (436) counts retained files against the live limit.                                                                                                                                                                                                                                                                      |
| 515-518 | Create: `records.size + pendingCreates >= limits.sessions` counts exited, failed and lost records.                                                                                                                                                                                                                                                                                |
| 584-624 | PTY callback: broadcast output (droppable), each effect as non-droppable (a resync each) plus `notify("effect")`, then `notify("activity")` on every chunk (604).                                                                                                                                                                                                                 |
| 636-646 | Exit handler: ends viewers, `notify("exited")`, `checkpoint(r)`.                                                                                                                                                                                                                                                                                                                  |
| 672-681 | Resize: non-droppable broadcast; the comment explains why a resync is genuinely needed here (a replica's own reflow can disagree with the engine).                                                                                                                                                                                                                                |
| 754-802 | Attach: builds and validates the initial snapshot, registers the viewer, and queues the snapshot as a control message in `after()` so the response precedes it.                                                                                                                                                                                                                   |
| 875-878 | `setInterval`: checkpoints every record every `checkpointIntervalMs` (5 s).                                                                                                                                                                                                                                                                                                       |
| 880-911 | `close()`: checkpoints every record after terminating processes.                                                                                                                                                                                                                                                                                                                  |

Client and replica contract that the design must keep:

- `packages/session/src/index.ts:100-135` `Attachment.deliver`: first event
  must be `snapshot`, `resync` or `ended`; a stale generation or a position not
  greater than the last is ignored; any other event whose position is not
  `last + 1` throws `PROTOCOL` unless it is `resync`, `snapshot` or `ended`.
- `packages/terminal/src/replica.ts:36-78`: the same gap rule; every
  establishing event restores a new WASM terminal.
- `packages/session/README.md:25-30, 44`: "subsequent positions increase by
  one. A resync may advance across a gap"; "Output prioritisation and
  per-viewer resynchronisation belong to the server's queue scheduler."
- `packages/session-daemon/README.md:21-23`: "Slow viewers receive replacement
  snapshots; control queue exhaustion disconnects the connection."

Tests that encode the current behaviour:

- `packages/session-daemon/test/hardening.test.ts:127-205` blocked viewer
  recovers through real snapshots, counts `resyncs > 0`, checks the replica
  after a resize (`cols === 93`).
- `hardening.test.ts:207-257` effects ordered, `title` effect reaches both the
  attachment and the watch stream, `reply` effects never leave the daemon.
- `hardening.test.ts:463-493` control queue overflow closes only the stalled
  connection.
- `hardening.test.ts:511-617` fleet watch: the row handler treats an event
  without `session` as "row not visible" (`event.session?.labels.team !== "alpha"`
  deletes the row), which matters for any lighter watch payload.
- `packages/session-daemon/test/daemon.test.ts:105-158` watch, size transfer,
  retained recovery.
- `scripts/session-soak.ts:189` asserts `resyncs > 0` for the 200 ms-delayed
  viewer; `docs/session-library.md:98-113` records the baseline.

Confirmation of the analysis: the baseline smoke (`../proto/smoke3.ts` shape,
run pre-crash with the same parameters) reproduced 402 resyncs and 400 effects
for 200 prompt lines, 59 activity events for a 1.29 MB flood, 7 checkpoint
events in 11 s for three exited sessions, and `LIMIT` on the fourth create with
`sessions: 3` and three exited records. One correction to the brief: the
resize path's resync is not only an ordering trick; the comment at 677-679 is
right that a replica resizing on its own can disagree with the engine, so a
resize still has to be followed by authoritative state. The design keeps that
one resync and removes the others.

## Design

### Scheduler

Data shape per connection (replacing lines 80-91):

```ts
type Entry = {
  frame?: Uint8Array; // pre-encoded wire frame; absent only for the lazy resync
  resync?: true; // placeholder: encode stateEvent(v, "resync") when sent
  position: number; // reserved at enqueue time, see below
  bytes: number; // frame.byteLength, exact once frames are pre-encoded
  droppable: boolean; // output (and the initial snapshot): superseded by a resync
  last?: boolean; // the ended event; delete the stream after sending
};
type Stream = {
  viewer: Viewer;
  entries: Entry[];
  droppableBytes: number;
  dirty: boolean; // a resync placeholder is queued
  held: boolean; // attach response not yet queued ahead of it
};
type Connection = {
  wire: FramedTransport;
  principal: Principal;
  watch: boolean;
  closed: boolean;
  control: { frame: Uint8Array; bytes: number }[]; // hello, responses, daemon-events
  controlBytes: number;
  streams: Map<string, Stream>;
  cursor: number; // round-robin index
  bytes: number; // droppable bytes across streams
  writing: boolean;
};
```

Rules:

- **One ordered stream per attachment.** Output, effect, resize, exit,
  size-holder and ended all go into `stream.entries` in emission order.
- **Only output is droppable.** When `c.bytes + bytes > outputQueueBytes`, pick
  the stream with the largest `droppableBytes` (ties go to the arriving stream),
  discard all of its droppable entries and mark it dirty; repeat until the new
  entry fits or the arriving stream itself is dirty, in which case the new
  entry is not queued either. Not "oldest" or "newest": the whole backlog goes,
  because any gap needs a resync and a resync makes everything before it
  redundant, and while dirty every further chunk is covered by the snapshot
  that will be taken when the resync is sent. Picking the largest backlog
  rather than the arriving stream means a slow attachment pays for its own
  slowness instead of a quiet neighbour on the same connection.
- **Dirty means one resync placeholder.** `invalidate()` reserves a position
  (`++v.position`) for the resync at the moment the stream goes dirty and
  appends a placeholder entry; later control events get later positions, so
  the resync sent from the placeholder never reorders them. Output emitted
  while dirty is dropped and consumes no position. The snapshot itself is taken
  and encoded only when the placeholder reaches the head of the stream, so a
  blocked viewer costs one snapshot per send opportunity, not one per
  overflow. A second invalidation while dirty changes nothing.
- **Resize invalidates.** A resize marks the stream dirty (discarding queued
  output) and then queues the resize event, so the viewer receives fresh
  post-resize state and then the resize, which its replica applies as a
  no-op. Effects, exit and size-holder do not invalidate.
- **Positions.** Reserved at enqueue time for everything, including the resync
  placeholder. Dropped output leaves gaps; the following resync "advances
  across a gap" exactly as the README already says. Control events are never
  dropped so, between resyncs, positions are consecutive. No client change.
- **`ended` is always delivered.** It is a control entry; the stream is
  deleted only after it is sent. If the resync placeholder cannot be encoded
  (no engine and no checkpoint, which only happens after an engine fault), the
  stream's remaining entries are discarded and the viewer is ended with
  `session-ended`; the client accepts `ended` across any gap. Today the same
  failure drops the whole connection (line 258 inside the `try`).
- **Initial snapshot.** Encoded once in `attach` for the cap check, queued as
  the first entry of a `held` stream before the request returns (so output
  that arrives during the response round trip lands behind it), and released
  in `after()` once the response has been queued. The snapshot entry is
  droppable with `bytes: 0`: if output overflows before it is sent, it is
  replaced by the resync.
- **Fairness.** `flush()` drains the control queue first, then takes one entry
  from the next ready stream in round-robin order (`c.cursor`), then loops.
  Control first keeps responses and watch events ahead of a large output
  backlog; with coalescing the watch traffic is bounded (below), so control
  cannot starve streams indefinitely. Round robin replaces today's
  first-in-Map behaviour, under which a continuously busy attachment starves
  the others on the same connection.
- **Control queue overflow** stays a disconnect: a client that cannot drain
  responses has no coherent state left to recover. Two adjustments make it
  rare: coalescing (below) bounds watch traffic to about `sessions × (1 +
effect kinds)` frames per interval, and `controlQueueMessages` (1024) is
  too low for that bound at 128 sessions when a watcher stalls for a second;
  it probably wants to be 8192 or dropped in favour of the byte limit. A
  further optional step is in-queue replacement: keep a per-connection map
  from session id to the unsent `activity`/`effect` entry and overwrite its
  frame in place, so a stalled watcher holds at most one pending notification
  per session per kind.

Sketch against the real functions (the prototype `../proto/scheduler.ts:212-405`
is the working version with JSON-era events; this sketch is the pre-encoded
form):

```ts
function queue(c: Connection, item: WireMessage | Uint8Array) {   // control only
  if (c.closed) return;
  let frame: Uint8Array;
  try { frame = item instanceof Uint8Array ? item : encodeFrame(item, limits.maxFrameBytes); }
  catch { dropConnection(c); return; }
  if (c.control.length >= limits.controlQueueMessages ||
      c.controlBytes + frame.byteLength > limits.controlQueueBytes) { dropConnection(c); return; }
  c.control.push({ frame, bytes: frame.byteLength });
  c.controlBytes += frame.byteLength;
  void flush(c);
}

function invalidate(c: Connection, s: Stream) {
  if (s.droppableBytes) {
    s.entries = s.entries.filter((e) => !e.droppable);
    c.bytes -= s.droppableBytes;
    s.droppableBytes = 0;
  }
  if (!s.dirty) {
    s.dirty = true;
    s.entries.push({ resync: true, position: ++s.viewer.position, bytes: 0, droppable: false });
  }
}

function emit(v: Viewer, event: any) {
  const c = v.connection;
  if (c.closed) return;
  const s = c.streams.get(v.info.id) ?? newStream(c, v);
  if (s.ended) return;
  if (event.type === "resize") invalidate(c, s);           // fresh state precedes the resize
  if (event.type === "output") {
    if (s.dirty) return;                                     // covered by the pending resync
    const frame = encodeEvent(v, event, ++v.position);       // encoded once, here
    while (c.bytes + frame.byteLength > limits.outputQueueBytes && !s.dirty) {
      let victim = s;
      for (const other of c.streams.values())
        if (other.droppableBytes > victim.droppableBytes) victim = other;
      invalidate(c, victim);
    }
    if (s.dirty) return;
    push(s, { frame, position, bytes: frame.byteLength, droppable: true });
    c.bytes += frame.byteLength;
  } else {
    const position = ++v.position;
    push(s, { frame: encodeEvent(v, event, position), position, bytes: 0, droppable: false,
              last: event.type === "ended" });
    if (event.type === "ended") s.ended = true;
  }
  void flush(c);
}

async function flush(c: Connection) {
  if (c.writing || c.closed) return;
  c.writing = true;
  try {
    while (!c.closed) {
      let frame: Uint8Array | undefined;
      const control = c.control.shift();
      if (control) { c.controlBytes -= control.bytes; frame = control.frame; }
      else {
        const s = nextStream(c);                             // round robin, skips held
        if (!s) break;
        const entry = s.entries.shift()!;
        if (entry.resync) {
          s.dirty = false;
          try { frame = encodeEvent(s.viewer, stateEvent(s.viewer, "resync"), entry.position); }
          catch { failStream(c, s); continue; }              // discard, then ended
        } else {
          if (entry.droppable) { s.droppableBytes -= entry.bytes; c.bytes -= entry.bytes; }
          frame = entry.frame;
          if (entry.last) c.streams.delete(s.viewer.info.id);
        }
      }
      await c.wire.sendFrame(frame);
    }
  } catch { dropConnection(c); } finally { c.writing = false; }
}

function end(v: Viewer, reason: EndReason) {                 // no resync here any more
  viewers.delete(v.info.id);
  v.record.info.attachments = v.record.info.attachments.filter((a) => a.id !== v.info.id);
  if (reason === "session-ended" && v.record.info.exit) emit(v, { type: "exit", exit: v.record.info.exit });
  emit(v, { type: "ended", reason });
  ...size handover and notify("detached") unchanged...
}
```

`broadcast()` loses its `droppable` parameter; the PTY callback, resize and
`transferSize` call `emit`/`broadcast` without it. `dropConnection()` clears
`streams` and `bytes`. `diagnostics().outputQueueBytes` keeps reporting
`c.bytes`.

Interaction with the wire framing change: `encodeEvent` is `encodeFrame` of
the event message with the binary layout, called once; `flush` sends bytes via
`sendFrame`. With the JSON framing the prototype had to estimate output cost
(`data.byteLength * 4 + 96`) because encoding every chunk twice was the very
cost being removed; with pre-encoded frames the budget is exact and, as the
framing research notes, `outputQueueBytes` then holds about 3.5x more raw
output than today for the same number, so slow viewers resync less often and
the soak baseline moves.

Interaction with the attachment semantics research (`06`): a per-attachment
"latest preview" slot is one more entry kind on `Stream` (replace in place if
unsent); late attach to a dead record can simply `emit` snapshot, exit and
ended through the same stream because control events no longer cost a
snapshot; `claimSize`'s `size-holder` events become free.

### Activity coalescing

- Per record: `pulse?: { timer?, activity: boolean, effects: Map<kind, Effect> }`.
- `pulse(r)` on every PTY chunk and on input; `pulse(r, effect)` per effect.
  If no timer is armed the pending set is drained immediately (leading edge),
  otherwise it accumulates. The timer drains again after `notifyIntervalMs`
  and re-arms only if something was pending, so an idle session stops
  costing anything.
- A drain sends one `effect` per pending kind (latest payload wins) and then
  one `activity`, each carrying the current `session`. `drainPulse(r)` is also
  called before `notify("exited")` and before `notify("state")` in the engine
  fault path, so notifications never trail a state change (the first prototype
  run showed a title effect arriving after `exited`; the re-run shows
  `effect effect activity exited`).
- `notify()` computes `publicInfo(r)` once per event, not once per watcher.
- Suggested `notifyIntervalMs`: 250. The web example already debounces its
  refresh at 50 ms, so a 4 Hz ceiling per session is not visible; at 128 busy
  sessions that is about 512 frames/s per watcher, roughly 0.5 to 1 MB/s with
  full records, which is the bound the control queue then has to hold. 100 ms
  would be visibly livelier and 2.5x the traffic; anything in 100 to 500 looks
  defensible. It is a limit, so a consumer can tune it.
- Lighter payload: `DaemonEvent.session` is already optional in the type, but
  the fleet test's row handler (`hardening.test.ts:538`) treats a missing
  `session` as "not visible" and deletes the row, and the README promises the
  current metadata on every event. Dropping `session` from `effect` or
  `activity` would therefore be a contract change for consumers. With
  coalescing the full record costs a bounded amount, so the lean is to keep
  the full record now and revisit a delta form (`changed: string[]` plus
  optional `session`) if a fleet of hundreds of busy sessions turns out to be
  real. `effect` coalescing per kind does lose bell counts within a window;
  whether a fleet view cares is an open question.

### Checkpoints

- `RecordState.dirty` is set by output (in the PTY callback, which also covers
  title/cwd/lastEffect), resize, create, exit and engine fault. Restored records
  start clean.
- `checkpoint()` clears `dirty` before it snapshots, so output that arrives
  during the write dirties the record again for the next tick.
- The interval becomes `for r of records: if (r.dirty) checkpoint(r)`. The exit
  path keeps its immediate `checkpoint(r)`, so the final screen is saved at
  once and never again. Lost and preserved-checkpoint records are never dirty
  and are never rewritten; their files stay byte-for-byte as recovered.
- `close()` terminates processes, awaits exits (which set dirty and checkpoint),
  then checkpoints any still-dirty record. A record that has not changed since
  its last write is not rewritten on shutdown; the file is already current.
- The `checkpoint` watch event fires only when a file was written. There is no
  periodic heartbeat any more. Nothing in the repository relied on it: the
  README describes `checkpoint` as reporting changes, and the tests wait on
  states, not on checkpoint ticks. If a consumer ever wants "is the daemon
  alive" it should not be inferred from checkpoint churn.
- `info.checkpoint.time` now means "last write of a changed record". Unchanged.

### Limits

- `limits.sessions` counts live records only (`r.child` present) plus pending
  creates. Retained records no longer block `create`.
- A new `limits.retainedSessions` (prototype default 512) bounds exited, failed
  and lost records. Restore honours it by skipping the excess files (they stay
  on disk, untouched). At exit, `evictRetained()` removes the oldest retained
  records beyond the cap through the same path as `remove` (file deleted,
  terminal disposed, `removed` notified), so fleet views drop the row.
- This is a lean. Evicting deletes a saved screen without anyone asking, which
  sits uneasily with `docs/session-library.md`'s advice to copy checkpoint
  files before removing a record. The alternatives are to refuse `create`
  with a clearer `LIMIT` message when retained records are over the cap (which
  reproduces today's failure mode, later), or to leave retention unbounded and
  rely on consumers. The choice needs an owner; the doc should record it as
  an open question until then.
- Where consumers need GC either way: `werk remove` exists in the CLI; the
  browser example has no remove path; the soak already removes. Eviction is
  the backstop, not a substitute for those.
- Memory note found on the way: every restored record with a decodable
  checkpoint instantiates a WASM terminal at startup (line 465). With hundreds
  of retained records that is hundreds of instances before anyone looks at
  them. Lazy restore on first read or attach is probably wanted, but it is
  outside this fix.

## Prototype results

Environment: Bun, Linux x64, real engine, in-process daemon with in-memory
duplex transports, `outputQueueBytes: 64 KiB`, one viewer connection with a
replica applying every event, one watcher connection. "Before" is the
unmodified daemon (pre-crash run); "after v1" is the prototype before the
pulse-ordering fix (pre-crash run); "after v2" is the rebuilt prototype with the
fix (post-crash run, `../proto/proto3.out`). The replica matched
`readScreen()` at the end of every case with no gap errors.

| Case                                    | Metric                            | Before                                             | After v1                                           | After v2                |
| --------------------------------------- | --------------------------------- | -------------------------------------------------- | -------------------------------------------------- | ----------------------- |
| 200 prompt lines, OSC title + cwd each  | viewer resyncs / effects / output | 402 / 400 / 2                                      | 0 / 400 / 2                                        | 0 / 400 / 2             |
|                                         | snapshot payload / wire bytes     | 1,077,586 / 3,592,593                              | 1,210 / 113,781                                    | 1,210 / 113,781         |
|                                         | wall time                         | 3,409 ms                                           | 320 ms                                             | 317 ms                  |
|                                         | watch frames / bytes              | 408 / 480,831                                      | 7 / 7,126                                          | 11 / 11,002             |
|                                         | watch effect / activity events    | 400 / 2                                            | 1 / 1 (trailing pulse leaked into next case)       | 3 / 2, before `exited`  |
| `seq 1 200000` flood (1.29 MB)          | viewer resyncs / output events    | 37 / 24                                            | 62 / 2                                             | 59 / 1                  |
|                                         | output bytes delivered            | 491,100                                            | 20,025                                             | 10,047                  |
|                                         | wire bytes                        | 2,199,127                                          | 1,246,675                                          | 1,179,395               |
|                                         | watch activity events / bytes     | 59 / 55,659                                        | 4 / 10,450                                         | 3 / 7,130               |
| Blocked viewer: flood, title, resize    | slow viewer events                | snapshot 1, output 2, resync 2, effect 1, resize 1 | snapshot 1, output 1, resync 1, effect 1, resize 1 | not re-run              |
|                                         | replica cols after unblock        | 93                                                 | 93                                                 |                         |
| Idle exited sessions                    | checkpoint watch events           | 7 in 11 s (3 sessions)                             | 0 in 11 s (3 sessions)                             | 0 in 5.5 s (2 sessions) |
| `sessions: 3`, three exited, 4th create | outcome                           | `LIMIT`                                            | created                                            | not re-run              |

Reading the flood row: the prototype resyncs more often than the baseline on a
fast local pipe with a 64 KiB budget. The baseline JSON-encodes every chunk in
`queue()` before it is ever sent, which throttles the synchronous PTY callback
and, through PTY backpressure, the producer; the prototype's enqueue path is
cheap, so the daemon drains the PTY faster and the 64 KiB budget (about 16 KB
of raw output at the 4x estimate) overflows on almost every send. Both
implementations end with a correct replica; the difference is how much of the
1.29 MB arrives as output rather than as 7 KB snapshots. This is expected
behaviour for a viewer that is persistently just too slow, and it points at a
real question for the design: with scrollback a snapshot is hundreds of
kilobytes, so back-to-back resyncs can cost more than the output they replace.
A minimum spacing between resyncs on one stream (keep dropping output for, say,
100 ms after a resync before generating the next) or a budget that scales with
snapshot size are the candidate mitigations; see open questions.

Lost measurements, not re-run under the post-crash caps (one bun process at a
time, one flood per run, a handful of WASM instances):

- The same flood at the default 256 KiB budget for both implementations. The
  direction is predictable (fewer resyncs, more output delivered, for both) but
  the numbers are not recorded.
- `hardening.test.ts` and `daemon.test.ts` run against the prototype. The
  test copies were pointed at the prototype and the run was in flight when the
  machine crashed. The blocked-viewer case above exercises the same path as
  the first hardening test and the effect-ordering smoke exercises the second,
  but a green suite is not on record.

## Implementation plan

Order matters: land the wire framing change first so that the queue holds
frames from the start and the budget is exact. If the framing lands later, the
scheduler can ship with the `bytes` estimate the prototype uses and switch to
`frame.byteLength` in one line.

| Step | Files                                                                                                               | Change                                                                                                                                                                                                                                                                                                                                      | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Hours |
| ---- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| 1    | `packages/session-daemon/src/index.ts` 63-91, 176-359, 754-802, 805-822                                             | `Entry`/`Stream`/`Connection` types; `queue` control-only with frames; `invalidate`, `nextStream`, `flush`, `emit` with reserved positions and lazy resync; `end` without resync; `attach` held stream; `dropConnection`; drop the `droppable` parameter from `broadcast` and its three call sites; `failStream` for an unencodable resync. | `hardening.test.ts:127-205` unchanged (resync count is still > 0). New in `hardening.test.ts`: 200 title effects on a live viewer produce zero resyncs and consecutive positions; a resize produces exactly one resync immediately before the resize event; two attachments on one connection both progress while one floods (round robin); output arriving during attach lands after the initial snapshot; a viewer whose engine faulted still receives `ended`. `scripts/session-soak.ts` still asserts `resyncs > 0`; re-baseline `docs/session-library/linux-x64-baseline.json`. | 6-8   |
| 2    | `index.ts` 64-72, 310-331, 584-624, 636-646, 655-666, 880-911; `DaemonConfig.limits`                                | `pulse`/`drainPulse`, `notifyIntervalMs` (250), `publicInfo` once per event, drain before `exited`/`state`, clear timers on remove and close; optionally raise `controlQueueMessages` to 8192.                                                                                                                                              | `hardening.test.ts:207-257` and `511-617` unchanged. New: a burst of effects yields at most one `effect` per kind per interval and one `activity`, and the last `effect` precedes `exited`; input alone produces one `activity`. Adjust `hardening.test.ts:463-493` limits if the message cap changes.                                                                                                                                                                                                                                                                               | 2-3   |
| 3    | `index.ts` 375-432, 584-624, 636-646, 672-681, 875-911                                                              | `dirty` flag, clear at checkpoint start, interval and close checkpoint dirty records only.                                                                                                                                                                                                                                                  | `daemon.test.ts:105-158` and `hardening.test.ts:333-372` unchanged. New in `daemon.test.ts` with `checkpointIntervalMs: 100`: an exited session produces exactly one `checkpoint` event after exit and none over the next several intervals; output after a checkpoint produces the next one.                                                                                                                                                                                                                                                                                        | 1-2   |
| 4    | `index.ts` 433-483, 515-518, 636-646, 733-753; `DaemonConfig.limits`                                                | `liveSessions()`, `retainedSessions` (default to be decided), `removeRecord` shared by `remove` and `evictRetained`, `endedAt` on exit and restore.                                                                                                                                                                                         | `hardening.test.ts:429-461` (`sessions: 0` must still fail validation) unchanged. New in `daemon.test.ts`: with `sessions: 2`, two exited records do not block a third create; with `retainedSessions: 2`, a third exit evicts the oldest, emits `removed`, and its file is gone.                                                                                                                                                                                                                                                                                                    | 2-3   |
| 5    | `packages/session-daemon/README.md:21-26`, `packages/session/README.md:12-30, 44`, `docs/session-library.md:98-113` | Describe the stream (control events never cost a snapshot; a resync follows dropped output or a resize), notification coalescing, dirty checkpoints, live-only limit and retention policy. `bun run format`.                                                                                                                                | `bun run typecheck`, `bun test`, `bun run test:soak` for the new baseline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 2-3   |
| 6    | Optional: `index.ts` control queue                                                                                  | In-queue replacement of unsent `activity`/`effect` frames per session.                                                                                                                                                                                                                                                                      | Stalled watcher with 50 busy sessions stays under `controlQueueMessages`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 2     |

Total: 15 to 21 hours including the optional step. No client package or
replica change is needed.

Dependencies on other fixes:

- Wire framing (`01-wire-framing.md`): the framing's `queue(c, WireMessage | Uint8Array)` and `sendFrame` are the same change as step 1's control path; whoever lands second rebases. Its note that `outputQueueBytes` will then hold about 3.5x more raw output applies here too.
- Scrollback increase (separate research): larger snapshots make every resync dearer, which raises the priority of resync spacing (open question below) and of the framing change.
- Attachment semantics (`06`): late attach, `claimSize` and the preview slot all get cheaper or simpler on top of step 1; none of them block it.

## Risks and open questions

- **Reserved positions.** The resync placeholder must take its position when the
  stream goes dirty, not when it is sent; otherwise queued control events end up
  with positions below the resync and the client silently ignores them as
  duplicates. The first prototype assigned positions at send time to avoid
  this, which cannot survive pre-encoded frames; the reserved-position form is
  the one to implement and the one to test explicitly (a test that queues an
  effect, overflows the viewer, then checks the effect is delivered after the
  resync with a higher position).
- **Resync spacing.** A persistently slow viewer resyncs on every send. With
  scrollback that can be a stream of large snapshots. A minimum spacing per
  stream, or a budget expressed as a multiple of the current snapshot size, is
  probably wanted; nobody has picked one. The soak's 200 ms viewer is the
  place to measure it.
- **Control-first fairness.** Responses and watch events always precede
  output. With coalescing the watch share is bounded, but a connection that is
  both a fleet watcher over 128 sessions and a viewer could see output delayed
  behind up to 512 frames per 250 ms. Weighted alternation is possible if it
  shows up.
- **Effect coalescing loses bursts.** Per-kind latest-wins hides repeated
  bells within 250 ms. If a fleet indicator wants counts, carry a `count` on
  the coalesced effect or exempt `bell`.
- **Eviction deletes screens.** The retained cap's oldest-first eviction needs
  an owner's decision; refusing or leaving it unbounded are the alternatives.
- **Budget meaning changes twice.** The prototype's 4x estimate roughly
  preserves today's JSON-inflated meaning; pre-encoded frames make the number
  mean raw bytes. Pick the default deliberately (256 KiB of raw output is
  probably fine) and re-baseline the soak once.
- **`checkpoint` is no longer periodic.** Anything that treated it as a
  heartbeat breaks; nothing in the repository does.
- **Lost verification.** The full daemon test suites did not run against the
  prototype after the crash; step 1's new tests are where that evidence should
  come from.

## Effort

| Part                                               | Hours |
| -------------------------------------------------- | ----- |
| Scheduler (step 1) with tests                      | 6-8   |
| Activity and effect coalescing (step 2)            | 2-3   |
| Dirty checkpoints (step 3)                         | 1-2   |
| Limits and retention (step 4)                      | 2-3   |
| Docs, format, typecheck, soak re-baseline (step 5) | 2-3   |
| Optional in-queue notification slots (step 6)      | 2     |
| Total                                              | 15-21 |
