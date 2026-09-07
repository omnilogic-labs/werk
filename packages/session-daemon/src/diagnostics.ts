import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { connectSessionClient } from "@werk/session";
import {
  openLocalTransport,
  validateRuntimeDirectory,
  resolveSessionDaemonPaths,
  type LocalEndpoint,
} from "./local.js";
import { acquireDaemonLock, probeLockMechanism } from "./platform/lock.js";
import {
  readDaemonRecord,
  recordedDaemonLiveness,
  type DaemonRecord,
} from "./supervise.js";

export async function readDaemonLog(stateDir: string) {
  const file = path.join(stateDir, "daemon.log");
  // Read a bounded tail even if an externally supplied logger has no rotation.
  const pieces: string[] = [];
  for (const name of [`${file}.1`, file]) {
    let handle;
    try {
      handle = await fs.open(name, "r");
      const size = (await handle.stat()).size;
      const start = Math.max(0, size - 256 * 1024);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const text = buffer.toString("utf8");
      pieces.push(start ? text.slice(text.indexOf("\n") + 1) : text);
    } catch {
    } finally {
      await handle?.close();
    }
  }
  const lines = pieces.join("").split("\n").filter(Boolean);
  return {
    tail: lines.slice(-20),
    lastError:
      [...lines].reverse().find((line) => / ERROR /.test(line)) ?? null,
  };
}
export async function inspectSessionDaemon(options: {
  runtimeDir: string;
  stateDir: string;
  doctor?: boolean;
}) {
  const paths = resolveSessionDaemonPaths(options);
  const checks: Record<string, unknown> = {};
  let daemon: unknown = null;
  let record: DaemonRecord | null = await readDaemonRecord(paths.record);
  const recorded: { pid?: number; bootId?: string } = record
    ? {
        pid: Number.isInteger(record.pid) ? record.pid : undefined,
        bootId: typeof record.bootId === "string" ? record.bootId : undefined,
      }
    : {};
  try {
    const stat = await fs.lstat(paths.runtimeDir);
    checks.runtime = {
      exists: true,
      directory: stat.isDirectory(),
      symlink: stat.isSymbolicLink(),
      owned: process.getuid ? stat.uid === process.getuid() : null,
      mode:
        process.platform === "win32" ? null : (stat.mode & 0o777).toString(8),
    };
    await validateRuntimeDirectory(paths.runtimeDir);
    const endpointStat = await fs.lstat(paths.endpoint);
    if (
      !endpointStat.isFile() ||
      endpointStat.isSymbolicLink() ||
      (process.getuid &&
        (endpointStat.uid !== process.getuid() ||
          (endpointStat.mode & 0o077) !== 0))
    )
      throw new Error(
        "Endpoint record must be a private file owned by the current user",
      );
    const endpoint = JSON.parse(
      await fs.readFile(paths.endpoint, "utf8"),
    ) as LocalEndpoint;
    const client = await connectSessionClient({
      transport: await openLocalTransport(endpoint, 500),
      credential: endpoint.kind === "tcp" ? endpoint.credential : undefined,
      requestTimeoutMs: 500,
    });
    try {
      daemon = await client.daemonInfo();
      checks.connection = "ok";
    } finally {
      await client.close();
    }
  } catch (error) {
    checks.connection = String(error);
  }
  if (options.doctor) {
    const liveness = recordedDaemonLiveness(record);
    checks.recordedDaemon = liveness.reason;
    checks.pidAlive = liveness.live;
    try {
      await fs.access(paths.stateDir, constants.W_OK);
      const stat = await fs.statfs(paths.stateDir);
      checks.state = { writable: true, freeBytes: stat.bavail * stat.bsize };
    } catch (error) {
      checks.state = { writable: false, error: String(error) };
    }
    // Never create a lock during diagnosis: report the file that exists, whichever of the
    // two paths the daemon settled on.
    const lockFile = await fs.access(paths.lock).then(
      () => paths.lock,
      () =>
        fs.access(paths.fallbackLock).then(
          () => paths.fallbackLock,
          () => null,
        ),
    );
    if (lockFile) {
      checks.lockFile = lockFile;
      try {
        const release = acquireDaemonLock(lockFile);
        release();
        checks.lock = "not-held";
        checks.lockMechanism = release.mechanism;
      } catch (error) {
        checks.lock = String(error).includes("Daemon already running")
          ? "held"
          : String(error);
      }
    } else checks.lock = "no-lock-file";
    checks.term = process.env.TERM ?? null;
    const infocmp = Bun.which("infocmp");
    checks.terminfo = infocmp
      ? Bun.spawnSync([infocmp, "xterm-256color"], {
          stdout: "ignore",
          stderr: "ignore",
        }).exitCode === 0
      : "infocmp unavailable";
  }
  return {
    version: "0.1.0",
    paths: { ...paths, log: path.join(paths.stateDir, "daemon.log") },
    lockMechanism: probeLockMechanism(),
    recorded,
    daemon,
    ...(options.doctor
      ? { checks, log: await readDaemonLog(paths.stateDir) }
      : { connection: checks.connection }),
  };
}
