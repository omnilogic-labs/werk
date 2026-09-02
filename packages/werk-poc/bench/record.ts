// Records a real program's output under `Bun.Terminal` into an asciicast
// for the corpus. Input is scripted: a list of `[delay ms, keys]` fed to
// the PTY, then the program is given a moment and killed if still alive.
//
//   bun run bench/record.ts <name> --cols 80 --rows 24 [--input '[[500,"ihello:q!\r"]]'] [--wait 2000] -- <command...>
//
// Every PTY read becomes one "o" event (or "b" when the read is cut in
// the middle of a multibyte character), so the split points a real PTY
// produced are what the runner replays.

import path from "node:path";
import { writeCast, type CastEvent } from "./cast.ts";

export interface RecordOptions {
  cols: number;
  rows: number;
  argv: string[];
  input?: [number, string][];
  /** Milliseconds to keep recording after the last scripted input. */
  wait?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export async function record(opts: RecordOptions): Promise<{
  events: CastEvent[];
  exitCode: number | null;
}> {
  const events: CastEvent[] = [];
  const t0 = performance.now();
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const proc = Bun.spawn(opts.argv, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, TERM: "xterm-256color" },
    terminal: {
      cols: opts.cols,
      rows: opts.rows,
      name: "xterm-256color",
      data: (_t, bytes) => {
        events.push({
          t: (performance.now() - t0) / 1000,
          kind: "output",
          bytes: bytes.slice(),
        });
      },
      exit: () => done(),
    },
  });
  const term = proc.terminal!;
  const script = opts.input ?? [];
  (async () => {
    for (const [delay, keys] of script) {
      await Bun.sleep(delay);
      term.write(keys);
    }
    await Bun.sleep(opts.wait ?? 1500);
    if (proc.exitCode === null) proc.kill("SIGTERM");
    await Bun.sleep(300);
    if (proc.exitCode === null) proc.kill("SIGKILL");
  })();
  await Promise.race([proc.exited, finished]);
  await Bun.sleep(50);
  term.close();
  return { events, exitCode: proc.exitCode };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dd = argv.indexOf("--");
  const own = dd < 0 ? argv : argv.slice(0, dd);
  const cmd = dd < 0 ? [] : argv.slice(dd + 1);
  const flag = (n: string, d?: string) => {
    const i = own.indexOf(`--${n}`);
    return i >= 0 ? own[i + 1] : d;
  };
  const name = own.find((a) => !a.startsWith("--") && !own.includes(`--${a}`));
  if (!name || cmd.length === 0) {
    console.error(
      "usage: bun run bench/record.ts <name> [--cols N --rows N --input JSON --wait MS] -- <command...>",
    );
    process.exit(2);
  }
  const cols = Number(flag("cols", "80"));
  const rows = Number(flag("rows", "24"));
  const input = JSON.parse(flag("input", "[]")!) as [number, string][];
  const wait = Number(flag("wait", "1500"));
  const { events, exitCode } = await record({
    cols,
    rows,
    argv: cmd,
    input,
    wait,
  });
  const file = path.join(import.meta.dir, "corpus", `${name}.cast`);
  writeCast(file, {
    header: {
      version: 2,
      width: cols,
      height: rows,
      timestamp: Math.floor(Date.now() / 1000),
      title: cmd.join(" "),
      env: { TERM: "xterm-256color" },
    },
    events,
  });
  const bytes = events.reduce(
    (n, e) => n + (e.kind === "output" ? e.bytes.length : 0),
    0,
  );
  console.log(
    `${file}: ${events.length} events, ${bytes} bytes, exit ${exitCode}`,
  );
}
