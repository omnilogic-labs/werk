import { expect, test } from "bun:test";
import { SessionError, type ErrorCode } from "@werk/session";
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
