// Control: a test file that touches nothing of the engine.
import { expect, test } from "bun:test";

test("no engine", () => {
  expect(1 + 1).toBe(2);
});
