# @werk/terminal

Portable, session-scoped Ghostty WASM interpretation and snapshot replicas.
`createTerminalEngine(bytesOrModule)` compiles once and allocates an independent
WASM instance for every created or restored terminal. `loadTerminalEngine()`
from `@werk/terminal/bun` loads the pinned asset through Bun's file loader,
including when compiled into an executable.

The factory exposes its build identity, snapshot version and explicit
capabilities. `create(size)` and `restore(envelope)` return owned handles;
`dispose()` is idempotent. A reply effect has `kind: "reply"` and a byte-array
payload and must be answered by the PTY owner. Consumers must not render it.

`createTerminalReplica(factory, renderer?)` serialises attachment events,
rejects gaps, ignores stale generations and replaces state atomically on a
snapshot or resynchronisation. Await `apply(event)` to observe decoding errors.
Renderers receive changed cell rows and cursor state through `Frame`; the core
has no DOM, runtime or session dependencies. `@werk/terminal/dom` exports
`createWtermRenderer({ mount })`, backed by pinned Apache-2.0 `@wterm/dom` and
`@wterm/core` 0.4.1. Those packages include their upstream licences.

`inputModes()` queries application cursor/keypad, bracketed paste, focus,
mouse tracking and kitty keyboard state from the engine, including restored
snapshots. `encodeKey` and `encodePaste` accept the queried cursor/paste modes.
`viewport()` reports scrollback position; `scrollViewport()` moves by rows or
to either end. `readSelection()` uses inclusive viewport cell coordinates and
preserves wide graphemes. The standalone `selectionText` helper operates on
supplied text with code-point indices. Snapshot bytes contain parser continuation and retained
history; screen recovery does not recover a process. Defaults retain upstream's
bounded scrollback. Dimensions and snapshot input have explicit limits.

The pinned engine can reflow a restored long wrapped line differently after
subsequent output and a resize. Session owners therefore send authoritative
state after resizing; replicas must apply that resynchronisation before later
output. A resize-only replay is insufficient for this engine build.
