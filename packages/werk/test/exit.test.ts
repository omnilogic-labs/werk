import { expect, test } from "bun:test";
import { SessionError, type ErrorCode } from "@werk/session";
import { WorkspaceError, type WorkspaceErrorCode } from "@werk/workspace";
import { HostError, type HostErrorCode } from "../src/host/types.js";
import {
  CancelledError,
  UsageError,
  errorPayload,
  exitCodeFor,
} from "../src/runtime/exit.js";

test("each protocol error gets its own code", () => {
  const expected: Record<string, number> = {
    NOT_FOUND: 3,
    PERMISSION_DENIED: 4,
    CONFLICT: 5,
    LIMIT: 6,
    TIMEOUT: 7,
    CLOSED: 7,
    CANCELLED: 130,
    INVALID_ARGUMENT: 2,
    PROTOCOL: 1,
    INTERNAL: 1,
    UNSUPPORTED: 1,
  };
  for (const [code, status] of Object.entries(expected))
    expect(exitCodeFor(new SessionError(code as ErrorCode, "x"))).toBe(status);
});
test("a mistyped command is a usage failure, not a generic one", () => {
  expect(exitCodeFor(new UsageError("x"))).toBe(2);
});
test("cancelling reports the conventional signal status", () => {
  expect(exitCodeFor(new CancelledError("x"))).toBe(130);
});
test("anything unrecognised fails generically", () => {
  expect(exitCodeFor(new Error("x"))).toBe(1);
  expect(exitCodeFor("a string")).toBe(1);
});
test("the machine shape carries the protocol code", () => {
  expect(
    errorPayload(new SessionError("NOT_FOUND", "no such session")),
  ).toEqual({
    error: { code: "NOT_FOUND", message: "no such session" },
  });
  expect(errorPayload(new UsageError("bad flag")).error.code).toBe("USAGE");
  expect(errorPayload("boom").error).toEqual({
    code: "INTERNAL",
    message: "boom",
  });
});

test("commander's own parse failures are usage failures too", () => {
  // `exitOverride` makes commander throw these rather than exiting 1 itself,
  // which would otherwise collide with the status a daemon refusal uses.
  for (const code of [
    "commander.unknownCommand",
    "commander.unknownOption",
    "commander.invalidArgument",
    "commander.missingArgument",
    "commander.excessArguments",
    "commander.conflictingOption",
  ])
    expect(
      exitCodeFor(Object.assign(new Error("x"), { code, exitCode: 1 })),
    ).toBe(2);
});
test("help and version succeed even though they arrive as errors", () => {
  for (const code of [
    "commander.help",
    "commander.helpDisplayed",
    "commander.version",
  ])
    expect(
      exitCodeFor(Object.assign(new Error("x"), { code, exitCode: 0 })),
    ).toBe(0);
});
test("a commander failure reports as a usage failure in JSON", () => {
  const payload = errorPayload(
    Object.assign(new Error("unknown command"), {
      code: "commander.unknownCommand",
    }),
  );
  expect(payload.error.code).toBe("USAGE");
});

test("a workspace failure is told apart from a daemon refusal", () => {
  // Without this mapping "you are not in a git repository" would arrive as
  // INTERNAL and exit 1, which is the status a daemon refusal uses.
  const expected: Record<string, number> = {
    INVALID_NAME: 2,
    NOT_A_REPOSITORY: 2,
    NO_COMMITS: 2,
    BRANCH_EXISTS: 5,
    DIRECTORY_EXISTS: 5,
    GIT_MISSING: 1,
    GIT_FAILED: 1,
    // A machine that did not answer and a daemon that did not answer are the
    // same fact to a script deciding whether to try again, and being refused
    // by ssh is being refused, so both reuse the status that already means it.
    HOST_UNREACHABLE: 7,
    HOST_AUTH_DENIED: 4,
    HOST_UNSUPPORTED: 1,
    HOST_BOOTSTRAP_FAILED: 1,
    REMOTE_GIT_MISSING: 1,
    TRANSFER_FAILED: 1,
  };
  for (const [code, status] of Object.entries(expected))
    expect(
      exitCodeFor(new WorkspaceError(code as WorkspaceErrorCode, "x")),
      code,
    ).toBe(status);
});
test("the machine shape carries the workspace code and what git said", () => {
  expect(
    errorPayload(new WorkspaceError("NOT_A_REPOSITORY", "/tmp is not a repo")),
  ).toEqual({
    error: { code: "NOT_A_REPOSITORY", message: "/tmp is not a repo" },
  });
  const failed = new WorkspaceError("GIT_FAILED", "add failed", "fatal: told");
  expect(failed.detail).toBe("fatal: told");
  expect(errorPayload(failed).error.message).toBe("add failed: fatal: told");
});

/**
 * The two tables name overlapping facts, and a caller cannot tell which layer
 * noticed one: an unreachable machine fails in the probe when the workspace
 * root has to be asked for, and in the transfer when a host block named one.
 * Answering differently down the two paths would make the same machine look
 * like a typing mistake or a timeout depending on how its block was written.
 */
test("a host error means the same thing whichever layer raised it", () => {
  const pairs: readonly (readonly [HostErrorCode, WorkspaceErrorCode])[] = [
    ["HOST_UNREACHABLE", "HOST_UNREACHABLE"],
    ["HOST_AUTH_FAILED", "HOST_AUTH_DENIED"],
    ["HOST_UNSUPPORTED", "HOST_UNSUPPORTED"],
    ["HOST_BOOTSTRAP_FAILED", "HOST_BOOTSTRAP_FAILED"],
  ];
  for (const [host, workspace] of pairs)
    expect(
      exitCodeFor(new HostError(host, "asleep")),
      `${host} and ${workspace} disagree`,
    ).toBe(exitCodeFor(new WorkspaceError(workspace, "asleep")));
});

test("a machine that is asleep is not a usage mistake", () => {
  expect(exitCodeFor(new HostError("HOST_UNREACHABLE", "asleep"))).toBe(7);
  expect(exitCodeFor(new HostError("HOST_AUTH_FAILED", "refused"))).toBe(4);
});
