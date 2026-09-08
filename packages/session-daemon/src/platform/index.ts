import fs from "node:fs/promises";
import type { Size } from "@werk/session";
import { posixSummary, signalPosixTree } from "./posix.js";
import { createWindowsTree, privateWindowsDirectory } from "./win32.js";

export { privateWindowsDirectory } from "./win32.js";
export { socketPathTooLong, notPrivateToOwner } from "./rules.js";
export { processStartedAt } from "./posix.js";

/**
 * Restrict a directory to the current user. Windows has no mode to set, so the
 * per-user ACL does the work the POSIX bits do everywhere else.
 */
export async function makePrivate(directory: string) {
  if (process.platform === "win32") privateWindowsDirectory(directory);
  else await fs.chmod(directory, 0o700);
}

export const platformCapabilities = {
  pty: process.platform !== "win32" || process.arch === "x64",
  processGroups: process.platform !== "win32",
  processTreeSummary:
    process.platform === "linux" || process.platform === "darwin",
};
export function spawnPty(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  size: Size,
  output: (bytes: Uint8Array) => void,
) {
  if (!platformCapabilities.pty)
    throw new Error(
      "Windows ARM64 PTY ownership is unsupported: Bun FFI requires x64",
    );
  const tree = process.platform === "win32" ? createWindowsTree() : undefined;
  let child: ReturnType<typeof Bun.spawn>;
  try {
    // Inline terminal creation is supported by Bun 1.3.14 on Windows (ConPTY).
    child = Bun.spawn(argv, {
      cwd,
      env,
      terminal: {
        cols: size.cols,
        rows: size.rows,
        data(_terminal, bytes) {
          output(new Uint8Array(bytes));
        },
      },
    });
    try {
      tree?.adopt(child.pid);
    } catch (error) {
      child.kill();
      child.terminal?.close();
      throw error;
    }
  } catch (error) {
    tree?.close();
    throw error;
  }
  let inspectedAt = 0;
  let summary = { foreground: argv[0], children: 0 };
  return {
    summary() {
      if (
        platformCapabilities.processTreeSummary &&
        Date.now() - inspectedAt >= 1000
      ) {
        inspectedAt = Date.now();
        try {
          summary = posixSummary(child.pid, argv[0]!);
        } catch {}
      }
      return summary;
    },
    pid: child.pid,
    exited: child.exited,
    write(bytes: Uint8Array) {
      child.terminal!.write(bytes);
    },
    resize(size: Size) {
      child.terminal!.resize(size.cols, size.rows);
    },
    terminate(intent: "interrupt" | "terminate" | "force") {
      if (intent === "interrupt") {
        child.terminal!.write(new Uint8Array([3]));
        return { delivery: "pty-control-c" };
      }
      if (tree) return tree.terminate();
      return signalPosixTree(
        child.pid,
        intent === "force" ? "SIGKILL" : "SIGTERM",
      );
    },
    close() {
      tree?.close();
      child.terminal?.close();
    },
  };
}
