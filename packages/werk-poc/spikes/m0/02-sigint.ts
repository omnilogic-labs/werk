// Probe 2: does 0x03 written to the PTY reach the child as SIGINT? That only
// happens if the PTY is the child's controlling terminal and the child is in
// its foreground process group, so both are checked too.

import {
  Collector,
  deadline,
  finish,
  log,
  psInfo,
  selfArgv,
  waitFor,
} from "./_lib.ts";

const P = "02-sigint";

if (process.argv[2] === "child") {
  // role used by case (c): a Bun process that reports SIGINT and exits
  process.on("SIGINT", () => {
    console.log("BUN_GOT_SIGINT");
    process.exit(0);
  });
  console.log("READY");
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

deadline(P, 20_000);

// (a) a shell that traps SIGINT and says so
const a = new Collector();
const trap = Bun.spawn(
  [
    "bash",
    "-c",
    'trap "echo GOT_SIGINT" INT; echo READY; tty; while :; do sleep 0.05; done',
  ],
  { terminal: { cols: 80, rows: 24, data: (_t, d) => a.push(d) } },
);
// A pty slave is /dev/pts/N on Linux and /dev/ttysNNN on macOS, and the two
// `ps` report it as "pts/N" and "sNNN".
const DARWIN = process.platform === "darwin";
await waitFor(
  () =>
    a.text.includes("READY") &&
    (DARWIN ? /\/dev\/ttys\d+/ : /\/dev\/pts\/\d+/).test(a.text),
  5000,
);
const childTty = DARWIN
  ? (/\/dev\/ttys(\d+)/.exec(a.text)?.[1] ?? null)
  : (/\/dev\/pts\/(\d+)/.exec(a.text)?.[1] ?? null);
const ps = psInfo(trap.pid);
log(
  "child says tty",
  DARWIN ? "s" + childTty : "pts/" + childTty,
  "ps says",
  ps,
);

// controlling terminal: the pid's own session leader has this tty and `ps` agrees
const psTty = ps?.tty ?? "?";
const ctty =
  childTty !== null && psTty === (DARWIN ? `s${childTty}` : `pts/${childTty}`);

trap.terminal!.write("\x03");
const trapped = await waitFor(() => a.text.includes("GOT_SIGINT"), 3000);
log("trap fired:", trapped, "output:", JSON.stringify(a.text.slice(-120)));
trap.kill("SIGKILL");
await trap.exited;
trap.terminal!.close();

// (b) a child with no handler: it should die of SIGINT
const b = new Collector();
const plain = Bun.spawn(["sleep", "30"], {
  terminal: { data: (_t, d) => b.push(d) },
});
await Bun.sleep(200);
plain.terminal!.write("\x03");
const died = await Promise.race([
  plain.exited.then(() => true),
  Bun.sleep(3000).then(() => false),
]);
const bSignal = plain.signalCode;
const bCode = plain.exitCode;
log("plain sleep died:", died, "signalCode:", bSignal, "exitCode:", bCode);
if (!died) plain.kill("SIGKILL");
await plain.exited;
plain.terminal!.close();

// (c) a Bun child, since the daemon's real children will sometimes be Bun
const c = new Collector();
const bunChild = Bun.spawn(selfArgv(import.meta.path, ["child"]), {
  terminal: { data: (_t, d) => c.push(d) },
});
await waitFor(() => c.text.includes("READY"), 5000);
bunChild.terminal!.write("\x03");
const bunTrapped = await waitFor(() => c.text.includes("BUN_GOT_SIGINT"), 3000);
log("bun child trapped:", bunTrapped);
if (!bunTrapped) bunChild.kill("SIGKILL");
await bunChild.exited;
bunChild.terminal!.close();

const details = {
  childTty,
  ps,
  controllingTerminal: ctty,
  shellTrapFired: trapped,
  sleepDiedOfSignal: bSignal,
  sleepExitCode: bCode,
  bunChildTrapFired: bunTrapped,
};
if (trapped && bSignal === "SIGINT" && bunTrapped && ctty) {
  finish(
    P,
    "pass",
    "0x03 delivers SIGINT; PTY is the controlling terminal",
    details,
  );
} else {
  finish(P, "fail", "SIGINT not delivered or PTY not controlling", details);
}
