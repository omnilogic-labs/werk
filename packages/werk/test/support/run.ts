/**
 * The one place a test starts werk.
 *
 * The reason it exists is a hole that already cost something. A test set
 * `WERK_CONFIG_DIR` in its own process and then spawned werk with `Bun.spawn`,
 * which does not inherit it, and three commands wrote to the config file of
 * whoever was running the suite. Nothing about that is visible at the call
 * site: the run passes, and the file it touched is somewhere else entirely.
 *
 * So the environment stops being the caller's to remember. A sandbox owns a
 * config directory, a runtime directory and a state directory; `spawnWerk` puts
 * all three into every child it starts, and passes the last two as flags as
 * well, so both layers are exercised and both name the same place. What keeps
 * it honest is `sandboxed.test.ts`, which fails if any other test file hands
 * the CLI to a process spawner.
 *
 * ## Short paths
 *
 * A sandbox root is `/tmp/<tag>-XXXXXX` and nothing more nested. A Unix socket
 * path is capped at 103 bytes, the daemon binds `<runtimeDir>/daemon.sock`, and
 * a temporary directory a few levels deeper than this fails at `bind` with
 * `EINVAL`, which names nothing.
 *
 * ## 0700
 *
 * `openLocalTransport` refuses to dial through a runtime directory that is not
 * exactly 0700 and owned by the caller, so the sandbox creates it that way
 * rather than leaving it to whatever umask the run inherited.
 */
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";

/** The CLI as a developer runs it, and the CLI as it is shipped. */
const MAIN = resolve(import.meta.dir, "../../src/main.ts");

/**
 * The entry a test spawns when it needs the CLI but not this module's sandbox,
 * which today is only the pty suite: it builds its own command line for
 * `script` and answers the terminal part way through. Exported so that one
 * module still knows where the CLI is.
 */
export const cliEntry = MAIN;
const COMPILED = resolve(import.meta.dir, "../../dist/werk");
const PACKAGE = resolve(import.meta.dir, "../..");

/** A place for one test file's werk to keep everything it writes. */
export interface Sandbox {
  /** The temporary root. Everything below is inside it. */
  readonly root: string;
  readonly configDir: string;
  readonly runtimeDir: string;
  readonly stateDir: string;
  /**
   * The environment a child gets: the caller's, less every `WERK_` variable it
   * happened to be run with, plus this sandbox's three. `undefined` in `extra`
   * removes a variable rather than setting it to that string.
   */
  environment(
    extra?: Record<string, string | undefined>,
  ): Record<string, string>;
  /** Signal any daemon this sandbox started, then delete the directory. */
  dispose(): Promise<void>;
}

const livingSandboxes = new Set<Sandbox>();

/**
 * A sandbox of its own.
 *
 * `tag` becomes the `/tmp` prefix, so it is short, and one file's tag is not
 * another's: these files deliberately do not share a daemon, and a shared
 * runtime directory is how they would start.
 */
export async function sandbox(tag: string): Promise<Sandbox> {
  if (!/^[a-z][a-z0-9-]{1,7}$/.test(tag))
    throw new Error(
      `${JSON.stringify(tag)} is not a sandbox tag: two to eight lowercase letters, digits or dashes, because the socket length depends on it`,
    );
  const root = await mkdtemp(`/tmp/${tag}-`);
  const configDir = join(root, "c");
  const runtimeDir = join(root, "r");
  const stateDir = join(root, "s");
  await mkdir(configDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  // Exactly 0700, because that is what `openLocalTransport` checks for. A mode
  // passed to `mkdir` is still subject to the umask, so it is set afterwards.
  await chmod(runtimeDir, 0o700);

  const box: Sandbox = {
    root,
    configDir,
    runtimeDir,
    stateDir,
    environment(extra = {}) {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env))
        if (value !== undefined && !key.startsWith("WERK_")) env[key] = value;
      env.WERK_CONFIG_DIR = configDir;
      env.WERK_RUNTIME_DIR = runtimeDir;
      env.WERK_STATE_DIR = stateDir;
      for (const [key, value] of Object.entries(extra))
        if (value === undefined) delete env[key];
        else env[key] = value;
      return env;
    },
    async dispose() {
      livingSandboxes.delete(box);
      try {
        const record: unknown = JSON.parse(
          await readFile(join(stateDir, "daemon.json"), "utf8"),
        );
        const pid = (record as { pid?: unknown }).pid;
        if (Number.isInteger(pid)) process.kill(pid as number, "SIGTERM");
      } catch {
        // No daemon was started, or it has already gone.
      }
      await rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
  livingSandboxes.add(box);
  return box;
}

/** Dispose every sandbox still standing, for a file that makes one per test. */
export async function disposeSandboxes(): Promise<void> {
  for (const box of [...livingSandboxes]) await box.dispose();
}

export interface SpawnWerkOptions {
  readonly sandbox: Sandbox;
  readonly args: readonly string[];
  /** Where the command is typed. Defaults to the sandbox root. */
  readonly cwd?: string;
  /** Laid over the sandbox environment; `undefined` removes a variable. */
  readonly env?: Record<string, string | undefined>;
  readonly stdin?: "ignore" | "pipe";
  /** The compiled binary to run, from `compiledWerk`, instead of the sources. */
  readonly binary?: string;
  /**
   * Run under a pseudo-terminal, through `script`. Both streams are then the
   * terminal, so they arrive merged, and stdin is the pty master.
   */
  readonly pty?: boolean;
  /**
   * Pass `--runtime-dir` and `--state-dir` as well as setting them in the
   * environment. On by default, so the flag layer keeps being exercised.
   */
  readonly dirFlags?: boolean;
}

/** Single-quote a token, so the shell `script` starts receives it whole. */
function quote(token: string): string {
  return `'${token.replaceAll("'", `'\\''`)}'`;
}

/** The argv a werk in this sandbox is started with. */
function werkArgv(options: SpawnWerkOptions): string[] {
  const box = options.sandbox;
  const flags =
    options.dirFlags === false
      ? []
      : ["--runtime-dir", box.runtimeDir, "--state-dir", box.stateDir];
  const head =
    options.binary === undefined ? [process.execPath, MAIN] : [options.binary];
  return [...head, ...flags, ...options.args];
}

/** Start werk in a sandbox. Nothing else in the suite starts it. */
export function spawnWerk(options: SpawnWerkOptions): Bun.Subprocess {
  const argv = werkArgv(options);
  return Bun.spawn(
    options.pty === true
      ? ["script", "-qec", argv.map(quote).join(" "), "/dev/null"]
      : argv,
    {
      cwd: options.cwd ?? options.sandbox.root,
      env: options.sandbox.environment(options.env),
      stdin: options.stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

export interface WerkRun {
  /** Null where the deadline stopped it rather than werk finishing. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Wait for a child, with a deadline of its own.
 *
 * The deadline is an assertion as much as a convenience: several of the things
 * these tests guard against are a process that never returns, and without a
 * bound the suite would hang rather than fail.
 */
export async function settle(
  child: Bun.Subprocess,
  timeoutMs = 30_000,
): Promise<WerkRun> {
  const expired = Symbol("expired");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof expired>((resolveDeadline) => {
    timer = setTimeout(() => resolveDeadline(expired), timeoutMs);
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
  // A held-open stdin is how an attachment is kept from detaching on the first
  // tick. Once the child has gone there is nothing to hold it open for.
  try {
    (child.stdin as { end?: () => void } | null)?.end?.();
  } catch {
    // Already closed, or never a pipe.
  }
  return {
    code: timedOut ? null : (outcome as number),
    stdout,
    stderr,
    timedOut,
  };
}

/** Start werk in a sandbox and wait for it. */
export async function runWerk(
  options: SpawnWerkOptions & { readonly timeoutMs?: number },
): Promise<WerkRun> {
  return await settle(spawnWerk(options), options.timeoutMs ?? 30_000);
}

/**
 * The compiled binary, built first when the sources have moved since.
 *
 * A stale binary would pass or fail for a reason that is no longer in the tree,
 * so the mtimes decide rather than the presence of a file. Memoised, so a suite
 * that asks twice builds once.
 */
let building: Promise<string> | undefined;
export function compiledWerk(): Promise<string> {
  building ??= (async () => {
    const built = await stat(COMPILED).then(
      (s) => s.mtimeMs,
      () => 0,
    );
    if (built > (await newestSource(join(PACKAGE, "src")))) return COMPILED;
    const build = Bun.spawn([process.execPath, "run", "build"], {
      cwd: PACKAGE,
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await build.exited) !== 0)
      throw new Error(await new Response(build.stderr).text());
    return COMPILED;
  })();
  return building;
}

/** The newest mtime under a directory, so a stale binary is rebuilt. */
async function newestSource(directory: string): Promise<number> {
  let newest = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    newest = Math.max(
      newest,
      entry.isDirectory()
        ? await newestSource(full)
        : (await stat(full)).mtimeMs,
    );
  }
  return newest;
}

/**
 * Whether `script` gives a child a terminal on these arguments.
 *
 * util-linux takes `script -qec "<cmd>" /dev/null` and BSD takes different
 * ones, so rather than name the platforms that have the right `script`, the
 * invocation is run once and the caller skips itself when it does not work.
 */
export async function ptyAvailable(): Promise<boolean> {
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
