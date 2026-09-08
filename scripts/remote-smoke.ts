// Measure what a remote werk would have to live with, against a real machine.
//
// The questions this answers cannot be answered on one box: whether a binary
// cross-compiled here runs there, whether a daemon started over ssh outlives
// the ssh, what `ssh -L` gives the client-side checks to look at, and what a
// keystroke costs through the forward. Every one of them is a property of the
// pair of machines, so this takes a host and goes and looks.
//
// It is not part of `bun test`: it needs a box you can reach with key auth and
// it starts processes there. Run it by hand.
//
//   bun run build && bun scripts/remote-smoke.ts --host agent-sandboxes
//
// Everything it creates on the far end lives under one directory named after
// the run, and the `finally` removes it along with the daemons and the local
// forwards. `--keep` is there for when a failure needs looking at.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { connectSessionClient } from "../packages/session/dist/index.js";
import type {
  AttachmentEvent,
  SessionClient,
} from "../packages/session/dist/index.js";
import { openLocalTransport } from "../packages/session-daemon/dist/index.js";
// The compatibility surface itself, rather than a second copy of its rule here:
// this check is only worth anything if it is the one the transport applies.
import { notPrivateToOwner } from "../packages/session-daemon/dist/platform/index.js";
import { openForward } from "../packages/werk/src/host/forward.js";
import { openHostSession } from "../packages/werk/src/host/session.js";
import {
  fingerprintSetup,
  runHostSetup,
  setupStampFile,
  setupHintFile,
} from "../packages/werk/src/host/setup.js";
import { spawnRunner } from "../packages/werk/src/host/ssh.js";
import { HostError } from "../packages/werk/src/host/types.js";
import type { SetupBlock } from "../packages/werk/src/config/setup.js";
import type { WerkContext } from "../packages/werk/src/runtime/context.js";
import { createStyles } from "../packages/werk/src/runtime/style.js";
import { roles } from "../packages/palette/dist/index.js";

export type Options = {
  host?: string;
  rounds: number;
  keep: boolean;
  binary?: string;
  help: boolean;
};

export class UsageError extends Error {}

export const usage = `Measure a remote werk against a machine you can ssh to.

  bun scripts/remote-smoke.ts --host <name> [options]

Checks, in order:
  compile   cross-compile the CLI for bun-linux-x64; report bytes and seconds
  deploy    copy it over and run it there
  survive   whether a daemon outlives the ssh that started it
  forward   what \`ssh -L\` hands the client-side socket checks
  latency   keystroke round trip through a -N forward and through a -tt one
  transport the CLI's own remote path, end to end: probe, install, forward
  setup     a [setup.<name>] block against a real \$HOME and a real login shell

Options:
  --host <name>     the ssh destination, as ssh itself would take it
  --binary <path>   skip the compile and send this binary instead
  --rounds <n>      samples per latency figure (default 40)
  --keep            leave the remote directory, the daemons and the forwards
  -h, --help        this text

Needs \`bun run build\` first: the harness talks to the daemon through the
built packages, and the CLI's own entrypoint imports them.

Exit status: 0 every check passed, 1 a check failed, 2 a usage mistake.`;

export function parseArgs(argv: string[]): Options {
  const options: Options = { rounds: 40, keep: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i]!;
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "--keep") options.keep = true;
    else if (
      argument === "--host" ||
      argument === "--rounds" ||
      argument === "--binary"
    ) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-"))
        throw new UsageError(`${argument} needs a value`);
      if (argument === "--host") options.host = value;
      else if (argument === "--binary") options.binary = value;
      else {
        const rounds = Number(value);
        if (!Number.isInteger(rounds) || rounds < 1)
          throw new UsageError("--rounds must be a whole number above zero");
        options.rounds = rounds;
      }
      i += 1;
    } else throw new UsageError(`Unknown argument ${argument}`);
  }
  return options;
}

/** One line of the report. A check that cannot decide is a failure. */
type Check = { name: string; ok: boolean; detail: string };

const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name.padEnd(28)}  ${detail}`);
}
function note(name: string, detail: string) {
  console.log(`      ${name.padEnd(28)}  ${detail}`);
}

/** Quote a string for a remote `sh -c`, which is what sshd gives a command. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const SSH_BASE = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ExitOnForwardFailure=yes",
  "-o",
  "StreamLocalBindUnlink=yes",
];

type RunResult = { status: number | null; stdout: string; stderr: string };

function ssh(host: string, args: string[], timeoutMs = 60_000): RunResult {
  const result = spawnSync("ssh", [...SSH_BASE, host, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
  return {
    status: result.status,
    stdout: (result.stdout ?? "").replaceAll("\r", "").trim(),
    stderr: (result.stderr ?? "").replaceAll("\r", "").trim(),
  };
}

/** A remote command under a pty, which is the harsher case for a daemon. */
function sshPty(host: string, command: string, timeoutMs = 60_000): RunResult {
  const result = spawnSync(
    "ssh",
    [...SSH_BASE, "-tt", host, command],
    // A pty echoes stdin, so give it nothing to echo.
    {
      encoding: "utf8",
      input: "",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    },
  );
  return {
    status: result.status,
    stdout: (result.stdout ?? "").replaceAll("\r", "").trim(),
    stderr: (result.stderr ?? "").replaceAll("\r", "").trim(),
  };
}

/** `unix /run/werk/daemon.sock`, or `tcp 127.0.0.1:49731`. */
const describe = (endpoint: {
  kind: string;
  path?: string;
  host?: string;
  port?: number;
}) =>
  endpoint.kind === "unix"
    ? `unix ${endpoint.path}`
    : `tcp ${endpoint.host}:${endpoint.port}`;

const quantile = (samples: number[], p: number) =>
  samples.slice().sort((a, b) => a - b)[
    Math.min(samples.length - 1, Math.floor(samples.length * p))
  ]!;

const summarise = (samples: number[]) =>
  `p50 ${quantile(samples, 0.5).toFixed(1)} p90 ${quantile(samples, 0.9).toFixed(1)} max ${Math.max(...samples).toFixed(1)}`;

/**
 * Keystroke to first painted byte, and to the byte the session writes a
 * moment later.
 *
 * The second write is the one that matters. Nagle only ever holds a small
 * write that follows an unacknowledged one, so a session answering a key with
 * a single write says nothing about it; a session answering with two says
 * whether the transport is holding the tail of a redraw back for a round trip.
 * `noise` is a second client polling the daemon down the same connection,
 * because Nagle also needs data in flight to have something to wait for.
 */
async function keystrokeLatency(
  socket: string,
  rounds: number,
  noise: boolean,
): Promise<{ request: string; firstWrite: string; secondWrite: string }> {
  const client = await connectSessionClient({
    transport: await openLocalTransport({ kind: "unix", path: socket }),
    requestTimeoutMs: 20_000,
  });
  let poller: SessionClient | undefined;
  let polling = true;
  try {
    const request: number[] = [];
    for (let i = 0; i < rounds; i += 1) {
      const started = performance.now();
      await client.daemonInfo();
      request.push(performance.now() - started);
    }

    const session = await client.create({
      argv: [
        "sh",
        "-c",
        "stty -echo; while IFS= read -r line; do printf X; sleep 0.002; printf Y; done",
      ],
      cwd: "/tmp",
      size: { cols: 80, rows: 24 },
    });

    let seen = "";
    let wanted = "";
    let arrived: (() => void) | undefined;
    const attachment = await client.attach(session.id, {
      representation: "vt",
      permissions: { read: true, input: true },
      onEvent: (event: AttachmentEvent) => {
        if (event.type !== "output") return;
        seen += new TextDecoder().decode(event.data);
        if (wanted && seen.includes(wanted)) arrived?.();
      },
    });
    // The shell has to reach its `read` before a keystroke means anything.
    await Bun.sleep(400);

    if (noise) {
      poller = await connectSessionClient({
        transport: await openLocalTransport({ kind: "unix", path: socket }),
        requestTimeoutMs: 20_000,
      });
      void (async () => {
        while (polling) {
          try {
            await poller!.readScreen(session.id);
          } catch {
            return;
          }
          await Bun.sleep(5);
        }
      })();
    }

    const firstWrite: number[] = [];
    const secondWrite: number[] = [];
    for (let i = 0; i < rounds; i += 1) {
      seen = "";
      wanted = "X";
      let first = 0;
      const started = performance.now();
      const gotFirst = new Promise<void>((resolve) => {
        arrived = () => {
          first = performance.now();
          resolve();
        };
      });
      // Deliberately not awaited: the round trip being measured starts with
      // this frame leaving, not with the daemon's reply to it coming back.
      void attachment.writeInput(new TextEncoder().encode("\n"));
      await gotFirst;
      wanted = "XY";
      if (!seen.includes("XY"))
        await new Promise<void>((resolve) => (arrived = resolve));
      firstWrite.push(first - started);
      secondWrite.push(performance.now() - started);
      await Bun.sleep(40);
    }

    polling = false;
    await client.terminate(session.id, "force").catch(() => {});
    await client.remove(session.id).catch(() => {});
    return {
      request: summarise(request),
      firstWrite: summarise(firstWrite),
      secondWrite: summarise(secondWrite),
    };
  } finally {
    polling = false;
    await poller?.close().catch(() => {});
    await client.close().catch(() => {});
  }
}

/** Start a forward and wait for the socket it binds to appear. */
async function forward(
  host: string,
  options: string[],
  command: string[],
  socket: string,
): Promise<{ kill: () => void }> {
  const child = Bun.spawn(["ssh", ...SSH_BASE, ...options, host, ...command], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await fs.lstat(socket).catch(() => null))
      return { kill: () => child.kill() };
    if (child.exitCode !== null) break;
    await Bun.sleep(100);
  }
  child.kill();
  throw new Error(`forward to ${socket} never came up`);
}

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(Bun.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    console.error(`\n${usage}`);
    return 2;
  }
  if (options.help) {
    console.log(usage);
    return 0;
  }
  const host = options.host;
  if (host === undefined) {
    console.error("--host is required.\n");
    console.error(usage);
    return 2;
  }
  const here = path.resolve(import.meta.dir, "..");
  if (
    !(await Bun.file(
      path.join(here, "packages/session/dist/index.js"),
    ).exists())
  ) {
    console.error("The built packages are missing. Run `bun run build` first.");
    return 2;
  }

  const tag = randomBytes(4).toString("hex");
  const remoteDir = `/tmp/werk-smoke-${tag}`;
  const localDir = `/tmp/werk-smoke-${tag}`;
  const forwards: { kill: () => void }[] = [];
  let binary = options.binary;
  let transport: { close(): Promise<void> } | undefined;
  /** The binary the transport check installed, so the teardown can remove it. */
  let installed: string | undefined;
  /** What the setup check left under the far side's own `$HOME`. */
  const setupLeft: string[] = [];

  try {
    // The forwarded sockets land here, and `openLocalTransport` refuses a
    // parent directory that is not the daemon's own 0700.
    await fs.mkdir(localDir, { recursive: true });
    await fs.chmod(localDir, 0o700);

    // 1. Cross-compilation. The flags are `packages/werk/build.ts` plus a
    //    target, which is the only thing that has to change for a binary the
    //    far end can run.
    if (binary === undefined) {
      binary = path.join(localDir, "werk-linux-x64");
      const started = performance.now();
      const built = spawnSync(
        process.execPath,
        [
          "build",
          "--compile",
          "--target=bun-linux-x64",
          "--define",
          "WERK_COMPILED=true",
          "--no-compile-autoload-dotenv",
          "--outfile",
          binary,
          path.join(here, "packages/werk/src/main.ts"),
        ],
        { cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const bytes = built.status === 0 ? (await fs.stat(binary)).size : 0;
      record(
        "compile bun-linux-x64",
        built.status === 0,
        built.status === 0
          ? `${bytes} bytes (${(bytes / 1024 / 1024).toFixed(1)} MiB) in ${seconds}s`
          : (built.stderr ?? "").trim().split("\n").slice(-3).join(" "),
      );
      if (built.status !== 0) return 1;
    } else note("compile bun-linux-x64", `skipped, sending ${binary}`);

    // 2. Does it run over there. The runtime directory is made 0700 here
    //    because the daemon's own checks refuse anything looser.
    const slots = ["auto", "nohup", "setsid", "bare"];
    const made = ssh(host, [
      `mkdir -p ${slots.map((slot) => `${remoteDir}/rt-${slot} ${remoteDir}/state-${slot}`).join(" ")} && chmod 700 ${slots.map((slot) => `${remoteDir}/rt-${slot}`).join(" ")}`,
    ]);
    if (made.status !== 0) {
      record("deploy", false, `mkdir failed: ${made.stderr}`);
      return 1;
    }
    const copyStarted = performance.now();
    const copied = spawnSync(
      "scp",
      ["-o", "BatchMode=yes", "-q", binary, `${host}:${remoteDir}/werk`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 },
    );
    const copySeconds = ((performance.now() - copyStarted) / 1000).toFixed(1);
    if (copied.status !== 0) {
      record("deploy", false, `scp failed: ${(copied.stderr ?? "").trim()}`);
      return 1;
    }
    const remoteWerk = `${remoteDir}/werk`;
    const version = ssh(host, [
      `chmod +x ${remoteWerk} && ${remoteWerk} --version`,
    ]);
    record(
      "deploy",
      version.status === 0,
      version.status === 0
        ? `werk ${version.stdout} runs there; copied in ${copySeconds}s`
        : `${version.status}: ${version.stderr}`,
    );
    const help = ssh(host, [`${remoteWerk} daemon serve --help`]);
    record(
      "daemon serve --help",
      help.status === 0 && help.stdout.includes("--runtime-dir"),
      help.status === 0 ? "prints its options" : help.stderr,
    );
    note(
      "host",
      ssh(host, ["uname -srm; ldd --version | head -1"]).stdout.replaceAll(
        "\n",
        "; ",
      ),
    );

    // 3. Does a daemon outlive the ssh that started it. Four forms, all of
    //    them under a pty, because closing a pty hangs its session up and
    //    that is the case a background job does not survive. `-T` is the
    //    kinder one and tells you less.
    const flags = (slot: string) =>
      `--runtime-dir ${remoteDir}/rt-${slot} --state-dir ${remoteDir}/state-${slot}`;
    const alive = (slot: string) =>
      ssh(host, [
        `p=$(sed -n 's/.*"pid":\\([0-9]*\\).*/\\1/p' ${remoteDir}/state-${slot}/daemon.json 2>/dev/null); ` +
          `[ -n "$p" ] && ps -o pid=,ppid=,pgid=,sid=,stat= -p "$p" 2>/dev/null | tr -s ' ' || echo none`,
      ]).stdout.trim();
    const parse = (row: string) => {
      const [pid, ppid, pgid, sid, stat] = row.trim().split(/\s+/);
      return { pid, ppid, pgid, sid, stat };
    };
    /** Start a daemon in one of the four forms and give it time to record itself. */
    const start = async (slot: string, command: string) => {
      sshPty(host, command);
      await Bun.sleep(3000);
      return alive(slot);
    };

    const autostart = sshPty(host, `${remoteWerk} ${flags("auto")} list`);
    const autoRow = alive("auto");
    const auto = parse(autoRow);
    record(
      "survive: CLI autostart",
      autostart.status === 0 && autoRow !== "none",
      autoRow === "none"
        ? "the daemon was gone once the ssh had exited"
        : `pid ${auto.pid} ppid ${auto.ppid} pgid ${auto.pgid} sid ${auto.sid} stat ${auto.stat}`,
    );
    record(
      "survive: Bun detached setsid",
      autoRow !== "none" && auto.pid === auto.sid,
      autoRow === "none"
        ? "nothing to look at"
        : auto.pid === auto.sid
          ? "sid equals pid, so `detached: true` calls setsid()"
          : `sid ${auto.sid} is not pid ${auto.pid}: the daemon shares the ssh session`,
    );

    // `setsid --fork` in the foreground: the parent returns as soon as the
    // child is in its own session, so the shell exits with nothing left in
    // the pty's process group to be hung up.
    const setsidRow = await start(
      "setsid",
      `setsid --fork ${remoteWerk} daemon serve ${flags("setsid")} </dev/null >/dev/null 2>&1`,
    );
    record(
      "survive: setsid --fork",
      setsidRow !== "none" && parse(setsidRow).pid === parse(setsidRow).sid,
      setsidRow === "none"
        ? "left no daemon behind"
        : `pid ${parse(setsidRow).pid}, its own session`,
    );

    // The same thing backgrounded. Under a pty this is a race the daemon
    // usually loses: the shell exits, the pty hangs up, and SIGHUP reaches
    // the job in the shell's own process group before `nohup` has had a
    // chance to ignore it.
    const nohupRow = await start(
      "nohup",
      `setsid nohup ${remoteWerk} daemon serve ${flags("nohup")} </dev/null >/dev/null 2>&1 & echo started`,
    );
    note(
      "form: setsid nohup … &",
      nohupRow === "none"
        ? "lost the hangup race under a pty; add a short sleep after the & or drop the &"
        : `survived: pid ${parse(nohupRow).pid}`,
    );

    const bareRow = await start(
      "bare",
      `${remoteWerk} daemon serve ${flags("bare")} >/dev/null 2>&1 & echo started`,
    );
    note(
      "form: bare &",
      bareRow === "none"
        ? "did not survive the hangup, as a job in the pty's session would not"
        : `survived: ${bareRow}`,
    );

    // 4. What `ssh -L` gives the client-side checks to look at.
    const remoteSocket = `${remoteDir}/rt-auto/daemon.sock`;
    const plain = path.join(localDir, "plain.sock");
    const carried = path.join(localDir, "carried.sock");
    forwards.push(
      await forward(host, ["-N", "-L", `${plain}:${remoteSocket}`], [], plain),
    );
    forwards.push(
      await forward(
        host,
        ["-tt", "-L", `${carried}:${remoteSocket}`],
        ["sleep", "100000"],
        carried,
      ),
    );
    const forwardStat = await fs.lstat(plain);
    const localStat = await fs.stat(localDir);
    record(
      "forward: socket is private",
      // The daemon's own rule, rather than a second copy of it here: this
      // check is only worth anything if it is the one the transport applies.
      forwardStat.isSocket() &&
        !forwardStat.isSymbolicLink() &&
        !notPrivateToOwner(forwardStat),
      `mode ${(forwardStat.mode & 0o777).toString(8)}, uid ${forwardStat.uid}, socket ${forwardStat.isSocket()}`,
    );
    note(
      "forward: parent directory",
      `mode ${(localStat.mode & 0o777).toString(8)} — openLocalTransport refuses anything but 0700`,
    );
    let opened = "";
    try {
      const transport = await openLocalTransport({ kind: "unix", path: plain });
      const client = await connectSessionClient({
        transport,
        requestTimeoutMs: 10_000,
      });
      opened = (await client.daemonInfo()).version;
      await client.close();
    } catch (error) {
      opened = "";
      note("forward: open failed", (error as Error).message);
    }
    record(
      "forward: openLocalTransport",
      opened !== "",
      opened !== ""
        ? `handshake through the forward reached daemon ${opened}`
        : "the client-side checks refused the forwarded socket",
    );

    // A looser directory is what a caller would reach for first, so say what
    // it costs rather than leaving it to be discovered.
    const looseDir = path.join(localDir, "loose");
    await fs.mkdir(looseDir, { recursive: true, mode: 0o755 });
    await fs.chmod(looseDir, 0o755);
    const loose = path.join(looseDir, "loose.sock");
    forwards.push(
      await forward(host, ["-N", "-L", `${loose}:${remoteSocket}`], [], loose),
    );
    let looseError = "opened, which the 0700 rule says it should not have";
    try {
      await openLocalTransport({ kind: "unix", path: loose });
    } catch (error) {
      looseError = (error as Error).message;
    }
    record(
      "forward: 0755 parent refused",
      looseError.includes("0700"),
      looseError,
    );

    // ExitOnForwardFailure only covers binding the listener. A remote socket
    // that is not there is not a bind failure, so ssh stays up and the client
    // gets a connection that closes immediately.
    const occupied = spawnSync(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "StreamLocalBindUnlink=no",
        "-N",
        "-L",
        `${plain}:${remoteSocket}`,
        host,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 },
    );
    record(
      "forward: bind failure exits",
      occupied.status !== null && occupied.status !== 0,
      `ssh exited ${occupied.status} rather than staying up without a forward`,
    );

    const missing = path.join(localDir, "missing.sock");
    forwards.push(
      await forward(
        host,
        ["-N", "-L", `${missing}:${remoteDir}/rt-auto/absent.sock`],
        [],
        missing,
      ),
    );
    let missingDetail = "the connection stayed open";
    try {
      const transport = await openLocalTransport(
        { kind: "unix", path: missing },
        3000,
      );
      const read = await transport.readable.getReader().read();
      missingDetail = read.done
        ? "connect succeeds and the stream ends at once — no connect-time error"
        : "the connection carried bytes";
    } catch (error) {
      missingDetail = `threw: ${(error as Error).message}`;
    }
    note("forward: missing remote socket", missingDetail);

    // 5. What a keystroke costs through each forward. The pair is the whole
    //    point: `-N` opens no session channel, `-tt` carries a pty beside the
    //    forward, and the question is whether that changes the shape.
    for (const [label, socket] of [
      ["-N", plain],
      ["-tt", carried],
    ] as const) {
      for (const noisy of [false, true]) {
        const measured = await keystrokeLatency(socket, options.rounds, noisy);
        note(
          `latency ${label}${noisy ? " + poller" : ""}`,
          `request ${measured.request} | first write ${measured.firstWrite} | second write ${measured.secondWrite}`,
        );
      }
    }
    record("latency", true, `${options.rounds} samples per figure, in ms`);

    // 6. The path the CLI itself takes, rather than a reconstruction of it.
    //    Everything above measures a property of the pair of machines; this
    //    runs `packages/werk/src/host/` against the same box and reports what
    //    it decided. It uses the far side's ordinary directories on purpose —
    //    guessing them is the thing the transport is built not to do — so the
    //    teardown kills what it started.
    const transportRuntime = path.join(localDir, "transport");
    await fs.mkdir(transportRuntime, { recursive: true });
    await fs.chmod(transportRuntime, 0o700);
    const session = openHostSession({
      name: "smoke",
      host: { kind: "ssh", sshHost: host },
      runtimeDir: transportRuntime,
      stateDir: path.join(localDir, "transport-state"),
      entry: path.join(here, "packages/werk/src/main.ts"),
    });
    transport = session;
    try {
      const ready = await session.ready();
      installed = ready.installed.binary;
      record(
        "transport: probe",
        true,
        `${ready.facts.uname} ${ready.facts.arch} ${ready.facts.libc}, ` +
          `home ${ready.facts.home}, rsync ${ready.facts.rsync}, ` +
          `claude ${ready.facts.claudeConfig ?? "not configured"}`,
      );
      record("transport: target", true, ready.target.target);
      record("transport: install", true, ready.installed.reason);
      record(
        "transport: remote endpoint",
        true,
        `${describe(ready.report.endpoint)}, runtime ${ready.report.runtimeDir}`,
      );
      const client = await connectSessionClient({
        transport: await openLocalTransport(ready.forward.endpoint),
        requestTimeoutMs: 10_000,
      });
      const info = await client.daemonInfo();
      await client.close();
      record(
        "transport: daemon reached",
        true,
        `${describe(ready.forward.endpoint)} answered as ${info.version}`,
      );
    } catch (error) {
      record(
        "transport",
        false,
        error instanceof HostError
          ? `${error.code}: ${error.message.split("\n")[0]}`
          : String(error),
      );
    }

    // The fault ExitOnForwardFailure cannot catch, through the real code
    // rather than through a reconstruction of it.
    let missingCode = "came up, which it should not have";
    try {
      await openForward({
        sshHost: host,
        runtimeDir: transportRuntime,
        remote: { kind: "unix", path: `${remoteDir}/rt-auto/absent.sock` },
        runner: spawnRunner(),
        timeoutMs: 4000,
      });
    } catch (error) {
      missingCode = error instanceof HostError ? error.code : String(error);
    }
    record(
      "transport: missing socket named",
      missingCode === "HOST_DAEMON_MISSING",
      missingCode,
    );

    // 7. A setup block, against the only thing that can answer for one: a real
    //    `$HOME`, a real login shell, and the real ssh stdin pipe carrying the
    //    tar. Everything about a setup that a test can settle without a machine
    //    is settled in `packages/werk/test/host/setup.test.ts`; what is left is
    //    whether the login shell over there finds what the block expects.
    const setupBlock = `smoke-${tag}`;
    const setupLanding = `.werk-smoke-${tag}`;
    setupLeft.push(`"$HOME/${setupLanding}"`);
    const copyFrom = path.join(localDir, "setup-copy");
    await fs.mkdir(copyFrom, { recursive: true });
    await Bun.write(
      path.join(copyFrom, "hello.sh"),
      '#!/bin/sh\nprintf %s "$WERK_SMOKE_TOKEN"\n',
    );
    await fs.chmod(path.join(copyFrom, "hello.sh"), 0o755);
    const setupHome = `$HOME/${setupLanding}`;
    const block: SetupBlock = {
      copy: copyFrom,
      to: `${setupLanding}/sent`,
      run: [
        // Proves the executable bit survived the tar and that the block's `env`
        // reached the command.
        `"${setupHome}/sent/hello.sh" > "${setupHome}/token"`,
        // The one thing no test on one machine can answer: whether a login
        // shell over there has `claude` on its PATH.
        `command -v claude > "${setupHome}/claude" || printf '' > "${setupHome}/claude"`,
      ],
    };
    const setupState = path.join(localDir, "setup-state");
    const ctx: WerkContext = {
      write: () => {},
      // The far side's own output, which is what a person would see on stderr.
      writeError: (text) => void process.stderr.write(text),
      stdoutTTY: false,
      stdinTTY: false,
      columns: 80,
      style: createStyles(0),
      theme: roles(),
      colourLevel: 0,
      json: false,
      noInput: true,
      yes: true,
      runtimeDir: transportRuntime,
      stateDir: setupState,
      entry: path.join(here, "packages/werk/src/main.ts"),
      hosts: {},
      hostProblems: [],
      defaultHost: "smoke",
      setups: { [setupBlock]: block },
      hostOrigin: {},
    };
    const setupHost = {
      kind: "ssh" as const,
      sshHost: host,
      setup: setupBlock,
      env: { WERK_SMOKE_TOKEN: `token-${tag}` },
    };
    const expected = (await fingerprintSetup(block)).fingerprint;
    try {
      const first = await runHostSetup({
        ctx,
        name: "smoke",
        host: setupHost,
        runner: spawnRunner(),
      });
      record(
        "setup: ran",
        first.state === "ran",
        first.state === "ran"
          ? `${first.commands} commands, ${first.copied ?? 0} entries sent, ${first.fingerprint}`
          : `answered ${first.state}`,
      );
      const token = ssh(host, [`cat "${setupHome}/token"`]);
      record(
        "setup: copy and env arrived",
        token.stdout.trim() === `token-${tag}`,
        `hello.sh printed ${JSON.stringify(token.stdout.trim())}`,
      );
      const claude = ssh(host, [`cat "${setupHome}/claude"`]).stdout.trim();
      note(
        "setup: claude on the login shell",
        claude === "" ? "not on it" : claude,
      );
      const remoteHome = ssh(host, ['printf %s "$HOME"']).stdout.trim();
      setupLeft.push(`"$HOME/.local/share/werk/setup/${setupBlock}"`);
      const stamp = ssh(host, [
        `cat ${shellQuote(setupStampFile(remoteHome, setupBlock))}`,
      ]).stdout.trim();
      record(
        "setup: stamped last",
        stamp === expected,
        `${remoteHome} carries ${stamp || "no stamp"}, werk computed ${expected}`,
      );

      // Nothing changed, so nothing happens — and with the local hint in place
      // the machine is not asked at all.
      const second = await runHostSetup({
        ctx,
        name: "smoke",
        host: setupHost,
        runner: spawnRunner(),
      });
      record(
        "setup: second run does nothing",
        second.state === "current" && second.asked === false,
        second.state === "current"
          ? `answered from ${second.asked ? "the machine" : "the local hint"}`
          : `answered ${second.state}`,
      );

      // With the hint gone the machine answers instead, which is the property
      // that makes a second laptop correct without either knowing the other.
      await fs.rm(setupHintFile(setupState, "smoke"), { force: true });
      const third = await runHostSetup({
        ctx,
        name: "smoke",
        host: setupHost,
        runner: spawnRunner(),
      });
      record(
        "setup: the machine is the authority",
        third.state === "current" && third.asked === true,
        third.state === "current"
          ? `answered from ${third.asked ? "the machine" : "the local hint"}`
          : `answered ${third.state}`,
      );
    } catch (error) {
      record(
        "setup",
        false,
        error instanceof HostError
          ? `${error.code}: ${error.message.split("\n")[0]}`
          : String(error),
      );
    }

    const failed = checks.filter((check) => !check.ok);
    console.log(
      `\n${checks.length - failed.length}/${checks.length} checks passed`,
    );
    return failed.length === 0 ? 0 : 1;
  } finally {
    // `pkill -f` reads its pattern as a regular expression and matches every
    // command line including the shell running this one, which holds the
    // pattern verbatim. Bracketing the first character keeps it off itself.
    await transport?.close().catch(() => {});
    // The transport check installs a binary under the far side's own
    // `~/.local/share/werk/bin` and may have started a daemon from it, neither
    // of which is under `remoteDir`, so both are named here.
    const installedTeardown =
      installed === undefined
        ? ""
        : `pkill -f '[${installed[0]}]${installed.slice(1)} daemon serve'; ` +
          // The far side is POSIX, so the directory is the path up to the
          // last slash; `path.dirname` here would be this machine's rules.
          `sleep 1; rm -rf ${shellQuote(installed.slice(0, installed.lastIndexOf("/")))}; `;
    // The setup check writes under the far side's own `$HOME`, which is not
    // under `remoteDir`, so what it left is named here too.
    const setupTeardown =
      setupLeft.length === 0 ? "" : `rm -rf ${setupLeft.join(" ")}; `;
    const teardown = `${installedTeardown}${setupTeardown}pkill -f '[${remoteDir[0]}]${remoteDir.slice(1)}/werk'; sleep 1; rm -rf ${remoteDir}`;
    if (options.keep) {
      console.log(`\nKept ${localDir} here and ${remoteDir} on ${host}.`);
      console.log(`Tear it down with: ssh ${host} ${shellQuote(teardown)}`);
    } else {
      for (const held of forwards) {
        try {
          held.kill();
        } catch {}
      }
      ssh(host, [`${teardown}; exit 0`]);
      await fs.rm(localDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

if (import.meta.main) process.exit(await main());
