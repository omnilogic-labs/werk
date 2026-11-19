import { expect, test } from "bun:test";
import { refuseDaemonPlatform } from "../src/platform/index.js";
import { notPrivateToOwner, socketPathTooLong } from "../src/platform/rules.js";

const private0600 = { uid: 1000, mode: 0o100600 };

test("a Unix socket path is measured in bytes against the portable limit", () => {
  expect(socketPathTooLong("/tmp/werk-1000/daemon.sock")).toBe(false);
  expect(socketPathTooLong("/" + "a".repeat(103))).toBe(true);
  expect(socketPathTooLong("/" + "a".repeat(102))).toBe(false);
  // Multi-byte characters spend more of the limit than their length suggests.
  expect(socketPathTooLong("/" + "é".repeat(52))).toBe(true);
  expect(socketPathTooLong("/" + "é".repeat(51))).toBe(false);
});

test("a POSIX endpoint is private only to its own owner with no group or other bits", () => {
  expect(notPrivateToOwner(private0600, 1000)).toBe(false);
  expect(notPrivateToOwner({ uid: 1001, mode: 0o100600 }, 1000)).toBe(true);
  expect(notPrivateToOwner({ uid: 1000, mode: 0o100640 }, 1000)).toBe(true);
  expect(notPrivateToOwner({ uid: 1000, mode: 0o100606 }, 1000)).toBe(true);
  expect(notPrivateToOwner({ uid: 1000, mode: 0o100700 }, 1000)).toBe(false);
});

test("the owner check reads the running user when it is not given one", () => {
  const uid = process.getuid!();
  expect(notPrivateToOwner({ uid, mode: 0o100600 })).toBe(false);
  expect(notPrivateToOwner({ uid: uid + 1, mode: 0o100600 })).toBe(true);
});

test("the daemon refuses to start on Windows, where werk runs only as a client", () => {
  expect(() => refuseDaemonPlatform("win32")).toThrow(
    "On Windows werk runs only as a client",
  );
  expect(() => refuseDaemonPlatform("linux")).not.toThrow();
  expect(() => refuseDaemonPlatform("darwin")).not.toThrow();
});
