# @werk/terminal

Portable, session-scoped Ghostty WASM interpretation and snapshot replicas.
`createTerminalEngine(bytesOrModule)` compiles once and allocates an independent
WASM instance for every created or restored terminal. `loadTerminalEngine()`
from `@werk/terminal/bun` loads the pinned asset through Bun's file loader,
including when compiled into an executable.

The factory exposes its build identity, snapshot version and explicit
capabilities. `create(size, options?)` and `restore(envelope, options?)` return owned handles;
`dispose()` is idempotent. A reply effect has `kind: "reply"` and a byte-array
payload and must be answered by the PTY owner. Consumers must not render it.

`createTerminalReplica(factory, renderer?, options?)` serialises attachment events,
rejects gaps, ignores stale generations and replaces state atomically on a
snapshot or resynchronisation. Await `apply(event)` to observe decoding errors.
Application updates the terminal immediately; renderer paints coalesce once per
`requestAnimationFrame` tick in browsers or `setTimeout(0)` elsewhere.
`options.schedulePaint(callback)` can inject a scheduler and optionally return
a cancellation function. A microtask scheduler will paint between serialised
events and should be avoided when coalescing bursts. After awaiting `apply()`,
call `flush()` to paint pending state synchronously. `ended` flushes before
resolving so consumers can dispose immediately without losing final output.
Disposal cancels pending work; stale callbacks do nothing. Scheduled renderer
failures are retained and thrown by the next `flush()` or `apply()` after its
event is applied, without poisoning the event queue. Explicit flush failures
propagate directly.
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
history; screen recovery does not recover a process. Dimensions and snapshot
input have explicit limits.

`TerminalOptions.scrollbackBytes` sets the page-memory budget on create or,
after decoding all history, on restore. Omission keeps the upstream 10,000-byte
create default or the limit stored in the snapshot. A lower restore budget
prunes oldest pages immediately; a higher budget permits future growth.
`scrollback()` reports `{ maxBytes, rows }`, with `null` for an unlimited byte
budget, and `capabilities.scrollbackLimit` advertises support. Budgets must be
integers from 0 to 4,294,967,295; 0 disables history and the maximum value is the
pinned engine's unlimited sentinel. Other non-zero budgets have a minimum of
two pages (about 0.9 MB), with retention changing in roughly 450 KB steps
(about 450 rows at 120 columns). Bytes measure page memory, not text size.

The pinned engine can reflow a restored long wrapped line differently after
subsequent output and a resize. Session owners therefore send authoritative
state after resizing; replicas must apply that resynchronisation before later
output. A resize-only replay is insufficient for this engine build.

`formatScreen("plain" | "vt" | "html")` formats only the active screen,
regardless of viewport scrolling, without consuming frame dirtiness.
`capabilities.preview` advertises this formatter. Plain output equals
`readScreen()`; VT retains styles and graphemes, and HTML escapes text with
style markup. VT output is a formatted fragment with LF line separators;
consumers replaying it into a terminal should position the cursor, clear the
previous screen and translate LF to CRLF as needed. It does not encode cursor
position or other terminal state.
