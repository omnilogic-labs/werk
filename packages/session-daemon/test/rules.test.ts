import { expect, test } from "bun:test";
import { notPrivateToOwner, socketPathTooLong } from "../src/platform/rules.js";

const private0600 = { uid: 1000, mode: 0o100600 };

test("a Unix socket path is measured in bytes against the portable limit", () => {
  expect(socketPathTooLong("/tmp/werk-1000/daemon.sock", "linux")).toBe(false);
  expect(socketPathTooLong("/" + "a".repeat(103), "linux")).toBe(true);
  expect(socketPathTooLong("/" + "a".repeat(102), "linux")).toBe(false);
  // Multi-byte characters spend more of the limit than their length suggests.
  expect(socketPathTooLong("/" + "é".repeat(52), "linux")).toBe(true);
  expect(socketPathTooLong("/" + "é".repeat(51), "linux")).toBe(false);
});

test("Windows carries the endpoint on a port, so no path length is refused", () => {
  expect(socketPathTooLong("/" + "a".repeat(5000), "win32")).toBe(false);
});

test("a POSIX endpoint is private only to its own owner with no group or other bits", () => {
  expect(notPrivateToOwner(private0600, "linux", 1000)).toBe(false);
  expect(notPrivateToOwner({ uid: 1001, mode: 0o100600 }, "linux", 1000)).toBe(
    true,
  );
  expect(notPrivateToOwner({ uid: 1000, mode: 0o100640 }, "linux", 1000)).toBe(
    true,
  );
  expect(notPrivateToOwner({ uid: 1000, mode: 0o100606 }, "linux", 1000)).toBe(
    true,
  );
  expect(notPrivateToOwner({ uid: 1000, mode: 0o100700 }, "linux", 1000)).toBe(
    false,
  );
});

test("Windows reads privacy from the ACL, so a stat refuses nothing", () => {
  // The same values that fail on POSIX pass here, including an absent uid.
  expect(notPrivateToOwner({ uid: 1001, mode: 0o100666 }, "win32", 1000)).toBe(
    false,
  );
  expect(
    notPrivateToOwner({ uid: 0, mode: 0o100666 }, "win32", undefined),
  ).toBe(false);
});

test("both predicates read the running platform when they are not given one", () => {
  expect(socketPathTooLong("/" + "a".repeat(5000))).toBe(
    process.platform !== "win32",
  );
  expect(
    notPrivateToOwner({ uid: 1000, mode: 0o100666 }, undefined, 1000),
  ).toBe(process.platform !== "win32");
});
