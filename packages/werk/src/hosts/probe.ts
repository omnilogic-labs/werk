/**
 * Asking a machine about itself, through whatever can reach it.
 *
 * A host block holds what the machine is called and where werk may put things.
 * Everything else werk asks the machine, at the moment it needs to know, and
 * throws the answer away. That is the whole reason this exists: a `werkPath` or
 * a `shell` written into a config file is a fact that was true once, and it
 * goes stale silently while `ssh beast` keeps working.
 *
 * The seam is one method. A transport that could not connect answers `ok:
 * false` with no `code`; a command that ran and exited non-zero answers `ok:
 * true` with the code, because a command that failed is an answer. Nothing here
 * throws for a status.
 *
 * `noProbe` answers "unknown" to everything, in the same shape and for the same
 * reason as `unconfiguredSource` in `config/sources.ts`: it makes the seam
 * usable before anything is behind it, and it makes the report say "unknown"
 * rather than pretending.
 */

export interface ProbeAnswer {
  /** Whether the command was run at all. */
  readonly ok: boolean;
  /** Its exit status, or null when nothing ran. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProbeOptions {
  /** How long this one command may take. */
  readonly timeoutMs: number;
  /**
   * Whether the command wants a login shell's environment. The commands below
   * spell that themselves with `sh -lc`, so this is a hint for a transport that
   * would rather arrange it another way.
   */
  readonly login?: boolean;
}

export interface HostProbe {
  run(command: readonly string[], options: ProbeOptions): Promise<ProbeAnswer>;
}

/** Answers nothing to everything, so a report says "unknown" and not a guess. */
export const noProbe: HostProbe = {
  async run() {
    return { ok: false, code: null, stdout: "", stderr: "" };
  },
};

/**
 * The machine werk is running on. It exists so `werk config check local` says
 * something true rather than six unknowns, and it is the one transport that
 * needs nothing built: the commands below are the same ones a remote probe
 * runs, so whatever this reports is what the seam is expected to report.
 */
export const localProbe: HostProbe = {
  async run(command, options) {
    try {
      const child = Bun.spawn([...command], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const deadline = setTimeout(() => child.kill(), options.timeoutMs);
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const code = await child.exited;
      clearTimeout(deadline);
      return { ok: true, code, stdout, stderr };
    } catch (error) {
      // The command is not on this machine at all, which is nothing having run
      // rather than something having failed.
      return {
        ok: false,
        code: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

/**
 * Which transport can reach a host today. An ssh host gets {@link noProbe}
 * until something implements the seam over ssh, and every caller of this is
 * expected to say "not checked" rather than "unreachable" when it gets one.
 */
export const probeFor = (kind: "local" | "ssh"): HostProbe =>
  kind === "local" ? localProbe : noProbe;

/** What one check found. `unknown` is what a probe that could not run says. */
export interface Check {
  readonly name: string;
  readonly state: "yes" | "no" | "unknown";
  /** What it found, for a check that answers with a value rather than a fact. */
  readonly detail?: string;
}

export interface ProbeReport {
  readonly reachable: "yes" | "no" | "unknown";
  readonly checks: readonly Check[];
  /**
   * The workspace root the machine's own environment implies, computed on that
   * machine by the same rule the local host uses.
   */
  readonly workspaceRoot?: string;
  /** Whether that directory exists yet. werk would create it if it does not. */
  readonly workspaceRootExists?: boolean;
  /** Whether it, or the nearest existing parent, can be written to. */
  readonly workspaceRootUsable?: boolean;
  /** Findings worth saying out loud, in the order they were made. */
  readonly notes: readonly string[];
}

/** Ten seconds to answer at all; the rest are quick once a connection is up. */
const REACH_MS = 10_000;
const QUICK_MS = 5_000;
/** The whole probe, however many checks it makes. */
export const PROBE_BUDGET_MS = 30_000;

/**
 * The same rule `defaultStateDir` applies locally, spelled for the machine's own
 * shell so the answer is that machine's `$HOME` and its `$XDG_STATE_HOME`.
 */
const WORKSPACE_ROOT_COMMAND =
  'printf %s "${XDG_STATE_HOME:-$HOME/.local/state}/werk/workspaces"';

/**
 * Ask a machine the handful of things werk wants to know before putting work on
 * it.
 *
 * **Nothing here creates anything.** A probe that runs `mkdir -p` has changed
 * somebody's machine before they said yes to anything, so the workspace root is
 * tested, and its nearest existing parent is tested when it is not there yet.
 * Whoever is asking says "werk will create it" rather than werk creating it.
 *
 * Unreachable is not a failure of the probe. A machine that is asleep is a
 * legitimate host, and the report says so and stops rather than reporting six
 * more unknowns.
 */
export async function probeHost(
  probe: HostProbe,
  options: { signal?: AbortSignal } = {},
): Promise<ProbeReport> {
  const signal = options.signal ?? AbortSignal.timeout(PROBE_BUDGET_MS);
  const checks: Check[] = [];
  const notes: string[] = [];
  const spent = () => signal.aborted;

  const reach = await probe.run(["true"], { timeoutMs: REACH_MS });
  // No code at all means nothing ran, which is what {@link noProbe} says to
  // everything and what a transport says when it could not connect. Those two
  // read differently to a person, and only the caller knows which probe it
  // handed over, so the distinction is made there rather than guessed at here.
  const reachable =
    reach.code === null
      ? "unknown"
      : reach.ok && reach.code === 0
        ? "yes"
        : "no";
  checks.push({ name: "reachable", state: reachable });
  if (reachable !== "yes") {
    if (reachable === "no" && reach.stderr.trim() !== "")
      notes.push(reach.stderr.trim().split("\n")[0]!);
    return { reachable, checks, notes };
  }

  const ran = async (
    name: string,
    command: readonly string[],
    login = false,
  ) => {
    if (spent()) {
      checks.push({
        name,
        state: "unknown",
        detail: "the probe ran out of time",
      });
      return undefined;
    }
    const answer = await probe.run(command, {
      timeoutMs: QUICK_MS,
      ...(login ? { login: true } : {}),
    });
    const value = answer.stdout.trim();
    const found = answer.ok && answer.code === 0 && value !== "";
    checks.push({
      name,
      state: answer.code === null ? "unknown" : found ? "yes" : "no",
      ...(found ? { detail: value } : {}),
    });
    return found ? value : undefined;
  };

  await ran("system", ["uname", "-sm"]);
  await ran("git", ["git", "--version"]);
  await ran("werk", ["sh", "-c", "command -v werk"]);
  const root = await ran("workspace root", [
    "sh",
    "-c",
    WORKSPACE_ROOT_COMMAND,
  ]);
  const usable =
    root === undefined ? undefined : await usability(probe, root, spent);
  if (usable?.exists === false)
    notes.push(`${root} does not exist yet; werk will create it`);
  if (usable?.writable === false)
    notes.push(`nothing under ${root} can be written to as this user`);
  if (usable !== undefined)
    checks.push({
      name: "workspace root usable",
      state: usable.writable ? "yes" : "no",
      detail: usable.nearest,
    });

  const login = await ran(
    "claude on a login shell",
    ["sh", "-lc", "command -v claude"],
    true,
  );
  const plain = await ran("claude on a plain shell", [
    "sh",
    "-c",
    "command -v claude",
  ]);
  if (login !== undefined && plain === undefined)
    notes.push(
      `claude is at ${login} on a login shell's PATH and is not on a plain ` +
        `one, so whatever starts it will have to ask for a login shell`,
    );

  return {
    reachable,
    checks,
    ...(root === undefined ? {} : { workspaceRoot: root }),
    ...(usable === undefined
      ? {}
      : {
          workspaceRootExists: usable.exists,
          workspaceRootUsable: usable.writable,
        }),
    notes,
  };
}

/**
 * Whether werk could put a workspace at a path, without making anything. When
 * the directory is not there yet the nearest existing parent is tested instead,
 * which is the question that actually matters: `mkdir -p` will work if the
 * first directory above it that exists can be written to.
 */
async function usability(
  probe: HostProbe,
  root: string,
  spent: () => boolean,
): Promise<
  { exists: boolean; writable: boolean; nearest: string } | undefined
> {
  if (spent()) return undefined;
  const script =
    `p=${shellQuote(root)}\n` +
    `if [ -d "$p" ]; then printf 'here '; else printf 'absent '; fi\n` +
    `while [ ! -d "$p" ] && [ "$p" != "/" ] && [ "$p" != "." ]; do ` +
    `p=$(dirname "$p"); done\n` +
    `if [ -w "$p" ]; then printf 'writable '; else printf 'readonly '; fi\n` +
    `printf %s "$p"\n`;
  const answer = await probe.run(["sh", "-c", script], { timeoutMs: QUICK_MS });
  if (!answer.ok || answer.code !== 0) return undefined;
  const [there, write, ...rest] = answer.stdout.trim().split(" ");
  return {
    exists: there === "here",
    writable: write === "writable",
    nearest: rest.join(" "),
  };
}

/** A path inside single quotes, which is the only shell quoting werk needs. */
export const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;
