// The Bun-specific half of loading: getting the pinned artifact's bytes.
//
// `import ... with { type: "file" }` is the form `bun build --compile` embeds:
// inside a compiled binary the path resolves to `/$bunfs/root/<name>.wasm`
// and `Bun.file()` reads it with nothing on disk. `Bun.file(import.meta.dir +
// "/...")` is *not* embedded and fails with ENOENT once compiled.
//
// The commit is spelled out in the import path because the bundler needs a
// static string; a test checks it against vendor/ghostty-vt/PIN.

import wasmPath from "../../../vendor/ghostty-vt/3c1ef5b32fc5ea6b93d28493fabf193f595139cf/ghostty-vt-small.wasm" with { type: "file" };

export const GHOSTTY_COMMIT = "3c1ef5b32fc5ea6b93d28493fabf193f595139cf";

export async function ghosttyWasmBytes(): Promise<ArrayBuffer> {
  return Bun.file(wasmPath).arrayBuffer();
}

/** Where the bytes came from — a real path when interpreted, a bunfs path when compiled. */
export const ghosttyWasmPath: string = wasmPath;
