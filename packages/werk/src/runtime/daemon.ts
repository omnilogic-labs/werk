/**
 * Getting a client, with and without permission to start a daemon, and on this
 * machine or another one.
 *
 * Every command before this took the same route: `ensureSessionDaemon`, which
 * starts a detached daemon when none answers. That is right for `werk list` and
 * wrong for tab completion — pressing TAB must never launch a background
 * process, and it must never block the shell waiting for one to come up. So the
 * two intents are separate functions rather than a flag, and the completion path
 * can only reach the one that cannot spawn.
 *
 * ## What a remote daemon costs this file
 *
 * One line. `connectDaemon` gets an endpoint and then dials it, and the only
 * difference between a daemon here and a daemon on another machine is where the
 * endpoint comes from: `ensureSessionDaemon` for a local one, a `HostSession`
 * for a remote one. Everything after that — `openLocalTransport`, the
 * credential, `connectSessionClient` — is the same code on the same shapes,
 * because a forward's local end is an ordinary local endpoint.
 *
 * The kind is never assumed. `HostSession.endpoint()` hands back whatever the
 * far side reported with the address rewritten to this end of the forward, so a
 * daemon on Windows reporting loopback TCP with a credential arrives here as a
 * `tcp` endpoint carrying that credential and is dialled without a branch. What
 * that would take is a change to the shape of the forward, in `host/forward.ts`,
 * and nothing here.
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
import type { HostSession } from "../host/session.js";
import { compiledWerk } from "./version.js";

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
  return compiledWerk()
    ? [process.execPath, "daemon", "serve"]
    : [process.execPath, entry, "daemon", "serve"];
}

/**
 * A client, and whatever has to be let go of when the caller is done with it.
 *
 * A remote connection is holding an `ssh -N` open, and that has to die with the
 * command that made it — a leaked forward is a much worse failure than a slow
 * `werk list`. So callers close the connection rather than the client, and the
 * local case simply has nothing else to close.
 */
export interface DaemonConnection {
  readonly client: SessionClient;
  /** The machine, when the daemon is on one. */
  readonly host?: HostSession;
  close(): Promise<void>;
}

/**
 * Connect, starting a daemon if none is running.
 *
 * The session is passed in rather than opened here, because an invocation
 * reaches its machine for more than the daemon: `create` also makes a workspace
 * on it, and a second `HostSession` would mean a second probe, a second
 * install check and a second forward. `host/place.ts` opens the one, and this
 * dials through it.
 *
 * A connection that fails lets go of the session on its way out. The caller
 * that supplied it usually closes it too, and closing twice is a no-op — a
 * leaked `ssh -N` is a far worse failure than a redundant close.
 */
export async function connectDaemon(
  paths: DaemonPaths,
  host?: HostSession,
): Promise<DaemonConnection> {
  try {
    const endpoint: LocalEndpoint = host
      ? await host.endpoint()
      : (
          await ensureSessionDaemon({
            runtimeDir: paths.runtimeDir,
            stateDir: paths.stateDir,
            daemonCommand: daemonCommand(paths.entry),
            logLevel: parseLogLevel(paths.logLevel),
          })
        ).endpoint;
    const client = await connectSessionClient({
      transport: await openLocalTransport(endpoint),
      credential: endpoint.kind === "tcp" ? endpoint.credential : undefined,
      requestTimeoutMs: 5000,
    });
    return {
      client,
      ...(host ? { host } : {}),
      async close() {
        try {
          await client.close();
        } finally {
          await host?.close();
        }
      },
    };
  } catch (error) {
    await host?.close().catch(() => {});
    throw error;
  }
}

/**
 * Connect only to a daemon that is already listening, within `timeoutMs`, and
 * return undefined for every reason it might not be there. Nothing here throws:
 * a completion that raised would put an error message where the shell expects
 * candidates.
 *
 * **Local only, and it stays that way.** This is the function tab completion
 * reaches, and the same rule that forbids it from spawning a daemon forbids it
 * from opening an ssh connection: pressing TAB must not start a process, and it
 * must not put a network round trip between a keystroke and a candidate list.
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
