# Replica paint performance

Research notes for `@werk/terminal`. Nothing here is decided; the
recommendation at the end is a lean.

Measurements were taken in Bun 1.3.14 on the WSL2 host. The machine was
shared with other agents' experiments throughout, and it rebooted part way
through the work. Numbers marked **(pre-reboot)** are transcribed from the
first session's output; numbers marked **(post-reboot)** were re-measured
afterwards under a one-process, two-terminal cap. Anything neither measured
nor transcribed is labelled as such.

## Summary

- `TerminalHandle.frame()` costs 9 / 24 / 50 ms at 80x24 / 120x40 / 200x50
  regardless of how much changed, because `cells()` makes 17k / 43k / 90k
  WASM calls per frame and allocates 79k / 197k / 410k typed-array views.
  Only 15 to 18 percent of that time is inside WASM; the rest is the
  marshalling layer in `abi.ts`. `JSON.stringify` diffing is a further 0.5 /
  1.1 / 2.0 ms.
- The ABI already offers everything needed to make this cheap: a persistent
  render state with global and per-row dirty flags, a one-call
  `CELLS_RAW` row view of packed `GhosttyCell` u64s, a bit layout for that
  u64 in `ghostty_type_json`, and a once-per-frame `COLORS` struct that
  replaces the per-cell `FG_COLOR`/`BG_COLOR` calls.
- A prototype using those paths produces frames identical to today's across
  170 checkpoints (styles, palette and truecolour, background-only erase,
  wide cells, graphemes, combining marks, scroll, alt screen, OSC 4, resize,
  viewport scroll, snapshot restore) at **0.013 ms** for one changed byte
  and **0.34 ms** for a whole-screen change at 120x40, against 24 ms today.
  An idle frame is 0.001 ms.
- One upstream gap: appending a combining mark or a lone ZWJ to an existing
  cell does not mark the row dirty on the pinned build, and the persistent
  render state re-copies only dirty rows. A ZWJ emoji sequence escapes the gap
  only incidentally, because the codepoint after the joiner lands in new cells
  and dirties the row that way. The prototype covers the gap by decoding the
  cursor row (and the one above) from a throwaway render state whenever a
  write produced no dirty rows; that path costs 0.02 to 0.05 ms. See
  [upstream-grapheme-dirty.md](upstream-grapheme-dirty.md) for the
  reproduction and for what is not established, including an appended U+FE0F
  that reports `FALSE` while changing nothing.
- `TerminalReplica` paints after every event. Coalescing to one paint per
  scheduler tick (rAF in browsers, `setTimeout(0)` elsewhere, injectable)
  turns a 50-chunk burst at 120x40 from 50 paints handing 1,951 rows to the
  renderer into 1 paint handing 40 rows. With today's engine that burst
  takes 1.04 s of main-thread time; with the prototype and coalescing it
  takes 0.2 ms.
- A resync could keep painting only rows that actually differ if the replica
  kept a shadow of the last painted rows, but the shadow does not survive a
  resync — the replica rebuilds the terminal and disposes the old one — so it
  would need a second full-grid copy taken on every paint. The restore itself
  (4.3 ms here, 10 to 20 ms once snapshots carry more scrollback) dominates
  either way. Not worth it; see "Snapshot and resync".

## Current state (file:line)

| Where                                                        | What happens                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/terminal/src/engine.ts:398-416` `frame()`          | Calls `cells()`, `JSON.stringify`s each row, compares with `previous[y]`, then makes three `terminal_get` calls for the cursor.                                                                                                                                                                                                                                                |
| `packages/terminal/src/engine.ts:417-509` `cells()`          | Creates a render state, row iterator and cells handle per call and frees them. Per cell: `row_cells_select`, `get RAW`, `write GhosttyStyle {}` + `get STYLE` + recursive `Abi.read` of the 72-byte struct, `get FG_COLOR`, `get BG_COLOR`, `get GRAPHEMES_LEN`, and for every cell with text a temporary alloc + `get GRAPHEMES_BUF` + free. Six to nine WASM calls per cell. |
| `packages/terminal/src/engine.ts:221,328`                    | `resize()` and `scrollViewport()` reset `previous`, so the next frame reports every row.                                                                                                                                                                                                                                                                                       |
| `packages/terminal/src/abi.ts:30-35`                         | `bytes()` and `view()` allocate a fresh `Uint8Array` and `DataView` on every access.                                                                                                                                                                                                                                                                                           |
| `packages/terminal/src/abi.ts:77-119` `read()`               | Generic struct reader: `Object.entries` over fields, recursion, and for tagged unions a linear `find` over the enum's values. Called once per cell for `GhosttyStyle`.                                                                                                                                                                                                         |
| `packages/terminal/src/replica.ts:36-78` `accept()`          | Applies the event and, at 76-77, calls `renderer.paint(terminal.frame())` unconditionally. Events are serialised through a promise chain (31-35), so a burst of N events is N frames.                                                                                                                                                                                          |
| `packages/terminal/src/dom/index.ts:71-81`                   | wterm adapter. Marks `frame.changed` rows dirty; wterm repaints only dirty rows plus the rows the cursor left and entered (`@wterm/dom/dist/renderer.js:549-557`).                                                                                                                                                                                                             |
| `packages/terminal-beamterm/src/index.ts:37-83`              | Merges changed rows into a shadow, then re-emits every cell of the grid into a batch and renders, on every paint.                                                                                                                                                                                                                                                              |
| `packages/werk/src/main.ts:97-122` `terminalRenderer()`      | Writes changed rows as ANSI to stdout on every paint.                                                                                                                                                                                                                                                                                                                          |
| `examples/session-web/src/client.ts:90-100`                  | `createTerminalReplica(engine, renderer)`; `attachment.onEvent` calls `replica.apply(event)` per event.                                                                                                                                                                                                                                                                        |
| `packages/terminal/test/engine.test.ts:73-115`               | Replica gap rules (stale events ignored, gaps rejected, resync recovers). Uses a replica with no renderer.                                                                                                                                                                                                                                                                     |
| `packages/session-daemon/test/hardening.test.ts:132,186,209` | Replicas without renderers.                                                                                                                                                                                                                                                                                                                                                    |
| `examples/session-web/test/browser.test.ts:71-153`           | Waits on `#screen` text content with `waitForFunction`; does not assume a paint happens synchronously after an event.                                                                                                                                                                                                                                                          |

## Profile

Instrumented copies of `abi.ts` and `engine.ts` counted calls and allocations
and timed the sections of `frame()`. Content was the measurement script's
fill (`"hello world \x1b[1mbold\x1b[0m "` repeated), then one `y` per frame.
**(pre-reboot)**

| Grid   | `frame()` | `cells()` | JSON diff | cursor | WASM calls | typed-array views | inside WASM   |
| ------ | --------- | --------- | --------- | ------ | ---------- | ----------------- | ------------- |
| 80x24  | 9.0 ms    | 8.5 ms    | 0.50 ms   | 0.02   | 17,173     | 78,607            | 2.5 ms (18 %) |
| 120x40 | 24.4 ms   | 23.2 ms   | 1.13 ms   | 0.02   | 43,125     | 196,719           | 4.3 ms (15 %) |
| 200x50 | 50.5 ms   | 48.4 ms   | 2.01 ms   | 0.03   | 89,585     | 409,579           | not timed     |

The "inside WASM" column comes from a run with a timer around every call;
the timers themselves inflated those runs to 13.9 and 28.4 ms, so the
percentage is the reliable part. Attribution at 120x40, then: roughly 4 ms
of WASM execution, 1 ms of `JSON.stringify`, and 18 to 19 ms of JS
marshalling: view allocation (197k per frame), the recursive `Abi.read` of
`GhosttyStyle` per cell, the temporary alloc/free pair per text cell, and
argument spreading through `call(name, ...args)`.

Caching the two views in `Abi` (recreate only when `memory.buffer` changes
identity, which happens on grow) took the same frames to 8.3 / 17.4 / 36.4 ms:
worth doing on its own, but a 25 percent gain against a 100x problem.

The cost is independent of what changed: idle frames and cursor-only frames
cost the same as whole-screen frames.

## ABI capabilities found

Dumped from `ghostty_type_json` on the pinned build
(`ghostty-3c1ef5b32fc5ea6b93d28493fabf193f595139cf`), with semantics from the
vendored header
`packages/werk-poc/vendor/ghostty-vt/3c1ef5b.../include/ghostty/vt/render.h`.

Render state (`GhosttyRenderStateData`): `COLS`, `ROWS`, `DIRTY`
(`GhosttyRenderStateDirty`: FALSE / PARTIAL / FULL), `ROW_ITERATOR`,
`COLOR_BACKGROUND`, `COLOR_FOREGROUND`, `COLOR_CURSOR`, `COLOR_PALETTE`,
`CURSOR_*` fields, `CURSOR` (a 20-byte `GhosttyRenderStateCursor` with
viewport x/y, `viewport_has_value`, `wide_tail`, `visible`, `blinking`,
`password_input`, `visual_style`), and `COLORS` (a 784-byte struct with
background, foreground, cursor and the 256-entry palette). Options:
`GhosttyRenderStateOption.DIRTY` (set). Functions: `update`, `begin_update` /
`end_update`, `clean`, `get_multi`, `set`.

Row (`GhosttyRenderStateRowData`): `DIRTY` (bool), `RAW` (`GhosttyRow` u64),
`CELLS` (populate a pre-allocated cells handle), `SELECTION`, and `CELLS_RAW`
(a borrowed `GhosttyCellsView {ptr, len}` over the row's packed cells,
documented as "the bulk alternative to iterating cells one at a time ... for
WebAssembly embedders"). `row_iterator_next_dirty(iter, out_y)` skips clean
rows in a PARTIAL frame and returns every row in a FULL one. Option
`GhosttyRenderStateRowOption.DIRTY` (set).

Cell (`GhosttyRenderStateRowCellsData`): `RAW`, `STYLE`, `GRAPHEMES_LEN`,
`GRAPHEMES_BUF`, `BG_COLOR`, `FG_COLOR`, `SELECTED`, `HAS_STYLING`,
`GRAPHEMES_UTF8`; `row_cells_next`, `row_cells_select`, `row_cells_get_multi`.

`GhosttyCell` is a packed u64: `content_tag` (bits 0-1: CODEPOINT,
CODEPOINT_GRAPHEME, BG_COLOR_PALETTE, BG_COLOR_RGB), `content` (bits 2-25: a
21-bit codepoint, an 8-bit palette index, or r/g/b bytes, by tag), `style_id`
(bits 26-41), `wide` (bits 42-43: NARROW, WIDE, SPACER_TAIL, SPACER_HEAD),
`protected`, `hyperlink`, `semantic_content`. The header says bit positions
are not ABI-stable and must be read from the manifest, which the prototype
does.

`GhosttyStyle` is 72 bytes: `fg_color`, `bg_color`, `underline_color` (each a
tag NONE / PALETTE / RGB plus a value), bold, italic, faint, blink, inverse,
invisible, strikethrough, overline, and `underline` (i32). The header for
`FG_COLOR` says it resolves palette indices through the palette and does not
apply bold-as-bright; `BG_COLOR` flattens the content-tag background and the
style background. Resolving in JS from `STYLE` plus `COLORS` reproduced both
exactly (see the equivalence run).

What the dirty flags report, on a 20x5 terminal **(pre-reboot, matches the
POC's `findings/m1.md` table)**:

| After                                         | `DIRTY`                          |
| --------------------------------------------- | -------------------------------- |
| first update of a new render state            | FULL                             |
| a write on one row                            | PARTIAL, that row                |
| CUP alone                                     | PARTIAL, old and new cursor rows |
| cursor hide, SGR alone, title                 | FALSE                            |
| line feed that scrolls                        | FULL                             |
| `CSI 2 J`, alt screen on or off               | FULL                             |
| OSC 4 palette change                          | FULL                             |
| resize                                        | FULL                             |
| `scrollViewport`                              | FULL                             |
| a fresh render state on a restored terminal   | FULL                             |
| combining mark or lone ZWJ appended to a cell | **FALSE** (see Risks)            |

Two points from the header matter for the design. `update` "consumes
terminal/screen dirty state", so there can be only one render state per
terminal that expects to see dirty flags; `readScreen`, `readSelection` and
`snapshot` go through the formatter and encoder and do not interfere. And
`update` does not clear flags; the caller must call `clean` after a complete
frame.

Also present and unused: `ghostty_row_get` / `ghostty_row_get_multi` on the
`GhosttyRow` u64 (`WRAP`, `WRAP_CONTINUATION`, `GRAPHEME`, `STYLED`,
`HYPERLINK`, `SEMANTIC_PROMPT`, `DIRTY`).

## Prototype results

The prototype (`scratchpad/perf/engine-fast.ts`) keeps one render state,
row iterator and cells handle per terminal plus a 1 KiB scratch buffer;
reads `DIRTY` after `update`; on FULL walks every row, on PARTIAL walks
rows and reads each row's `DIRTY` flag, on FALSE walks nothing; reads
`COLORS` once per decoded frame; reads each decoded row through `CELLS_RAW`
and decodes the u64s in JS; reads `STYLE` only for cells with a non-zero
`style_id`, cached per row by id; reads graphemes only for
CODEPOINT_GRAPHEME cells; compares each decoded row field by field against a
shadow of `Cell[]` and reports only rows that differ; and calls `clean`.
After any write, if the walk did not deliver the cursor row and the row
above, it decodes those two from a throwaway render state. `resize` and
`scrollViewport` force the next frame to walk every row. It uses a
view-caching `Abi`.

Equivalence **(post-reboot)**: against the current engine on a 12x8 grid,
25 scripts and 170 checkpoints (every step, two resizes, viewport top and
bottom, and a snapshot restore) produced identical screens and cursors. The
current engine reported 1,055 changed rows over those checkpoints; the
prototype reported 635, the difference being rows the current engine
re-reports after `resize`/`scrollViewport` wipe its diff.

Per-frame cost, frame only, mean of 30 frames (10 for whole screen):

| Case             | Grid   | Today (pre-reboot) | Today + cached views (pre-reboot) | Prototype (pre-reboot) | Prototype with fallback (post-reboot) |
| ---------------- | ------ | ------------------ | --------------------------------- | ---------------------- | ------------------------------------- |
| one byte         | 80x24  | 8.98 ms            | 8.34 ms                           | 0.026 ms               | 0.011 ms                              |
|                  | 120x40 | 24.36 ms           | 17.43 ms                          | 0.017 ms               | 0.013 ms                              |
|                  | 200x50 | 50.48 ms           | 36.38 ms                          | 0.013 ms               | 0.024 ms                              |
| one byte via CUP | 80x24  | 8.62 ms            | 6.44 ms                           | 0.015 ms               | 0.015 ms                              |
|                  | 120x40 | 22.99 ms           | 16.73 ms                          | 0.019 ms               | 0.016 ms                              |
|                  | 200x50 | 46.17 ms           | 34.38 ms                          | 0.024 ms               | 0.023 ms                              |
| whole screen     | 80x24  | 8.73 ms            | 6.44 ms                           | 0.088 ms               | 0.232 ms                              |
|                  | 120x40 | 22.85 ms           | 17.74 ms                          | 0.189 ms               | 0.340 ms                              |
|                  | 200x50 | 48.05 ms           | 36.18 ms                          | 0.551 ms               | 0.651 ms                              |
| scroll one line  | 80x24  | 9.95 ms            | 6.45 ms                           | 0.072 ms               | not re-measured                       |
|                  | 120x40 | 22.61 ms           | 16.02 ms                          | 0.180 ms               | not re-measured                       |
|                  | 200x50 | 46.13 ms           | 32.44 ms                          | 0.369 ms               | not re-measured                       |
| cursor move only | 80x24  | 9.31 ms            | 6.76 ms                           | 0.019 ms               | 0.026 ms                              |
|                  | 120x40 | 23.24 ms           | 17.22 ms                          | 0.014 ms               | 0.016 ms                              |
|                  | 200x50 | 48.88 ms           | 42.55 ms                          | 0.029 ms               | 0.029 ms                              |
| idle             | 80x24  | 9.01 ms            | 6.34 ms                           | 0.001 ms               | 0.001 ms                              |
|                  | 120x40 | 23.49 ms           | 16.34 ms                          | 0.001 ms               | 0.001 ms                              |
|                  | 200x50 | 46.70 ms           | 33.95 ms                          | 0.001 ms               | 0.002 ms                              |

Fallback-only cases **(post-reboot)**, 120x40: an SGR-only write (no dirty
rows, cursor row re-read from a throwaway state) 0.018 ms; a combining-mark
append 0.027 ms (0.049 ms at 80x24, 0.028 ms at 200x50).

WASM calls per frame drop from 43,125 to about 23 (one byte) and 218 (whole
screen) at 120x40; typed-array views from 196,719 to 30 and 498
**(pre-reboot)**. The whole-screen case is dominated by JS object creation
(4,800 `Cell` objects) and the per-row `STYLE` read for the bold run in the
fill; both post-reboot whole-screen numbers were taken while another agent's
experiments were running, which probably explains the spread against the
pre-reboot figures.

Memory **(pre-reboot)**: WASM memory reached 30 pages (1.97 MB) after the
first full frame at 120x40 for both today's engine and the prototype (a
freed render state does not shrink the heap), so the persistent state costs
nothing extra there. JS heap per instance: today's engine holds 338 KB of
row JSON strings; the reading for the prototype's `Cell[][]` shadow came out
as 0 KB, which is a GC artefact and not a measurement. Arithmetic says 4,800
small objects at roughly 80 to 120 bytes each is 0.4 to 0.6 MB per 120x40
instance; this is an estimate, not a measurement.

The DOM renderer's own paint cost was not measured (no browser in the
post-reboot cap). From `@wterm/dom/dist/renderer.js:266-444`, a dirty row is
rebuilt as an HTML string of styled spans (runs of equal style are merged)
and assigned to `rowEl.innerHTML`, and row backgrounds are set only when they
change. Cost is therefore one string build plus one `innerHTML` parse per
changed row, plus the browser's layout and paint; a 40-row repaint is
probably in the low milliseconds but that is untested.

## Coalescing design

The lean: `TerminalReplica` keeps applying events immediately and
`apply()` keeps resolving or rejecting per event, so gap errors and decode
errors are observed exactly as today; but the paint is requested, not
performed, and at most one paint runs per scheduler tick.

```ts
export type PaintScheduler = (paint: () => void) => void;
export interface ReplicaOptions {
  schedulePaint?: PaintScheduler;
}
const defaultScheduler: PaintScheduler =
  typeof requestAnimationFrame === "function"
    ? (paint) => requestAnimationFrame(() => paint())
    : (paint) => setTimeout(paint, 0);

class TerminalReplica {
  private paintPending = false;
  private paintScheduled = false;
  constructor(factory, renderer?, options: ReplicaOptions = {}) {
    this.schedule = options.schedulePaint ?? defaultScheduler;
  }
  private async accept(e) {
    // ... unchanged gap rules, restore, write, resize ...
    this.position = e.position;
    if (this.terminal && this.renderer) this.requestPaint();
  }
  private requestPaint() {
    this.paintPending = true;
    if (this.paintScheduled) return;
    this.paintScheduled = true;
    this.schedule(() => {
      this.paintScheduled = false;
      this.flush();
    });
  }
  /** Paint now if anything is pending; tests and synchronous callers use this. */
  flush() {
    if (!this.paintPending || this.closed || !this.terminal || !this.renderer)
      return;
    this.paintPending = false;
    this.renderer.paint(this.terminal.frame());
  }
  dispose() {
    this.closed = true;
    this.paintPending = false; // a scheduled callback finds nothing to do
    // ...
  }
}
```

Two details matter. `queueMicrotask` is the wrong default: `apply()` chains
events through promises, so each `accept` is its own microtask and a
microtask paint queued during the first runs before the second, coalescing
nothing. A macrotask (`setTimeout(0)`) or `requestAnimationFrame` runs after
every event of a burst that arrived in the same turn. The feature-detected
default keeps the core runtime-free; the option lets tests pass a manual
scheduler and lets the CLI pass `setImmediate` if it prefers.

Measured with the prototype replica **(post-reboot)**, 50 output events of
115 bytes applied in one tick at 120x40:

| Engine    | Paint policy | Paints | Rows handed to renderer | Time until all applies settled  |
| --------- | ------------ | ------ | ----------------------- | ------------------------------- |
| today's   | per event    | 50     | 1,951                   | 1,038 ms                        |
| today's   | one per tick | 1      | 40                      | 0.26 ms (+ 24 ms in the paint)  |
| prototype | per event    | 50     | 1,951                   | 11.3 ms                         |
| prototype | one per tick | 1      | 40                      | 0.19 ms (+ 0.3 ms in the paint) |

So the two changes are independent and both worth having: coalescing bounds
the paint rate to the scheduler's (60 per second under rAF), the engine
change bounds the cost of each paint.

Consumers:

- The DOM renderer needs no change. It already repaints only `changed` rows
  plus the cursor's old and new rows.
- The CLI renderer needs no change to stay correct. Coalescing means fewer
  `stdout` writes and each carries only rows that differ, which also
  removes the flicker of re-emitting every row after a resize.
- The beamterm renderer probably wants to emit only `frame.changed` rows
  plus the cursor's old and new cells into the batch instead of the whole
  grid, if beamterm's batch keeps cells it is not given (its README and
  typings were not checked in this session; this is untested). If it does
  not, it can stay as it is: with coalescing it repaints at most once per
  animation frame.
- Anything that wants a synchronous screen after `await replica.apply(e)`
  (none of the existing tests do; they read `readScreen()`, which goes to
  the terminal) can call `flush()`.

## Snapshot and resync

Today a resync creates a new `Terminal`, whose `previous` is empty, so the
first frame after it reports every row and the renderer repaints the whole
grid even if nothing changed. With the prototype the first frame of a fresh
terminal is a FULL walk (0.23 ms at 120x40 **(post-reboot)**) and reports
every row, which is right for `TerminalHandle.frame()` on its own.

The replica could keep a shadow of the rows it last handed to the renderer
and, on the first paint after a restore, drop rows equal to the shadow
before painting. Measured **(post-reboot)** at 120x40: snapshot 7,006 bytes
in 0.18 ms, restore 4.3 ms, first frame 0.23 ms, and a naive
`JSON.stringify` compare of 40 rows against the shadow 1.7 to 2.1 ms with 0
rows differing. A field compare like the engine's `same()` would be an
order of magnitude cheaper. Either way the restore dominates.

The filter is not worth its complexity as things stand. The replica's shadow
does not survive a resync at all — it rebuilds the terminal through
`factory.restore` and disposes the old one — so the filter would need a second
full-grid shadow, deep-copied on every paint, to have anything to compare
against. What it would buy is one avoidable full repaint per resync, in a case
note 02's ordered stream already makes rare. An alternative that avoids the
shadow copy is to let `frame()` accept the previous terminal's shadow
(`terminal.adoptShadow(old)`), but that widens `TerminalHandle` for one caller
and is not obviously better.

## Implementation plan

Ordered so that each step ships on its own and the tests stay green
throughout.

1. **`packages/terminal/src/abi.ts`: cache the views.** Keep `buffer`,
   `Uint8Array` and `DataView` on the instance and recreate them when
   `memory.buffer` changes identity. Also add small typed helpers used by
   step 2 (`u32(p)`, `u8(p)`, `setU32(p, v)`) so hot paths avoid the generic
   `read`/`write`. Tests: existing `packages/terminal/test/engine.test.ts`.
   About 0.5 h.

2. **`packages/terminal/src/engine.ts`: rebuild `frame()` on the prototype.**
   Persistent render state, row iterator, cells handle and scratch buffer
   created in the constructor and freed in `dispose()`; a `layout()` helper
   that reads bit positions, struct offsets and enum values from
   `a.types` once per instance; `shadow: Cell[][]` replacing
   `previous: string[]`; `forceFull` set by `resize()` and
   `scrollViewport()`; the write flag and throwaway-state fallback for the
   cursor rows. Delete `cells()`. Add tests to `engine.test.ts`:
   - an idle frame reports no rows; a cursor move reports no rows but a new
     cursor;
   - one write reports exactly the rows it touched;
   - a combining mark written on its own after the base character appears
     in the next frame (this is the upstream gap);
   - background-only erase carries the colour; palette, bright palette,
     256-colour and truecolour fg and bg resolve; OSC 4 recolours existing
     cells on the next frame;
   - wide cells report width 2 and a width-0 tail; a ZWJ emoji is one cell;
   - after `resize` and after `scrollViewport` every row is reported;
   - a restored terminal's first frame reports every row and its second
     reports none;
   - `dispose()` twice is safe.
     Keep the existing test at lines 8-38, which reads `r.frame().changed[0]`
     on a fresh terminal, unchanged. About 4 to 6 h including tests.

3. **`packages/terminal/src/replica.ts`: coalesce paints.** `ReplicaOptions`
   with `schedulePaint`, `requestPaint()`, `flush()`, the feature-detected
   default, and `createTerminalReplica(factory, renderer?, options?)`.
   `apply()` semantics unchanged, so the replica test at
   `engine.test.ts:73-115` passes as is (it has no renderer). Add a test
   with a counting renderer and a manual scheduler: three applies in one
   tick schedule once and paint nothing until the scheduler fires; the
   paint carries only rows that differ; a rejected event does not paint;
   `dispose()` before the scheduler fires paints nothing. Update
   `packages/terminal/README.md` (lines 14-19 describe the replica). About
   1.5 h.

4. **Consumers.** `packages/werk/src/main.ts:127-130` and
   `examples/session-web/src/client.ts:90` need no code change for
   correctness; passing an explicit scheduler is optional. Re-run
   `bun run test:browser` (`examples/session-web/test/browser.test.ts`
   waits on DOM text, so rAF pacing is fine) and the CLI attach path by
   hand. About 0.5 h.

5. **`packages/terminal-beamterm/src/index.ts`**, optional: emit only changed
   rows and the cursor's old and new cells, after confirming beamterm keeps
   cells it is not given in a batch. About 1 to 2 h including the check.

6. **Resync shadow filter in the replica**, optional and probably later:
   keep the last painted rows, filter the first frame after a restore.
   Test: a resync with identical content paints no rows; with one changed
   row paints one. About 1 h.

7. **Upstream note.** Report the grapheme-append dirty gap against
   libghostty-vt at the pinned commit, with the 12x8 reproduction from the
   equivalence script. About 0.5 h.

## Risks and open questions

- **Dirty tracking is upstream's, and it has at least one gap.** The
  combining-mark and ZWJ case is covered by the fallback, but any other
  content change that does not dirty its row would be missed until the row
  is next dirtied. Nothing else showed up across the 25 scripts (insert and
  delete characters and lines, scroll regions, tabs and backspace, alt
  screen, hyperlinks, underline colours, OSC 4/10/11), which is evidence,
  not proof. A cheap belt-and-braces option is to walk every row and read
  its `DIRTY` flag even on FALSE frames (about 40 to 50 extra calls); a
  heavier one is to skip dirty flags entirely and use a fresh render state
  with the bulk decode every frame, which is the "whole screen" column
  (0.2 to 0.65 ms at 120x40, so still 50 to 100 times cheaper than today
  and enough for a handful of attached terminals with coalescing). The
  choice probably wants to be made by whoever owns step 2; the prototype's
  path is the fast one and the equivalence script is the guard.
- **One render state per terminal.** `update` consumes terminal dirty
  flags, so a second render state on the same terminal would see nothing.
  Nothing else in `engine.ts` creates one today; this needs a comment on the
  field so nobody adds a diagnostic that does.
- **Style ids are page-local.** The prototype caches `STYLE` by `style_id`
  per row only, because the viewport may span two pages. Caching across rows
  would save little and risk wrong colours after a scroll.
- **Bit positions are read from the manifest**, as the header asks, so a
  libghostty upgrade that moves them keeps working; a change of field
  names would fail loudly at construction. `ENGINE_BUILD` pins the build
  anyway.
- **`Frame` semantics stay the same but report fewer rows.** Today's engine
  reports every row after `resize` and `scrollViewport`; the prototype
  reports only rows that differ from its shadow. Renderers that assumed a
  full repaint on resize (the DOM adapter calls `renderer.setup` on a size
  change and then relies on `changed`) get every row anyway because the
  shadow is cleared on resize.
- **The cursor comes from `terminal_get`, not the render state**, to keep
  today's semantics (active-screen coordinates even while the viewport is
  scrolled). Reading `CURSOR` from the render state would give
  viewport-relative coordinates and a `viewport_has_value` flag, which is
  probably what renderers actually want; that is a separate, small
  behaviour change and was not measured.
- **Paint pacing changes observable timing.** Anything that awaited
  `apply()` and then inspected the renderer synchronously would see no
  paint yet. No such caller exists in the repo; `flush()` covers new ones.
- **Shadow memory.** Roughly half a megabyte of JS objects per 120x40
  replica (estimated, not measured). Fine for a handful of attached
  terminals; if it ever matters the shadow can be packed into typed arrays.
- **Measurements were noisy.** The machine was shared and rebooted; the
  ratios are robust, the third significant figure is not.

## Effort

| Step                                       | Hours      |
| ------------------------------------------ | ---------- |
| 1. `abi.ts` cached views and typed helpers | 0.5        |
| 2. `engine.ts` frame rebuild and tests     | 4 to 6     |
| 3. `replica.ts` coalescing and tests       | 1.5        |
| 4. Consumers and browser test run          | 0.5        |
| 5. beamterm changed-rows batch (optional)  | 1 to 2     |
| 6. Resync shadow filter (optional, later)  | 1          |
| 7. Upstream report                         | 0.5        |
| Total for 1 to 4                           | 6.5 to 8.5 |

Scratch material: `scratchpad/perf/engine-fast.ts` (the prototype),
`scratchpad/perf/abi-cached.ts`, `scratchpad/perf/replica-coalesce.ts`,
`scratchpad/perf/verify.ts` (equivalence, timings, resync and burst in one
bounded run; output in `verify-out2.txt`).
