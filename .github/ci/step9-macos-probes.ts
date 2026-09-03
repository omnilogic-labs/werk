// Probes for §8 step 9's macOS half: whether a hosted macOS runner can be
// its own M5 "remote" — an sshd it can log in to, a Unix socket forwarded
// through it, and a round trip that can be delayed the way `tc netem`
// delays the container M5 uses on Linux. M5 itself needs Docker, which a
// hosted macOS runner does not have, so the spike's remote end has to be
// the runner itself before there can be an RTT table for macOS.
//
// One `PROBE <name>: <verdict>` line per question; nothing here throws.
//
//   bun run .github/ci/step9-macos-probes.ts

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function say(name: string, verdict: string): void {
  const line = `PROBE ${name}: ${verdict}\n`;
  try {
    fs.writeSync(1, line);
  } catch {
    console.log(line.trimEnd());
  }
}

function firstLine(e: unknown): string {
  const s = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return s.split("\n")[0]!.trim();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  ms: number,
  step = 25,
) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(step);
  }
  return !!(await pred());
}

function sh(cmd: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return {
    code: r.exitCode ?? -1,
    out: `${r.stdout.toString()}${r.stderr.toString()}`.trim(),
  };
}

const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[
    Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  ]!;
};
const ms = (x: number) => (Number.isNaN(x) ? "-" : x.toFixed(1));

const tmp = fs.mkdtempSync(path.join("/tmp", "wp-step9-"));
const key = path.join(tmp, "id_ed25519");
const hostKey = path.join(tmp, "host_ed25519");
const authKeys = path.join(tmp, "authorized_keys");
const user = os.userInfo().username;
let port = 0;

console.log(
  `platform=${process.platform} arch=${process.arch} bun=${Bun.version} release=${os.release()} user=${user} tmp=${tmp}`,
);

/** A free TCP port, by binding one and letting go of it. */
async function freePort(): Promise<number> {
  const s = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const p = s.port;
  s.stop(true);
  return p;
}

function sshArgs(extra: string[] = []): string[] {
  return [
    "ssh",
    "-F",
    "/dev/null",
    "-i",
    key,
    "-p",
    String(port),
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
    `${user}@127.0.0.1`,
  ];
}

// ------------------------------------------------------------------ sshd
// A private sshd on a high port, with its own host key and authorized_keys
// file: the runner is the "remote". Remote Login (`systemsetup
// -setremotelogin on`) needs Full Disk Access on recent macOS, so this asks
// for nothing of the machine's own configuration.
let sshdUp = false;
{
  const t0 = performance.now();
  const parts: string[] = [];
  try {
    parts.push(sh(["ssh", "-V"]).out.split("\n")[0] ?? "");
    sh(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key]);
    sh(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
    fs.copyFileSync(`${key}.pub`, authKeys);
    fs.chmodSync(authKeys, 0o600);
    port = await freePort();
    const log = path.join(tmp, "sshd.log");
    const start = sh([
      "sudo",
      "-n",
      "/usr/sbin/sshd",
      "-f",
      "/dev/null",
      "-h",
      hostKey,
      "-p",
      String(port),
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
      `AllowUsers=${user}`,
      "-o",
      `PidFile=${path.join(tmp, "sshd.pid")}`,
      "-E",
      log,
    ]);
    parts.push(
      `sshd start exit ${start.code}${start.out ? ` (${start.out})` : ""}`,
    );
    const up = await waitFor(
      () => sh([...sshArgs(), "true"]).code === 0,
      20_000,
      250,
    );
    sshdUp = up;
    const who = sh([...sshArgs(), "id", "-un"]);
    parts.push(
      `login ${up ? "ok" : "**failed**"} as ${who.out.split("\n").pop() ?? "?"} on port ${port} in ${ms(performance.now() - t0)} ms`,
    );
    if (!up) {
      const tail = fs.existsSync(log)
        ? fs.readFileSync(log, "utf8").trim().split("\n").slice(-3).join(" / ")
        : "(no log)";
      parts.push(`sshd log: ${tail}`);
    }
  } catch (e) {
    parts.push(`fail — ${firstLine(e)}`);
  }
  say("sshd-self", parts.join("; "));
}

/** A Unix-socket echo server that counts what it was written. */
function unixEcho(sock: string) {
  let frames = 0;
  let bytes = 0;
  const listener = Bun.listen<undefined>({
    unix: sock,
    socket: {
      data(socket, chunk) {
        frames++;
        bytes += chunk.length;
        socket.write(chunk);
      },
    },
  });
  return { listener, stat: () => ({ frames, bytes }) };
}

/** Forwards `-L`, waits for the local end to appear, and returns the process. */
async function forward(
  local: string,
  remote: string,
  mode: "N" | "tty",
  ready: () => Promise<boolean> | boolean,
) {
  const L = ["-L", `${local}:${remote}`];
  const argv =
    mode === "N"
      ? sshArgs(["-N", ...L])
      : [...sshArgs(["-tt", ...L]), "sleep", "100000"];
  const p = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const up = await waitFor(ready, 10_000, 50);
  return { proc: p, up };
}

/** One request/response over a connected socket, timed. */
async function rtt(
  connect: () => Promise<{
    write(b: Uint8Array | string): number;
    end(): void;
    onData: (cb: (b: Uint8Array) => void) => void;
  }>,
  n: number,
): Promise<number[]> {
  const out: number[] = [];
  const conn = await connect();
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      conn.onData(() => resolve());
      conn.write(`ping ${i}\n`);
    });
    out.push(performance.now() - t0);
  }
  conn.end();
  return out;
}

function connectUnix(sock: string) {
  return new Promise<{
    write(b: Uint8Array | string): number;
    end(): void;
    onData: (cb: (b: Uint8Array) => void) => void;
  }>((resolve, reject) => {
    let cb: ((b: Uint8Array) => void) | null = null;
    Bun.connect({
      unix: sock,
      socket: {
        open(socket) {
          resolve({
            write: (b) => socket.write(b),
            end: () => socket.end(),
            onData: (f) => (cb = f),
          });
        },
        data(_s, chunk) {
          cb?.(chunk);
        },
        error: (_s, e) => reject(e),
        connectError: (_s, e) => reject(e),
      },
    }).catch(reject);
  });
}

// -------------------------------------------------------- unix -L forward
let fwdSock = "";
if (sshdUp) {
  const parts: string[] = [];
  try {
    const target = path.join(tmp, "target.sock");
    fwdSock = path.join(tmp, "fwd.sock");
    const echo = unixEcho(target);
    const f = await forward(fwdSock, target, "N", () => fs.existsSync(fwdSock));
    if (!f.up) throw new Error("the forwarded socket never appeared");
    const lat = await rtt(() => connectUnix(fwdSock), 50);
    const s = echo.stat();
    parts.push(
      `50 round trips through \`ssh -N -L unix:unix\`: p50 ${ms(pct(lat, 50))} / p90 ${ms(pct(lat, 90))} ms; server saw ${s.frames} frames, ${s.bytes} B`,
    );
    f.proc.kill("SIGKILL");
    echo.listener.stop(true);
  } catch (e) {
    parts.push(`fail — ${firstLine(e)}`);
  }
  say("unix-forward", parts.join("; "));
}

// ------------------------------------------------------------- dummynet
// `tc netem` has no macOS equivalent; pf's dummynet does. The M5 container
// delays both directions, so this asks for two pipes on the sshd port and
// measures a TCP connect-to-banner before, during and after.
async function bannerMs(): Promise<number> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const s = net.connect(port, "127.0.0.1");
    s.once("data", () => {
      resolve(performance.now() - t0);
      s.destroy();
    });
    s.once("error", reject);
  });
}

if (sshdUp) {
  const parts: string[] = [];
  const rules = path.join(tmp, "pf.conf");
  try {
    const before: number[] = [];
    for (let i = 0; i < 5; i++) before.push(await bannerMs());
    fs.writeFileSync(
      rules,
      `dummynet in quick proto tcp from any to any port ${port} pipe 100\n` +
        `dummynet out quick proto tcp from any to any port ${port} pipe 101\n`,
    );
    const cfg = [
      sh(["sudo", "-n", "dnctl", "pipe", "100", "config", "delay", "25"]),
      sh(["sudo", "-n", "dnctl", "pipe", "101", "config", "delay", "25"]),
      sh(["sudo", "-n", "pfctl", "-a", "com.apple/step9", "-f", rules]),
      sh(["sudo", "-n", "pfctl", "-E"]),
    ];
    await sleep(300);
    const during: number[] = [];
    for (let i = 0; i < 5; i++) during.push(await bannerMs());
    sh(["sudo", "-n", "pfctl", "-a", "com.apple/step9", "-F", "all"]);
    sh(["sudo", "-n", "dnctl", "-q", "flush"]);
    sh(["sudo", "-n", "pfctl", "-X", "0"]);
    await sleep(300);
    const after: number[] = [];
    for (let i = 0; i < 5; i++) after.push(await bannerMs());
    parts.push(
      `banner p50 before ${ms(pct(before, 50))} ms, with two 25 ms pipes ${ms(pct(during, 50))} ms, after ${ms(pct(after, 50))} ms`,
    );
    parts.push(`dnctl/pfctl exits ${cfg.map((c) => c.code).join(",")}`);
    const errs = cfg
      .filter((c) => c.code !== 0)
      .map((c) => c.out.split("\n")[0])
      .filter(Boolean);
    if (errs.length) parts.push(`errors: ${errs.join(" | ")}`);
  } catch (e) {
    parts.push(`fail — ${firstLine(e)}`);
  }
  say("dummynet", parts.join("; "));
}

// ------------------------------------------------------- loopback TCP -L
// The Windows client's route, measured here too so the two runners can be
// read against each other: `ssh -L 127.0.0.1:local:127.0.0.1:remote`.
if (sshdUp) {
  const parts: string[] = [];
  try {
    let frames = 0;
    let bytes = 0;
    const server = Bun.listen<undefined>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, chunk) {
          frames++;
          bytes += chunk.length;
          socket.write(chunk);
        },
      },
    });
    const lp = await freePort();
    const f = await forward(
      `127.0.0.1:${lp}`,
      `127.0.0.1:${server.port}`,
      "N",
      async () => {
        try {
          const s = net.connect(lp, "127.0.0.1");
          await new Promise<void>((res, rej) => {
            s.once("connect", () => res());
            s.once("error", rej);
          });
          s.destroy();
          return true;
        } catch {
          return false;
        }
      },
    );
    if (!f.up) throw new Error("the forwarded port never accepted");
    const lat = await new Promise<number[]>((resolve, reject) => {
      const out: number[] = [];
      let t0 = 0;
      let i = 0;
      const s = net.connect(lp, "127.0.0.1");
      s.on("connect", () => {
        t0 = performance.now();
        s.write(`ping ${i}\n`);
      });
      s.on("data", () => {
        out.push(performance.now() - t0);
        if (++i >= 50) {
          s.destroy();
          resolve(out);
          return;
        }
        t0 = performance.now();
        s.write(`ping ${i}\n`);
      });
      s.on("error", reject);
    });
    parts.push(
      `50 round trips through \`ssh -N -L tcp:tcp\`: p50 ${ms(pct(lat, 50))} / p90 ${ms(pct(lat, 90))} ms; server saw ${frames} frames, ${bytes} B`,
    );
    f.proc.kill("SIGKILL");
    server.stop(true);
  } catch (e) {
    parts.push(`fail — ${firstLine(e)}`);
  }
  say("tcp-forward", parts.join("; "));
}

// --------------------------------------------- frames through the forward
// The same question the Windows probe asks, so the two can be read against
// each other and against the Linux forward in findings/m5.md: 20,000
// length-prefixed 520 B frames, each stamped with its sequence number,
// through the forward and directly. A drop is a gap, a reorder is a wrong
// stamp, and coalescing is a read far larger than a frame.
const FRAMES = 20_000;
const PAYLOAD = 512;

/** Serves the frame stream to whatever connects, one frame per write. */
function framedSender(where: { unix: string } | { port: 0 }) {
  let zeroWrites = 0;
  const listener = Bun.listen<undefined>({
    ...("unix" in where
      ? { unix: where.unix }
      : { hostname: "127.0.0.1", port: 0 }),
    socket: {
      async data(socket) {
        for (let i = 0; i < FRAMES; i++) {
          const f = Buffer.alloc(8 + PAYLOAD, i % 251);
          f.writeUInt32LE(i, 0);
          f.writeUInt32LE(PAYLOAD, 4);
          let off = 0;
          while (off < f.length) {
            const n = socket.write(f.subarray(off));
            if (n === 0) {
              zeroWrites++;
              await sleep(1);
              continue;
            }
            off += n;
          }
        }
      },
    },
  } as never);
  return { listener, zero: () => zeroWrites };
}

/** Reads the stream back and says what arrived, in how many reads. */
function framedReceiver(
  open: (onData: (b: Uint8Array) => void, onOpen: () => void) => void,
) {
  return new Promise<{
    frames: number;
    gaps: number;
    wrong: number;
    reads: number[];
    ms: number;
  }>((resolve, reject) => {
    const reads: number[] = [];
    let frames = 0;
    let gaps = 0;
    let wrong = 0;
    let expect = 0;
    let buf = Buffer.alloc(0);
    let t0 = 0;
    const timer = setTimeout(
      () => reject(new Error("frames timed out")),
      120_000,
    );
    open(
      (b) => {
        reads.push(b.length);
        buf =
          buf.length === 0
            ? Buffer.from(b)
            : Buffer.concat([buf, Buffer.from(b)]);
        for (;;) {
          if (buf.length < 8) break;
          const seq = buf.readUInt32LE(0);
          const len = buf.readUInt32LE(4);
          if (buf.length < 8 + len) break;
          const body = buf.subarray(8, 8 + len);
          buf = buf.subarray(8 + len);
          frames++;
          if (seq !== expect) gaps++;
          expect = seq + 1;
          if (len !== PAYLOAD || body[0] !== seq % 251) wrong++;
          if (frames >= FRAMES) {
            clearTimeout(timer);
            resolve({ frames, gaps, wrong, reads, ms: performance.now() - t0 });
            return;
          }
        }
      },
      () => (t0 = performance.now()),
    );
  });
}

const framedLine = (
  name: string,
  r: {
    frames: number;
    gaps: number;
    wrong: number;
    reads: number[];
    ms: number;
  },
  zero: number,
) => {
  const sorted = [...r.reads].sort((a, b) => a - b);
  return `${name}: ${r.frames}/${FRAMES} frames, ${r.gaps} out of sequence, ${r.wrong} malformed in ${r.ms.toFixed(0)} ms; ${r.reads.length} reads, p50 ${sorted[Math.floor(sorted.length / 2)]} B / max ${sorted[sorted.length - 1]} B against a ${8 + PAYLOAD} B frame; ${zero} sender writes took nothing`;
};

if (sshdUp) {
  // Through the forwarded Unix socket, and directly against the same kind
  // of socket with no ssh at all.
  for (const through of ["ssh -N -L", "no ssh"] as const) {
    const parts: string[] = [];
    const target = path.join(
      tmp,
      `frames-${through === "no ssh" ? "d" : "f"}.sock`,
    );
    const sender = framedSender({ unix: target });
    let fwdProc: { kill(sig?: string): void } | null = null;
    try {
      let sock = target;
      if (through === "ssh -N -L") {
        sock = path.join(tmp, "frames-fwd.sock");
        const f = await forward(sock, target, "N", () => fs.existsSync(sock));
        fwdProc = f.proc;
        if (!f.up) throw new Error("the forwarded socket never appeared");
      }
      const r = await framedReceiver((onData, onOpen) => {
        Bun.connect({
          unix: sock,
          socket: {
            open(s) {
              onOpen();
              s.write("go\n");
            },
            data(_s, chunk) {
              onData(chunk);
            },
          },
        });
      });
      parts.push(framedLine(through, r, sender.zero()));
    } catch (e) {
      parts.push(`fail — ${firstLine(e)}`);
    } finally {
      try {
        fwdProc?.kill("SIGKILL");
      } catch {}
      sender.listener.stop(true);
    }
    say(
      through === "no ssh" ? "frames-direct" : "frames-forwarded",
      parts.join("; "),
    );
  }
}

sh(["sudo", "-n", "pkill", "-f", `sshd.*-p ${port}`]);
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {}
process.exit(0);
