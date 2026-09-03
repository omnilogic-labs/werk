import { expect, test } from "bun:test";
import { main, parse } from "./main.ts";

test("no arguments prints usage and exits 0", async () => {
  expect(await main([])).toBe(0);
});

test("attach without an id is a usage error", async () => {
  expect(await main(["attach"])).toBe(2);
});

test("run without a command is a usage error", async () => {
  expect(await main(["run"])).toBe(2);
});

test("bench without a subcommand is a usage error", async () => {
  expect(await main(["bench"])).toBe(2);
  expect(await main(["bench", "frobnicate"])).toBe(2);
});

test("serve refuses a bad port", async () => {
  expect(await main(["serve", "--port", "nope"])).toBe(2);
});

test("unknown commands fail", async () => {
  expect(await main(["frobnicate"])).toBe(2);
});

// The child after `--` must survive exactly as typed: nothing in it gets
// consumed as a flag of wp's own, reordered, or otherwise touched.

test("a child flag that looks dangerous passes through untouched", () => {
  const p = parse(["--", "claude", "--dangerously-skip-permissions"]);
  expect(p.rest).toEqual(["claude", "--dangerously-skip-permissions"]);
});

test("an empty `--` tail is an empty rest, not a missing one", () => {
  const p = parse(["--"]);
  expect(p.rest).toEqual([]);
});

test("`--` after other flags still marks the boundary correctly", () => {
  const p = parse([
    "--engine",
    "ghostty-wasm",
    "--cols",
    "80",
    "--",
    "claude",
    "--dangerously-skip-permissions",
  ]);
  expect(p.flags.get("engine")).toBe("ghostty-wasm");
  expect(p.flags.get("cols")).toBe("80");
  expect(p.rest).toEqual(["claude", "--dangerously-skip-permissions"]);
});

test("a child argv holding one of wp's own flag names is not parsed as wp's", () => {
  const p = parse([
    "--",
    "claude",
    "--socket",
    "not-a-real-socket",
    "--engine",
    "nope",
  ]);
  expect(p.flags.has("socket")).toBe(false);
  expect(p.flags.has("engine")).toBe(false);
  expect(p.rest).toEqual([
    "claude",
    "--socket",
    "not-a-real-socket",
    "--engine",
    "nope",
  ]);
});

test("a second `--` inside the child argv is just another child argument", () => {
  const p = parse(["--", "claude", "--", "--dangerously-skip-permissions"]);
  expect(p.rest).toEqual(["claude", "--", "--dangerously-skip-permissions"]);
});
