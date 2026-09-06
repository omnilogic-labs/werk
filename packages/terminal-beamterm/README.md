# @werk/terminal-beamterm

`beamtermRenderer({ wasmUrl })` returns the same renderer factory used by the
bundled DOM adapter. The module and WASM are loaded only when that factory is
mounted. Browser applications must serve the pinned renderer WASM and pass its
URL. `createBeamtermRenderer` uses upstream's default asset resolution.

The dependency is exactly `@beamterm/renderer` 1.0.0, from
<https://github.com/junkdog/beamterm>, under its included MIT licence.
See `PROVENANCE.md` for the exact WASM SHA-256 and `LICENSE.beamterm` for the
redistribution licence. Its WASM and generated JavaScript must be upgraded together. WebGL2 is required.
The cursor is represented by cell inversion. Each mounted renderer owns and
disposes its canvas and native renderer.
