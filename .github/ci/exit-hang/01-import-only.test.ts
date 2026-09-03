// The engine's modules imported, the wasm never compiled.
import { expect, test } from "bun:test";
import { GhosttyWasmEngine } from "../src/engine/ghostty-wasm/index.ts";
import { GHOSTTY_COMMIT } from "../src/engine/ghostty-wasm/bytes.ts";

test("import only", () => {
  expect(typeof GhosttyWasmEngine.load).toBe("function");
  expect(GHOSTTY_COMMIT.length).toBe(40);
});
