// bun-types declares *.txt, *.toml, *.html and friends but not *.wasm. With
// `with { type: "file" }` Bun resolves the import to a path string.
declare module "*.wasm" {
  const path: string;
  export default path;
}
