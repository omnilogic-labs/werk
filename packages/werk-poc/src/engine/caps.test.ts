import { expect, test } from "bun:test";
import { main } from "../cli/main.ts";
import { CAPABILITY_NAMES, capabilityMatrix } from "./caps.ts";
import { engineIds, getEngine } from "./registry.ts";
import "./ghostty-wasm/bun.ts";

test("the matrix is output of the program, and ghostty-wasm has every capability", async () => {
  const engines = await Promise.all(engineIds().map((id) => getEngine(id)));
  const table = capabilityMatrix(engines);
  console.log(`\n${table}\n`);
  const wasm = engines.find((e) => e.id === "ghostty-wasm")!;
  for (const name of CAPABILITY_NAMES) expect(wasm.caps[name]).toBe(true);
  expect(table.split("\n").length).toBe(CAPABILITY_NAMES.length + 2);
  expect(table).toContain("| `renderConsumer` | yes");
});

test("wp caps prints it", async () => {
  expect(await main(["caps"])).toBe(0);
});
