// Builds spikes/m6/compiled.ts with `bun build --compile` and runs it from
// an empty directory with no PATH: the three engines have to come out of
// the binary alone. Also records the binary's size against a script that
// embeds nothing, and the wasm-only binary from M1.

import { expect, test } from "bun:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkg = join(import.meta.dir, "..", "..");
const outDir = join(pkg, "dist", "m6");

function compile(entry: string, out: string): void {
  const build = Bun.spawnSync(
    ["bun", "build", "--compile", entry, "--outfile", out],
    { cwd: pkg, stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
}

const mb = (p: string) => (Bun.file(p).size / 1048576).toFixed(1);

// The adapter extracts the prebuild pair for the host platform under names
// the shim was linked against: a versioned soname next to a shim on Linux,
// plain .dylib files on macOS.
const DARWIN = process.platform === "darwin";
const PLATFORM = DARWIN ? `darwin-${process.arch}` : "linux-x64-glibc";
const LIB_NAME = DARWIN ? "libghostty-vt.dylib" : "libghostty-vt.so.0";
const SHIM_NAME = DARWIN ? "libghostty-vt-shim.dylib" : "libghostty-vt-shim.so";

test("all three engines load inside a --compile binary run from an empty directory", async () => {
  const out = join(outDir, "compiled");
  compile(join(import.meta.dir, "compiled.ts"), out);
  const cwd = await mkdtemp(join(tmpdir(), "werk-poc-m6-"));
  expect(await readdir(cwd)).toEqual([]);
  const env = { PATH: "/nonexistent", TMPDIR: cwd, WP_FFI_RAW: "1" };
  const run = Bun.spawnSync([out], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const stdout = run.stdout.toString();
  console.log(stdout.trimEnd());
  expect(run.exitCode).toBe(0);
  // The bare binding cannot find its prebuild inside bunfs …
  expect(stdout).toMatch(/^ffi-raw: LibraryNotFoundError: .*\/\$bunfs\//m);
  // … and the adapter's extraction gets it loaded from the binary's own bytes.
  expect(stdout).toMatch(
    /^ghostty-wasm: text="ghostty-wasm 日" bold=true wide=2 vt=\d+B$/m,
  );
  expect(stdout).toMatch(
    new RegExp(
      `^ghostty-ffi: text="ghostty-ffi 日" bold=true wide=2 vt=\\d+B lib=.*werk-poc-libghostty-vt-0\\.6\\.3/${PLATFORM}/${LIB_NAME.replace(/\./g, "\\.")}$`,
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
  expect(extracted.sort()).toEqual([SHIM_NAME, LIB_NAME].sort());

  // Size: an empty script, the wasm alone, and all three.
  const empty = join(outDir, "empty.ts");
  await writeFile(empty, "console.log('empty');\n");
  compile(empty, join(outDir, "empty"));
  compile(join(pkg, "spikes", "m1", "embedded.ts"), join(outDir, "wasm-only"));
  console.log(
    `binary sizes: empty ${mb(join(outDir, "empty"))} MB, wasm only ${mb(join(outDir, "wasm-only"))} MB, all three engines ${mb(out)} MB`,
  );
}, 120_000);
