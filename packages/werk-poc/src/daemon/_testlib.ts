// Helpers for the daemon tests: a temporary runtime directory per test
// file, a daemon started in it, and the means to be sure it is gone.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Client,
  connect,
  type AttachOptions,
  type Attachment,
} from "../client/index.ts";
import { platform } from "../platform/index.ts";

// Every daemon a test starts inherits this environment, so point snapshots
// at a directory of their own rather than the user's real state directory.
// One per test process, removed by `stopDaemon` (the process's `exit` hook
// was not seen to run under `bun test`); a later file's daemon recreates it.
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wp-m2-state-"));
process.env.WP_STATE_DIR = stateRoot;

export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor(
  pred: () => boolean,
  ms: number,
  step = 10,
): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return pred();
}

/** Whether `pid` is a live process; a zombie waiting to be reaped counts as dead. */
export const alive = (pid: number): boolean => platform.isAlive(pid);

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wp-m2-"));
}

/**
 * Shuts the daemon in `dir` down over the socket, then makes sure the
 * process is gone. Works from the directory alone, so a test that failed
 * before it learned the pid still cleans up.
 */
export async function stopDaemon(
  dir: string,
  client?: Client | null,
  pid?: number | null,
): Promise<void> {
  let c = client ?? null;
  if (!c)
    c = await connect({ dir, autostart: false, timeoutMs: 1000 }).catch(
      () => null,
    );
  if (c && pid == null) pid = c.daemon.pid;
  if (c) await c.shutdown().catch(() => {});
  if (pid != null) {
    // The message is the way out on every platform; this is the grace
    // running out, which is the seam's job because a signal name means
    // nothing on Windows (../platform/).
    if (!(await waitFor(() => !alive(pid), 3000))) {
      platform.terminate(pid);
      await waitFor(() => !alive(pid), 2000);
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(stateRoot, { recursive: true, force: true });
}

/** A client attached with all output captured as text. */
export class Capture {
  render = "";
  output = "";
  renders: string[] = [];
  exited: { exitCode: number | null; signalCode: string | null } | null = null;
  lagged: { droppedBytes: number }[] = [];
  resumed = 0;
  effects: { kind: string; value?: string }[] = [];
  outputBytes = 0;
  att!: Attachment;
  private dec = new TextDecoder();

  constructor(readonly client: Client) {}

  async attach(
    id: string,
    opts: Partial<AttachOptions> = {},
  ): Promise<Attachment> {
    this.att = await this.client.attach(id, {
      cols: 80,
      rows: 24,
      ...opts,
      onOutput: (b) => {
        this.outputBytes += b.length;
        this.output += this.dec.decode(b, { stream: true });
      },
      onRender: (b) => {
        this.render = this.dec.decode(b);
        this.renders.push(this.render);
      },
      onExited: (i) => (this.exited = i),
      onLag: (i) => this.lagged.push(i),
      onResumed: () => this.resumed++,
      onEffect: (e) => this.effects.push(e),
    });
    return this.att;
  }

  /** Everything seen so far: the latest render plus output since. */
  get all(): string {
    return this.render + this.output;
  }
}

export async function connectTo(dir: string): Promise<Client> {
  return connect({ dir });
}

/** The line a `flood` repeats: 79 characters and a newline, a full row at 80 columns. */
export const FLOOD_LINE = `${"y".repeat(79)}\n`;

/**
 * A child that floods its terminal with `bytes` of full 80-column lines
 * after a short pause, prints `DONE`, and then idles so the session stays
 * alive: the producer behind the slow-client rule and the snapshot
 * lag-resume. It is Bun itself, writing 64 KiB chunks, so it is the same
 * program on all three platforms. The shape of the output is the point:
 * a pseudoconsole's cost is per line rather than per byte — about
 * 200,000 lines/s whatever their length, so `y\n` lines arrive at
 * 0.6 MiB/s and full rows at 12–13 MiB/s — and `yes | head -c` under
 * MSYS `sh` reaches it three bytes at a time, at 20 KiB/s
 * (.github/ci/step10-flood-probes.ts, findings/platforms.md). What the
 * line discipline makes of the bytes is `floodDelivered`.
 */
export function flood(bytes: number, pauseMs = 300, idleMs = 30_000): string[] {
  const script =
    `const fs=require("node:fs");` +
    `const chunk=Buffer.from(${JSON.stringify(FLOOD_LINE)}.repeat(819));` +
    `const w=(b,n)=>{let off=0;while(off<n){try{off+=fs.writeSync(1,b,off,n-off);}catch(e){if(e.code!=="EAGAIN")throw e;}}};` +
    `await Bun.sleep(${pauseMs});` +
    `let left=${bytes};` +
    `while(left>0){const n=Math.min(left,chunk.length);w(chunk,n);left-=n;}` +
    `w(Buffer.from("DONE\\n"),5);` +
    `await Bun.sleep(${idleMs});`;
  return [process.execPath, "-e", script];
}

/**
 * How many bytes a `flood(bytes)` puts on the wire on a POSIX pty, where
 * the line discipline turns each `\n` into `\r\n`. A ConPTY re-encodes
 * rather than translates and sends about an eighth more than this, so a
 * test holds this figure as a floor rather than an exact count.
 */
export const floodDelivered = (bytes: number) =>
  Math.floor(bytes / FLOOD_LINE.length) * (FLOOD_LINE.length + 1) +
  (bytes % FLOOD_LINE.length);
