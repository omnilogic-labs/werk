/**
 * Going back to a session.
 *
 * This is the only command that owns the terminal: it takes the alternate
 * screen, puts stdin in raw mode, paints frames through a local replica and
 * gives all of it back on the way out. What gives it back goes on first: the
 * signal handlers are registered before anything is taken, and detaching is
 * allowed to win the race against reaching the daemon, so there is no window in
 * which a terminal can be left on the alternate screen. It streams rather than
 * returning a value,
 * so it opts out of the `Result` seam — under `--json` there is nothing to
 * print, because the session's own output is the output.
 *
 * Without a terminal the same attachment still works: the screen and then the
 * live output go to stdout as plain bytes, which is what makes `werk attach ID`
 * usable in a pipe.
 */
import { Command } from "@commander-js/extra-typings";
import {
  type Attachment,
  type EndReason,
  type ExitOutcome,
  type HoldSize,
  type SessionClient,
} from "@werk/session";
import { createTerminalReplica } from "@werk/terminal";
import { loadTerminalEngine } from "@werk/terminal/bun";
import { withContext } from "./shared.js";
import { defineCommand } from "./define.js";
import { editorArgv, editorHost } from "../editor.js";
import { wholeNumber, windowSize } from "./create.js";
import { workspaceAt } from "@werk/workspace";
import { sessionArgument, withSession } from "./session-argument.js";
import type { HostPlace } from "../host/place.js";
import type { WerkContext } from "../runtime/context.js";
import {
  createInputPump,
  inputSliceBytes,
  INPUT_CHUNK_BYTES,
  type InputPump,
} from "../input.js";
import {
  createViewRenderer,
  sessionArea,
  type ViewRenderer,
  type ViewState,
} from "../view.js";

/** Ctrl-] — the byte that ends the attachment rather than reaching the session. */
const DETACH_BYTE = 29;

export interface AttachFlags {
  readOnly?: boolean;
  follow?: boolean;
  claimSize?: boolean;
  cols?: number;
  rows?: number;
}
/**
 * How a session that was already over is described once the screen is torn down.
 * A `lost` record has no outcome to report, because the daemon never saw the
 * process finish.
 */
export function outcomeNote(
  id: string,
  exit: ExitOutcome | undefined,
  state?: string,
): string {
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
export function sizeIntent(flags: AttachFlags): HoldSize {
  if (flags.follow) return "never";
  if (flags.claimSize) return "claim";
  return flags.readOnly ? "never" : "if-free";
}
/**
 * What a person is told when a remote daemon's connection goes away under them.
 *
 * "Connection closed" is the commonest remote fault and the least useful thing
 * to read: a forward pointed at a missing socket comes up fine and then ends
 * the stream at once, so the message has to say which machine went and that the
 * work is still on it. The command to get back names the host, because a bare
 * `werk attach` would look on this machine.
 */
export const remoteDropNote = (host: string, id: string): string =>
  `lost the connection to ${host}. The session is still running there — ` +
  `\`werk attach --host ${host} ${id}\``;

export async function attachSession(
  ctx: WerkContext,
  client: SessionClient,
  id: string,
  flags: AttachFlags,
  place: HostPlace,
): Promise<void> {
  const tty = ctx.stdoutTTY;
  const window = () => windowSize(flags);
  // The chrome costs the bottom local row, so the grid this attachment asks the
  // session for is the window less that row. Without a terminal there is no
  // chrome to make room for and the session gets the whole window, which is what
  // keeps a piped attachment carrying every row it was going to.
  const target = () => (tty ? sessionArea(window()) : window());
  const state: ViewState = {
    writable: !flags.readOnly,
    holdsSize: false,
    claimed: flags.claimSize === true,
    follow: flags.follow === true,
    // The id is what the chrome shows until the name arrives, and what it keeps
    // showing if the name never does.
    name: id,
  };
  const view: ViewRenderer | undefined = tty
    ? createViewRenderer({
        write: (data) => ctx.write(data),
        window,
        state: () => state,
      })
    : undefined;
  const replica = createTerminalReplica(await loadTerminalEngine(), view);
  // What this attachment could not do, said once the alternate screen is gone.
  // Saying it while attached would paint over the session.
  const notes: string[] = [];
  /**
   * Open a path the session asked for, on this machine.
   *
   * The configured command is split into words before `{host}` and `{path}`
   * are filled in, so a path with a space, a quote or a semicolon in it is one
   * argument and can never become a second command; see `editor.ts`. There is
   * no shell here: the argv is handed to the operating system.
   *
   * The child gets none of this terminal. Standard input and output are thrown
   * away, because this attachment owns the alternate screen and the keyboard
   * and a program writing into either would paint over the session, and
   * standard error is kept and drained so a failure has something to say and a
   * chatty editor cannot fill a pipe and stop.
   */
  async function openLocally(event: {
    openId: string;
    path: string;
    wait: boolean;
  }): Promise<void> {
    let failure: string | undefined;
    try {
      const argv = editorArgv(ctx.editor, {
        host: editorHost(place.host),
        path: event.path,
      });
      const child = Bun.spawn(argv, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      const [status, said] = await Promise.all([
        child.exited,
        new Response(child.stderr as ReadableStream).text(),
      ]);
      const first = said.trim().split("\n")[0];
      if (status !== 0)
        failure = `${argv[0]} exited with status ${status}${first ? `: ${first}` : ""}`;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure) notes.push(`could not open ${event.path}: ${failure}`);
    // Only a caller that asked to wait is owed an answer; without one the
    // daemon has already told it the request was taken.
    if (event.wait)
      await client.finishOpen(event.openId, failure).catch(() => {});
  }
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
  let dropped = false;
  let outcome: ExitOutcome | undefined;
  let endReason: EndReason | undefined;
  let pump!: InputPump;
  const input = (data: Buffer) => {
    if (stopped) return;
    const at = data.indexOf(DETACH_BYTE);
    const bytes = at < 0 ? data : data.subarray(0, at);
    if (bytes.length && !flags.readOnly) pump.offer(bytes);
    // Detaching stops reading; the bytes already offered still drain below.
    if (at >= 0) finish();
  };
  const fitSession = () => {
    if (!attachment?.holdsSize) return;
    void attachment.resize(target()).catch((e) => {
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
    // Before the screen rather than after the attach. Reaching the daemon can
    // take a moment, and longer when one has to be started; a signal arriving
    // in that window would otherwise take Node's default disposition and leave
    // the terminal on the alternate screen with the session's paint on it.
    // These are `once`, so a second signal still ends the process, which is the
    // way out if the daemon never answers at all.
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (tty) ctx.write("\x1b[?1049h\x1b[2J");
    // The name is chrome, not a precondition. The lookup runs alongside the
    // attach rather than before it, a failure leaves the id in place, and a
    // reply that arrives after the screen is gone repaints nothing.
    if (tty)
      void client.get(id).then(
        (info) => {
          if (info.name) state.name = info.name;
          // The directory the session was started in is the workspace, when
          // this host's layout is what put it there. A session started
          // somewhere else recovers none and the chrome keeps the name.
          state.workspace = workspaceAt(place.root, info.cwd, place.reference);
          state.cwd = info.reportedCwd;
          view?.refresh();
        },
        () => {},
      );
    const attaching = client.attach(id, {
      representation: "snapshot",
      permissions: { read: true, input: state.writable },
      holdSize: sizeIntent(flags),
      onEvent(event) {
        void replica
          .apply(event)
          .then(() => {
            if (!tty) {
              if (event.type === "snapshot" || event.type === "resync")
                ctx.write(replica.readScreen());
              // Session output is bytes and goes out as bytes: decoding it here
              // would mangle anything that is not this process's own encoding.
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
            // A shell that reports where it has moved to keeps the chrome
            // current; the daemon records the same effect on the session.
            if (event.type === "effect" && event.effect.kind === "cwd") {
              state.cwd = String(event.effect.payload);
              view?.refresh();
            }
            // The work is on this machine and takes as long as an editor
            // takes, so it runs beside the stream rather than in it.
            if (event.type === "open") void openLocally(event);
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
    // Detaching is allowed to win the race. Waiting the attach out would mean
    // Ctrl-C did nothing until the daemon answered, which is the same hang from
    // the other side.
    attachment = await Promise.race([
      attaching,
      finished.then(() => undefined),
    ]);
    if (!attachment) {
      // The attachment may still arrive, with nobody left to read it, so it is
      // given back to the daemon rather than left holding a size.
      void attaching.then(
        (late) => void late.detach().catch(() => {}),
        () => {},
      );
      return;
    }
    // Nobody need hold the size: a `--follow` or read-only attach leaves the
    // grid wherever it was, which is exactly the case the view clips.
    state.holdsSize = attachment.holdsSize;
    view?.refresh();
    if (attachment.holdsSize) await attachment.resize(target());
    // Clamp the slice so one slice is one request; see inputSliceBytes. A frame
    // budget too small to carry input raises LIMIT here rather than swallowing
    // the first keystroke, and read-only attachments never ask.
    const slice = flags.readOnly
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
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    // Which of the two ended it matters afterwards: a connection that went
    // away is a different thing to say from a session that finished or a
    // person who pressed Ctrl-]. The client turns a transport that closed into
    // an `ended` event with that reason, so the flag below is usually set from
    // there; the race is what catches a connection that went before any
    // attachment did.
    dropped = await Promise.race([
      finished.then(() => endReason === "connection-closed"),
      client.closed.then(() => true),
    ]);
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
    if (tty) ctx.write("\x1b[?1049l");
  }
  // The alternate screen is gone by here, and the note is status rather than
  // session output, so it goes to stderr and leaves piped stdout carrying only
  // the screen.
  if (endReason === "session-ended") {
    let recorded: string | undefined;
    if (!outcome)
      recorded = await client.get(id).then(
        (s) => s.state,
        () => undefined,
      );
    ctx.writeError(`werk: ${outcomeNote(id, outcome, recorded)}\n`);
  }
  for (const note of notes) ctx.writeError(`werk: ${note}\n`);
  if (dropped && place.reference !== undefined)
    ctx.writeError(`werk: ${remoteDropNote(place.reference, id)}\n`);
}
export function buildAttach(): Command {
  // Typed as the widened `Command` the command table holds: declaring a
  // positional puts it in commander's generics, and every method here mutates
  // and returns the same object, so the chain need not carry the type back.
  const attach: Command = defineCommand({
    name: "attach",
    summary: "Go back to a running session; Ctrl-] detaches",
    description:
      "Go back to a running session and take over its screen and keyboard. " +
      "Detaching leaves the session running. A session that has already " +
      "finished paints its saved screen, reports how it ended, and returns.",
    examples: [
      { run: "werk attach 8f2c1b04e9d1" },
      {
        run: "werk attach 8f2c1b04e9d1 --read-only",
        note: "watch, do not type",
      },
      {
        run: "werk attach 8f2c1b04e9d1 --claim-size",
        note: "resize the session to this window",
      },
      { run: "werk attach", note: "pick from a list" },
    ],
    notes: "Ctrl-] detaches and leaves the session running.",
    requires: [
      {
        need: "pass --follow or --claim-size, not both: one leaves the session size alone and the other takes it",
        met: (command) => {
          const opts = command.opts() as {
            follow?: boolean;
            claimSize?: boolean;
          };
          return !(opts.follow && opts.claimSize);
        },
      },
    ],
  });
  attach
    .addArgument(sessionArgument())
    .option("--read-only", "watch without asking for input")
    .option(
      "--follow",
      "leave the session size alone and clip the session grid to this window",
    )
    .option("--claim-size", "take the session size from whoever holds it")
    .option(
      "--cols <N>",
      "assume this window width instead of the terminal's",
      wholeNumber("--cols"),
    )
    .option(
      "--rows <N>",
      "assume this window height instead of the terminal's",
      wholeNumber("--rows"),
    )
    .action(
      withContext(async (ctx, opts: AttachFlags, given?: string) => {
        // That --follow and --claim-size are exclusive is declared on the spec,
        // so it is reported with anything else wrong with the invocation and
        // still before a daemon is reached.
        await withSession(
          ctx,
          given,
          "Attach to which session?",
          (client, id, _picked, place) =>
            attachSession(ctx, client, id, opts, place),
        );
      }),
    );
  return attach;
}
