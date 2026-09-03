// One terminal created, written to, and disposed.
import { expect, test } from "bun:test";
import { ghosttyWasmBytes } from "../src/engine/ghostty-wasm/bytes.ts";
import { GhosttyWasmEngine } from "../src/engine/ghostty-wasm/index.ts";

const engine = await GhosttyWasmEngine.load(await ghosttyWasmBytes());

test("create and dispose", () => {
  const t = engine.create({ cols: 40, rows: 12, scrollback: 100 });
  t.write(new TextEncoder().encode("hello\r\nworld"));
  expect(t.plainText()).toContain("hello");
  t.dispose();
});
