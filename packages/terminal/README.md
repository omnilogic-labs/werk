# @werk/terminal

Interpret terminal output and rebuild the resulting screen anywhere. The package
carries a pinned Ghostty WASM build, a snapshot format for a screen, and a
**replica**: a client-side copy of a session's screen, rebuilt from snapshot
bytes and attachment events, with no process behind it.

This is a private workspace package. Depend on it as `"@werk/terminal":
"workspace:*"` and import from `@werk/terminal`, `@werk/terminal/bun` or
`@werk/terminal/dom`. Build it with `bun run build`.

## Rebuilding a screen from a snapshot

This runs under Bun as written. In a real consumer the snapshot bytes and the
output events arrive from a session rather than from a terminal made locally.

```ts
import { createTerminalReplica, type Frame } from "@werk/terminal";
import { loadTerminalEngine } from "@werk/terminal/bun";

// An engine factory: one compiled WASM module, one WASM instance per terminal.
const engine = await loadTerminalEngine();

// A renderer paints frames. `@werk/terminal/dom` has a real one; this is the
// smallest thing that satisfies the interface.
const renderer = {
  paint: (frame: Frame) => console.log("painted", frame.changed.length, "rows"),
  dispose: () => {},
};

const replica = createTerminalReplica(engine, renderer);

// A session owner would send these. Here one terminal is made locally to
// produce them.
const source = await engine.create({ cols: 80, rows: 24 });
source.write(new TextEncoder().encode("hello"));
const snapshot = source.snapshot();

await replica.apply({
  type: "snapshot",
  attachmentId: "a1",
  generation: 0,
  position: 0,
  size: snapshot.size,
  snapshot: snapshot.bytes,
  engineBuildId: snapshot.engineBuild,
  snapshotFormatVersion: snapshot.formatVersion,
});
await replica.apply({
  type: "output",
  attachmentId: "a1",
  generation: 0,
  position: 1,
  data: new TextEncoder().encode(" world"),
});

replica.flush(); // paint now rather than on the next scheduler tick
console.log(replica.readScreen().trimEnd()); // "hello world"
replica.dispose();
source.dispose();
```

In a browser, replace the stub renderer with the bundled one and mount it:

```ts
import { createWtermRenderer } from "@werk/terminal/dom";
import { roles } from "@werk/palette";

const renderer = await createWtermRenderer({
  mount: document.getElementById("terminal")!,
  theme: roles("mocha", "mauve"),
});
const replica = createTerminalReplica(engine, renderer);
```

## What this package exports

| Export                                               | Entry                | What it is                                                              |
| ---------------------------------------------------- | -------------------- | ----------------------------------------------------------------------- |
| `createTerminalEngine(source)`                       | `@werk/terminal`     | Compile WASM once, return a `TerminalEngineFactory`                     |
| `createTerminalReplica(engine, renderer?, options?)` | `@werk/terminal`     | Return a `TerminalReplica` that applies events to a screen              |
| `TerminalReplica`                                    | `@werk/terminal`     | The replica class, if a consumer would rather construct it              |
| `defaultScheduler`                                   | `@werk/terminal`     | `requestAnimationFrame` where there is one, `setTimeout(0)` otherwise   |
| `createColourReader(source)`                         | `@werk/terminal`     | Parse Ghostty's colour syntax without building a terminal               |
| `ENGINE_BUILD`, `SNAPSHOT_FORMAT_VERSION`            | `@werk/terminal`     | The pinned build identity and the snapshot format number                |
| `validateSize(size)`                                 | `@werk/terminal`     | Throw `RangeError` for a grid this engine will not take                 |
| `encodeKey(key, applicationCursor?)`                 | `@werk/terminal`     | Encode one key name as the bytes a PTY expects                          |
| `encodePaste(text, bracketed?)`                      | `@werk/terminal`     | Encode pasted text, optionally bracketed                                |
| `UnsupportedSnapshotError`                           | `@werk/terminal`     | Thrown when a snapshot's build or format does not match                 |
| `loadTerminalEngine()`                               | `@werk/terminal/bun` | `createTerminalEngine` over the pinned asset, through Bun's file loader |
| `loadTerminalColours()`                              | `@werk/terminal/bun` | `createColourReader` over the same asset                                |
| `terminalWasmBytes()`                                | `@werk/terminal/bun` | The pinned WASM as a `Uint8Array`                                       |
| `createWtermRenderer(host)`                          | `@werk/terminal/dom` | The bundled DOM renderer, a `RendererFactory`                           |

The types are in `src/types.ts`: `Size`, `Cell`, `Frame`, `Renderer`,
`RendererHost`, `RendererFactory`, `TerminalHandle`, `TerminalEngineFactory`,
`TerminalOptions`, `TerminalCapabilities`, `SnapshotEnvelope`, `TerminalEffect`,
`InputModes`, `Viewport`, `Scrollback` and `Selection`. `ReplicaEvent`,
`ReplicaOptions` and `PaintScheduler` are in `src/replica.ts`, and `Rgb` and
`ColourReader` in `src/colour.ts`.

## Making an engine

`createTerminalEngine(source)` takes a `Uint8Array`, an `ArrayBuffer` or a
`WebAssembly.Module`. It compiles the module once and allocates an independent
WASM instance for every terminal it then creates or restores, so one session
cannot corrupt another's memory.

`loadTerminalEngine()` from `@werk/terminal/bun` does the same over the pinned
asset in `assets/terminal.wasm`, loaded through Bun's file loader, including
when compiled into an executable.

The factory carries its build identity (`buildId`), its snapshot version
(`snapshotFormatVersion`) and a `capabilities` object saying which optional
operations this build supports. `create(size, options?)` and
`restore(envelope, options?)` both resolve to an owned `TerminalHandle`;
`dispose()` on that handle is idempotent.

Dimensions and snapshot input are bounded. `validateSize` requires whole
`cols` and `rows` from 1 to 1,000 with at most 250,000 cells between them.
`restore` refuses a snapshot over 64 MiB, and decodes at most 1 MiB of retained
parser continuation.

`write(bytes)` returns any `TerminalEffect` values the bytes produced. An
effect with `kind: "reply"` carries a byte-array payload that must be written
back into the PTY by whoever owns it. A consumer must never render a reply
effect.

`createColourReader(source)` is a reader for Ghostty's colour syntax, over the
same WASM artefact but with no terminal behind it. That syntax is what a
terminal answers `OSC 11` in. It needs no grid, no size and no snapshot, so a
caller that only wants to know what colour a terminal is does not build a
terminal to find out. `parse(value)` returns an `Rgb` of three eight-bit
channels, or `undefined` when the text names no colour. `loadTerminalColours()`
from `@werk/terminal/bun` is the same thing over the pinned asset, and the
CLI's theme probe in `packages/werk/src/main.ts` is its only caller today.

## Making a replica

`createTerminalReplica(engineFactory, renderer?, options?)` takes a
`TerminalEngineFactory` and an optional `Renderer`. Those two types are not the
same thing and are easy to confuse. `createWtermRenderer` is a
`RendererFactory`: call it with `{ mount, theme? }` and await the `Renderer` it
resolves to, then pass that `Renderer` here.

**Ordering and gaps.** `apply(event)` serialises events. A stale generation or
a duplicate position is ignored. A gap in stream positions throws, and only a
`snapshot` or `resync` event can re-establish state after one. Both of those
replace the terminal atomically, so a failed restore leaves the previous screen
in place.

**Painting and scheduling.** An applied event updates the terminal immediately.
Renderer paints are coalesced to at most one per scheduler tick:
`requestAnimationFrame` in browsers and `setTimeout(0)` elsewhere.
`options.schedulePaint(callback)` injects a different scheduler and may return
a cancellation function. Avoid a microtask scheduler: it paints between
serialised events, which defeats the coalescing that makes a burst cheap.
`frame()` walks only the rows the engine's render state reports dirty, so an
idle or one-cell frame costs a fraction of a millisecond at any grid size.

**Flushing.** After awaiting `apply()`, call `flush()` to paint pending state
synchronously. An `ended` event flushes before its `apply()` resolves, so a
consumer can dispose immediately without losing the final output.

**Disposal.** `dispose()` cancels pending work and disposes the terminal and the
renderer. Callbacks that were already scheduled do nothing.

**Errors.** Await `apply(event)` to observe decoding errors. A paint that fails
inside the scheduler is retained and rethrown by the next `flush()` or
`apply()` after its event is applied, which leaves the replica able to go on
processing events. A paint that fails inside an explicit `flush()` propagates
from that call.

## Renderers

A `Renderer` has `paint(frame)` and `dispose()`. `Frame` carries the grid size,
the rows whose cells changed, and the cursor position and visibility. The core
has no DOM, runtime or session dependency, so a renderer can paint into
anything.

`@werk/terminal/dom` exports `createWtermRenderer`, backed by pinned Apache-2.0
`@wterm/dom` and `@wterm/core` 0.4.1. Both include their upstream licences.
`createWtermRenderer({ mount, theme })` takes an `HTMLElement` to mount into and
an optional `Roles` object from `@werk/palette`; omitting `theme` paints in
werk's default flavour, Mocha with a mauve accent.

`@werk/terminal-beamterm` is a second renderer of the same type, over WebGL2. It
exists to prove that the `Frame` / `Renderer` / `RendererFactory` interface in
`src/types.ts` is sufficient for a renderer written against nothing else.

## Input modes, viewport and selection

`inputModes()` queries application cursor and keypad mode, bracketed paste,
focus events, mouse tracking and kitty keyboard state from the engine,
including for a restored snapshot. `encodeKey` and `encodePaste` take the
cursor and paste modes that query reports.

`viewport()` reports the scrollback position. `scrollViewport(delta)` moves by a
number of rows or to `"top"` or `"bottom"`. `readSelection(selection)` uses
inclusive cell coordinates relative to the visible viewport and preserves wide
graphemes.

Snapshot bytes carry parser continuation and retained history. Recovering a
screen does not recover a process.

## Scrollback

`TerminalOptions.scrollbackBytes` sets the page-memory budget, on `create` or,
after all history has been decoded, on `restore`. `scrollback()` reports
`{ maxBytes, rows }` and `capabilities.scrollbackLimit` advertises support.

| Fact                  | Value                                                                     |
| --------------------- | ------------------------------------------------------------------------- |
| Accepted range        | Integers from 0 to 4,294,967,295                                          |
| 0                     | History disabled                                                          |
| 4,294,967,295         | The pinned engine's unlimited sentinel; `scrollback().maxBytes` is `null` |
| Other non-zero values | Minimum two pages, about 0.9 MB                                           |
| Retention granularity | Roughly 450 KB steps, about 450 rows at 120 columns                       |
| Omitted on `create`   | The upstream default of 10,000 bytes                                      |
| Omitted on `restore`  | The limit stored in the snapshot                                          |
| Lowered on `restore`  | Oldest pages pruned immediately                                           |
| Raised on `restore`   | Future growth permitted                                                   |

Bytes measure page memory, not text size.

## A restored wrapped line can reflow differently

The pinned engine can reflow a restored long wrapped line differently after
subsequent output and a resize. Session owners therefore send authoritative
state after resizing, and replicas must apply that resynchronisation before
later output. A resize-only replay is insufficient for this engine build.

## Formatting a screen

`formatScreen("plain" | "vt" | "html")` formats the active screen, whatever the
viewport is scrolled to, and does not consume frame dirtiness.
`capabilities.preview` advertises this formatter.

- `plain` equals `readScreen()`.
- `vt` retains styles and graphemes.
- `html` escapes the text and adds style markup.

VT output is a formatted fragment with LF line separators. A consumer replaying
it into a terminal should position the cursor, clear the previous screen and
translate LF to CRLF as needed. It encodes no cursor position and no other
terminal state.
