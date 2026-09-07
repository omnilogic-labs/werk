import { expect, test } from "bun:test";
import { colourLevel, colourLevelFromArgv } from "../src/runtime/colour.js";

const level = (isTTY: boolean, env: Record<string, string | undefined>) =>
  colourLevel({ isTTY, env });

test("a terminal gets colour and a pipe does not", () => {
  expect(level(true, { COLORTERM: "truecolor" })).toBe(3);
  expect(level(false, { COLORTERM: "truecolor" })).toBe(0);
});
test("depth follows COLORTERM then TERM", () => {
  expect(level(true, { COLORTERM: "24bit" })).toBe(3);
  expect(level(true, { TERM: "xterm-256color" })).toBe(2);
  expect(level(true, { TERM: "screen-256" })).toBe(2);
  expect(level(true, { TERM: "xterm" })).toBe(1);
});
test("NO_COLOR wins, by presence rather than by value", () => {
  expect(level(true, { NO_COLOR: "1" })).toBe(0);
  expect(level(true, { NO_COLOR: "0" })).toBe(0);
  expect(level(true, { NO_COLOR: "false" })).toBe(0);
  // The convention treats an empty value as unset.
  expect(level(true, { NO_COLOR: "" })).toBe(1);
});
test("NO_COLOR beats FORCE_COLOR", () => {
  expect(level(false, { NO_COLOR: "1", FORCE_COLOR: "1" })).toBe(0);
});
test("FORCE_COLOR colours a pipe, and can switch itself off", () => {
  expect(level(false, { FORCE_COLOR: "1", TERM: "xterm-256color" })).toBe(2);
  expect(level(false, { FORCE_COLOR: "0" })).toBe(0);
  expect(level(false, { FORCE_COLOR: "false" })).toBe(0);
});
test("a dumb terminal is taken at its word, even under FORCE_COLOR", () => {
  expect(level(true, { TERM: "dumb" })).toBe(0);
  expect(level(true, { TERM: "dumb", FORCE_COLOR: "1" })).toBe(0);
});
test("--color and --no-color override the environment", () => {
  const env = { COLORTERM: "truecolor" };
  expect(colourLevelFromArgv(["list", "--color"], { isTTY: false, env })).toBe(
    3,
  );
  expect(
    colourLevelFromArgv(["list", "--no-color"], { isTTY: true, env }),
  ).toBe(0);
});
test("a child's --no-color after -- is not werk's", () => {
  const env = { COLORTERM: "truecolor" };
  expect(
    colourLevelFromArgv(["create", "--", "sh", "--no-color"], {
      isTTY: true,
      env,
    }),
  ).toBe(3);
});
