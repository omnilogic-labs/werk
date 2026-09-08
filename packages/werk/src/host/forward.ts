/**
 * A socket here that is the daemon's socket there.
 *
 * `ssh -L <local>:<remote>` is the whole mechanism. What this file adds is
 * where the local socket goes, who is allowed to make one, how a forward that
 * did not work is told apart from one that did, and when it dies.
 *
 * ## Where the socket goes
 *
 * `<runtimeDir>/h/<key>.sock`, where the key is the first eight hex digits of
 * `sha256(sshHost + "\0" + remoteSocket)`. The hash is not for secrecy: it is
 * for length. A Unix socket path is capped at 103 usable bytes on the
 * platforms werk cares about, an ssh destination can be `deploy@build-07.eu-
 * west-1.internal.example.com` and a remote socket path can be anything, so
 * naming the file after either would put the cap within reach of an ordinary
 * setup. Sixteen bytes of `/h/xxxxxxxx.sock` on top of the runtime directory is
 * about thirty-one all told, and the length is asserted here rather than
 * discovered at `bind`, because a failure at `bind` says `EINVAL` and names
 * nothing.
 *
 * The `h` directory is created 0700 because `openLocalTransport` refuses to
 * dial through a parent that is anything else. The forwarded socket itself
 * needs no help: ssh creates it 0600 owned by the caller even under `umask
 * 000`, so it passes the ownership and mode checks with nothing done to it.
 *
 * ## Telling a working forward from a broken one
 *
 * `ExitOnForwardFailure=yes` catches a local bind that failed. It does not
 * catch the far end being absent, because ssh contacts the far end only when a
 * client arrives: the forward comes up, `connect()` succeeds, and the stream
 * ends immediately. That is the commonest remote fault, and left alone it
 * reaches a person as "connection closed", which sends them to look at the
 * wrong machine. So the forward is not considered up until a client has said
 * hello through it, and a connection that opens and closes without one is
 * reported as `HOST_DAEMON_MISSING`, naming the socket on the far side.
 *
 * ## When it dies
 *
 * The invocation that made a forward kills it when it finishes. A leaked `ssh
 * -N` is a much worse failure than a slow `werk list`, and a forward that
 * outlives its maker needs supervising — which is the daemon's job, and the
 * daemon is on the wrong machine for it. The child is deliberately left in this
 * process's group, so a terminal that interrupts werk interrupts the forward
 * too, and `process.on("exit")` catches the ordinary paths. Nothing here
 * installs a SIGINT handler: commands install their own, and a second listener
 * would stop the signal doing what the first one expects.
 *
 * Within one process a forward is shared, keyed by the local socket path.
 * Across processes it is shared by being found: a second werk connects to the
 * socket, gets an answer, and uses the forward the first one is holding without
 * owning it.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { connectSessionClient } from "@werk/session";
import {
  acquireDaemonLock,
  openLocalTransport,
  type LocalEndpoint,
} from "@werk/session-daemon";
import {
  classifySshFailure,
  sshForwardArgv,
  type RemoteRunner,
} from "./ssh.js";
import { HostError } from "./types.js";

/** The portable cap on a Unix socket path, as `local.ts` enforces it. */
export const SOCKET_PATH_LIMIT = 103;

/** How long a forward has to come up and answer before it is a failure. */
export const FORWARD_TIMEOUT_MS = 10_000;
/** How long a forward that might already be there is given to answer. */
export const REUSE_TIMEOUT_MS = 200;
/** How long to wait for whoever else is making the same forward. */
export const LOCK_TIMEOUT_MS = 5_000;

export function forwardKey(sshHost: string, remoteSocket: string): string {
  return createHash("sha256")
    .update(`${sshHost}\0${remoteSocket}`)
    .digest("hex")
    .slice(0, 8);
}

export function forwardSocketPath(runtimeDir: string, key: string): string {
  return path.join(runtimeDir, "h", `${key}.sock`);
}

/** Raises rather than letting `bind` fail with a message that names nothing. */
export function assertSocketFits(sshHost: string, socket: string): void {
  const bytes = Buffer.byteLength(socket, "utf8");
  if (bytes > SOCKET_PATH_LIMIT)
    throw new HostError(
      "HOST_UNSUPPORTED",
      sshHost,
      `the socket werk would forward ${sshHost} through is ${bytes} bytes ` +
        `long and a Unix socket path may be ${SOCKET_PATH_LIMIT}. The runtime ` +
        `directory is where the length comes from: ${socket}`,
    );
}

/** A live forward, and whether this process is the one holding it open. */
export interface Forward {
  /** Dialable here, in the same shape the far side reported. */
  readonly endpoint: LocalEndpoint;
  /** True where this process started it and will therefore stop it. */
  readonly owned: boolean;
  close(): void;
}

const held = new Map<string, Promise<Forward>>();
const killers = new Set<() => void>();
let exitHooked = false;
function killOnExit(kill: () => void): () => void {
  killers.add(kill);
  if (!exitHooked) {
    exitHooked = true;
    process.on("exit", () => {
      for (const killer of killers) {
        try {
          killer();
        } catch {}
      }
    });
  }
  return () => {
    killers.delete(kill);
    kill();
  };
}

/** What a hello through a socket said, without saying whether it matters. */
type Hello =
  | { ok: true; version: string }
  | { ok: false; connected: boolean; message: string };

/**
 * Open the socket and complete the protocol handshake.
 *
 * `connected` is the field that earns this function its shape. A socket that is
 * not there yet and a socket that is there with nothing behind it look the same
 * to a caller reading only success or failure, and they mean opposite things:
 * the first is "wait a moment", the second is "the daemon is not running over
 * there".
 */
async function hello(socket: string, timeoutMs: number): Promise<Hello> {
  let transport;
  try {
    transport = await openLocalTransport(
      { kind: "unix", path: socket },
      timeoutMs,
    );
  } catch (error) {
    return {
      ok: false,
      connected: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const client = await connectSessionClient({
      transport,
      requestTimeoutMs: timeoutMs,
    });
    try {
      return { ok: true, version: (await client.daemonInfo()).version };
    } finally {
      await client.close().catch(() => {});
    }
  } catch (error) {
    return {
      ok: false,
      connected: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface ForwardOptions {
  readonly sshHost: string;
  /** werk's local runtime directory; the forwarded socket lives under it. */
  readonly runtimeDir: string;
  /** What the far side said it is listening on. */
  readonly remote: LocalEndpoint;
  readonly runner: RemoteRunner;
  readonly timeoutMs?: number;
}

/** Reach a daemon on another machine through a socket on this one. */
export async function openForward(options: ForwardOptions): Promise<Forward> {
  const { sshHost, remote } = options;
  if (remote.kind !== "unix")
    // Reachable only against a daemon on Windows, which reports loopback TCP
    // with a credential. Forwarding that means `-L <local port>:127.0.0.1:<its
    // port>` and handing back a `tcp` endpoint carrying the far side's
    // credential, which needs a free local port picked here — ssh will not
    // report the one it chose for `-L 0:`. Nothing has needed it yet.
    throw new HostError(
      "HOST_UNSUPPORTED",
      sshHost,
      `${sshHost} is listening on ${remote.kind}, and werk can only forward a ` +
        `Unix socket today.`,
    );
  const socket = forwardSocketPath(
    options.runtimeDir,
    forwardKey(sshHost, remote.path),
  );
  assertSocketFits(sshHost, socket);
  const existing = held.get(socket);
  if (existing) return existing;
  const opening = create(options, socket, remote.path).catch((error) => {
    held.delete(socket);
    throw error;
  });
  held.set(socket, opening);
  return opening;
}

async function create(
  options: ForwardOptions,
  socket: string,
  remoteSocket: string,
): Promise<Forward> {
  const { sshHost, runner } = options;
  const directory = path.dirname(socket);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // An `h` that already existed may have been made under a different umask,
  // and `openLocalTransport` wants exactly 0700.
  await fs.chmod(directory, 0o700);

  const reuse = await hello(socket, REUSE_TIMEOUT_MS);
  if (reuse.ok)
    return {
      endpoint: { kind: "unix", path: socket },
      owned: false,
      close: () => {},
    };

  const release = await takeLock(sshHost, `${socket}.lock`);
  try {
    // Somebody else may have made it while this was waiting for the lock.
    const second = await hello(socket, REUSE_TIMEOUT_MS);
    if (second.ok)
      return {
        endpoint: { kind: "unix", path: socket },
        owned: false,
        close: () => {},
      };
    // Whatever is there is not a working forward, and ssh will not bind over
    // it. Nothing else may write into a 0700 directory werk owns.
    await fs.rm(socket, { force: true });

    const child = runner.start(
      sshForwardArgv(sshHost, {
        kind: "unix",
        local: socket,
        remote: remoteSocket,
      }),
    );
    const stderr = new Response(child.stderr).text().catch(() => "");
    const stop = killOnExit(() => child.kill());
    try {
      await waitForHello(options, child, socket, remoteSocket, stderr);
    } catch (error) {
      stop();
      throw error;
    }
    return {
      endpoint: { kind: "unix", path: socket },
      owned: true,
      close: () => {
        held.delete(socket);
        stop();
      },
    };
  } finally {
    release();
  }
}

async function waitForHello(
  options: ForwardOptions,
  child: { exitCode(): number | null; kill(): void },
  socket: string,
  remoteSocket: string,
  stderr: Promise<string>,
): Promise<void> {
  const { sshHost } = options;
  const deadline = Date.now() + (options.timeoutMs ?? FORWARD_TIMEOUT_MS);
  let last: Hello = { ok: false, connected: false, message: "not started" };
  while (Date.now() < deadline) {
    const code = child.exitCode();
    if (code !== null)
      throw classifySshFailure(
        sshHost,
        { code, stdout: "", stderr: await stderr, timedOut: false },
        `forwarding ${sshHost}`,
      );
    last = await hello(
      socket,
      Math.min(2000, Math.max(1, deadline - Date.now())),
    );
    if (last.ok) return;
    await Bun.sleep(50);
  }
  if (last.connected)
    // Finding 2 in the flesh: ssh bound the local socket, so it stayed up and
    // reported nothing, and the far end had nothing listening. Saying
    // "connection closed" here would be true of the socket and useless about
    // the machine.
    //
    // A daemon that is there but speaks a protocol this client does not know
    // arrives here identically — the handshake fails either way and the client
    // cannot tell which — so the message names both rather than claiming the
    // one it cannot prove.
    throw new HostError(
      "HOST_DAEMON_MISSING",
      sshHost,
      `the forward to ${sshHost} came up and nothing answered on ` +
        `${remoteSocket} at the far end. ssh cannot report that — it only ` +
        `contacts the far side once a client arrives — so werk checked. The ` +
        `daemon over there is not running, is listening somewhere else, or is ` +
        `one this werk cannot speak to.`,
      `the handshake said: ${last.message}`,
    );
  throw new HostError(
    "HOST_BOOTSTRAP_FAILED",
    sshHost,
    `the forward to ${sshHost} did not come up in time.`,
    [last.message, await stderr].filter(Boolean).join("\n"),
  );
}

/** Serialise forward creation between processes, and give up rather than hang. */
async function takeLock(sshHost: string, file: string): Promise<() => void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      return acquireDaemonLock(file);
    } catch (error) {
      if (Date.now() >= deadline)
        throw new HostError(
          "HOST_BOOTSTRAP_FAILED",
          sshHost,
          `another werk has been making the forward to ${sshHost} for ` +
            `${LOCK_TIMEOUT_MS / 1000} seconds and has not finished.`,
          error instanceof Error ? error.message : String(error),
        );
      await Bun.sleep(50);
    }
  }
}
