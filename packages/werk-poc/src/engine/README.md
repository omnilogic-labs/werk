# engine

The terminal engine seam and its adapters.

| Path            | What it is                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`      | `VtEngine` / `VtTerminal` from the proposal, §5, with `Unsupported`, `Cell`, `Row`, `Frame`, `Effect`, `KeyEvent`, `MouseEvent`, `TerminalModes` and co |
| `registry.ts`   | Adapters register by id; `getEngine(id)` constructs one lazily                                                                                          |
| `caps.ts`       | `capabilityMatrix(engines)`: the §5 matrix as a markdown table read off each engine's `caps`; `wp caps` prints it                                       |
| `all.ts`        | Imports every adapter's registry entry: `wp caps`, `wp bench diff` and the daemon use it                                                                |
| `ghostty-wasm/` | The adapter over upstream's freestanding WASM build (M1)                                                                                                |
| `ghostty-ffi/`  | The adapter over `libghostty-vt` (`prime-radiant-inc/ts-libghostty`), a prebuilt libghostty reached through `bun:ffi` (M6)                              |
| `xterm-oracle/` | Headless xterm.js 6 behind the seam, for the differential corpus only (M6)                                                                              |

## `ghostty-wasm/`

| File          | What it is                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layout.ts`   | Parses `ghostty_type_json()` into a `Layout`: sizes, alignments, struct fields and offsets, enum values, the packed `GhosttyCell` descriptor and a decoder compiled from it. No WASM dependency                                       |
| `loader.ts`   | `GhosttyModule`: instantiates the module, marshals through the layout. `alloc`/`free`, `allocType`, `read`/`write` for scalars, structs, arrays and tagged unions, `withOpaque`, `check`, `hostFunction` for C callbacks. No Bun APIs |
| `bytes.ts`    | Bun only: the pinned artifact's bytes via `import ... with { type: "file" }`, which `bun build --compile` embeds                                                                                                                      |
| `encoders.ts` | `KeyEncoder` / `MouseEncoder` over libghostty's encoders: configured from the seam's `TerminalModes` or synced from a terminal handle, one reusable event each. No Bun APIs                                                           |
| `index.ts`    | `GhosttyWasmEngine` / `GhosttyWasmTerminal` / `GhosttyWasmDecodedState`: the seam over the loader, including the render consumer and `modes()`                                                                                        |
| `bun.ts`      | `loadGhosttyWasmEngine()` and the registry entry                                                                                                                                                                                      |
| `*.test.ts`   | Loader, terminal, reattach (emitVt, effects, snapshot), encoders and render-consumer tests; `spikes/m1/embedded.test.ts` covers the compiled binary                                                                                   |

### The adapter's surface

Beyond the seam, `GhosttyWasmTerminal` exposes `size`, `cursor()`,
`viewport()`, `modes()`, `decMode(n)`, `getNumber(data)`, `getString(data)`,
`scrollbackMaxLines()`, `fullText()` and `rawHandle()`;
`GhosttyWasmEngine` adds `encodeKeySynced(term, ev)` and
`encodeMouseSynced(term, ev)`, the same encoders configured by libghostty's
`setopt_from_terminal` rather than by `modes()`.

The browser-facing pieces, in the order a client uses them:

```ts
const term = engine.create({ cols: 80, rows: 24, scrollback: 2000 });

// one consumer per attached client; each keeps its own dirty cursor
const consumer = term.renderConsumer();
const frame = consumer.frame();
// frame.dirtyAll        every row is in `changed` (first frame, scroll, clear, resize, screen switch)
// frame.changed         Row[] — { y, cells: Cell[] } for what this consumer has not yet seen
// frame.cursor          { x, y, inViewport, visible, blinking, style, wideTail, passwordInput }
// frame.cursorChanged   the cursor differs from this consumer's previous frame
// frame.viewport        { total, offset, rows, active } — a scrollbar
for (const row of consumer.dirtyRows()) draw(row); // frame().changed, if that is all you need

// input: the modes come off the terminal, the events from the DOM
const modes = term.modes();
pty.write(
  engine.encodeKey(
    {
      action: "press",
      key: e.code,
      utf8: e.key.length === 1 ? e.key : undefined,
      mods: {
        ctrl: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
        super: e.metaKey,
      },
    },
    modes,
  ),
);
pty.write(
  engine.encodeMouse(
    { action: "press", button: MouseButton.left, x: col, y: row, mods: {} },
    modes,
  ),
);
```

`KeyEvent.key` is the W3C `KeyboardEvent.code` ("KeyA", "ArrowUp"), which
is what libghostty's physical-key enum is built from; `utf8` is the text
the layout produces before Ctrl or Alt apply. An encoder returning an
empty array is the normal answer for a bare modifier, a release, or a
mouse event the current tracking mode does not report.

A typical call through the loader:

```ts
const g = await GhosttyModule.load(await ghosttyWasmBytes());
const opts = g.allocType("GhosttyFormatterTerminalOptions"); // zeroed, size field set
g.writeStruct(opts, "GhosttyFormatterTerminalOptions", {
  emit: "VT",
  unwrap: true,
});
const f = g.withOpaque("formatter", (slot) =>
  g.call("ghostty_formatter_terminal_new", 0, slot, term, opts),
);
```

Functions taking a struct by value in C take a pointer to it in the wasm32
ABI; 64-bit values (`GhosttyCell`, `GhosttyRow`) cross as `BigInt`. A C
function pointer is an index into the exported function table;
`g.hostFunction(signature, fn)` puts a JS function there through a
one-function trampoline module and returns the index, which is what
`ghostty_terminal_set` takes for a callback option.

## `ghostty-ffi/`

| File          | What it is                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`    | `GhosttyFfiEngine` / `GhosttyFfiTerminal` over the binding's `Terminal`, `RenderState`, `Formatter` and `KeyEncoder`; the module namespace is injected so a dlopen failure surfaces at engine load                        |
| `bun.ts`      | `loadGhosttyFfiEngine()` and the registry entry. Embeds the binding's five prebuild pairs with `import ... with { type: "file" }` and, inside a compiled binary, extracts the host's pair to disk before the first dlopen |
| `ffi.test.ts` | Against the WASM adapter on the same bytes, the binding's effects, the consumer fan-out, the `Unsupported` reasons                                                                                                        |

The binding pins Ghostty `e88c6c09` (2026-04-23); the WASM adapter pins
`3c1ef5b3` (2026-09-01). The two are four months apart, and the corpus
shows it (findings/m6.md). What the binding does not reach comes back as
`Unsupported`: the snapshot codec, the mouse encoder. It has no pwd,
progress or notification callback either, so `onEffect` reports bell,
title and write-pty only. All reads go through one shared `RenderState`
refreshed in `sync()`, because the binding's own doc says a second
`RenderState` (which `Terminal.renderToAnsiRect` allocates) consumes the
terminal's dirty flags behind the first one's back.

## `xterm-oracle/`

| File             | What it is                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`       | `XtermOracleEngine` / `XtermOracleTerminal` over `@xterm/headless` with `reflowCursorLine`, the unicode11 addon and the serialize addon |
| `bun.ts`         | The registry entry                                                                                                                      |
| `oracle.test.ts` | The queue and `flush()`, what it reads back, the effects hooks, the `Unsupported` answers                                               |

xterm's `write` is asynchronous, so the adapter queues writes and resizes
in order and exposes `flush(): Promise<void>`; read `plainText`,
`styledCells` or `emitVt` only after `await term.flush()`. Effects come
through `parser.registerOscHandler` (0/2 title, 7 pwd, 9 notification and
9;4 progress, 777 notification, 133 as `other`), `onBell`, and `onData`
for query replies. Everything the corpus does not compare answers
`Unsupported("not a candidate; oracle only")`.
