// M6's compiled-binary probe: inside a `bun build --compile` binary run
// from an empty directory, does the ffi adapter load (through the
// extraction in src/engine/ghostty-ffi/bun.ts) and does the oracle? One
// line per engine; compiled.test.ts reads them. With WP_FFI_RAW=1 the
// binding is imported bare, to show what happens without the extraction.

import { getEngine } from "../../src/engine/all.ts";
import { isUnsupported } from "../../src/engine/types.ts";

const enc = new TextEncoder();

if (process.env.WP_FFI_RAW) {
  try {
    const { Terminal } = await import("libghostty-vt");
    new Terminal({ cols: 2, rows: 1 }).close();
    console.log("ffi-raw: loaded");
  } catch (e) {
    console.log(
      `ffi-raw: ${(e as Error).constructor.name}: ${(e as Error).message}`,
    );
  }
}

for (const id of ["ghostty-wasm", "ghostty-ffi", "xterm-oracle"]) {
  try {
    const engine = await getEngine(id);
    const t = engine.create({ cols: 20, rows: 2, scrollback: 10 });
    t.write(enc.encode(`\x1b[1m${id}\x1b[0m 日`));
    const flush = (t as { flush?: () => Promise<void> }).flush;
    if (flush) await flush.call(t);
    const cells = t.styledCells();
    const vt = t.emitVt();
    const extra =
      id === "ghostty-ffi"
        ? ` lib=${(engine as unknown as { info: { path: string } }).info.path}`
        : "";
    console.log(
      `${id}: text=${JSON.stringify(t.plainText().split("\n")[0])} bold=${cells[0]![0]!.bold} wide=${cells[0]![id.length + 1]!.width} vt=${isUnsupported(vt) ? "unsupported" : vt.length + "B"}${extra}`,
    );
    t.dispose();
  } catch (e) {
    console.log(
      `${id}: FAILED ${(e as Error).constructor.name}: ${(e as Error).message}`,
    );
  }
}
