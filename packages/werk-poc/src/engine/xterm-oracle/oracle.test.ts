// The oracle behind the seam: its queued write and flush, what it reads
// back, its effects hooks, and the Unsupported answers.

import { expect, test } from "bun:test";
import { isUnsupported, type Effect } from "../types.ts";
import { XtermOracleEngine } from "./index.ts";

const engine = new XtermOracleEngine();
const enc = new TextEncoder();
const dec = new TextDecoder();

test("write is queued; flush() is the point at which reads are current", async () => {
  const t = engine.create({ cols: 20, rows: 3, scrollback: 10 });
  t.write(enc.encode("hello"));
  expect(t.queued).toBe(1);
  expect(t.plainText()).toBe("\n\n");
  await t.flush();
  expect(t.queued).toBe(0);
  expect(t.plainText()).toBe("hello\n\n");
  t.dispose();
});

test("resize is ordered behind the writes before it", async () => {
  const t = engine.create({ cols: 40, rows: 3, scrollback: 10 });
  t.write(enc.encode("a".repeat(60)));
  t.resize(20, 3);
  await t.flush();
  expect(t.size).toEqual({ cols: 20, rows: 3 });
  expect(t.plainText()).toBe(
    "aaaaaaaaaaaaaaaaaaaa\naaaaaaaaaaaaaaaaaaaa\naaaaaaaaaaaaaaaaaaaa",
  );
  // Where the cursor lands after this reflow is a corpus case (reflow-cursor-boundary).
  t.dispose();
});

test("styledCells: attributes, palette and rgb colours, wide cells", async () => {
  const t = engine.create({ cols: 20, rows: 2, scrollback: 10 });
  t.write(
    enc.encode(
      "\x1b[1;3;4;7;9m*\x1b[0m\x1b[31mr\x1b[38;5;208mo\x1b[38;2;1;2;3mt\x1b[0m\x1b[44mb\x1b[0m日x",
    ),
  );
  await t.flush();
  const c = t.styledCells();
  expect(c.length).toBe(2);
  expect(c[0]!.length).toBe(20);
  expect(c[0]![0]).toMatchObject({
    text: "*",
    bold: true,
    italic: true,
    underline: true,
    inverse: true,
    strikethrough: true,
  });
  expect(c[0]![1]!.fg).toEqual({ kind: "palette", index: 1 });
  expect(c[0]![2]!.fg).toEqual({ kind: "palette", index: 208 });
  expect(c[0]![3]!.fg).toEqual({ kind: "rgb", r: 1, g: 2, b: 3 });
  expect(c[0]![4]!.bg).toEqual({ kind: "palette", index: 4 });
  expect(c[0]![5]).toMatchObject({ text: "日", width: 2 });
  expect(c[0]![6]).toMatchObject({ text: "", width: 0 });
  expect(c[0]![7]).toMatchObject({ text: "x", width: 1 });
  expect(c[0]![8]).toMatchObject({ text: "", width: 1 });
  t.dispose();
});

test("effects: titles, pwd, notifications, progress, marks, bell, query replies", async () => {
  const t = engine.create({ cols: 20, rows: 2, scrollback: 10 });
  const seen: Effect[] = [];
  t.onEffect((e) => seen.push(e));
  t.write(
    enc.encode(
      "\x1b]0;t0\x07\x1b]2;t2\x07\x1b]7;file://h/p\x07\x1b]9;note\x07\x1b]9;4;1;50\x07\x1b]9;4;3\x07\x1b]777;notify;T;B\x07\x1b]133;A\x07\x07\x1b[6n",
    ),
  );
  await t.flush();
  expect(seen).toEqual([
    { kind: "title", title: "t0" },
    { kind: "title", title: "t2" },
    { kind: "pwd", pwd: "file://h/p" },
    { kind: "notification", title: "", body: "note" },
    { kind: "progress", state: "set", progress: 50 },
    { kind: "progress", state: "indeterminate", progress: null },
    { kind: "notification", title: "T", body: "B" },
    { kind: "other", name: "osc133", detail: "A" },
    { kind: "bell" },
    { kind: "write-pty", bytes: enc.encode("\x1b[1;1R") },
  ]);
  t.dispose();
});

test("emitVt through the serialize addon; the alternate screen is visible to decMode", async () => {
  const t = engine.create({ cols: 20, rows: 2, scrollback: 10 });
  t.write(enc.encode("\x1b[1mhi\x1b[0m"));
  await t.flush();
  const vt = t.emitVt();
  if (isUnsupported(vt)) throw new Error(vt.reason);
  expect(dec.decode(vt)).toContain("\x1b[1mhi");
  expect(t.decMode(1049)).toBe(false);
  t.write(enc.encode("\x1b[?1049h"));
  await t.flush();
  expect(t.decMode(1049)).toBe(true);
  expect(t.activeScreen()).toBe("alternate");
  expect(() => t.decMode(2027)).toThrow();
  t.dispose();
});

test("everything else is oracle-only", () => {
  const t = engine.create({ cols: 20, rows: 2, scrollback: 10 });
  for (const r of [
    t.encodeState(),
    t.renderConsumer(),
    engine.decodeState(new Uint8Array(0)),
    engine.encodeKey({ action: "press", key: "KeyA", mods: {} }, {}),
    engine.encodeMouse(
      { action: "press", button: 1, x: 0, y: 0, mods: {} },
      {},
    ),
  ])
    expect(isUnsupported(r) && r.reason).toBe("not a candidate; oracle only");
  t.dispose();
});
