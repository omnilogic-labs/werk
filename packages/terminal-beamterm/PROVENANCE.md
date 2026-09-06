# beamterm renderer pin

The adapter consumes exactly `@beamterm/renderer` **1.0.0**, published from
<https://github.com/junkdog/beamterm> (`js` package, MIT; see `LICENSE.beamterm`).
The browser uses the package's `dist/web/beamterm_renderer.js` glue and adjacent
`dist/web/beamterm_renderer_bg.wasm` together. The WASM SHA-256 is:

`0f5e9f04ba2fbcfcc8dac30523ef692bfc6bf84fbb61d545deeb4fb6138d6d36`

`examples/session-web/build.ts` checks that digest before copying the WASM and
ships this provenance and the licence beside the browser assets. Upgrade the
exact dependency, this digest, and generated glue together, then run the packaged
browser renderer tests (including actual coloured pixels and renderer swaps).
