import { mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = import.meta.dir;
const outdir = join(root, "dist");
await mkdir(outdir, { recursive: true });
for (const [name, target] of [
  ["client", "browser"],
  ["server", "bun"],
  ["bridge", "bun"],
] as const) {
  const result = await Bun.build({
    entrypoints: [join(root, `src/${name}.ts`)],
    outdir,
    target,
    splitting: target === "browser",
    minify: target === "browser",
    naming: "[name].[ext]",
    external: target === "bun" ? ["@werk/session-daemon", "@werk/session"] : [],
  });
  if (!result.success)
    throw new AggregateError(result.logs, `${name} bundle failed`);
}
for (const name of ["index.html", "style.css"])
  await copyFile(join(root, "src", name), join(outdir, name));
await copyFile(
  fileURLToPath(import.meta.resolve("@werk/terminal/assets/terminal.wasm")),
  join(outdir, "terminal.wasm"),
);
// The upstream web module references this adjacent pinned WASM. Its package has
// no WASM export, so resolve its public entry and copy the shipped sibling.
const beamPackage = import.meta.resolve("@werk/terminal-beamterm");
const beamWeb = Bun.resolveSync(
  "@beamterm/renderer/web",
  dirname(fileURLToPath(beamPackage)),
);
const beamWasm = join(dirname(beamWeb), "beamterm_renderer_bg.wasm");
const beamDigest = new Bun.CryptoHasher("sha256")
  .update(await Bun.file(beamWasm).arrayBuffer())
  .digest("hex");
if (
  beamDigest !==
  "0f5e9f04ba2fbcfcc8dac30523ef692bfc6bf84fbb61d545deeb4fb6138d6d36"
)
  throw new Error("beamterm WASM digest differs from PROVENANCE.md");
await copyFile(beamWasm, join(outdir, "beamterm_renderer_bg.wasm"));
console.log(`Browser and bridge assets built in ${outdir}`);

const terminalAssets = dirname(
  fileURLToPath(import.meta.resolve("@werk/terminal/assets/terminal.wasm")),
);
for (const name of ["LICENSE", "PROVENANCE.md"])
  await copyFile(join(terminalAssets, name), join(outdir, `terminal.${name}`));
const adapterRoot = dirname(dirname(fileURLToPath(beamPackage)));
for (const name of ["LICENSE.beamterm", "PROVENANCE.md"])
  await copyFile(
    join(adapterRoot, name),
    join(outdir, name === "PROVENANCE.md" ? "beamterm.PROVENANCE.md" : name),
  );
// DOM renderer code is bundled too; preserve its upstream licence in the output.
const terminalDom = fileURLToPath(import.meta.resolve("@werk/terminal/dom"));
const wtermDom = Bun.resolveSync("@wterm/dom", dirname(terminalDom));
await copyFile(
  join(dirname(dirname(wtermDom)), "LICENSE"),
  join(outdir, "LICENSE.wterm-dom"),
);
