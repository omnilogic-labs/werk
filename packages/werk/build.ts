import { mkdir } from "node:fs/promises";
import { join } from "node:path";
// `import.meta.dir` is the absolute filesystem path of this directory. The
// `pathname` of `import.meta.url` is not one: on Windows a `file://` URL keeps
// a slash in front of the drive letter, so `D:\a\werk` comes back as
// `/D:/a/werk`, which nothing on that platform can open.
const here = import.meta.dir;
const entrypoint = join(here, "src", "main.ts");
const outdir = join(here, "dist");
await mkdir(outdir, { recursive: true });
// The compiled binary is the only artefact. `bin.werk` points at it, the tests
// spawn it or `src/main.ts`, and `check-artefacts.ts` copies it; a bundled
// `dist/main.js` beside it was reached by none of those. `WERK_COMPILED` is
// therefore defined on the compiled side alone, and `runtime/daemon.ts` reads
// it through a `typeof` guard so an interpreted run sees it as unset.
const child = Bun.spawn(
  [
    process.execPath,
    "build",
    "--compile",
    entrypoint,
    "--define",
    "WERK_COMPILED=true",
    // Bun compiles dotenv autoloading in by default, so the binary would read a
    // `.env` out of whatever directory it was run in and merge it into
    // `process.env`. `clientEnvironment()` forwards nearly all of `process.env`
    // to the daemon, so `werk create` inside any repository holding a `.env`
    // would ship that repository's secrets into every session it starts.
    "--no-compile-autoload-dotenv",
    "--outfile",
    join(outdir, "werk"),
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await child.exited) !== 0) throw new Error("CLI executable build failed");
