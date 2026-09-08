# @werk/terminal-beamterm

Paint a `@werk/terminal` replica onto a WebGL2 canvas instead of DOM rows.

This is a private workspace package. Depend on it as
`"@werk/terminal-beamterm": "workspace:*"` and import from
`@werk/terminal-beamterm`. Build it with `bun run build`.

```ts
import { createTerminalReplica } from "@werk/terminal";
import { beamtermRenderer } from "@werk/terminal-beamterm";

const factory = beamtermRenderer({ wasmUrl: "/beamterm_renderer_bg.wasm" });
const renderer = await factory({ mount: document.getElementById("terminal")! });
const replica = createTerminalReplica(engine, renderer);
```

`beamtermRenderer(options)` returns a value of the same type the bundled DOM
adapter has: a `RendererFactory` from `@werk/terminal`. The bundled one is
`createWtermRenderer` from `@werk/terminal/dom`. Either can be handed to
`createTerminalReplica` in the same place.

The module and its 1.4 MB of WASM load only when the returned factory is
mounted, not when this package is imported. Browser applications must serve the
pinned renderer WASM themselves and pass its URL as `wasmUrl`.

WebGL2 is required. The cursor is drawn by inverting the cell it sits on. Each
mounted renderer owns its canvas and its native renderer, and disposes both.

## The shadow buffer

A beamterm batch updates the cells it is given and keeps every cell it is not.
So a paint writes the rows the frame reports as changed, plus the two cells the
cursor left and entered. A size change writes the whole grid. The adapter keeps
a shadow copy of the last painted rows so those writes can be assembled from
frames that carry only what changed.

## The pin

The dependency is exactly `@beamterm/renderer` 1.0.0, from
<https://github.com/junkdog/beamterm>, under its included MIT licence. See
`PROVENANCE.md` for the exact WASM SHA-256 and `LICENSE.beamterm` for the
redistribution licence.

Its WASM and generated JavaScript must be upgraded together.
