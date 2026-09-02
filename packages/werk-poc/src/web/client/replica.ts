// The browser's copy of a session: the same libghostty bytes the daemon
// runs, fed the daemon's snapshot and then the raw output the daemon
// streams after it. No DOM here — the page wires this to a renderer and a
// WebSocket, and a Bun test drives it with neither — so the data path can
// be proved headless.
//
// A snapshot is decoded in two stages (proposal §2): `ready()` gives the
// viewport and the newest page of history, the consumer's first frame is
// painted from that, and the remaining pages are pulled in `next()` calls
// deferred through `defer` so the first paint is presented before history
// finishes. Live output is written straight into the terminal and a paint
// is coalesced through `raf`.

import type {
  Frame,
  RenderConsumer,
  TerminalModes,
  VtEngine,
  VtTerminal,
} from "../../engine/types.ts";
import { isUnsupported } from "../../engine/types.ts";

export interface DecodeTimings {
  snapshotBytes: number;
  /** `decodeState()` + `ready()`. */
  readyMs: number;
  /** From the snapshot's arrival to the end of the first paint, `ready()` included. */
  firstPaintMs: number;
  /** Rows the terminal held after `ready()`, and rows the snapshot still had to prepend. */
  readyRows: number;
  pendingRows: number;
  /** Set once history is done. */
  historyMs: number | null;
  pages: number;
  totalRows: number | null;
}

export interface ReplicaHost {
  /** Draw a frame. Called synchronously from `loadSnapshot` for the first paint, and from `raf` for the rest. */
  paint(frame: Frame): void;
  /** Coalesce a paint: `requestAnimationFrame` in the browser. */
  raf(fn: () => void): void;
  /** Run `fn` in a later task: `setTimeout(fn, 0)` in the browser. */
  defer(fn: () => void): void;
  /** History finished (or was abandoned by a newer snapshot). */
  onHistoryDone?(timings: DecodeTimings): void;
}

/** Reads a row count off the wasm adapter; -1 for an engine without `getNumber`. */
function totalRows(t: VtTerminal): number {
  const f = (t as { getNumber?: (d: string) => number }).getNumber;
  return typeof f === "function" ? f.call(t, "TOTAL_ROWS") : -1;
}

export class Replica {
  term: VtTerminal | null = null;
  private consumer: RenderConsumer | null = null;
  private generation = 0;
  private paintPending = false;
  private cachedModes: TerminalModes | null = null;
  timings: DecodeTimings | null = null;
  /** Bytes of live output applied since the last snapshot. */
  outputBytes = 0;
  cols: number;
  rows: number;

  constructor(
    private readonly engine: VtEngine,
    private readonly host: ReplicaHost,
    size: { cols: number; rows: number },
  ) {
    this.cols = size.cols;
    this.rows = size.rows;
  }

  /**
   * Replace the terminal with the decoded snapshot: dispose the old one,
   * decode to `ready()`, paint once, then pull history in deferred steps.
   * The page's size is applied to the new terminal if the snapshot was
   * taken at another size (the decoded terminal reflows, findings/m1.md);
   * that abandons any history pages still pending, which the decoder
   * reports as pages of 0 rows.
   */
  loadSnapshot(bytes: Uint8Array): DecodeTimings {
    const t0 = performance.now();
    this.dispose();
    const gen = ++this.generation;
    const d = this.engine.decodeState(bytes);
    if (isUnsupported(d)) throw new Error(d.reason);
    const term = d.ready();
    const readyMs = performance.now() - t0;
    const readyRows = totalRows(term);
    const size = (term as { size?: { cols: number; rows: number } }).size;
    // The snapshot's advisory scrollback count, less the page ready() already holds.
    const hist = (
      d as { historyRows?: () => { primary: number | null } }
    ).historyRows?.();
    const pendingRows = Math.max(
      0,
      (hist?.primary ?? 0) - (readyRows - (size?.rows ?? 0)),
    );
    this.term = term;
    this.outputBytes = 0;
    this.cachedModes = null;
    if (size && (size.cols !== this.cols || size.rows !== this.rows))
      term.resize(this.cols, this.rows);
    const c = term.renderConsumer();
    if (isUnsupported(c)) throw new Error(c.reason);
    this.consumer = c;
    this.host.paint(c.frame());
    const timings: DecodeTimings = {
      snapshotBytes: bytes.byteLength,
      readyMs,
      firstPaintMs: performance.now() - t0,
      readyRows,
      pendingRows,
      historyMs: null,
      pages: 0,
      totalRows: null,
    };
    this.timings = timings;

    const t1 = performance.now();
    const step = () => {
      if (gen !== this.generation) return; // a newer snapshot took over
      const page = d.next();
      if (page) {
        timings.pages++;
        this.host.defer(step);
        return;
      }
      timings.historyMs = performance.now() - t1;
      timings.totalRows = totalRows(term);
      this.requestPaint();
      this.host.onHistoryDone?.(timings);
    };
    this.host.defer(step);
    return timings;
  }

  /** Live PTY output after the snapshot point. */
  write(bytes: Uint8Array): void {
    if (!this.term) return;
    this.term.write(bytes);
    this.outputBytes += bytes.length;
    this.cachedModes = null;
    this.requestPaint();
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (!this.term) return;
    this.term.resize(cols, rows);
    this.cachedModes = null;
    this.requestPaint();
  }

  /** The terminal's modes for the input encoders, cached until the next write. */
  modes(): TerminalModes {
    if (!this.term) return {};
    if (!this.cachedModes) {
      const m = this.term.modes();
      this.cachedModes = isUnsupported(m) ? {} : m;
    }
    return this.cachedModes;
  }

  /** One frame now, for a caller that wants to paint synchronously (tests, measurements). */
  frame(): Frame | null {
    return this.consumer ? this.consumer.frame() : null;
  }

  requestPaint(): void {
    if (this.paintPending || !this.consumer) return;
    this.paintPending = true;
    this.host.raf(() => {
      this.paintPending = false;
      if (this.consumer) this.host.paint(this.consumer.frame());
    });
  }

  dispose(): void {
    this.generation++;
    this.consumer?.dispose();
    this.consumer = null;
    this.term?.dispose();
    this.term = null;
  }
}
