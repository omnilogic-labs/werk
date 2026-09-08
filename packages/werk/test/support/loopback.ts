/**
 * A machine that is this one.
 *
 * Everything werk does to reach a computer sits behind three seams:
 * `@werk/workspace`'s `RemoteRunner`, which runs a shell script over there;
 * the `pushUrl` the same package hands git; and `HostProbe`, which asks the
 * machine about itself. Until now those seams have been answered either by a
 * scripted fake, which proves the mapping and never runs the scripts, or by
 * `scripts/remote-smoke.ts`, which needs a second computer that most people and
 * no CI lane have. Between the two there was nothing in `bun test` that ran the
 * remote scripts at all.
 *
 * This fills that in by satisfying the seams with the local machine. The
 * scripts really run, under `sh -c` in a temporary `$HOME`; `git init --bare`,
 * the numbered refusals and `worktree add --lock` really execute; and the push
 * really transfers objects, over the filesystem rather than over ssh. What it
 * cannot say anything about is ssh: the connection, its failures, the argv werk
 * builds for it and the forward it opens are all somewhere else.
 *
 * **This is deliberately not in the product.** A `kind: "loopback"` host in
 * werk's configuration would be a fake machine in the model — a host that
 * answers as though it were elsewhere while being here — and the model is
 * expected to grow real ones. Nothing needs it: the seams already take an
 * injected runner, which is what a test is for.
 */
import net from "node:net";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RemoteRunner } from "@werk/workspace";
import {
  assertSocketFits,
  forwardKey,
  forwardSocketPath,
} from "../../src/host/forward.js";
import type { HostProbe } from "../../src/host/probe.js";

/** `sh` by absolute path, so a machine with an emptied `PATH` still has one. */
const SHELL = Bun.which("sh") ?? "/bin/sh";

export interface LoopbackOptions {
  /** What werk's configuration would call it. Becomes the reference's host. */
  readonly host?: string;
  /**
   * Run everything with a `PATH` that has no git on it, which is the machine
   * the preparation script exits 90 for.
   */
  readonly withoutGit?: boolean;
  /**
   * Point the push at a path beside the mirror rather than at it, so git runs
   * and fails for a reason of its own. The other ways to break a push — an
   * unwritable mirror, a disc that is full — either need root to be reliable or
   * cannot be arranged at all.
   */
  readonly brokenPush?: boolean;
}

export interface LoopbackMachine {
  /** What werk's configuration would call it. */
  readonly host: string;
  /** `$HOME` over there. */
  readonly home: string;
  /** The workspace root over there: `repos/` and the workspaces sit under it. */
  readonly root: string;
  /** `@werk/workspace`'s seam, running the script here. */
  readonly remote: RemoteRunner;
  /** What git is told to push to. A filesystem path, so no ssh is involved. */
  pushUrl(repositoryPath: string): string;
  /** The probe seam, answering about this machine with that `$HOME`. */
  readonly probe: HostProbe;
  dispose(): Promise<void>;
}

export async function loopbackMachine(
  options: LoopbackOptions = {},
): Promise<LoopbackMachine> {
  const host = options.host ?? "loop";
  // Short, and beside the sandboxes for the same reason: everything under a
  // machine ends up in a path something has a length limit for.
  const home = await mkdtemp("/tmp/wkl-");
  const root = join(home, "werk");
  const nowhere = join(home, "empty-path");
  if (options.withoutGit === true) await mkdir(nowhere, { recursive: true });

  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith("WERK_"))
      environment[key] = value;
  environment.HOME = home;
  // A machine without git is one whose PATH has nothing on it at all, which is
  // the honest way to make `command -v git` answer no. `sh` is spawned by
  // absolute path, so the script still has a shell to run in.
  if (options.withoutGit === true) environment.PATH = nowhere;

  const shell = async (
    argv: readonly string[],
    timeoutMs: number | undefined,
  ) => {
    const child = Bun.spawn([...argv], {
      cwd: home,
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let killed = false;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            killed = true;
            child.kill("SIGKILL");
          }, timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      // A machine that stopped answering, spelled the way ssh spells it, so the
      // maker reads it as unreachable rather than as a refusal.
      return { code: killed || code === null ? 255 : code, stdout, stderr };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const machine: LoopbackMachine = {
    host,
    home,
    root,
    async remote(script, runOptions) {
      const ran = await shell([SHELL, "-c", script], runOptions?.timeoutMs);
      return { exitCode: ran.code, stdout: ran.stdout, stderr: ran.stderr };
    },
    pushUrl(repositoryPath) {
      return options.brokenPush === true
        ? `${repositoryPath}.not-a-repository`
        : repositoryPath;
    },
    probe: {
      async run(command, probeOptions) {
        try {
          const ran = await shell(command, probeOptions.timeoutMs);
          return {
            ok: true,
            code: ran.code,
            stdout: ran.stdout,
            stderr: ran.stderr,
          };
        } catch (error) {
          // The command is not on the machine at all, which is nothing having
          // run rather than something having failed.
          return {
            ok: false,
            code: null,
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
          };
        }
      },
    },
    async dispose() {
      await rm(home, { recursive: true, force: true }).catch(() => {});
    },
  };
  return machine;
}

/** A socket here that is a daemon's socket there, where there is also here. */
export interface LoopbackForward {
  readonly endpoint: { readonly kind: "unix"; readonly path: string };
  close(): Promise<void>;
}

/**
 * Put a daemon's socket where a forward would have put it.
 *
 * `openLocalTransport` refuses a symbolic link — it `lstat`s the endpoint and
 * insists on a socket — so this is a relay rather than a link: a listener on
 * `<runtimeDir>/h/<key>.sock` that copies bytes to the daemon's own socket and
 * back. The path is built by the code the CLI builds it with, so the naming and
 * the 103-byte check are the real ones. The directory is 0700 and the socket is
 * 0600 because that is what `openLocalTransport` requires of both, and a
 * listener takes its mode from the umask.
 */
export async function forwardLocalDaemon(options: {
  readonly host: string;
  /** The client's runtime directory; the socket goes under it. */
  readonly runtimeDir: string;
  /** What the daemon is really listening on. */
  readonly remoteSocket: string;
}): Promise<LoopbackForward> {
  const socket = forwardSocketPath(
    options.runtimeDir,
    forwardKey(options.host, options.remoteSocket),
  );
  assertSocketFits(options.host, socket);
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 });
  await chmod(dirname(socket), 0o700);
  await rm(socket, { force: true });

  const open = new Set<net.Socket>();
  const join2 = (client: net.Socket, upstream: net.Socket) => {
    open.add(client);
    open.add(upstream);
    const drop = () => {
      open.delete(client);
      open.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    client.on("error", drop);
    upstream.on("error", drop);
    client.on("close", drop);
    upstream.on("close", drop);
    client.pipe(upstream);
    upstream.pipe(client);
  };
  const server = net.createServer((client) =>
    join2(client, net.createConnection({ path: options.remoteSocket })),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve());
  });
  await chmod(socket, 0o600);

  return {
    endpoint: { kind: "unix", path: socket },
    async close() {
      for (const one of [...open]) one.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(socket, { force: true }).catch(() => {});
    },
  };
}
