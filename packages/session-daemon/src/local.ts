import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readDaemonLog } from "./diagnostics.js";
import {
  processStartedAt,
  readDaemonRecord,
  recordedDaemonLiveness,
} from "./supervise.js";
import { notPrivateToOwner, socketPathTooLong } from "./platform/index.js";
import { parseLogLevel, type LogLevel } from "./log.js";
import { daemonEnvironment } from "./environment.js";
import { connectSessionClient } from "@werk/session";
import type { Transport } from "@werk/session/protocol";
export type LocalEndpoint =
  | { kind: "unix"; path: string }
  | { kind: "tcp"; host: "127.0.0.1"; port: number; credential: string };
export function defaultSessionRuntimeDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  uid: number = process.getuid?.() ?? 0,
): string {
  if (env.WERK_RUNTIME_DIR) return env.WERK_RUNTIME_DIR;
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    if (!local)
      throw new Error(
        "LOCALAPPDATA is required for the default runtime directory",
      );
    return path.win32.join(local, "werk", "run");
  }
  return `/tmp/werk-${uid}`;
}
class UnsafeLocalPathError extends Error {}
function validateSocketLength(socket: string) {
  if (socketPathTooLong(socket))
    throw new UnsafeLocalPathError(
      "Unix socket path exceeds portable length limit (103 bytes)",
    );
}
export async function validateRuntimeDirectory(
  directory: string,
  allowMissing = false,
) {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT")
      return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new UnsafeLocalPathError(
      "Runtime path must be a directory, not a symbolic link",
    );
  if (process.platform !== "win32") {
    if (stat.uid !== process.getuid!())
      throw new UnsafeLocalPathError(
        "Runtime directory belongs to another user",
      );
    if ((stat.mode & 0o777) !== 0o700)
      throw new UnsafeLocalPathError("Runtime directory must have mode 0700");
  }
}
export function resolveSessionDaemonPaths(options: {
  runtimeDir: string;
  stateDir: string;
}) {
  return {
    runtimeDir: path.resolve(options.runtimeDir),
    stateDir: path.resolve(options.stateDir),
    socket: path.resolve(options.runtimeDir, "daemon.sock"),
    endpoint: path.resolve(options.runtimeDir, "endpoint.json"),
    // The state directory is what checkpoints and identity already share, and no cleaner
    // ages it, so the lock lives there and the guarantee is one daemon per state directory.
    lock: path.resolve(options.stateDir, "daemon.lock"),
    // Used only where the state directory cannot hold a lock; see `serveSessionDaemon`.
    fallbackLock: path.resolve(options.runtimeDir, "daemon.lock"),
    record: path.resolve(options.stateDir, "daemon.json"),
  };
}
export function socketTransport(socket: net.Socket): Transport {
  let ended = false;
  const readable = new ReadableStream<Uint8Array>(
    {
      start(c) {
        socket.on("data", (data) => {
          if (!ended) {
            c.enqueue(
              new Uint8Array(
                typeof data === "string" ? Buffer.from(data) : data,
              ),
            );
            if ((c.desiredSize ?? 0) <= 0) socket.pause();
          }
        });
        socket.on("end", () => {
          if (!ended) {
            ended = true;
            c.close();
          }
        });
        socket.on("error", (e) => {
          if (!ended) {
            ended = true;
            c.error(e);
          }
        });
        socket.on("close", () => {
          if (!ended) {
            ended = true;
            c.close();
          }
        });
      },
      pull() {
        socket.resume();
      },
      cancel() {
        ended = true;
        socket.destroy();
      },
    },
    { highWaterMark: 256 * 1024, size: (chunk) => chunk?.byteLength ?? 0 },
  );
  return {
    readable,
    writable: new WritableStream({
      write(data) {
        return new Promise<void>((resolve, reject) =>
          socket.write(data, (e) => (e ? reject(e) : resolve())),
        );
      },
      close() {
        socket.end();
      },
      abort() {
        socket.destroy();
      },
    }),
    close() {
      socket.destroy();
    },
  };
}
export async function openLocalTransport(
  endpoint: LocalEndpoint,
  timeoutMs = 5000,
): Promise<Transport> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Invalid connection deadline");
  if (
    !endpoint ||
    (endpoint.kind !== "unix" && endpoint.kind !== "tcp") ||
    (endpoint.kind === "unix" && typeof endpoint.path !== "string") ||
    (endpoint.kind === "tcp" &&
      (endpoint.host !== "127.0.0.1" ||
        !Number.isInteger(endpoint.port) ||
        endpoint.port < 1 ||
        endpoint.port > 65535 ||
        typeof endpoint.credential !== "string"))
  )
    throw new Error("Invalid local endpoint");
  if (endpoint.kind === "unix") {
    validateSocketLength(endpoint.path);
    await validateRuntimeDirectory(path.dirname(endpoint.path));
    const stat = await fs.lstat(endpoint.path);
    if (!stat.isSocket() || stat.isSymbolicLink())
      throw new UnsafeLocalPathError("Local endpoint must be a Unix socket");
    if (notPrivateToOwner(stat))
      throw new UnsafeLocalPathError(
        "Unix socket must be owned by the current user with private permissions",
      );
  }
  const socket = net.createConnection(
    endpoint.kind === "unix"
      ? { path: endpoint.path }
      : { host: endpoint.host, port: endpoint.port },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Local connection timed out"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  return socketTransport(socket);
}
export async function ensureSessionDaemon(options: {
  runtimeDir: string;
  stateDir: string;
  daemonCommand: string[];
  startupTimeoutMs?: number;
  logLevel?: LogLevel;
}) {
  if (options.logLevel) parseLogLevel(options.logLevel);
  const paths = resolveSessionDaemonPaths(options);
  validateSocketLength(paths.socket);
  await validateRuntimeDirectory(paths.runtimeDir, true);
  const startupTimeoutMs = options.startupTimeoutMs ?? 10000;
  if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0)
    throw new Error("Invalid startup deadline");
  const deadline = Date.now() + startupTimeoutMs;
  async function probe() {
    await validateRuntimeDirectory(paths.runtimeDir);
    const stat = await fs.lstat(paths.endpoint);
    if (!stat.isFile() || stat.isSymbolicLink() || notPrivateToOwner(stat))
      throw new UnsafeLocalPathError(
        "Endpoint record must be a private file owned by the current user",
      );
    const endpoint = JSON.parse(
      await fs.readFile(paths.endpoint, "utf8"),
    ) as LocalEndpoint;
    const client = await connectSessionClient({
      transport: await openLocalTransport(
        endpoint,
        Math.max(1, Math.min(500, deadline - Date.now())),
      ),
      credential: endpoint.kind === "tcp" ? endpoint.credential : undefined,
      requestTimeoutMs: Math.max(1, Math.min(500, deadline - Date.now())),
    });
    try {
      return { endpoint, version: (await client.daemonInfo()).version };
    } finally {
      await client.close();
    }
  }
  try {
    return await probe();
  } catch (error) {
    if (error instanceof UnsafeLocalPathError) throw error;
  }
  // A daemon whose endpoint has been removed is still running its sessions. Spawning a
  // second one beside it gives two daemons rewriting the same checkpoints, so ask the
  // recorded daemon to rebuild its endpoint and wait for it rather than starting a rival.
  const record = await readDaemonRecord(paths.record);
  if (record && recordedDaemonLiveness(record).live) {
    // SIGUSR1 terminates a process that does not handle it, so it goes only where the
    // pid's own start time confirms the record. Elsewhere the daemon's periodic check
    // does the same work a few seconds later, inside the startup deadline.
    if (process.platform !== "win32" && processStartedAt(record.pid) !== null) {
      try {
        process.kill(record.pid, "SIGUSR1");
      } catch {}
    }
    while (Date.now() < deadline) {
      try {
        return await probe();
      } catch (error) {
        if (error instanceof UnsafeLocalPathError) throw error;
      }
      await Bun.sleep(30);
    }
    const { lastError } = await readDaemonLog(paths.stateDir);
    throw new Error(
      `Daemon ${record.pid} is alive but its endpoint is missing${lastError ? `: ${lastError}` : ""}`,
    );
  }
  if (!options.daemonCommand.length)
    throw new Error("daemonCommand must be explicit");
  const child = Bun.spawn(
    [
      ...options.daemonCommand,
      "--runtime-dir",
      paths.runtimeDir,
      "--state-dir",
      paths.stateDir,
      ...(options.logLevel ? ["--log-level", options.logLevel] : []),
    ],
    {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: daemonEnvironment(),
      cwd: process.platform === "win32" ? os.homedir() : "/",
    },
  );
  child.unref();
  while (Date.now() < deadline) {
    try {
      return await probe();
    } catch (error) {
      if (error instanceof UnsafeLocalPathError) throw error;
    }
    await Bun.sleep(30);
  }
  try {
    child.kill();
  } catch {}
  const { lastError } = await readDaemonLog(paths.stateDir);
  throw new Error(
    `Daemon did not become ready before startup deadline${lastError ? `: ${lastError}` : ""}`,
  );
}
