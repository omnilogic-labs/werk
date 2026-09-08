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
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Command, InvalidArgumentError } from "@commander-js/extra-typings";
import type { SessionInfo } from "@werk/session";
import {
  createLocalWorktreeMaker,
  formatWorkspaceReference,
  workspaceReference,
  type Workspace,
  type WorkspaceMaker,
} from "@werk/workspace";
import { childCommand, withContext } from "./shared.js";
import { defineCommand } from "./define.js";
import { attachSession } from "./attach.js";
import { collectLabel } from "./list.js";
import { result } from "../runtime/output.js";
import { connectDaemon } from "../runtime/daemon.js";
import { reportedSize, type WerkContext } from "../runtime/context.js";
import { clientEnvironment } from "../environment.js";
import { DETACH_HINT, sessionArea } from "../view.js";

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
 * Where werk puts the workspaces it makes. It hangs off the state directory
 * rather than off a setting of its own, so `--state-dir` and a `stateDir` in a
 * config file already move it and no configuration key has to be invented for
 * a package that is still finding its shape.
 */
export const workspaceRoot = (ctx: WerkContext): string =>
  path.join(ctx.stateDir, "workspaces");

/**
 * The kind of workspace the CLI makes today. `@werk/workspace` also describes
 * one on a machine reached over ssh, and nothing here reaches a machine yet.
 */
export const workspaceMakerFor = (ctx: WerkContext): WorkspaceMaker =>
  createLocalWorktreeMaker({ root: workspaceRoot(ctx) });

/** Characters a branch and a directory leaf both carry without being escaped. */
const unsafe = /[^A-Za-z0-9._-]/g;

/**
 * What the workspace is called.
 *
 * `--workspace` is taken as typed, so a person who names their branch gets the
 * branch they named and a second `create` under the same name is the conflict
 * it looks like. Everything else is generated here, in the client, because the
 * workspace exists before any daemon has been asked for a session and so has
 * no session name to borrow.
 *
 * The generated form is a readable leaf and a digest, the same shape
 * `repositorySlot` uses for a repository's directory: `claude-a3f2b1c9` says
 * what is running in `git branch` output, and the suffix is what lets
 * `werk create -- claude` be run twice in one repository. The digest is what
 * makes a workspace the shortest unique thing on a `werk list` row, which is
 * why `attach` takes one.
 */
export function workspaceNameFor(
  opts: { workspace?: string; name?: string },
  argv: readonly string[],
): string {
  if (opts.workspace !== undefined) return opts.workspace;
  const leaf = path
    .basename(opts.name ?? argv[0] ?? "")
    .replace(unsafe, "-")
    // `..` is refused by the workspace name rule, and a leading dot or dash is
    // not a first character a branch and a directory both accept.
    .replace(/\.{2,}/g, ".")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 32);
  return `${leaf === "" ? "workspace" : leaf}-${randomBytes(4).toString("hex")}`;
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
    ...(hint ? [`werk attach ${info.id}`] : []),
  ].join("\n");
}
export function buildCreate(): Command {
  return defineCommand({
    name: "create",
    summary: "Start a session running a command",
    description:
      "Start a command under the daemon and attach to it. It gets a " +
      "workspace of its own: a git worktree of the repository you are standing " +
      "in, on a new branch. Put the command after --. werk does not parse " +
      "anything after that, so the child keeps its own flags. The session " +
      "outlives the terminal that started it, and `werk attach` goes back to " +
      "it. --detach starts the session and returns instead. --json does the " +
      "same, because the session's output and the one JSON value cannot share " +
      "stdout.",
    usage: "[options] -- COMMAND [ARGS...]",
    examples: [
      {
        run: "werk create -- /bin/sh",
        note: "a shell in a new workspace; werk names the session and the workspace",
      },
      { run: "werk create --name demo --label project=werk -- claude" },
      { run: "werk create --scrollback 2000000 -- npm run dev" },
      {
        run: "werk create --workspace fix-login -- claude",
        note: "choose the workspace name, which is also the branch name",
      },
      {
        run: "werk create --detach -- npm run dev",
        note: "start it and come back later",
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
      "--workspace <NAME>",
      "name the workspace and its branch; werk generates one otherwise",
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
          // Before the daemon, deliberately: a workspace that cannot be made is
          // a failure that should not have started a daemon on its way to being
          // reported. Nothing removes the worktree if the session then fails to
          // start — rolling a half-made workspace back is one of the things
          // `docs/workspaces-and-git.md` leaves open.
          const workspace = await workspaceMakerFor(ctx).create({
            name: workspaceNameFor(opts, argv),
            from: { kind: "local-checkout", path: here },
          });
          // `--json` does not attach, and does not have to say so: the caller
          // asked for the record and got the whole of it. The session's own
          // bytes are what an attachment writes to stdout, and one stream
          // cannot carry both and still be the single value the machine
          // register promises.
          const detached = opts.detach === true || ctx.json;
          const window = windowSize(opts);
          const daemon = await connectDaemon(ctx);
          const { client } = daemon;
          try {
            const info = await client.create({
              argv: [...argv],
              env: clientEnvironment(),
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
            if (detached)
              return result(
                {
                  ...info,
                  workspace: {
                    name: workspace.name,
                    directory: workspace.directory,
                    branch: workspace.branch,
                    // The one notation, so a caller reading this record and a
                    // person reading the chrome are looking at one spelling.
                    reference: formatWorkspaceReference(
                      workspaceReference(workspace),
                      "full",
                    ),
                  },
                },
                (c) => renderCreated(info, c, workspace, true),
              );
            // The summary is status rather than session output, so it goes to
            // stderr for the reason `attach`'s outcome note does: a piped
            // stdout then carries only the screen. It is written here rather
            // than returned because `withContext` prints a returned value after
            // the action finishes, which for this one is after the detach.
            ctx.writeError(renderCreated(info, ctx, workspace, false) + "\n");
            await attachSession(ctx, client, info.id, {});
          } finally {
            await daemon.close();
          }
        },
      ),
    );
}
