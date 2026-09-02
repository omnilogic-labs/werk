// Bun entry point for the adapter: pinned bytes + registry entry. Anything
// that must stay portable to the browser lives in index.ts / loader.ts.

import { registerEngine } from "../registry.ts";
import { ghosttyWasmBytes } from "./bytes.ts";
import { GhosttyWasmEngine } from "./index.ts";

export async function loadGhosttyWasmEngine(): Promise<GhosttyWasmEngine> {
  return GhosttyWasmEngine.load(await ghosttyWasmBytes());
}

registerEngine("ghostty-wasm", loadGhosttyWasmEngine);
