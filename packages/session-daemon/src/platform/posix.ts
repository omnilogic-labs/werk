import { readdirSync, readFileSync, statSync } from "node:fs";
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

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Reads the line `ps -o lstart=` prints, `Tue Sep  8 05:26:49 2026`, including the double
 * space a single-digit day takes. The instant is read as UTC because `psStartedAt` asks ps
 * for UTC, so the answer does not depend on the host's zone or on a daylight-saving fold.
 */
export function parseProcessStartLine(line: string): number | null {
  const match = line
    .trim()
    .match(/^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]!);
  if (month < 0) return null;
  return Date.UTC(
    Number(match[6]),
    month,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
}

/**
 * When a pid started, as ps reports it, to the nearest second. Null where the pid is gone
 * or ps answers something the parser does not recognise.
 */
export function psStartedAt(pid: number): number | null {
  try {
    const command = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    });
    if (command.exitCode !== 0) return null;
    return parseProcessStartLine(new TextDecoder().decode(command.stdout));
  } catch {
    return null;
  }
}

/**
 * When a pid started, which is what catches a pid reused within one boot. Linux carries it
 * as the ctime of `/proc/<pid>`, and Darwin reports it through ps. Windows has neither, so
 * there the boot identifier and the ownership check are the whole guard.
 */
export function processStartedAt(pid: number): number | null {
  if (process.platform === "linux") {
    try {
      return statSync(`/proc/${pid}`).ctimeMs;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") return psStartedAt(pid);
  return null;
}
