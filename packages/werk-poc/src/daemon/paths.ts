// Where the daemon lives on disk. The runtime directory —
// `$XDG_RUNTIME_DIR/werk-poc` when that is set (tmpfs, 0700, cleaned on
// logout), else `/tmp/werk-poc-$UID` — holds the socket, lock and log. The
// state directory — `$XDG_STATE_HOME/werk-poc`, else
// `~/.local/state/werk-poc` — holds session snapshots and has to outlive a
// logout, which is why it is not the runtime directory. Tests and the
// launcher can point both at explicit directories; `WP_STATE_DIR` overrides
// the state directory for a daemon started from a test.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DaemonPaths {
  dir: string;
  socket: string;
  lock: string;
  log: string;
  /** Where snapshots live; persistent, unlike `dir`. */
  state: string;
}

export function defaultRuntimeDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return path.join(xdg, "werk-poc");
  return path.join(os.tmpdir(), `werk-poc-${process.getuid?.() ?? "0"}`);
}

export function defaultStateDir(): string {
  const override = process.env.WP_STATE_DIR;
  if (override) return override;
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg) return path.join(xdg, "werk-poc");
  return path.join(os.homedir(), ".local", "state", "werk-poc");
}

export function daemonPaths(
  dir: string = defaultRuntimeDir(),
  state: string = defaultStateDir(),
): DaemonPaths {
  return {
    dir,
    socket: path.join(dir, "wp.sock"),
    lock: path.join(dir, "wp.lock"),
    log: path.join(dir, "wp.log"),
    state,
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
