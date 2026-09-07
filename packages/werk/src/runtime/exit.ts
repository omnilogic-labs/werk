/**
 * What the process exits with.
 *
 * The CLI used to have two outcomes, 0 and 1, which made "the session is gone"
 * indistinguishable from "the daemon never answered" to anything scripting it.
 * `@werk/session` already carries the vocabulary, so the mapping is a lookup
 * rather than a judgement, and it is pure so it can be asserted directly.
 */
import { SessionError, type ErrorCode } from "@werk/session";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_CANCELLED = 130;

/** Raised for anything the caller typed wrong; never for a daemon refusal. */
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

export function exitCodeFor(error: unknown): number {
  if (error instanceof UsageError) return EXIT_USAGE;
  if (error instanceof CancelledError) return EXIT_CANCELLED;
  if (error instanceof SessionError) return BY_CODE[error.code] ?? EXIT_FAILURE;
  return EXIT_FAILURE;
}

/** The machine shape of a failure, written to stderr so stdout stays clean. */
export function errorPayload(error: unknown): {
  error: { code: string; message: string };
} {
  const code =
    error instanceof SessionError
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
