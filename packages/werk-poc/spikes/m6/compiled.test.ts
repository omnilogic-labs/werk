// Builds spikes/m6/compiled.ts with `bun build --compile` and runs it from
// an empty directory with no PATH: the three engines have to come out of
// the binary alone. Also records the binary's size against a script that
// embeds nothing, and the wasm-only binary from M1.

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffiPlatform } from "../../src/engine/ghostty-ffi/bun.ts";
import { BUNFS_PATH } from "../../src/platform/index.ts";

const pkg = join(import.meta.dir, "..", "..");
const outDir = join(pkg, "dist", "m6");

/** The binary `--outfile <p>` wrote: `<p>.exe` where the platform adds one. */
const built = (p: string) => (existsSync(`${p}.exe`) ? `${p}.exe` : p);

function compile(entry: string, out: string): string {
  const build = Bun.spawnSync(
    ["bun", "build", "--compile", entry, "--outfile", out],
    { cwd: pkg, stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
  return built(out);
}

const mb = (p: string) => (Bun.file(p).size / 1048576).toFixed(1);

// The adapter extracts the prebuild pair for the host platform under names
// the shim was linked against: a versioned soname next to a shim on Linux,
// plain .dylib files on macOS, one DLL under both names on Windows. The
// platform id is the binding's own — `linux-<arch>-<libc>`, so it differs
// per architecture and between glibc and musl — and the expectation reads
// it from the host rather than naming one target.
const DARWIN = process.platform === "darwin";
const WIN32 = process.platform === "win32";
const PLATFORM = ffiPlatform();
const LIB_NAME = DARWIN
  ? "libghostty-vt.dylib"
  : WIN32
    ? "ghostty-vt.dll"
    : "libghostty-vt.so.0";
const SHIM_NAME = DARWIN
  ? "libghostty-vt-shim.dylib"
  : WIN32
    ? "ghostty-vt.dll"
    : "libghostty-vt-shim.so";

test("all three engines load inside a --compile binary run from an empty directory", async () => {
  const out = compile(
    join(import.meta.dir, "compiled.ts"),
    join(outDir, "compiled"),
  );
  const cwd = await mkdtemp(join(tmpdir(), "werk-poc-m6-"));
  expect(await readdir(cwd)).toEqual([]);
  // The extraction lands in the temp directory, which is `TMPDIR` on POSIX
  // and `TEMP` on Windows; name all of them so it lands here.
  const env = {
    PATH: "/nonexistent",
    TMPDIR: cwd,
    TEMP: cwd,
    TMP: cwd,
    WP_FFI_RAW: "1",
  };
  const run = Bun.spawnSync([out], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const stdout = run.stdout.toString();
  console.log(stdout.trimEnd());
  expect(run.exitCode).toBe(0);
  // The bare binding cannot find its prebuild: inside bunfs on the platforms
  // it ships one for, and nowhere on win32, which it ships none for and
  // names before it looks …
  expect(stdout).toMatch(
    new RegExp(
      `^ffi-raw: (?:LibraryNotFoundError: .*${BUNFS_PATH.source}|UnsupportedPlatformError: No bundled libghostty-vt for win32-)`,
      "m",
    ),
  );
  // … and the adapter's extraction gets it loaded from the binary's own bytes.
  expect(stdout).toMatch(
    /^ghostty-wasm: text="ghostty-wasm 日" bold=true wide=2 vt=\d+B$/m,
  );
  expect(stdout).toMatch(
    new RegExp(
      `^ghostty-ffi: text="ghostty-ffi 日" bold=true wide=2 vt=\\d+B lib=.*werk-poc-libghostty-vt-0\\.6\\.3[\\\\/]${PLATFORM}[\\\\/]${LIB_NAME.replace(/\./g, "\\.")}$`,
      "m",
    ),
  );
  expect(stdout).toMatch(
    /^xterm-oracle: text="xterm-oracle 日" bold=true wide=2 vt=\d+B$/m,
  );
  // Extracted next to each other, as the shim's $ORIGIN needs.
  const extracted = await readdir(
    join(cwd, "werk-poc-libghostty-vt-0.6.3", PLATFORM),
  );
  expect(extracted.sort()).toEqual([...new Set([SHIM_NAME, LIB_NAME])].sort());

  // Size: an empty script, the wasm alone, and all three.
  const empty = join(outDir, "empty.ts");
  await writeFile(empty, "console.log('empty');\n");
  const emptyBin = compile(empty, join(outDir, "empty"));
  const wasmOnly = compile(
    join(pkg, "spikes", "m1", "embedded.ts"),
    join(outDir, "wasm-only"),
  );
  console.log(
    `binary sizes: empty ${mb(emptyBin)} MB, wasm only ${mb(wasmOnly)} MB, all three engines ${mb(out)} MB`,
  );
}, 120_000);
