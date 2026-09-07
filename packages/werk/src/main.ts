#!/usr/bin/env bun
import path from "node:path";
import { clientEnvironment } from "./environment.js";
import {
  createInputPump,
  inputSliceBytes,
  INPUT_CHUNK_BYTES,
  type InputPump,
} from "./input.js";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  connectSessionClient,
  type SessionClient,
  type Attachment,
  type EndReason,
  type ExitOutcome,
  type HoldSize,
  type TerminationIntent,
} from "@werk/session";
import {
  createViewRenderer,
  type ViewRenderer,
  type ViewState,
} from "./view.js";
import {
  defaultSessionRuntimeDir,
  createLogger,
  parseLogLevel,
  errorFields,
  installDaemonErrorHandlers,
  inspectSessionDaemon,
  ensureSessionDaemon,
  openLocalTransport,
  serveSessionDaemon,
} from "@werk/session-daemon";
import { loadTerminalEngine } from "@werk/terminal/bun";
import { createTerminalReplica } from "@werk/terminal";
declare const WERK_COMPILED: boolean;
const usage = `werk <create|list|attach|logs|kill|remove|watch|info|doctor|session-daemon>

  create [--name NAME] [--label KEY=VALUE] [--cols N --rows N] [--scrollback BYTES] -- COMMAND [ARGS...]
  list [--label KEY=VALUE]             List sessions as JSON
  attach ID [--read-only] [--follow|--claim-size]
                                     Attach; Ctrl-] detaches
  logs ID [--history]                 Read retained screen or history
  kill ID [--intent interrupt|terminate|force]
  remove ID                          Remove a retained record
  watch                              Print daemon events as JSON lines
  info                               Print paths and available daemon information
  doctor                             Check local daemon health and show log tail
  session-daemon                     Serve the daemon in this process

All commands accept --runtime-dir PATH, --state-dir PATH and --log-level LEVEL.
The CLI explicitly starts a detached daemon when one is needed.
`;
interface Arguments {
  verb: string;
  positionals: string[];
  command: string[];
  flags: Map<string, string>;
  labels: Record<string, string>;
}
function parse(args: string[]): Arguments {
  const verb = args.shift() ?? "help",
    positionals: string[] = [],
    command: string[] = [],
    flags = new Map<string, string>(),
    labels: Record<string, string> = {};
  const booleans = new Set([
    "read-only",
    "follow",
    "claim-size",
    "history",
    "help",
  ]);
  const valued = new Set([
    "runtime-dir",
    "log-level",
    "state-dir",
    "name",
    "label",
    "cols",
    "rows",
    "scrollback",
    "cwd",
    "intent",
  ]);
  while (args.length) {
    const a = args.shift()!;
    if (a === "--") {
      command.push(...args);
      break;
    }
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const key = a.slice(2);
    if (booleans.has(key)) {
      flags.set(key, "true");
      continue;
    }
    if (!valued.has(key)) throw new Error(`Unknown option ${a}`);
    const value = args.shift();
    if (value === undefined) throw new Error(`${a} requires a value`);
    if (key === "label") {
      const index = value.indexOf("=");
      if (index < 1) throw new Error("--label requires KEY=VALUE");
      labels[value.slice(0, index)] = value.slice(index + 1);
    } else flags.set(key, value);
  }
  return { verb, positionals, command, flags, labels };
}
const json = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
/** Read `--scrollback`, rejecting locally so the message names the flag. */
function scrollbackBytes(a: Arguments): number | undefined {
  const raw = a.flags.get("scrollback");
  if (raw === undefined) return undefined;
  const bytes = Number(raw);
  if (!Number.isInteger(bytes) || bytes < 0)
    throw new Error("--scrollback must be a whole number of bytes");
  return bytes;
}
function size(a: Arguments) {
  return {
    cols: Number(a.flags.get("cols") ?? process.stdout.columns ?? 80),
    rows: Number(a.flags.get("rows") ?? process.stdout.rows ?? 24),
  };
}
/**
 * How a session that was already over is described once the screen is torn down. A `lost`
 * record has no outcome to report, because the daemon never saw the process finish.
 */
function outcomeNote(
  id: string,
  exit: ExitOutcome | undefined,
  state?: string,
) {
  if (!exit)
    return state === "lost"
      ? `session ${id} was lost: the daemon stopped watching the process before it finished`
      : `session ${id} has ended with no recorded outcome`;
  const detail = exit.signal
    ? `signal ${exit.signal}`
    : exit.code === null
      ? "an unknown status"
      : `status ${exit.code}`;
  return `session ${id} has ended with ${detail}${exit.reason ? ` (${exit.reason})` : ""}`;
}
/**
 * What the attachment asks to do about the session grid. A writable attach takes
 * a free size, which is the daemon's own default; `--claim-size` adds the
 * takeover, so nothing quietly resizes a grid somebody else is working in.
 */
function sizeIntent(args: Arguments): HoldSize {
  if (args.flags.has("follow")) return "never";
  if (args.flags.has("claim-size")) return "claim";
  return args.flags.has("read-only") ? "never" : "if-free";
}
async function attach(client: SessionClient, id: string, args: Arguments) {
  const tty = !!process.stdout.isTTY;
  const state: ViewState = {
    writable: !args.flags.has("read-only"),
    holdsSize: false,
    claimed: args.flags.has("claim-size"),
    follow: args.flags.has("follow"),
  };
  const view: ViewRenderer | undefined = tty
    ? createViewRenderer({
        write: (data) => process.stdout.write(data),
        window: () => size(args),
        state: () => state,
      })
    : undefined;
  const replica = createTerminalReplica(await loadTerminalEngine(), view);
  let attachment: Attachment | undefined;
  let finish!: () => void;
  let stopped = false;
  const finished = new Promise<void>((resolve) => {
    finish = () => {
      stopped = true;
      process.stdin.pause();
      resolve();
    };
  });
  let error: unknown;
  let outcome: ExitOutcome | undefined;
  let endReason: EndReason | undefined;
  let pump!: InputPump;
  const input = (data: Buffer) => {
    if (stopped) return;
    const at = data.indexOf(29);
    const bytes = at < 0 ? data : data.subarray(0, at);
    if (bytes.length && !args.flags.has("read-only")) pump.offer(bytes);
    // Detaching stops reading; the bytes already offered still drain below.
    if (at >= 0) finish();
  };
  const fitSession = () => {
    if (!attachment?.holdsSize) return;
    void attachment.resize(size(args)).catch((e) => {
      error = e;
      finish();
    });
  };
  /**
   * Holding the size means the session follows the window. Not holding it means
   * only the clipping moves, and no frame is coming to prompt a repaint, so the
   * view redraws itself against the new window.
   */
  const resize = () => {
    if (attachment?.holdsSize) fitSession();
    else view?.refresh();
  };
  const stop = () => finish();
  try {
    if (tty) process.stdout.write("\x1b[?1049h\x1b[2J");
    attachment = await client.attach(id, {
      representation: "snapshot",
      permissions: { read: true, input: state.writable },
      holdSize: sizeIntent(args),
      onEvent(event) {
        void replica
          .apply(event)
          .then(() => {
            if (!tty) {
              if (event.type === "snapshot" || event.type === "resync")
                process.stdout.write(replica.readScreen());
              else if (event.type === "output")
                process.stdout.write(event.data);
            }
            // `holdsSize` is authoritative on this event and not before it, so
            // the status row and the resize policy both follow the event rather
            // than whatever request produced it.
            if (event.type === "size-holder") {
              state.holdsSize = event.holdsSize;
              view?.refresh();
              fitSession();
            }
            if (event.type === "exit") outcome = event.exit;
            if (event.type === "ended") {
              endReason = event.reason;
              finish();
            }
          })
          .catch((e) => {
            error = e;
            finish();
          });
      },
    });
    // Nobody need hold the size: a `--follow` or read-only attach leaves the
    // grid wherever it was, which is exactly the case the view clips.
    state.holdsSize = attachment.holdsSize;
    view?.refresh();
    if (attachment.holdsSize) await attachment.resize(size(args));
    // Clamp the slice so one slice is one request; see inputSliceBytes. A frame
    // budget too small to carry input raises LIMIT here rather than swallowing
    // the first keystroke, and read-only attachments never ask.
    const slice = args.flags.has("read-only")
      ? INPUT_CHUNK_BYTES
      : inputSliceBytes(client.inputChunkBytes(attachment.id));
    pump = createInputPump({
      sink: { writeInput: (data) => attachment!.writeInput(data) },
      chunkBytes: slice,
      pause: () => process.stdin.pause(),
      resume: () => {
        if (!stopped) process.stdin.resume();
      },
      onError: (e) => {
        error = e;
        finish();
      },
    });
    process.stdin.on("data", input);
    process.stdin.once("end", stop);
    process.stdout.on("resize", resize);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    await Promise.race([finished, client.closed]);
    await pump.drained();
    if (error) throw error;
  } finally {
    process.stdin.off("data", input);
    process.stdin.off("end", stop);
    process.stdout.off("resize", resize);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    await attachment?.detach().catch(() => {});
    replica.dispose();
    if (tty) process.stdout.write("\x1b[?1049l");
  }
  // The alternate screen is gone by here, and the note is status rather than session
  // output, so it goes to stderr and leaves piped stdout carrying only the screen.
  if (endReason === "session-ended") {
    let state: string | undefined;
    if (!outcome)
      state = await client.get(id).then(
        (s) => s.state,
        () => undefined,
      );
    process.stderr.write(`werk: ${outcomeNote(id, outcome, state)}\n`);
  }
}
async function main() {
  const args = parse(process.argv.slice(2));
  if (
    args.verb === "help" ||
    args.verb === "--help" ||
    args.flags.has("help")
  ) {
    process.stdout.write(usage);
    return;
  }
  const known = new Set([
    "create",
    "list",
    "attach",
    "logs",
    "kill",
    "remove",
    "watch",
    "info",
    "doctor",
    "session-daemon",
  ]);
  if (!known.has(args.verb)) throw new Error(`Unknown command ${args.verb}`);
  const runtimeDir = path.resolve(
    args.flags.get("runtime-dir") ?? defaultSessionRuntimeDir(),
  );
  const stateDir = path.resolve(
    args.flags.get("state-dir") ??
      path.join(
        process.env.XDG_STATE_HOME ??
          path.join(os.homedir(), ".local", "state"),
        "werk",
      ),
  );
  const logLevel = parseLogLevel(
    args.flags.get("log-level") ?? process.env.WERK_LOG_LEVEL,
  );
  if (args.verb === "info" || args.verb === "doctor") {
    json(
      await inspectSessionDaemon({
        runtimeDir,
        stateDir,
        doctor: args.verb === "doctor",
      }),
    );
    return;
  }
  if (args.verb === "session-daemon") {
    const log = createLogger({
      file: path.join(stateDir, "daemon.log"),
      level: logLevel,
    });
    let daemon;
    try {
      daemon = await serveSessionDaemon({
        runtimeDir,
        stateDir,
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
    // The daemon itself records its pid in $stateDir/daemon.json; nothing here duplicates it.
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
    return;
  }
  if (
    ["attach", "logs", "kill", "remove"].includes(args.verb) &&
    !args.positionals[0]
  )
    throw new Error(`${args.verb} requires a session ID`);
  if (args.flags.has("follow") && args.flags.has("claim-size"))
    throw new Error("--follow and --claim-size ask for opposite things");
  if (args.verb === "create" && !args.command.length)
    throw new Error("create requires -- COMMAND [ARGS...]");
  const compiled = typeof WERK_COMPILED !== "undefined" && WERK_COMPILED;
  const daemonCommand = compiled
    ? [process.execPath, "session-daemon"]
    : [process.execPath, fileURLToPath(import.meta.url), "session-daemon"];
  const daemon = await ensureSessionDaemon({
    runtimeDir,
    stateDir,
    daemonCommand,
    logLevel,
  });
  const client = await connectSessionClient({
    transport: await openLocalTransport(daemon.endpoint),
    credential:
      daemon.endpoint.kind === "tcp" ? daemon.endpoint.credential : undefined,
    requestTimeoutMs: 5000,
  });
  const id = args.positionals[0]!;
  try {
    switch (args.verb) {
      case "create":
        json(
          await client.create({
            argv: args.command,
            env: clientEnvironment(),
            cwd: path.resolve(args.flags.get("cwd") ?? process.cwd()),
            size: size(args),
            scrollbackBytes: scrollbackBytes(args),
            name: args.flags.get("name"),
            labels: args.labels,
          }),
        );
        break;
      case "list":
        json(await client.list({ labels: args.labels }));
        break;
      case "info":
        json(await client.daemonInfo());
        break;
      case "logs":
        process.stdout.write(
          (args.flags.has("history")
            ? await client.readHistory(id)
            : await client.readScreen(id)) + "\n",
        );
        break;
      case "kill": {
        const intent = args.flags.get("intent") ?? "terminate";
        if (!["interrupt", "terminate", "force"].includes(intent))
          throw new Error("Invalid termination intent");
        json(await client.terminate(id, intent as TerminationIntent));
        break;
      }
      case "remove":
        await client.remove(id);
        break;
      case "attach":
        await attach(client, id, args);
        break;
      case "watch": {
        const stop = client.watch(json);
        await stop.ready;
        let finish!: () => void;
        const done = new Promise<void>((r) => (finish = r));
        process.once("SIGINT", finish);
        process.once("SIGTERM", finish);
        try {
          await Promise.race([done, client.closed]);
        } finally {
          stop();
          process.off("SIGINT", finish);
          process.off("SIGTERM", finish);
        }
        break;
      }
    }
  } finally {
    await client.close();
  }
}
main().catch((error) => {
  console.error(
    `werk: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
