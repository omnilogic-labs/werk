// Entry point for `wp`, the proof-of-concept binary. Only a usage printer for
// now; commands arrive with their milestones (see the proposal, §7).

const USAGE = `wp — werk proof of concept (disposable name, disposable code)

usage:
  wp run [--engine=wasm|ffi] -- <command...>   spawn under a PTY in the daemon, attach
  wp ls                                        id, command, engine, status, title, age
  wp attach [--read-only] <id>                 come back to a session
  wp logs <id>                                 dump scrollback
  wp kill <id>                                 stop a session
  wp serve                                     loopback web UI
  wp bench                                     the measurements in the proposal, §6
  wp __daemon                                  hidden; not typed by a human

none of these do anything yet.`;

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

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (cmd === undefined || cmd === "-h" || cmd === "--help" || cmd === "help") {
    console.log(USAGE);
    return 0;
  }
  if (KNOWN.has(cmd)) {
    console.error(`wp ${cmd}: not implemented yet`);
    return 2;
  }
  console.error(`wp: unknown command "${cmd}"\n`);
  console.error(USAGE);
  return 2;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
