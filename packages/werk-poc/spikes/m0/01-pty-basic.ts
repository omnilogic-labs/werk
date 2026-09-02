// Probe 1: does Bun.spawn({ terminal }) give the child a real PTY, and does it
// work at all from inside a compiled binary? The runner executes this file
// both interpreted and compiled; the probe itself is the same either way.

import { Collector, deadline, finish, log, waitFor, compiled } from "./_lib.ts";

const P = "01-pty-basic";
deadline(P, 15_000);

const out = new Collector();
let exitCalls = 0;
let exitArgs: unknown[] = [];

const proc = Bun.spawn(
  [
    "sh",
    "-c",
    "tty; [ -t 0 ] && echo STDIN_IS_TTY; [ -t 1 ] && echo STDOUT_IS_TTY; stty size; echo DONE",
  ],
  {
    terminal: {
      cols: 80,
      rows: 24,
      data: (_t, d) => out.push(d),
      exit: (_t, code, signal) => {
        exitCalls++;
        exitArgs = [code, signal];
      },
    },
  },
);

log(
  "compiled:",
  compiled,
  "execPath:",
  process.execPath,
  "import.meta.path:",
  import.meta.path,
);
log(
  "proc.stdout is",
  proc.stdout,
  "proc.terminal is",
  proc.terminal?.constructor.name,
);

const gotDone = await waitFor(() => out.text.includes("DONE"), 5000);
await proc.exited;
await Bun.sleep(100);

const text = out.text;
const tty = /\/dev\/pts\/\d+/.exec(text)?.[0] ?? null;
const size = /(\d+) (\d+)\r?\n/.exec(text);
log("child output:", JSON.stringify(text));

const details = {
  gotDone,
  tty,
  stdinIsTty: text.includes("STDIN_IS_TTY"),
  stdoutIsTty: text.includes("STDOUT_IS_TTY"),
  sttySize: size ? `${size[1]}x${size[2]}` : null,
  dataCalls: out.calls,
  exitCalls,
  exitArgs,
  procExitCode: proc.exitCode,
  procStdoutNull: proc.stdout === null,
  terminalClosedAfterExit: proc.terminal?.closed,
};

proc.terminal?.close();

if (
  gotDone &&
  tty &&
  details.stdinIsTty &&
  details.stdoutIsTty &&
  details.sttySize === "24x80"
) {
  finish(
    P,
    "pass",
    `child sees ${tty}, 24x80, isatty on stdin and stdout`,
    details,
  );
} else {
  finish(P, "fail", "child did not see a working PTY", details);
}
