/**
 * Opening a file from inside a session, in the editor on the machine the
 * person is sitting at.
 *
 * This is the one command meant to be run from inside a session rather than at
 * the machine somebody is typing at, which is what makes it read its session
 * from `WERK_SESSION` instead of taking one: the daemon puts that variable in
 * every session's environment, so the process asking already knows which
 * session it is in and nothing has to be passed down through a shell.
 *
 * No file content moves. What is sent is a path on this machine, and whoever
 * is attached opens it with a command of their own — `code --remote
 * ssh-remote+beast /path/on/beast` in the default configuration. That is why
 * this can work across three machines when no `$EDITOR` string can: the editor
 * reaches the file itself over ssh rather than something carrying it back.
 *
 * The daemon it talks to is the one on this machine, always. The session is a
 * record that daemon holds, and `--host` would name somebody else's.
 */
import path from "node:path";
import { Argument, Command } from "@commander-js/extra-typings";
import type { OpenOutcome } from "@werk/session";
import { withContext } from "./shared.js";
import { defineCommand } from "./define.js";
import { connectDaemon } from "../runtime/daemon.js";
import { UsageError } from "../runtime/exit.js";
import { result } from "../runtime/output.js";
import type { WerkContext } from "../runtime/context.js";

/**
 * How long to wait for the answer to a `--wait`.
 *
 * The daemon holds the request until a client reports the file finished, and
 * it reports the bound it holds it for, so the deadline here is that bound and
 * a little more: whichever of the two expires first should be the daemon's, so
 * the failure says what actually happened instead of a bare client timeout.
 */
const WAIT_SLACK_MS = 5000;
export function waitTimeoutMs(capabilities: Record<string, unknown>): number {
  const bound = capabilities.openWaitMs;
  return (
    (typeof bound === "number" && Number.isFinite(bound) && bound > 0
      ? bound
      : 60 * 60 * 1000) + WAIT_SLACK_MS
  );
}

/** What a person is told about an open that was accepted. */
export function renderOpen(
  outcome: OpenOutcome,
  file: string,
  ctx: WerkContext,
): string {
  const who =
    outcome.attachments === 1
      ? "1 attached client"
      : `${outcome.attachments} attached clients`;
  return outcome.finished
    ? `${ctx.style.emphasis(file)} was opened and reported finished`
    : `asked ${who} to open ${ctx.style.emphasis(file)}`;
}

export function buildEdit(): Command {
  const edit: Command = defineCommand({
    name: "edit",
    summary: "Open a file from inside this session, where you are sitting",
    description:
      "Ask whoever is attached to this session to open a file in their own " +
      "editor. Run it from inside a session: it reads WERK_SESSION from its " +
      "environment, resolves the path on this machine, and sends the path — " +
      "never the file — to the daemon here, which relays it to every " +
      "attached client. What a client does with it is its `editor` setting.",
    examples: [
      { run: "werk edit src/main.ts" },
      {
        run: "werk edit --wait CHANGELOG.md",
        note: "return once the client says it has finished",
      },
      {
        run: 'EDITOR="werk edit --wait" git commit',
        note: "what makes a commit message editable from a laptop",
      },
    ],
    notes:
      "--wait returns when the attached client's editor command exits. " +
      "Whether that means the file was closed is the editor's business: " +
      "VS Code needs its own --wait in the `editor` setting, and whether " +
      "that composes with --remote is untested. Nothing attached is a " +
      "refusal rather than a wait, because somebody who has detached cannot " +
      "open anything.",
  });
  edit
    .addArgument(
      new Argument("<path>", "the file to open, as a path on this machine"),
    )
    .option("--wait", "wait until the client reports it has finished")
    .action(
      withContext(async (ctx, opts: { wait?: boolean }, given: string) => {
        const session = process.env.WERK_SESSION;
        if (!session)
          throw new UsageError(
            "werk edit runs inside a werk session, and WERK_SESSION is not set here",
          );
        // The session belongs to the daemon on this machine, so a --host would
        // name a machine that has never heard of it.
        if (ctx.requestedHost !== undefined)
          throw new UsageError(
            "werk edit acts on the session it is running in, so it takes no --host",
          );
        // Absolute, because it is read on a machine that is not this one and
        // has no idea what directory this command was typed in.
        const file = path.resolve(given);
        const daemon = await connectDaemon(ctx);
        try {
          const outcome = await daemon.client.openPath(session, file, {
            wait: opts.wait === true,
            ...(opts.wait === true
              ? { timeoutMs: waitTimeoutMs(daemon.client.daemon.capabilities) }
              : {}),
          });
          // A client that could not open it has reported why, and whoever ran
          // $EDITOR is entitled to a status that says the same.
          if (outcome.error)
            throw new Error(`could not open ${file}: ${outcome.error}`);
          return result(outcome, (c) => renderOpen(outcome, file, c));
        } finally {
          await daemon.close();
        }
      }),
    );
  return edit;
}
