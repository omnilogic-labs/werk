import { openSync, closeSync } from "node:fs";
import { dlopen, FFIType } from "bun:ffi";
import { acquireWindowsLock } from "./win32.js";
/** Kernel ownership survives stale socket paths and ends automatically on process death. */
export function acquireDaemonLock(file: string): () => void {
  if (process.platform === "win32") return acquireWindowsLock(file);
  const library = dlopen(
    process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6",
    { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } },
  );
  let fd: number;
  try {
    fd = openSync(file, "a", 0o600);
  } catch (error) {
    library.close();
    throw error;
  }
  if (library.symbols.flock(fd, 6) !== 0) {
    closeSync(fd);
    library.close();
    throw new Error("Daemon already running");
  }
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    closeSync(fd);
    library.close();
  };
}
