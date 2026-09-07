/**
 * Painting a session grid into a local window that need not match it.
 *
 * An attachment that does not hold the size sees whatever grid the holder set,
 * or the grid the session was created at when nobody holds it at all. The view
 * clips that grid to the window rather than letting a wider row wrap or a taller
 * grid scroll the local terminal, clears whenever the two grids change relative
 * to each other so cells from a larger grid cannot linger, and spends the bottom
 * local row on a status line for as long as the grids differ.
 *
 * The planning half is pure so it can be exercised without a daemon or a TTY.
 */
import type { Cell, Frame, Renderer } from "@werk/terminal";
export interface ViewSize {
  cols: number;
  rows: number;
}
export interface ViewState {
  /** Input was granted, so this attachment is able to claim the size. */
  writable: boolean;
  /** This attachment currently sets the session grid. */
  holdsSize: boolean;
  /** `--claim-size` asked to take the size, including from a holder. */
  claimed: boolean;
  /** `--follow` declined the size outright. */
  follow: boolean;
}
export interface ViewPlan {
  session: ViewSize;
  window: ViewSize;
  /** Session rows painted, top-aligned in the window. */
  rows: number;
  /** Session columns painted, left-aligned in each row. */
  cols: number;
  /** Zero-based local row carrying the status line, when one is shown. */
  statusRow?: number;
  status?: string;
}
const same = (a: ViewSize, b: ViewSize) =>
  a.cols === b.cols && a.rows === b.rows;
/**
 * Joins as many parts as the width allows, in order, so the widest terminal
 * shows the hint and the narrowest still shows the two grid sizes.
 */
function fit(parts: string[], cols: number): string {
  let line = "";
  for (const part of parts) {
    const next = line ? `${line} · ${part}` : part;
    if (next.length > cols) break;
    line = next;
  }
  return line || (parts[0] ?? "").slice(0, cols);
}
/**
 * What the status line says. It reports both grids and why this one is not in
 * charge of the session's; it never names a holder, because a `size-holder`
 * event does not carry one.
 */
export function statusText(
  session: ViewSize,
  window: ViewSize,
  state: ViewState,
): string {
  const parts = [
    `session ${session.cols}x${session.rows}`,
    `window ${window.cols}x${window.rows}`,
  ];
  if (!state.writable) parts.push("read-only");
  if (state.follow) parts.push("following");
  else if (state.claimed) parts.push("size claim refused");
  else parts.push("--claim-size to take it");
  parts.push("Ctrl-] detaches");
  return fit(parts, window.cols);
}
/**
 * The status line exists only while the grids differ and this attachment is not
 * the one setting them: a holder's mismatch is its own pending resize and
 * corrects itself within a frame or two.
 */
export function planView(
  session: ViewSize,
  window: ViewSize,
  state: ViewState,
): ViewPlan {
  const differ = !same(session, window);
  const status =
    differ && !state.holdsSize && window.rows > 1
      ? statusText(session, window, state)
      : undefined;
  const height = Math.max(0, window.rows - (status === undefined ? 0 : 1));
  return {
    session,
    window,
    rows: Math.min(session.rows, height),
    cols: Math.min(session.cols, window.cols),
    statusRow: status === undefined ? undefined : window.rows - 1,
    status,
  };
}
function sgr(c: Cell): string {
  const fg = c.inverse ? c.bg : c.fg,
    bg = c.inverse ? c.fg : c.bg;
  return `\x1b[0;38;2;${fg >> 16};${(fg >> 8) & 255};${fg & 255};48;2;${bg >> 16};${(bg >> 8) & 255};${bg & 255}${c.bold ? ";1" : ""}${c.italic ? ";3" : ""}${c.underline ? ";4" : ""}${c.strikethrough ? ";9" : ""}m`;
}
export interface ViewRendererOptions {
  write(data: string): void;
  /** The local window, read afresh on every paint. */
  window(): ViewSize;
  state(): ViewState;
}
/**
 * A renderer that also repaints on demand. `refresh()` is what a local window
 * resize or a change of size holder calls: the session grid has not moved, so
 * no frame is coming, but the window it is painted into has.
 */
export interface ViewRenderer extends Renderer {
  refresh(): void;
}
export function createViewRenderer(options: ViewRendererOptions): ViewRenderer {
  let ended = false;
  /** The session grid as last received; rows never delivered stay undefined. */
  let grid: (Cell[] | undefined)[] = [];
  let session: ViewSize = { cols: 0, rows: 0 };
  let plan: ViewPlan | undefined;
  let cursor = { x: 0, y: 0, visible: false };
  const row = (y: number, cells: Cell[], p: ViewPlan) => {
    let out = `\x1b[${y + 1};1H`;
    for (let x = 0; x < cells.length && x < p.cols; x++) {
      const c = cells[x]!;
      // A zero width cell is the tail of a wide one; a wide one straddling the
      // right edge is dropped rather than painted half outside the window.
      if (c.width === 0) continue;
      if (x + c.width > p.cols) break;
      out += sgr(c) + (c.text || " ");
    }
    // Only a session narrower than the window leaves anything to the right.
    return p.cols < p.window.cols ? out + "\x1b[0m\x1b[K" : out;
  };
  const draw = (full: boolean, changed: number[]) => {
    if (ended) return;
    const next = planView(session, options.window(), options.state());
    const clear =
      full ||
      plan === undefined ||
      !same(plan.session, next.session) ||
      !same(plan.window, next.window) ||
      (plan.status === undefined) !== (next.status === undefined);
    const paint = clear
      ? grid.flatMap((cells, y) => (cells && y < next.rows ? [y] : []))
      : changed.filter((y) => y < next.rows);
    let out = "\x1b[?25l\x1b[?7l" + (clear ? "\x1b[2J" : "");
    for (const y of paint) out += row(y, grid[y]!, next);
    if (next.status !== undefined && (clear || next.status !== plan?.status))
      out += `\x1b[${next.statusRow! + 1};1H\x1b[0m\x1b[7m${next.status.padEnd(next.window.cols)}\x1b[0m`;
    out += "\x1b[0m";
    // Homing the cursor outside the painted area would put session output in
    // the status row or below the window, so it is hidden instead.
    if (cursor.x < next.cols && cursor.y < next.rows)
      out +=
        `\x1b[${cursor.y + 1};${cursor.x + 1}H` +
        (cursor.visible ? "\x1b[?25h" : "");
    plan = next;
    options.write(out);
  };
  return {
    paint(frame: Frame) {
      if (ended) return;
      if (frame.cols !== session.cols || frame.rows !== session.rows) {
        session = { cols: frame.cols, rows: frame.rows };
        grid = new Array(frame.rows);
      }
      for (const changed of frame.changed) grid[changed.y] = changed.cells;
      cursor = frame.cursor;
      draw(
        false,
        frame.changed.map((c) => c.y),
      );
    },
    refresh() {
      draw(true, []);
    },
    dispose() {
      if (ended) return;
      ended = true;
      options.write("\x1b[0m\x1b[?25h\x1b[?7h");
    },
  };
}
