// Every adapter's registry entry, for the places that want all three: `wp
// caps`, `wp bench diff`, and the daemon (which loads an engine only when a
// session asks for it, so an ffi library that cannot open costs nothing
// until then).

import "./ghostty-wasm/bun.ts";
import "./ghostty-ffi/bun.ts";
import "./xterm-oracle/bun.ts";

export { engineIds, getEngine } from "./registry.ts";
