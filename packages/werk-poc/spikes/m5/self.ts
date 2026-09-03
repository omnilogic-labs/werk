// M5's other remote end: this machine, over an sshd of its own.
//
// The container in `lib.ts` is the remote M5 was written against, and it
// needs Docker. A hosted macOS runner has none, so the RTT table §8 step 9
// asks for on macOS needs a remote that is nothing but ssh: a private sshd
// on a high port with a throwaway key, a second daemon in a runtime
// directory of its own, and `ssh -L` between them. The daemon, the forward,
// the client and the protocol are then exactly what the container run
// exercises; the machine is one instead of two, and the "network" is
// loopback.
//
// The RTT that `tc netem` supplies in the container comes here from
// whichever traffic shaper the machine has: pf's dummynet (`dnctl`, macOS)
// or `tc netem` on the loopback device (Linux). Both are asked for by name
// rather than by platform, and `netem()` says so when the machine has
// neither, so a run without a shaper still produces the RTT 0 row.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";
import type { Client } from "../../src/client/index.ts";
import { sh, sleep, waitFor, type M5Remote } from "./lib.ts";

/** Whether a command exists on this machine. */
function have(cmd: string): boolean {
  return sh(["sh", "-c", `command -v ${cmd}`], false).code === 0;
}

/** A free TCP port, by binding one and letting go of it. */
function freePort(): number {
  const l = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const p = l.port;
  l.stop(true);
  return p;
}

export class SelfRemote implements M5Remote {
  readonly kind = "self";
  readonly localSock: string;
  readonly key: string;
  /** The remote daemon's runtime directory, and so the far end of the forward. */
  readonly remoteDir: string;
  readonly remoteSock: string;
  readonly stateDir: string;
  readonly cwd: string;
  port = 0;
  ssh: Subprocess | null = null;
  /** Which shaper `netem()` found, for the report. */
  shaper: "dummynet" | "tc" | "none" = "none";
  private readonly sshes: Subprocess[] = [];
  private sshdPid = 0;
  private readonly user = os.userInfo().username;

  constructor(
    readonly tmp: string,
    readonly wp: string,
  ) {
    this.localSock = path.join(tmp, "wp.sock");
    this.key = path.join(tmp, "id_ed25519");
    this.remoteDir = path.join(tmp, "werk-poc");
    this.remoteSock = path.join(this.remoteDir, "wp.sock");
    this.stateDir = path.join(tmp, "state");
    this.cwd = path.join(tmp, "cwd");
    fs.mkdirSync(this.cwd, { recursive: true });
  }

  /** What a session started at the far end runs with: this machine's own. */
  readonly sessionEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? os.homedir(),
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
  };

  /** What the daemon at the far end runs with; `XDG_RUNTIME_DIR` puts it in `tmp`. */
  get env(): Record<string, string> {
    return {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? os.homedir(),
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      XDG_RUNTIME_DIR: this.tmp,
      WP_STATE_DIR: this.stateDir,
    };
  }

  async start() {
    const hostKey = path.join(this.tmp, "host_ed25519");
    const authKeys = path.join(this.tmp, "authorized_keys");
    sh(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", this.key]);
    sh(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
    fs.copyFileSync(`${this.key}.pub`, authKeys);
    fs.chmodSync(authKeys, 0o600);
    this.port = freePort();
    const log = path.join(this.tmp, "sshd.log");
    const pidFile = path.join(this.tmp, "sshd.pid");
    // Its own sshd, so nothing of the machine's own configuration — Remote
    // Login, the system authorized_keys, the standard port — is touched.
    sh([
      "sudo",
      "-n",
      "/usr/sbin/sshd",
      "-f",
      "/dev/null",
      "-h",
      hostKey,
      "-p",
      String(this.port),
      "-o",
      `AuthorizedKeysFile=${authKeys}`,
      "-o",
      "PasswordAuthentication=no",
      "-o",
      "KbdInteractiveAuthentication=no",
      "-o",
      "UsePAM=no",
      "-o",
      "StrictModes=no",
      "-o",
      `AllowUsers=${this.user}`,
      "-o",
      `PidFile=${pidFile}`,
      "-E",
      log,
    ]);
    const up = await waitFor(
      () => sh([...this.sshArgs(), "true"], false).code === 0,
      20_000,
      250,
    );
    if (!up) {
      const tail = fs.existsSync(log)
        ? fs.readFileSync(log, "utf8").trim().split("\n").slice(-3).join(" / ")
        : "(no log)";
      throw new Error(`the private sshd never answered: ${tail}`);
    }
    this.shaper = have("dnctl") ? "dummynet" : have("tc") ? "tc" : "none";
    this.sshdPid = Number(
      fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim() : 0,
    );
    // `wp ls` autostarts the far daemon in its own runtime directory.
    this.exec(["wp", "ls"]);
    if (!(await waitFor(() => fs.existsSync(this.remoteSock), 10_000, 100)))
      throw new Error(`no daemon at ${this.remoteSock}`);
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
      `${this.user}@127.0.0.1`,
    ];
  }

  async forward(
    mode: "N" | "tty" = "N",
    sock = this.localSock,
  ): Promise<Subprocess> {
    fs.rmSync(sock, { force: true });
    const L = ["-L", `${sock}:${this.remoteSock}`];
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

  execBulkMiBs() {
    const t0 = performance.now();
    // A byte count, not `16M`: BSD `head` refuses the suffix.
    const n = sh([...this.sshArgs(), "head", "-c", "16777216", "/dev/zero"])
      .stdout.length;
    return n / 1048576 / ((performance.now() - t0) / 1000);
  }

  async restartDaemon(ctl: Client, env: string[]) {
    await ctl.shutdown();
    ctl.close();
    await waitFor(() => !fs.existsSync(this.remoteSock), 10_000, 100);
    this.exec(["wp", "ls"], true, env);
    await waitFor(() => fs.existsSync(this.remoteSock), 10_000, 100);
  }

  /** Runs a command with the far daemon's environment; the far side is this machine. */
  exec(cmd: string[], ok = true, env: string[] = []) {
    const extra = Object.fromEntries(
      env.map((e) => {
        const at = e.indexOf("=");
        return [e.slice(0, at), e.slice(at + 1)];
      }),
    );
    const argv = cmd[0] === "wp" ? [this.wp, ...cmd.slice(1)] : cmd;
    const r = Bun.spawnSync(argv, {
      cwd: this.cwd,
      env: { ...this.env, ...extra },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = {
      code: r.exitCode,
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
    };
    if (ok && r.exitCode !== 0)
      throw new Error(
        `${argv.join(" ")} failed (${r.exitCode}): ${out.stderr}`,
      );
    return out;
  }

  /**
   * The RTT, applied to the sshd port in both directions: two dummynet
   * pipes where pf has them, `tc netem` on the loopback device where Linux
   * does, and nothing at all otherwise — a run with no shaper still has an
   * RTT 0 row, and says so.
   */
  netem(rtt: number) {
    const half = Math.floor(rtt / 2);
    if (this.shaper === "dummynet") {
      const rules = path.join(this.tmp, "pf.conf");
      sh(["sudo", "-n", "pfctl", "-a", "com.apple/m5", "-F", "all"], false);
      sh(["sudo", "-n", "dnctl", "-q", "flush"], false);
      if (rtt === 0) return;
      fs.writeFileSync(
        rules,
        `dummynet in quick proto tcp from any to any port ${this.port} pipe 100\n` +
          `dummynet out quick proto tcp from any to any port ${this.port} pipe 101\n`,
      );
      sh([
        "sudo",
        "-n",
        "dnctl",
        "pipe",
        "100",
        "config",
        "delay",
        String(half),
      ]);
      sh([
        "sudo",
        "-n",
        "dnctl",
        "pipe",
        "101",
        "config",
        "delay",
        String(half),
      ]);
      sh(["sudo", "-n", "pfctl", "-a", "com.apple/m5", "-f", rules]);
      sh(["sudo", "-n", "pfctl", "-E"], false);
      return;
    }
    if (this.shaper === "tc") {
      sh(["sudo", "-n", "tc", "qdisc", "del", "dev", "lo", "root"], false);
      if (rtt === 0) return;
      sh([
        "sudo",
        "-n",
        "tc",
        "qdisc",
        "add",
        "dev",
        "lo",
        "root",
        "netem",
        "delay",
        `${half}ms`,
        "limit",
        "100000",
      ]);
      return;
    }
    if (rtt !== 0)
      throw new Error("this machine has neither dnctl nor tc: no RTT to apply");
  }

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

  /** What the setup section reports about the far end. */
  describe(): string {
    const daemon = this.exec(
      [
        "sh",
        "-c",
        "ps -o pid,ppid,tty= -p $(pgrep -f __daemon | head -1) | tail -1",
      ],
      false,
    ).stdout.trim();
    return `remote is this machine over a private sshd on 127.0.0.1:${this.port} (${os.type()} ${os.release()}), delay by ${this.shaper}; far daemon ${daemon || "(not listed)"} in ${this.remoteDir}`;
  }

  async stop() {
    for (const p of this.sshes)
      try {
        p.kill("SIGKILL");
      } catch {}
    try {
      this.netem(0);
    } catch {}
    // The far daemon goes the way every daemon goes: the shutdown message.
    try {
      const { connect } = await import("../../src/client/index.ts");
      const ctl = await connect({
        dir: this.remoteDir,
        autostart: false,
        timeoutMs: 2000,
      });
      await ctl.shutdown().catch(() => {});
      ctl.close();
    } catch {}
    await sleep(300);
    if (this.sshdPid > 0)
      sh(["sudo", "-n", "kill", String(this.sshdPid)], false);
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }
}
