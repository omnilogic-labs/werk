// M5's helpers: the stand-in user terminal with a timestamp (and, when
// asked, a screen key) per PTY read, screen comparison against the daemon,
// percentiles, and the container + `ssh -L` plumbing.

import fs from "node:fs";
import path from "node:path";
import type { Subprocess } from "bun";
import type { Client, ScreenResult } from "../../src/client/index.ts";
import { loadGhosttyWasmEngine } from "../../src/engine/ghostty-wasm/bun.ts";
import type {
  GhosttyWasmEngine,
  GhosttyWasmTerminal,
} from "../../src/engine/ghostty-wasm/index.ts";

export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor(pred: () => boolean, ms: number, step = 20) {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await sleep(step);
  return pred();
}

export function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[
    Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  ]!;
}

export const ms = (x: number) => (Number.isNaN(x) ? "-" : x.toFixed(1));
export const kb = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
/** `n p50/p90/max` of a size list. */
export const sizes = (xs: number[]) =>
  `${xs.length} × p50 ${pct(xs, 50)} / p90 ${pct(xs, 90)} / max ${Math.max(0, ...xs)} B`;

/** A screen as one comparable string: trailing blanks off, plus the cursor. */
export function screenKey(text: string, cursor: { x: number; y: number }) {
  const lines = text.split("\n").map((l) => l.trimEnd());
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return `${lines.join("\n")}\0${cursor.x},${cursor.y}`;
}

export interface Chunk {
  t: number;
  size: number;
  /** The replica's screen after this chunk, when `trackScreen` is on. */
  screen?: string;
}

let engine: GhosttyWasmEngine | null = null;

/** The user's terminal: a PTY running one `wp` command, fed into a libghostty replica. */
export class Term {
  proc!: Subprocess;
  vt!: GhosttyWasmTerminal;
  readonly chunks: Chunk[] = [];
  bytes = 0;
  text = "";
  exitCode: number | null = null;
  trackScreen = false;
  private readonly dec = new TextDecoder();

  static async spawn(
    wp: string,
    args: string[],
    env: Record<string, string>,
    size = { cols: 80, rows: 24 },
  ): Promise<Term> {
    const t = new Term();
    engine ??= await loadGhosttyWasmEngine();
    t.vt = engine.create({ ...size, scrollback: 200 });
    t.proc = Bun.spawn([wp, ...args], {
      cwd: "/",
      env,
      terminal: { ...size, data: (_term, d) => t.onData(d) },
    });
    void t.proc.exited.then((c) => (t.exitCode = c));
    return t;
  }

  private onData(d: Uint8Array) {
    const copy = new Uint8Array(d);
    this.bytes += copy.length;
    this.text += this.dec.decode(copy, { stream: true });
    this.vt.write(copy);
    this.chunks.push({
      t: performance.now(),
      size: copy.length,
      screen: this.trackScreen ? this.key() : undefined,
    });
  }

  key() {
    return screenKey(this.vt.plainText(), this.vt.cursor());
  }
  write(s: string) {
    this.proc.terminal!.write(s);
  }
  resize(cols: number, rows: number) {
    this.vt.resize(cols, rows);
    this.proc.terminal!.resize(cols, rows);
  }
  get pid() {
    return this.proc.pid;
  }
  waitExit(t: number) {
    return waitFor(() => this.exitCode !== null, t);
  }
  async close() {
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

/**
 * Polls the daemon's `screen` until it differs from `before` (null: any)
 * and the replica shows the same thing on two polls 80 ms apart. The poll
 * itself crosses the forward; the paint time is read off chunk timestamps
 * afterwards (`paintLatency`), so the polling does not enter the number.
 */
export async function settle(
  ctl: Client,
  id: string,
  term: Term,
  before: string | null,
  limitMs: number,
): Promise<{ ok: boolean; key: string; daemon: ScreenResult }> {
  const end = Date.now() + limitMs;
  let lastKey: string | null = null;
  let matched = false;
  for (;;) {
    const daemon = await ctl.screen(id);
    const key = screenKey(daemon.text, daemon.cursor);
    const now = key !== before && term.key() === key;
    if (now && matched && key === lastKey) return { ok: true, key, daemon };
    if (Date.now() > end) return { ok: false, key, daemon };
    matched = now;
    lastKey = key;
    await sleep(now ? 80 : 30);
  }
}

/** Time from `t0` to the chunk after which the replica showed `key` and kept showing it. */
export function paintLatency(
  term: Term,
  from: number,
  key: string,
  t0: number,
) {
  let at: number | null = null;
  for (let i = from; i < term.chunks.length; i++) {
    const c = term.chunks[i]!;
    if (c.screen === key) at ??= c.t;
    else at = null;
  }
  return at === null ? null : at - t0;
}

export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function sh(cmd: string[], ok = true) {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = {
    code: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
  if (ok && r.exitCode !== 0)
    throw new Error(`${cmd.join(" ")} failed (${r.exitCode}): ${out.stderr}`);
  return out;
}

/**
 * The far end of the forward, whichever it is: the container below, or the
 * machine itself over an sshd of its own (`self.ts`), which is what a
 * hosted macOS runner has to use because it has no Docker.
 */
export interface M5Remote {
  readonly kind: "docker" | "self";
  readonly tmp: string;
  /** The host end of the `-N` forward. */
  readonly localSock: string;
  /** Where a session started at the far end runs, and with what. */
  readonly cwd: string;
  readonly sessionEnv: Record<string, string>;
  /** The `-N` forward on `localSock`, once `start()` has run. */
  ssh: Subprocess | null;
  start(): Promise<void>;
  forward(mode?: "N" | "tty", sock?: string): Promise<Subprocess>;
  /** What one exec channel carries at this RTT, handshake included. */
  execBulkMiBs(): number;
  restartDaemon(ctl: Client, env: string[]): Promise<void>;
  exec(
    cmd: string[],
    ok?: boolean,
    env?: string[],
  ): { code: number | null; stdout: string; stderr: string };
  /** Applies a symmetric RTT to the path, or clears it at 0. */
  netem(rtt: number): void;
  /** Time to sshd's banner: a TCP round trip over whatever is in the way. */
  bannerMs(): Promise<number>;
  /** One line naming what the far end is, for the report's setup section. */
  describe(): string;
  stop(): Promise<void>;
}

export const IMAGE = "werk-poc-m5";
export const REMOTE_SOCK = "/run/user/1000/werk-poc/wp.sock";
export const REMOTE_ENV = [
  "HOME=/home/werk",
  "USER=werk",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "XDG_RUNTIME_DIR=/run/user/1000",
  "WP_STATE_DIR=/home/werk/.local/state/werk-poc",
];

/** The container, the throwaway key, and the `ssh -N -L` forward. */
export class Remote implements M5Remote {
  readonly kind = "docker";
  readonly name = `werk-poc-m5-${process.pid}`;
  readonly cwd = "/home/werk";
  readonly sessionEnv = {
    HOME: "/home/werk",
    USER: "werk",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
  };
  readonly localSock: string;
  readonly key: string;
  port = 0;
  /** The `-N` forward on `localSock`. */
  ssh: Subprocess | null = null;
  private readonly sshes: Subprocess[] = [];

  constructor(
    readonly tmp: string,
    readonly wp: string,
  ) {
    this.localSock = path.join(tmp, "wp.sock");
    this.key = path.join(tmp, "id_ed25519");
  }

  async start() {
    const ctx = path.join(this.tmp, "ctx");
    fs.mkdirSync(ctx);
    fs.copyFileSync(
      path.join(import.meta.dir, "Dockerfile"),
      path.join(ctx, "Dockerfile"),
    );
    fs.copyFileSync(this.wp, path.join(ctx, "wp"));
    sh(["docker", "build", "-q", "-t", IMAGE, ctx]);
    sh(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", this.key]);
    sh([
      "docker",
      "run",
      "-d",
      "--rm",
      "--name",
      this.name,
      "--cap-add",
      "NET_ADMIN",
      "-p",
      "127.0.0.1:0:22",
      "-e",
      `AUTHORIZED_KEY=${fs.readFileSync(this.key + ".pub", "utf8").trim()}`,
      IMAGE,
    ]);
    this.port = Number(
      sh(["docker", "port", this.name, "22/tcp"])
        .stdout.trim()
        .split(":")
        .pop(),
    );
    const up = await waitFor(
      () => sh([...this.sshArgs(), "true"], false).code === 0,
      20_000,
      250,
    );
    if (!up) throw new Error("sshd in the container never answered");
    // `wp ls` autostarts the daemon in the container's runtime dir, from the same binary.
    this.exec(["wp", "ls"]);
    await this.forward();
  }

  sshArgs(extra: string[] = []) {
    return [
      "ssh",
      "-F",
      "/dev/null",
      "-i",
      this.key,
      "-p",
      String(this.port),
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "LogLevel=ERROR",
      "-o",
      "StreamLocalBindUnlink=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      ...extra,
      "werk@127.0.0.1",
    ];
  }

  /**
   * `ssh -L <local unix socket>:<remote unix socket>`, carried either by
   * `-N` (no session: OpenSSH treats the connection as non-interactive and
   * leaves Nagle on at both ends) or by a pty session running `sleep`
   * (`-tt`: both ends set TCP_NODELAY). Resolves once the local socket exists.
   */
  async forward(
    mode: "N" | "tty" = "N",
    sock = this.localSock,
  ): Promise<Subprocess> {
    fs.rmSync(sock, { force: true }); // a killed ssh leaves its socket behind
    const L = ["-L", `${sock}:${REMOTE_SOCK}`];
    const argv =
      mode === "N"
        ? this.sshArgs(["-N", ...L])
        : [...this.sshArgs(["-tt", ...L]), "sleep", "100000"];
    const p = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    });
    this.sshes.push(p);
    if (sock === this.localSock) this.ssh = p;
    if (!(await waitFor(() => fs.existsSync(sock), 10_000, 50)))
      throw new Error("the forwarded socket never appeared");
    return p;
  }

  /** `ssh host head -c 16777216 /dev/zero`: what one exec channel carries at this RTT, handshake included. */
  execBulkMiBs() {
    const t0 = performance.now();
    // A byte count, not `16M`: BSD `head` refuses the suffix.
    const n = sh([...this.sshArgs(), "head", "-c", "16777216", "/dev/zero"])
      .stdout.length;
    return n / 1048576 / ((performance.now() - t0) / 1000);
  }

  /** Restarts the container's daemon with extra `KEY=value` pairs in its environment; its sessions die with it. */
  async restartDaemon(ctl: Client, env: string[]) {
    await ctl.shutdown();
    ctl.close();
    await waitFor(
      () =>
        sh(["docker", "exec", this.name, "pgrep", "-f", "__daemon"], false)
          .code !== 0,
      10_000,
      100,
    );
    this.exec(["wp", "ls"], true, env);
  }

  exec(cmd: string[], ok = true, env: string[] = []) {
    return sh(
      [
        "docker",
        "exec",
        "-u",
        "werk",
        ...[...REMOTE_ENV, ...env].flatMap((e) => ["-e", e]),
        this.name,
        ...cmd,
      ],
      ok,
    );
  }

  netem(rtt: number) {
    sh(["docker", "exec", this.name, "netem", String(rtt)]);
  }

  /** Time to sshd's banner over the published port: a TCP round trip plus Docker Desktop's proxy. */
  bannerMs(): Promise<number> {
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      Bun.connect({
        hostname: "127.0.0.1",
        port: this.port,
        socket: {
          data(s) {
            resolve(performance.now() - t0);
            s.end();
          },
          error: (_s, e) => reject(e),
          connectError: (_s, e) => reject(e),
        },
      }).catch(reject);
    });
  }

  describe(): string {
    const version = this.exec([
      "dpkg-query",
      "-W",
      "-f",
      "${Version}",
      "openssh-server",
    ]).stdout.trim();
    const os = this.exec([
      "sh",
      "-c",
      ". /etc/os-release; echo $PRETTY_NAME",
    ]).stdout.trim();
    const daemon = this.exec(
      [
        "sh",
        "-c",
        "ps -o pid,sid,tty,args -p $(pgrep -f __daemon | head -1) | tail -1",
      ],
      false,
    ).stdout.trim();
    return `container: openssh-server ${version} on ${os}; far daemon ${daemon}`;
  }

  async stop() {
    for (const p of this.sshes)
      try {
        p.kill("SIGKILL");
      } catch {}
    sh(["docker", "rm", "-f", this.name], false);
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }
}
