/**
 * Painting a session grid into a local window that need not match it.
 *
 * werk spends the bottom row of the local window on one row of chrome: which
 * workspace this is and where on disk it is, and the key that ends the
 * attachment. That row is werk's, so
 * the session grid gets the window less one row, and an attachment that sets the
 * grid asks for that smaller size rather than for the whole window. A window one
 * row tall gives the chrome up, because it has nothing left to frame.
 *
 * An attachment that does not hold the size sees whatever grid the holder set,
 * or the grid the session was created at when nobody holds it at all. The view
 * clips that grid to the area it has, rather than letting a wider row wrap or a
 * taller grid scroll the local terminal, and clears whenever the two grids
 * change relative to each other so cells from a larger grid cannot linger. The
 * chrome names both sizes for as long as they differ, alongside the identity
 * and the hint it always carries.
 *
 * The planning half is pure so it can be exercised without a daemon or a TTY.
 */
import path from "node:path";
import type { Cell, Frame, Renderer } from "@werk/terminal";
import {
  fitWorkspaceReference,
  type WorkspaceReference,
} from "@werk/workspace";

/** Ctrl-] — the key that ends an attachment, said the way the chrome says it. */
export const DETACH_HINT = "Ctrl-] detaches";

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
  /** What the chrome calls this session: its name, or its id until one is known. */
  name?: string;
  /**
   * The workspace this session was started in, when the directory it was
   * started in is one this host laid out. A session running somewhere werk did
   * not make has none, and the chrome falls back to the session name.
   */
  workspace?: WorkspaceReference;
  /**
   * Where the session says it is executing now, when it says. A shell that
   * emits OSC 7 moves this as a person moves around; one that does not leaves
   * it undefined and the chrome shows only the workspace.
   */
  cwd?: string;
}
export interface ViewPlan {
  session: ViewSize;
  window: ViewSize;
  /** Session rows painted, top-aligned in the window. */
  rows: number;
  /** Session columns painted, left-aligned in each row. */
  cols: number;
  /** Zero-based local row carrying the chrome, when there is one. */
  statusRow?: number;
  status?: string;
}
const same = (a: ViewSize, b: ViewSize) =>
  a.cols === b.cols && a.rows === b.rows;
/** A grid the view has been told about. Before the first frame there is none. */
const known = (a: ViewSize) => a.cols > 0 && a.rows > 0;
/** Local rows the chrome takes. A single row window has none to spare. */
export function chromeRows(window: ViewSize): number {
  return window.rows > 1 ? 1 : 0;
}
/**
 * The window less the chrome: the grid a session should be at to fill what is
 * left. It is a function of the window alone, deliberately. Were the row
 * reserved only while the grids differ, a size holding attachment would resize
 * to fill the window, find the grids matching, get the row back, no longer fit,
 * and resize again for as long as it stayed attached.
 */
export function sessionArea(window: ViewSize): ViewSize {
  return {
    cols: window.cols,
    rows: Math.max(1, window.rows - chromeRows(window)),
  };
}
/**
 * Joins as many parts as the width allows, in order, so the widest terminal
 * shows everything and the narrowest still shows the identity and the hint.
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
/** Clamped to the budget, with an ellipsis standing in for what was cut. */
const clamp = (text: string, budget: number) =>
  text.length <= budget ? text : `${text.slice(0, budget - 1)}…`;
/**
 * The identity, clamped so that the hint beside it always fits whole. Below the
 * width that leaves a legible identity there is none at all, because a name cut
 * down to one letter says less than the key that gets you out.
 *
 * A workspace takes the slot when there is one, at the most detailed level the
 * budget allows, so a wide window says which workspace this is and where on
 * disk it is while a narrow one says only its name. The session name is what is
 * left when no workspace can be recovered, and otherwise moves down the row: it
 * is the part a person can most easily infer from what is on the screen.
 */
function identity(state: ViewState, cols: number): string | undefined {
  const budget = cols - DETACH_HINT.length - 3;
  if (budget < 4) return undefined;
  if (state.workspace)
    return (
      fitWorkspaceReference(state.workspace, budget) ??
      clamp(state.workspace.name, budget)
    );
  return state.name ? clamp(state.name, budget) : undefined;
}
/**
 * Where the session says it is executing, when that is somewhere other than the
 * workspace it was started in. Inside the workspace it is relative, because the
 * part a person does not already have from the identity is the part below it;
 * outside, or with no workspace to be relative to, it is the path itself.
 *
 * Separators are made `/` for display so one row reads the same on every
 * platform.
 */
function executing(state: ViewState): string | undefined {
  const { workspace, cwd } = state;
  if (!cwd) return undefined;
  if (!workspace) return `in ${cwd}`;
  const relative = path.relative(workspace.directory, cwd);
  if (relative === "") return undefined;
  if (relative.startsWith("..") || path.isAbsolute(relative))
    return `in ${cwd}`;
  return `in ./${relative.split(path.sep).join("/")}`;
}
/**
 * What the chrome says. The identity and the detach hint are unconditional; the
 * rest reports where the session is executing, then the grids and why this
 * attachment is not in charge of the session's, for as long as they differ. It
 * never names a size holder, because a `size-holder` event does not carry one.
 *
 * The order is a priority ladder, because `fit` stops at the first part that
 * does not fit rather than skipping it. What a person cannot get from the
 * screen in front of them comes first.
 *
 * `area` is what the session grid is measured against and clipped to, which is
 * the window less the chrome rather than the window itself.
 */
export function statusText(
  session: ViewSize,
  area: ViewSize,
  state: ViewState,
): string {
  const parts: string[] = [];
  const who = identity(state, area.cols);
  if (who) parts.push(who);
  parts.push(DETACH_HINT);
  if (!state.writable) parts.push("read-only");
  const where = executing(state);
  if (where) parts.push(where);
  // The session name only when the workspace took the identity slot; otherwise
  // it is already the identity and saying it twice would spend the row on it.
  if (state.workspace && state.name) parts.push(state.name);
  // A holder's mismatch is its own pending resize and corrects itself within a
  // frame or two, so only somebody else's grid is worth reporting. A grid of no
  // size is one no frame has arrived for yet, which is not a mismatch either.
  if (known(session) && !same(session, area) && !state.holdsSize) {
    // One part, so a narrow window can never show a grid with nothing to
    // compare it to.
    parts.push(
      `session ${session.cols}x${session.rows} · space ${area.cols}x${area.rows}`,
    );
    // A read-only attachment asked for no input, so `--claim-size` is not
    // something it could act on and the size policy is not its business.
    if (state.writable) {
      if (state.follow) parts.push("following");
      else if (state.claimed) parts.push("size claim refused");
      else parts.push("--claim-size to take it");
    }
  }
  return fit(parts, area.cols);
}
/**
 * Where everything goes: the chrome on the bottom local row, the session grid
 * clipped into what is left.
 */
export function planView(
  session: ViewSize,
  window: ViewSize,
  state: ViewState,
): ViewPlan {
  const chrome = chromeRows(window);
  const area = sessionArea(window);
  const status = chrome > 0 ? statusText(session, area, state) : undefined;
  const height = Math.max(0, window.rows - chrome);
  return {
    session,
    window,
    rows: Math.min(session.rows, height),
    cols: Math.min(session.cols, area.cols),
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
