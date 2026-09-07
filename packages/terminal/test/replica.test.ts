import { test, expect } from "bun:test";
import { loadTerminalEngine } from "../src/bun/index.ts";
import { createTerminalReplica, type Frame } from "../src/index.ts";

async function fixture() {
  const factory = await loadTerminalEngine();
  const source = await factory.create({ cols: 20, rows: 3 });
  const snapshot = source.snapshot();
  source.dispose();
  const frames: Frame[] = [];
  const callbacks: (() => void)[] = [];
  let cancelled = 0,
    fail = false;
  const replica = createTerminalReplica(
    factory,
    {
      paint(frame) {
        if (fail) throw new Error("paint failed");
        frames.push(frame);
      },
      dispose() {},
    },
    {
      schedulePaint(callback) {
        callbacks.push(callback);
        return () => {
          cancelled++;
        };
      },
    },
  );
  const base = { attachmentId: "a", generation: 1 };
  await replica.apply({
    ...base,
    type: "snapshot",
    position: 0,
    size: snapshot.size,
    snapshot: snapshot.bytes,
  });
  return {
    replica,
    frames,
    callbacks,
    base,
    cancelled: () => cancelled,
    fail: (value: boolean) => {
      fail = value;
    },
  };
}

test("replica applies a burst immediately and paints once per scheduler tick", async () => {
  const f = await fixture();
  try {
    for (let position = 1; position <= 50; position++)
      await f.replica.apply({
        ...f.base,
        type: "output",
        position,
        data: new TextEncoder().encode("x"),
      });
    expect(f.replica.readScreen()).toContain("xxxxxxxxxxxxxxxxxxxx");
    expect(f.frames).toHaveLength(0);
    expect(f.callbacks).toHaveLength(1);
    f.callbacks.shift()!();
    expect(f.frames).toHaveLength(1);
    expect(f.frames[0]!.changed).toHaveLength(3);
    await expect(
      f.replica.apply({ ...f.base, type: "output", position: 52 }),
    ).rejects.toThrow("gap");
    expect(f.callbacks).toHaveLength(0);
    await f.replica.apply({
      ...f.base,
      type: "output",
      position: 51,
      data: new TextEncoder().encode("!"),
    });
    f.replica.flush();
    expect(f.frames[1]!.changed.map((row) => row.y)).toEqual([2]);
    expect(f.cancelled()).toBe(1);
    f.callbacks.shift()!();
    expect(f.frames).toHaveLength(2);
  } finally {
    f.replica.dispose();
  }
});

test("replica cancels pending paints on disposal and flushes before ended resolves", async () => {
  const f = await fixture();
  await f.replica.apply({ ...f.base, type: "ended", position: 1 });
  expect(f.frames).toHaveLength(1);
  expect(f.cancelled()).toBe(1);
  await f.replica.apply({
    ...f.base,
    type: "output",
    position: 2,
    data: new TextEncoder().encode("x"),
  });
  f.replica.dispose();
  expect(f.cancelled()).toBe(2);
  for (const callback of f.callbacks) callback();
  expect(f.frames).toHaveLength(1);
  f.replica.dispose();
});

test("scheduled paint failures surface through flush without poisoning event application", async () => {
  const f = await fixture();
  try {
    f.fail(true);
    expect(() => f.callbacks.shift()!()).not.toThrow();
    expect(() => f.replica.flush()).toThrow("paint failed");
    f.fail(false);
    await f.replica.apply({
      ...f.base,
      type: "output",
      position: 1,
      data: new TextEncoder().encode("alive"),
    });
    expect(f.replica.readScreen()).toContain("alive");
    f.replica.flush();
    expect(f.frames).toHaveLength(1);
  } finally {
    f.replica.dispose();
  }
});
