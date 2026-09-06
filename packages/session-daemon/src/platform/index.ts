import { readdirSync, readFileSync } from "node:fs";
import type { Size } from "@werk/session";

export const platformCapabilities = {
  pty: process.platform !== "win32",
  processGroups: process.platform !== "win32",
  processTreeSummary: process.platform === "linux",
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
  let inspectedAt = 0;
  let summary = { foreground: argv[0], children: 0 };
  function inspect() {
    if (process.platform !== "linux" || Date.now() - inspectedAt < 1000)
      return summary;
    inspectedAt = Date.now();
    try {
      const root = readFileSync(`/proc/${child.pid}/stat`, "utf8")
        .split(") ")
        .pop()!
        .split(" ");
      const foregroundGroup = Number(root[5]);
      let children = 0,
        foreground = argv[0];
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
          const fields = stat.split(") ").pop()!.split(" ");
          if (Number(fields[3]) !== child.pid) continue;
          if (Number(entry) !== child.pid && fields[0] !== "Z") children++;
          if (Number(fields[2]) === foregroundGroup)
            foreground = stat.slice(
              stat.indexOf("(") + 1,
              stat.lastIndexOf(")"),
            );
        } catch {}
      }
      summary = { foreground, children };
    } catch {}
    return summary;
  }
  return {
    summary: inspect,
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
