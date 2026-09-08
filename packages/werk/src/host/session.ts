/**
 * One machine, from "here is its name" to "here is a socket".
 *
 * Everything else in this directory does one step. This is the order they go
 * in, what is remembered between runs, and what is worth trying before all of
 * it.
 *
 * ## The client never guesses a remote path
 *
 * It would be easy to assume the far side's runtime directory is `/tmp/werk-
 * <uid>` and dial it. It would also be wrong the first time somebody sets
 * `WERK_RUNTIME_DIR`, uses a machine with a per-session `XDG_RUNTIME_DIR`, or
 * runs werk under a different account than the probe reported. So werk runs
 * `werk daemon endpoint --ensure --json` over there and reads the answer: the
 * far side says where it put things, and starts a daemon in the same breath if
 * none was running.
 *
 * That command is run under a **login shell**. On the machines werk is aimed at
 * `claude` lives in `~/.local/bin` and is on the login PATH and no other, and a
 * daemon started from a non-login shell would hand every session it spawns a
 * PATH that cannot find it.
 *
 * A daemon started this way outlives the ssh that started it with nothing said:
 * `ensureSessionDaemon` spawns with Bun's `detached: true`, which calls
 * `setsid()`, so the daemon is in its own session before the ssh exits.
 *
 * ## The warm path
 *
 * The cold path is four round trips — probe, stamp, ensure, forward — and about
 * a second of them at any real latency. So the answer is cached in
 * `<stateDir>/hosts/<name>.json` and a second command tries the forward
 * straight away: one round trip, and the hello through it proves the whole
 * chain still holds. Anything that does not hold falls back to the cold path
 * rather than failing, because a cache that has to be right is a cache that
 * breaks people's machines.
 *
 * An interpreted werk never takes the warm path. Its identity is
 * `0.0.0-source` for every working tree, so a cache entry cannot say whether
 * the binary over there was built from the code in front of you — and whoever
 * is running werk from source is exactly the person who has just changed it.
 *
 * ## Readiness starts before anybody asks for it
 *
 * `openHostSession` starts `ready()` and holds the promise. The probe is a
 * round trip werk is going to need whatever the caller does next, and starting
 * it here lets it overlap with resolving a workspace or reading a config. The
 * rejection is captured immediately, because an unobserved rejected promise is
 * a process-level warning that has nothing to do with the failure.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { LocalEndpoint } from "@werk/session-daemon";
import type { SshHost } from "../config/hosts.js";
import type { HostProbe, ProbeOptions, ProbeAnswer } from "./probe.js";
import {
  SOURCE_IDENTITY,
  compiledWerk,
  werkVersion,
} from "../runtime/version.js";
import { openForward, type Forward } from "./forward.js";
import { ensureRemoteWerk, type Installed } from "./install.js";
import { probeFacts, sshProbe } from "./ssh-probe.js";
import {
  requireConnection,
  shellQuote,
  spawnRunner,
  sshExecArgv,
  EXEC_TIMEOUT_MS,
  type RemoteRunner,
} from "./ssh.js";
import { targetFor, type HostTarget } from "./target.js";
import { HostError, type RemoteFacts } from "./types.js";

/** Starting a daemon on a machine that has none includes starting a process. */
export const ENSURE_TIMEOUT_MS = 20_000;

/** What `werk daemon endpoint --json` prints, as far as this file reads it. */
interface EndpointReport {
  endpoint: LocalEndpoint;
  runtimeDir: string;
  stateDir: string;
  version: string;
  build: string;
}

/** What werk remembers about a machine between commands. */
export interface HostCache {
  readonly sshHost: string;
  /** The identity of the client that wrote this. */
  readonly build: string;
  readonly binary: string;
  readonly endpoint: LocalEndpoint;
  readonly runtimeDir: string;
  readonly stateDir: string;
  readonly at: string;
}

/** Everything werk found out on the way to a socket. */
export interface HostReady {
  readonly facts: RemoteFacts;
  readonly target: HostTarget;
  readonly installed: Installed;
  readonly report: EndpointReport;
  readonly forward: Forward;
}

export interface HostSessionOptions {
  /** The `[hosts.<name>]` this came from; it names the cache file. */
  readonly name: string;
  readonly host: SshHost;
  /** werk's local runtime directory; the forwarded socket goes under it. */
  readonly runtimeDir: string;
  /** werk's local state directory; the cache and any built binary go under it. */
  readonly stateDir: string;
  /** Absolute path of the entry module, for a build on demand. */
  readonly entry: string;
  /**
   * A bun target, when the person had to say. See `target.ts`: there is no
   * config key for this yet, and one in the host block is what it wants.
   */
  readonly target?: string;
  readonly runner?: RemoteRunner;
  /** Overridden only by tests; the defaults describe the running werk. */
  readonly build?: string;
  readonly compiled?: boolean;
  readonly execPath?: string;
}

export interface HostSession extends HostProbe {
  readonly name: string;
  readonly sshHost: string;
  /** Everything, memoised: probe, install, remote daemon, forward. */
  ready(): Promise<HostReady>;
  /** A socket on this machine that reaches the daemon on that one. */
  endpoint(): Promise<LocalEndpoint>;
  close(): Promise<void>;
}

const cacheFile = (stateDir: string, name: string) =>
  path.join(stateDir, "hosts", `${name}.json`);

/** The last JSON object on stdout, so a profile's banner costs nothing. */
export function readEndpointReport(stdout: string): EndpointReport | null {
  const lines = stdout.replaceAll("\r", "").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const value = JSON.parse(line) as EndpointReport;
      if (value && typeof value === "object" && value.endpoint) return value;
    } catch {}
  }
  return null;
}

export function openHostSession(options: HostSessionOptions): HostSession {
  const sshHost = options.host.sshHost;
  const runner = options.runner ?? spawnRunner();
  const identity = options.build ?? werkVersion();
  const probe = sshProbe(sshHost, runner);
  let readiness: Promise<HostReady> | undefined;
  let warm: Promise<LocalEndpoint> | undefined;
  let forward: Forward | undefined;

  async function ensure(binary: string): Promise<EndpointReport> {
    const outcome = await runner.run(
      sshExecArgv(
        sshHost,
        `${shellQuote(binary)} daemon endpoint --ensure --json`,
        { login: true },
      ),
      { timeoutMs: ENSURE_TIMEOUT_MS },
    );
    requireConnection(sshHost, outcome, `starting werk on ${sshHost}`);
    const report = readEndpointReport(outcome.stdout);
    if (report === null)
      throw new HostError(
        "HOST_BOOTSTRAP_FAILED",
        sshHost,
        `werk on ${sshHost} did not say what it is listening on.`,
        outcome.stderr || outcome.stdout,
      );
    return report;
  }

  async function cold(): Promise<HostReady> {
    const facts = await probeFacts(sshHost, runner, EXEC_TIMEOUT_MS);
    const target = targetFor(sshHost, facts, options.target);
    const installed = await ensureRemoteWerk({
      sshHost,
      runner,
      facts,
      target,
      stateDir: options.stateDir,
      entry: options.entry,
      ...(options.build === undefined ? {} : { build: options.build }),
      compiled: options.compiled ?? compiledWerk(),
      execPath: options.execPath ?? process.execPath,
    });
    const report = await ensure(installed.binary);
    await writeCache(report, installed.binary);
    const opened = await openForward({
      sshHost,
      runtimeDir: options.runtimeDir,
      remote: report.endpoint,
      runner,
    });
    forward = opened;
    return { facts, target, installed, report, forward: opened };
  }

  async function writeCache(
    report: EndpointReport,
    binary: string,
  ): Promise<void> {
    const file = cacheFile(options.stateDir, options.name);
    const cache: HostCache = {
      sshHost,
      build: identity,
      binary,
      endpoint: report.endpoint,
      runtimeDir: report.runtimeDir,
      stateDir: report.stateDir,
      at: new Date().toISOString(),
    };
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
    } catch {
      // A cache that cannot be written costs a round trip next time and
      // nothing else, so it is not worth failing a command over.
    }
  }

  async function readCache(): Promise<HostCache | null> {
    try {
      const cache = JSON.parse(
        await fs.readFile(cacheFile(options.stateDir, options.name), "utf8"),
      ) as HostCache;
      if (cache.sshHost !== sshHost || cache.build !== identity) return null;
      return cache;
    } catch {
      return null;
    }
  }

  /** One round trip, or nothing. Any doubt at all hands over to `cold`. */
  async function tryWarm(): Promise<LocalEndpoint | null> {
    if (identity === SOURCE_IDENTITY) return null;
    const cache = await readCache();
    if (cache === null) return null;
    try {
      const opened = await openForward({
        sshHost,
        runtimeDir: options.runtimeDir,
        remote: cache.endpoint,
        runner,
      });
      forward = opened;
      return opened.endpoint;
    } catch {
      return null;
    }
  }

  const session: HostSession = {
    name: options.name,
    sshHost,
    ready() {
      readiness ??= cold();
      return readiness;
    },
    async endpoint() {
      warm ??= (async () => {
        const quick = await tryWarm();
        if (quick !== null) return quick;
        return (await session.ready()).forward.endpoint;
      })();
      return warm;
    },
    run(
      command: readonly string[],
      probeOptions: ProbeOptions,
    ): Promise<ProbeAnswer> {
      return probe.run(command, probeOptions);
    },
    async close() {
      forward?.close();
      forward = undefined;
    },
  };

  // Eager, because reaching the machine is a round trip that is needed whatever
  // the caller does next, and it may as well overlap resolving a workspace or
  // reading a config. Started through `endpoint` rather than `ready` so that a
  // machine werk has already been to costs the one round trip the cache is
  // there to buy; `ready` is the whole pipeline and runs when the cache cannot
  // answer. Captured, because nobody may ever await it and an unobserved
  // rejection is a warning about the wrong thing.
  void session.endpoint().catch(() => {});
  return session;
}
