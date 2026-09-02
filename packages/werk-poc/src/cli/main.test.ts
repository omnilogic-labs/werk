import { expect, test } from "bun:test";
import { main } from "./main.ts";

test("no arguments prints usage and exits 0", () => {
  expect(main([])).toBe(0);
});

test("known commands are not implemented yet", () => {
  expect(main(["attach"])).toBe(2);
});

test("unknown commands fail", () => {
  expect(main(["frobnicate"])).toBe(2);
});
