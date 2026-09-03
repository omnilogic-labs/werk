// The reattach-fidelity harness: the compiled `wp` driven inside a PTY of
// its own, with everything it writes fed into a fresh `ghostty-wasm`
// terminal that stands in for the user's terminal. That terminal's screen
// is compared with the daemon's own screen for the session (`screen`).
//
// Each test environment is a temporary XDG_RUNTIME_DIR, so `wp` autostarts
// a daemon there and nothing touches the real one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";
import {
  connect,
  type Client,
  type ScreenResult,
} from "../../src/client/index.ts";
import { loadGhosttyWasmEngine } from "../../src/engine/ghostty-wasm/bun.ts";
import { platform } from "../../src/platform/index.ts";
import type {
  GhosttyWasmEngine,
  GhosttyWasmTerminal,
} from "../../src/engine/ghostty-wasm/index.ts";

export const pkg = path.join(import.meta.dir, "..", "..");

export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor(
  pred: () => boolean,
  ms: number,
  step = 20,
): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return pred();
}

/** Where this run's binary goes; one directory, one file per live run. */
const BUILD_DIR = path.join(pkg, "dist", "m2");

/**
 * Removes the binaries of runs that have exited, so `dist/m2/` holds this
 * run's and at most one other rather than one per run ever made. A pid that
 * has been reused keeps its file for one more round, which costs a binary.
 */
function sweepBuilds(): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(BUILD_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(/^wp-(\d+)(?:\.exe)?$/.exec(name)?.[1]);
    if (!Number.isInteger(pid) || pid === process.pid || alive(pid)) continue;
    try {
      fs.rmSync(path.join(BUILD_DIR, name));
    } catch {}
  }
}

/**
 * Compiles `wp` into a path of this run's own and returns it. ~150 ms.
 *
 * Not `dist/wp`: Windows holds an executable's file open for as long as a
 * process is running it, so a rebuild over the binary some earlier suite's
 * daemon is still running fails with `EPERM`, and the harness would have to
 * stop that daemon before it could build. A path named after this process
 * cannot be the one anything else is running, so the build depends on
 * nothing but itself — and it leaves the `dist/wp` an earlier `bun run
 * build` produced alone.
 *
 * The two commands are `package.json`'s `build` script with its output
 * redirected: the web bundle, then the compile.
 */
export function buildWp(): string {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  sweepBuilds();
  const out = path.join(BUILD_DIR, `wp-${process.pid}`);
  const web = Bun.spawnSync(["bun", "run", "build:web"], {
    cwd: pkg,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (web.exitCode !== 0) throw new Error(`build:web failed: ${web.stderr}`);
  const r = Bun.spawnSync(
    ["bun", "build", "--compile", "./src/cli/main.ts", "--outfile", out],
    { cwd: pkg, stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) throw new Error(`build failed: ${r.stderr}`);
  // Windows names the compiled output `wp-<pid>.exe`; ask the filesystem
  // which one arrived rather than the platform which one to expect.
  return fs.existsSync(out) ? out : `${out}.exe`;
}

export interface TestEnv {
  /** The temporary XDG_RUNTIME_DIR. */
  root: string;
  /** The daemon's directory inside it. */
  dir: string;
  wp: string;
  env: Record<string, string>;
}

export function tempEnv(wp: string): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp-m2cli-"));
  return {
    root,
    dir: path.join(root, "werk-poc"),
    wp,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/",
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      XDG_RUNTIME_DIR: root,
      // Snapshots go under the temporary root too, never the real state dir.
      XDG_STATE_HOME: path.join(root, "state"),
      WP_TRACE: path.join(root, "trace.log"),
      // A prompt with no colour and no cwd, so screens are predictable.
      PS1: "$ ",
      // The daemon's socket-buffer switch (src/platform/) is the one knob the
      // harness forwards, so a run can be repeated with it off.
      ...(process.env.WP_SNDBUF !== undefined
        ? { WP_SNDBUF: process.env.WP_SNDBUF }
        : {}),
    },
  };
}

/** Shuts the environment's daemon down (over the socket, then SIGKILL) and removes the directory. */
export async function stopEnv(env: TestEnv, keep = false): Promise<void> {
  const c = await connect({
    dir: env.dir,
    autostart: false,
    timeoutMs: 1000,
  }).catch(() => null);
  if (c) {
    const pid = c.daemon.pid;
    await c.shutdown().catch(() => {});
    c.close();
    const gone = await waitFor(() => !alive(pid), 3000);
    if (!gone) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  if (keep) {
    console.error(`kept ${env.root} for inspection`);
    return;
  }
  fs.rmSync(env.root, { recursive: true, force: true });
}

/** Whether `pid` is a live process; a zombie waiting to be reaped counts as dead. */
export const alive = (pid: number): boolean => platform.isAlive(pid);

/** A client on the environment's daemon, for `screen`, `ls`, `logs`. */
export function daemonClient(env: TestEnv): Promise<Client> {
  return connect({ dir: env.dir, autostart: false, requestTimeoutMs: 10_000 });
}

/** `wp run` without a tty: starts the session and prints the id. */
export async function wpRun(
  env: TestEnv,
  argv: string[],
  size: { cols: number; rows: number } = { cols: 80, rows: 24 },
  cwd = os.tmpdir(),
): Promise<string> {
  const p = Bun.spawn(
    [
      env.wp,
      "run",
      `--cols=${size.cols}`,
      `--rows=${size.rows}`,
      "--",
      ...argv,
    ],
    { cwd, env: env.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`wp run failed (${code}): ${err}`);
  return out.trim();
}

/** Runs a non-interactive `wp` command and returns its output. */
export async function wp(
  env: TestEnv,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([env.wp, ...args], {
    cwd: os.tmpdir(),
    env: env.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
}

let engine: GhosttyWasmEngine | null = null;
export async function freshEngine(): Promise<GhosttyWasmEngine> {
  return (engine ??= await loadGhosttyWasmEngine());
}

/**
 * "The user's terminal": a PTY running one `wp` command, whose output is
 * fed into a fresh libghostty terminal of the same size. `text` holds
 * everything written, decoded, for looking for `[detached ...]` lines.
 */
export class UserTerminal {
  proc!: Subprocess;
  vt!: GhosttyWasmTerminal;
  readonly chunks: Uint8Array[] = [];
  bytes = 0;
  text = "";
  exitCode: number | null = null;
  private readonly dec = new TextDecoder();
  /** Set to false to stop feeding the emulator (the bytes are still kept). */
  feed = true;

  private constructor(
    readonly cols: number,
    readonly rows: number,
  ) {}

  static async spawn(
    env: TestEnv,
    args: string[],
    size: { cols: number; rows: number } = { cols: 80, rows: 24 },
    extraEnv: Record<string, string> = {},
  ): Promise<UserTerminal> {
    const t = new UserTerminal(size.cols, size.rows);
    t.vt = (await freshEngine()).create({
      cols: size.cols,
      rows: size.rows,
      scrollback: 1000,
    });
    t.proc = Bun.spawn([env.wp, ...args], {
      cwd: os.tmpdir(),
      env: { ...env.env, ...extraEnv },
      terminal: {
        cols: size.cols,
        rows: size.rows,
        data: (_term, data) => t.onData(data),
      },
    });
    void t.proc.exited.then((c) => (t.exitCode = c));
    return t;
  }

  private onData(data: Uint8Array): void {
    const copy = new Uint8Array(data);
    this.chunks.push(copy);
    this.bytes += copy.length;
    this.text += this.dec.decode(copy, { stream: true });
    if (this.feed) this.vt.write(copy);
  }

  /** Replays chunks not yet fed (after `feed` was false). */
  catchUp(from: number): void {
    for (let i = from; i < this.chunks.length; i++)
      this.vt.write(this.chunks[i]!);
  }

  write(bytes: string | Uint8Array): void {
    this.proc.terminal!.write(bytes);
  }

  /** The outer PTY's size; `wp attach` sees SIGWINCH. The stand-in terminal follows, as a real one would. */
  resize(cols: number, rows: number): void {
    this.vt.resize(cols, rows);
    this.proc.terminal!.resize(cols, rows);
  }

  screen(): string {
    return this.vt.plainText();
  }

  cursor(): { x: number; y: number } {
    return this.vt.cursor();
  }

  altScreen(): boolean {
    return this.vt.decMode(1049);
  }

  get pid(): number {
    return this.proc.pid;
  }

  waitExit(ms: number): Promise<boolean> {
    return waitFor(() => this.exitCode !== null, ms);
  }

  async close(): Promise<void> {
    // The terminal is about to be disposed and a ConPTY goes on delivering
    // for a moment after the process it fed is killed, so a write from
    // `onData` would land on a freed terminal and throw where nothing can
    // catch it (the Windows lane of run 33705365214, where the throw
    // replaced the scenario's own verdict in the report).
    this.feed = false;
    if (this.exitCode === null) {
      try {
        this.proc.kill("SIGKILL");
      } catch {}
      await this.waitExit(2000);
    }
    try {
      this.proc.terminal?.close();
    } catch {}
    this.vt.dispose();
  }
}

/** Lines where two screens differ, as `y: |a| vs |b|`. Empty when equal. */
export function diffScreens(a: string, b: string): string[] {
  const la = a.split("\n");
  const lb = b.split("\n");
  const out: string[] = [];
  const n = Math.max(la.length, lb.length);
  for (let y = 0; y < n; y++) {
    if ((la[y] ?? "") !== (lb[y] ?? ""))
      out.push(`${y}: |${la[y] ?? ""}| vs |${lb[y] ?? ""}|`);
  }
  return out;
}

/** Compares the user's terminal with the daemon's screen for `id`; returns the differing lines. */
export async function compare(
  client: Client,
  id: string,
  term: UserTerminal,
): Promise<{ diff: string[]; daemon: ScreenResult; cursorMatch: boolean }> {
  const daemon = await client.screen(id);
  const diff = diffScreens(daemon.text, term.screen());
  const c = term.cursor();
  return {
    diff,
    daemon,
    cursorMatch: c.x === daemon.cursor.x && c.y === daemon.cursor.y,
  };
}

/** Polls until the screens agree or `ms` passes; returns the last comparison. */
export async function settle(
  client: Client,
  id: string,
  term: UserTerminal,
  ms: number,
): Promise<Awaited<ReturnType<typeof compare>>> {
  const end = Date.now() + ms;
  let last = await compare(client, id, term);
  while ((last.diff.length > 0 || !last.cursorMatch) && Date.now() < end) {
    await sleep(50);
    last = await compare(client, id, term);
  }
  return last;
}
