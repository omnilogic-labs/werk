import fs from "node:fs/promises";
import type { Size } from "@werk/session";
import { posixSummary, signalPosixTree } from "./posix.js";

export { socketPathTooLong, notPrivateToOwner } from "./rules.js";
export { processStartedAt } from "./posix.js";

/** Restrict a directory to the current user. */
export async function makePrivate(directory: string) {
  await fs.chmod(directory, 0o700);
}

/**
 * The daemon runs on Linux and macOS. On Windows werk runs only as a client, so
 * nothing there may start one, and this says so before anything is created.
 */
export function refuseDaemonPlatform(
  platform: NodeJS.Platform = process.platform,
) {
  if (platform === "win32")
    throw new Error(
      "The werk session daemon runs on Linux and macOS. On Windows werk runs only as a client.",
    );
}

export const platformCapabilities = {
  pty: true,
  processGroups: true,
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
  const child = Bun.spawn(argv, {
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
      return signalPosixTree(
        child.pid,
        intent === "force" ? "SIGKILL" : "SIGTERM",
      );
    },
    close() {
      child.terminal?.close();
    },
  };
}
