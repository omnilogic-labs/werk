// Where the daemon lives on disk. The runtime directory —
// `$XDG_RUNTIME_DIR/werk-poc` when that is set (tmpfs, 0700, cleaned on
// logout), else whatever `platform.runtimeDir()` says — holds the socket,
// lock and log. The state directory — `$XDG_STATE_HOME/werk-poc`, else
// `platform.stateDir()` — holds session snapshots and has to outlive a
// logout, which is why it is not the runtime directory. Tests and the
// launcher can point both at explicit directories; `WP_STATE_DIR` overrides
// the state directory for a daemon started from a test.
//
// The environment overrides are read here rather than per platform, so a
// directory named in the environment is honoured wherever werk runs; what
// each platform picks when nothing names one is a row of the seam.

import fs from "node:fs";
import path from "node:path";
import { platform } from "../platform/index.ts";

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
  return platform.runtimeDir();
}

export function defaultStateDir(): string {
  const override = process.env.WP_STATE_DIR;
  if (override) return override;
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg) return path.join(xdg, "werk-poc");
  return platform.stateDir();
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
 * Creates the directory 0700 if needed and, where the filesystem can say,
 * refuses one owned by someone else — so a pre-created `/tmp/werk-poc-1000`
 * cannot hand our sessions to another local user.
 */
export function ensureRuntimeDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  platform.checkRuntimeDir(dir);
}
