// Probe 6: a child toggles raw mode. What does the daemon side observe — does
// echo stop, does the `data` callback change, can the mode be detected?

import { Collector, deadline, finish, log, waitFor } from "./_lib.ts";

const P = "06-raw-mode";
deadline(P, 20_000);

const out = new Collector();
const script = [
  "echo READY_COOKED",
  'read line; echo "GOT:$line"',
  "stty raw -echo",
  "printf 'READY_RAW\\r\\n'",
  "head -c 5 | od -An -c",
  "stty sane",
  "echo READY_SANE",
  'read line; echo "GOT:$line"',
  "echo READY_HOLD; sleep 3",
].join("; ");

const proc = Bun.spawn(["bash", "-c", script], {
  terminal: { data: (_t, d) => out.push(d) },
});
await Bun.sleep(100);
// `ps -o tty=` says "pts/N" on Linux and "ttysNNN" on macOS; BSD `stty`
// reads another terminal with -f, not -F.
const DARWIN = process.platform === "darwin";
const psTty = Bun.spawnSync([
  "ps",
  "-o",
  "tty=",
  "-p",
  String(proc.pid),
]).stdout.toString();
const pts = DARWIN
  ? /ttys(\d+)/.exec(psTty)?.[1]
  : /pts\/(\d+)/.exec(psTty)?.[1];
const ttyPath = pts ? (DARWIN ? `/dev/ttys${pts}` : `/dev/pts/${pts}`) : null;
const stty = () =>
  ttyPath
    ? Bun.spawnSync(["stty", "-a", DARWIN ? "-f" : "-F", ttyPath])
        .stdout.toString()
        .replace(/\n/g, " ")
    : "";
const flags = (s: string) => ({
  icanon: !/-icanon/.test(s),
  echo: !/-echo\b/.test(s),
  isig: !/-isig/.test(s),
  opost: !/-opost/.test(s),
});
log("child tty:", ttyPath);

// cooked
await waitFor(() => out.text.includes("READY_COOKED"), 5000);
const cookedFlags = flags(stty());
out.reset();
proc.terminal!.write("abc\n");
await waitFor(() => out.text.includes("GOT:abc"), 3000);
const cookedText = out.text;
const cookedEchoed = /^abc\r\n/.test(cookedText);

// raw
await waitFor(() => out.text.includes("READY_RAW"), 3000);
const rawFlags = flags(stty());
out.reset();
proc.terminal!.write("xyz12");
await waitFor(() => out.text.includes("x   y   z"), 3000);
const rawText = out.text;
const rawEchoed = rawText.startsWith("xyz12");

// sane again
await waitFor(() => out.text.includes("READY_SANE"), 3000);
const saneFlags = flags(stty());
out.reset();
proc.terminal!.write("def\n");
await waitFor(() => out.text.includes("GOT:def"), 3000);
const saneEchoed = /^def\r\n/.test(out.text);

// what does terminal.setRawMode do to the slave's termios, seen from the child's side?
await waitFor(() => out.text.includes("READY_HOLD"), 3000);
const beforeSet = flags(stty());
let setRawErr: string | null = null;
try {
  proc.terminal!.setRawMode(true);
} catch (e) {
  setRawErr = String(e);
}
await Bun.sleep(100);
const afterSetRaw = flags(stty());
try {
  proc.terminal!.setRawMode(false);
} catch {}
await Bun.sleep(100);
const afterSetCooked = flags(stty());

proc.kill("SIGKILL");
await proc.exited;
proc.terminal!.close();

const details = {
  ttyPath,
  cooked: { flags: cookedFlags, echoed: cookedEchoed, text: cookedText },
  raw: { flags: rawFlags, echoed: rawEchoed, text: rawText },
  sane: { flags: saneFlags, echoed: saneEchoed },
  setRawMode: {
    error: setRawErr,
    before: beforeSet,
    afterTrue: afterSetRaw,
    afterFalse: afterSetCooked,
  },
};
log(JSON.stringify(details));
const ok =
  cookedEchoed &&
  !rawEchoed &&
  saneEchoed &&
  !rawFlags.icanon &&
  !rawFlags.echo &&
  cookedFlags.icanon;
finish(
  P,
  ok ? "pass" : "fail",
  ok
    ? "echo follows the child's termios; mode is readable via stty -F on the slave; no signal in the data callback itself"
    : "unexpected raw-mode behaviour",
  details,
);
