import type { Size } from "@werk/session";

export const platformCapabilities = {
  pty: process.platform !== "win32",
  processGroups: process.platform !== "win32",
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
      "Native PTY hosting is unavailable in this Bun runtime on Windows",
    );
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
  return {
    pid: child.pid,
    exited: child.exited,
    write(bytes: Uint8Array) {
      child.terminal!.write(bytes);
    },
    resize(size: Size) {
      child.terminal!.resize(size.cols, size.rows);
    },
    terminate(intent: "interrupt" | "terminate" | "force") {
      const signal =
        intent === "interrupt"
          ? "SIGINT"
          : intent === "force"
            ? "SIGKILL"
            : "SIGTERM";
      try {
        process.kill(-child.pid, signal);
        return { delivery: "group-signal", signal };
      } catch {
        child.kill(signal);
        return { delivery: "signal", signal };
      }
    },
    close() {
      child.terminal?.close();
    },
  };
}
