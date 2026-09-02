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
  wp ls                                        id, command, engine, status, title, age, clients
  wp attach [--read-only] <id>                 come back to a session
  wp logs [--vt] <id>                          dump the whole screen incl. scrollback
  wp kill [--signal SIG] [--rm] <id>           signal a running session; --rm removes an exited one
  wp serve                                     loopback web UI
  wp bench                                     the measurements in the proposal, §6
  wp caps                                      the capability matrix, one column per engine
  wp __daemon                                  hidden; not typed by a human

serve and bench do nothing yet.`;

interface Parsed {
  flags: Map<string, string | true>;
  positional: string[];
  /** Everything after `--`. */
  rest: string[];
}

/** Flags that take a value; every other `--x` is boolean. */
const VALUED = new Set(["engine", "cols", "rows", "signal"]);

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
  const { engineIds, getEngine } = await import("../engine/registry.ts");
  await import("../engine/ghostty-wasm/bun.ts");
  const engines = await Promise.all(engineIds().map((id) => getEngine(id)));
  console.log(capabilityMatrix(engines));
  return 0;
}

function age(since: number): string {
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

async function withClient(
  autostart: boolean,
  body: (client: import("../client/index.ts").Client) => Promise<number>,
): Promise<number> {
  const { connect, DaemonError } = await import("../client/index.ts");
  let client;
  try {
    client = await connect({ autostart });
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
      s.status === "exited"
        ? `exited(${s.signalCode ?? s.exitCode})`
        : s.status,
      s.title,
      age(s.createdAt),
      String(s.attachedClients),
    ]);
    const head = [
      "ID",
      "COMMAND",
      "ENGINE",
      "STATUS",
      "TITLE",
      "AGE",
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
  const cmd = argv[0];
  if (cmd === undefined || cmd === "-h" || cmd === "--help" || cmd === "help") {
    console.log(USAGE);
    return 0;
  }
  try {
    const p = parse(argv.slice(1));
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
      case "bench":
        console.error(`wp ${cmd}: not implemented yet`);
        return 2;
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
