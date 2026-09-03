// The wasm compiled and instantiated; no terminal created.
import { expect, test } from "bun:test";
import { ghosttyWasmBytes } from "../src/engine/ghostty-wasm/bytes.ts";
import { GhosttyWasmEngine } from "../src/engine/ghostty-wasm/index.ts";

const engine = await GhosttyWasmEngine.load(await ghosttyWasmBytes());

test("load", () => {
  expect(engine.module.exportCount).toBeGreaterThan(0);
});
