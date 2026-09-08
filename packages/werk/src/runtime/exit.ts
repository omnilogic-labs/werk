/**
 * What the process exits with.
 *
 * The CLI used to have two outcomes, 0 and 1, which made "the session is gone"
 * indistinguishable from "the daemon never answered" to anything scripting it.
 * `@werk/session` already carries the vocabulary, so the mapping is a lookup
 * rather than a judgement, and it is pure so it can be asserted directly.
 */
import { SessionError, type ErrorCode } from "@werk/session";
import { WorkspaceError, type WorkspaceErrorCode } from "@werk/workspace";
import { ConfigError, type ConfigErrorCode } from "../config/errors.js";
import { HostError, type HostErrorCode } from "../host/types.js";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_CANCELLED = 130;

/**
 * Raised for anything the caller typed wrong; never for a daemon refusal.
 *
 * A command raises one from wherever the mistake becomes apparent, including
 * after the parse. `withContext` catches it and hands it to commander's own
 * error path, so a rule commander could not express is still reported with the
 * usage line, the command's options and its examples behind it.
 */
export class UsageError extends Error {
  readonly name = "UsageError";
}
/** Raised when an interactive prompt is cancelled, or SIGINT arrives. */
export class CancelledError extends Error {
  readonly name = "CancelledError";
}

const BY_CODE: Record<ErrorCode, number> = {
  NOT_FOUND: 3,
  PERMISSION_DENIED: 4,
  CONFLICT: 5,
  LIMIT: 6,
  // Both mean the daemon is not answering, which a caller retries differently
  // from a refusal it did answer with.
  TIMEOUT: 7,
  CLOSED: 7,
  CANCELLED: EXIT_CANCELLED,
  INVALID_ARGUMENT: EXIT_USAGE,
  PROTOCOL: EXIT_FAILURE,
  INTERNAL: EXIT_FAILURE,
  UNSUPPORTED: EXIT_FAILURE,
};

/**
 * A workspace that could not be made, in the same registers the daemon's
 * refusals already use: what the caller asked for is wrong, something is
 * already there, nothing answered, werk was not let in, or the machine could
 * not do it. Without this a person standing outside a repository would be told
 * `INTERNAL` and given exit 1, which is the status a daemon refusal uses —
 * exactly the collision this file exists to prevent.
 *
 * No new statuses for the machine a workspace is being made on. "That host did
 * not answer" and "the daemon did not answer" are the same thing to a script
 * deciding whether to retry, and being refused by ssh is being refused, so both
 * reuse the number that already means it.
 */
const BY_WORKSPACE_CODE: Record<WorkspaceErrorCode, number> = {
  INVALID_NAME: EXIT_USAGE,
  NOT_A_REPOSITORY: EXIT_USAGE,
  NO_COMMITS: EXIT_USAGE,
  // The same status a daemon uses for CONFLICT, because it is the same fact:
  // the name is taken.
  BRANCH_EXISTS: 5,
  DIRECTORY_EXISTS: 5,
  GIT_MISSING: EXIT_FAILURE,
  GIT_FAILED: EXIT_FAILURE,
  // The status that already means "nothing answered", which is the same fact a
  // caller retrying wants from a machine as from a daemon.
  HOST_UNREACHABLE: 7,
  // The same status a daemon uses for PERMISSION_DENIED: werk was not let in.
  HOST_AUTH_DENIED: 4,
  HOST_UNSUPPORTED: EXIT_FAILURE,
  HOST_BOOTSTRAP_FAILED: EXIT_FAILURE,
  REMOTE_GIT_MISSING: EXIT_FAILURE,
  TRANSFER_FAILED: EXIT_FAILURE,
  // The landing half, in the same statuses. Naming a workspace nothing knows
  // about is a name that resolves to nothing, which is what exit 3 already
  // means for a session; standing on a detached HEAD and asking for a route
  // werk cannot take are things the caller can put right, which is exit 2. A
  // change already on the branch and a checkout with work in it are both "that
  // is already the case", which is the status BRANCH_EXISTS uses.
  NO_SUCH_WORKSPACE: 3,
  WORKSPACE_ELSEWHERE: EXIT_FAILURE,
  DETACHED_HEAD: EXIT_USAGE,
  NOTHING_TO_LAND: 5,
  WORKTREE_DIRTY: 5,
  LAND_CONFLICT: EXIT_FAILURE,
};

/**
 * Configuration werk cannot act on, in the statuses that already exist. A host
 * block that does not parse, a name nothing defines and a file that is not the
 * TOML it claims to be are all the same thing to a caller: what werk was told
 * is wrong, which is exit 2, the status a mistyped flag already gets. A write
 * that failed is the machine not doing it, which is exit 1.
 *
 * No new statuses. Nothing scripting werk should have to learn a number to find
 * out that a config file has a typo in it.
 */
const BY_CONFIG_CODE: Record<ConfigErrorCode, number> = {
  HOST_INVALID: EXIT_USAGE,
  HOST_NAME_INVALID: EXIT_USAGE,
  SETUP_INVALID: EXIT_USAGE,
  UNKNOWN_HOST: EXIT_USAGE,
  CONFIG_UNREADABLE: EXIT_USAGE,
  CONFIG_WRITE_FAILED: EXIT_FAILURE,
};

/**
 * A machine werk could not reach or could not put itself on.
 *
 * No new statuses, and every row that names the same fact as one in
 * `BY_WORKSPACE_CODE` carries the same status as it. The two tables are
 * separate because the errors are raised by different layers, but a caller
 * cannot tell which layer noticed: reaching a machine that is asleep fails in
 * the probe when the workspace root has to be asked for, and in the transfer
 * when the configuration already named one. Answering 2 down one path and 7
 * down the other would make the same machine look like a typing mistake or a
 * timeout depending on how a host block happened to be written.
 *
 * So none of these is a usage status. Nobody mistyped anything: the name
 * resolved, the block parsed, and the machine is asleep, or refused werk, or is
 * one werk has no binary for.
 */
const BY_HOST_CODE: Record<HostErrorCode, number> = {
  // The status that already means "nothing answered".
  HOST_UNREACHABLE: 7,
  // The same status a daemon uses for PERMISSION_DENIED: werk was not let in.
  HOST_AUTH_FAILED: 4,
  HOST_UNSUPPORTED: EXIT_FAILURE,
  HOST_BOOTSTRAP_FAILED: EXIT_FAILURE,
  HOST_DAEMON_MISSING: 7,
  // A command somebody wrote in a `[setup.<name>]` block refused. The machine
  // answered and werk reached it, so this is neither a timeout nor a usage
  // mistake: it is the general failure, which is exit 1.
  HOST_SETUP_FAILED: EXIT_FAILURE,
  WORKSPACE_SETUP_FAILED: EXIT_FAILURE,
};

/**
 * Commander's own parse failures — an unknown command, a bad `--intent` — are
 * the same class of mistake as a `UsageError` and get the same status. Left to
 * itself commander exits 1, which would make "you typed it wrong" indist-
 * inguishable from "the daemon refused". `--help` and `--version` arrive here
 * too, because `exitOverride` throws for them as well, and they succeeded.
 *
 * The code alone does not settle it. Commander raises `commander.help` both for
 * a `--help` somebody asked for and for a parent command given no subcommand,
 * which is a usage mistake it answers by printing help to stderr. It separates
 * the two by exit code, so this reads that rather than the code alone.
 */
const COMMANDER_SUCCESS = new Set([
  "commander.help",
  "commander.helpDisplayed",
  "commander.version",
]);
export function isCommanderError(
  error: unknown,
): error is { code: string; exitCode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code.startsWith("commander.")
  );
}
export function exitCodeFor(error: unknown): number {
  if (isCommanderError(error))
    return COMMANDER_SUCCESS.has(error.code) && error.exitCode === 0
      ? EXIT_OK
      : EXIT_USAGE;
  if (error instanceof UsageError) return EXIT_USAGE;
  if (error instanceof CancelledError) return EXIT_CANCELLED;
  if (error instanceof SessionError) return BY_CODE[error.code] ?? EXIT_FAILURE;
  if (error instanceof WorkspaceError)
    return BY_WORKSPACE_CODE[error.code] ?? EXIT_FAILURE;
  if (error instanceof ConfigError)
    return BY_CONFIG_CODE[error.code] ?? EXIT_FAILURE;
  if (error instanceof HostError)
    return BY_HOST_CODE[error.code] ?? EXIT_FAILURE;
  return EXIT_FAILURE;
}

/**
 * One `error:` line per rule broken, as the message of a single failure.
 *
 * Commander renders its own prefix into the text it hands to `outputError`, and
 * werk appends a line per further rule the invocation broke. The machine
 * register wants the sentences rather than the prefixes.
 */
export function usageMessage(rendered: string): string {
  return rendered
    .split("\n")
    .map((line) => line.replace(/^error: /, "").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** The machine shape of a failure, written to stderr so stdout stays clean. */
export function errorPayload(error: unknown): {
  error: { code: string; message: string };
} {
  const code = isCommanderError(error)
    ? "USAGE"
    : error instanceof SessionError ||
        error instanceof WorkspaceError ||
        error instanceof ConfigError ||
        error instanceof HostError
      ? error.code
      : error instanceof UsageError
        ? "USAGE"
        : error instanceof CancelledError
          ? "CANCELLED"
          : "INTERNAL";
  return {
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
