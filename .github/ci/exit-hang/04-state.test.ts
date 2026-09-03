// encodeState / decodeState, the way reattach.test.ts uses them.
import { expect, test } from "bun:test";
import { ghosttyWasmBytes } from "../src/engine/ghostty-wasm/bytes.ts";
import { GhosttyWasmEngine } from "../src/engine/ghostty-wasm/index.ts";
import { isUnsupported } from "../src/engine/types.ts";

const engine = await GhosttyWasmEngine.load(await ghosttyWasmBytes());

test("encode and decode state", () => {
  const a = engine.create({ cols: 40, rows: 12, scrollback: 100 });
  a.write(new TextEncoder().encode("\x1b[1mbold\x1b[0m 日本語\r\nline two"));
  const snap = a.encodeState();
  if (isUnsupported(snap)) throw new Error(snap.reason);
  const d = engine.decodeState(snap);
  if (isUnsupported(d)) throw new Error(d.reason);
  const b = d.ready();
  expect(b.plainText()).toBe(a.plainText());
  d.dispose();
  a.dispose();
});
