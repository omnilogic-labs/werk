// Entry point for `wp`, the proof-of-concept binary. Commands arrive with
// their milestones (see the proposal, §7). Argument parsing is hand-rolled
// and small: `--flag`, `--flag=value`, `--flag value`, and `--` to end
// options.
//
// Command output goes through `fs.writeSync(1)`, not `console.log`, so that
// the `process.exit` that follows cannot race a buffered pipe write. Once,
// under the full test suite, `wp run` with stdout piped exited 0 with no id
// on it; a 300-run probe of `console.log` + `process.exit` did not reproduce
// it, so the cause is unproven — the synchronous write removes the question
// (findings/m2.md).

import fs from "node:fs";

function out(text: string): void {
  fs.writeSync(1, text);
}

const USAGE = `wp — werk proof of concept (disposable name, disposable code)

usage:
  wp run [--engine=ghostty-wasm] [--cols N --rows N] -- <command...>
                                               spawn under a PTY in the daemon, attach
                                               (ctrl-\\ detaches; without a tty: print the id)
  wp ls                                        id, command, engine, status, title, age, snapshot, clients
  wp attach [--read-only] <id>                 come back to a session
  wp logs [--vt] <id>                          dump the whole screen incl. scrollback
  wp kill [--signal SIG] [--rm] <id>           signal a running session; --rm removes an exited one
  wp serve [--port N]                          loopback web UI: session list, live terminals
  wp bench diff [--fuzz N] [--seed N] [--verbose] [case...]
                                               the differential corpus across the three engines
  wp bench perf [--only a,b] [--json] [--quick]
                                               throughput, relay latency, snapshot cost, daemon
                                               memory and churn, slow client, wasm trap isolation
  wp bench ops [--json] [--quick] [--no-compile]
                                               toolchain, platform matrix, --compile survival and
                                               binary size, cold start
  wp bench soak [--duration 24h] [--interval 60s] [--out f.jsonl] [--idle N] [--noisy N] [--keep]
                                               twenty sessions on a daemon of their own, sampled
                                               to a JSONL file; a summary at the end
  wp bench soak --report <f.jsonl>             the summary from an existing soak log
  wp caps                                      the capability matrix, one column per engine
  wp __daemon                                  hidden; not typed by a human

Every command but __daemon takes --socket <path> (or WP_SOCKET in the
environment): talk to the daemon behind that socket — one forwarded with
ssh -L from another machine, say — and never start one. The benches run
their daemons on temporary directories and never touch that one.`;

interface Parsed {
  flags: Map<string, string | true>;
  positional: string[];
  /** Everything after `--`. */
  rest: string[];
}

/** Flags that take a value; every other `--x` is boolean. */
const VALUED = new Set([
  "engine",
  "cols",
  "rows",
  "signal",
  "port",
  "socket",
  "fuzz",
  "seed",
  "only",
  "duration",
  "interval",
  "out",
  "report",
  "idle",
  "noisy",
  "attach-every",
  "trap-child",
]);

function parse(argv: string[]): Parsed {
  const out: Parsed = { flags: new Map(), positional: [], rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      out.rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      if (eq >= 0) out.flags.set(name, a.slice(eq + 1));
      else if (VALUED.has(name)) {
        const v = argv[++i];
        if (v === undefined) throw new UsageError(`--${name} needs a value`);
        out.flags.set(name, v);
      } else out.flags.set(name, true);
      continue;
    }
    out.positional.push(a);
  }
  return out;
}

class UsageError extends Error {}

function intFlag(p: Parsed, name: string): number | undefined {
  const v = p.flags.get(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0)
    throw new UsageError(`--${name} must be a positive integer`);
  return n;
}

function oneId(p: Parsed, cmd: string): string {
  const id = p.positional[0];
  if (!id || p.positional.length !== 1)
    throw new UsageError(`wp ${cmd}: expected exactly one session id`);
  return id;
}

async function caps(): Promise<number> {
  const { capabilityMatrix } = await import("../engine/caps.ts");
  const { engineIds, getEngine } = await import("../engine/all.ts");
  const engines = [];
  for (const id of engineIds()) {
    try {
      engines.push(await getEngine(id));
    } catch (e) {
      console.error(`wp caps: ${id} did not load: ${(e as Error).message}`);
    }
  }
  console.log(capabilityMatrix(engines));
  return 0;
}

async function bench(p: Parsed): Promise<number> {
  const [sub, ...cases] = p.positional;
  const str = (name: string) => {
    const v = p.flags.get(name);
    return typeof v === "string" ? v : undefined;
  };
  switch (sub) {
    case "diff": {
      const { runDifferential } = await import("../../bench/differential.ts");
      await runDifferential({
        cases,
        fuzz: intFlag(p, "fuzz"),
        seed: intFlag(p, "seed"),
        verbose: p.flags.has("verbose"),
      });
      return 0;
    }
    case "perf": {
      const { runPerf, SECTIONS } = await import("../../bench/perf.ts");
      const only = str("only")?.split(",");
      for (const s of only ?? [])
        if (!(SECTIONS as string[]).includes(s))
          throw new UsageError(
            `wp bench perf: unknown section "${s}"; one of ${SECTIONS.join(", ")}`,
          );
      await runPerf({
        only: only as typeof SECTIONS | undefined,
        json: p.flags.has("json"),
        quick: p.flags.has("quick"),
        trapChild: str("trap-child"),
      });
      return 0;
    }
    case "ops": {
      const { runOps } = await import("../../bench/ops.ts");
      await runOps({
        json: p.flags.has("json"),
        quick: p.flags.has("quick"),
        compile: p.flags.has("no-compile") ? false : undefined,
      });
      return 0;
    }
    case "soak": {
      const { runSoak, formatSummary, reportFile, parseDuration } =
        await import("../../bench/soak.ts");
      const report = str("report");
      if (report) {
        out(reportFile(report) + "\n");
        return 0;
      }
      const summary = await runSoak({
        durationMs: parseDuration(str("duration") ?? "30m"),
        intervalMs: str("interval")
          ? parseDuration(str("interval")!)
          : undefined,
        out: str("out"),
        idle: intFlag(p, "idle"),
        noisy: intFlag(p, "noisy"),
        attachEveryMs: str("attach-every")
          ? parseDuration(str("attach-every")!)
          : undefined,
        keep: p.flags.has("keep"),
      });
      out(formatSummary(summary) + "\n");
      return 0;
    }
    default:
      console.error("wp bench: expected one of diff, perf, ops, soak");
      return 2;
  }
}

function age(since: number): string {
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** The STATUS column: `running`, `exited(code)`, `corpse`, or `corpse(mismatch abcd1234/ef567890)`. */
function statusOf(s: import("../protocol/index.ts").SessionInfo): string {
  if (s.status === "exited") return `exited(${s.signalCode ?? s.exitCode})`;
  if (s.status === "corpse" && s.corpse?.reason === "mismatch")
    return `corpse(mismatch ${s.corpse.snapshotEngine.slice(0, 8)}/${s.corpse.daemonEngine.slice(0, 8)})`;
  return s.status;
}

/** `--socket` on the command, else `WP_SOCKET`; undefined means the local daemon. */
let socketOverride: string | undefined = process.env.WP_SOCKET || undefined;

async function withClient(
  autostart: boolean,
  body: (client: import("../client/index.ts").Client) => Promise<number>,
): Promise<number> {
  const { connect, DaemonError } = await import("../client/index.ts");
  let client;
  try {
    client = await connect({ autostart, socket: socketOverride });
  } catch (e) {
    if (e instanceof DaemonError) console.error(`wp: ${e.message}`);
    else console.error(`wp: ${(e as Error).message}`);
    return 1;
  }
  try {
    return await body(client);
  } catch (e) {
    if (e instanceof DaemonError) {
      console.error(`wp: ${e.message}`);
      return 1;
    }
    throw e;
  } finally {
    client.close();
  }
}

async function ls(): Promise<number> {
  return withClient(true, async (client) => {
    const sessions = await client.ls();
    const rows = sessions.map((s) => [
      s.id,
      s.argv.join(" "),
      s.engine,
      statusOf(s),
      s.title,
      age(s.createdAt),
      s.snapshotAt ? `${age(s.snapshotAt)} ago` : "-",
      String(s.attachedClients),
    ]);
    const head = [
      "ID",
      "COMMAND",
      "ENGINE",
      "STATUS",
      "TITLE",
      "AGE",
      "SNAPSHOT",
      "CLIENTS",
    ];
    const widths = head.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => r[i]!.length)),
    );
    const line = (r: string[]) =>
      r
        .map((c, i) => c.padEnd(widths[i]!))
        .join("  ")
        .trimEnd();
    out([line(head), ...rows.map(line)].join("\n") + "\n");
    return 0;
  });
}

async function run(p: Parsed): Promise<number> {
  if (p.rest.length === 0)
    throw new UsageError("wp run: no command; write `wp run -- <command...>`");
  const { attachInteractive, terminalSize } = await import("./attach.ts");
  const cols = intFlag(p, "cols");
  const rows = intFlag(p, "rows");
  const engine = p.flags.get("engine");
  const size = terminalSize();
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return withClient(true, async (client) => {
    const { id } = await client.run({
      argv: p.rest,
      cols: cols ?? size.cols,
      rows: rows ?? size.rows,
      engine: typeof engine === "string" ? engine : undefined,
    });
    if (!interactive) {
      out(id + "\n");
      return 0;
    }
    return attachInteractive(client, id, { cols, rows });
  });
}

async function attach(p: Parsed): Promise<number> {
  const id = oneId(p, "attach");
  const { attachInteractive } = await import("./attach.ts");
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("wp attach: stdin and stdout must be a terminal");
    return 1;
  }
  return withClient(false, (client) =>
    attachInteractive(client, id, { readOnly: p.flags.has("read-only") }),
  );
}

async function logs(p: Parsed): Promise<number> {
  const id = oneId(p, "logs");
  return withClient(false, async (client) => {
    const text = await client.logs(id, p.flags.has("vt") ? "vt" : "text");
    out(text.endsWith("\n") ? text : text + "\n");
    return 0;
  });
}

async function serve(p: Parsed): Promise<number> {
  const port = p.flags.get("port");
  const { serveWeb } = await import("../web/server.ts");
  const web = await serveWeb({
    port: typeof port === "string" ? intFlag(p, "port") : undefined,
    log: (line) => console.error(line),
  });
  out(`${web.url}\n`);
  // Runs until interrupted; SIGINT/SIGTERM stop the server and leave the daemon alone.
  await new Promise<void>((resolve) => {
    const stop = () => {
      web.stop();
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}

async function kill(p: Parsed): Promise<number> {
  const id = oneId(p, "kill");
  const signal = p.flags.get("signal");
  return withClient(false, async (client) => {
    const r = await client.kill(
      id,
      typeof signal === "string" ? signal : undefined,
    );
    if (r.action === "removed") {
      out(`removed ${id}\n`);
      return 0;
    }
    out(`signalled ${id} (${signal ?? "SIGTERM"})\n`);
    if (p.flags.has("rm")) {
      // Wait for the exit, then remove.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const s = (await client.ls()).find((x) => x.id === id);
        if (!s) return 0;
        if (s.status !== "running") {
          await client.kill(id);
          out(`removed ${id}\n`);
          return 0;
        }
        await Bun.sleep(50);
      }
      console.error(`wp kill: ${id} still running after 5 s; not removed`);
      return 1;
    }
    return 0;
  });
}

export async function main(argv: string[]): Promise<number> {
  // `wp --socket <path> <command>` reads as naturally as `wp <command> --socket <path>`; take either.
  if (argv[0]?.startsWith("--socket=")) {
    socketOverride = argv[0].slice("--socket=".length);
    argv = argv.slice(1);
  } else if (argv[0] === "--socket" && argv[1] !== undefined) {
    socketOverride = argv[1];
    argv = argv.slice(2);
  }
  const cmd = argv[0];
  if (cmd === undefined || cmd === "-h" || cmd === "--help" || cmd === "help") {
    console.log(USAGE);
    return 0;
  }
  try {
    const p = parse(argv.slice(1));
    const sock = p.flags.get("socket");
    if (typeof sock === "string") socketOverride = sock;
    switch (cmd) {
      case "caps":
        return await caps();
      case "ls":
        return await ls();
      case "run":
        return await run(p);
      case "attach":
        return await attach(p);
      case "logs":
        return await logs(p);
      case "kill":
        return await kill(p);
      case "__daemon":
        return await import("../daemon/main.ts").then((m) =>
          m.daemonMain(argv.slice(1)),
        );
      case "serve":
        return await serve(p);
      case "bench":
        return await bench(p);
      default:
        console.error(`wp: unknown command "${cmd}"\n`);
        console.error(USAGE);
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
