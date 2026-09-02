import { expect, test } from "bun:test";
import { main } from "../cli/main.ts";
import { engineIds, getEngine } from "./all.ts";
import { CAPABILITY_NAMES, capabilityMatrix } from "./caps.ts";

test("the matrix is output of the program: three columns, one honest row per capability", async () => {
  const engines = await Promise.all(engineIds().map((id) => getEngine(id)));
  const table = capabilityMatrix(engines);
  console.log(`\n${table}\n`);
  expect(engines.map((e) => e.id)).toEqual([
    "ghostty-wasm",
    "ghostty-ffi",
    "xterm-oracle",
  ]);
  const wasm = engines[0]!;
  for (const name of CAPABILITY_NAMES) expect(wasm.caps[name]).toBe(true);
  const ffi = engines[1]!;
  expect(ffi.caps).toMatchObject({
    encodeState: false,
    decodeState: false,
    encodeMouse: false,
    renderConsumer: true,
    encodeKey: true,
    effects: true,
  });
  const oracle = engines[2]!;
  expect(oracle.caps).toMatchObject({
    write: true,
    plainText: true,
    styledCells: true,
    emitVt: true,
    effects: true,
    encodeState: false,
    decodeState: false,
    renderConsumer: false,
    encodeKey: false,
    encodeMouse: false,
  });
  expect(table.split("\n").length).toBe(CAPABILITY_NAMES.length + 2);
  expect(table).toContain(
    "| `renderConsumer` | yes            | yes           | no",
  );
});

test("wp caps prints it", async () => {
  expect(await main(["caps"])).toBe(0);
});
