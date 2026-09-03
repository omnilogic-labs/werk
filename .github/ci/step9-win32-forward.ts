// §8 step 9's Windows claim, end to end on a real runner: a Windows `wp`
// completing `hello` with a daemon it did not start, through an `ssh -L`
// forward, and the same daemon's own socket measured as `AF_UNIX` against
// the loopback TCP landing it also carries.
//
// The daemon is the compiled `dist\wp.exe`, autostarted in a runtime
// directory of its own with `WP_TCP_LISTEN=1` so that it listens on both.
// The "remote" is this machine over its own sshd: what that arrangement
// exercises is the Windows ssh client's `-L`, a Windows sshd's side of the
// forward, and a `wp.exe` that has only a port to talk to. What it does not
// exercise is a real network, a non-Windows sshd, or any RTT worth the
// name.
//
// One `PROBE <name>: <verdict>` line per question; nothing here throws.
//
//   bun run .github/ci/step9-win32-forward.ts

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  connect,
  type Client,
} from "../../packages/werk-poc/src/client/index.ts";
import { readToken } from "../../packages/werk-poc/src/daemon/tcp.ts";

function say(name: string, verdict: string): void {
  const line = `PROBE ${name}: ${verdict}\n`;
  try {
    fs.writeSync(1, line);
  } catch {
    console.log(line.trimEnd());
  }
}

const firstLine = (e: unknown) =>
  (e instanceof Error ? `${e.name}: ${e.message}` : String(e))
    .split("\n")[0]!
    .trim();

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

function sh(cmd: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  return {
    code: r.exitCode ?? -1,
    out: `${r.stdout.toString()}${r.stderr.toString()}`
      .replace(/\r/g, "")
      .trim(),
  };
}

const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[
    Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  ]!;
};
const ms = (x: number) => (Number.isNaN(x) ? "-" : x.toFixed(2));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp-step9-fwd-"));
const local = path.join(root, "local"); // the "remote" daemon's %LOCALAPPDATA%
const runtime = path.join(local, "werk-poc");
const key = path.join(root, "id_ed25519");
const emptyConf = path.join(root, "ssh_config.empty");
const user = os.userInfo().username;
const wp = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "packages",
  "werk-poc",
  "dist",
  process.platform === "win32" ? "wp.exe" : "wp",
);
fs.mkdirSync(local, { recursive: true });
fs.writeFileSync(emptyConf, "");

const daemonEnv = {
  LOCALAPPDATA: local,
  WP_STATE_DIR: path.join(root, "state"),
  WP_TCP_LISTEN: "1",
};

console.log(
  `platform=${process.platform} bun=${Bun.version} user=${user} wp=${wp} exists=${fs.existsSync(wp)} root=${root}`,
);

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
    `UserKnownHostsFile=${path.join(root, "known_hosts")}`,
    "-o",
    "LogLevel=ERROR",
    "-o",
    "ExitOnForwardFailure=yes",
    ...extra,
    `${user}@127.0.0.1`,
  ];
}

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

const portAccepts = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });

let sshdUp = false;
let daemonUp = false;
let token = { port: 0, token: "" };
let forwardPort = 0;
let ssh: ReturnType<typeof Bun.spawn> | null = null;

// ------------------------------------------------------------------ sshd
{
  const parts: string[] = [];
  try {
    sh(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key]);
    const pub = fs.readFileSync(`${key}.pub`, "utf8").trim();
    const admin = path.join(
      process.env.ProgramData ?? "C:\\ProgramData",
      "ssh",
      "administrators_authorized_keys",
    );
    fs.mkdirSync(path.dirname(admin), { recursive: true });
    fs.writeFileSync(admin, `${pub}\n`);
    sh([
      "icacls",
      admin,
      "/inheritance:r",
      "/grant",
      "Administrators:F",
      "/grant",
      "SYSTEM:F",
    ]);
    fs.mkdirSync(path.join(os.homedir(), ".ssh"), { recursive: true });
    fs.writeFileSync(
      path.join(os.homedir(), ".ssh", "authorized_keys"),
      `${pub}\n`,
    );
    sh([
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Set-Service sshd -StartupType Manual; Start-Service sshd",
    ]);
    sshdUp = await waitFor(
      () => sh([...sshArgs(), "whoami"]).code === 0,
      60_000,
      500,
    );
    parts.push(
      `sshd ${sshdUp ? "answers" : "**never answered**"}: ${sh([
        ...sshArgs(),
        "whoami",
      ])
        .out.split("\n")
        .pop()}`,
    );
  } catch (e) {
    parts.push(`fail — ${firstLine(e)}`);
  }
  say("sshd", parts.join("; "));
}

// -------------------------------------------------- the "remote" daemon
{
  const parts: string[] = [];
  try {
    const t0 = performance.now();
    const start = sh([wp, "ls"], daemonEnv);
    parts.push(
      `\`wp ls\` in ${ms(performance.now() - t0)} ms, exit ${start.code}: ${start.out.split("\n")[0]}`,
    );
    const tokenFile = path.join(runtime, "wp.tcp");
    const there = await waitFor(() => fs.existsSync(tokenFile), 10_000, 100);
    if (!there) throw new Error(`no ${tokenFile}`);
    token = readToken(tokenFile);
    daemonUp = true;
    parts.push(
      `token file: port ${token.port}, ${token.token.length} hex chars`,
    );
    parts.push(`runtime dir holds ${fs.readdirSync(runtime).join(", ")}`);
  } catch (e) {
    parts.push(`fail — ${firstLine(e)}`);
  }
  say("daemon-tcp-listener", parts.join("; "));
}

// ------------------------------------------------------------ the forward
if (sshdUp && daemonUp) {
  const parts: string[] = [];
  try {
    forwardPort = await freePort();
    ssh = Bun.spawn(
      sshArgs(["-N", "-L", `127.0.0.1:${forwardPort}:127.0.0.1:${token.port}`]),
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const up = await waitFor(() => portAccepts(forwardPort), 20_000, 250);
    parts.push(
      `\`ssh -N -L 127.0.0.1:${forwardPort}:127.0.0.1:${token.port}\` ${up ? "accepts" : "**never accepted**"}`,
    );
    if (!up) throw new Error("no forward");
  } catch (e) {
    parts.push(`fail — ${firstLine(e)}`);
  }
  say("forward", parts.join("; "));
}

// ------------------------------------------- the compiled client's hello
if (forwardPort) {
  const parts: string[] = [];
  try {
    const t0 = performance.now();
    const good = sh([wp, "--socket", `tcp:127.0.0.1:${forwardPort}`, "ls"], {
      WP_TOKEN: token.token,
      // Nothing of this machine's own daemon: the client has only the port.
      LOCALAPPDATA: path.join(root, "client-appdata"),
    });
    parts.push(
      `\`wp.exe --socket tcp:127.0.0.1:${forwardPort} ls\` exit ${good.code} in ${ms(performance.now() - t0)} ms: ${JSON.stringify(good.out.split("\n").slice(0, 2).join(" / "))}`,
    );
    const bad = sh([wp, "--socket", `tcp:127.0.0.1:${forwardPort}`, "ls"], {
      WP_TOKEN: "",
      LOCALAPPDATA: path.join(root, "client-appdata"),
    });
    parts.push(
      `without the token: exit ${bad.code}: ${JSON.stringify(bad.out.split("\n")[0] ?? "")}`,
    );
  } catch (e) {
    parts.push(`fail — ${firstLine(e)}`);
  }
  say("wp-hello-through-forward", parts.join("; "));
}

// ------------------------- the same daemon over each transport, measured
// A session whose output is a file `type`d into the ConPTY, attached over
// each of the three routes in turn: the daemon's `AF_UNIX` socket, its
// loopback TCP landing directly, and that landing through the forward.
// What is compared is the round trip, what the client received against
// what the daemon says it sent, and the size of the reads it arrived in.
interface Route {
  name: string;
  open(): Promise<Client>;
}

const bigFile = path.join(root, "big.txt");
{
  const line = `${"x".repeat(78)}\n`;
  const chunks: string[] = [];
  for (let i = 0; i < 20_000; i++) chunks.push(line);
  fs.writeFileSync(bigFile, chunks.join(""));
}

async function measure(route: Route): Promise<string> {
  const ctl = await route.open();
  try {
    const rtt: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      await ctl.stats();
      rtt.push(performance.now() - t0);
    }
    const { id } = await ctl.run({
      argv: ["cmd.exe", "/c", `type ${bigFile}`],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        SYSTEMROOT: process.env.SYSTEMROOT ?? "C:\\Windows",
        TEMP: root,
        TMP: root,
      },
      cols: 80,
      rows: 24,
    });
    let frames = 0;
    let bytes = 0;
    let lags = 0;
    const t0 = performance.now();
    const att = await ctl.attach(id, {
      cols: 80,
      rows: 24,
      readOnly: true,
      onOutput: (b) => {
        frames++;
        bytes += b.length;
      },
      onLag: () => lags++,
    });
    // The session ends when `type` does; wait for the output to stop.
    let last = -1;
    await waitFor(
      () => {
        const settled = bytes === last && bytes > 0;
        last = bytes;
        return settled;
      },
      60_000,
      500,
    );
    const wall = performance.now() - t0;
    const stats = await ctl.stats();
    const conn = stats.connections.find((c) => c.attached === id);
    await att.detach().catch(() => {});
    await ctl.kill(id, "SIGKILL").catch(() => {});
    return `${route.name}: \`stats\` round trip p50 ${ms(pct(rtt, 50))} / p90 ${ms(pct(rtt, 90))} / max ${ms(Math.max(...rtt))} ms; attach took ${frames} frames / ${(bytes / 1048576).toFixed(2)} MiB in ${wall.toFixed(0)} ms (${(bytes / 1048576 / (wall / 1000)).toFixed(1)} MiB/s), daemon sent ${((conn?.bytesSent ?? 0) / 1048576).toFixed(2)} MiB, dropped ${conn?.droppedBytes ?? 0} B, lag ${lags}×`;
  } finally {
    ctl.close();
  }
}

for (const route of [
  { name: "af-unix", open: () => connect({ dir: runtime, autostart: false }) },
  {
    name: "loopback-tcp",
    open: () =>
      connect({
        socket: `tcp:127.0.0.1:${token.port}`,
        token: token.token,
      }),
  },
  ...(forwardPort
    ? [
        {
          name: "loopback-tcp through ssh -L",
          open: () =>
            connect({
              socket: `tcp:127.0.0.1:${forwardPort}`,
              token: token.token,
            }),
        },
      ]
    : []),
] as Route[]) {
  if (!daemonUp) break;
  try {
    say(`route-${route.name.split(" ")[0]}`, await measure(route));
  } catch (e) {
    say(`route-${route.name.split(" ")[0]}`, `fail — ${firstLine(e)}`);
  }
}

// ------------------------------------------------------------- teardown
try {
  ssh?.kill();
} catch {}
if (daemonUp) {
  try {
    const ctl = await connect({ dir: runtime, autostart: false });
    await ctl.shutdown().catch(() => {});
    ctl.close();
  } catch {}
  await sleep(500);
}
try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {}
process.exit(0);
