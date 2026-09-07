import { expect, test } from "bun:test";
import type { Cell, Frame } from "@werk/terminal";
import {
  chromeRows,
  createViewRenderer,
  planView,
  sessionArea,
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
test("the chrome names both grids while they differ and keeps the hint once they match", () => {
  const h = harness({ cols: 120, rows: 40 });
  h.view.paint(frame({ cols: 160, rows: 50 }));
  expect(h.last()).toContain("session 160x50 · view 120x39");
  // Thirty-nine rows is the whole window less the chrome, so this grid matches.
  h.view.paint(frame({ cols: 120, rows: 39 }));
  expect(h.last()).not.toContain("session 120x39");
  expect(h.last()).not.toContain("view 120x39");
  expect(h.last()).toContain("Ctrl-] detaches");
  // The chrome keeps the fortieth row whether or not the grids agree.
  expect(painted(h.last()).get(40)).toBe(0);
  expect(painted(h.last()).get(39)).toBe(120);
});
test("the chrome carries the session identity", () => {
  const h = harness({ cols: 120, rows: 40 }, state({ name: "demo" }));
  h.view.paint(frame({ cols: 120, rows: 39 }));
  expect(h.last()).toContain("demo · Ctrl-] detaches");
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
  h.resize({ cols: 60, rows: 10 });
  h.view.refresh();
  expect(h.last()).toContain("\x1b[2J");
  expect(h.last()).toContain("session 160x50 · view 60x9");
  const rows = painted(h.last());
  expect([...rows.keys()].filter((y) => y <= 9).length).toBe(9);
  for (const [y, count] of rows) if (y <= 9) expect(count).toBe(60);
  // Too narrow for the grid pair beside the hint, the hint is what survives.
  h.resize({ cols: 40, rows: 10 });
  h.view.refresh();
  expect(h.last()).toContain("Ctrl-] detaches");
  expect(h.last()).not.toContain("view 40x9");
});
test("a session grid smaller than the window is painted top left and padded", () => {
  const h = harness({ cols: 120, rows: 40 });
  h.view.paint(frame({ cols: 80, rows: 24 }));
  const rows = painted(h.last());
  expect([...rows.keys()].filter((y) => y <= 24)).toHaveLength(24);
  expect(h.last()).toContain("\x1b[0m\x1b[K");
  expect(h.last()).toContain("session 80x24 · view 120x39");
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
test("holding the size drops the grid sizes while a resize is in flight, and keeps the hint", () => {
  const h = harness({ cols: 120, rows: 40 }, state({ holdsSize: true }));
  h.view.paint(frame({ cols: 160, rows: 50 }));
  expect(h.last()).not.toContain("view 120x39");
  expect(h.last()).not.toContain("session 160x50");
  expect(h.last()).toContain("Ctrl-] detaches");
  // The chrome costs its row whoever holds the size.
  const rows = painted(h.last());
  expect([...rows.keys()].filter((y) => y <= 39).length).toBe(39);
  expect(rows.get(40)).toBe(0);
  h.set({ holdsSize: false });
  h.view.refresh();
  expect(h.last()).toContain("session 160x50 · view 120x39");
});
test("the chrome says which session this is, how to leave, and why the grid is not this attachment's to set", () => {
  const session = { cols: 160, rows: 50 },
    area = { cols: 120, rows: 39 },
    named = (o: Partial<ViewState> = {}) => state({ name: "demo", ...o });
  expect(statusText(session, area, named())).toBe(
    "demo · Ctrl-] detaches · session 160x50 · view 120x39 · --claim-size to take it",
  );
  // No name yet, so the line opens on the hint rather than on an empty part.
  expect(statusText(session, area, state())).toBe(
    "Ctrl-] detaches · session 160x50 · view 120x39 · --claim-size to take it",
  );
  // A read-only attachment asked for no input, so it is not offered the size.
  expect(statusText(session, area, named({ writable: false }))).toBe(
    "demo · Ctrl-] detaches · read-only · session 160x50 · view 120x39",
  );
  expect(statusText(session, area, named({ follow: true }))).toEndWith(
    "· following",
  );
  expect(statusText(session, area, named({ claimed: true }))).toEndWith(
    "· size claim refused",
  );
});
test("a narrow window keeps the identity and the hint and drops the grid sizes", () => {
  const session = { cols: 160, rows: 50 };
  const line = statusText(
    session,
    { cols: 34, rows: 12 },
    state({ name: "demo" }),
  );
  expect(line).toBe("demo · Ctrl-] detaches");
  expect(line.length).toBeLessThanOrEqual(34);
  // Narrower than the hint, the hint is what the row spends itself on.
  const tiny = statusText(
    session,
    { cols: 8, rows: 12 },
    state({ name: "demo" }),
  );
  expect(tiny.length).toBeLessThanOrEqual(8);
  expect("Ctrl-] detaches").toStartWith(tiny);
});
test("a long name is truncated rather than crowding the hint out", () => {
  const line = statusText(
    { cols: 160, rows: 50 },
    { cols: 34, rows: 12 },
    state({ name: "a-session-with-a-very-long-name-indeed" }),
  );
  expect(line.length).toBeLessThanOrEqual(34);
  expect(line).toContain("Ctrl-] detaches");
  expect(line).toStartWith("a-session-with-");
  expect(line.split(" · ")[0]).toEndWith("…");
});
test("the chrome takes the bottom row of every window with a row to spare", () => {
  expect(chromeRows({ cols: 120, rows: 40 })).toBe(1);
  expect(chromeRows({ cols: 120, rows: 2 })).toBe(1);
  expect(chromeRows({ cols: 120, rows: 1 })).toBe(0);
  expect(chromeRows({ cols: 120, rows: 0 })).toBe(0);
  expect(sessionArea({ cols: 120, rows: 40 })).toEqual({
    cols: 120,
    rows: 39,
  });
  expect(sessionArea({ cols: 120, rows: 2 })).toEqual({ cols: 120, rows: 1 });
  expect(sessionArea({ cols: 120, rows: 1 })).toEqual({ cols: 120, rows: 1 });
});
test("a grid no frame has arrived for yet is not reported as a mismatch", () => {
  // The view opens on a session of no size; reporting it would flash a 0x0
  // grid across the chrome on every attach.
  const line = statusText(
    { cols: 0, rows: 0 },
    { cols: 120, rows: 39 },
    state({ name: "demo" }),
  );
  expect(line).toBe("demo · Ctrl-] detaches");
});
test("a grid that fills the area is not reported as a mismatch", () => {
  const plan = planView(
    { cols: 120, rows: 39 },
    { cols: 120, rows: 40 },
    state({ name: "demo" }),
  );
  expect(plan.status).toBe("demo · Ctrl-] detaches");
  expect(plan.statusRow).toBe(39);
  expect(plan.rows).toBe(39);
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
