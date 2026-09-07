import { expect, test } from "bun:test";
import { renderTable } from "../src/runtime/table.js";

const rows = [
  ["ID", "COMMAND", "STATE"],
  ["a1", "claude", "running"],
  ["bbbb", "sleep 300", "exited"],
];
test("columns align to the widest cell", () => {
  expect(renderTable(rows, { aligned: true })).toBe(
    [
      "ID    COMMAND    STATE",
      "a1    claude     running",
      "bbbb  sleep 300  exited",
    ].join("\n"),
  );
});
test("a pipe gets tab-separated values and no padding", () => {
  expect(renderTable(rows, { aligned: false })).toBe(
    [
      "ID\tCOMMAND\tSTATE",
      "a1\tclaude\trunning",
      "bbbb\tsleep 300\texited",
    ].join("\n"),
  );
});
test("width is display cells, so wide glyphs still line up", () => {
  const out = renderTable(
    [
      ["a", "x"],
      ["日本", "y"],
    ],
    { aligned: true },
  ).split("\n");
  // "日本" occupies four cells, so the one-cell "a" is padded by three more.
  expect(out[0]).toBe("a     x");
  expect(out[1]).toBe("日本  y");
});
test("an emoji counts as the two cells a terminal draws", () => {
  const out = renderTable(
    [
      ["🚀", "x"],
      ["ab", "y"],
    ],
    { aligned: true },
  ).split("\n");
  expect(out[0]).toBe("🚀  x");
  expect(out[1]).toBe("ab  y");
});
test("colour does not change a cell's measured width", () => {
  const red = (s: string) => `\x1b[31m${s}\x1b[39m`;
  const out = renderTable(
    [
      [red("a1"), "x"],
      ["bbbb", "y"],
    ],
    { aligned: true },
  ).split("\n");
  expect(out[0]).toBe(`${red("a1")}    x`);
  expect(out[1]).toBe("bbbb  y");
});
test("the flex column gives up its width and marks the cut", () => {
  const out = renderTable([["id", "a very long command line indeed", "st"]], {
    aligned: true,
    width: 20,
    flex: 1,
  });
  // 20 cells less two 2-cell gaps and the two fixed columns leaves 12 for the flex.
  expect(out).toBe("id  a very long…  st");
  expect(Bun.stringWidth(out)).toBeLessThanOrEqual(20);
});
test("the flex column keeps a readable floor rather than vanishing", () => {
  // Asking for 4 cells cannot be honoured; the flex column stops at eight rather
  // than collapsing to a bare ellipsis.
  const out = renderTable([["id", "a very long command", "st"]], {
    aligned: true,
    width: 4,
    flex: 1,
  });
  expect(out).toBe("id  a very …  st");
  expect(Bun.stringWidth("a very …")).toBe(8);
});
test("no rows renders nothing", () => {
  expect(renderTable([], { aligned: true })).toBe("");
});
