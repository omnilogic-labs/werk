/**
 * Getting a client, with and without permission to start a daemon.
 *
 * Every command before this took the same route: `ensureSessionDaemon`, which
 * starts a detached daemon when none answers. That is right for `werk list` and
 * wrong for tab completion — pressing TAB must never launch a background
 * process, and it must never block the shell waiting for one to come up. So the
 * two intents are separate functions rather than a flag, and the completion path
 * can only reach the one that cannot spawn.
 */
import fs from "node:fs/promises";
import { connectSessionClient, type SessionClient } from "@werk/session";
import {
  parseLogLevel,
  ensureSessionDaemon,
  openLocalTransport,
  resolveSessionDaemonPaths,
  type LocalEndpoint,
} from "@werk/session-daemon";

declare const WERK_COMPILED: boolean;

export interface DaemonPaths {
  runtimeDir: string;
  stateDir: string;
  logLevel?: string;
  /** Absolute path of the entry module; see {@link daemonCommand}. */
  entry: string;
}

/**
 * How this binary re-invokes itself as a daemon. Compiled, `process.execPath` is
 * werk itself and the entry path is a `/$bunfs/` virtual path that no child could
 * open; uncompiled, `execPath` is `bun` and the entry has to be named explicitly.
 * `entry` is therefore supplied by `main.ts`, where `import.meta.url` is the real
 * entry module rather than whichever file asked.
 */
export function daemonCommand(entry: string): string[] {
  const compiled = typeof WERK_COMPILED !== "undefined" && WERK_COMPILED;
  return compiled
    ? [process.execPath, "daemon", "serve"]
    : [process.execPath, entry, "daemon", "serve"];
}

/** Connect, starting a daemon if none is running. */
export async function connectDaemon(
  paths: DaemonPaths,
): Promise<SessionClient> {
  const daemon = await ensureSessionDaemon({
    runtimeDir: paths.runtimeDir,
    stateDir: paths.stateDir,
    daemonCommand: daemonCommand(paths.entry),
    logLevel: parseLogLevel(paths.logLevel),
  });
  return connectSessionClient({
    transport: await openLocalTransport(daemon.endpoint),
    credential:
      daemon.endpoint.kind === "tcp" ? daemon.endpoint.credential : undefined,
    requestTimeoutMs: 5000,
  });
}

/**
 * Connect only to a daemon that is already listening, within `timeoutMs`, and
 * return undefined for every reason it might not be there. Nothing here throws:
 * a completion that raised would put an error message where the shell expects
 * candidates.
 *
 * The endpoint comes back with the client because reaching a daemon is the only
 * proof that the record on disk describes a daemon at all, and `werk daemon
 * endpoint` wants to print the thing it just connected through rather than
 * whatever a stale file said.
 */
export async function connectExistingDaemon(
  paths: DaemonPaths,
  timeoutMs = 150,
): Promise<{ client: SessionClient; endpoint: LocalEndpoint } | undefined> {
  try {
    const resolved = resolveSessionDaemonPaths(paths);
    const endpoint = JSON.parse(
      await fs.readFile(resolved.endpoint, "utf8"),
    ) as LocalEndpoint;
    const client = await connectSessionClient({
      transport: await openLocalTransport(endpoint, timeoutMs),
      credential: endpoint.kind === "tcp" ? endpoint.credential : undefined,
      requestTimeoutMs: timeoutMs,
    });
    return { client, endpoint };
  } catch {
    return undefined;
  }
}
