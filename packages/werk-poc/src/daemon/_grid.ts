// The fidelity oracle for the daemon tests: what a client would see, rather
// than which bytes carried it there.
//
// A render frame is a full repaint — clear, then the viewport with the cursor
// placed — so replaying everything one attached client received into a fresh
// terminal of the same size reproduces the session's screen exactly. That
// makes the grid the thing to compare, and the grid is what reattach fidelity
// is actually about: a client that comes back sees the right screen, whatever
// sequence of bytes put it there.
//
// It has to be the grid rather than the stream on Windows, where ConPTY
// re-encodes what a child writes instead of passing the bytes through
// (docs/proposals/01-cross-platform.md §3). The same `echo hi` reaches a
// client as a different byte sequence there and leaves the same cells behind.

import type { Client } from "../client/index.ts";
import { loadGhosttyWasmEngine } from "../engine/ghostty-wasm/bun.ts";
import type {
  GhosttyWasmEngine,
  GhosttyWasmTerminal,
} from "../engine/ghostty-wasm/index.ts";
import type { Capture } from "./_testlib.ts";

let engine: GhosttyWasmEngine | null = null;

/** The engine the oracle renders through; loaded once per test process. */
export async function gridEngine(): Promise<GhosttyWasmEngine> {
  return (engine ??= await loadGhosttyWasmEngine());
}

export interface Grid {
  /** The viewport as `rows` lines, trailing whitespace removed. */
  text: string;
  /** The same lines, split, for looking one up by what is on it. */
  rows: string[];
  cursor: { x: number; y: number };
}

const enc = new TextEncoder();

/** The screen `bytes` leave on a fresh terminal of this size. */
export function gridOf(bytes: string | Uint8Array, cols = 80, rows = 24): Grid {
  if (!engine) throw new Error("call gridEngine() first, in beforeAll");
  let term: GhosttyWasmTerminal | null = null;
  try {
    term = engine.create({ cols, rows, scrollback: 1000 });
    term.write(typeof bytes === "string" ? enc.encode(bytes) : bytes);
    const text = term.plainText();
    return { text, rows: text.split("\n"), cursor: term.cursor() };
  } finally {
    term?.dispose();
  }
}

/** The grid a capture's client holds: its latest render, plus the output since. */
export function gridOfCapture(cap: Capture, cols = 80, rows = 24): Grid {
  return gridOf(cap.all, cols, rows);
}

/** The first row satisfying `re`, and the row under it; -1 when there is none. */
export function rowIndex(grid: Grid, re: RegExp): number {
  return grid.rows.findIndex((r) => re.test(r));
}

export interface Agreement {
  ok: boolean;
  /** What differed, for the assertion message; "" when nothing did. */
  detail: string;
}

/**
 * Polls until the client's replay of everything it received shows the same
 * screen as the daemon's own emulator for `id`, or `ms` passes. This is the
 * reattach-fidelity check: the client's cells and cursor, against the
 * session's, with no claim about the bytes in between.
 */
export async function agreesWithDaemon(
  client: Client,
  id: string,
  cap: Capture,
  ms = 3000,
): Promise<Agreement> {
  const end = Date.now() + ms;
  let last: Agreement = { ok: false, detail: "never compared" };
  for (;;) {
    const screen = await client.screen(id);
    const grid = gridOf(cap.all, screen.cols, screen.rows);
    const cursorOk =
      grid.cursor.x === screen.cursor.x && grid.cursor.y === screen.cursor.y;
    if (grid.text === screen.text && cursorOk) return { ok: true, detail: "" };
    const diff = grid.rows
      .map((r, y) =>
        r === (screen.text.split("\n")[y] ?? "")
          ? null
          : `${y}: |${screen.text.split("\n")[y] ?? ""}| vs |${r}|`,
      )
      .filter((x): x is string => x !== null);
    last = {
      ok: false,
      detail:
        `${diff.length} rows differ: ${diff.slice(0, 4).join(" ; ")}` +
        (cursorOk
          ? ""
          : `; cursor (${grid.cursor.x},${grid.cursor.y}) vs (${screen.cursor.x},${screen.cursor.y})`),
    };
    if (Date.now() >= end) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
}
