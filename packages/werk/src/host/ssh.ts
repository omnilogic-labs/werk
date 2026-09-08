/**
 * Every ssh command line werk builds, built in one place.
 *
 * The reason for the file is not tidiness. An option set in two places drifts,
 * and the options here are the difference between a command that fails in ten
 * seconds and one that hangs forever, so a second spelling of the list is a
 * defect waiting to happen. Nothing outside this file writes `-o`.
 *
 * ## What is always passed, and why
 *
 * | Option | What it buys |
 * | --- | --- |
 * | `BatchMode=yes` | Never prompt. A password prompt on a stdin nothing is watching is a hang, and werk's callers are commands with deadlines. |
 * | `ConnectTimeout=10` | A bound on the part of the connection ssh will otherwise wait on indefinitely. |
 * | `ForwardAgent=no` | werk does not need the caller's agent on the far machine, so it does not ask for it, whatever their config says. |
 * | `ServerAliveInterval=15`, `ServerAliveCountMax=3` | A forward that has lost its network dies in about 45 seconds instead of staying up and swallowing every request. |
 * | `ControlMaster=no`, `ControlPath=none` | See below. |
 *
 * `ControlMaster=no -o ControlPath=none` go on unconditionally and explicitly.
 * A `~/.ssh/config` that sets `ControlMaster=auto` — a common thing to have —
 * would route werk's connections through a shared master, and a blackholed
 * master hangs rather than errors: ssh waits on a socket whose other end is
 * gone, past `ConnectTimeout`, which does not apply because no connection is
 * being made. A command-line `-o` beats the file, so passing both turns that
 * failure into one werk can bound.
 *
 * **`StrictHostKeyChecking` is not passed at all, and that is deliberate.**
 * werk is talking to a machine the person already has and has already accepted.
 * Silently accepting a new or changed key on their behalf is a larger claim
 * than werk should be making about a machine it did not set up, so their
 * setting stands. Under `BatchMode` an unknown key then fails, which is why
 * `classifySshFailure` turns that into a message telling them to run `ssh
 * <host>` once and accept it.
 *
 * ## Reading ssh's stderr
 *
 * `classifySshFailure` scrapes strings out of stderr, which is exactly what
 * `@werk/workspace` refuses to do to git. The difference is worth saying out
 * loud rather than leaving as an inconsistency: this is ssh's stderr, not
 * git's; ssh has one exit status for every one of these failures (255), so
 * there is nothing else to read; and the strings are stable — they have been in
 * OpenSSH's sources, unchanged, for longer than most of the tools that parse
 * them. Anything unrecognised is reported as unreachable with ssh's own text
 * attached, so a string that does move is a worse message rather than a wrong
 * one.
 */
import { HostError, type HostErrorCode } from "./types.js";

/** ssh's own status for "the connection itself failed", whatever the cause. */
export const SSH_CONNECTION_FAILED = 255;

/**
 * Passed on every invocation, forward and exec alike. Read the table at the top
 * of this file before changing one of them.
 */
export const SSH_COMMON_OPTIONS: readonly string[] = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ForwardAgent=no",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
];

/**
 * Added to a forward and to nothing else.
 *
 * Measured, because it covers less than the name suggests. It catches a failure
 * to bind the *local* listener: ssh exits 255 rather than staying up with no
 * forward, which is the difference between a fast error and a client blocking
 * on a socket that will never exist. It does **not** catch a remote socket that
 * is not there — the far end is contacted only when a client arrives, so the
 * forward comes up, `connect()` succeeds and the stream ends immediately. That
 * is the commonest remote fault, and `forward.ts` detects it separately rather
 * than trusting this to.
 */
export const SSH_FORWARD_OPTIONS: readonly string[] = [
  "-o",
  "ExitOnForwardFailure=yes",
];

/**
 * Where git should push, for a mirror at `repositoryPath` on `sshHost`.
 *
 * `@werk/workspace` builds no URLs and knows no transports, so the one place
 * that knows werk reaches a machine with ssh builds this. The `ssh://` form
 * rather than `host:path` because it is unambiguous: an ssh destination can
 * carry a user and the path is always absolute, so
 * `ssh://mike@10.0.0.7/srv/x.git` has exactly one reading.
 */
export const sshPushUrl =
  (sshHost: string) =>
  (repositoryPath: string): string =>
    `ssh://${sshHost}${repositoryPath}`;

/**
 * What to put in front of a push so git's own ssh is werk's ssh.
 *
 * Without it git spawns a plain `ssh` and inherits none of the options at the
 * top of this file: a push would prompt on a machine werk never prompts on, and
 * a `ControlMaster=auto` in the person's config would route it through a shared
 * master that can hang past any timeout. None of the values carry a space, so
 * git's shell-like splitting of `core.sshCommand` reads them back unchanged.
 */
export const sshGitConfig = (): string[] => [
  "-c",
  `core.sshCommand=ssh ${SSH_COMMON_OPTIONS.join(" ")}`,
];

/** Quote a value for the `sh -c` that sshd hands a remote command to. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Wrap a command so the far side runs it under the login shell.
 *
 * sshd runs a remote command through the account's shell with `-c`, which for
 * bash and friends is the *non-interactive, non-login* path: no `~/.profile`,
 * no `~/.bash_profile`, so no `~/.local/bin` on PATH. On the machines werk is
 * aimed at that is where `claude` lives, and it is where `werk` itself will
 * live once it has been installed, so most of what werk asks a machine has to
 * be asked under a login shell.
 *
 * `${SHELL:-/bin/sh}` rather than `bash -lc`: the account's shell is what the
 * person's login files were written for, and a machine with no bash is a
 * machine werk should still be able to ask a question.
 */
export function loginCommand(command: string): string {
  return `"\${SHELL:-/bin/sh}" -lc ${shellQuote(command)}`;
}

export interface SshExecOptions {
  /** Run the command under a login shell; see {@link loginCommand}. */
  readonly login?: boolean;
}

/** The whole argv, `ssh` included, for running one command on a machine. */
export function sshExecArgv(
  sshHost: string,
  command: string,
  options: SshExecOptions = {},
): string[] {
  return [
    "ssh",
    ...SSH_COMMON_OPTIONS,
    // No pty. A pty would echo, translate newlines and hang a command up when
    // it closed, and none of what werk asks a machine wants any of that.
    "-T",
    sshHost,
    options.login === true ? loginCommand(command) : command,
  ];
}

/**
 * What the local end of a forward is, and therefore what shape of `-L` it takes.
 *
 * Two shapes because the far side gets to choose: a daemon on a Unix-socket
 * machine reports a socket, and one on Windows reports loopback TCP with a
 * credential. `session.ts` hands over whatever the far side reported, so
 * supporting the second is a change to this file rather than to the client.
 */
export type ForwardShape =
  | { readonly kind: "unix"; readonly local: string; readonly remote: string }
  | {
      readonly kind: "tcp";
      readonly localPort: number;
      readonly remoteHost: string;
      readonly remotePort: number;
    };

/** The whole argv for a forward that carries no session channel. */
export function sshForwardArgv(sshHost: string, shape: ForwardShape): string[] {
  const spec =
    shape.kind === "unix"
      ? `${shape.local}:${shape.remote}`
      : `${shape.localPort}:${shape.remoteHost}:${shape.remotePort}`;
  return [
    "ssh",
    ...SSH_COMMON_OPTIONS,
    ...SSH_FORWARD_OPTIONS,
    // `-N` asks for no remote command at all.
    //
    // An earlier reading of this held that a plain `-N` leaves Nagle on and
    // costs two round trips per keystroke, and that a `-tt … sleep` session had
    // to be carried alongside the forward to get `TCP_NODELAY` set. It does not
    // reproduce: on OpenSSH 10.2p1 the `setsockopt` traces for the two are
    // identical, and keystroke latency at 51 ms RTT measured 52.4 ms for `-N`
    // against 52.3 ms for `-tt`. So werk carries no pty beside the forward, and
    // `scripts/remote-smoke.ts` is where that stays measured rather than
    // assumed.
    "-N",
    "-L",
    spec,
    sshHost,
  ];
}

/** What a command that ran somewhere did. */
export interface RunOutcome {
  /** Null where the process was killed by a signal or never started. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True where the runner stopped it for taking too long. */
  readonly timedOut: boolean;
}

export interface RunOptions {
  /** The whole command, connection included. The runner kills it at this. */
  readonly timeoutMs?: number;
  /** Piped to the process's stdin. A stream is what a 92 MB transfer needs. */
  readonly stdin?: ReadableStream<Uint8Array> | Uint8Array;
  /**
   * The whole environment for a process started on this machine, replacing the
   * caller's rather than adding to it.
   *
   * Only a local command can be given one. Over ssh the far side's environment
   * is the far side's business, and what werk wants set there is written into
   * the command instead.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Called with each piece of output as it arrives, stdout and stderr alike,
   * for a command whose progress somebody is meant to watch. The outcome still
   * carries the whole of both.
   */
  readonly onOutput?: (chunk: string) => void;
}

/** A process the caller has to be able to outlive: a forward, or a `tar`. */
export interface RemoteProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  /**
   * Piped rather than discarded because it is the only thing a forward that
   * failed to start ever says. Whoever starts a process has to read it, or the
   * pipe fills and the process blocks.
   */
  readonly stderr: ReadableStream<Uint8Array>;
  /** Resolves with the exit status once it has one. */
  readonly exited: Promise<number | null>;
  /** The status if it has already exited, null while it is running. */
  exitCode(): number | null;
  kill(): void;
}

/**
 * Everything under `host/` runs its processes through one of these, so a test
 * can answer for every ssh, tar and bun in the directory without a network and
 * without a machine. There is no ssh-shaped method on it on purpose: the argv
 * comes from the builders above, and the runner only runs what it is given.
 */
export interface RemoteRunner {
  run(argv: string[], options?: RunOptions): Promise<RunOutcome>;
  start(argv: string[]): RemoteProcess;
}

/** The default budget for a one-off command, connection included. */
export const EXEC_TIMEOUT_MS = 20_000;

/**
 * Everything a stream carried, handing each piece on as it arrives.
 *
 * Read piece by piece rather than with `new Response(stream).text()` so that a
 * caller watching a slow command sees it working. A `TextDecoder` in streaming
 * mode is what keeps a multi-byte character split across two chunks from
 * arriving as two replacement characters.
 */
async function collect(
  stream: ReadableStream<Uint8Array>,
  onOutput?: (chunk: string) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    const piece = decoder.decode(chunk, { stream: true });
    if (piece === "") continue;
    text += piece;
    onOutput?.(piece);
  }
  const last = decoder.decode();
  if (last !== "") {
    text += last;
    onOutput?.(last);
  }
  return text;
}

/** The runner that actually starts processes. */
export function spawnRunner(): RemoteRunner {
  return {
    async run(argv, options = {}) {
      const child = Bun.spawn(argv, {
        stdin:
          options.stdin === undefined
            ? "ignore"
            : (options.stdin as ReadableStream<Uint8Array>),
        stdout: "pipe",
        stderr: "pipe",
        ...(options.env === undefined
          ? {}
          : { env: options.env as Record<string, string> }),
      });
      let timedOut = false;
      const timeoutMs = options.timeoutMs ?? EXEC_TIMEOUT_MS;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      try {
        const [stdout, stderr, code] = await Promise.all([
          collect(child.stdout as ReadableStream<Uint8Array>, options.onOutput),
          collect(child.stderr as ReadableStream<Uint8Array>, options.onOutput),
          child.exited,
        ]);
        return { code, stdout, stderr, timedOut };
      } finally {
        clearTimeout(timer);
      }
    },
    start(argv) {
      // stdin is closed rather than inherited: a forward must never find
      // itself reading the terminal the caller is typing into.
      const child = Bun.spawn(argv, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        stdout: child.stdout as ReadableStream<Uint8Array>,
        stderr: child.stderr as ReadableStream<Uint8Array>,
        exited: child.exited,
        exitCode: () => child.exitCode,
        kill: () => {
          try {
            child.kill();
          } catch {}
        },
      };
    },
  };
}

/**
 * The stderr strings that decide which of ssh's failures this was.
 *
 * Order matters only in that the changed-key line is checked before the generic
 * host-key one, because OpenSSH prints both for the same event and the first is
 * the alarming one.
 */
const AUTH_MARKERS = [
  "REMOTE HOST IDENTIFICATION HAS CHANGED",
  "Host key verification failed",
  "Permission denied",
  "No supported authentication methods",
  "Too many authentication failures",
];
const UNREACHABLE_MARKERS = [
  "Could not resolve hostname",
  "Connection timed out",
  "Operation timed out",
  "No route to host",
  "Connection refused",
  "Network is unreachable",
  "Connection closed by remote host",
];

/**
 * Turn an ssh failure into something a person can act on.
 *
 * `what` names the thing werk was trying to do, so the message says which step
 * failed rather than only that ssh did.
 */
export function classifySshFailure(
  sshHost: string,
  outcome: RunOutcome,
  what: string,
): HostError {
  const stderr = outcome.stderr.replaceAll("\r", "").trim();
  if (outcome.timedOut)
    return new HostError(
      "HOST_UNREACHABLE",
      sshHost,
      `${what}: ${sshHost} did not answer in time.`,
      stderr,
    );
  if (stderr.includes("REMOTE HOST IDENTIFICATION HAS CHANGED"))
    return new HostError(
      "HOST_AUTH_FAILED",
      sshHost,
      `${what}: the host key for ${sshHost} is not the one known_hosts has. ` +
        `werk inherits your ssh settings rather than accepting a changed key ` +
        `for you, so settle it with ssh first: run \`ssh ${sshHost}\` and deal ` +
        `with what it says.`,
      stderr,
    );
  if (stderr.includes("Host key verification failed"))
    return new HostError(
      "HOST_AUTH_FAILED",
      sshHost,
      `${what}: ${sshHost} has a host key ssh will not accept unprompted. ` +
        `Run \`ssh ${sshHost}\` once to accept it, then try again.`,
      stderr,
    );
  if (AUTH_MARKERS.some((marker) => stderr.includes(marker)))
    return new HostError(
      "HOST_AUTH_FAILED",
      sshHost,
      `${what}: ${sshHost} refused the key. werk connects with ` +
        `BatchMode=yes and never prompts, so key authentication has to work ` +
        `on its own — check with \`ssh ${sshHost}\`.`,
      stderr,
    );
  const reason = UNREACHABLE_MARKERS.find((marker) => stderr.includes(marker));
  return new HostError(
    "HOST_UNREACHABLE",
    sshHost,
    reason === undefined
      ? `${what}: ssh to ${sshHost} failed.`
      : `${what}: ${sshHost} could not be reached.`,
    stderr,
  );
}

/** Raise for an ssh that failed to connect; return the outcome otherwise. */
export function requireConnection(
  sshHost: string,
  outcome: RunOutcome,
  what: string,
): RunOutcome {
  if (outcome.timedOut || outcome.code === SSH_CONNECTION_FAILED)
    throw classifySshFailure(sshHost, outcome, what);
  return outcome;
}

/** Raise unless the remote command also succeeded. */
export function requireSuccess(
  sshHost: string,
  outcome: RunOutcome,
  what: string,
  code: HostErrorCode = "HOST_BOOTSTRAP_FAILED",
): RunOutcome {
  requireConnection(sshHost, outcome, what);
  if (outcome.code !== 0)
    throw new HostError(
      code,
      sshHost,
      `${what}: the command failed on ${sshHost} (exit ${outcome.code ?? "signal"}).`,
      outcome.stderr || outcome.stdout,
    );
  return outcome;
}
