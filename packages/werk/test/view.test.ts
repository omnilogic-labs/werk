import { expect, test } from "bun:test";
import type { Cell, Frame } from "@werk/terminal";
import {
  createViewRenderer,
  planView,
  statusText,
  type ViewSize,
  type ViewState,
} from "../src/view.js";
const state = (overrides: Partial<ViewState> = {}): ViewState => ({
  writable: true,
  holdsSize: false,
  claimed: false,
  follow: false,
  ...overrides,
});
const cell = (text: string, width = 1): Cell => ({
  text,
  width,
  fg: 0xc0c0c0,
  bg: 0,
  bold: false,
  italic: false,
  underline: false,
  inverse: false,
  strikethrough: false,
});
/** A frame whose every row is delivered, each filled with one repeated glyph. */
function frame(size: ViewSize, glyph = "x", cursor = { x: 0, y: 0 }): Frame {
  return {
    ...size,
    changed: Array.from({ length: size.rows }, (_, y) => ({
      y,
      cells: Array.from({ length: size.cols }, () => cell(glyph)),
    })),
    cursor: { ...cursor, visible: true },
  };
}
/** Every absolute cursor address the output contains, as one-based row/column. */
function addresses(out: string) {
  return [...out.matchAll(/\x1b\[(\d+);(\d+)H/g)].map((m) => ({
    row: Number(m[1]),
    col: Number(m[2]),
  }));
}
/** Glyphs painted per one-based local row, counted by their leading SGR. */
function painted(out: string) {
  const rows = new Map<number, number>();
  for (const segment of out.split(/\x1b\[(?=\d+;\d+H)/).slice(1)) {
    const at = /^(\d+);(\d+)H/.exec(segment);
    if (!at) continue;
    const y = Number(at[1]);
    rows.set(
      y,
      (rows.get(y) ?? 0) + (segment.match(/\x1b\[0;38;2;/g) ?? []).length,
    );
  }
  return rows;
}
function harness(window: ViewSize, initial: ViewState = state()) {
  const writes: string[] = [];
  let current = { ...initial };
  let size = { ...window };
  const view = createViewRenderer({
    write: (data) => writes.push(data),
    window: () => size,
    state: () => current,
  });
  return {
    view,
    writes,
    last: () => writes[writes.length - 1] ?? "",
    all: () => writes.join(""),
    resize(next: ViewSize) {
      size = { ...next };
    },
    set(next: Partial<ViewState>) {
      current = { ...current, ...next };
    },
  };
}
test("a session grid larger than the window is clipped, never wrapped or scrolled", () => {
  const h = harness({ cols: 120, rows: 40 });
  h.view.paint(frame({ cols: 160, rows: 50 }));
  const out = h.last();
  for (const { row, col } of addresses(out)) {
    expect(row).toBeLessThanOrEqual(40);
    expect(col).toBeLessThanOrEqual(120);
  }
  const rows = painted(out);
  // Thirty-nine session rows plus the status row on row forty.
  expect([...rows.keys()].filter((y) => y <= 39).length).toBe(39);
  for (const [y, count] of rows) if (y <= 39) expect(count).toBe(120);
});
test("a wide cell straddling the right edge is dropped rather than half painted", () => {
  const h = harness({ cols: 6, rows: 4 });
  const wide: Frame = {
    cols: 8,
    rows: 1,
    changed: [
      {
        y: 0,
        cells: [
          cell("a"),
          cell("b"),
          cell("c"),
          cell("d"),
          cell("e"),
          cell("あ", 2),
          cell("", 0),
          cell("f"),
        ],
      },
    ],
    cursor: { x: 0, y: 0, visible: true },
  };
  h.view.paint(wide);
  expect(h.last()).toContain("e");
  expect(h.last()).not.toContain("あ");
});
test("the status row names both grids and disappears once they match", () => {
  const h = harness({ cols: 120, rows: 40 });
  h.view.paint(frame({ cols: 160, rows: 50 }));
  expect(h.last()).toContain("session 160x50 · window 120x40");
  h.view.paint(frame({ cols: 120, rows: 40 }));
  expect(h.last()).not.toContain("session 120x40");
  // The row the status occupied is now free for the fortieth session row.
  expect(painted(h.last()).get(40)).toBe(120);
});
test("a grid change clears before repainting so no cell of the old grid lingers", () => {
  const h = harness({ cols: 120, rows: 40 });
  h.view.paint(frame({ cols: 160, rows: 50 }));
  h.writes.length = 0;
  h.view.paint(frame({ cols: 80, rows: 24 }));
  expect(h.last()).toContain("\x1b[2J");
  const rows = painted(h.last());
  expect(rows.size).toBe(25);
  for (const [y, count] of rows) if (y <= 24) expect(count).toBe(80);
});
test("a window change repaints the known grid without a new frame", () => {
  const h = harness({ cols: 120, rows: 40 });
  h.view.paint(frame({ cols: 160, rows: 50 }));
  h.writes.length = 0;
  h.resize({ cols: 40, rows: 10 });
  h.view.refresh();
  expect(h.last()).toContain("\x1b[2J");
  expect(h.last()).toContain("window 40x10");
  const rows = painted(h.last());
  expect([...rows.keys()].filter((y) => y <= 9).length).toBe(9);
  for (const [y, count] of rows) if (y <= 9) expect(count).toBe(40);
});
test("a session grid smaller than the window is painted top left and padded", () => {
  const h = harness({ cols: 120, rows: 40 });
  h.view.paint(frame({ cols: 80, rows: 24 }));
  const rows = painted(h.last());
  expect([...rows.keys()].filter((y) => y <= 24)).toHaveLength(24);
  expect(h.last()).toContain("\x1b[0m\x1b[K");
  expect(h.last()).toContain("session 80x24 · window 120x40");
});
test("the cursor is homed inside the window and hidden outside it", () => {
  const inside = harness({ cols: 120, rows: 40 });
  inside.view.paint(frame({ cols: 160, rows: 50 }, "x", { x: 10, y: 5 }));
  expect(inside.last()).toContain("\x1b[6;11H\x1b[?25h");
  const outside = harness({ cols: 120, rows: 40 });
  outside.view.paint(frame({ cols: 160, rows: 50 }, "x", { x: 150, y: 45 }));
  expect(outside.last()).not.toContain("\x1b[?25h");
  for (const { row, col } of addresses(outside.last())) {
    expect(row).toBeLessThanOrEqual(40);
    expect(col).toBeLessThanOrEqual(120);
  }
});
test("holding the size suppresses the status row while a resize is in flight", () => {
  const h = harness({ cols: 120, rows: 40 }, state({ holdsSize: true }));
  h.view.paint(frame({ cols: 160, rows: 50 }));
  expect(h.last()).not.toContain("window 120x40");
  expect(painted(h.last()).size).toBe(40);
  h.set({ holdsSize: false });
  h.view.refresh();
  expect(h.last()).toContain("session 160x50 · window 120x40");
});
test("the status row says why the grid is not this attachment's to set", () => {
  const session = { cols: 160, rows: 50 },
    window = { cols: 120, rows: 40 };
  expect(statusText(session, window, state())).toBe(
    "session 160x50 · window 120x40 · --claim-size to take it · Ctrl-] detaches",
  );
  expect(statusText(session, window, state({ writable: false }))).toContain(
    "read-only",
  );
  expect(statusText(session, window, state({ follow: true }))).toContain(
    "following",
  );
  expect(statusText(session, window, state({ claimed: true }))).toContain(
    "size claim refused",
  );
});
test("a narrow window keeps the grid sizes and drops the rest of the status", () => {
  const line = statusText(
    { cols: 160, rows: 50 },
    { cols: 34, rows: 12 },
    state(),
  );
  expect(line).toBe("session 160x50 · window 34x12");
  expect(line.length).toBeLessThanOrEqual(34);
  expect(
    statusText({ cols: 160, rows: 50 }, { cols: 8, rows: 12 }, state()).length,
  ).toBeLessThanOrEqual(8);
});
test("a one row window spends it on the session rather than the status", () => {
  const plan = planView(
    { cols: 160, rows: 50 },
    { cols: 120, rows: 1 },
    state(),
  );
  expect(plan.status).toBeUndefined();
  expect(plan.rows).toBe(1);
  expect(plan.cols).toBe(120);
});
