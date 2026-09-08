/**
 * Every command exits when stdin and stdout are both a terminal.
 *
 * werk asks the terminal for its background colour before the command line is
 * parsed, so the exchange runs for `--version` as much as for `list`. It is the
 * only thing in the CLI that reads stdin before a command does, and it only
 * runs when stdout is a terminal and stdin can be put into raw mode. Spawning
 * the binary with pipes misses it in both directions at once, which is why the
 * rest of the suite never saw the read being left running.
 *
 * So every case here runs the CLI under a pseudo-terminal and gives it a
 * deadline. The assertion that matters is that the process came back at all.
 *
 * The pty comes from `script`. util-linux takes `script -qec "<cmd>" /dev/null`
 * and BSD takes different arguments, so rather than name the platforms that
 * have the right one, the suite runs the invocation once and skips itself if
 * the host cannot allocate a pty that way.
 *
 * `script`'s own stdin is the pty master. Writing an `OSC 11` reply into it is
 * how a terminal that answers the question gets tested, without the suite
 * taking a native pty dependency for one file.
 *
 * ## Nothing here is written down twice
 *
 * An exit code is read off the same command run through pipes, and the output
 * is read off the same command run on a terminal with colour refused. Both
 * comparisons are between two runs of werk, so they keep holding as the
 * commands and their prose move, and neither can pass by asserting something
 * werk has never printed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "../src/main.ts");
/** Long enough for a cold start and a daemon; short enough to fail a hang. */
const DEADLINE = 30_000;

/** Ask the host whether `script` gives a child a terminal on these arguments. */
async function ptyAvailable(): Promise<boolean> {
  try {
    const child = Bun.spawn(
      [
        "script",
        "-qec",
        `${process.execPath} -e "process.exit(process.stdin.isTTY ? 0 : 1)"`,
        "/dev/null",
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}
const PTY = await ptyAvailable();

let home = "";
let runtimeDir = "";
let stateDir = "";

/** Single-quote a token, so the shell `script` starts receives it whole. */
function quote(token: string): string {
  return `'${token.replaceAll("'", `'\\''`)}'`;
}

/**
 * An environment in which the probe actually runs.
 *
 * Three things would settle the theme without asking the terminal, and each of
 * them would leave these cases passing while exercising nothing: `CI` and
 * `NO_COLOR` both make `probeAllowed` refuse, and a flavour named in the
 * environment or in the reader's own `~/.werk/config.toml` means there is
 * nothing to ask about. `HOME` therefore points at the scratch directory.
 *
 * `unthemed` puts `NO_COLOR` back deliberately, to get the same command in the
 * same output register with the probe refused.
 */
function environment(unthemed: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith("WERK_")) env[key] = value;
  delete env.CI;
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  env.TERM = "xterm-256color";
  env.HOME = home;
  if (unthemed) env.NO_COLOR = "1";
  return env;
}

/** Where the scratch daemon lives, so `list` and `doctor` stay off the host's. */
const sandbox = (): string[] => [
  "--runtime-dir",
  runtimeDir,
  "--state-dir",
  stateDir,
];

interface Run {
  code: number | null;
  /**
   * Everything the command wrote. Under a pty both streams are the terminal, so
   * they arrive already merged; with pipes they are joined here to match.
   */
  output: string;
  timedOut: boolean;
}

/**
 * Wait for a child with a deadline of its own. The regression is a process that
 * never returns, so the deadline is the assertion: without it the suite would
 * hang rather than fail.
 */
async function settle(child: Bun.Subprocess): Promise<Run> {
  const expired = Symbol("expired");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof expired>((resolve) => {
    timer = setTimeout(() => resolve(expired), DEADLINE);
  });
  const outcome = await Promise.race([child.exited, deadline]);
  if (timer !== undefined) clearTimeout(timer);
  const timedOut = outcome === expired;
  if (timedOut) child.kill("SIGKILL");
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout as ReadableStream).text(),
    new Response(child.stderr as ReadableStream).text(),
  ]);
  await child.exited;
  return {
    code: timedOut ? null : (outcome as number),
    output: stdout + stderr,
    timedOut,
  };
}

interface PtyOptions {
  /** An `OSC 11` reply, fed in as a terminal that answers would send it. */
  reply?: string;
  /** Refuse colour, which refuses the probe with it. */
  unthemed?: boolean;
}

/** Run the CLI with a terminal on both ends. */
async function underPty(
  args: string[],
  { reply, unthemed = false }: PtyOptions = {},
): Promise<Run> {
  const command = [process.execPath, MAIN, ...args].map(quote).join(" ");
  const child = Bun.spawn(["script", "-qec", command, "/dev/null"], {
    cwd: home,
    env: environment(unthemed),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (reply !== undefined) {
    child.stdin.write(reply);
    child.stdin.flush();
  }
  return await settle(child);
}

/** The same command with pipes, which is the combination that always worked. */
async function piped(args: string[]): Promise<Run> {
  const child = Bun.spawn([process.execPath, MAIN, ...args], {
    cwd: home,
    env: environment(false),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return await settle(child);
}

/** Drop escape sequences and carriage returns, leaving what a person read. */
function plain(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\r/g, "");
}

/**
 * Take back out what the pty echoed.
 *
 * A reply written to the master arrives before werk has put the line into raw
 * mode, so the terminal is still echoing, and it echoes control bytes in caret
 * notation: `ESC` comes back as the two characters `^[`, which no escape
 * sequence strip will touch. The echo is removed by rebuilding it from what was
 * written rather than by matching on what werk printed.
 */
function withoutEcho(text: string, reply: string): string {
  return text.split(reply.replaceAll("\x1b", "^[")).join("");
}

/**
 * The first line that carries anything.
 *
 * The opening line rather than the whole output, because `werk doctor` reports
 * the daemon's log and the timestamps in it differ between two runs.
 */
function opening(text: string): string {
  return (
    plain(text)
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

beforeAll(async () => {
  // Short, because a Unix socket path is capped near 103 bytes and the daemon
  // binds one inside the runtime directory.
  home = await mkdtemp("/tmp/wkt-");
  runtimeDir = join(home, "r");
  stateDir = join(home, "s");
});

afterAll(async () => {
  try {
    const record: unknown = JSON.parse(
      await readFile(join(stateDir, "daemon.json"), "utf8"),
    );
    const pid = (record as { pid?: unknown }).pid;
    if (Number.isInteger(pid)) process.kill(pid as number, "SIGTERM");
  } catch {
    // No daemon was started, or it has already gone.
  }
  await rm(home, { recursive: true, force: true });
});

/** Bare `werk` and `werk config` answer with usage, which is still an answer. */
const COMMANDS: string[][] = [
  [],
  ["--version"],
  ["--help"],
  ["list"],
  ["info"],
  ["config"],
  ["doctor"],
];

describe.skipIf(!PTY)("with a terminal on stdin and stdout", () => {
  for (const args of COMMANDS) {
    const name = args.length === 0 ? "werk" : `werk ${args.join(" ")}`;
    test(
      `${name} answers and exits`,
      async () => {
        const terminal = await underPty([...sandbox(), ...args]);
        expect(terminal.timedOut).toBe(false);

        const pipes = await piped([...sandbox(), ...args]);
        expect(pipes.timedOut).toBe(false);
        expect(terminal.code).toBe(pipes.code);

        const unthemed = await underPty([...sandbox(), ...args], {
          unthemed: true,
        });
        expect(unthemed.timedOut).toBe(false);
        expect(opening(terminal.output)).toBe(opening(unthemed.output));
        // Every one of these commands says something on a terminal, so an
        // empty opening line would mean both runs printed nothing at all.
        expect(opening(terminal.output)).not.toBe("");
      },
      DEADLINE * 4,
    );
  }

  test(
    "the list table names its columns, the workspace among them",
    async () => {
      // A person gets column headings; a pipe gets rows alone, which
      // `table.test.ts` settles. This is the one place the set of columns
      // `werk list` actually offers is read back off a real run.
      const terminal = await underPty([...sandbox(), "list"]);
      expect(terminal.timedOut).toBe(false);
      const heading = plain(terminal.output)
        .split("\n")
        .find((line) => line.includes("WORKSPACE"));
      expect(heading, terminal.output).toBeDefined();
      for (const column of [
        "ID",
        "NAME",
        "WORKSPACE",
        "STATE",
        "AGE",
        "COMMAND",
      ])
        expect(heading).toContain(column);
    },
    DEADLINE * 2,
  );

  test(
    "a terminal that answers the question is heard",
    async () => {
      // Without this the suite would still pass against a werk that had given
      // up asking, which is the other way to make the hang go away.
      const answers = { light: "eeee/eeee/eeee", dark: "1e1e/1e1e/2e2e" };
      const query = (colour: string) => `\x1b]11;rgb:${colour}\x1b\\`;
      const light = await underPty([...sandbox(), "--help"], {
        reply: query(answers.light),
      });
      const dark = await underPty([...sandbox(), "--help"], {
        reply: query(answers.dark),
      });
      expect(light.timedOut).toBe(false);
      expect(dark.timedOut).toBe(false);
      expect(light.code).toBe(0);
      expect(dark.code).toBe(0);

      const worn = {
        light: withoutEcho(light.output, query(answers.light)),
        dark: withoutEcho(dark.output, query(answers.dark)),
      };
      // A light ground and a dark one wear different flavours, so the same help
      // page comes back painted differently. The runs are compared with each
      // other because naming a colour would pin a palette that is free to move.
      expect(worn.light).not.toBe(worn.dark);
      // The same words underneath, whichever flavour was worn.
      expect(plain(worn.light)).toBe(plain(worn.dark));
    },
    DEADLINE * 3,
  );
});
