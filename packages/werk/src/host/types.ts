/**
 * What werk knows about a machine it has looked at, and what can go wrong on
 * the way to looking.
 *
 * `RemoteFacts` is deliberately small. It is not an inventory of the box; it is
 * the set of answers something in this directory acts on — which binary to
 * build, whether to use `rsync` or a `tar` pipe, where the home directory is,
 * and whether the machine already has a werk of its own. A fact nothing branches
 * on does not belong here.
 */

/**
 * What one machine answered. Every field comes back from a single round trip;
 * see `probe.ts` for the wire form and why it is line-oriented rather than
 * JSON.
 */
export interface RemoteFacts {
  /** `uname -s`: `Linux`, `Darwin`, and so on, spelled as the machine spells it. */
  readonly uname: string;
  /** `uname -m`: `x86_64`, `aarch64`, `arm64`. */
  readonly arch: string;
  /**
   * Which C library the machine has, decided by looking for a musl loader
   * rather than by running `ldd`; see `probe.ts`.
   */
  readonly libc: "glibc" | "musl";
  /** `$HOME`, absolute. Everything werk writes over there hangs off it. */
  readonly home: string;
  /** `id -u`. */
  readonly uid: number;
  /** Where `git` is on the login PATH, when it is there at all. */
  readonly git?: string;
  /** Whether `rsync` is on the login PATH; it changes how a binary is sent. */
  readonly rsync: boolean;
  /**
   * `PATH` as a login shell resolves it, which is the PATH werk's own commands
   * will see over there and usually not the one a bare `ssh host command` gets.
   */
  readonly loginPath: string;
  /**
   * A Claude Code configuration on that machine, when it has one: `~/.claude`
   * or `~/.claude.json`. werk does not read it. Something asking whether a box
   * is ready to be worked on wants to know it is there.
   */
  readonly claudeConfig?: string;
  /**
   * What a `werk` already on the login PATH reports as its version. Absent when
   * the machine has no werk of its own, which is the ordinary case.
   */
  readonly installed?: string;
  /** Where a werk sent by this client lives: `<home>/.local/share/werk/bin`. */
  readonly werk: string;
}

/**
 * What can be wrong between here and a machine.
 *
 * The split that matters to a person is the first three. *Unreachable* is the
 * network or the name; *auth* is the key or the host key, and is the one where
 * running plain `ssh` by hand is the fix; *unsupported* is a machine werk
 * cannot put a binary on. The rest are werk's own failures on a box it did
 * reach.
 */
export type HostErrorCode =
  /** ssh could not get there: the name, the route, the port, the timeout. */
  | "HOST_UNREACHABLE"
  /** ssh got there and would not let werk in, or would not trust the host key. */
  | "HOST_AUTH_FAILED"
  /** A machine werk has no binary for, or one it could not identify. */
  | "HOST_UNSUPPORTED"
  /** werk could not get itself installed and running over there. */
  | "HOST_BOOTSTRAP_FAILED"
  /**
   * A `[setup.<name>]` block the host names did not finish on the machine.
   *
   * Separate from the bootstrap failure above because the remedy is somebody
   * else's: werk got itself there, and a command that person wrote refused.
   */
  | "HOST_SETUP_FAILED"
  /** The `workspaceSetup` block did not finish in the workspace. */
  | "WORKSPACE_SETUP_FAILED"
  /**
   * The forward came up and nothing was listening at the far end of it.
   *
   * This has its own code because it is the commonest remote fault and the one
   * that lies most convincingly: `ExitOnForwardFailure` does not catch it, so
   * ssh stays up, `connect()` succeeds, and the stream ends at once. Without a
   * code of its own it reaches a person as "connection closed", which sends
   * them to look at the wrong machine.
   */
  | "HOST_DAEMON_MISSING";

/** Something werk could not do to a machine, with the machine named. */
export class HostError extends Error {
  readonly name = "HostError";
  readonly code: HostErrorCode;
  /**
   * The ssh destination, as it would be typed after `ssh`, or the host block's
   * own name where the machine is the one werk is running on. Everything that
   * raises one of these is reached over ssh except a setup, which runs on
   * whichever machine the block names.
   */
  readonly sshHost: string;
  /** What ssh or the far side actually printed, when there was anything. */
  readonly detail?: string;
  constructor(
    code: HostErrorCode,
    sshHost: string,
    message: string,
    detail?: string,
  ) {
    const trimmed = detail?.trim();
    super(trimmed ? `${message}\n${trimmed}` : message);
    this.code = code;
    this.sshHost = sshHost;
    if (trimmed) this.detail = trimmed;
  }
}
