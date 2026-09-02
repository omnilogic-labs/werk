import { expect, test } from "bun:test";
import { main } from "./main.ts";

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
