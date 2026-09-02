// `app.js` is built here by `bun run build:web` (src/web/build.ts) and
// imported by the server `with { type: "text" }`, which `bun build
// --compile` embeds. This declaration lets tsc resolve the import whether
// or not the bundle has been built; the file itself is not committed.
declare const source: string;
export default source;
