// Bun entry point for the ffi adapter: the dynamic import, the registry
// entry, and the one thing a compiled binary needs that `bun run` does not.
//
// `libghostty-vt` finds its prebuilt `.so` / `.dylib` next to its own
// `import.meta.url`, which inside `bun build --compile` is `/$bunfs/...`,
// a virtual path its `existsSync` check rejects (findings/m6.md). The
// binding's escape hatch is `setLibraryPath` / `setShimLibraryPath`, so
// this file embeds the prebuilds with `import ... with { type: "file" }`,
// and, when it finds itself running from bunfs, writes the pair for the
// host platform to a directory on disk and points the binding at it before
// the first dlopen. The shim resolves the main library by soname through
// `$ORIGIN` (`@loader_path` on darwin), so the two files have to land in
// the same directory under the names the shim was linked against.
//
// win32 needs the override in the interpreted path too, not only from
// bunfs: the package ships no Windows prebuild at all, so the binding's own
// platform detection has nothing to find either way. Its win32 artefact is
// built here rather than installed — vendor/ghostty-vt-ffi/build.md — and
// is one DLL with the shim compiled in, because Windows resolves a
// dependent DLL from the loading process's directory rather than from the
// directory of the DLL that depends on it, and has no `$ORIGIN`. The
// binding dlopens the library and the shim separately and takes a path for
// each, so both point at the same file.
//
// All six prebuild pairs are imported statically, so a compiled `wp`
// carries every platform's; that is what the size delta in findings/m6.md
// measures. A build per target would import one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerEngine } from "../registry.ts";
import { GhosttyFfiEngine, type LibGhosttyVt } from "./index.ts";

import darwinArm64Lib from "../../../node_modules/libghostty-vt/prebuilds/darwin-arm64/libghostty-vt.dylib" with { type: "file" };
import darwinArm64Shim from "../../../node_modules/libghostty-vt/prebuilds/darwin-arm64/libghostty-vt-shim.dylib" with { type: "file" };
import linuxX64GlibcLib from "../../../node_modules/libghostty-vt/prebuilds/linux-x64-glibc/libghostty-vt.so" with { type: "file" };
import linuxX64GlibcShim from "../../../node_modules/libghostty-vt/prebuilds/linux-x64-glibc/libghostty-vt-shim.so" with { type: "file" };
import linuxX64MuslLib from "../../../node_modules/libghostty-vt/prebuilds/linux-x64-musl/libghostty-vt.so" with { type: "file" };
import linuxX64MuslShim from "../../../node_modules/libghostty-vt/prebuilds/linux-x64-musl/libghostty-vt-shim.so" with { type: "file" };
import linuxArm64GlibcLib from "../../../node_modules/libghostty-vt/prebuilds/linux-arm64-glibc/libghostty-vt.so" with { type: "file" };
import linuxArm64GlibcShim from "../../../node_modules/libghostty-vt/prebuilds/linux-arm64-glibc/libghostty-vt-shim.so" with { type: "file" };
import linuxArm64MuslLib from "../../../node_modules/libghostty-vt/prebuilds/linux-arm64-musl/libghostty-vt.so" with { type: "file" };
import linuxArm64MuslShim from "../../../node_modules/libghostty-vt/prebuilds/linux-arm64-musl/libghostty-vt-shim.so" with { type: "file" };
import win32X64Lib from "../../../vendor/ghostty-vt-ffi/win32-x64/ghostty-vt.dll" with { type: "file" };

export const LIBGHOSTTY_VT_VERSION = "0.6.3";
export const FFI_GHOSTTY_COMMIT = "e88c6c099152dd6d2d7e517516e1f3c183c152f7";

/** The embedded pair per platform id (the binding's own naming), and the file names the shim's loader expects. */
const PREBUILDS: Record<
  string,
  { lib: string; shim: string; libName: string; shimName: string }
> = {
  "darwin-arm64": {
    lib: darwinArm64Lib,
    shim: darwinArm64Shim,
    libName: "libghostty-vt.dylib",
    shimName: "libghostty-vt-shim.dylib",
  },
  "linux-x64-glibc": {
    lib: linuxX64GlibcLib,
    shim: linuxX64GlibcShim,
    libName: "libghostty-vt.so.0",
    shimName: "libghostty-vt-shim.so",
  },
  "linux-x64-musl": {
    lib: linuxX64MuslLib,
    shim: linuxX64MuslShim,
    libName: "libghostty-vt.so.0",
    shimName: "libghostty-vt-shim.so",
  },
  "linux-arm64-glibc": {
    lib: linuxArm64GlibcLib,
    shim: linuxArm64GlibcShim,
    libName: "libghostty-vt.so.0",
    shimName: "libghostty-vt-shim.so",
  },
  "linux-arm64-musl": {
    lib: linuxArm64MuslLib,
    shim: linuxArm64MuslShim,
    libName: "libghostty-vt.so.0",
    shimName: "libghostty-vt-shim.so",
  },
  // One file under both names: the win32 DLL has the shim linked into it.
  "win32-x64": {
    lib: win32X64Lib,
    shim: win32X64Lib,
    libName: "ghostty-vt.dll",
    shimName: "ghostty-vt.dll",
  },
};

/** The binding's platform id for this process; mirrors its own detection. */
export function ffiPlatform(): string {
  if (process.platform === "darwin") return `darwin-${process.arch}`;
  if (process.platform !== "linux")
    return `${process.platform}-${process.arch}`;
  let libc = "glibc";
  try {
    const report = (
      process as unknown as {
        report?: { getReport(): { header?: { glibcVersionRuntime?: string } } };
      }
    ).report?.getReport();
    if (!report?.header?.glibcVersionRuntime) libc = "musl";
  } catch {
    // keep glibc
  }
  return `linux-${process.arch}-${libc}`;
}

export const embeddedInBinary = linuxX64GlibcLib.startsWith("/$bunfs/");

/**
 * Whether the binding has to be pointed at a library rather than left to
 * find its own. True from a compiled binary on every platform, and true on
 * win32 either way, because the package ships no win32 prebuild for the
 * binding's own resolver to find.
 */
export const needsPrebuildOverride =
  embeddedInBinary || process.platform === "win32";

/**
 * Where a compiled binary puts the extracted pair: a directory keyed by
 * the package version and platform under the temp dir, written once and
 * reused. Returns the paths handed to the binding.
 */
export async function extractPrebuilds(
  platform = ffiPlatform(),
  root = path.join(
    os.tmpdir(),
    `werk-poc-libghostty-vt-${LIBGHOSTTY_VT_VERSION}`,
  ),
): Promise<{ lib: string; shim: string; dir: string }> {
  const p = PREBUILDS[platform];
  if (!p)
    throw new Error(
      `no embedded libghostty-vt prebuild for ${platform}; the package ships ${Object.keys(PREBUILDS).join(", ")}`,
    );
  const dir = path.join(root, platform);
  const lib = path.join(dir, p.libName);
  const shim = path.join(dir, p.shimName);
  fs.mkdirSync(dir, { recursive: true });
  for (const [src, dst] of [
    [p.lib, lib],
    [p.shim, shim],
  ] as const) {
    const bytes = await Bun.file(src).arrayBuffer();
    if (fs.existsSync(dst) && fs.statSync(dst).size === bytes.byteLength)
      continue;
    const tmp = `${dst}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, new Uint8Array(bytes), { mode: 0o755 });
    fs.renameSync(tmp, dst);
  }
  return { lib, shim, dir };
}

export async function loadGhosttyFfiEngine(): Promise<GhosttyFfiEngine> {
  let lib: LibGhosttyVt;
  try {
    lib = await import("libghostty-vt");
  } catch (e) {
    throw new Error(`libghostty-vt failed to import: ${String(e)}`);
  }
  if (needsPrebuildOverride && !lib.isLoaded()) {
    const { lib: libPath, shim } = await extractPrebuilds();
    lib.setLibraryPath(libPath);
    lib.setShimLibraryPath(shim);
  }
  try {
    return GhosttyFfiEngine.load(lib);
  } catch (e) {
    throw new Error(
      `libghostty-vt could not open its library: ${(e as Error).message}`,
    );
  }
}

registerEngine("ghostty-ffi", loadGhosttyFfiEngine);
