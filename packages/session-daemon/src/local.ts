import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { connectSessionClient } from "@werk/session";
import type { Transport } from "@werk/session/protocol";
export type LocalEndpoint =
  | { kind: "unix"; path: string }
  | { kind: "tcp"; host: "127.0.0.1"; port: number; credential: string };
export function resolveSessionDaemonPaths(options: {
  runtimeDir: string;
  stateDir: string;
}) {
  return {
    runtimeDir: path.resolve(options.runtimeDir),
    stateDir: path.resolve(options.stateDir),
    socket: path.resolve(options.runtimeDir, "daemon.sock"),
    endpoint: path.resolve(options.runtimeDir, "endpoint.json"),
    lock: path.resolve(options.runtimeDir, "daemon.lock"),
  };
}
export function socketTransport(socket: net.Socket): Transport {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  const readable = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
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
  if (
    !endpoint ||
    (endpoint.kind !== "unix" && endpoint.kind !== "tcp") ||
    (endpoint.kind === "unix" && typeof endpoint.path !== "string") ||
    (endpoint.kind === "tcp" &&
      (endpoint.host !== "127.0.0.1" || !Number.isInteger(endpoint.port)))
  )
    throw new Error("Invalid local endpoint");
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
}) {
  const paths = resolveSessionDaemonPaths(options);
  async function probe() {
    const endpoint = JSON.parse(
      await fs.readFile(paths.endpoint, "utf8"),
    ) as LocalEndpoint;
    const client = await connectSessionClient({
      transport: await openLocalTransport(endpoint, 500),
      credential: endpoint.kind === "tcp" ? endpoint.credential : undefined,
      requestTimeoutMs: 500,
    });
    try {
      return { endpoint, version: (await client.daemonInfo()).version };
    } finally {
      await client.close();
    }
  }
  try {
    return await probe();
  } catch {}
  if (!options.daemonCommand.length)
    throw new Error("daemonCommand must be explicit");
  const child = Bun.spawn(
    [
      ...options.daemonCommand,
      "--runtime-dir",
      paths.runtimeDir,
      "--state-dir",
      paths.stateDir,
    ],
    { detached: true, stdio: ["ignore", "ignore", "ignore"] },
  );
  child.unref();
  const deadline = Date.now() + (options.startupTimeoutMs ?? 10000);
  while (Date.now() < deadline) {
    try {
      return await probe();
    } catch {}
    await Bun.sleep(30);
  }
  try {
    child.kill();
  } catch {}
  throw new Error("Daemon did not become ready before startup deadline");
}
