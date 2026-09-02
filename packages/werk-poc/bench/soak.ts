// The soak from the proposal, §6: twenty sessions on a real daemon — idle
// shells and looping noisy producers — held for hours with the snapshot
// timer running, one client attached in snapshot mode throughout, and one
// client that attaches to a random session and leaves again every few
// seconds. Every interval the daemon's `stats` are written to a JSONL file:
// RSS, the wasm instance's memory, the JS heap, event-loop lag, the last
// snapshot pass, and the attach latencies the roaming client saw. The
// summary at the end (or from `--report <file>` later) answers §8's row —
// "RSS grows without bound over the 24-hour soak" — with a linear fit of
// RSS over the second half of the run.
//
//   wp bench soak --duration 30m                 # runtime and state on temp dirs
//   wp bench soak --duration 24h --out soak.jsonl
//   wp bench soak --report soak.jsonl            # summarise an existing log
//
// Everything is on temporary directories; the user's real daemon, socket
// and snapshots are not touched.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, type Client, type DaemonStats } from "../src/client/index.ts";
import { GhosttyWasmEngine } from "../src/engine/ghostty-wasm/index.ts";
import { ghosttyWasmBytes } from "../src/engine/ghostty-wasm/bytes.ts";
import { isUnsupported, type VtTerminal } from "../src/engine/types.ts";
import { alive, kernel, mib, pct, readRss, sleep, waitFor } from "./_lib.ts";

export interface SoakOptions {
  durationMs: number;
  /** How often a sample is taken. Default 60 s. */
  intervalMs?: number;
  /** Where the JSONL goes. Default: next to the runtime dir, printed at start. */
  out?: string;
  idle?: number;
  noisy?: number;
  /** How often the roaming client attaches somewhere. Default 10 s. */
  attachEveryMs?: number;
  /** The daemon's snapshot timer. Default 30 s. */
  snapshotIntervalMs?: number;
  /** Leave the temp directories (daemon log included) in place. */
  keep?: boolean;
  log?: (line: string) => void;
}

const SESSION_COLS = 100;
const SESSION_ROWS = 30;

/**
 * The noisy producer: styled lines, a `\r` progress line, an occasional
 * `clear`, about 50 KiB/s. Forty ~110-byte lines per 0.1 s; `sleep` is
 * the only fork per iteration, so ten of these cost the machine little.
 */
export const NOISY_SCRIPT = `
i=0
while :; do
  i=$((i+1))
  n=0
  while [ $n -lt 40 ]; do
    n=$((n+1))
    printf '\\033[1;%dm[%06d.%02d]\\033[0m \\033[38;5;%dmstyled\\033[0m lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor\\r\\n' $((31 + n % 7)) $i $n $(( (i + n) % 256 ))
  done
  printf '\\rprogress %3d%% [%-20s]' $((i % 101)) '####################'
  if [ $((i % 300)) -eq 0 ]; then printf '\\033[H\\033[2J'; fi
  sleep 0.1
done
`;

export interface SoakSample {
  kind: "sample";
  t: number;
  elapsedMs: number;
  rss: number | null;
  wasm: number | null;
  memory: DaemonStats["memory"];
  jsc: DaemonStats["jsc"];
  lag: {
    p50: number;
    p99: number;
    recentMax: number;
    totalMax: number;
    samples: number;
  };
  snapshotPass: DaemonStats["snapshots"]["lastPass"];
  snapshotsWritten: number;
  slowestEncodeMs: number | null;
  /** Attach latencies (request to first render, ms) the roaming client saw since the previous sample. */
  attachMs: number[];
  /** Connect times (socket open to hello, ms) for the same attaches. */
  connectMs: number[];
  sessions: { running: number; total: number };
  connections: number;
  /** The snapshot-mode client: snapshots received, bytes fed into the replica, lag episodes. */
  replica: { snapshots: number; bytes: number; lags: number };
  /** The soak process's own RSS, for reference. */
  soakRss: number;
}

export interface SoakHeader {
  kind: "header";
  bun: string;
  kernel: string;
  startedAt: number;
  daemonPid: number;
  options: Required<Omit<SoakOptions, "log" | "out" | "keep">> & {
    out: string;
  };
}

export type SoakRecord =
  SoakHeader | SoakSample | { kind: "end"; t: number; reason: string };

export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(s.trim());
  if (!m) throw new Error(`bad duration "${s}"; write 30m, 24h, 90s`);
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  return n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 120_000) return `${(ms / 1000).toFixed(0)} s`;
  if (ms < 7_200_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(2)} h`;
}

/** Least-squares slope of y over x, in y units per x unit. */
function slope(points: { x: number; y: number }[]): number {
  const n = points.length;
  if (n < 2) return NaN;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  return den === 0 ? NaN : num / den;
}

// ------------------------------------------------------------------ run

export async function runSoak(opts: SoakOptions): Promise<SoakSummary> {
  const log = opts.log ?? ((l: string) => console.error(l));
  const intervalMs = opts.intervalMs ?? 60_000;
  const idle = opts.idle ?? 10;
  const noisy = opts.noisy ?? 10;
  const attachEveryMs = opts.attachEveryMs ?? 10_000;
  const snapshotIntervalMs = opts.snapshotIntervalMs ?? 30_000;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp-soak-"));
  const dir = path.join(root, "run");
  const stateDir = path.join(root, "state");
  const out = opts.out ?? path.join(root, "soak.jsonl");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // The daemon inherits this process's environment.
  process.env.WP_STATE_DIR = stateDir;
  process.env.WP_SNAPSHOT_INTERVAL_MS = String(snapshotIntervalMs);

  const write = (r: SoakRecord) =>
    fs.appendFileSync(out, JSON.stringify(r) + "\n");

  log(`soak: runtime ${dir}, state ${stateDir}, log ${out}`);
  const main = await connect({ dir, autostart: true });
  const daemonPid = main.daemon.pid;
  log(`soak: daemon pid ${daemonPid}, bun ${Bun.version}`);

  const header: SoakHeader = {
    kind: "header",
    bun: Bun.version,
    kernel: kernel(),
    startedAt: Date.now(),
    daemonPid,
    options: {
      durationMs: opts.durationMs,
      intervalMs,
      idle,
      noisy,
      attachEveryMs,
      snapshotIntervalMs,
      out,
    },
  };
  write(header);

  // -- sessions ------------------------------------------------------------
  const ids: string[] = [];
  const noisyIds: string[] = [];
  for (let i = 0; i < idle; i++) {
    const { id } = await main.run({
      argv: ["sh"],
      cols: SESSION_COLS,
      rows: SESSION_ROWS,
    });
    ids.push(id);
  }
  for (let i = 0; i < noisy; i++) {
    const { id } = await main.run({
      argv: ["sh", "-c", NOISY_SCRIPT],
      cols: SESSION_COLS,
      rows: SESSION_ROWS,
    });
    ids.push(id);
    noisyIds.push(id);
  }
  log(`soak: ${idle} idle + ${noisy} noisy sessions`);

  // -- the snapshot-mode client on one noisy session ------------------------
  const replica = { snapshots: 0, bytes: 0, lags: 0 };
  let replicaTerm: VtTerminal | null = null;
  let replicaClient: Client | null = null;
  if (noisyIds.length > 0) {
    const engine = await GhosttyWasmEngine.load(await ghosttyWasmBytes());
    replicaClient = await connect({ dir, autostart: false });
    await replicaClient.attach(noisyIds[0]!, {
      cols: SESSION_COLS,
      rows: SESSION_ROWS,
      readOnly: true,
      mode: "snapshot",
      onSnapshot: (bytes) => {
        replica.snapshots++;
        const d = engine.decodeState(bytes);
        if (isUnsupported(d)) return;
        const t = d.ready();
        for (let p = d.next(); p; p = d.next()) {}
        replicaTerm?.dispose();
        replicaTerm = t;
      },
      onOutput: (bytes) => {
        replica.bytes += bytes.length;
        replicaTerm?.write(bytes);
      },
      onLag: () => replica.lags++,
    });
  }

  // -- the roaming client ---------------------------------------------------
  let attachMs: number[] = [];
  let connectMs: number[] = [];
  let stop = false;
  let stopReason = "duration";
  const roam = (async () => {
    while (!stop) {
      const id = ids[Math.floor(Math.random() * ids.length)]!;
      try {
        const t0 = performance.now();
        const c = await connect({ dir, autostart: false });
        const t1 = performance.now();
        let painted: (() => void) | null = null;
        const first = new Promise<void>((r) => (painted = r));
        const att = await c.attach(id, {
          cols: SESSION_COLS,
          rows: SESSION_ROWS,
          readOnly: true,
          onRender: () => painted?.(),
        });
        await Promise.race([first, sleep(5000)]);
        attachMs.push(performance.now() - t1);
        connectMs.push(t1 - t0);
        await sleep(Math.min(3000, attachEveryMs / 3));
        await att.detach();
        c.close();
      } catch (e) {
        log(`soak: roaming attach failed: ${(e as Error).message}`);
      }
      const until = Date.now() + attachEveryMs;
      while (!stop && Date.now() < until) await sleep(100);
    }
  })();

  // -- sampling -------------------------------------------------------------
  const startedAt = Date.now();
  const deadline = startedAt + opts.durationMs;
  const samples: SoakSample[] = [];
  const onSignal = () => {
    stopReason = "interrupted";
    stop = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  async function sample(): Promise<SoakSample> {
    const s = await main.stats();
    const ls = await main.ls();
    const rec: SoakSample = {
      kind: "sample",
      t: Date.now(),
      elapsedMs: Date.now() - startedAt,
      rss: s.rssBytes,
      wasm: s.wasmMemoryBytes,
      memory: s.memory,
      jsc: s.jsc,
      lag: {
        p50: s.loop.recent.p50Ms,
        p99: s.loop.recent.p99Ms,
        recentMax: s.loop.recent.maxMs,
        totalMax: s.loop.total.maxMs,
        samples: s.loop.total.samples,
      },
      snapshotPass: s.snapshots.lastPass,
      snapshotsWritten: s.snapshots.written.timer + s.snapshots.written.exit,
      slowestEncodeMs: s.snapshots.slowest?.encodeMs ?? null,
      attachMs,
      connectMs,
      sessions: {
        running: ls.filter((x) => x.status === "running").length,
        total: ls.length,
      },
      connections: s.connections.length,
      replica: { ...replica },
      soakRss: readRss(process.pid) ?? 0,
    };
    attachMs = [];
    connectMs = [];
    return rec;
  }

  const first = await sample();
  samples.push(first);
  write(first);
  log(
    `soak: t=0 rss ${mib(first.rss)} wasm ${mib(first.wasm)} sessions ${first.sessions.running}/${first.sessions.total}`,
  );

  while (!stop && Date.now() < deadline) {
    const next = Math.min(deadline, Date.now() + intervalMs);
    while (!stop && Date.now() < next)
      await sleep(Math.min(250, next - Date.now()));
    // `alive` can miss transiently when this process is starved (a busy
    // machine delays the /proc read); a real death is confirmed twice with
    // a short gap before the run is abandoned, so a loaded host does not
    // masquerade as a leaked daemon.
    if (!alive(daemonPid)) {
      await sleep(500);
      if (!alive(daemonPid)) {
        stopReason = "daemon died";
        log(`soak: daemon ${daemonPid} is gone`);
        break;
      }
    }
    try {
      const rec = await sample();
      samples.push(rec);
      write(rec);
      log(
        `soak: t=${fmtDuration(rec.elapsedMs)} rss ${mib(rec.rss)} wasm ${mib(rec.wasm)} heap ${mib(rec.memory.heapUsed)} lag p99 ${rec.lag.p99.toFixed(1)} ms max ${rec.lag.totalMax.toFixed(1)} ms attach p50 ${pct(rec.attachMs, 0.5).toFixed(1)} ms snap ${rec.snapshotPass ? `${rec.snapshotPass.ms.toFixed(1)} ms/${rec.snapshotPass.written}` : "-"} sessions ${rec.sessions.running}/${rec.sessions.total}`,
      );
    } catch (e) {
      log(`soak: sample failed: ${(e as Error).message}`);
      stopReason = `sample failed: ${(e as Error).message}`;
      break;
    }
  }
  stop = true;
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  await roam;
  write({ kind: "end", t: Date.now(), reason: stopReason });

  // -- teardown --------------------------------------------------------------
  replicaClient?.close();
  (replicaTerm as VtTerminal | null)?.dispose();
  await main.shutdown();
  main.close();
  if (!(await waitFor(() => !alive(daemonPid), 5000, 50))) {
    try {
      process.kill(daemonPid, "SIGKILL");
    } catch {}
  }
  const daemonLog = path.join(dir, "wp.log");
  if (fs.existsSync(daemonLog))
    fs.copyFileSync(daemonLog, out.replace(/\.jsonl$/, "") + ".daemon.log");
  if (!opts.keep) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    if (out.startsWith(root + path.sep) === false)
      fs.rmSync(root, { recursive: true, force: true });
  }
  log(`soak: ended (${stopReason}); ${samples.length} samples in ${out}`);
  const summary = summarise([
    header,
    ...samples,
    { kind: "end", t: Date.now(), reason: stopReason },
  ]);
  return summary;
}

// -------------------------------------------------------------- summary

export interface SoakSummary {
  bun: string;
  kernel: string;
  durationMs: number;
  samples: number;
  sessions: { expected: number; runningAtEnd: number };
  rss: {
    start: number;
    end: number;
    max: number;
    slopePerHourSecondHalf: number;
    slopePerHourWhole: number;
  };
  wasm: { start: number | null; end: number | null; max: number | null };
  heapUsed: { start: number; end: number; max: number };
  attach: {
    start: { n: number; p50: number; p99: number };
    end: { n: number; p50: number; p99: number };
    all: { n: number; p50: number; p99: number; max: number };
  };
  lag: { maxMs: number; worstRecentP99Ms: number };
  snapshotPass: {
    n: number;
    medianMs: number;
    maxMs: number;
    slowestEncodeMs: number | null;
  };
  replica: { snapshots: number; bytes: number; lags: number };
  endReason: string;
}

export function readLog(file: string): SoakRecord[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as SoakRecord);
}

export function summarise(records: SoakRecord[]): SoakSummary {
  const header = records.find((r): r is SoakHeader => r.kind === "header");
  const samples = records.filter((r): r is SoakSample => r.kind === "sample");
  const end = records.find((r) => r.kind === "end") as
    { reason: string } | undefined;
  if (!header || samples.length === 0) throw new Error("log has no samples");
  const rss = samples.map((s) => s.rss ?? 0);
  const last = samples[samples.length - 1]!;
  const durationMs = last.elapsedMs;
  const half = samples.filter((s) => s.elapsedMs >= durationMs / 2);
  const fit = (xs: SoakSample[]) =>
    slope(xs.map((s) => ({ x: s.elapsedMs / 3_600_000, y: s.rss ?? 0 })));
  const quarter = Math.max(1, Math.floor(samples.length / 4));
  const attachAll = samples.flatMap((s) => s.attachMs);
  const attachStart = samples.slice(0, quarter).flatMap((s) => s.attachMs);
  const attachEnd = samples.slice(-quarter).flatMap((s) => s.attachMs);
  const passes = samples
    .map((s) => s.snapshotPass)
    .filter((p): p is NonNullable<typeof p> => p != null);
  const passMs = passes.map((p) => p.ms);
  const stat = (xs: number[]) => ({
    n: xs.length,
    p50: pct(xs, 0.5),
    p99: pct(xs, 0.99),
  });
  return {
    bun: header.bun,
    kernel: header.kernel,
    durationMs,
    samples: samples.length,
    sessions: {
      expected: header.options.idle + header.options.noisy,
      runningAtEnd: last.sessions.running,
    },
    rss: {
      start: rss[0]!,
      end: rss[rss.length - 1]!,
      max: Math.max(...rss),
      slopePerHourSecondHalf: half.length >= 2 ? fit(half) : NaN,
      slopePerHourWhole: fit(samples),
    },
    wasm: {
      start: samples[0]!.wasm,
      end: last.wasm,
      max: Math.max(...samples.map((s) => s.wasm ?? 0)),
    },
    heapUsed: {
      start: samples[0]!.memory.heapUsed,
      end: last.memory.heapUsed,
      max: Math.max(...samples.map((s) => s.memory.heapUsed)),
    },
    attach: {
      start: stat(attachStart),
      end: stat(attachEnd),
      all: {
        ...stat(attachAll),
        max: attachAll.length ? Math.max(...attachAll) : NaN,
      },
    },
    lag: {
      maxMs: Math.max(...samples.map((s) => s.lag.totalMax)),
      worstRecentP99Ms: Math.max(...samples.map((s) => s.lag.p99)),
    },
    snapshotPass: {
      n: passes.length,
      medianMs: pct(passMs, 0.5),
      maxMs: passMs.length ? Math.max(...passMs) : NaN,
      slowestEncodeMs: last.slowestEncodeMs,
    },
    replica: last.replica,
    endReason: end?.reason ?? "still running",
  };
}

export function formatSummary(s: SoakSummary): string {
  const ms = (x: number) => (Number.isNaN(x) ? "-" : `${x.toFixed(1)} ms`);
  const rows: [string, string][] = [
    ["Bun / kernel", `${s.bun} / ${s.kernel}`],
    [
      "Duration",
      `${fmtDuration(s.durationMs)} (${s.samples} samples; ended: ${s.endReason})`,
    ],
    [
      "Sessions running at end",
      `${s.sessions.runningAtEnd} of ${s.sessions.expected}`,
    ],
    [
      "Daemon RSS start / end / max",
      `${mib(s.rss.start)} / ${mib(s.rss.end)} / ${mib(s.rss.max)}`,
    ],
    [
      "RSS slope, second half (linear fit)",
      `${(s.rss.slopePerHourSecondHalf / 1048576).toFixed(2)} MiB/h`,
    ],
    [
      "RSS slope, whole run",
      `${(s.rss.slopePerHourWhole / 1048576).toFixed(2)} MiB/h`,
    ],
    [
      "wasm memory start / end / max",
      `${mib(s.wasm.start)} / ${mib(s.wasm.end)} / ${mib(s.wasm.max)}`,
    ],
    [
      "JS heapUsed start / end / max",
      `${mib(s.heapUsed.start)} / ${mib(s.heapUsed.end)} / ${mib(s.heapUsed.max)}`,
    ],
    [
      "Attach latency, first quarter p50 / p99",
      `${ms(s.attach.start.p50)} / ${ms(s.attach.start.p99)} (n=${s.attach.start.n})`,
    ],
    [
      "Attach latency, last quarter p50 / p99",
      `${ms(s.attach.end.p50)} / ${ms(s.attach.end.p99)} (n=${s.attach.end.n})`,
    ],
    [
      "Attach latency, all p50 / p99 / max",
      `${ms(s.attach.all.p50)} / ${ms(s.attach.all.p99)} / ${ms(s.attach.all.max)} (n=${s.attach.all.n})`,
    ],
    [
      "Event-loop lag max / worst recent p99",
      `${ms(s.lag.maxMs)} / ${ms(s.lag.worstRecentP99Ms)}`,
    ],
    [
      "Snapshot pass median / max",
      `${ms(s.snapshotPass.medianMs)} / ${ms(s.snapshotPass.maxMs)} over ${s.snapshotPass.n} passes; slowest encode ${s.snapshotPass.slowestEncodeMs == null ? "-" : ms(s.snapshotPass.slowestEncodeMs)}`,
    ],
    [
      "Snapshot-mode client",
      `${s.replica.snapshots} snapshots, ${mib(s.replica.bytes)} of output fed, ${s.replica.lags} lag episodes`,
    ],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  return rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`).join("\n");
}

export function reportFile(file: string): string {
  return formatSummary(summarise(readLog(file)));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const report = get("report");
  if (report) {
    console.log(reportFile(report));
  } else {
    const summary = await runSoak({
      durationMs: parseDuration(get("duration") ?? "30m"),
      intervalMs: get("interval") ? parseDuration(get("interval")!) : undefined,
      out: get("out"),
      idle: get("idle") ? Number(get("idle")) : undefined,
      noisy: get("noisy") ? Number(get("noisy")) : undefined,
      attachEveryMs: get("attach-every")
        ? parseDuration(get("attach-every")!)
        : undefined,
      keep: args.includes("--keep"),
    });
    console.log(formatSummary(summary));
  }
  process.exit(0);
}
