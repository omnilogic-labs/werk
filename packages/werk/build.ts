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
    // Bun compiles dotenv autoloading in by default, so the binary would read a
    // `.env` out of whatever directory it was run in and merge it into
    // `process.env`. `clientEnvironment()` forwards nearly all of `process.env`
    // to the daemon, so `werk create` inside any repository holding a `.env`
    // would ship that repository's secrets into every session it starts.
    "--no-compile-autoload-dotenv",
    "--outfile",
    new URL("./dist/werk", import.meta.url).pathname,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await child.exited) !== 0) throw new Error("CLI executable build failed");
