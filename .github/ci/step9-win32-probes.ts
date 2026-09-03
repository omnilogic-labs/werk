// Probes for §8 step 9's Windows half, on a real runner: can a Windows
// machine be an ssh client of a daemon it did not start, and what does the
// daemon's own socket cost as `AF_UNIX` against loopback TCP.
//
// Win32-OpenSSH forwards no Unix socket and no named pipe on either side
// (spike/win32-daemon), so the only route a Windows client has to a remote
// daemon is `ssh -L <local tcp port>:<something the far side can reach>`.
// This asks the runner to be both ends of that: its own sshd, its own
// forward, its own echo server. What it therefore does not exercise is a
// real network, a non-Windows sshd, and any RTT above loopback.
//
// One `PROBE <name>: <verdict>` line per question; nothing here throws.
//
//   bun run .github/ci/step9-win32-probes.ts

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
  step = 50,
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
    out: `${r.stdout.toString()}${r.stderr.toString()}`
      .replace(/\r/g, "")
      .trim(),
  };
}

const ps = (script: string) =>
  sh(["powershell", "-NoProfile", "-NonInteractive", "-Command", script]);

const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[
    Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  ]!;
};
const ms = (x: number) => (Number.isNaN(x) ? "-" : x.toFixed(2));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wp-step9-"));
const key = path.join(tmp, "id_ed25519");
const user = os.userInfo().username;

console.log(
  `platform=${process.platform} arch=${process.arch} bun=${Bun.version} release=${os.release()} user=${user} tmp=${tmp}`,
);

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

// Win32-OpenSSH cannot open `NUL` as a config file ("No such file or
// directory"), so an empty file stands in for /dev/null on both counts.
const emptyConf = path.join(tmp, "ssh_config.empty");
fs.writeFileSync(emptyConf, "");

function sshArgs(extra: string[] = []): string[] {
  return [
    "ssh",
    "-F",
    emptyConf,
    "-i",
    key,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    `UserKnownHostsFile=${path.join(tmp, "known_hosts")}`,
    "-o",
    "LogLevel=ERROR",
    "-o",
    "ExitOnForwardFailure=yes",
    ...extra,
    `${user}@127.0.0.1`,
  ];
}

// ------------------------------------------------------------------ sshd
// The image ships the OpenSSH client; the server is a Windows capability
// that may or may not be installed and whose service is stopped either way.
let sshdUp = false;
{
  const parts: string[] = [];
  try {
    parts.push(sh(["ssh", "-V"]).out.split("\n")[0] ?? "");
    const cap = ps(
      "(Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1 -ExpandProperty State)",
    );
    parts.push(`capability ${cap.out || `(exit ${cap.code})`}`);
    if (!/Installed/i.test(cap.out)) {
      const add = ps(
        "Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null; $?",
      );
      parts.push(`install ${add.out || `exit ${add.code}`}`);
    }
    sh(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key]);
    const pub = fs.readFileSync(`${key}.pub`, "utf8").trim();
    // An administrator's key goes in the machine-wide file, restricted to
    // Administrators and SYSTEM or sshd refuses it.
    const admin = path.join(
      process.env.ProgramData ?? "C:\\ProgramData",
      "ssh",
      "administrators_authorized_keys",
    );
    fs.mkdirSync(path.dirname(admin), { recursive: true });
    fs.writeFileSync(admin, `${pub}\n`);
    const acl = sh([
      "icacls",
      admin,
      "/inheritance:r",
      "/grant",
      "Administrators:F",
      "/grant",
      "SYSTEM:F",
    ]);
    parts.push(`icacls exit ${acl.code}`);
    const home = os.homedir();
    fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
    fs.writeFileSync(path.join(home, ".ssh", "authorized_keys"), `${pub}\n`);
    const start = ps("Start-Service sshd; (Get-Service sshd).Status");
    parts.push(
      `service ${start.out.split("\n").pop() || `exit ${start.code}`}`,
    );
    const t0 = performance.now();
    const up = await waitFor(
      () => sh([...sshArgs(), "whoami"]).code === 0,
      60_000,
      500,
    );
    sshdUp = up;
    const who = sh([...sshArgs(), "whoami"]);
    parts.push(
      `login ${up ? "ok" : "**failed**"} as ${who.out.split("\n").pop() ?? "?"} in ${ms(performance.now() - t0)} ms`,
    );
    if (!up)
      parts.push(`ssh said: ${who.out.split("\n").slice(-2).join(" / ")}`);
  } catch (e) {
    parts.push(`fail — ${firstLine(e)}`);
  }
  say("sshd-self", parts.join("; "));
}

/** `ssh -N -L …`, with the process kept so it can be killed. */
function forward(spec: string) {
  return Bun.spawn(sshArgs(["-N", "-L", spec]), {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function portAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

// --------------------------------------------------------- tcp -L forward
// A length-framed echo, the shape the daemon's protocol has: every frame
// that goes in has to come back whole and in order. Frames counted at the
// server say whether the forward coalesces writes.
function framedEcho() {
  let frames = 0;
  let bytes = 0;
  const listener = Bun.listen<undefined>({
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
  return { listener, stat: () => ({ frames, bytes }) };
}

if (sshdUp) {
  const parts: string[] = [];
  let fwd: ReturnType<typeof forward> | null = null;
  const echo = framedEcho();
  try {
    const local = await freePort();
    fwd = forward(`127.0.0.1:${local}:127.0.0.1:${echo.listener.port}`);
    const up = await waitFor(() => portAccepts(local), 20_000, 250);
    if (!up) throw new Error("the forwarded port never accepted");
    // 200 request/response round trips, then 8 MiB one way.
    const lat: number[] = [];
    let reads = 0;
    let got = 0;
    await new Promise<void>((resolve, reject) => {
      let i = 0;
      let t0 = 0;
      const s = net.connect(local, "127.0.0.1");
      s.setNoDelay(true);
      s.on("connect", () => {
        t0 = performance.now();
        s.write(`ping ${i}\n`);
      });
      s.on("data", (b) => {
        reads++;
        got += b.length;
        lat.push(performance.now() - t0);
        if (++i >= 200) {
          s.destroy();
          resolve();
          return;
        }
        t0 = performance.now();
        s.write(`ping ${i}\n`);
      });
      s.on("error", reject);
    });
    const s = echo.stat();
    parts.push(
      `200 round trips: p50 ${ms(pct(lat, 50))} / p90 ${ms(pct(lat, 90))} / max ${ms(Math.max(...lat))} ms; client read ${reads} times for ${got} B, server saw ${s.frames} frames / ${s.bytes} B`,
    );
  } catch (e) {
    parts.push(`fail — ${firstLine(e)}`);
  } finally {
    try {
      fwd?.kill();
    } catch {}
    echo.listener.stop(true);
  }
  say("tcp-forward", parts.join("; "));
}

// ----------------------------------------------- frames through the forward
// The step's stop condition: does the forwarded loopback port coalesce or
// drop frames where the Linux Unix-socket forward in findings/m5.md did
// not. 20,000 length-prefixed frames of 512 B, each stamped with its
// sequence number, sent from a server the forward reaches and parsed back
// on the far side: a dropped frame is a gap, a reordered one is a wrong
// stamp, and coalescing shows up as reads far larger than a frame.
async function framesThroughForward(connectPort: number): Promise<{
  frames: number;
  bytes: number;
  reads: number;
  readSizes: number[];
  gaps: number;
  wrong: number;
  ms: number;
}> {
  const N = 20_000;
  const PAY = 512;
  return new Promise((resolve, reject) => {
    const readSizes: number[] = [];
    let frames = 0;
    let bytes = 0;
    let gaps = 0;
    let wrong = 0;
    let expect = 0;
    let buf = Buffer.alloc(0);
    const t0 = performance.now();
    const s = net.connect(connectPort, "127.0.0.1");
    s.on("connect", () => s.write("go\n"));
    s.on("data", (b: Buffer) => {
      readSizes.push(b.length);
      bytes += b.length;
      buf = buf.length === 0 ? b : Buffer.concat([buf, b]);
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
        if (len !== PAY || body[0] !== seq % 251 || body[len - 1] !== seq % 251)
          wrong++;
        if (frames >= N) {
          s.destroy();
          resolve({
            frames,
            bytes,
            reads: readSizes.length,
            readSizes,
            gaps,
            wrong,
            ms: performance.now() - t0,
          });
          return;
        }
      }
    });
    s.on("error", reject);
    setTimeout(() => reject(new Error("frames timed out")), 120_000);
  });
}

if (sshdUp) {
  const parts: string[] = [];
  let fwd: ReturnType<typeof forward> | null = null;
  const N = 20_000;
  const PAY = 512;
  let sender: ReturnType<typeof Bun.listen<undefined>> | null = null;
  try {
    let zeroWrites = 0;
    sender = Bun.listen<undefined>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        async data(socket) {
          // One frame at a time, so a short write is visible as one.
          for (let i = 0; i < N; i++) {
            const f = Buffer.alloc(8 + PAY, i % 251);
            f.writeUInt32LE(i, 0);
            f.writeUInt32LE(PAY, 4);
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
    });
    const local = await freePort();
    fwd = forward(`127.0.0.1:${local}:127.0.0.1:${sender.port}`);
    if (!(await waitFor(() => portAccepts(local), 20_000, 250)))
      throw new Error("the forwarded port never accepted");
    const r = await framesThroughForward(local);
    const sizes = [...r.readSizes].sort((a, b) => a - b);
    parts.push(
      `${r.frames}/${N} frames, ${r.gaps} out of sequence, ${r.wrong} malformed, ${(r.bytes / 1048576).toFixed(1)} MiB in ${r.ms.toFixed(0)} ms`,
    );
    parts.push(
      `client reads: ${r.reads}, p50 ${sizes[Math.floor(sizes.length / 2)]} B / max ${sizes[sizes.length - 1]} B against a ${8 + PAY} B frame`,
    );
    parts.push(`${zeroWrites} sender writes took nothing`);
  } catch (e) {
    parts.push(`fail — ${firstLine(e)}`);
  } finally {
    try {
      fwd?.kill();
    } catch {}
    sender?.stop(true);
  }
  say("tcp-forward-frames", parts.join("; "));
}

// ------------------------------------------------- unix socket as a -L end
// Recorded because §8 step 9 leaves the far end of the forward open: "a
// remote unix socket or port". What Win32-OpenSSH says to each spelling.
if (sshdUp) {
  const parts: string[] = [];
  for (const [name, spec] of [
    [
      "remote unix",
      `127.0.0.1:${await freePort()}:${path.join(tmp, "remote.sock")}`,
    ],
    ["local unix", `${path.join(tmp, "local.sock")}:127.0.0.1:22`],
  ] as const) {
    const p = Bun.spawn(sshArgs(["-N", "-L", spec]), {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await Promise.race([
      new Response(p.stderr).text(),
      sleep(6000).then(() => "(no error within 6 s)"),
    ]);
    try {
      p.kill();
    } catch {}
    parts.push(
      `${name}: ${err.replace(/\r?\n/g, " ").trim().slice(0, 160) || "(silent)"}`,
    );
  }
  say("unix-as-forward-end", parts.join("; "));
}

// ------------------------------------------- AF_UNIX against loopback TCP
// The daemon's own socket, with no ssh in the path: what each transport
// costs on Windows. Connect time, request/response round trip, one-way
// bulk, and how many bytes the kernel takes before the first short write.
type Verdict = {
  connect: number[];
  rtt: number[];
  mibs: number;
  short: number;
  reads: number;
  sent: number;
  got: number;
  zeroWrites: number;
};

async function transport(
  kind: "unix" | "tcp",
  where: { unix?: string; hostname?: string; port?: number },
): Promise<Verdict> {
  const BULK = 16 * 1024 * 1024;
  const CHUNK = 64 * 1024;
  let serverSock: {
    write(b: Uint8Array | string): number;
    end(): void;
  } | null = null;
  const listener = Bun.listen<undefined>({
    ...(kind === "unix"
      ? { unix: where.unix! }
      : { hostname: where.hostname!, port: where.port! }),
    socket: {
      open(socket) {
        serverSock = socket;
      },
      data(socket, chunk) {
        socket.write(chunk);
      },
    },
  } as never);

  const connectOne = () =>
    new Promise<{
      write(b: Uint8Array | string): number;
      end(): void;
      onData(cb: (b: Uint8Array) => void): void;
      elapsed: number;
    }>((resolve, reject) => {
      const t0 = performance.now();
      let cb: ((b: Uint8Array) => void) | null = null;
      Bun.connect({
        ...(kind === "unix"
          ? { unix: where.unix! }
          : { hostname: where.hostname!, port: listenerPort() }),
        socket: {
          open(socket) {
            resolve({
              write: (b) => socket.write(b),
              end: () => socket.end(),
              onData: (f) => (cb = f),
              elapsed: performance.now() - t0,
            });
          },
          data(_s, chunk) {
            cb?.(chunk);
          },
          error: (_s, e) => reject(e),
          connectError: (_s, e) => reject(e),
        },
      } as never).catch(reject);
    });
  const listenerPort = () =>
    (listener as unknown as { port: number }).port ?? where.port!;

  const connect: number[] = [];
  for (let i = 0; i < 10; i++) {
    const c = await connectOne();
    connect.push(c.elapsed);
    c.end();
  }
  const c = await connectOne();
  const rtt: number[] = [];
  const ping = new TextEncoder().encode("ping\n");
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      c.onData(() => resolve());
      c.write(ping);
    });
    rtt.push(performance.now() - t0);
  }
  // One-way bulk from the server, counting the client's reads and the
  // bytes the kernel took before the first short write.
  let reads = 0;
  let got = 0;
  const t0 = performance.now();
  const done = new Promise<void>((resolve) => {
    c.onData((b) => {
      reads++;
      got += b.length;
      if (got >= BULK) resolve();
    });
  });
  let short = 0;
  let sent = 0;
  let zeroWrites = 0;
  const buf = new Uint8Array(CHUNK).fill(65);
  const deadline = Date.now() + 60_000;
  while (sent < BULK && Date.now() < deadline) {
    const want = Math.min(CHUNK, BULK - sent);
    const n = serverSock!.write(buf.subarray(0, want));
    if (n === 0) {
      zeroWrites++;
      await sleep(1);
      continue;
    }
    if (short === 0 && n < want) short = sent + n;
    sent += n;
    if (n < want) await sleep(1);
  }
  await Promise.race([done, sleep(30_000)]);
  const mibs = got / 1048576 / ((performance.now() - t0) / 1000);
  c.end();
  listener.stop(true);
  return { connect, rtt, mibs, short, reads, sent, got, zeroWrites };
}

{
  const line = (name: string, v: Verdict) =>
    `connect p50 ${ms(pct(v.connect, 50))} ms; round trip p50 ${ms(pct(v.rtt, 50))} / p90 ${ms(pct(v.rtt, 90))} / max ${ms(Math.max(...v.rtt))} ms; ${(v.sent / 1048576).toFixed(1)} MiB written, ${(v.got / 1048576).toFixed(1)} MiB read in ${v.reads} reads at ${v.mibs.toFixed(1)} MiB/s; first short write after ${v.short} B; ${v.zeroWrites} writes took nothing`;
  for (const [name, kind, where] of [
    ["af-unix", "unix", { unix: path.join(tmp, "t.sock") }],
    ["loopback-tcp", "tcp", { hostname: "127.0.0.1", port: 0 }],
  ] as const) {
    try {
      say(name, line(name, await transport(kind, { ...where })));
    } catch (e) {
      say(name, `fail — ${firstLine(e)}`);
    }
  }
}

// -------------------------------------------------------- the token file
// A loopback TCP port has no filesystem permissions, so what stands in for
// the socket's 0600 is a file holding the port and a random token. This
// asks what Windows can say about who may read such a file.
{
  const parts: string[] = [];
  try {
    const f = path.join(tmp, "wp.token");
    fs.writeFileSync(f, `${await freePort()} ${crypto.randomUUID()}\n`);
    const before = sh(["icacls", f]).out.split("\n").slice(0, 4).join(" | ");
    sh(["icacls", f, "/inheritance:r"]);
    const set = sh([
      "icacls",
      f,
      "/grant:r",
      `${process.env.USERDOMAIN ?? "."}\\${user}:F`,
    ]);
    const after = sh(["icacls", f]).out.split("\n").slice(0, 4).join(" | ");
    const readable = fs.readFileSync(f, "utf8").trim().length > 0;
    parts.push(`inherited ACL: ${before}`);
    parts.push(`after /inheritance:r /grant:r (exit ${set.code}): ${after}`);
    parts.push(`owner can still read: ${readable}`);
    parts.push(
      `node stat mode: ${(fs.statSync(f).mode & 0o777).toString(8)} (what Bun reports on NTFS, not an ACL)`,
    );
  } catch (e) {
    parts.push(`fail — ${firstLine(e)}`);
  }
  say("token-file", parts.join("; "));
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {}
process.exit(0);
