// Builds the browser bundle: src/web/client/main.ts and everything it
// reaches (the engine adapter, the encoders, the wire format) for the
// browser, into src/web/bundle/app.js. The server imports that file as
// text, so the compiled `wp` carries it. Run by `bun run build:web`, and
// by `bun run build` before the compile.

import path from "node:path";

export const BUNDLE_DIR = path.join(import.meta.dir, "bundle");
export const BUNDLE_FILE = path.join(BUNDLE_DIR, "app.js");

export async function buildBundle(): Promise<{ bytes: number; ms: number }> {
  const t0 = performance.now();
  const r = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "client", "main.ts")],
    target: "browser",
    outdir: BUNDLE_DIR,
    naming: "app.js",
    minify: false,
    sourcemap: "none",
  });
  if (!r.success) {
    throw new Error(
      "bundle failed:\n" + r.logs.map((l) => String(l)).join("\n"),
    );
  }
  const out = r.outputs.find((o) => o.path.endsWith("app.js"));
  return { bytes: out?.size ?? 0, ms: performance.now() - t0 };
}

if (import.meta.main) {
  const { bytes, ms } = await buildBundle();
  console.log(
    `web bundle: ${bytes} B in ${ms.toFixed(0)} ms -> ${BUNDLE_FILE}`,
  );
}
