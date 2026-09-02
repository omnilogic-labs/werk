// Entry point for `wp`, the proof-of-concept binary. Commands arrive with
// their milestones (see the proposal, §7). `__daemon` and `ls` work; the
// interactive commands are the second half of M2.

const USAGE = `wp — werk proof of concept (disposable name, disposable code)

usage:
  wp run [--engine=wasm|ffi] -- <command...>   spawn under a PTY in the daemon, attach
  wp ls                                        id, command, engine, status, title, age
  wp attach [--read-only] <id>                 come back to a session
  wp logs <id>                                 dump scrollback
  wp kill <id>                                 stop a session
  wp serve                                     loopback web UI
  wp bench                                     the measurements in the proposal, §6
  wp caps                                      the capability matrix, one column per engine
  wp __daemon                                  hidden; not typed by a human

only caps, ls and __daemon do anything yet.`;

const KNOWN = new Set([
  "run",
  "ls",
  "attach",
  "logs",
  "kill",
  "serve",
  "bench",
  "__daemon",
]);

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

async function ls(): Promise<number> {
  const { connect } = await import("../client/index.ts");
  const client = await connect();
  try {
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
    console.log(line(head));
    for (const r of rows) console.log(line(r));
    return 0;
  } finally {
    client.close();
  }
}

export function main(argv: string[]): number | Promise<number> {
  const cmd = argv[0];
  if (cmd === undefined || cmd === "-h" || cmd === "--help" || cmd === "help") {
    console.log(USAGE);
    return 0;
  }
  if (cmd === "caps") return caps();
  if (cmd === "ls") return ls();
  if (cmd === "__daemon")
    return import("../daemon/main.ts").then((m) => m.daemonMain(argv.slice(1)));
  if (KNOWN.has(cmd)) {
    console.error(`wp ${cmd}: not implemented yet`);
    return 2;
  }
  console.error(`wp: unknown command "${cmd}"\n`);
  console.error(USAGE);
  return 2;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
