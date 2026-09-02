// Shared bits for the bench runners: a daemon on temporary directories,
// process accounting, percentiles, and a markdown table so the numbers
// paste straight into findings/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, type Client } from "../src/client/index.ts";

export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

export function readRss(pid: number): number | null {
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(
      fs.readFileSync(`/proc/${pid}/status`, "utf8"),
    );
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

/** Whether `pid` is a live process; a zombie counts as dead. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return !/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

export async function waitFor(
  pred: () => boolean | Promise<boolean>,
  ms: number,
  step = 20,
): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(step);
  }
  return pred();
}

export function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}

export const mib = (b: number | null | undefined, digits = 1) =>
  b == null || Number.isNaN(b) ? "-" : `${(b / 1048576).toFixed(digits)} MiB`;

export const ms = (x: number | null | undefined, digits = 2) =>
  x == null || Number.isNaN(x) ? "-" : `${x.toFixed(digits)} ms`;

/** A markdown table; Prettier will re-pad it. */
export function table(head: string[], rows: string[][]): string {
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (r: string[]) =>
    "| " + r.map((c, i) => (c ?? "").padEnd(widths[i]!)).join(" | ") + " |";
  return [
    line(head),
    "| " + widths.map((w) => "-".repeat(w)).join(" | ") + " |",
    ...rows.map(line),
  ].join("\n");
}

export function kernel(): string {
  return os.release();
}

export function cpuModel(): string {
  try {
    const m = /model name\s*:\s*(.+)/.exec(
      fs.readFileSync("/proc/cpuinfo", "utf8"),
    );
    return m ? m[1]!.trim() : (os.cpus()[0]?.model ?? "?");
  } catch {
    return os.cpus()[0]?.model ?? "?";
  }
}

export interface TempDaemon {
  root: string;
  dir: string;
  stateDir: string;
  pid: number;
  client: Client;
  /** A fresh connection to the same daemon. */
  connect(): Promise<Client>;
  /** Shuts the daemon down, makes sure it is gone, removes the directories. */
  stop(): Promise<void>;
}

/**
 * A daemon of its own on temporary runtime and state directories, started
 * the way the CLI starts one (interpreted from this tree). The user's real
 * daemon and snapshots are never touched.
 */
export async function tempDaemon(
  opts: {
    snapshotIntervalMs?: number;
    prefix?: string;
    env?: Record<string, string>;
  } = {},
): Promise<TempDaemon> {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), opts.prefix ?? "wp-bench-"),
  );
  const dir = path.join(root, "run");
  const stateDir = path.join(root, "state");
  // The daemon inherits this process's environment.
  process.env.WP_STATE_DIR = stateDir;
  if (opts.snapshotIntervalMs)
    process.env.WP_SNAPSHOT_INTERVAL_MS = String(opts.snapshotIntervalMs);
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;
  const client = await connect({ dir, autostart: true });
  const pid = client.daemon.pid;
  return {
    root,
    dir,
    stateDir,
    pid,
    client,
    connect: () => connect({ dir, autostart: false }),
    async stop() {
      await client.shutdown().catch(() => {});
      client.close();
      if (!(await waitFor(() => !alive(pid), 5000))) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
        await waitFor(() => !alive(pid), 2000);
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Waits until the session's viewport contains `text`. */
export async function waitForScreen(
  client: Client,
  id: string,
  text: string,
  timeoutMs = 20_000,
): Promise<boolean> {
  return waitFor(
    async () => (await client.screen(id)).text.includes(text),
    timeoutMs,
    50,
  );
}

/** Signals a running session, waits for it to exit, and removes it. */
export async function killAndRemove(client: Client, id: string): Promise<void> {
  const r = await client.kill(id, "SIGKILL");
  if (r.action === "removed") return;
  await waitFor(
    async () => {
      const s = (await client.ls()).find((x) => x.id === id);
      return !s || s.status !== "running";
    },
    10_000,
    25,
  );
  await client.kill(id).catch(() => {});
}
