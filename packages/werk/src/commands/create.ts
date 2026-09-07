/**
 * Starting a session.
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
  createLocalWorktreeHost,
  type Workspace,
  type WorkspaceHost,
} from "@werk/workspace";
import { childCommand, withContext } from "./shared.js";
import { defineCommand } from "./define.js";
import { collectLabel } from "./list.js";
import { result } from "../runtime/output.js";
import { connectDaemon } from "../runtime/daemon.js";
import type { WerkContext } from "../runtime/context.js";
import { clientEnvironment } from "../environment.js";

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
/**
 * The grid a session starts at, or the window an attachment assumes. The
 * terminal answers when it is one; 80x24 is what every terminal falls back to
 * and what a pipe has always been given.
 */
export function windowSize(opts: { cols?: number; rows?: number }) {
  return {
    cols: opts.cols ?? process.stdout.columns ?? 80,
    rows: opts.rows ?? process.stdout.rows ?? 24,
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

/** The one kind of workspace werk can make today. */
export const workspaceHostFor = (ctx: WerkContext): WorkspaceHost =>
  createLocalWorktreeHost({ root: workspaceRoot(ctx) });

/** What a person is told once the daemon has the session. */
export function renderCreated(
  info: SessionInfo,
  ctx: WerkContext,
  workspace?: Workspace,
): string {
  const where = `${info.size.cols}x${info.size.rows} in ${info.cwd}`;
  return [
    `${ctx.colour.green("created")} ${info.id} ${ctx.colour.bold(info.name)}`,
    ...(workspace
      ? [
          ctx.colour.dim(
            `workspace ${workspace.name} on branch ${workspace.branch}`,
          ),
        ]
      : []),
    ctx.colour.dim(`${info.argv.join(" ")} · ${where}`),
    `werk attach ${info.id}`,
  ].join("\n");
}
export function buildCreate(): Command {
  return defineCommand({
    name: "create",
    summary: "Start a session running a command",
    description:
      "Start a command under the daemon and leave it running. The command " +
      "comes after --, and werk does not parse it, so the child keeps its own " +
      "flags. Nothing is attached to: the session outlives the terminal that " +
      "started it and `werk attach` goes back to it.",
    usage: "[options] -- COMMAND [ARGS...]",
    examples: [
      { run: "werk create -- /bin/sh", note: "a shell, named for you" },
      { run: "werk create --name demo --label project=werk -- claude" },
      { run: "werk create --scrollback 2000000 -- npm run dev" },
      {
        run: "werk create --workspace fix-login -- claude",
        note: "a git worktree of its own, branched from where you are",
      },
    ],
    requires: [
      {
        need: "create needs a command to run, after --",
        met: () => childCommand().length > 0,
      },
    ],
  })
    .option(
      "--name <NAME>",
      "name the session instead of taking a generated one",
    )
    .option(
      "--label <KEY=VALUE>",
      "attach a label, repeatable",
      collectLabel,
      {},
    )
    .option("--cols <N>", "starting columns", wholeNumber("--cols"))
    .option("--rows <N>", "starting rows", wholeNumber("--rows"))
    .option(
      "--scrollback <BYTES>",
      "page-memory budget for scrollback; above the daemon's cap fails",
      wholeNumber("--scrollback", " of bytes"),
    )
    .option("--cwd <PATH>", "working directory for the command")
    .option(
      "--workspace <NAME>",
      "make a git worktree of this name and run the command in it",
    )
    .action(
      withContext(
        async (
          ctx,
          opts: {
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
          // Where the caller is standing. With `--workspace` this is the
          // checkout the new branch comes from; without it, it is where the
          // command runs, which is what it has always meant.
          const here = path.resolve(opts.cwd ?? process.cwd());
          // Before the daemon, deliberately: a workspace that cannot be made is
          // a failure that should not have started a daemon on its way to being
          // reported. Nothing removes the worktree if the session then fails to
          // start — rolling a half-made workspace back is one of the things
          // `docs/workspaces-and-git.md` leaves open.
          const workspace = opts.workspace
            ? await workspaceHostFor(ctx).create({
                name: opts.workspace,
                from: { kind: "local-checkout", path: here },
              })
            : undefined;
          const client = await connectDaemon(ctx);
          try {
            const info = await client.create({
              argv: [...argv],
              env: clientEnvironment(),
              cwd: workspace ? workspace.directory : here,
              size: windowSize(opts),
              scrollbackBytes: opts.scrollback,
              name: opts.name,
              labels: opts.label,
            });
            // The machine shape gains a key only when there is a workspace, so
            // what anything already parsing `create --json` reads is untouched.
            return result(
              workspace
                ? {
                    ...info,
                    workspace: {
                      name: workspace.name,
                      directory: workspace.directory,
                      branch: workspace.branch,
                    },
                  }
                : info,
              (c) => renderCreated(info, c, workspace),
            );
          } finally {
            await client.close();
          }
        },
      ),
    );
}
