// Where the daemon lives on disk. `$XDG_RUNTIME_DIR/werk-poc` when that is
// set (tmpfs, 0700, cleaned on logout), else `/tmp/werk-poc-$UID`. Tests
// and the launcher can point both ends at an explicit directory instead.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DaemonPaths {
  dir: string;
  socket: string;
  lock: string;
  log: string;
}

export function defaultRuntimeDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return path.join(xdg, "werk-poc");
  return path.join(os.tmpdir(), `werk-poc-${process.getuid?.() ?? "0"}`);
}

export function daemonPaths(dir: string = defaultRuntimeDir()): DaemonPaths {
  return {
    dir,
    socket: path.join(dir, "wp.sock"),
    lock: path.join(dir, "wp.lock"),
    log: path.join(dir, "wp.log"),
  };
}

/**
 * Creates the directory 0700 if needed and refuses one owned by someone
 * else, so a pre-created `/tmp/werk-poc-1000` cannot hand our sessions to
 * another local user.
 */
export function ensureRuntimeDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.statSync(dir);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(
      `${dir} is owned by uid ${st.uid}, not ${uid}; refusing to use it`,
    );
  }
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}
