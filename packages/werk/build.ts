import { mkdir } from "node:fs/promises";
await mkdir(new URL("./dist/", import.meta.url), { recursive: true });
const result = await Bun.build({
  entrypoints: [new URL("./src/main.ts", import.meta.url).pathname],
  target: "bun",
  outdir: new URL("./dist/", import.meta.url).pathname,
  define: { WERK_COMPILED: "false" },
});
if (!result.success)
  throw new AggregateError(result.logs, "CLI JavaScript build failed");
const child = Bun.spawn(
  [
    process.execPath,
    "build",
    "--compile",
    new URL("./src/main.ts", import.meta.url).pathname,
    "--define",
    "WERK_COMPILED=true",
    "--outfile",
    new URL("./dist/werk", import.meta.url).pathname,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await child.exited) !== 0) throw new Error("CLI executable build failed");
