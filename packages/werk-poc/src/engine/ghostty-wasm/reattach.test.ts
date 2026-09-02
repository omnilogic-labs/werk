// The two reattach mechanisms from the proposal, §2, and the effects: what
// each one preserves, what it costs, and the one defect re-emission has.

import { describe, expect, test } from "bun:test";
import { GhosttyError } from "./loader.ts";
import { isUnsupported, type Effect, type Unsupported } from "../types.ts";
import { ghosttyWasmBytes } from "./bytes.ts";
import { GhosttyWasmEngine, type GhosttyWasmTerminal } from "./index.ts";

const engine = await GhosttyWasmEngine.load(await ghosttyWasmBytes());
const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesOf(v: Uint8Array | Unsupported): Uint8Array {
  if (isUnsupported(v)) throw new Error(v.reason);
  return v;
}

/** A styled 40×12 screen: SGR runs, truecolour, wide characters, a hyperlink, the cursor parked mid-screen. */
function styledScreen(): GhosttyWasmTerminal {
  const t = engine.create({ cols: 40, rows: 12, scrollback: 100 });
  t.write(
    enc.encode(
      "\x1b[1mbold\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munder\x1b[0m \x1b[7minv\x1b[0m\r\n" +
        "\x1b[31mred\x1b[0m \x1b[38;5;200mpal\x1b[0m \x1b[38;2;10;20;30mrgb\x1b[0m \x1b[44mbg\x1b[0m\r\n" +
        "日本語 😀 mixed\r\n" +
        "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ after\r\n" +
        "\x1b[6;9H",
    ),
  );
  return t;
}

function sameScreen(a: GhosttyWasmTerminal, b: GhosttyWasmTerminal): void {
  expect(b.plainText()).toBe(a.plainText());
  expect(b.styledCells()).toEqual(a.styledCells());
  expect(b.cursor()).toEqual(a.cursor());
}

describe("emitVt (reattach mechanism 1)", () => {
  test("a styled 40×12 screen round-trips through a fresh terminal, and re-emission is idempotent", () => {
    const a = styledScreen();
    const vt = bytesOf(a.emitVt());
    console.log(`emitVt: ${vt.length} bytes for the styled 40×12 screen`);
    expect(vt.length).toBeGreaterThan(0);
    expect(vt.length).toBeLessThan(600);
    const b = engine.create({ cols: 40, rows: 12, scrollback: 100 });
    b.write(vt);
    sameScreen(a, b);
    expect(a.cursor()).toEqual({ x: 8, y: 5 });
    expect(bytesOf(b.emitVt())).toEqual(vt);
    a.dispose();
    b.dispose();
  });

  test("cursor and style can be left out; style is the SGR state pending at the cursor", () => {
    const a = styledScreen();
    a.write(enc.encode("\x1b[1;34m")); // bold blue pending, nothing printed yet
    const all = dec.decode(bytesOf(a.emitVt()));
    const noCursor = dec.decode(bytesOf(a.emitVt({ cursor: false })));
    const noStyle = dec.decode(bytesOf(a.emitVt({ style: false })));
    const neither = dec.decode(
      bytesOf(a.emitVt({ cursor: false, style: false })),
    );
    const pending = "\x1b[0m\x1b[1m\x1b[38;5;4m";
    expect(all.endsWith("\x1b[6;9H" + pending)).toBe(true);
    expect(noCursor.endsWith(pending)).toBe(true);
    expect(noCursor).not.toContain("\x1b[6;9H");
    expect(noStyle.endsWith("\x1b[6;9H")).toBe(true);
    expect(
      neither.endsWith("inv\x1b[0m\r\n") || !neither.includes("\x1b[6;9H"),
    ).toBe(true);
    // the cells' own SGR is always there; `style` only governs the trailing state
    for (const v of [all, noCursor, noStyle, neither])
      expect(v).toContain("\x1b[1mbold");
    const b = engine.create({ cols: 40, rows: 12, scrollback: 100 });
    b.write(bytesOf(a.emitVt()));
    b.write(enc.encode("Z"));
    a.write(enc.encode("Z"));
    expect(b.styledCells()[5]![8]).toMatchObject({
      text: "Z",
      bold: true,
      fg: { kind: "palette", index: 4 },
    });
    expect(b.styledCells()).toEqual(a.styledCells());
    a.dispose();
    b.dispose();
  });

  test("the third defect: a closed hyperlink is not re-emitted, only one still open at the cursor", () => {
    const a = engine.create({ cols: 40, rows: 3, scrollback: 10 });
    a.write(enc.encode("\x1b]8;;https://a.example\x1b\\closed\x1b]8;;\x1b\\ "));
    expect(dec.decode(bytesOf(a.emitVt()))).not.toContain("https://a.example");
    a.write(enc.encode("\x1b]8;;https://b.example\x1b\\open"));
    const vt = dec.decode(bytesOf(a.emitVt()));
    expect(vt).not.toContain("https://a.example");
    expect(vt.endsWith("\x1b]8;;https://b.example\x1b\\")).toBe(true);
    a.dispose();
  });

  test("the second defect: a background-only (BCE) row comes out blank", () => {
    const a = engine.create({ cols: 10, rows: 5, scrollback: 10 });
    a.write(enc.encode("a\r\n\x1b[42m\x1b[K\x1b[0m\r\nb\x1b[1;1H"));
    expect(a.styledCells()[1]![3]).toMatchObject({
      text: "",
      bg: { kind: "palette", index: 2 },
    });
    const b = engine.create({ cols: 10, rows: 5, scrollback: 10 });
    b.write(bytesOf(a.emitVt()));
    expect(b.plainText()).toBe(a.plainText());
    expect(b.styledCells()[1]![3]).toMatchObject({
      text: "",
      bg: { kind: "default" },
    });
    a.dispose();
    b.dispose();
  });

  test("scrollback: true emits the whole buffer, scrollback first", () => {
    const a = engine.create({ cols: 20, rows: 4, scrollback: 100 });
    for (let i = 0; i < 10; i++) a.write(enc.encode(`line ${i}\r\n`));
    const viewport = dec.decode(bytesOf(a.emitVt()));
    const whole = dec.decode(bytesOf(a.emitVt({ scrollback: true })));
    expect(viewport).not.toContain("line 0");
    expect(whole).toContain("line 0");
    expect(whole.indexOf("line 0")).toBeLessThan(whole.indexOf("line 9"));
    const b = engine.create({ cols: 20, rows: 4, scrollback: 100 });
    b.write(bytesOf(a.emitVt({ scrollback: true })));
    expect(b.fullText()).toBe(a.fullText());
    expect(b.plainText()).toBe(a.plainText());
    expect(b.cursor()).toEqual(a.cursor());
    expect(b.getNumber("TOTAL_ROWS")).toBe(a.getNumber("TOTAL_ROWS"));
    // a cleared viewport over retained scrollback, and a cursor mid-viewport, both align
    a.write(enc.encode("\x1b[2J\x1b[2;3H"));
    const c = engine.create({ cols: 20, rows: 4, scrollback: 100 });
    c.write(bytesOf(a.emitVt({ scrollback: true })));
    expect(c.plainText()).toBe(a.plainText());
    expect(c.cursor()).toEqual({ x: 2, y: 1 });
    expect(c.fullText()).toBe(a.fullText());
    a.dispose();
    b.dispose();
    c.dispose();
  });

  test("the known defect: a soft-wrapped line becomes a hard newline", () => {
    const a = engine.create({ cols: 40, rows: 12, scrollback: 100 });
    a.write(enc.encode("x".repeat(60)));
    const b = engine.create({ cols: 40, rows: 12, scrollback: 100 });
    b.write(bytesOf(a.emitVt()));
    expect(b.plainText()).toBe(a.plainText());
    a.resize(80, 12);
    b.resize(80, 12);
    // the original reflows into one logical line; the replayed copy stays split
    expect(a.plainText().split("\n")[0]).toBe("x".repeat(60));
    expect(b.plainText().split("\n").slice(0, 2)).toEqual([
      "x".repeat(40),
      "x".repeat(20),
    ]);
    a.dispose();
    b.dispose();
  });
});

describe("effects", () => {
  function collect(t: GhosttyWasmTerminal): Effect[] {
    const out: Effect[] = [];
    const r = t.onEffect((e) => out.push(e));
    expect(isUnsupported(r)).toBe(false);
    return out;
  }

  test("title, pwd, bell, progress, notification and write-pty", () => {
    const t = engine.create({ cols: 40, rows: 5, scrollback: 10 });
    const got = collect(t);
    t.write(enc.encode("\x07"));
    t.write(enc.encode("\x1b]0;from osc 0\x07"));
    t.write(enc.encode("\x1b]2;from osc 2\x1b\\"));
    t.write(enc.encode("\x1b]7;file://host/home/me\x1b\\"));
    t.write(enc.encode("\x1b]9;4;1;42\x1b\\\x1b]9;4;3\x1b\\\x1b]9;4;0\x1b\\"));
    t.write(enc.encode("\x1b]9;plain note\x1b\\"));
    t.write(enc.encode("\x1b]777;notify;Title;Body\x1b\\"));
    t.write(enc.encode("\x1b[6n")); // DSR: cursor position
    t.write(enc.encode("\x1b[?1$p")); // DECRQM: DECCKM
    t.write(enc.encode("\x1b[c")); // DA1
    expect(got).toEqual([
      { kind: "bell" },
      { kind: "title", title: "from osc 0" },
      { kind: "title", title: "from osc 2" },
      { kind: "pwd", pwd: "file://host/home/me" },
      { kind: "progress", state: "set", progress: 42 },
      { kind: "progress", state: "indeterminate", progress: null },
      { kind: "progress", state: "remove", progress: null },
      { kind: "notification", title: "", body: "plain note" },
      { kind: "notification", title: "Title", body: "Body" },
      { kind: "write-pty", bytes: enc.encode("\x1b[1;1R") },
      { kind: "write-pty", bytes: enc.encode("\x1b[?1;2$y") },
      { kind: "write-pty", bytes: enc.encode("\x1b[?62;22c") },
    ]);
    expect(t.getString("TITLE")).toBe("from osc 2");
    t.dispose();
  });

  test("every listener sees every effect, and terminals do not cross-talk", () => {
    const a = engine.create({ cols: 10, rows: 2, scrollback: 10 });
    const b = engine.create({ cols: 10, rows: 2, scrollback: 10 });
    const a1 = collect(a);
    const a2 = collect(a);
    const b1 = collect(b);
    a.write(enc.encode("\x1b]2;A\x1b\\"));
    b.write(enc.encode("\x07"));
    expect(a1).toEqual([{ kind: "title", title: "A" }]);
    expect(a2).toEqual(a1);
    expect(b1).toEqual([{ kind: "bell" }]);
    a.dispose();
    b.dispose();
  });

  test("a throwing listener surfaces from write() after libghostty has returned", () => {
    const t = engine.create({ cols: 10, rows: 2, scrollback: 10 });
    const seen: Effect[] = [];
    t.onEffect(() => {
      throw new Error("listener failed");
    });
    t.onEffect((e) => seen.push(e));
    expect(() => t.write(enc.encode("a\x07b"))).toThrow("listener failed");
    expect(seen).toEqual([{ kind: "bell" }]);
    expect(t.plainText()).toBe("ab\n");
    t.write(enc.encode("c")); // the terminal is still consistent
    expect(t.plainText()).toBe("abc\n");
    t.dispose();
  });

  test("a write on a terminal without listeners still answers queries silently", () => {
    const t = engine.create({ cols: 10, rows: 2, scrollback: 10 });
    t.write(enc.encode("\x1b[6n\x07\x1b]2;x\x1b\\"));
    expect(t.plainText()).toBe("\n");
    expect(t.getString("TITLE")).toBe("x");
    t.dispose();
  });
});

describe("encodeState / decodeState (reattach mechanism 2)", () => {
  function restore(bytes: Uint8Array): {
    t: GhosttyWasmTerminal;
    pages: number;
    rows: number;
  } {
    const d = engine.decodeState(bytes);
    if (isUnsupported(d)) throw new Error(d.reason);
    const t = d.ready();
    let pages = 0;
    let rows = 0;
    for (let p = d.next(); p; p = d.next()) {
      pages++;
      rows += p.rows;
    }
    return { t, pages, rows };
  }

  test("a styled 40×12 screen round-trips, and soft-wrap survives a resize", () => {
    const a = styledScreen();
    a.write(enc.encode("\x1b[12;1H" + "y".repeat(60)));
    const snap = bytesOf(a.encodeState());
    expect(dec.decode(snap.subarray(0, 8))).toBe("GHOSTSNP");
    console.log(
      `encodeState: ${snap.length} bytes for the styled 40×12 screen`,
    );
    const { t: b } = restore(snap);
    expect(b.size).toEqual({ cols: 40, rows: 12 });
    sameScreen(a, b);
    a.resize(80, 12);
    b.resize(80, 12);
    sameScreen(a, b);
    expect(b.plainText()).toContain("y".repeat(60));
    a.dispose();
    b.dispose();
  });

  test("5,000 lines: ready() paints the tail, next() restores the rest, byte-exact", () => {
    const a = engine.create({ cols: 80, rows: 24, scrollback: 2000 });
    for (let i = 0; i < 5000; i++) a.write(enc.encode(`line ${i}\r\n`));
    const totalRows = a.getNumber("TOTAL_ROWS");

    let t0 = performance.now();
    const snap = bytesOf(a.encodeState());
    const encodeMs = performance.now() - t0;
    expect(dec.decode(snap.subarray(0, 8))).toBe("GHOSTSNP");
    const version = snap[8]! | (snap[9]! << 8);

    const d = engine.decodeState(snap);
    if (isUnsupported(d)) throw new Error(d.reason);
    t0 = performance.now();
    const b = d.ready();
    const readyMs = performance.now() - t0;
    const readyRows = b.getNumber("TOTAL_ROWS");
    const history = d.historyRows();
    const pending = history.primary! - (readyRows - 24);
    expect(b.plainText()).toBe(a.plainText()); // the viewport is renderable at once
    expect(readyRows).toBeLessThan(totalRows); // and history is still to come
    expect(pending).toBeGreaterThan(0);

    t0 = performance.now();
    const pages: number[] = [];
    let last: { remaining: number; screen: string } | null = null;
    for (let p = d.next(); p; p = d.next()) {
      pages.push(p.rows);
      last = p;
    }
    const nextMs = performance.now() - t0;
    expect(last?.remaining).toBe(0);
    expect(last?.screen).toBe("primary");
    expect(pages.reduce((x, y) => x + y, 0)).toBe(pending);
    expect(b.getNumber("TOTAL_ROWS")).toBe(totalRows);
    expect(b.fullText()).toBe(a.fullText());
    expect(d.next()).toBeNull(); // and stays null
    console.log(
      `snapshot: ${totalRows} rows -> ${snap.length} bytes (format v${version}) in ${encodeMs.toFixed(2)} ms; ` +
        `ready() ${readyMs.toFixed(2)} ms with ${readyRows} rows renderable and ${pending} pending; ` +
        `next() ${pages.length} pages of ${pages.join("/")} rows in ${nextMs.toFixed(2)} ms; ` +
        `restored scrollbackMaxLines=${b.scrollbackMaxLines()}`,
    );
    a.dispose();
    b.dispose();
  });

  test("a snapshot taken mid-CSI carries the continuation, and the sequence completes after restore", () => {
    const a = engine.create({ cols: 20, rows: 3, scrollback: 10 });
    a.write(enc.encode("ab\x1b[3")); // cut inside CSI 31 m
    const snap = bytesOf(a.encodeState());
    const { t: b } = restore(snap);
    const rest = enc.encode("1mX\x1b[0mY");
    a.write(rest);
    b.write(rest);
    expect(b.plainText()).toBe("abXY\n\n");
    expect(b.styledCells()[0]![2]).toMatchObject({
      text: "X",
      fg: { kind: "palette", index: 1 },
    });
    expect(b.styledCells()).toEqual(a.styledCells());
    // the restored terminal keeps tracking, so it can be snapshotted mid-sequence again
    b.write(enc.encode("\x1b[3"));
    expect(bytesOf(b.encodeState()).length).toBeGreaterThan(0);
    a.dispose();
    b.dispose();
  });

  test("without continuation tracking, encoding mid-sequence is INVALID_VALUE", () => {
    const t = engine.create({
      cols: 20,
      rows: 3,
      scrollback: 10,
      continuationMaxBytes: 0,
    });
    t.write(enc.encode("ab\x1b[3"));
    expect(() => t.encodeState()).toThrow(GhosttyError);
    expect(() => t.encodeState()).toThrow(/INVALID_VALUE/);
    t.write(enc.encode("1m")); // back at ground
    expect(bytesOf(t.encodeState()).length).toBeGreaterThan(0);
    t.dispose();
  });

  test("ownership: ready() is idempotent, disposing the terminal abandons the decoder, garbage fails cleanly", () => {
    const a = engine.create({ cols: 80, rows: 24, scrollback: 2000 });
    for (let i = 0; i < 3000; i++) a.write(enc.encode(`line ${i}\r\n`));
    const snap = bytesOf(a.encodeState());
    const d = engine.decodeState(snap);
    if (isUnsupported(d)) throw new Error(d.reason);
    expect(() => d.next()).toThrow(/ready/);
    const b = d.ready();
    expect(d.ready()).toBe(b);
    expect(d.next()).not.toBeNull(); // one page in
    b.dispose(); // the decoder goes with it
    expect(d.next()).toBeNull();
    d.dispose(); // idempotent

    const bad = engine.decodeState(enc.encode("not a snapshot at all"));
    if (isUnsupported(bad)) throw new Error(bad.reason);
    expect(() => bad.ready()).toThrow(GhosttyError);
    bad.dispose();
    a.dispose();
  });
});
