# 06: Attachment semantics: size ownership, preview, late attach, non-holding terminals

Research and recommendations for the werk session libraries. Nothing here is
decided; where a lean is stated it is labelled. Measurements were taken on
2026-09-05 against the real daemon and ghostty engine in this checkout (Bun,
Linux x64, WSL2); the scratch scripts were lost in a reboot, so figures are
reproduced from the run logs rather than re-run.

## Summary

Three problems were confirmed against a real daemon:

1. **Whoever attaches first holds the size.** A read-only viewer attached first
   takes it; a later input-capable viewer gets `PERMISSION_DENIED` on resize and
   the only remedy is `endAttachment` on the first viewer. `preview` is refused
   as reserved. When a holder leaves, the size passes to whichever remaining
   viewer is first in the daemon's `viewers` map (insertion order), with no
   preference for input-capable or recent attachments.
2. **Attaching to a session that has already exited delivers a snapshot and
   then nothing.** No `exit`, no `ended`. A consumer that waits for `ended`
   hangs. The late attachment also holds the size and its `resize` is accepted,
   which reflows the saved screen of a dead process (size went from 80x24 to
   100x30 in the run).
3. **A terminal client that does not hold the size has no way to show a grid
   unlike its own window.** The CLI paints rows straight through, so a larger
   session grid scrolls the local window.

Two findings shape the preview design more than anything in the original
questions:

- **The wire encoding, not the snapshot, is the cost.** A 120x40 snapshot with
  2,000 lines of scrollback is 278 KB and takes 0.27 ms to encode in the engine,
  but 745 KB and 40 ms to JSON-encode with the protocol's `{"$bytes":[...]}`
  representation. Even with no scrollback (18 KB) the JSON step is 2.3 ms.
- **The formatter is two orders of magnitude cheaper.** Formatting the active
  screen as VT (colours preserved) costs 0.1 ms and 5.8 KB on the wire; as plain
  text 0.08 ms and 4.5 KB; as HTML 0.07 ms and 7.1 KB. On the client,
  `frame()` on a restored 120x40 replica costs about 30 ms per call, so a
  snapshot-driven tile would cost about 35 ms of main-thread time per update.

Recommendations, in one paragraph each:

- **Size ownership.** Keep one holder at a time, transferable, visible in
  listings, but allow the size to be unheld. `preview` never holds it and is
  never a successor. `attach` takes `holdSize: "never" | "if-free" | "claim"`,
  defaulting to `if-free` for input-capable attachments and `never` otherwise.
  Add a `claimSize` request that any input-capable attachment may make, gated by
  the authorize hook under the action `claimSize`. On a holder leaving, prefer
  input-capable attachments, then those that asked to hold, then most recent.
  Refuse `resize` on a record with no live process.
- **Preview.** A `preview` attachment is read-only, holds no size, gets no
  output stream and no resyncs. The daemon formats the active screen once per
  record per interval (on change, minimum interval 250 ms, default 500 ms) as a
  small `preview` event carrying VT text, cursor and size, and sends that one
  encoding to every preview viewer. Twenty busy 120x40 tiles at 500 ms cost the
  daemon about 4 ms of CPU per second and about 230 KB/s on the wire; the same
  tiles fed by snapshots would cost 50 ms to 800 ms of daemon CPU per second
  and 2 MB/s to 30 MB/s, and about 1.4 s of client main thread per second.
- **Late attach.** When the record has no live process, the daemon should send
  the initial snapshot, then `exit` when the outcome is known, then
  `ended: "session-ended"`, in the attach's `after()` hook, without registering
  a viewer. The client contract already allows `ended` immediately after a
  snapshot; no client change is needed. This is simpler and safer than putting
  session state in the attach response, because the race the reviewer hit is
  exactly the one the stream is ordered to close.
- **Non-holding terminals.** Clip to the local window with a one-line
  indicator, clear on grid change, and offer `--claim-size` (default on for a
  writable attach when the daemon allows it, degrading to clipped follow on
  `PERMISSION_DENIED`). No renderer seam change is required; a viewport origin
  on `Frame` is a possible later nicety.

Estimated effort for all four: about 40 to 45 hours, with C (late attach) first
at about 5 hours because it unblocks the smoke test, then A, then B, then D.
The preview scheduler and the size-holder events both interact with the stream
scheduler rewrite; details in the plan.

## Current state (file:line)

All paths are under `/home/mike/Development/omnilogic-labs/werk`.

### Daemon: `packages/session-daemon/src/index.ts`

| Lines   | What it does today                                                                                                                                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 53-58   | `authorize?(principal, action, session?, requested?) => boolean \| Permissions`. Actions seen today: `list`, `create`, `attach`, `endAttachment`, `readScreen`, `readHistory`, `terminate`, `remove`, `watch`. No size action exists.                                                                                                 |
| 73-79   | `Viewer` stores `representation: string` but nothing reads it.                                                                                                                                                                                                                                                                        |
| 188-226 | `queue()`: control messages (no `attachmentId`) are never dropped; output is per-attachment and dropped by marking the attachment `dirty` when the connection's output budget is exceeded.                                                                                                                                            |
| 227-244 | `stateEvent()`: encodes a full engine snapshot (scrollback included) for `snapshot` and `resync`.                                                                                                                                                                                                                                     |
| 279-305 | `emit()`: **every non-droppable event except `ended` discards the viewer's queued output and queues a full `resync` first**, whether or not anything was queued. Confirmed: five title changes produced five resyncs for a live viewer; a `transferSize` there and back produced two resyncs for the holder.                          |
| 332-359 | `end()`: removes the viewer; on `session-ended` sends `resync`, `exit` (if known) and `ended`; if the leaver held the size, hands it to the first remaining viewer on the same record in `viewers` insertion order (351-357) and emits `size-holder` to that viewer only.                                                             |
| 589     | Output is broadcast to every viewer as droppable; 601 broadcasts effects as non-droppable (so each effect costs a resync per viewer).                                                                                                                                                                                                 |
| 636-646 | Child exit: marks `exited`, records `exit`, calls `end(v, "session-ended")` for viewers present **at that moment**. Nobody else is ever told through an attachment stream.                                                                                                                                                            |
| 649-696 | `input` refuses when there is no child (`CONFLICT`, 660-661). `resize` (672-681) requires `holdsSize` and resizes `child?` and `terminal?` even when the child is gone. `transferSize` (683-694) requires the caller to hold the size; target must be on the same record; both parties get `size-holder`.                             |
| 697-703 | `endAttachment`: any connection with `endAttachment` permission on the session may end any attachment. Today this is the only way to take the size from a tile.                                                                                                                                                                       |
| 754-802 | `attach`: refuses when `!r.terminal` (758); refuses `preview` as reserved (759-764); default permissions `{read: true, input: false}`; **`holdsSize: !r.info.attachments.length`** (780); `after()` queues the initial snapshot and notifies `attached`. Nothing looks at `r.child`, so an exited or `lost` record attaches normally. |

### Client: `packages/session/src/index.ts` and `types.ts`

| Lines               | What it does today                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| index.ts 100-135    | `Attachment.deliver()`: first event must be `snapshot`, `resync` or `ended` (107-116); `size-holder` updates `holdsSize` (127-128); `ended` forgets the attachment. |
| index.ts 161-173    | `resize()` refuses locally unless `holdsSize`.                                                                                                                      |
| index.ts 174-184    | `transferSize(targetAttachmentId)`; the daemon enforces that the caller holds it.                                                                                   |
| index.ts 375-392    | `attach()` sends `representation` (default `snapshot`) and `permissions`.                                                                                           |
| types.ts 28-35      | `AttachmentInfo { id, sessionId, generation, principal, permissions, holdsSize }`. No representation field, so a listing cannot tell a tile from a terminal.        |
| types.ts 83         | `Representation = "snapshot" \| "vt" \| "preview"`.                                                                                                                 |
| types.ts 85-89      | `AttachOptions { representation?, permissions?, onEvent }`.                                                                                                         |
| types.ts 92-110     | `AttachmentEvent` union; `size-holder` at 108 carries only `holdsSize` for the recipient.                                                                           |
| README.md 25-30, 44 | "first event is a snapshot"; "ended is last"; size-holder semantics; output prioritisation and per-viewer resync "belong to the server's queue scheduler".          |

### Consumers

| File                                 | Lines        | Behaviour                                                                                                                                                                                                        |
| ------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/werk/src/main.ts`          | 97-124       | `terminalRenderer()` paints every changed row at `y+1` with no clipping; a session grid taller or wider than the window scrolls or wraps the local terminal.                                                     |
| `packages/werk/src/main.ts`          | 167-173, 198 | Resizes the session to the local window only when `holdsSize`; otherwise the local window follows nothing.                                                                                                       |
| `packages/werk/src/main.ts`          | 190          | `finish()` on `ended`, so `werk attach` on an exited session hangs today.                                                                                                                                        |
| `examples/session-web/src/client.ts` | 92-102       | Attaches with `input: true`, shows "You hold terminal size" or "Following shared size"; the resize button calls `attachment.resize()` regardless (136-143) and surfaces `PERMISSION_DENIED` as a status message. |

### Product and proposal context

- `docs/product/00-what-werk-is.md`, "Sharing and handoff": one person holding
  the size of a shared terminal at a time, able to pass it on; nobody watched
  silently. Web-first. The owner has confirmed this direction.
- `docs/product/03-surfaces.md`, TUI and Web: a live preview pane and a grid of
  live or recently snapshotted tiles are the features that justify those
  surfaces.
- `docs/product/04-open-questions.md` question 9: lean is first writable,
  subsequent read-only, with an explicit takeover; the UI must show how many
  are attached.
- `docs/proposals/02-session-library.md`, "Attachments and ordered state":
  reserves `preview` as read-only and rate-limited "without designing it now";
  "Sharing, permissions and size": one holder, transferable; where the size
  goes when the holder leaves is "an implementation detail"; the raw terminal
  client's grid mismatch is open and a browser-first answer is fine.
- `docs/research/11-interfaces.md`, "Rendering many terminals at once":
  proposes static snapshot tiles ("a text blob or one canvas paint per push")
  for the grid and a live replica only for the focused session.

## Measurements

Real daemon, real engine, one process, this machine. Figures are per call.

| Scenario (cols x rows, content)   | Snapshot bytes | Engine encode | Wire frame (JSON `$bytes`) | JSON encode | `restore()` | `frame()` | `readScreen()` |
| --------------------------------- | -------------: | ------------: | -------------------------: | ----------: | ----------: | --------: | -------------: |
| 120x40, empty                     |          1,210 |      0.039 ms |                    3,844 B |    0.136 ms |     5.33 ms |   28.2 ms |       0.030 ms |
| 120x40, 40 coloured lines         |         18,299 |      0.333 ms |                   49,585 B |    2.290 ms |     4.97 ms |   32.6 ms |       0.032 ms |
| 120x40, + 2,000 lines scrollback  |        277,648 |      0.266 ms |                  744,712 B |    40.45 ms |     6.58 ms |   35.0 ms |       0.034 ms |
| 120x40, + 10,000 lines scrollback |        227,262 |      0.200 ms |                  609,560 B |     32.8 ms |     5.31 ms |   31.9 ms |       0.038 ms |
| 200x60, + 2,000 lines scrollback  |        161,087 |      0.148 ms |                  432,221 B |     24.0 ms |     5.25 ms |   78.4 ms |       0.057 ms |

Notes on those numbers:

- The engine encode figure the task quoted (about 0.3 ms) holds. The restore
  figure (6 to 10 ms) is slightly pessimistic; 5 to 6.6 ms was measured. But
  neither is the dominant cost. The `{"$bytes":[...]}` encoding inflates bytes
  by about 2.7x and costs 2 to 40 ms per snapshot; and `frame()` iterates every
  cell through the WASM boundary and `JSON.stringify`s every row to detect
  change (`packages/terminal/src/engine.ts:398-415`), so it costs about 30 ms
  at 120x40 even when nothing changed. A full 120x40 `Frame` is about 640 KB as
  JSON; 200x60 is 1.6 MB.
- Snapshot size tracks page capacity rather than visible content: a 120x40
  screen with 40 short lines and no scrollback is 1.5 KB, the same screen after
  2,000 coloured lines has an 87 KB active page record.
- Formatter on the same 120x40 screen with 2,000 lines of scrollback, selecting
  the active screen only: `PLAIN` 0.080 ms, 4,328 chars, 4,496 B as a JSON
  event; `VT` 0.096 ms, 5,029 chars, 5,820 B; `HTML` 0.070 ms, 6,846 chars,
  7,094 B. The ghostty formatter exposes `PLAIN`, `VT` and `HTML`
  (`GhosttyFormatterFormat` in the vendored `types.h`); the engine wrapper
  hard-codes `PLAIN` today (`engine.ts:244-262`).
- Snapshot record stream observed: `TERMINAL:926 SCREEN:54 PAGE:86981
CONTINUATION:0 READY:0 HISTORY:6 PAGE:199943 FINISH:0` (tag values 1, 2, 3,
  7, 5, 4, 3, 6). Cutting the byte stream after READY (with or without the
  HISTORY manifest) is refused by the decoder's `next()` with `INVALID_VALUE`;
  `ready()` itself accepts the prefix. A screen-only snapshot is therefore
  possible only through an engine restore option that stops at READY (the API
  is designed for that), not by slicing bytes. That is a possible later
  fast-first-paint improvement for full attachments and is not needed for
  previews.
- Control events cost a resync each today (see `emit()` above): a `claimSize`
  would cost two full snapshots (old holder and new) per claim, 40 ms of JSON
  each on a session with scrollback, until the scheduler rewrite changes
  `emit()`.

## Size ownership

### Options

| Option                                       | What it fixes                                                                                     | What it does not fix                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| (i) `preview` never holds size               | The fleet-tile case entirely: tiles cannot capture the size, so a later terminal gets it if free. | Two full viewers (owner's terminal and a colleague's browser tab); a read-only `snapshot` viewer that attached first. |
| (ii) `claimSize` request, authorize-gated    | Taking the size from anyone, including a colleague, under policy.                                 | Nothing on its own; it is the takeover primitive question 9 already leans towards.                                    |
| (iii) Preference order on succession         | The arbitrary hand-off in `end()`.                                                                | The first-attach capture.                                                                                             |
| (iv) `attach` requests `holdSize` explicitly | Read-only viewers of any representation not capturing the size; terminals asking for it up front. | A holder that will not give it up; needs (ii).                                                                        |

None is sufficient alone. (i) is the cheapest and removes the case the review
hit. (iv) generalises (i) to `snapshot` and `vt` viewers that only watch. (ii)
is what sharing needs and what question 9's "explicit takeover" means. (iii)
is a small change in `end()`.

### Recommendation (a lean, not a decision)

Keep the contract "at most one holder at a time, transferable, visible in
listings". Change "exactly one whenever anyone is attached" to "at most one",
so the size can be free while only non-holding viewers are attached.

**Attach.** `AttachOptions.holdSize?: "never" | "if-free" | "claim"`.

- `never`: never holds, never a successor. Forced for `preview`; the daemon
  refuses `preview` with anything else as `INVALID_ARGUMENT`.
- `if-free`: takes the size when nobody holds it; otherwise attaches without it.
  Default when the granted permissions include `input`.
- `claim`: takes the size if free, otherwise takes it from the holder subject
  to `authorize(principal, "claimSize", session)`; on refusal the attach still
  succeeds without the size rather than failing, so a terminal does not need two
  round trips. The response's `holdsSize` says what happened.
- Default when `input` is not granted: `never`. This follows question 9's lean
  (watchers are secondary) and the owner's direction that one designated owner
  sizes a shared terminal. A read-only terminal on one's own session that wants
  the grid to fit can pass `if-free` or `claim` explicitly.

**Claim.** New request `claimSize { attachmentId }` on `Attachment`, allowed
when the attachment has `input` and `authorize` permits action `claimSize`
(the hook sees the session record including its `attachments`, so it can see
who holds the size now and decide by principal). Effect is identical to
`transferSize` initiated by the recipient: old holder gets `size-holder:
false`, new holder `size-holder: true`, watchers get `attachments-updated`.
`transferSize` stays as the holder-initiated form; its target must not be a
`preview` attachment and must have `input`, otherwise `INVALID_ARGUMENT`.

**Succession** when the holder ends (`end()`, 351-357): choose among remaining
attachments on the record, excluding `preview` and `holdSize: "never"`, by
(1) `input` granted, (2) `holdSize: "claim"` before `"if-free"`, (3) most
recently attached (higher `generation`). If nobody qualifies the size is free;
the next `if-free` or `claim` attach, or a `claimSize`, takes it. Listings show
no holder.

**Dead records.** `resize` on a record with no live child returns `CONFLICT`
"Session has no live process", matching `input`. Attachments to such records
never hold the size (they end immediately under the late-attach change below).

**What the authorize hook sees.** Two new actions: `claimSize` (from the
`claim` attach option and from the `claimSize` request) and, only if the
design wants it, `holdSize` for `if-free` on a shared session. The lean is to
gate only `claimSize`; taking a free size is not a takeover. Existing hooks
written as allowlists (as the fleet test's hook is) will refuse `claimSize` by
construction, which fails closed.

**Visibility.** Add `representation: Representation` and `holdSize` to
`AttachmentInfo` so listings and `attachments-updated` can show tiles apart
from terminals and show who could take the size. `size-holder` keeps its
shape; the recipient learns only about itself, which is enough because the
listing carries the rest. An optional `by?: Principal` on the `holdsSize:
false` event would let a terminal say "size taken by Alice"; this is a nicety.

**Consumers.**

- CLI: `werk attach` requests `holdSize: "claim"` for a writable attach and
  `never` for `--read-only`; `--follow` forces `never`; `--claim-size` forces
  `claim` even with `--read-only`. After attach, if `holdsSize` is false, the
  clipped mode in the "Non-holding terminal clients" section applies.
- Browser example: request `if-free`; show a "Claim size" button when not
  holding; keep the resize button enabled only when holding.

## Preview representation

### What a tile needs

A tile shows roughly the last screen of a session, updated often enough to
look alive: a frame every 250 ms to 1 s, only when something changed, no
scrollback, no input, and a cost that stays flat across twenty or more tiles on
one browser connection through the bridge. It also needs to know when the
session exits, but the fleet `watch` stream already carries `state`, `title`,
`lastEffect` and `attachments`, so the preview stream needs only what the watch
stream does not have: the picture.

### Payload

Send text, not a snapshot. The lean is a new event:

```ts
| {
    type: "preview";
    size: Size;                 // the session grid the text was formatted at
    format: "vt" | "plain";    // requested at attach; vt keeps colour and styles
    text: string;               // active screen, rows joined by "\n", trailing blanks trimmed
    cursor?: { x: number; y: number; visible: boolean };
    changedAt: number;          // lastOutputAt when this frame was taken
  }
```

Reasons: the formatter produces it in 0.1 ms; it is 5 to 7 KB at 120x40; it
needs no replica, no WASM and no `restore()` on the client; the `HTML` emit
even skips the client's ANSI parsing (a tile can set `innerHTML`, sanitised,
or a TUI pane can write the `VT` text through a small cell renderer). It is
exactly the "text blob per push" `11-interfaces.md` proposed for the grid.

A snapshot-driven preview was the working assumption and is worth recording as
rejected on the measurements: the replica does accept a snapshot at any
position, but each frame costs the daemon 2 to 40 ms of JSON encoding and the
client 5 ms of restore plus about 30 ms of `frame()`, and carries the whole
scrollback. The size-only READY prefix cannot be cut from the bytes (decoder
refuses it) and would still be 87 KB for a well-used page. If `frame()` is
later made cheap (ghostty's render state has per-row dirty flags that the
engine wrapper does not use) and the wire gains a binary byte encoding, a
`snapshot`-based preview could be revisited for the focused tile, but the text
form remains the right default for the grid.

### Daemon scheduling

Per record, not per viewer:

- `RecordState` gains `previewDirty: boolean` and `previewTimer?`. The output
  path (`index.ts:589`) sets `previewDirty` and, if preview viewers exist and
  no timer is pending, arms a timer for the record's interval. Resize and
  effects that change the screen set the flag the same way.
- On the timer: if still dirty and at least one preview viewer remains, format
  once (`terminal.formatScreen("vt")` plus cursor and size), clear the flag,
  and hand the same message object to every preview viewer on the record with
  its own `attachmentId`, `generation` and next `position`. One formatter call
  per record per interval regardless of viewer count. The interval is the
  minimum requested by that record's preview viewers, clamped to daemon limits
  (`previewMinIntervalMs` 250, default 500, maximum 5,000).
- The first `preview` frame is sent immediately from `after()` as the
  attachment's first event, in place of the snapshot. Nothing else is sent
  until output changes the screen.
- Preview viewers are excluded from `broadcast()` of output and from the
  resync machinery in `emit()`; they receive `preview`, `exit` and `ended`
  only. `resize` and `effect` are not sent (the next preview frame carries the
  new size; effects are on the watch stream). This also means no preview viewer
  ever triggers a `stateEvent()`.
- Queueing: a preview frame is small and coalesced, so it can travel as a
  control message today. With the scheduler rewrite the better shape is a
  per-attachment "latest preview" slot that a newer frame replaces if the older
  one has not been flushed, so a slow connection never accumulates frames.
  Design the slot as one of the rewrite's per-attachment lanes; ship the
  control-message form first if the rewrite lands later.

### Engine change

`TerminalHandle` gains `formatScreen(format: "plain" | "vt" | "html"): string`
(or `readScreen(format?)`), and `TerminalCapabilities` gains `preview: boolean`
so a daemon with an engine that cannot format refuses `preview` with
`UNSUPPORTED`. The wrapper already builds the selection and options for
`PLAIN`; this is parameterising `emit`. The test engine fakes in
`packages/session-daemon/test/daemon.test.ts:20-70` need the method.

### Client

`Attachment.deliver()` accepts `preview` as a first event (alongside
`snapshot`, `resync`, `ended`). `AttachOptions` gains
`preview?: { intervalMs?: number; format?: "vt" | "plain" }` used only with
`representation: "preview"`. The replica ignores preview attachments entirely;
a tiny helper that turns `VT` text into `Frame` rows (or the `HTML` form into
a node) could live in `@werk/terminal` later, but the example can start with a
`<pre>` and a 200-line ANSI-to-span converter.

### Cost for twenty tiles at 120x40

Assume every session is busy (worst case), 500 ms interval, one browser
connection through the bridge.

| Cost                        | Text preview (recommended)                 | Snapshot preview, no scrollback            | Snapshot preview, 2,000 lines scrollback      |
| --------------------------- | ------------------------------------------ | ------------------------------------------ | --------------------------------------------- |
| Daemon CPU per second       | 20 x 2 x (0.1 + 0.05) ms = **6 ms**        | 20 x 2 x (0.33 + 2.3) ms = 105 ms          | 20 x 2 x (0.27 + 40) ms = 1.6 s (over budget) |
| Wire per second             | 20 x 2 x 5.8 KB = **232 KB/s**             | 20 x 2 x 50 KB = 2 MB/s                    | 20 x 2 x 745 KB = 30 MB/s                     |
| Client main thread per sec. | 20 x 2 x ~0.5 ms (ANSI to DOM) = **20 ms** | 20 x 2 x (5 + 30) ms = 1.4 s (over budget) | same                                          |

At 1 s intervals halve everything. Idle sessions cost nothing because frames go
out only on change. Realistically a fleet of twenty has two or three sessions
scrolling at once, so the text design is comfortably under 1% of a core on the
daemon.

## Late attach

### The problem

`attach` never consults `r.child`. For an `exited`, `failed` or `lost` record
with a decodable terminal it registers a viewer, sends the snapshot and stops.
`exit` and `ended` are only ever sent from the child-exit handler to viewers
present at that instant (`index.ts:636-646`). The list/attach race is
unavoidable in any consumer, so the stream has to close it.

### Options

1. **Attach response carries session state and exit.** `AttachmentInfo` (or a
   sibling field) says `state: "exited", exit: {...}`. The consumer checks it
   before waiting. Cheap, but it moves lifecycle knowledge out of the ordered
   stream, every consumer has to remember to check, and the race between the
   response and the first event still exists for a session exiting in that
   window (already handled by `end()`, so this is fine in practice, but it is
   two places to look).
2. **Daemon emits `exit` then `ended` after the initial snapshot when the
   record has no live process.** The stream stays the single source of truth;
   "first event is a snapshot, `ended` is last" holds; consumers that already
   wait for `ended` work unchanged.

### Recommendation

Option 2, implemented in `attach`'s `after()`: if `!r.child`, queue the initial
snapshot, then `exit` when `r.info.exit` exists (it does for `exited` and
`failed`; `lost` records have none), then `ended` with reason `session-ended`,
all with consecutive positions, and do not register the viewer at all (no
`viewers.set`, no `attachments.push`, no `attached`/`detached` notifications,
`holdsSize: false` in the response). The attachment exists only for the three
frames it takes to deliver the saved screen, which is what a dead session has
to offer. `permission()` and the attachment limit still apply.

Queue those three frames directly rather than through `emit()`, or the
`exit` will be preceded by a second full snapshot (the resync-per-control
event). The same applies inside `end()` on `session-ended` for live viewers:
its resync (341-346) exists to reconcile discarded output and could be skipped
when the viewer has nothing queued and is not dirty; the scheduler rewrite
probably subsumes this.

For `lost` records, `ended` without `exit` is honest; the consumer can read
`state` from `get()` or the watch stream. Adding a synthetic
`exit: { code: null, reason: "lost" }` is possible but invents an outcome the
daemon does not know, so the lean is against it.

Consumers: `werk attach` on an exited session will paint the screen and return
immediately (it could print the exit code and, in a TTY, wait for a key before
leaving the alternate screen; a CLI choice). The browser example shows
"Attachment ended: session-ended" and keeps the painted replica, which is
already its behaviour for a session that exits while attached.

Also fold in from problem 1: `resize` on a dead record returns `CONFLICT`.

## Non-holding terminal clients

This depends on A: with `preview` never holding and `claim` on a writable
attach, the common case is that a person at a terminal on their own daemon
holds the size and this section is the exception, not the rule. It becomes the
rule only for `--read-only`, `--follow`, and shared sessions where the daemon's
policy refuses the claim.

Recommendation for the CLI (`packages/werk/src/main.ts`, `terminalRenderer`):

- **Clip, do not scroll.** Paint only rows `y < local.rows` and cells `x <
local.cols`; skip the rest. Home the cursor only when it is inside the
  window; hide it otherwise. On any change of session grid or local window,
  clear the screen before the next paint so stale cells from a larger grid do
  not linger. The `Frame` already carries `cols`/`rows`, so the renderer knows
  when it is clipping.
- **One-line indicator.** When clipping, reserve the bottom local row for
  `session 160x50 · window 120x40 · read-only · Ctrl-] detaches` (or
  `--claim-size to resize`). This is the status line `03-surfaces.md` already
  allows for and it should exist only while the grids differ.
- **Pad** when the session grid is smaller: paint top-left aligned and leave
  the rest blank. Already the effective behaviour once clearing on change is
  added.
- **Offer to claim.** `--claim-size` at attach time; a runtime chord is not
  worth its complexity while Ctrl-] is a single-key detach.

Renderer seam: no change needed for clipping. A `viewport?: { x: number; y:
number }` origin on the CLI's own renderer would let a small window pan over a
large grid keeping the cursor visible; it can be added inside the CLI without
touching `@werk/terminal`'s `Renderer` interface. The browser letterboxes or
scales, as the proposal says, and needs nothing here.

## Implementation plan

Ordered so each step leaves the tests green and the earlier steps do not need
re-work. Steps 1 and 2 do not depend on the scheduler rewrite; step 3 is best
built on it or designed to slot into it; step 4 is consumer-only.

### Step 1: late attach (C) and dead-record resize

| File                                           | Change                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/session-daemon/src/index.ts` 754-802 | In `attach`, when `!r.child`: respond with `holdsSize: false`, and in `after()` queue snapshot, `exit` (if known), `ended: session-ended` directly; do not register a viewer.                                                                                                                                                                                                    |
| `packages/session-daemon/src/index.ts` 672-681 | `resize` with no child: `CONFLICT`.                                                                                                                                                                                                                                                                                                                                              |
| `packages/session/README.md`                   | Document: an attachment to a session with no live process receives its saved screen, its exit when known, and `ended`; resize and input on such a session are refused.                                                                                                                                                                                                           |
| `packages/session-daemon/test/daemon.test.ts`  | New test: create a fast-exiting session, wait for `exited`, attach, assert events `[snapshot, exit, ended]` in order with consecutive positions, `holdsSize` false, no entry in `attachments`, `resize` rejects `CONFLICT`. A second case for a `lost` record recovered from checkpoint (`createSessionDaemon` on the same state dir after close) asserting `[snapshot, ended]`. |
| `packages/session/test/session.test.ts`        | Mock server sending `snapshot`, `exit`, `ended` before the attach response resolves; assert the listener saw all three and the handle is closed.                                                                                                                                                                                                                                 |
| `packages/werk/src/main.ts` 190                | Print the exit outcome on `exit` when not a TTY; no behaviour change otherwise.                                                                                                                                                                                                                                                                                                  |
| `docs/session-library.md`                      | One sentence under "Run the consumers".                                                                                                                                                                                                                                                                                                                                          |

### Step 2: size ownership (A)

| File                                                                   | Change                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/session/src/types.ts` 28-35, 85-89, 92-110                   | `AttachmentInfo` gains `representation: Representation` and `holdSize: "never" \| "if-free" \| "claim"`. `AttachOptions` gains `holdSize?`. `size-holder` optionally gains `by?: Principal`.                                                                                                                                        |
| `packages/session/src/index.ts` 174-189, 375-392                       | `Attachment.claimSize(options?)` sending `claimSize { attachmentId }`; `attach()` forwards `holdSize`; `transferSize` unchanged.                                                                                                                                                                                                    |
| `packages/session-daemon/src/index.ts` 754-802                         | Accept `preview` (see step 3 for its stream; here just stop refusing it and force `holdSize: "never"`, `input: false`). Compute `holdsSize` from `holdSize`, current holder and, for `claim`, `permission(c, "claimSize", r)`; on refusal attach without size. Record `representation` and `holdSize` in `info`.                    |
| `packages/session-daemon/src/index.ts` 649-696                         | New method `claimSize`: requires `input`, `permission(c, "claimSize", r)`, target not already holder; move the size; emit `size-holder` to both; `notify("attachments-updated")`. `transferSize`: target must have `input` and not be `preview`/`never`.                                                                            |
| `packages/session-daemon/src/index.ts` 332-359                         | `end()`: succession by the preference order; size may become free.                                                                                                                                                                                                                                                                  |
| `packages/session/README.md`                                           | Rewrite the size paragraph: at most one holder; `holdSize`; `claimSize`; succession order; listings show representation and holder.                                                                                                                                                                                                 |
| `docs/proposals/02-session-library.md` "Sharing, permissions and size" | Replace "where the size goes when its holder's attachment ends is an implementation detail" with the order, in the present tense once implemented; keep the raw-terminal presentation sentence pointing at the CLI behaviour from step 4.                                                                                           |
| `packages/session-daemon/test/daemon.test.ts` 105-158                  | Extend: read-only second viewer does not hold; `preview` never holds; input-capable `if-free` attach after a read-only one holds; `claimSize` by an input-capable viewer moves it and both see `size-holder`; `claimSize` from a read-only viewer is `PERMISSION_DENIED`; an authorize hook refusing `claimSize` leaves the holder. |
| `packages/session-daemon/test/hardening.test.ts` 511-617               | Fleet watch test: assert `representation` and `holdSize` appear in `attachments`; after `b` detaches, `a` (input) still becomes holder under the new order (line 598 stays true); add a case where only `never` viewers remain and no holder is listed.                                                                             |
| `packages/session/test/session.test.ts` 117-191, 288-339               | Mock results carry the new fields; `claimSize` routes to the right request; `size-holder` with `by` updates state.                                                                                                                                                                                                                  |
| `examples/session-web/src/client.ts` 92-143                            | Attach with `holdSize: "if-free"`; add a "Claim size" button calling `attachment.claimSize()`; enable resize only when holding.                                                                                                                                                                                                     |
| `examples/session-web/test/browser.test.ts`                            | The single-viewer resize assertions (124-128, 183-189) hold; add a claim-button click after a second attach in a second page if the test harness makes that cheap, else leave to daemon tests.                                                                                                                                      |
| `packages/werk/src/main.ts` 125-221                                    | `holdSize: "claim"` for writable, `never` for `--read-only`; flags `--follow` and `--claim-size`.                                                                                                                                                                                                                                   |
| `scripts/check-artefacts.ts` 166-215                                   | The binary's attach path is unchanged in behaviour (single viewer); re-run only.                                                                                                                                                                                                                                                    |

### Step 3: preview representation (B)

| File                                                                    | Change                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/terminal/src/types.ts` 38-46, 60-74                           | `TerminalCapabilities.preview`; `TerminalHandle.formatScreen(format)`.                                                                                                                                                                                                                          |
| `packages/terminal/src/engine.ts` 244-262, 375-396                      | Parameterise `format()` by `emit`; implement `formatScreen`.                                                                                                                                                                                                                                    |
| `packages/terminal/test/engine.test.ts`                                 | `formatScreen("vt")` round-trips colour; `plain` equals `readScreen()` modulo padding.                                                                                                                                                                                                          |
| `packages/session/src/types.ts` 92-110                                  | `preview` event variant; `AttachOptions.preview?`.                                                                                                                                                                                                                                              |
| `packages/session/src/index.ts` 100-135                                 | Accept `preview` as first event.                                                                                                                                                                                                                                                                |
| `packages/session-daemon/src/index.ts` 64-72, 279-309, 589-604, 754-802 | `previewDirty`/timer on `RecordState`; exclude preview viewers from output broadcast and resync; per-record tick formatting once; initial frame in `after()`; limits `previewMinIntervalMs`, `previewDefaultIntervalMs`, `previewMaxIntervalMs`; `UNSUPPORTED` when the engine lacks `preview`. |
| `packages/session-daemon/test/daemon.test.ts` 20-70                     | Fake engine gains `formatScreen` with a call counter and `capabilities.preview`.                                                                                                                                                                                                                |
| `packages/session-daemon/test/daemon.test.ts` (new)                     | Preview attach: first event is `preview`; no `output`; a burst of 50 writes within one interval yields one frame; twenty preview viewers on one record cause one `formatScreen` call per tick; `writeInput` refused; never holds size; on exit sees `exit` then `ended`.                        |
| `packages/session-daemon/test/hardening.test.ts` 127-206                | Slow-viewer test: a preview viewer on a blocked connection never triggers a resync and receives at most one pending frame when unblocked (with the slot design) or a bounded number (control-message form).                                                                                     |
| `packages/session/README.md`                                            | Describe `preview`: read-only, no size, text frames on change at a bounded interval, `exit` and `ended` only.                                                                                                                                                                                   |
| `examples/session-web/src/client.ts`, `index.html`                      | Optional: a preview strip for every listed session using `HTML` or `VT` text, to prove the consumer path; keep it small.                                                                                                                                                                        |
| `docs/session-library.md`                                               | Mention the representation and its limits.                                                                                                                                                                                                                                                      |

### Step 4: non-holding terminal clients (D)

| File                                          | Change                                                                                                                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/werk/src/main.ts` 97-124, 125-221   | Clipping renderer with clear-on-change and the status row; `--follow`, `--claim-size` wiring from step 2.                                                                        |
| `packages/werk/test/` (new, small)            | Extract `terminalRenderer` into a module so a unit test can feed a 160x50 frame into a 120x40 window and assert the emitted escape sequences never address row 41 or column 121. |
| `docs/session-library.md` "Run the consumers" | Two sentences on follow mode and the status row.                                                                                                                                 |

### Dependency on the stream scheduler rewrite

- `emit()`'s resync-per-control-event is the reason `size-holder`, `exit` and
  `effect` each cost a full snapshot per viewer. Step 1 avoids it by queueing
  directly; step 2's `claimSize` will pay it (two snapshots per claim) until the
  rewrite lands. Acceptable for now; note it in the README as a cost, not a
  contract.
- Step 3's per-attachment "latest preview" slot belongs in the rewrite's
  per-attachment lanes. If the rewrite lands first, build the slot there; if
  not, ship preview frames as control messages and migrate.
- The framing change (binary bytes instead of `{"$bytes":[...]}`), if the
  separate research recommends it, changes the snapshot columns of the cost
  table by roughly 3x in size and 10x in time; it does not change the
  recommendation that previews are text.

## Risks and open questions

Risks:

- **Contract change: the size can be free.** Any consumer assuming a holder
  exists whenever attachments exist (the fleet test's line 598, the browser
  status text) needs the "nobody holds" case. Small, but it is a protocol
  semantics change and the README must say so.
- **Allowlist hooks and `claim`.** A hook that only knows old actions refuses
  `claimSize`, so `werk attach` in a policy-gated deployment attaches without
  the size and clips. That is the safe failure; the CLI must not treat it as an
  error.
- **Resync cost of `size-holder` until the scheduler rewrite.** A claim on a
  session with a large scrollback costs about 80 ms of daemon JSON encoding and
  1.5 MB on the wire. Rare, but worth a note in the README.
- **`frame()` at 30 ms** is a client-side cost for every full attachment, not
  just tiles; it is outside this cluster but sets the ceiling on how many live
  replicas one browser can hold. Using ghostty's per-row dirty flags in
  `engine.ts` would likely cut it by an order of magnitude.
- **Formatter output shape.** `trim: true` drops trailing blanks and blank
  trailing rows, so a tile must pad to `size.rows`; the `VT` form includes
  `\x1b[0m` resets and 256-colour SGR that a naive ANSI-to-HTML helper must
  handle. Verify wide characters and grapheme clusters survive `VT` formatting.
- **Preview timer lifetime.** Timers must be cleared when the last preview
  viewer leaves and on record removal, or the daemon keeps ticking for dead
  sessions; `unref()` them like the checkpoint interval.
- **Ephemeral late attachments** never appear in `attachments`, so "nobody
  watched silently" is technically weakened for dead sessions by a few
  milliseconds. Probably fine; say so.

Open questions (for `04-open-questions.md` or the proposal):

- Should a read-only terminal attach on one's own daemon default to `if-free`
  rather than `never`? The lean above is `never` for consistency with sharing,
  but the solo-owner experience argues for `if-free` when the principal matches
  the session's creator. The authorize hook can express that; the default is
  the question.
- Should `claimSize` tell the old holder who took it (`by`)? Cheap and
  friendly; adds a `Principal` to an event that so far carries none.
- Is an `effect` worth carrying on the preview stream (bell, progress), or is
  the watch stream enough? Lean: watch stream is enough.
- Does the preview interval belong per attachment (requested, clamped) or only
  per daemon? Lean: requested per attachment, clamped, minimum across a
  record's viewers.
- Should `lost` records synthesise an `exit`? Lean: no.

## Effort

| Step                               | Hours    | Notes                                                                                                   |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| 1. Late attach, dead-record resize | 4 to 6   | Daemon 2, tests 2, docs and CLI 1. Unblocks the smoke test.                                             |
| 2. Size ownership                  | 12 to 16 | Types and client 2, daemon 5, tests 4, browser and CLI 2, docs 1.                                       |
| 3. Preview representation          | 14 to 20 | Engine 2, daemon 6 to 8 (less if built on the scheduler rewrite), client 1, tests 4, example 2, docs 1. |
| 4. Non-holding terminal clients    | 4 to 6   | CLI 3 to 4, unit test 1 to 2.                                                                           |
| Total                              | 34 to 48 | Sequential; steps 2 and 3 could overlap once step 2's `attach` changes are in.                          |
