// `import x from "./lib.so" with { type: "file" }` gives the path Bun will
// serve the file at (embedded under /$bunfs/ once compiled); tsc needs to
// be told the same for the ffi prebuilds as wasm.d.ts tells it for .wasm.
declare module "*.so" {
  const path: string;
  export default path;
}
declare module "*.dylib" {
  const path: string;
  export default path;
}
