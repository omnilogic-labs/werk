/**
 * Starting a session, and going straight into it.
 *
 * Creating and attaching are one gesture: the session is started and then this
 * command hands the terminal to it, by calling the attachment `attach` already
 * owns rather than growing a second one. `--detach` starts it and returns, and
 * `--json` does the same, because a machine asked for the record and the
 * session's own bytes cannot share that stream with it.
 *
 * The command werk runs is not an argument: it is everything after `--`, split
 * off before commander sees the argv (see `runtime/argv.ts`), so a child's own
 * flags can never be mistaken for werk's. This command therefore takes no
 * positional at all and reads the child's argv from the same place `main.ts` put
 * it.
 */
import path from "node:path";
import { Command, InvalidArgumentError } from "@commander-js/extra-typings";
import type { SessionInfo } from "@werk/session";
import {
  formatWorkspaceReference,
  workspaceRecords,
  workspaceReference,
  WorkspaceError,
  type CreateWorkspaceOptions,
  type Workspace,
  type WorkspaceMaker,
  type WorkspaceSource,
} from "@werk/workspace";
import { childCommand, withContext } from "./shared.js";
import { defineCommand } from "./define.js";
import { attachSession } from "./attach.js";
import { collectLabel } from "./list.js";
import { result } from "../runtime/output.js";
import { connectDaemon } from "../runtime/daemon.js";
import { createProgress } from "../runtime/progress.js";
import { CancelledError } from "../runtime/exit.js";
import { reachHost, workspaceMakerFor } from "../host/place.js";
import { reportedSize, type WerkContext } from "../runtime/context.js";
import { canPrompt, text, type PromptOptions } from "../runtime/interactive.js";
import { workspaceNames } from "../workspace-name.js";
import { clientEnvironment, remoteEnvironment } from "../environment.js";
import { DETACH_HINT, sessionArea } from "../view.js";
import { gitToplevel } from "../config/load.js";

/**
 * A count, rejected here rather than by the daemon so the message names the flag
 * the caller typed. `Number` is deliberate: it takes `0x40` and `1e3` as well as
 * decimal, and everything it cannot read becomes NaN, which is not an integer.
 *
 * `InvalidArgumentError` is the one commander catches. Anything else thrown from
 * an option parser is rethrown raw out of `_callParseArg`, escaping the parse
 * with no usage and no help attached; as commander's own error the flag, the
 * value it could not read and this sentence are reported together.
 */
export function wholeNumber(flag: string, unit = "") {
  return (raw: string): number => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0)
      throw new InvalidArgumentError(`${flag} must be a whole number${unit}`);
    return value;
  };
}
/** What a terminal is given when it does not report a size werk can use. */
const FALLBACK_WINDOW = { cols: 80, rows: 24 };
/**
 * The grid a session starts at, or the window an attachment assumes. The flags
 * answer first, then the terminal, then 80x24 for a pipe and for a terminal
 * that cannot say how big it is.
 *
 * The reported size is a parameter rather than read here, so a test can hand it
 * the zero grid a real pty reports when its size was never set. That zero is
 * why `reportedSize` is used instead of `??`: the daemon's `sizeValid` wants
 * both dimensions above zero, so a bare `??` would send `create` and `attach` a
 * grid it refuses, on exactly the terminals the same guard in `context.ts` was
 * written to defend.
 *
 * An explicit `--cols 0` is left alone and still reaches the daemon, because
 * `wholeNumber` accepts zero on purpose and reinterpreting what somebody typed
 * would be worse than the refusal they get.
 */
export function windowSize(
  opts: { cols?: number; rows?: number },
  reported: { columns?: number; rows?: number } = process.stdout,
) {
  return {
    cols: opts.cols ?? reportedSize(reported.columns, FALLBACK_WINDOW.cols),
    rows: opts.rows ?? reportedSize(reported.rows, FALLBACK_WINDOW.rows),
  };
}
/**
 * What the work is going to be, in the person's own words.
 *
 * A workspace is a place to do one thing, and the person starting it is the
 * only one who knows what that thing is. So werk asks, and turns the answer
 * into the name: it is a better name than anything derivable from the command
 * line, where every session looks like `claude` or `/bin/sh`.
 *
 * Asking is skipped rather than refused wherever it would not help. `--workspace`
 * has already settled the name, so the answer would change nothing.
 * `--describe` is the same question answered in advance, which is what makes
 * the naming reachable from a script. `--json` is the machine register, where a
 * question drawn on stderr while one value goes to stdout is at best a
 * surprise. And `canPrompt` is the guard that keeps a pipe or a CI job from
 * waiting on a question nobody will ever see.
 *
 * An empty answer is an answer: it means "name it for me", and the sequence
 * below makes one up.
 */
export async function describeWork(
  ctx: WerkContext,
  opts: { workspace?: string; describe?: string },
  options: PromptOptions = {},
): Promise<string | undefined> {
  if (opts.describe !== undefined) return opts.describe;
  if (opts.workspace !== undefined) return undefined;
  if (ctx.json || !canPrompt(ctx)) return undefined;
  return await text(
    ctx,
    {
      message: "What is this workspace for?",
      placeholder: "a line about the work, or enter alone for a made-up name",
      defaultValue: "",
    },
    options,
  );
}

/** How many names a generated one is allowed to be before `create` gives up. */
export const NAME_ATTEMPTS = 5;

/**
 * A name somebody else already has. Both codes mean the same thing to a caller
 * holding more names — the branch is there, or the directory is — and the ssh
 * maker reports them under the same two words as the local one.
 */
const taken = (error: unknown): boolean =>
  error instanceof WorkspaceError &&
  (error.code === "BRANCH_EXISTS" || error.code === "DIRECTORY_EXISTS");

/**
 * The workspace, made under the first name the maker will take.
 *
 * Nothing records which workspaces exist, so there is no list to check a name
 * against and the maker is the only thing that knows. It refuses a taken name
 * before it changes anything — the branch and the directory are both looked for
 * first — so trying the next name costs a couple of git calls and leaves
 * nothing behind.
 *
 * A refusal is only ever swallowed while there is another name to try, so what
 * reaches the caller is the last one: `--workspace fix-login` twice is a
 * sequence of one name and one conflict, reported as the conflict it is.
 */
export async function makeWorkspace(
  maker: WorkspaceMaker,
  names: Iterable<string>,
  from: WorkspaceSource,
  options: CreateWorkspaceOptions,
): Promise<Workspace> {
  let attempts = 0;
  let refused: unknown;
  for (const name of names) {
    attempts += 1;
    try {
      return await maker.create({ name, from }, options);
    } catch (error) {
      if (!taken(error) || attempts >= NAME_ATTEMPTS) throw error;
      refused = error;
    }
  }
  // The sequence ran out, which only a typed name does. The second half is for
  // the type: `workspaceNames` always offers at least one name.
  throw (
    refused ??
    new WorkspaceError("INVALID_NAME", "no workspace name was offered")
  );
}

/**
 * The workspace as `--json` reports it.
 *
 * `host` is absent for a workspace on this machine, which is the same thing
 * `Workspace.host` says by being absent: the lean recorded in question 23 is
 * that no host reads as "here", and inventing `"local"` here would answer it.
 * The reference is the one notation, at `full`, so a caller reading this record
 * and a person reading the chrome are looking at one spelling.
 */
export function workspaceRecord(workspace: Workspace) {
  return {
    name: workspace.name,
    directory: workspace.directory,
    branch: workspace.branch,
    // The branch it came from, which is what `werk land` puts it back on. Null
    // rather than absent when the checkout was on a detached HEAD: there was
    // no branch to name, and a reader of the record should be told that rather
    // than left to wonder whether werk forgot.
    parent: workspace.parent ?? null,
    base: workspace.base,
    ...(workspace.host === undefined ? {} : { host: workspace.host }),
    reference: formatWorkspaceReference(workspaceReference(workspace), "full"),
  };
}

/**
 * Write down what was just made, so that `werk land` can find it later.
 *
 * The record goes with the client that made it, under its own state directory,
 * keyed by the checkout the workspace was derived from. It holds the one fact
 * that cannot be recovered afterwards: which branch the workspace came from.
 * The costs of keeping it here rather than on the host are
 * [question 19](../../../../docs/open-questions.md#19-where-does-the-record-of-a-workspace-live).
 *
 * A record that cannot be written is said and not raised. The workspace exists
 * and the session is about to start in it; failing the create because a JSON
 * file would not save would throw away work that was already done, and what is
 * lost is that `werk land` will not find it by name.
 */
async function remember(
  ctx: WerkContext,
  workspace: Workspace,
  source: string,
): Promise<void> {
  try {
    const toplevel = gitToplevel(source);
    if (toplevel === undefined) return;
    await workspaceRecords(path.join(ctx.stateDir, "workspaces"), toplevel).put(
      {
        name: workspace.name,
        directory: workspace.directory,
        branch: workspace.branch,
        ...(workspace.parent === undefined ? {} : { parent: workspace.parent }),
        base: workspace.base,
        source: toplevel,
        ...(workspace.host === undefined ? {} : { host: workspace.host }),
        createdAt: Date.now(),
      },
    );
  } catch (error) {
    ctx.writeError(
      `${ctx.style.warning("werk could not write down this workspace")}, so \`werk land ${workspace.name}\` will not find it: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

/**
 * What a person is told once the daemon has the session.
 *
 * `hint` is whether to say how to come back, which is only worth saying to
 * somebody who is not about to be put inside it. Attached, the last line would
 * be advice about a thing already happening.
 */
export function renderCreated(
  info: SessionInfo,
  ctx: WerkContext,
  workspace: Workspace,
  hint: boolean,
): string {
  return [
    `${ctx.style.success("created")} ${info.id} ${ctx.style.emphasis(info.name)}`,
    // The reference carries the directory, so the size line no longer says it a
    // second time in a second spelling.
    ctx.style.muted(
      `workspace ${formatWorkspaceReference(workspaceReference(workspace), "full")} on branch ${workspace.branch}`,
    ),
    ctx.style.muted(
      `${info.argv.join(" ")} · ${info.size.cols}x${info.size.rows}`,
    ),
    // The command to come back with names the machine when it is not this one:
    // a bare `werk attach` would look at this machine's daemon and find
    // nothing.
    ...(hint
      ? [
          `werk attach${workspace.host === undefined ? "" : ` --host ${workspace.host}`} ${info.id}`,
        ]
      : []),
  ].join("\n");
}
export function buildCreate(): Command {
  return defineCommand({
    name: "create",
    summary: "Start a session running a command",
    description:
      "Start a command under the daemon and attach to it. It gets a " +
      "workspace of its own: a worktree of the repository you are standing " +
      "in, on a new branch. --host puts both on another machine, as a mirror " +
      "of the repository pushed over and a worktree checked out beside it; " +
      "only committed work travels. Put the command after --. werk does not " +
      "parse anything after that, so the child keeps its own flags. The " +
      "session outlives the terminal that started it, and `werk attach` goes " +
      "back to it. --detach starts the session and returns instead. --json " +
      "does the same, because the session's output and the one JSON value " +
      "cannot share stdout. Unless the name is settled by --workspace, werk " +
      "asks what the workspace is for and makes the name out of the answer; " +
      "an empty answer gets a made-up one.",
    usage: "[options] -- COMMAND [ARGS...]",
    examples: [
      {
        run: "werk create -- /bin/sh",
        note: "a shell in a new workspace; werk asks what the workspace is for",
      },
      { run: "werk create --name demo --label project=werk -- claude" },
      { run: "werk create --scrollback 2000000 -- npm run dev" },
      {
        run: 'werk create --describe "fix the login redirect" -- claude',
        note: "answer the question in advance; the workspace is fix-login-redirect",
      },
      {
        run: "werk create --workspace fix-login -- claude",
        note: "choose the workspace name, which is also the branch name",
      },
      {
        run: "werk create --detach -- npm run dev",
        note: "start it and come back later",
      },
      {
        run: "werk create --host beast -- claude",
        note: "on another machine; `werk attach --host beast` goes back to it",
      },
    ],
    notes: `${DETACH_HINT} and leaves the session running.`,
    requires: [
      {
        need: "name the command to run after --, as in `werk create -- claude`",
        met: () => childCommand().length > 0,
      },
    ],
  })
    .option("--detach", "start the session and return instead of attaching")
    .option("--name <NAME>", "name the session; werk generates one otherwise")
    .option(
      "--label <KEY=VALUE>",
      "attach a label; repeat the flag for more",
      collectLabel,
      {},
    )
    .option("--cols <N>", "starting columns", wholeNumber("--cols"))
    .option("--rows <N>", "starting rows", wholeNumber("--rows"))
    .option(
      "--scrollback <BYTES>",
      "how many bytes of scrollback to keep; the daemon rejects a value over its limit",
      wholeNumber("--scrollback", " of bytes"),
    )
    .option("--cwd <PATH>", "which checkout to branch the workspace from")
    .option(
      "--describe <TEXT>",
      "say what the workspace is for; werk makes the name out of it, and asks when neither flag is given",
    )
    .option(
      "--workspace <NAME>",
      "name the workspace and its branch, exactly as typed",
    )
    .action(
      withContext(
        async (
          ctx,
          opts: {
            detach?: boolean;
            name?: string;
            label: Record<string, string>;
            cols?: number;
            rows?: number;
            scrollback?: number;
            cwd?: string;
            describe?: string;
            workspace?: string;
          },
        ) => {
          // That there is a command to run is declared on the spec rather than
          // checked here, so it is reported with everything else wrong with the
          // invocation and the caller sees the usage line and an example.
          const argv = childCommand();
          // The checkout the new branch comes from. `--cwd` says which one; it
          // never says where the command runs, because the command runs in the
          // workspace.
          const here = path.resolve(opts.cwd ?? process.cwd());
          // Which machine, resolved before anything is made, so a mistyped
          // `--host` costs no repository work and no network. Reaching an ssh
          // host starts here, and the probe it kicks off overlaps the workspace
          // below.
          const place = await reachHost(ctx);
          // A local create is instant, so nothing is said about it. The maker
          // reports its stages either way; this only decides who listens.
          const progress =
            place.session === undefined
              ? undefined
              : createProgress(ctx, place.name);
          // Ctrl-C reaches the maker as an abort rather than killing the
          // process where it stands, so a maker that got as far as a branch and
          // a worktree on another machine gets to take them back.
          const cancelling = new AbortController();
          const cancel = () =>
            cancelling.abort(new CancelledError("cancelled"));
          process.once("SIGINT", cancel);
          // `--json` does not attach, and does not have to say so: the caller
          // asked for the record and got the whole of it. The session's own
          // bytes are what an attachment writes to stdout, and one stream
          // cannot carry both and still be the single value the machine
          // register promises.
          const detached = opts.detach === true || ctx.json;
          const window = windowSize(opts);
          let daemon;
          let workspace: Workspace;
          try {
            // Asked here rather than before the machine was reached, so a
            // mistyped `--host` is reported before somebody types a sentence,
            // and inside the `try` so that a cancelled question closes the
            // connection that reaching one opened.
            const description = await describeWork(ctx, opts);
            // Before the daemon, deliberately: a workspace that cannot be made
            // is a failure that should not have started a daemon on its way to
            // being reported. Nothing removes the worktree if the session then
            // fails to start — rolling a half-made workspace back is one of the
            // things `docs/workspaces-and-git.md` leaves open.
            workspace = await makeWorkspace(
              workspaceMakerFor(place),
              workspaceNames(opts.workspace, description),
              { kind: "local-checkout", path: here },
              {
                signal: cancelling.signal,
                ...(progress ? { onProgress: progress.onProgress } : {}),
              },
            );
            // Written down before the daemon is asked for anything: the
            // workspace exists from here on whether or not a session ever
            // starts in it, and a record made only on the happy path would be
            // missing for exactly the workspaces somebody has to clear up.
            await remember(ctx, workspace, here);
            // The connection is under the spinner too. On a machine werk has
            // not been to, this is the install and the daemon start, which is
            // the longest silence there is.
            progress?.say(`reaching the daemon on ${place.name}`);
            daemon = await connectDaemon(ctx, place.session);
          } catch (error) {
            progress?.stop();
            await place.close().catch(() => {});
            throw error;
          } finally {
            process.off("SIGINT", cancel);
          }
          const { client } = daemon;
          try {
            const info = await client.create({
              argv: [...argv],
              // A denylist is affordable to a daemon on this machine and not to
              // one on another: `clientEnvironment` would carry every
              // credential in this shell across a machine boundary, and its
              // `PATH` and `HOME` would be lies about the far side anyway.
              env:
                place.session === undefined
                  ? clientEnvironment()
                  : remoteEnvironment(),
              cwd: workspace.directory,
              // An attachment on a terminal holds the grid and resizes it to
              // the window less the chrome row as soon as it arrives, so the
              // session is asked for that grid now rather than being resized
              // before the child has drawn anything.
              size: !detached && ctx.stdoutTTY ? sessionArea(window) : window,
              // The flag answers first, then the resolved setting. Without the
              // second half `scrollbackBytes` would be a key `werk config`
              // reports from a file layer while nothing acted on it.
              scrollbackBytes: opts.scrollback ?? ctx.scrollbackBytes,
              name: opts.name,
              labels: opts.label,
            });
            // Before anything is printed, and well before an attachment takes
            // the alternate screen.
            progress?.stop();
            if (detached)
              return result(
                { ...info, workspace: workspaceRecord(workspace) },
                (c) => renderCreated(info, c, workspace, true),
              );
            // The summary is status rather than session output, so it goes to
            // stderr for the reason `attach`'s outcome note does: a piped
            // stdout then carries only the screen. It is written here rather
            // than returned because `withContext` prints a returned value after
            // the action finishes, which for this one is after the detach.
            ctx.writeError(renderCreated(info, ctx, workspace, false) + "\n");
            await attachSession(ctx, client, info.id, {}, place);
          } finally {
            progress?.stop();
            await daemon.close();
            await place.close().catch(() => {});
          }
        },
      ),
    );
}
