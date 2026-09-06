#!/usr/bin/env bun
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  connectSessionClient,
  type SessionClient,
  type Attachment,
  type TerminationIntent,
} from "@werk/session";
import {
  ensureSessionDaemon,
  openLocalTransport,
  serveSessionDaemon,
} from "@werk/session-daemon";
import { loadTerminalEngine } from "@werk/terminal/bun";
import {
  createTerminalReplica,
  type Renderer,
  type Frame,
} from "@werk/terminal";
declare const WERK_COMPILED: boolean;
const usage = `werk <create|list|attach|logs|kill|remove|watch|info|session-daemon>

  create [--name NAME] [--label KEY=VALUE] [--cols N --rows N] -- COMMAND [ARGS...]
  list [--label KEY=VALUE]             List sessions as JSON
  attach ID [--read-only]             Attach; Ctrl-] detaches
  logs ID [--history]                 Read retained screen or history
  kill ID [--intent interrupt|terminate|force]
  remove ID                          Remove a retained record
  watch                              Print daemon events as JSON lines
  info                               Print daemon identity and capabilities
  session-daemon                     Serve the daemon in this process

All commands accept --runtime-dir PATH and --state-dir PATH.
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
  const booleans = new Set(["read-only", "history", "help"]);
  const valued = new Set([
    "runtime-dir",
    "state-dir",
    "name",
    "label",
    "cols",
    "rows",
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
function size(a: Arguments) {
  return {
    cols: Number(a.flags.get("cols") ?? process.stdout.columns ?? 80),
    rows: Number(a.flags.get("rows") ?? process.stdout.rows ?? 24),
  };
}
function terminalRenderer(): Renderer {
  let ended = false;
  return {
    paint(frame: Frame) {
      if (ended) return;
      let out = "\x1b[?25l\x1b[?7l";
      for (const row of frame.changed) {
        out += `\x1b[${row.y + 1};1H`;
        for (const c of row.cells) {
          if (c.width === 0) continue;
          const fg = c.inverse ? c.bg : c.fg,
            bg = c.inverse ? c.fg : c.bg;
          out += `\x1b[0;38;2;${fg >> 16};${(fg >> 8) & 255};${fg & 255};48;2;${bg >> 16};${(bg >> 8) & 255};${bg & 255}${c.bold ? ";1" : ""}${c.italic ? ";3" : ""}${c.underline ? ";4" : ""}${c.strikethrough ? ";9" : ""}m${c.text || " "}`;
        }
      }
      out +=
        "\x1b[0m" +
        `\x1b[${frame.cursor.y + 1};${frame.cursor.x + 1}H` +
        (frame.cursor.visible ? "\x1b[?25h" : "");
      process.stdout.write(out);
    },
    dispose() {
      if (ended) return;
      ended = true;
      process.stdout.write("\x1b[0m\x1b[?25h\x1b[?7h");
    },
  };
}
async function attach(client: SessionClient, id: string, args: Arguments) {
  const tty = !!process.stdout.isTTY,
    replica = createTerminalReplica(
      await loadTerminalEngine(),
      tty ? terminalRenderer() : undefined,
    );
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
  let pending = Promise.resolve();
  const input = (data: Buffer) => {
    if (stopped) return;
    const at = data.indexOf(29);
    const bytes = at < 0 ? data : data.subarray(0, at);
    if (bytes.length && !args.flags.has("read-only")) {
      process.stdin.pause();
      pending = pending
        .then(async () => {
          // Keep one acknowledged request in flight and copy Buffer-backed data.
          for (let offset = 0; offset < bytes.length; offset += 16384)
            await attachment!.writeInput(
              new Uint8Array(bytes.subarray(offset, offset + 16384)),
            );
        })
        .then(() => {
          if (at < 0 && !stopped) process.stdin.resume();
        })
        .catch((e) => {
          error = e;
          finish();
        });
    }
    if (at >= 0) finish();
  };
  const resize = () => {
    if (attachment?.holdsSize)
      void attachment.resize(size(args)).catch((e) => {
        error = e;
        finish();
      });
  };
  const stop = () => finish();
  try {
    if (tty) process.stdout.write("\x1b[?1049h\x1b[2J");
    attachment = await client.attach(id, {
      representation: "snapshot",
      permissions: { read: true, input: !args.flags.has("read-only") },
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
            if (event.type === "ended") finish();
          })
          .catch((e) => {
            error = e;
            finish();
          });
      },
    });
    if (attachment.holdsSize) await attachment.resize(size(args));
    process.stdin.on("data", input);
    process.stdin.once("end", stop);
    process.stdout.on("resize", resize);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    await Promise.race([finished, client.closed]);
    await pending;
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
    "session-daemon",
  ]);
  if (!known.has(args.verb)) throw new Error(`Unknown command ${args.verb}`);
  const runtimeDir = path.resolve(
    args.flags.get("runtime-dir") ??
      path.join(
        process.env.XDG_RUNTIME_DIR ?? os.tmpdir(),
        `werk-${process.getuid?.() ?? os.userInfo().username}`,
      ),
  );
  const stateDir = path.resolve(
    args.flags.get("state-dir") ??
      path.join(
        process.env.XDG_STATE_HOME ??
          path.join(os.homedir(), ".local", "state"),
        "werk",
      ),
  );
  if (args.verb === "session-daemon") {
    const daemon = await serveSessionDaemon({
      runtimeDir,
      stateDir,
      engineFactory: await loadTerminalEngine(),
    });
    const pid = path.join(runtimeDir, "daemon.pid");
    await fs.writeFile(pid, String(process.pid), { mode: 0o600 });
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      try {
        await daemon.close();
      } finally {
        await fs.rm(pid, { force: true });
        process.off("SIGINT", close);
        process.off("SIGTERM", close);
      }
    };
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
    return;
  }
  if (
    ["attach", "logs", "kill", "remove"].includes(args.verb) &&
    !args.positionals[0]
  )
    throw new Error(`${args.verb} requires a session ID`);
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
            cwd: path.resolve(args.flags.get("cwd") ?? process.cwd()),
            size: size(args),
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
