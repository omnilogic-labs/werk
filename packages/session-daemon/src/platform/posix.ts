import { readdirSync, readFileSync } from "node:fs";
type Process = {
  pid: number;
  parent: number;
  group: number;
  session: number;
  foreground: number;
  state: string;
  command: string;
};
function processes(): Process[] {
  if (process.platform === "linux") {
    const result: Process[] = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
        result.push({
          pid: Number(entry),
          parent: Number(fields[1]),
          group: Number(fields[2]),
          session: Number(fields[3]),
          foreground: Number(fields[5]),
          state: fields[0]!,
          command: stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")),
        });
      } catch {}
    }
    return result;
  }
  // Darwin exposes job-control groups and foreground groups through ps.
  const command = Bun.spawnSync(
    ["ps", "-axo", "pid=,ppid=,pgid=,tpgid=,stat=,comm="],
    { stdout: "pipe", stderr: "ignore" },
  );
  if (command.exitCode !== 0)
    throw new Error("Cannot inspect process ownership");
  return new TextDecoder()
    .decode(command.stdout)
    .trim()
    .split("\n")
    .flatMap((line) => {
      const match = line
        .trim()
        .match(/^(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.+)$/);
      return match
        ? [
            {
              pid: Number(match[1]),
              parent: Number(match[2]),
              group: Number(match[3]),
              session: 0,
              foreground: Number(match[4]),
              state: match[5]!,
              command: match[6]!,
            },
          ]
        : [];
    });
}
function owned(root: number, all: Process[]) {
  const members = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of all)
      if (
        !members.has(p.pid) &&
        (members.has(p.parent) ||
          (process.platform === "linux" && p.session === root))
      ) {
        members.add(p.pid);
        changed = true;
      }
  }
  return all.filter((p) => members.has(p.pid) && !p.state.startsWith("Z"));
}
export function posixSummary(pid: number, executable: string) {
  const all = processes(),
    members = owned(pid, all);
  const foreground = all.find(
    (p) => p.group === all.find((p) => p.pid === pid)?.foreground,
  );
  return {
    foreground: foreground?.command ?? executable,
    children: members.filter((p) => p.pid !== pid).length,
  };
}
export function signalPosixTree(pid: number, signal: "SIGTERM" | "SIGKILL") {
  const all = processes(),
    members = owned(pid, all);
  const root = all.find((p) => p.pid === pid);
  const ourGroup = all.find((p) => p.pid === process.pid)?.group;
  let delivered = false;
  const send = (target: number) => {
    try {
      process.kill(target, signal);
      delivered = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  // Signal descendant groups before the shell; include escaped sessions whose
  // live ancestry still identifies them. Never signal the daemon's own group.
  for (const group of new Set(
    members
      .filter(
        (p) => p.pid !== pid && p.group !== root?.group && p.group !== ourGroup,
      )
      .map((p) => p.group),
  ))
    if (group > 0) send(-group);
  for (const p of members) if (p.pid !== pid) send(p.pid);
  if (root?.group === pid && root.group !== ourGroup) send(-pid);
  else send(pid);
  return { delivery: "process-tree-signal", signal, delivered };
}
