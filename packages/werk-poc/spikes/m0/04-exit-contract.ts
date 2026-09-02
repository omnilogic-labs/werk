// Probe 4: what does the terminal `exit` callback actually report? How many
// times does it fire, with what arguments, and how does it relate to
// proc.exited / proc.exitCode / proc.signalCode?

import { deadline, finish, log } from "./_lib.ts";

const P = "04-exit-contract";
deadline(P, 30_000);

interface Obs {
  case: string;
  exitCallsBeforeClose: number;
  exitCallsAfterClose: number;
  callbackArgs: unknown[][];
  callbackBeforeExited: boolean | null;
  procExitCode: number | null;
  procSignalCode: string | null;
  terminalClosedAfterExited: boolean;
  dataCalls: number;
}

async function run(
  name: string,
  cmd: string[],
  kill?: NodeJS.Signals,
): Promise<Obs> {
  const args: unknown[][] = [];
  let calls = 0;
  let exitedResolved = false;
  let callbackBeforeExited: boolean | null = null;
  let dataCalls = 0;
  const proc = Bun.spawn(cmd, {
    terminal: {
      data: () => dataCalls++,
      exit: (_t, code, signal) => {
        calls++;
        args.push([code, signal]);
        if (callbackBeforeExited === null)
          callbackBeforeExited = !exitedResolved;
      },
    },
  });
  if (kill) {
    await Bun.sleep(200);
    proc.kill(kill);
  }
  await proc.exited;
  exitedResolved = true;
  await Bun.sleep(500); // give a late callback a chance
  const before = calls;
  const closedAfterExited = proc.terminal!.closed;
  proc.terminal!.close();
  await Bun.sleep(300);
  const obs: Obs = {
    case: name,
    exitCallsBeforeClose: before,
    exitCallsAfterClose: calls - before,
    callbackArgs: args,
    callbackBeforeExited,
    procExitCode: proc.exitCode,
    procSignalCode: proc.signalCode,
    terminalClosedAfterExited: closedAfterExited,
    dataCalls,
  };
  log(JSON.stringify(obs));
  return obs;
}

const obs = [
  await run("exit0", ["sh", "-c", "echo hi; exit 0"]),
  await run("exit3", ["sh", "-c", "echo hi; exit 3"]),
  await run("sigterm", ["sleep", "30"], "SIGTERM"),
];

// A close() with no child at all, to see whether close alone fires exit.
let bareCalls = 0;
const bareArgs: unknown[][] = [];
const bare = new Bun.Terminal({
  exit: (_t, c, s) => (bareCalls++, bareArgs.push([c, s])),
});
bare.close();
await Bun.sleep(300);
log("bare Terminal close():", bareCalls, JSON.stringify(bareArgs));

const codesRight =
  obs[0]!.procExitCode === 0 &&
  obs[1]!.procExitCode === 3 &&
  obs[2]!.procSignalCode === "SIGTERM";
const totalCalls = obs.map(
  (o) => o.exitCallsBeforeClose + o.exitCallsAfterClose,
);
const firesOnce = totalCalls.every((n) => n === 1);
const reflectsChild = obs[1]!.callbackArgs.some((a) => a[0] === 3);

const summary = [
  `proc.exitCode/signalCode ${codesRight ? "correct" : "WRONG"}`,
  `exit callback fires ${totalCalls.join("/")} times (before close: ${obs.map((o) => o.exitCallsBeforeClose).join("/")})`,
  `callback ${reflectsChild ? "carries" : "does not carry"} the child's exit code`,
].join("; ");

finish(P, codesRight ? "pass" : "fail", summary, {
  cases: obs,
  bareClose: { calls: bareCalls, args: bareArgs },
  firesOnce,
  reflectsChild,
});
