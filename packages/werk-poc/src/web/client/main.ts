// The terminal page: fetch the pinned WASM (the same bytes the daemon
// runs), open the WebSocket, decode the snapshot into a replica, render it,
// and send keys and mouse through the WASM encoders. One replica and one
// render consumer per tab; two tabs on one session each hold their own.
//
// Everything measurable is on `window.__wp` so a browser automation can
// read it: decode timings, paint costs, lag notices, and `stall(ms)`, which
// makes the next message handler busy-loop so backpressure can be forced.

import { GhosttyWasmEngine } from "../../engine/ghostty-wasm/index.ts";
import { isUnsupported } from "../../engine/types.ts";
import { WsTag, type WsCommand, type WsNotice } from "../wire.ts";
import {
  heldButtonOf,
  keyEventFromDom,
  mouseEventFromDom,
  wheelEventFromDom,
} from "./input.ts";
import { CanvasRenderer, type Renderer } from "./renderer.ts";
import { GhosttyWebRenderer } from "./renderer-ghostty-web.ts";
import { Replica, type DecodeTimings } from "./replica.ts";
import { SelectionController } from "./selection-ghostty-web.ts";

/**
 * `?renderer=ghostty-web` paints with the renderer rebased from ghostty-web
 * (findings/m4.md); the minimal one stays the default.
 */
const rendererName =
  new URLSearchParams(location.search).get("renderer") === "ghostty-web"
    ? "ghostty-web"
    : "minimal";

const id = decodeURIComponent(location.pathname.split("/").pop() ?? "");
const statusEl = document.getElementById("status")!;
const wrap = document.getElementById("wrap")!;
const canvas = document.getElementById("term") as HTMLCanvasElement;

interface State {
  status: string;
  title: string;
  argv: string[];
  session: string;
  lag: string;
  timings: DecodeTimings | null;
  notices: string[];
  lagEvents: {
    t: number;
    where: string;
    kind: string;
    droppedBytes?: number;
  }[];
  bell: number;
  snapshots: number;
  outputBytes: number;
  inputBytes: number;
  cols: number;
  rows: number;
  stallUntil: number;
  stalled: number;
  connected: boolean;
}

const state: State = {
  status: "connecting",
  title: "",
  argv: [],
  session: "",
  lag: "",
  timings: null,
  notices: [],
  lagEvents: [],
  bell: 0,
  snapshots: 0,
  outputBytes: 0,
  inputBytes: 0,
  cols: 0,
  rows: 0,
  stallUntil: 0,
  stalled: 0,
  connected: false,
};

let renderer: Renderer;
let replica: Replica;
let ws: WebSocket;
/** Only with the ghostty-web renderer: selection, and the viewport of the last frame. */
let selection: SelectionController | null = null;
let lastViewport: { offset: number; active: boolean } | null = null;

function fmt(ms: number | null): string {
  return ms === null ? "…" : `${ms.toFixed(1)} ms`;
}

function renderStatus(): void {
  const t = state.timings;
  const decode = t
    ? `snapshot ${t.snapshotBytes} B · ready ${fmt(t.readyMs)} · first paint ${fmt(t.firstPaintMs)} (${t.readyRows} rows, ${t.pendingRows} pending) · history ${fmt(t.historyMs)} (${t.pages} pages${t.totalRows !== null ? `, ${t.totalRows} rows` : ""})`
    : "no snapshot yet";
  const paint = renderer
    ? `paint last ${renderer.stats.lastMs.toFixed(2)} ms / max ${renderer.stats.maxMs.toFixed(2)} ms (${renderer.stats.paints} paints)`
    : "";
  const parts = [
    `${id} ${state.status}`,
    `${state.cols}×${state.rows}`,
    rendererName,
    state.title ? `“${state.title}”` : "",
    decode,
    paint,
    state.lag,
    state.notices.at(-1) ?? "",
  ].filter(Boolean);
  statusEl.textContent = parts.join("  |  ");
  statusEl.dataset["status"] = state.status;
}

function gridFor(): { cols: number; rows: number } {
  const r = wrap.getBoundingClientRect();
  return {
    cols: Math.max(2, Math.floor(r.width / renderer.cell.width)),
    rows: Math.max(1, Math.floor(r.height / renderer.cell.height)),
  };
}

function send(bytes: Uint8Array): void {
  if (ws.readyState !== WebSocket.OPEN || bytes.length === 0) return;
  state.inputBytes += bytes.length;
  ws.send(bytes);
}

function sendJson(cmd: WsCommand): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd));
}

function onNotice(n: WsNotice): void {
  switch (n.t) {
    case "hello":
      state.argv = n.argv;
      state.title = n.title;
      state.status = n.corpse ? `corpse (${n.corpse})` : n.status;
      if (n.status === "exited")
        state.status = `exited (${n.signalCode ?? n.exitCode})`;
      document.title = `wp ${id} — ${n.argv.join(" ")}`;
      break;
    case "exited":
      state.status = `exited (${n.signalCode ?? n.exitCode})`;
      break;
    case "lagging":
      state.lag = `lagging (${n.where}, dropped ${n.droppedBytes} B)`;
      state.lagEvents.push({
        t: performance.now(),
        where: n.where,
        kind: "lagging",
        droppedBytes: n.droppedBytes,
      });
      break;
    case "resumed":
      state.lag = `resumed (${n.where}) at ${new Date().toLocaleTimeString()}`;
      state.lagEvents.push({
        t: performance.now(),
        where: n.where,
        kind: "resumed",
      });
      break;
    case "notice":
      state.notices.push(n.message);
      break;
    case "effect":
      if (n.kind === "title") state.title = n.value ?? "";
      if (n.kind === "bell") {
        state.bell++;
        document.body.classList.add("bell");
        setTimeout(() => document.body.classList.remove("bell"), 150);
      }
      break;
    case "error":
      state.status = `error: ${n.message}`;
      break;
  }
  renderStatus();
}

function onMessage(ev: MessageEvent): void {
  // A forced stall, for the backpressure measurement: hold the main thread
  // so the browser stops draining the socket.
  if (state.stallUntil > performance.now()) {
    state.stalled++;
    while (performance.now() < state.stallUntil) {
      /* busy */
    }
    state.stallUntil = 0;
  }
  if (typeof ev.data === "string") {
    onNotice(JSON.parse(ev.data) as WsNotice);
    return;
  }
  const bytes = new Uint8Array(ev.data as ArrayBuffer);
  const payload = bytes.subarray(1);
  if (bytes[0] === WsTag.snapshot) {
    state.snapshots++;
    state.timings = replica.loadSnapshot(payload);
    renderStatus();
  } else if (bytes[0] === WsTag.output) {
    state.outputBytes += payload.length;
    replica.write(payload);
  }
}

function applySize(): void {
  const g = gridFor();
  if (g.cols === state.cols && g.rows === state.rows) return;
  state.cols = g.cols;
  state.rows = g.rows;
  renderer.resizeTo(g.cols, g.rows);
  replica.resize(g.cols, g.rows);
  sendJson({ t: "resize", cols: g.cols, rows: g.rows });
  renderStatus();
}

// -- input -----------------------------------------------------------------

function onKeyDown(e: KeyboardEvent): void {
  if (e.isComposing) return;
  // Keep the browser's own paste and devtools reachable.
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyV") return;
  if (e.code === "F12") return;
  const bytes = engine.encodeKey(keyEventFromDom(e), replica.modes());
  if (isUnsupported(bytes)) return;
  if (bytes.length > 0 || e.code === "Tab" || e.code === "Space") {
    e.preventDefault();
    send(bytes);
    // A key scrolls the viewport back to the active area, as Ghostty does.
    if (selection && lastViewport && !lastViewport.active)
      replica.scrollViewport({ kind: "bottom" });
  }
}

/** Fractional wheel lines carried between events (ghostty-web accumulated these in its Terminal). */
let wheelRemainder = 0;

/**
 * ghostty-web's wheel rule: on the alternate screen send arrow keys (the
 * program scrolls itself); otherwise move the viewport through scrollback.
 * Re-targeted onto libghostty's own viewport scrolling rather than a
 * JavaScript `viewportY`; the smooth-scroll animation was not ported.
 */
function scrollByWheel(e: WheelEvent): void {
  let deltaLines: number;
  if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
    deltaLines = e.deltaY / renderer.cell.height;
  } else if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    deltaLines = e.deltaY;
  } else {
    deltaLines = e.deltaY * state.rows;
  }
  if (replica.activeScreen() === "alternate") {
    const count = Math.min(Math.abs(Math.round(deltaLines)), 5);
    const seq = deltaLines < 0 ? "\x1b[A" : "\x1b[B";
    if (count > 0) send(new TextEncoder().encode(seq.repeat(count)));
    return;
  }
  wheelRemainder += deltaLines;
  const whole = Math.trunc(wheelRemainder);
  if (whole === 0) return;
  wheelRemainder -= whole;
  replica.scrollViewport({ kind: "delta", delta: whole });
}

function onPaste(e: ClipboardEvent): void {
  const text = e.clipboardData?.getData("text");
  if (!text) return;
  e.preventDefault();
  const enc = new TextEncoder();
  const bracketed = replica.modes().bracketedPaste;
  send(
    enc.encode(
      bracketed ? `\x1b[200~${text}\x1b[201~` : text.replace(/\r?\n/g, "\r"),
    ),
  );
}

function mouseOn(): boolean {
  const m = replica.modes().mouseTracking;
  return m !== undefined && m !== "none";
}

function sendMouse(ev: ReturnType<typeof mouseEventFromDom> | null): void {
  if (!ev) return;
  const bytes = engine.encodeMouse(ev, replica.modes());
  if (!isUnsupported(bytes)) send(bytes);
}

let engine: GhosttyWasmEngine;

async function main(): Promise<void> {
  renderStatus();
  const t0 = performance.now();
  const wasm = await fetch("/wasm").then((r) => {
    if (!r.ok) throw new Error(`GET /wasm: ${r.status}`);
    return r.arrayBuffer();
  });
  engine = await GhosttyWasmEngine.load(wasm);
  const loadMs = performance.now() - t0;
  renderer =
    rendererName === "ghostty-web"
      ? new GhosttyWebRenderer(canvas, {
          fontSize: 14,
          requestPaint: () => replica?.requestPaint(),
        })
      : new CanvasRenderer(canvas);
  const g = gridFor();
  state.cols = g.cols;
  state.rows = g.rows;
  renderer.resizeTo(g.cols, g.rows);
  replica = new Replica(
    engine,
    {
      paint: (f) => {
        lastViewport = f.viewport;
        selection?.viewportChanged();
        renderer.paint(f);
      },
      raf: (fn) => requestAnimationFrame(fn),
      defer: (fn) => setTimeout(fn, 0),
      onHistoryDone: () => renderStatus(),
    },
    g,
  );
  state.notices.push(
    `wasm ${(wasm.byteLength / 1024).toFixed(0)} KiB loaded in ${loadMs.toFixed(0)} ms`,
  );
  if (renderer instanceof GhosttyWebRenderer) {
    selection = new SelectionController(renderer, {
      viewportOffset: () => lastViewport?.offset ?? 0,
      cols: () => state.cols,
      rows: () => state.rows,
      textBetween: (a, b) => replica.selectionText(a, b),
      scrollLines: (n) => replica.scrollViewport({ kind: "delta", delta: n }),
      requestPaint: () => replica.requestPaint(),
      // The program gets the mouse when it asked for it, unless Shift is held.
      selectionEnabled: (e) => !mouseOn() || e.shiftKey,
    });
  }

  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(
    `${proto}://${location.host}/ws/${encodeURIComponent(id)}?cols=${g.cols}&rows=${g.rows}`,
  );
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    state.connected = true;
    state.status = "attached";
    renderStatus();
  };
  ws.onmessage = onMessage;
  ws.onclose = (e) => {
    state.connected = false;
    if (!state.status.startsWith("exited") && !state.status.startsWith("error"))
      state.status = `disconnected (${e.code}${e.reason ? ` ${e.reason}` : ""})`;
    renderStatus();
  };
  ws.onerror = () => {
    state.status = "socket error";
    renderStatus();
  };

  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("paste", onPaste);
  canvas.addEventListener("contextmenu", (e) => {
    if (mouseOn()) e.preventDefault();
  });
  canvas.addEventListener("mousedown", (e) => {
    canvas.focus();
    if (mouseOn()) sendMouse(mouseEventFromDom(e, "press", renderer.cell));
  });
  canvas.addEventListener("mouseup", (e) => {
    if (mouseOn()) sendMouse(mouseEventFromDom(e, "release", renderer.cell));
  });
  let lastCell = "";
  canvas.addEventListener("mousemove", (e) => {
    if (!mouseOn()) return;
    const ev = mouseEventFromDom(
      e,
      "motion",
      renderer.cell,
      heldButtonOf(e.buttons),
    );
    // TRACK_LAST_CELL is off in the encoder, so dedupe here.
    const key = `${ev.x},${ev.y},${ev.button}`;
    if (key === lastCell) return;
    lastCell = key;
    sendMouse(ev);
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (mouseOn()) {
        e.preventDefault();
        sendMouse(wheelEventFromDom(e, renderer.cell));
      } else if (selection) {
        e.preventDefault();
        scrollByWheel(e);
      }
    },
    { passive: false },
  );
  new ResizeObserver(() => applySize()).observe(wrap);
  canvas.focus();
}

// For the browser automation and the findings.
(window as unknown as { __wp: unknown }).__wp = {
  state,
  renderer: rendererName,
  stats: () => ({
    status: state.status,
    renderer: rendererName,
    cols: state.cols,
    rows: state.rows,
    viewport: lastViewport,
    timings: state.timings,
    paint: renderer?.stats ?? null,
    snapshots: state.snapshots,
    outputBytes: state.outputBytes,
    inputBytes: state.inputBytes,
    lagEvents: state.lagEvents,
    notices: state.notices,
    bell: state.bell,
    stalled: state.stalled,
    connected: state.connected,
  }),
  /** The next message handler busy-loops for `ms`; the socket backs up behind it. */
  stall: (ms: number) => {
    state.stallUntil = performance.now() + ms;
  },
  /** The replica's viewport as text, for comparing with the daemon's `screen`. */
  text: () => replica?.term?.plainText() ?? null,
  /** One full repaint now, timed, for the paint-cost measurement. */
  repaint: () => {
    const f = replica.frame();
    const term = replica.term;
    if (!f || !term) return null;
    const changed = term.styledCells().map((cells, y) => ({ y, cells }));
    const t0 = performance.now();
    renderer.paint({ ...f, dirtyAll: true, changed });
    return performance.now() - t0;
  },
  send: (text: string) => send(new TextEncoder().encode(text)),
  /** Move the viewport through scrollback (ghostty-web renderer only). */
  scroll: (delta: number) => replica.scrollViewport({ kind: "delta", delta }),
  scrollTo: (where: "top" | "bottom") =>
    replica.scrollViewport({ kind: where }),
  /** Select a viewport range as a drag would, copy it, and return its text (ghostty-web renderer only). */
  select: (x0: number, y0: number, x1: number, y1: number) =>
    selection?.selectViewport(x0, y0, x1, y1) ?? null,
  selection: () => selection?.getSelection() ?? null,
  lastCopied: () => selection?.lastCopied ?? null,
  clearSelection: () => selection?.clearSelection(),
};

main().catch((e) => {
  state.status = `error: ${(e as Error).message}`;
  renderStatus();
});
