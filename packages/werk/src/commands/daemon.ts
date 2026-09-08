/**
 * Running the daemon, and saying exactly what to connect to.
 *
 * `serve` is what the CLI spawns when a command needs a daemon and none is
 * listening, and it is what an operator points systemd or launchd at. It stays
 * visible in help for that second reason: syncthing keeps `serve` documented for
 * the same purpose, and a hidden command is one an operator cannot discover.
 *
 * `endpoint` is the pair to it. `werk info` says where werk keeps things;
 * `endpoint` says what is listening, in the form something else could dial.
 */
import path from "node:path";
import { Command } from "@commander-js/extra-typings";
import {
  createLogger,
  errorFields,
  ensureSessionDaemon,
  installDaemonErrorHandlers,
  parseLogLevel,
  readDaemonRecord,
  resolveSessionDaemonPaths,
  serveSessionDaemon,
  type LocalEndpoint,
} from "@werk/session-daemon";
import { SessionError } from "@werk/session";
import { loadTerminalEngine } from "@werk/terminal/bun";
import { withContext } from "./shared.js";
import { defineCommand } from "./define.js";
import { result, section } from "../runtime/output.js";
import {
  connectExistingDaemon,
  daemonCommand,
  type DaemonPaths,
} from "../runtime/daemon.js";
import { werkVersion } from "../runtime/version.js";
import type { WerkContext } from "../runtime/context.js";

async function serve(ctx: WerkContext): Promise<void> {
  const logLevel = parseLogLevel(ctx.logLevel);
  const log = createLogger({
    file: path.join(ctx.stateDir, "daemon.log"),
    level: logLevel,
  });
  let daemon;
  try {
    daemon = await serveSessionDaemon({
      runtimeDir: ctx.runtimeDir,
      stateDir: ctx.stateDir,
      // The daemon reports the identity of the binary that started it, so
      // `daemonInfo().version` and `werk --version` are the same string.
      version: werkVersion(),
      engineFactory: await loadTerminalEngine(),
      log,
      logLevel,
    });
  } catch (error) {
    log.write("error", "daemon.stop", {
      reason: "startup-failed",
      ...errorFields(error),
    });
    log.close();
    throw error;
  }
  // The daemon records its own pid in $stateDir/daemon.json; nothing here duplicates it.
  let closing = false;
  let removeErrorHandlers = () => {};
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await daemon.close();
    } finally {
      process.off("SIGINT", close);
      process.off("SIGTERM", close);
      removeErrorHandlers();
      log.close();
    }
  };
  removeErrorHandlers = installDaemonErrorHandlers({
    log,
    checkpoint: daemon.checkpoint,
    close,
  });
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

/**
 * What something else needs in order to talk to this daemon.
 *
 * `endpoint` is the address in the form `openLocalTransport` takes, credential
 * included where there is one, because a record you cannot dial is not an
 * answer. `version` is what the daemon says it is and `build` is what this
 * binary is: the same string whenever the running daemon came from this werk,
 * and two different strings when it did not, which is the question worth being
 * able to ask.
 */
export interface EndpointReport {
  endpoint: LocalEndpoint;
  runtimeDir: string;
  stateDir: string;
  /** From `$stateDir/daemon.json`; null where no record was readable. */
  pid: number | null;
  version: string;
  build: string;
}
/** `unix /run/werk/daemon.sock`, or `tcp 127.0.0.1:49731`. */
export function describeEndpoint(endpoint: LocalEndpoint): string {
  return endpoint.kind === "unix"
    ? `unix ${endpoint.path}`
    : `tcp ${endpoint.host}:${endpoint.port}`;
}
export function renderEndpoint(
  report: EndpointReport,
  ctx: WerkContext,
): string {
  return section(ctx, "daemon", [
    // The credential a TCP endpoint carries is left out of the human register
    // and kept in the JSON. Reading is what the block is for; connecting is
    // what `--json` is for, and a secret printed to a terminal ends up in a
    // scrollback, a screenshot or a pasted bug report.
    ["endpoint", describeEndpoint(report.endpoint)],
    ["runtime", report.runtimeDir],
    ["state", report.stateDir],
    ["pid", report.pid === null ? "not recorded" : String(report.pid)],
    ["version", report.version],
    ["build", report.build],
  ]);
}
async function endpointReport(
  ctx: WerkContext,
  ensure: boolean,
): Promise<EndpointReport> {
  const paths: DaemonPaths = {
    runtimeDir: ctx.runtimeDir,
    stateDir: ctx.stateDir,
    logLevel: ctx.logLevel,
    entry: ctx.entry,
  };
  let endpoint: LocalEndpoint;
  let version: string;
  if (ensure) {
    const daemon = await ensureSessionDaemon({
      runtimeDir: ctx.runtimeDir,
      stateDir: ctx.stateDir,
      daemonCommand: daemonCommand(ctx.entry),
      logLevel: parseLogLevel(ctx.logLevel),
    });
    endpoint = daemon.endpoint;
    version = daemon.version;
  } else {
    // Never the route that can spawn. Somebody asking what is listening has
    // not asked for anything to start listening, and a command that quietly
    // left a daemon behind would be a poor thing to run over ssh.
    const existing = await connectExistingDaemon(paths, 5000);
    if (!existing)
      throw new SessionError(
        "CLOSED",
        "no daemon is listening; start one with `werk daemon endpoint --ensure`",
      );
    endpoint = existing.endpoint;
    try {
      version = (await existing.client.daemonInfo()).version;
    } finally {
      await existing.client.close().catch(() => {});
    }
  }
  const record = await readDaemonRecord(
    resolveSessionDaemonPaths(paths).record,
  );
  return {
    endpoint,
    runtimeDir: ctx.runtimeDir,
    stateDir: ctx.stateDir,
    pid: record && Number.isInteger(record.pid) ? record.pid : null,
    version,
    build: werkVersion(),
  };
}
export function buildDaemon(): Command {
  const daemon = defineCommand({
    name: "daemon",
    summary: "Run the session daemon yourself",
    description:
      "The daemon that owns the PTYs. The CLI starts one for you when a " +
      "command needs it, so this is here for an operator who would rather " +
      "supervise it themselves.",
    examples: [{ run: "werk daemon serve", note: "run it in this process" }],
  });
  daemon.addCommand(
    defineCommand({
      name: "serve",
      summary: "Run the daemon in this process until it is signalled",
      description:
        "Runs in the foreground and does not return until it is signalled. " +
        "This is what systemd or launchd is pointed at.",
      examples: [
        { run: "werk daemon serve" },
        { run: "werk daemon serve --log-level debug" },
      ],
      notes: "The CLI starts this for you when a command needs a daemon.",
    }).action(withContext(async (ctx) => void (await serve(ctx)))),
  );
  daemon.addCommand(
    defineCommand({
      name: "endpoint",
      summary: "Print what to connect to, and what is running there",
      description:
        "The address a client dials to reach this daemon, the directories it " +
        "is using, its pid, the version it reports and the build of the werk " +
        "that asked. `werk info` says where werk keeps things; this says what " +
        "is listening.\n\n" +
        "It reads only. Without `--ensure` it never starts a daemon: if none " +
        "is listening it says so and exits 7.",
      examples: [
        { run: "werk daemon endpoint" },
        {
          run: "werk daemon endpoint --json | jq -r .endpoint.path",
          note: "the socket to dial",
        },
        {
          run: "werk daemon endpoint --ensure",
          note: "start one first if none is running",
        },
      ],
      notes:
        "Under --json the record is complete enough to connect with, so a TCP " +
        "endpoint's credential is in it. The human block leaves the " +
        "credential out.",
    })
      .option("--ensure", "start a daemon first if none is listening")
      .action(
        withContext(async (ctx, opts: { ensure?: boolean }) => {
          const report = await endpointReport(ctx, opts.ensure === true);
          return result(report, (c) => renderEndpoint(report, c));
        }),
      ),
  );
  return daemon;
}
