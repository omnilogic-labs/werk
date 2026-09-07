import { test, expect } from "bun:test";
import { loadTerminalEngine } from "../src/bun/index.ts";
import {
  createTerminalReplica,
  UnsupportedSnapshotError,
} from "../src/index.ts";
const bytes = (s: string) => new TextEncoder().encode(s);
test("independent engines restore parser continuation, styles, wide graphemes and resize", async () => {
  const f = await loadTerminalEngine();
  const a = await f.create({ cols: 12, rows: 3 });
  const b = await f.create({ cols: 12, rows: 3 });
  try {
    a.write(bytes("one\x1b[31"));
    const r = await f.restore(a.snapshot());
    try {
      a.write(bytes("m中é"));
      r.write(bytes("m中é"));
      expect(r.readScreen()).toBe(a.readScreen());
      expect(b.readScreen().trim()).toBe("");
      const row = r.frame().changed[0]!.cells;
      expect(row[0]!.text).toBe("o");
      expect(row[3]!.text).toBe("中");
      expect(row[3]!.width).toBe(2);
      expect(row[5]!.text).toBe("é");
      expect(row[3]!.fg).not.toBe(row[0]!.fg);
      expect(r.frame().changed).toHaveLength(0);
      a.resize({ cols: 8, rows: 4 });
      r.resize({ cols: 8, rows: 4 });
      expect(r.readScreen()).toBe(a.readScreen());
    } finally {
      r.dispose();
    }
  } finally {
    a.dispose();
    a.dispose();
    b.dispose();
  }
});
test("effects carry replies and titles without writing replies into screen", async () => {
  const t = await (await loadTerminalEngine()).create({ cols: 20, rows: 3 });
  try {
    const e = t.write(bytes("\x1b]2;title\x07\x07\x1b[6n"));
    expect(e.find((e) => e.kind === "title")?.payload).toBe("title");
    expect(e.some((e) => e.kind === "bell")).toBe(true);
    expect(
      new TextDecoder().decode(
        e.find((e) => e.kind === "reply")?.payload as Uint8Array,
      ),
    ).toContain("R");
    expect(t.readScreen().trim()).toBe("");
  } finally {
    t.dispose();
  }
});
test("invalid dimensions and snapshots leave healthy sessions usable", async () => {
  const f = await loadTerminalEngine();
  await expect(f.create({ cols: 0, rows: 2 })).rejects.toThrow();
  const t = await f.create({ cols: 8, rows: 2 });
  try {
    const s = t.snapshot();
    await expect(
      f.restore({ ...s, engineBuild: "unknown" }),
    ).rejects.toBeInstanceOf(UnsupportedSnapshotError);
    await expect(
      f.restore({ ...s, bytes: new Uint8Array([1, 2, 3]) }),
    ).rejects.toThrow();
    t.write(bytes("alive"));
    expect(t.readScreen()).toContain("alive");
  } finally {
    t.dispose();
  }
});
test("replica ignores stale events, rejects gaps, recovers with resync", async () => {
  const f = await loadTerminalEngine(),
    t = await f.create({ cols: 10, rows: 2 });
  const replica = createTerminalReplica(f);
  const base = { attachmentId: "a", generation: 1 };
  try {
    t.write(bytes("first"));
    const snapshot = t.snapshot();
    await replica.apply({
      ...base,
      type: "snapshot",
      position: 0,
      size: t.size,
      snapshot: snapshot.bytes,
    });
    await expect(
      replica.apply({
        ...base,
        type: "output",
        position: 2,
        data: bytes("bad"),
      }),
    ).rejects.toThrow("gap");
    t.write(bytes("!"));
    await replica.apply({
      ...base,
      type: "resync",
      position: 3,
      size: t.size,
      snapshot: t.snapshot().bytes,
    });
    await replica.apply({
      ...base,
      type: "output",
      position: 1,
      data: bytes("old"),
    });
    expect(replica.readScreen()).toBe(t.readScreen());
  } finally {
    replica.dispose();
    t.dispose();
  }
});

test("input mode queries survive snapshots and encode application input", async () => {
  const { encodeKey, encodePaste } = await import("../src/index.js");
  const factory = await loadTerminalEngine();
  const t = await factory.create({ cols: 20, rows: 4 });
  let restored;
  try {
    expect(t.inputModes().bracketedPaste).toBe(false);
    t.write(bytes("\x1b[?1h\x1b[?66h\x1b[?2004h\x1b[?1004h\x1b[?1003h"));
    restored = await factory.restore(t.snapshot());
    expect(restored.inputModes()).toEqual(t.inputModes());
    expect(restored.inputModes()).toMatchObject({
      applicationCursor: true,
      applicationKeypad: true,
      bracketedPaste: true,
      focusEvents: true,
      mouseTracking: "any",
    });
    expect(
      new TextDecoder().decode(
        encodeKey("ArrowUp", restored.inputModes().applicationCursor),
      ),
    ).toBe("\x1bOA");
    expect(
      new TextDecoder().decode(
        encodePaste("hello", restored.inputModes().bracketedPaste),
      ),
    ).toBe("\x1b[200~hello\x1b[201~");
    restored.write(bytes("\x1b[?1l\x1b[?2004l"));
    expect(restored.inputModes().applicationCursor).toBe(false);
    expect(restored.inputModes().bracketedPaste).toBe(false);
  } finally {
    t.dispose();
    restored?.dispose();
  }
});

test("viewport scrolling and cell selections preserve wide graphemes", async () => {
  const factory = await loadTerminalEngine();
  const t = await factory.create({ cols: 12, rows: 3 });
  try {
    t.write(bytes("first\r\nsecond\r\nthird\r\nfourth"));
    expect(t.viewport().totalRows).toBeGreaterThan(3);
    t.scrollViewport("top");
    expect(t.viewport().offset).toBe(0);
    expect(
      t.readSelection({ start: { x: 0, y: 0 }, end: { x: 4, y: 0 } }),
    ).toBe("first");
    t.scrollViewport(1);
    expect(t.viewport().offset).toBe(1);
    t.scrollViewport("bottom");
    t.write(bytes("\r\nA界B"));
    expect(
      t.readSelection({ start: { x: 3, y: 2 }, end: { x: 1, y: 2 } }),
    ).toBe("界B");
    expect(() =>
      t.readSelection({ start: { x: -1, y: 0 }, end: { x: 1, y: 0 } }),
    ).toThrow();
  } finally {
    t.dispose();
  }
});

test("scrollback budgets retain history and survive restore with optional pruning", async () => {
  const factory = await loadTerminalEngine();
  expect(factory.capabilities.scrollbackLimit).toBe(true);
  const data = bytes(
    Array.from({ length: 30000 }, (_, i) => `line ${i}\r\n`).join(""),
  );
  const size = { cols: 120, rows: 40 };
  let defaultRows = 0;
  for (const scrollbackBytes of [undefined, 1_000_000, 10_000_000]) {
    const t = await factory.create(size, { scrollbackBytes });
    try {
      expect(t.scrollback()).toEqual({
        maxBytes: scrollbackBytes ?? 10000,
        rows: 0,
      });
      t.write(data);
      const retained = t.scrollback();
      if (scrollbackBytes === undefined) defaultRows = retained.rows;
      else if (scrollbackBytes === 1_000_000)
        expect(retained.rows).toBe(defaultRows);
      else {
        expect(retained.rows).toBeGreaterThan(5000);
        const snapshot = t.snapshot();
        const restored = await factory.restore(snapshot);
        try {
          expect(restored.scrollback()).toEqual(retained);
          expect(restored.readHistory()).toBe(t.readHistory());
          restored.write(data);
          expect(restored.scrollback().rows).toBeGreaterThan(5000);
        } finally {
          restored.dispose();
        }
        const pruned = await factory.restore(snapshot, {
          scrollbackBytes: 1_000_000,
        });
        try {
          expect(pruned.scrollback().maxBytes).toBe(1_000_000);
          expect(pruned.scrollback().rows).toBeLessThan(retained.rows);
          expect(pruned.readScreen()).toBe(t.readScreen());
        } finally {
          pruned.dispose();
        }
      }
    } finally {
      t.dispose();
    }
  }
});

test("scrollback validates wasm32 budgets, supports zero and guards disposed readers", async () => {
  const factory = await loadTerminalEngine();
  const size = { cols: 20, rows: 3 };
  const t = await factory.create(size, { scrollbackBytes: 0 });
  try {
    t.write(bytes("line\r\n".repeat(1000)));
    expect(t.scrollback()).toEqual({ maxBytes: 0, rows: 0 });
    const snapshot = t.snapshot();
    for (const scrollbackBytes of [-1, 0.5, NaN, Infinity, 0x100000000]) {
      await expect(
        factory.create(size, { scrollbackBytes }),
      ).rejects.toBeInstanceOf(RangeError);
      await expect(
        factory.restore(snapshot, { scrollbackBytes }),
      ).rejects.toBeInstanceOf(RangeError);
    }
    const largest = await factory.create(size, { scrollbackBytes: 0xffffffff });
    try {
      expect(largest.scrollback().maxBytes).toBeNull();
    } finally {
      largest.dispose();
    }
  } finally {
    t.dispose();
  }
  expect(() => t.scrollback()).toThrow("disposed");
});

test("screen formatting preserves styles and graphemes without consuming frame dirtiness", async () => {
  const factory = await loadTerminalEngine();
  expect(factory.capabilities.preview).toBe(true);
  const size = { cols: 20, rows: 3 };
  const t = await factory.create(size);
  const replay = await factory.create(size);
  try {
    t.write(bytes("old history\r\n".repeat(10)));
    t.write(bytes("\x1b[2J\x1b[H\x1b[31;1mA界é\x1b[0m &<end>\r\nsecond"));
    t.frame();
    t.write(bytes("!"));
    t.formatScreen("vt");
    t.formatScreen("html");
    expect(t.frame().changed.map((row) => row.y)).toEqual([1]);
    t.scrollViewport("top");
    const plain = t.formatScreen("plain");
    expect(plain).toBe(t.readScreen());
    expect(plain).not.toContain("old history");
    const vt = t.formatScreen("vt");
    replay.write(bytes(vt.replace(/\r?\n/g, "\r\n")));
    expect(replay.readScreen()).toBe(plain);
    const html = t.formatScreen("html");
    expect(html).toContain("&lt;");
    expect(html).toContain("&amp;");
    // A preview carries the cursor without the cost of building a frame.
    expect(t.cursor()).toEqual(t.frame().cursor);
    expect(t.cursor()).toEqual({ x: 7, y: 1, visible: true });
    t.write(bytes("\x1b[?25l"));
    expect(t.cursor().visible).toBe(false);
    t.write(bytes("\x1b[?25h"));
    t.scrollViewport("bottom");
    const rendered = t.frame();
    expect(rendered.changed.length).toBeGreaterThan(0);
    const first = rendered.changed.find((row) => row.y === 0)!.cells;
    expect(replay.frame().changed[0]!.cells.slice(0, 5)).toEqual(
      first.slice(0, 5),
    );
    expect(t.frame().changed).toHaveLength(0);
  } finally {
    t.dispose();
    replay.dispose();
  }
  expect(() => t.formatScreen("plain")).toThrow("disposed");
  expect(() => t.cursor()).toThrow("disposed");
});
