// `wp bench perf`: the performance axis from the proposal, §6. Every
// measurement runs on each engine that loads and has the capability, and
// prints a table; `--json` emits the numbers instead. The sections:
//
//   throughput  VT parse throughput on a fixed corpus, MiB/s, best of five
//   latency     PTY `data` callback -> Unix socket client through the real
//               daemon, against a bare PTY round trip in the same process
//   snapshot    encode size and time, ready() and full decode (wasm only)
//   memory      daemon RSS for 1 / 10 / 50 idle shells, then 50 sessions
//               each fed ~1 MiB, then three rounds of kill-and-recreate
//   slow        the M2 slow-client number re-measured: queue bound, drops, RSS
//   trap        a deliberate wasm trap in one terminal with another live on
//               the same instance: does the other keep working?
//
//   bun run bench/perf.ts [--only throughput,latency,...] [--json] [--quick]
//
// Daemons run on temporary directories; the user's real daemon is untouched.

import fs from "node:fs";
import path from "node:path";
import { engineIds, getEngine } from "../src/engine/all.ts";
import { ghosttyWasmBytes } from "../src/engine/ghostty-wasm/bytes.ts";
import {
  GhosttyWasmEngine,
  type GhosttyWasmTerminal,
} from "../src/engine/ghostty-wasm/index.ts";
import {
  isUnsupported,
  type VtEngine,
  type VtTerminal,
} from "../src/engine/types.ts";
import type { DaemonStats } from "../src/client/index.ts";
import { readCast } from "./cast.ts";
import { CORPUS } from "./corpus/index.ts";
import {
  cpuModel,
  kernel,
  killAndRemove,
  mib,
  ms,
  pct,
  readRss,
  sleep,
  table,
  tempDaemon,
  waitFor,
  waitForScreen,
} from "./_lib.ts";

const enc = new TextEncoder();
const CORPUS_DIR = path.join(import.meta.dir, "corpus");

export type Section =
  "throughput" | "latency" | "snapshot" | "memory" | "slow" | "trap";
export const SECTIONS: Section[] = [
  "throughput",
  "latency",
  "snapshot",
  "memory",
  "slow",
  "trap",
];

export interface PerfOptions {
  only?: Section[];
  json?: boolean;
  /** Tiny parameters, for the smoke test. */
  quick?: boolean;
  /** Internal: run one trap step in this process and print a JSON line. */
  trapChild?: string;
  out?: (line: string) => void;
}

export interface PerfReport {
  bun: string;
  kernel: string;
  cpu: string;
  quick: boolean;
  engines: string[];
  loadErrors: Record<string, string>;
  throughput?: ThroughputRow[];
  latency?: LatencyReport;
  snapshot?: SnapshotRow[];
  memory?: MemoryReport;
  slow?: SlowReport;
  trap?: TrapReport;
  /** The tables, as printed. */
  tables: string;
}

// ------------------------------------------------------------ throughput

export interface ThroughputRow {
  stream: string;
  bytes: number;
  size: string;
  engine: string;
  /** MiB/s, best of the runs. */
  best: number;
  median: number;
  runs: number;
}

function tile(parts: Uint8Array[], atLeast: number): Uint8Array {
  const one = Buffer.concat(parts);
  const reps = Math.max(1, Math.ceil(atLeast / one.length));
  return Buffer.concat(Array.from({ length: reps }, () => one));
}

/** Every corpus case's output events, concatenated: real programs and the synthetic cases alike. */
function corpusStream(atLeast: number): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const c of CORPUS) {
    const cast = readCast(path.join(CORPUS_DIR, c.file));
    for (const e of cast.events) if (e.kind === "output") parts.push(e.bytes);
    parts.push(enc.encode("\x1b[0m\x1b[?1049l\x1b[H\x1b[2J"));
  }
  return tile(parts, atLeast);
}

function plainStream(atLeast: number): Uint8Array {
  const words =
    "the quick brown fox jumps over the lazy dog while bun parses bytes into cells".split(
      " ",
    );
  const lines: string[] = [];
  let n = 0;
  for (let i = 0; i < 2000; i++) {
    let line = "";
    while (line.length < 76) line += words[n++ % words.length] + " ";
    lines.push(line.trimEnd() + "\r\n");
  }
  return tile([enc.encode(lines.join(""))], atLeast);
}

function sgrStream(atLeast: number): Uint8Array {
  const lines: string[] = [];
  for (let i = 0; i < 2000; i++) {
    let line = "";
    for (let c = 0; c < 8; c++) {
      const fg = (i * 7 + c * 31) % 256;
      const r = (i + c) % 256;
      line += `\x1b[38;5;${fg}m\x1b[48;2;${r};${(r * 3) % 256};${(r * 5) % 256}m${c % 2 ? "\x1b[1m" : "\x1b[4m"}word${c}\x1b[0m `;
    }
    lines.push(line + "\r\n");
  }
  return tile([enc.encode(lines.join(""))], atLeast);
}

/** xterm.js logs a "parsing error" object to the console for every DEL inside a CSI (the `c0-controls` case has several); the timing loop does not want that on stdout. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

async function feed(
  term: VtTerminal,
  bytes: Uint8Array,
  chunk = 65536,
): Promise<number> {
  return quietly(async () => {
    const t0 = performance.now();
    for (let off = 0; off < bytes.length; off += chunk)
      term.write(bytes.subarray(off, Math.min(bytes.length, off + chunk)));
    const flush = (term as { flush?: () => Promise<void> }).flush;
    if (typeof flush === "function") await flush.call(term);
    return performance.now() - t0;
  });
}

async function throughput(
  engines: VtEngine[],
  quick: boolean,
): Promise<ThroughputRow[]> {
  const target = quick ? 256 * 1024 : 4 * 1048576;
  const runs = quick ? 2 : 5;
  const streams: [string, Uint8Array][] = [
    ["corpus (23 cases, tiled)", corpusStream(target)],
    ["plain text", plainStream(target)],
    ["SGR-heavy", sgrStream(target)],
  ];
  const sizes: [number, number][] = [
    [80, 24],
    [200, 50],
  ];
  const rows: ThroughputRow[] = [];
  for (const [name, bytes] of streams)
    for (const [cols, rowsN] of sizes)
      for (const engine of engines) {
        const rates: number[] = [];
        for (let r = 0; r < runs; r++) {
          const term = engine.create({ cols, rows: rowsN, scrollback: 2000 });
          const elapsed = await feed(term, bytes);
          term.dispose();
          rates.push(bytes.length / 1048576 / (elapsed / 1000));
        }
        rows.push({
          stream: name,
          bytes: bytes.length,
          size: `${cols}×${rowsN}`,
          engine: engine.id,
          best: Math.max(...rates),
          median: pct(rates, 0.5),
          runs,
        });
      }
  return rows;
}

// --------------------------------------------------------------- latency

export interface LatencyStat {
  n: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

export interface LatencyReport {
  iterations: number;
  /** `terminal.write` -> `data` callback, in this process; M0's path A. */
  bare: LatencyStat;
  /** client -> daemon socket -> PTY -> cat -> PTY -> daemon -> socket -> client. */
  daemon: LatencyStat;
  dtach: string;
}

function stat(us: number[]): LatencyStat {
  return {
    n: us.length,
    p50: pct(us, 0.5),
    p90: pct(us, 0.9),
    p99: pct(us, 0.99),
    max: Math.max(...us),
  };
}

function echoWaiter() {
  let resolve: (() => void) | null = null;
  return {
    got: () => {
      const r = resolve;
      resolve = null;
      r?.();
    },
    wait: () => new Promise<void>((r) => (resolve = r)),
  };
}

async function measureEcho(
  send: (b: Uint8Array) => void,
  wait: () => Promise<void>,
  n: number,
): Promise<LatencyStat> {
  const us: number[] = [];
  const b = new Uint8Array([0x61]);
  for (let i = 0; i < n; i++) {
    const t = Bun.nanoseconds();
    const p = wait();
    send(b);
    await p;
    us.push((Bun.nanoseconds() - t) / 1000);
  }
  return stat(us.slice(Math.floor(n / 10))); // drop warm-up
}

async function latency(quick: boolean): Promise<LatencyReport> {
  const n = quick ? 100 : 2000;

  // A: the bare PTY round trip in this process.
  const a = echoWaiter();
  const child = Bun.spawn(
    ["sh", "-c", "stty raw -echo; echo READY; exec cat"],
    {
      terminal: {
        data: (_t, d) => {
          if (d.includes(0x61)) a.got();
        },
      },
    },
  );
  await sleep(300);
  const bare = await measureEcho((b) => child.terminal!.write(b), a.wait, n);
  child.kill("SIGKILL");
  await child.exited;
  child.terminal!.close();

  // B: through the real daemon.
  const d = await tempDaemon({ prefix: "wp-perf-lat-" });
  try {
    const { id } = await d.client.run({
      argv: ["sh", "-c", "stty raw -echo; echo READY; exec cat"],
      cols: 80,
      rows: 24,
    });
    await waitForScreen(d.client, id, "READY");
    const w = echoWaiter();
    const att = await d.client.attach(id, {
      cols: 80,
      rows: 24,
      onOutput: (bytes) => {
        if (bytes.includes(0x61)) w.got();
      },
    });
    const daemon = await measureEcho((b) => att.input(b), w.wait, n);
    await att.detach();
    return {
      iterations: n,
      bare,
      daemon,
      dtach: Bun.which("dtach")
        ? "present, not measured"
        : "not installed, and not installed for this run; the bare-PTY row is the floor",
    };
  } finally {
    await d.stop();
  }
}

// -------------------------------------------------------------- snapshot

export interface SnapshotRow {
  session: string;
  rows: number;
  bytes: number;
  encodeMinMs: number;
  encodeMedianMs: number;
  readyMs: number;
  readyRows: number;
  fullDecodeMs: number;
  pages: number;
  roundTrip: boolean;
}

function idleShell(engine: GhosttyWasmEngine): GhosttyWasmTerminal {
  const t = engine.create({ cols: 80, rows: 24, scrollback: 2000 });
  t.write(enc.encode("$ ls\r\nREADME.md  package.json  src\r\n$ "));
  return t;
}

function plainLines(engine: GhosttyWasmEngine, n: number): GhosttyWasmTerminal {
  const t = engine.create({ cols: 80, rows: 24, scrollback: 2000 });
  for (let i = 1; i <= n; i++) t.write(enc.encode(`${i}\r\n`));
  return t;
}

/** Every cell on every row carries its own colour: the densest case. */
function perCellStyled(
  engine: GhosttyWasmEngine,
  n: number,
): GhosttyWasmTerminal {
  const t = engine.create({ cols: 80, rows: 24, scrollback: 2000 });
  for (let i = 0; i < n; i++) {
    let line = "";
    for (let c = 0; c < 80; c++)
      line += `\x1b[38;5;${(i + c) % 256}m${String.fromCharCode(97 + ((i + c) % 26))}`;
    t.write(enc.encode(line + "\x1b[0m\r\n"));
  }
  return t;
}

async function snapshot(quick: boolean): Promise<SnapshotRow[]> {
  const engine = await GhosttyWasmEngine.load(await ghosttyWasmBytes());
  const lines = quick ? 300 : 3000;
  const cases: [string, () => GhosttyWasmTerminal][] = [
    ["idle shell", () => idleShell(engine)],
    [
      `${lines.toLocaleString("en-GB")} plain lines`,
      () => plainLines(engine, lines),
    ],
    [
      `${lines.toLocaleString("en-GB")} per-cell-styled lines`,
      () => perCellStyled(engine, lines),
    ],
  ];
  const rows: SnapshotRow[] = [];
  for (const [name, make] of cases) {
    const t = make();
    const times: number[] = [];
    let bytes = 0;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const r = t.encodeState();
      times.push(performance.now() - t0);
      if (isUnsupported(r)) throw new Error(r.reason);
      bytes = r.byteLength;
    }
    const snap = t.encodeState() as Uint8Array;
    const t1 = performance.now();
    const d = engine.decodeState(snap);
    if (isUnsupported(d)) throw new Error(d.reason);
    const u = d.ready();
    const readyMs = performance.now() - t1;
    let pages = 0;
    for (let p = d.next(); p; p = d.next()) pages++;
    const fullDecodeMs = performance.now() - t1;
    rows.push({
      session: name,
      rows: t.getNumber("TOTAL_ROWS"),
      bytes,
      encodeMinMs: Math.min(...times),
      encodeMedianMs: pct(times, 0.5),
      readyMs,
      readyRows: u.getNumber("TOTAL_ROWS"),
      fullDecodeMs,
      pages,
      roundTrip:
        u.fullText() === t.fullText() && u.plainText() === t.plainText(),
    });
    t.dispose();
    u.dispose();
  }
  return rows;
}

// ---------------------------------------------------------------- memory

export interface MemoryPoint {
  label: string;
  sessions: number;
  rss: number;
  wasm: number | null;
  heapUsed: number;
  /** RSS delta per session against the previous point, when there is one. */
  perSession: number | null;
}

export interface MemoryReport {
  baseline: { rss: number; wasm: number | null };
  idle: MemoryPoint[];
  scrollback: MemoryPoint[];
  scrollbackBytesPerSession: number;
  churn: {
    round: number;
    rss: number;
    rssAfterGc: number;
    wasm: number | null;
    heapUsed: number;
  }[];
  counts: number[];
}

const SCROLLBACK_LINES = 150_000; // `seq 1 150000` is about 1 MiB

async function memory(quick: boolean): Promise<MemoryReport> {
  const counts = quick ? [1, 2, 4] : [1, 10, 50];
  const seqLines = quick ? 20_000 : SCROLLBACK_LINES;
  const d = await tempDaemon({ prefix: "wp-perf-mem-" });
  try {
    const point = async (
      label: string,
      n: number,
      prev: MemoryPoint | null,
    ): Promise<MemoryPoint> => {
      const s = await d.client.stats();
      const rss = s.rssBytes ?? 0;
      return {
        label,
        sessions: n,
        rss,
        wasm: s.wasmMemoryBytes,
        heapUsed: s.memory.heapUsed,
        perSession:
          prev && n > prev.sessions
            ? (rss - prev.rss) / (n - prev.sessions)
            : null,
      };
    };
    const base = await d.client.stats();
    const baseline = { rss: base.rssBytes ?? 0, wasm: base.wasmMemoryBytes };

    // Idle shells.
    const ids: string[] = [];
    const idle: MemoryPoint[] = [];
    let prev: MemoryPoint | null = null;
    for (const n of counts) {
      while (ids.length < n) {
        const { id } = await d.client.run({ argv: ["sh"], cols: 80, rows: 24 });
        ids.push(id);
      }
      for (const id of ids) await waitForScreen(d.client, id, "$", 5000);
      await sleep(300);
      prev = await point(`${n} idle sh`, n, prev);
      idle.push(prev);
    }
    for (const id of ids) await killAndRemove(d.client, id);
    ids.length = 0;

    // Each session fed ~1 MiB, then idling in a shell.
    const seqArgv = ["sh", "-c", `seq 1 ${seqLines}; exec sh`];
    const fill = async (n: number) => {
      while (ids.length < n) {
        const { id } = await d.client.run({
          argv: seqArgv,
          cols: 80,
          rows: 24,
        });
        ids.push(id);
      }
      for (const id of ids)
        await waitForScreen(d.client, id, `${seqLines}`, 60_000);
      await sleep(300);
    };
    const scrollback: MemoryPoint[] = [];
    prev = null;
    for (const n of counts) {
      await fill(n);
      prev = await point(`${n} × seq (~${mib(seqLines * 7)})`, n, prev);
      scrollback.push(prev);
    }

    // Churn: kill and re-create all of them, three times.
    const churn: MemoryReport["churn"] = [];
    const n = counts[counts.length - 1]!;
    for (let round = 1; round <= 3; round++) {
      for (const id of ids) await killAndRemove(d.client, id);
      ids.length = 0;
      await fill(n);
      const s = await d.client.stats();
      const g = await d.client.stats({ gc: true });
      churn.push({
        round,
        rss: s.rssBytes ?? 0,
        rssAfterGc: g.rssBytes ?? 0,
        wasm: g.wasmMemoryBytes,
        heapUsed: g.memory.heapUsed,
      });
    }
    for (const id of ids) await killAndRemove(d.client, id);
    return {
      baseline,
      idle,
      scrollback,
      scrollbackBytesPerSession: seqLines * 7,
      churn,
      counts,
    };
  } finally {
    await d.stop();
  }
}

// ------------------------------------------------------------------ slow

export interface SlowReport {
  queueBound: number;
  floodBytes: number;
  fastReceived: number;
  fastLags: number;
  slow: {
    maxQueuedBytes: number;
    droppedBytes: number;
    lagCount: number;
    shortWrites: number;
    drains: number;
    firstShortWriteAfterBytes: number | null;
    lastDrainLatencyMs: number | null;
    bytesSent: number;
  };
  slowRenders: number;
  slowResumed: number;
  rss: { before: number; peakDuring: number; after: number };
  ms: number;
}

async function slowClient(quick: boolean): Promise<SlowReport> {
  const size = quick ? "512K" : "8M";
  const d = await tempDaemon({ prefix: "wp-perf-slow-" });
  try {
    const { id } = await d.client.run({
      argv: ["sh", "-c", `sleep 1; yes | head -c ${size}; sleep 1`],
      cols: 80,
      rows: 24,
    });
    const before = (await d.client.stats()).rssBytes ?? 0;
    const fast = await d.connect();
    const slow = await d.connect();
    let fastBytes = 0;
    let fastLags = 0;
    let exited = false;
    await fast.attach(id, {
      cols: 80,
      rows: 24,
      onOutput: (b) => (fastBytes += b.length),
      onLag: () => fastLags++,
      onExited: () => (exited = true),
    });
    let slowRenders = 0;
    let slowResumed = 0;
    await slow.attach(id, {
      cols: 80,
      rows: 24,
      onRender: () => slowRenders++,
      onResumed: () => slowResumed++,
    });
    slow.pauseReading();
    const t0 = performance.now();
    let peak = before;
    await waitFor(
      async () => {
        peak = Math.max(peak, (await d.client.stats()).rssBytes ?? 0);
        return exited;
      },
      120_000,
      100,
    );
    const elapsed = performance.now() - t0;
    const during = await d.client.stats();
    const slowConn =
      during.connections.find((c) => c.attached === id && c.lagCount > 0) ??
      during.connections
        .filter((c) => c.attached === id)
        .sort((a, b) => b.droppedBytes - a.droppedBytes)[0]!;
    slow.resumeReading();
    await waitFor(() => slowResumed > 0, 5000);
    const afterStats = await d.client.stats();
    const after = afterStats.rssBytes ?? 0;
    // Drains and the drain latency exist only once the slow client reads again.
    const slowAfter =
      afterStats.connections.find((c) => c.attached === id && c.lagCount > 0) ??
      slowConn;
    fast.close();
    slow.close();
    return {
      queueBound: during.queueBound,
      floodBytes: fastBytes,
      fastReceived: fastBytes,
      fastLags,
      slow: {
        maxQueuedBytes: slowConn.maxQueuedBytes,
        droppedBytes: slowConn.droppedBytes,
        lagCount: slowConn.lagCount,
        shortWrites: slowAfter.shortWrites,
        drains: slowAfter.drains,
        firstShortWriteAfterBytes: slowConn.firstShortWriteAfterBytes,
        lastDrainLatencyMs: slowAfter.lastDrainLatencyMs,
        bytesSent: slowAfter.bytesSent,
      },
      slowRenders,
      slowResumed,
      rss: { before, peakDuring: peak, after },
      ms: elapsed,
    };
  } finally {
    await d.stop();
  }
}

// ------------------------------------------------------------------ trap
//
// The proposal's §8 row: "a wasm trap in one session poisons the shared
// instance -> instance-per-session". The daemon holds one WebAssembly
// instance for the ghostty-wasm engine and every wasm session's terminal
// lives in it (getEngine returns one engine; Session.create calls into it),
// so a poisoned instance is every wasm session at once. These steps drive
// deliberate faults on a shared instance with a second terminal live beside
// the target, and after each one check whether that other terminal - and a
// freshly created one - still read and write correctly.

export interface TrapStep {
  what: string;
  /** What the faulting call did: an error class, or a result code, or "returned". */
  outcome: string;
  ms: number;
  /** The other terminal on the same instance still reads and writes correctly. */
  otherOk: boolean;
  /** A terminal created fresh on the same instance after the fault still works. */
  freshOk: boolean;
  memoryBytes: number;
}

export interface TrapReport {
  steps: TrapStep[];
  /** How many repeats of a single trapping call it took to poison the instance (a fresh create then throws), or null if it survived the cap. */
  poisonAfterRepeats: number | null;
  poisonRepeatCap: number;
  /** The absurd resize, run in a child process under a timeout. */
  hugeResize: {
    outcome: string;
    ms: number;
    peakRss: number;
    timeoutMs: number;
  };
  /** Whether the daemon's PTY hot path catches a throw from `write` (by reading the source). */
  daemonCatches: boolean;
}

const PROBE = enc.encode(
  "\x1b[1;31mred\x1b[0m plain \x1b[4mul\x1b[0m 日本 😀\r\n" +
    Array.from(
      { length: 40 },
      (_, i) => `line ${i} \x1b[38;5;${i}mcolour\x1b[0m\r\n`,
    ).join("") +
    "\x1b[?1049h\x1b[Hlast\x1b[?1049l",
);

function fingerprint(t: VtTerminal): string {
  return JSON.stringify([t.plainText(), t.styledCells()]);
}

const HUGE_RESIZE_TIMEOUT_MS = 30_000;

/** `--trap-child resize-huge`: the resize that may never return, in a process of its own. */
export async function trapChild(step: string): Promise<void> {
  const engine = await GhosttyWasmEngine.load(await ghosttyWasmBytes());
  const g = engine.module;
  const a = engine.create({ cols: 80, rows: 24, scrollback: 500 });
  a.write(PROBE);
  const t0 = performance.now();
  let outcome: string;
  try {
    if (step !== "resize-huge") throw new Error(`unknown trap step ${step}`);
    const r = g.call(
      "ghostty_terminal_resize",
      a.rawHandle(),
      65535,
      65535,
      8,
      16,
    );
    outcome = `returned ${r} (${g.resultName(r)})`;
  } catch (e) {
    outcome = `${(e as Error).constructor.name}: ${(e as Error).message}`;
  }
  console.log(
    JSON.stringify({
      outcome,
      ms: performance.now() - t0,
      memoryBytes: g.memory.buffer.byteLength,
    }),
  );
}

async function hugeResizeInChild(): Promise<TrapReport["hugeResize"]> {
  const isCompiled = import.meta.path.startsWith("/$bunfs/");
  const argv = isCompiled
    ? [process.execPath, "bench", "perf", "--trap-child", "resize-huge"]
    : [
        process.execPath,
        "run",
        import.meta.path,
        "--trap-child",
        "resize-huge",
      ];
  const t0 = performance.now();
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  let peakRss = 0;
  let done = false;
  const text = proc.stdout
    ? new Response(proc.stdout).text()
    : Promise.resolve("");
  void proc.exited.then(() => (done = true));
  while (!done && performance.now() - t0 < HUGE_RESIZE_TIMEOUT_MS) {
    peakRss = Math.max(peakRss, readRss(proc.pid) ?? 0);
    await sleep(100);
  }
  if (!done) {
    proc.kill("SIGKILL");
    await proc.exited;
    return {
      outcome: `did not return within ${HUGE_RESIZE_TIMEOUT_MS / 1000} s; killed`,
      ms: performance.now() - t0,
      peakRss,
      timeoutMs: HUGE_RESIZE_TIMEOUT_MS,
    };
  }
  const line = (await text).trim().split("\n").pop() ?? "";
  try {
    const r = JSON.parse(line) as { outcome: string; ms: number };
    return {
      outcome: r.outcome,
      ms: r.ms,
      peakRss,
      timeoutMs: HUGE_RESIZE_TIMEOUT_MS,
    };
  } catch {
    return {
      outcome: `child exited ${proc.exitCode} with ${JSON.stringify(line)}`,
      ms: performance.now() - t0,
      peakRss,
      timeoutMs: HUGE_RESIZE_TIMEOUT_MS,
    };
  }
}

/**
 * One faulting call on a shared instance, then a health check of the other
 * terminal and of a fresh one. Every operation is guarded: a poisoned
 * instance throws on the very next call, which is the datum, not a crash.
 */
function faultStep(
  shared: GhosttyWasmEngine,
  other: VtTerminal,
  otherBefore: string,
  expected: string,
  what: string,
  fn: () => number | void,
): TrapStep {
  const g = shared.module;
  const t0 = performance.now();
  let outcome: string;
  try {
    const r = fn();
    outcome =
      typeof r === "number" ? `returned ${r} (${g.resultName(r)})` : "returned";
  } catch (e) {
    outcome = `${(e as Error).constructor.name}: ${(e as Error).message}`;
  }
  const stepMs = performance.now() - t0;
  let otherOk = false;
  try {
    other.write(enc.encode("\x1b[2J\x1b[H"));
    other.write(PROBE);
    otherOk = fingerprint(other) === otherBefore;
  } catch {}
  let freshOk = false;
  try {
    const f = shared.create({ cols: 80, rows: 24, scrollback: 500 });
    f.write(PROBE);
    freshOk = fingerprint(f) === expected;
    f.dispose();
  } catch {}
  let mem = 0;
  try {
    mem = g.memory.buffer.byteLength;
  } catch {}
  return { what, outcome, ms: stepMs, otherOk, freshOk, memoryBytes: mem };
}

async function trap(): Promise<TrapReport> {
  const bytes = await ghosttyWasmBytes();
  const hugeResize = await hugeResizeInChild();

  const pristine = await GhosttyWasmEngine.load(bytes);
  const ref = pristine.create({ cols: 80, rows: 24, scrollback: 500 });
  ref.write(PROBE);
  const expected = fingerprint(ref);
  ref.dispose();

  // Each single-fault step gets its own instance, since a fault can poison
  // one: "does the other terminal survive THIS fault" needs a healthy start.
  const singles: {
    what: string;
    fn: (
      e: GhosttyWasmEngine,
      target: VtTerminal,
      inPtr: number,
    ) => number | void;
  }[] = [
    {
      what: "vt_write, handle far outside memory (0xFFFFF000)",
      fn: (e, _t, p) =>
        e.module.call("ghostty_terminal_vt_write", 0xfffff000, p, PROBE.length),
    },
    {
      what: "vt_write on a live terminal, input pointer past memory",
      fn: (e, t) =>
        e.module.call(
          "ghostty_terminal_vt_write",
          (t as GhosttyWasmTerminal).rawHandle(),
          e.module.memory.buffer.byteLength - 8,
          4096,
        ),
    },
    {
      what: "resize to 0x0",
      fn: (e, t) =>
        e.module.call(
          "ghostty_terminal_resize",
          (t as GhosttyWasmTerminal).rawHandle(),
          0,
          0,
          8,
          16,
        ),
    },
    {
      what: "vt_write on a freed handle (use after free)",
      fn: (e, _t, p) => {
        const b = e.create({ cols: 80, rows: 24, scrollback: 500 });
        const h = b.rawHandle();
        b.dispose();
        return e.module.call("ghostty_terminal_vt_write", h, p, PROBE.length);
      },
    },
    {
      what: "terminal_free on a freed handle (double free)",
      fn: (e) => {
        const b = e.create({ cols: 80, rows: 24, scrollback: 500 });
        const h = b.rawHandle();
        b.dispose();
        return e.module.call("ghostty_terminal_free", h);
      },
    },
  ];
  const steps: TrapStep[] = [];
  for (const s of singles) {
    const shared = await GhosttyWasmEngine.load(bytes);
    const other = shared.create({ cols: 80, rows: 24, scrollback: 500 });
    other.write(PROBE);
    const otherBefore = fingerprint(other);
    const inPtr = shared.module.allocBytes(PROBE);
    const target = shared.create({ cols: 80, rows: 24, scrollback: 500 });
    target.write(PROBE);
    steps.push(
      faultStep(shared, other, otherBefore, expected, s.what, () =>
        s.fn(shared, target, inPtr),
      ),
    );
  }

  // The headline: repeat one trapping call until a fresh terminal on the
  // same instance stops working. A trap unwinds the JS frames but not the
  // module's own shadow-stack pointer, so each trap leaks a little of it.
  const cap = 20_000;
  const poison = await GhosttyWasmEngine.load(bytes);
  const pg = poison.module;
  const pin = pg.allocBytes(PROBE);
  const healthy = () => {
    try {
      const f = poison.create({ cols: 80, rows: 24, scrollback: 500 });
      f.write(PROBE);
      const ok = fingerprint(f) === expected;
      f.dispose();
      return ok;
    } catch {
      return false;
    }
  };
  let poisonAfterRepeats: number | null = null;
  for (let i = 1; i <= cap; i++) {
    try {
      pg.call("ghostty_terminal_vt_write", 0xfffff000, pin, PROBE.length);
    } catch {}
    if (!healthy()) {
      poisonAfterRepeats = i;
      break;
    }
  }

  const src = fs.readFileSync(
    path.join(import.meta.dir, "..", "src", "daemon", "session.ts"),
    "utf8",
  );
  const daemonCatches =
    /try\s*{\s*this\.vt\?\.write\(bytes\);\s*}\s*catch/.test(src);
  return {
    steps,
    poisonAfterRepeats,
    poisonRepeatCap: cap,
    hugeResize,
    daemonCatches,
  };
}

// ------------------------------------------------------------------- run

export async function runPerf(opts: PerfOptions = {}): Promise<PerfReport> {
  if (opts.trapChild) {
    await trapChild(opts.trapChild);
    return {
      bun: Bun.version,
      kernel: kernel(),
      cpu: cpuModel(),
      quick: false,
      engines: [],
      loadErrors: {},
      tables: "",
    };
  }
  const out = opts.out ?? ((l: string) => console.log(l));
  const only = new Set<Section>(opts.only ?? SECTIONS);
  const quick = opts.quick ?? false;
  const lines: string[] = [];
  const emit = (l: string) => {
    lines.push(l);
    if (!opts.json) out(l);
  };

  const engines: VtEngine[] = [];
  const loadErrors: Record<string, string> = {};
  for (const id of engineIds()) {
    try {
      engines.push(await getEngine(id));
    } catch (e) {
      loadErrors[id] = (e as Error).message;
    }
  }
  const report: PerfReport = {
    bun: Bun.version,
    kernel: kernel(),
    cpu: cpuModel(),
    quick,
    engines: engines.map((e) => e.id),
    loadErrors,
    tables: "",
  };
  emit(
    `wp bench perf — Bun ${report.bun}, kernel ${report.kernel}, ${report.cpu}${quick ? " (quick)" : ""}`,
  );
  emit(
    `engines: ${report.engines.join(", ")}${Object.keys(loadErrors).length ? `; failed: ${JSON.stringify(loadErrors)}` : ""}`,
  );

  if (only.has("throughput")) {
    emit("\n## VT throughput (MiB/s, best of runs; median in brackets)\n");
    report.throughput = await throughput(engines, quick);
    emit(
      table(
        ["Stream", "Bytes", "Size", ...engines.map((e) => e.id)],
        [...new Set(report.throughput.map((r) => `${r.stream}|${r.size}`))].map(
          (key) => {
            const [stream, size] = key.split("|");
            const rs = report.throughput!.filter(
              (r) => r.stream === stream && r.size === size,
            );
            return [
              stream!,
              mib(rs[0]!.bytes),
              size!,
              ...engines.map((e) => {
                const r = rs.find((x) => x.engine === e.id);
                return r
                  ? `${r.best.toFixed(1)} (${r.median.toFixed(1)})`
                  : "-";
              }),
            ];
          },
        ),
      ),
    );
  }

  if (only.has("latency")) {
    emit("\n## Relay latency (round trip, µs)\n");
    report.latency = await latency(quick);
    const l = report.latency;
    const row = (name: string, s: LatencyStat) => [
      name,
      String(s.n),
      s.p50.toFixed(1),
      s.p90.toFixed(1),
      s.p99.toFixed(1),
      s.max.toFixed(1),
    ];
    emit(
      table(
        ["Path", "n", "p50", "p90", "p99", "max"],
        [
          row("bare PTY, in-process (M0 path A)", l.bare),
          row("client → daemon → PTY → cat → client", l.daemon),
        ],
      ),
    );
    emit(`dtach: ${l.dtach}`);
  }

  if (only.has("snapshot")) {
    emit("\n## Snapshot (ghostty-wasm)\n");
    report.snapshot = await snapshot(quick);
    emit(
      table(
        [
          "Session",
          "Rows",
          "Bytes",
          "Encode min / median",
          "ready()",
          "Full decode",
          "Round trip",
        ],
        report.snapshot.map((r) => [
          r.session,
          String(r.rows),
          r.bytes.toLocaleString("en-GB"),
          `${ms(r.encodeMinMs)} / ${ms(r.encodeMedianMs)}`,
          `${ms(r.readyMs)}, ${r.readyRows} rows`,
          `${ms(r.fullDecodeMs)}, ${r.pages} pages`,
          r.roundTrip ? "identical" : "DIFFERS",
        ]),
      ),
    );
  }

  if (only.has("memory")) {
    emit("\n## Daemon memory (RSS from /proc/<pid>/status)\n");
    report.memory = await memory(quick);
    const m = report.memory;
    const pointRow = (p: MemoryPoint) => [
      p.label,
      mib(p.rss),
      p.perSession == null ? "-" : mib(p.perSession, 2),
      mib(p.wasm),
      mib(p.heapUsed),
    ];
    emit(
      table(
        ["Fleet", "RSS", "Δ per session", "wasm memory", "JS heapUsed"],
        [
          [
            "daemon, no sessions, no engine",
            mib(m.baseline.rss),
            "-",
            mib(m.baseline.wasm),
            "-",
          ],
          ...m.idle.map(pointRow),
          ...m.scrollback.map(pointRow),
        ],
      ),
    );
    emit("\nChurn: all sessions killed and re-created, three rounds:\n");
    emit(
      table(
        [
          "Round",
          "RSS",
          "RSS after Bun.gc(true)",
          "wasm memory",
          "JS heapUsed",
        ],
        m.churn.map((c) => [
          String(c.round),
          mib(c.rss),
          mib(c.rssAfterGc),
          mib(c.wasm),
          mib(c.heapUsed),
        ]),
      ),
    );
  }

  if (only.has("slow")) {
    emit("\n## Slow client\n");
    report.slow = await slowClient(quick);
    const s = report.slow;
    emit(
      table(
        ["Quantity", "Value"],
        [
          ["Queue bound", `${s.queueBound.toLocaleString("en-GB")} B`],
          [
            "Fast client received",
            `${s.fastReceived.toLocaleString("en-GB")} B, ${s.fastLags} lag episodes`,
          ],
          [
            "Slow client dropped",
            `${s.slow.droppedBytes.toLocaleString("en-GB")} B over ${s.slow.lagCount} lag episode(s)`,
          ],
          [
            "Slow client max queue",
            `${s.slow.maxQueuedBytes.toLocaleString("en-GB")} B (${s.slow.maxQueuedBytes <= s.queueBound ? "under" : "OVER"} the bound)`,
          ],
          [
            "First short write after",
            s.slow.firstShortWriteAfterBytes == null
              ? "-"
              : `${s.slow.firstShortWriteAfterBytes.toLocaleString("en-GB")} B`,
          ],
          ["Short writes / drains", `${s.slow.shortWrites} / ${s.slow.drains}`],
          ["Drain latency", ms(s.slow.lastDrainLatencyMs, 0)],
          [
            "Slow client delivered",
            `${s.slow.bytesSent.toLocaleString("en-GB")} B; ${s.slowRenders} renders, ${s.slowResumed} resumed`,
          ],
          [
            "Daemon RSS before / peak during / after",
            `${mib(s.rss.before)} / ${mib(s.rss.peakDuring)} / ${mib(s.rss.after)}`,
          ],
          ["Flood duration", ms(s.ms, 0)],
        ],
      ),
    );
  }

  if (only.has("trap")) {
    emit("\n## Trap isolation (ghostty-wasm shared instance)\n");
    report.trap = await trap();
    emit(
      table(
        [
          "Single fault (own instance)",
          "Outcome",
          "Time",
          "Other terminal ok",
          "Fresh terminal ok",
          "wasm memory",
        ],
        report.trap.steps.map((s) => [
          s.what,
          s.outcome,
          ms(s.ms),
          s.otherOk ? "yes" : "NO",
          s.freshOk ? "yes" : "NO",
          mib(s.memoryBytes),
        ]),
      ),
    );
    const tr = report.trap;
    emit(
      `\nrepeating the bogus-handle trap poisons the instance after ${tr.poisonAfterRepeats == null ? `no poison within ${tr.poisonRepeatCap.toLocaleString("en-GB")} repeats` : `${tr.poisonAfterRepeats.toLocaleString("en-GB")} repeats`}: a fresh terminal on it then throws.`,
    );
    const h = tr.hugeResize;
    emit(
      `resize to 65535×65535, in a child process: ${h.outcome} after ${ms(h.ms, 0)}; the child's RSS peaked at ${mib(h.peakRss)}`,
    );
    emit(
      `daemon's PTY hot path wraps vt.write in try/catch: ${tr.daemonCatches ? "yes" : "no"} (a single trap in one session's write is swallowed; the shared instance is the exposure).`,
    );
  }

  report.tables = lines.join("\n");
  if (opts.json) out(JSON.stringify(report, null, 2));
  return report;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--only");
  const only = i >= 0 ? (args[i + 1]!.split(",") as Section[]) : undefined;
  const c = args.indexOf("--trap-child");
  await runPerf({
    only,
    json: args.includes("--json"),
    quick: args.includes("--quick"),
    trapChild: c >= 0 ? args[c + 1] : undefined,
  });
  process.exit(0);
}
