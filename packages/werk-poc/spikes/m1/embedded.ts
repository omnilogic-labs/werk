// Does the pinned wasm survive `bun build --compile`? This entry is compiled
// into dist/m1/embedded and run from a directory with no .wasm anywhere near
// it (embedded.test.ts does that). It prints where the bytes came from and
// the plain text of a fed terminal.

import {
  ghosttyWasmBytes,
  ghosttyWasmPath,
} from "../../src/engine/ghostty-wasm/bytes.ts";
import { GhosttyWasmEngine } from "../../src/engine/ghostty-wasm/index.ts";

const engine = await GhosttyWasmEngine.load(await ghosttyWasmBytes());
const t = engine.create({ cols: 20, rows: 3, scrollback: 10 });
t.write(new TextEncoder().encode("\x1b[1mcompiled\x1b[0m ok\r\n日本 😀"));
console.log(`wasm: ${ghosttyWasmPath}`);
console.log(`exports: ${engine.module.exportCount}`);
console.log(`bold: ${t.styledCells()[0]![0]!.bold}`);
console.log(t.plainText());
t.dispose();
