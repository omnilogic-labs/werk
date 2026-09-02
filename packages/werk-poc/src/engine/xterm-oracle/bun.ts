// Registry entry for the oracle. Nothing here is Bun-specific; the file is
// named for symmetry with the two libghostty adapters.

import { registerEngine } from "../registry.ts";
import { XtermOracleEngine } from "./index.ts";

export async function loadXtermOracleEngine(): Promise<XtermOracleEngine> {
  return new XtermOracleEngine();
}

registerEngine("xterm-oracle", loadXtermOracleEngine);
