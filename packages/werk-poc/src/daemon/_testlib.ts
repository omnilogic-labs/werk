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
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // A zombie still answers signal 0. macOS has no /proc, so its STAT column
    // from `ps` is the only place the state shows up.
    if (process.platform === "darwin") {
      return !Bun.spawnSync(["ps", "-o", "state=", "-p", String(pid)])
        .stdout.toString()
        .trim()
        .startsWith("Z");
    }
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/\) Z /.test(stat);
  } catch {
    return false;
  }
}

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
    if (!(await waitFor(() => !alive(pid), 3000))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
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
