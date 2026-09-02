// The ffi adapter against the WASM adapter on the same bytes, plus what
// only it can show: the binding's effects, the consumer fan-out, and the
// exact reasons for each Unsupported.

import { beforeAll, expect, test } from "bun:test";
import { loadGhosttyWasmEngine } from "../ghostty-wasm/bun.ts";
import type { GhosttyWasmEngine } from "../ghostty-wasm/index.ts";
import { isUnsupported, type Effect } from "../types.ts";
import { loadGhosttyFfiEngine } from "./bun.ts";
import type { GhosttyFfiEngine } from "./index.ts";

let ffi: GhosttyFfiEngine;
let wasm: GhosttyWasmEngine;
const enc = new TextEncoder();
const dec = new TextDecoder();

beforeAll(async () => {
  ffi = await loadGhosttyFfiEngine();
  wasm = await loadGhosttyWasmEngine();
});

const SCREEN =
  "plain \x1b[1mbold\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munder\x1b[0m\r\n" +
  "\x1b[7minverse\x1b[0m \x1b[9mstrike\x1b[0m \x1b[31mred\x1b[0m \x1b[38;5;208m208\x1b[0m \x1b[38;2;1;2;3mrgb\x1b[0m\r\n" +
  "日本語 😀 mixed\r\n" +
  "\x1b[42m\x1b[K\x1b[0mbce\r\n";

test("the pinned library loads and reports its commit", () => {
  expect(ffi.info.loaded).toBe(true);
  expect(ffi.info.pinnedCommit).toBe(
    "e88c6c099152dd6d2d7e517516e1f3c183c152f7",
  );
  expect(ffi.info.actualIdentity).toBe("0.1.0-dev");
});

test("plainText and styledCells agree with the wasm adapter on a styled screen", () => {
  const a = ffi.create({ cols: 40, rows: 6, scrollback: 100 });
  const b = wasm.create({ cols: 40, rows: 6, scrollback: 100 });
  a.write(enc.encode(SCREEN));
  b.write(enc.encode(SCREEN));
  expect(a.plainText()).toBe(b.plainText());
  expect(a.plainText().split("\n")[2]).toBe("日本語 😀 mixed");
  const ca = a.styledCells();
  const cb = b.styledCells();
  expect(ca.length).toBe(6);
  expect(ca[0]!.length).toBe(40);
  expect(ca[0]![6]!.bold).toBe(true);
  expect(ca[1]![0]!.inverse).toBe(true);
  expect(ca[1]![8]!.strikethrough).toBe(true);
  expect(ca[1]![15]!.fg).toEqual({ kind: "palette", index: 1 });
  expect(ca[1]![19]!.fg).toEqual({ kind: "palette", index: 208 });
  expect(ca[1]![23]!.fg).toEqual({ kind: "rgb", r: 1, g: 2, b: 3 });
  expect(ca[2]![0]).toMatchObject({ text: "日", width: 2 });
  expect(ca[2]![1]).toMatchObject({ text: "", width: 0 });
  // Rows 0–2 are identical cell for cell; row 3 (the BCE row) is compared in the corpus.
  for (let y = 0; y < 3; y++) expect(ca[y]).toEqual(cb[y]!);
  a.dispose();
  b.dispose();
});

test("effects: bell, title and write-pty from the binding; no pwd, progress or notification", () => {
  const t = ffi.create({ cols: 20, rows: 4, scrollback: 10 });
  const seen: Effect[] = [];
  t.onEffect((e) => seen.push(e));
  t.write(
    enc.encode(
      "\x1b]2;hello\x07\x07\x1b[6n\x1b]7;file://localhost/tmp\x07\x1b]9;4;1;50\x07\x1b]9;note\x07",
    ),
  );
  expect(seen.map((e) => e.kind)).toEqual(["title", "bell", "write-pty"]);
  expect(seen[0]).toEqual({ kind: "title", title: "hello" });
  expect(dec.decode((seen[2] as { bytes: Uint8Array }).bytes)).toBe(
    "\x1b[1;1R",
  );
  // The binding's own pwd read stays empty too, so there is nothing to poll.
  expect(t.raw.snapshot().pwd).toBeUndefined();
  t.dispose();
});

test("a listener that throws is rethrown from write(), not swallowed", () => {
  const t = ffi.create({ cols: 20, rows: 4, scrollback: 10 });
  t.onEffect(() => {
    throw new Error("boom");
  });
  expect(() => t.write(enc.encode("\x07"))).toThrow("boom");
  expect(() => t.write(enc.encode("ok"))).not.toThrow();
  t.dispose();
});

test("emitVt paints the viewport and lands the cursor; the copy reads the same", () => {
  const t = ffi.create({ cols: 40, rows: 6, scrollback: 100 });
  t.write(enc.encode(SCREEN + "\x1b[2;5H"));
  const vt = t.emitVt();
  if (isUnsupported(vt)) throw new Error(vt.reason);
  const s = dec.decode(vt);
  expect(s).toContain("\x1b[2;5H");
  const copy = wasm.create({ cols: 40, rows: 6, scrollback: 100 });
  copy.write(vt);
  expect(copy.plainText()).toBe(t.plainText());
  expect(copy.cursor()).toEqual({ x: 4, y: 1 });
  // The BCE row: the binding's RenderCell has no style for a cell whose
  // colour sits in libghostty's bg-colour content tag rather than a style,
  // so neither styledCells nor toAnsiRect carries the background
  // (findings/m6.md). This asserts the defect so its fix is noticed.
  expect(t.styledCells()[3]![10]!.bg).toEqual({ kind: "default" });
  expect(copy.styledCells()[3]![10]!.bg).toEqual({ kind: "default" });
  const full = t.emitVt({ scrollback: true });
  if (isUnsupported(full)) throw new Error(full.reason);
  expect(dec.decode(full)).toContain("bold");
  t.dispose();
  copy.dispose();
});

test("two consumers each see every change; a slow one is not starved by a fast one", () => {
  const t = ffi.create({ cols: 10, rows: 3, scrollback: 10 });
  const fast = t.renderConsumer();
  const slow = t.renderConsumer();
  if (isUnsupported(fast) || isUnsupported(slow))
    throw new Error("unsupported");
  expect(fast.frame().dirtyAll).toBe(true);
  expect(slow.frame().dirtyAll).toBe(true);
  // libghostty dirties the row the cursor left as well as the one written; the wasm adapter reports the same pairs.
  t.write(enc.encode("\x1b[2;1Hx"));
  expect(fast.frame().changed.map((r) => r.y)).toEqual([0, 1]);
  t.write(enc.encode("\x1b[3;1Hy"));
  expect(fast.frame().changed.map((r) => r.y)).toEqual([1, 2]);
  const s = slow.frame();
  expect(s.dirtyAll).toBe(false);
  expect(s.changed.map((r) => r.y)).toEqual([0, 1, 2]);
  expect(s.changed[2]!.cells[0]!.text).toBe("y");
  expect(s.cursor).toMatchObject({
    x: 1,
    y: 2,
    inViewport: true,
    visible: true,
  });
  fast.dispose();
  slow.dispose();
  t.dispose();
});

test("modes, decMode and the key encoder follow the terminal", () => {
  const t = ffi.create({ cols: 10, rows: 3, scrollback: 10 });
  const m0 = t.modes();
  if (isUnsupported(m0)) throw new Error(m0.reason);
  expect(m0.cursorKeyApplication).toBe(false);
  expect(m0.mouseTracking).toBe("none");
  expect(t.decMode(1049)).toBe(false);
  t.write(enc.encode("\x1b[?1h\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[?2027h"));
  const m1 = t.modes();
  if (isUnsupported(m1)) throw new Error(m1.reason);
  expect(m1).toMatchObject({
    cursorKeyApplication: true,
    mouseTracking: "button",
    mouseFormat: "sgr",
  });
  expect(t.decMode(1049)).toBe(true);
  expect(t.decMode(2027)).toBe(true);
  expect(t.activeScreen()).toBe("alternate");
  const up = { action: "press" as const, key: "ArrowUp", mods: {} };
  expect(ffi.encodeKey(up, m1)).toEqual(new Uint8Array([0x1b, 0x4f, 0x41]));
  expect(ffi.encodeKey(up, m0)).toEqual(new Uint8Array([0x1b, 0x5b, 0x41]));
  expect(ffi.encodeKeySynced(t, up)).toEqual(
    new Uint8Array([0x1b, 0x4f, 0x41]),
  );
  const wasmT = wasm.create({ cols: 10, rows: 3, scrollback: 10 });
  const ctrlC = {
    action: "press" as const,
    key: "KeyC",
    mods: { ctrl: true },
    utf8: "c",
  };
  expect(ffi.encodeKey(ctrlC, m0)).toEqual(
    wasm.encodeKey(ctrlC, wasmT.modes()),
  );
  wasmT.dispose();
  t.dispose();
});

test("every gap is an Unsupported with its reason", () => {
  const t = ffi.create({ cols: 10, rows: 3, scrollback: 10 });
  const es = t.encodeState();
  expect(isUnsupported(es) && es.reason).toContain("snapshot");
  const ds = ffi.decodeState(new Uint8Array(8));
  expect(isUnsupported(ds) && ds.reason).toContain("e88c6c09");
  const em = ffi.encodeMouse(
    { action: "press", button: 1, x: 0, y: 0, mods: {} },
    {},
  );
  expect(isUnsupported(em) && em.reason).toContain("mouse");
  t.dispose();
  expect(() => t.write(enc.encode("x"))).toThrow("disposed");
});
