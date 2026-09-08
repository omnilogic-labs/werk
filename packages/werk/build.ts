import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { formatBuildIdentity } from "./src/runtime/version.js";
// `import.meta.dir` is the absolute filesystem path of this directory. The
// `pathname` of `import.meta.url` is not one: on Windows a `file://` URL keeps
// a slash in front of the drive letter, so `D:\a\werk` comes back as
// `/D:/a/werk`, which nothing on that platform can open.
const here = import.meta.dir;
const entrypoint = join(here, "src", "main.ts");
const outdir = join(here, "dist");
await mkdir(outdir, { recursive: true });

/**
 * Ask git what this tree is, and say nothing rather than guess when it cannot
 * answer — no repository, no git on PATH, a source tarball.
 */
async function git(...args: string[]): Promise<string | undefined> {
  try {
    const child = Bun.spawn(["git", ...args], {
      cwd: here,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(child.stdout).text();
    return (await child.exited) === 0 ? text.trim() : undefined;
  } catch {
    return undefined;
  }
}
const version = (
  (await Bun.file(join(here, "package.json")).json()) as {
    version: string;
  }
).version;
const sha = await git("rev-parse", "--short", "HEAD");
// A tree with uncommitted changes is not the tree the SHA names, and a build of
// one is not something a client could reproduce by checking that SHA out.
const dirty = ((await git("status", "--porcelain")) ?? "") !== "";
const build = formatBuildIdentity(version, sha, dirty);

// The compiled binary is the only artefact. `bin.werk` points at it, the tests
// spawn it or `src/main.ts`, and `check-artefacts.ts` copies it; a bundled
// `dist/main.js` beside it was reached by none of those. `WERK_COMPILED` and
// `WERK_BUILD` are therefore defined on the compiled side alone, and
// `runtime/daemon.ts` and `runtime/version.ts` read them through a `typeof`
// guard so an interpreted run sees them as unset.
const child = Bun.spawn(
  [
    process.execPath,
    "build",
    "--compile",
    entrypoint,
    "--define",
    "WERK_COMPILED=true",
    "--define",
    `WERK_BUILD=${JSON.stringify(build)}`,
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
