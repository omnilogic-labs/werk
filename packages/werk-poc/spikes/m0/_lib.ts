// Shared bits for the M0 probes. Each probe is a standalone script that prints
// human-readable progress to stderr and exactly one `RESULT {...}` line to
// stdout, then exits 0 (pass), 1 (fail) or 2 (inconclusive). The runner
// parses that line.

export type Status = "pass" | "fail" | "inconclusive";

export interface Result {
  probe: string;
  status: Status;
  bun: string;
  compiled: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

/** True when running from a `bun build --compile` binary. */
export const compiled =
  import.meta.path.startsWith("/$bunfs/") ||
  import.meta.path.startsWith("B:/~BUN/");

export const log = (...a: unknown[]) => console.error("  ·", ...a);

export function finish(
  probe: string,
  status: Status,
  summary: string,
  details?: Record<string, unknown>,
): never {
  const r: Result = {
    probe,
    status,
    bun: Bun.version,
    compiled,
    summary,
    details,
  };
  console.log("RESULT " + JSON.stringify(r));
  process.exit(status === "pass" ? 0 : status === "fail" ? 1 : 2);
}

/** Bail out with a failure if the whole probe takes longer than `ms`. */
export function deadline(probe: string, ms: number) {
  const t = setTimeout(
    () => finish(probe, "fail", `probe hung for ${ms} ms`),
    ms,
  );
  if (typeof t === "object" && "unref" in t) t.unref();
}

export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Poll `pred` until it is true or `ms` elapses. Returns whether it became true. */
export async function waitFor(
  pred: () => boolean,
  ms: number,
  step = 20,
): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return pred();
}

/**
 * How to re-invoke this very script with extra arguments, in a way that works
 * both under `bun run file.ts` and inside a compiled binary.
 */
export function selfArgv(callerPath: string, args: string[]): string[] {
  return compiled
    ? [process.execPath, ...args]
    : [process.execPath, "run", callerPath, ...args];
}

/**
 * `ps` fields for one pid, or null if it is gone.
 *
 * BSD `ps` has no `sid` keyword — `sess` there is a kernel pointer, not a
 * session id — so on macOS the session id is inferred from the `s` flag in
 * `STAT`, which marks a session leader. That is the only thing the probes
 * ask `sid` about (`sid === pid`), but it means `sid` is `NaN` on macOS for
 * a process that is not one.
 */
export function psInfo(pid: number): {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  tty: string;
  stat: string;
} | null {
  const darwin = process.platform === "darwin";
  const out = Bun.spawnSync([
    "ps",
    "-o",
    darwin
      ? "pid=,ppid=,pgid=,tty=,state="
      : "pid=,ppid=,pgid=,sid=,tty=,stat=",
    "-p",
    String(pid),
  ])
    .stdout.toString()
    .trim();
  if (!out) return null;
  const f = out.split(/\s+/);
  const [p, pp, pg] = f;
  const [s, tty, stat] = darwin
    ? [f[4]?.includes("s") ? p : undefined, f[3], f[4]]
    : [f[3], f[4], f[5]];
  return {
    pid: Number(p),
    ppid: Number(pp),
    pgid: Number(pg),
    sid: Number(s),
    tty: tty ?? "?",
    stat: stat ?? "?",
  };
}

/** Collects PTY output into a growable buffer with a decoded-text view. */
export class Collector {
  chunks: Uint8Array[] = [];
  calls = 0;
  push(d: Uint8Array) {
    this.calls++;
    this.chunks.push(new Uint8Array(d));
  }
  get text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
  get bytes(): number {
    return this.chunks.reduce((n, c) => n + c.length, 0);
  }
  reset() {
    this.chunks = [];
  }
}

export const which = (cmd: string) => Bun.which(cmd);
