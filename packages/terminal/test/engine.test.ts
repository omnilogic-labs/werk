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
