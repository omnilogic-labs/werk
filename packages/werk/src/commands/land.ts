/**
 * Getting the work out of a workspace and onto the branch it came from.
 *
 * The gesture is: stand in the repository, on the branch you want the change
 * on, and name the workspace. Where the command is run from is what the change
 * lands on, and the workspace's record says which branch it was made from — so
 * when those two are not the same branch, this says so and asks, rather than
 * quietly landing somewhere the caller did not mean.
 *
 * What it does with the change is
 * [route one](../../../../docs/product/landing.md#three-routes): squash it onto
 * a throwaway copy of the parent, settle the commit message and any conflict
 * there, and fast-forward the parent onto the finished commit. `@werk/workspace`
 * owns all of that. This file owns the conversation around it: which workspace,
 * whether the caller means it, what the commit message says, and who resolves a
 * conflict.
 *
 * The agent is asked for once. Nothing ships with one configured, because
 * naming one would be a claim about what is installed, so the first landing
 * that needs a commit message asks which agent to use and writes the answer
 * down. Left blank, werk writes the message from the workspace's own commits
 * and reports a conflict instead of trying to resolve it, and never asks again.
 */
import path from "node:path";
import { Command } from "@commander-js/extra-typings";
import {
  createLander,
  runGit,
  workspaceRecords,
  type LandConflict,
  type LandSurvey,
  type WorkspaceRecord,
} from "@werk/workspace";
import { defineCommand } from "./define.js";
import { withContext } from "./shared.js";
import { result } from "../runtime/output.js";
import { CancelledError, UsageError } from "../runtime/exit.js";
import { createProgress } from "../runtime/progress.js";
import { agentCommand, askAgent, KNOWN_AGENTS } from "../runtime/agent.js";
import { editMessage } from "../runtime/editor.js";
import {
  canPrompt,
  confirm,
  select,
  text,
  type Choice,
} from "../runtime/interactive.js";
import type { WerkContext } from "../runtime/context.js";
import { gitToplevel } from "../config/load.js";
import { editUserConfig } from "../config/write.js";

/** Where workspaces and their records live, as `create` spells it. */
const workspaceRoot = (ctx: WerkContext) =>
  path.join(ctx.stateDir, "workspaces");
/**
 * Where a landing's copy of the parent goes. Beside the workspaces rather than
 * among them: a copy left behind by a conflict must never be mistaken for a
 * workspace by anything reconstructing one from a path.
 */
const landingRoot = (ctx: WerkContext) => path.join(ctx.stateDir, "landings");

/** How much of the change the agent is shown. A whole diff can be enormous. */
const DIFF_BUDGET = 60_000;

/** The workspace to land, asked as a list when the caller named none. */
async function chooseWorkspace(
  ctx: WerkContext,
  records: readonly WorkspaceRecord[],
): Promise<string> {
  if (records.length === 0)
    throw new UsageError(
      "werk has no record of a workspace made from this repository; `werk create` makes one",
    );
  if (!canPrompt(ctx))
    throw new UsageError(
      "name the workspace to land; there is no terminal to pick one in",
    );
  return await select(ctx, {
    message: "Which workspace?",
    options: records.map((record): Choice<string> => ({
      value: record.name,
      label: record.name,
      hint:
        record.parent === undefined
          ? "made on a detached HEAD"
          : `from ${record.parent}`,
    })),
  });
}

/**
 * The agent to use, asking once when nobody has chosen.
 *
 * The answer is written to the user's config file, so the question is asked at
 * most once per person rather than once per landing — including the answer
 * "none", which is why an empty string written down is different from an empty
 * string defaulted to. A caller with no terminal is not asked and gets no
 * agent, which is the direction that runs nothing nobody chose.
 */
async function resolveAgent(ctx: WerkContext): Promise<string> {
  if (ctx.agentChosen || !canPrompt(ctx)) return ctx.agent;
  const choice = await select(ctx, {
    message: "Which agent should werk ask to write commit messages?",
    options: [
      ...KNOWN_AGENTS.map((name): Choice<string> => ({
        value: name,
        label: name,
        hint: `run as \`${agentCommand(name)?.join(" ")}\``,
      })),
      {
        value: "\0other",
        label: "something else",
        hint: "a command werk runs with the prompt on its stdin",
      },
      {
        value: "",
        label: "none",
        hint: "werk writes the message from your commits",
      },
    ],
    initialValue: KNOWN_AGENTS[0],
  });
  const agent =
    choice === "\0other"
      ? (
          await text(ctx, {
            message: "What should werk run?",
            placeholder: "codex exec",
          })
        ).trim()
      : choice;
  // Written to the user's file rather than the project's: which agent somebody
  // uses is a fact about them, not about the repository.
  await editUserConfig({ set: { agent } }).catch((error: unknown) => {
    ctx.writeError(
      `${ctx.style.warning("could not save that")}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  });
  return agent;
}

/** What the workspace's own commits say, when nothing else writes the message. */
async function messageFromCommits(survey: LandSurvey): Promise<string> {
  const commits = survey.commits;
  if (commits.length === 1) {
    const body = await runGit(
      ["log", "-1", "--format=%B", commits[0]!.sha],
      survey.toplevel,
    );
    const said = body.stdout.trim();
    if (said !== "") return said;
  }
  // Oldest first: the first thing the workspace did reads as the subject, and
  // the rest are the steps it took to get there.
  const subjects = [...commits].reverse().map((commit) => commit.subject);
  return [subjects[0], "", ...subjects.map((s) => `* ${s}`)].join("\n");
}

/** The change, as much of it as the agent is shown. */
async function changeForAgent(survey: LandSurvey): Promise<string> {
  const diff = await runGit(
    ["diff", `${survey.onto}...${survey.workspace.branch}`],
    survey.toplevel,
  );
  const text = diff.exitCode === 0 ? diff.stdout : "";
  return text.length > DIFF_BUDGET
    ? `${text.slice(0, DIFF_BUDGET)}\n[diff truncated at ${DIFF_BUDGET} characters]`
    : text;
}

/** What the agent is asked for a commit message. */
export function messagePrompt(
  survey: LandSurvey,
  commits: string,
  diff: string,
): string {
  return [
    `Write a git commit message for the change below. It is the work of a branch called ${survey.workspace.branch}, squashed into one commit on ${survey.onto}.`,
    "",
    "Answer with the commit message and nothing else: no preamble, no explanation, no code fences. A subject line under 72 characters, then a blank line, then a body only if the change needs one.",
    "",
    "The commits being squashed:",
    commits,
    "",
    "The change:",
    diff,
  ].join("\n");
}

/** What the agent is asked to do about a conflict. */
export function conflictPrompt(
  survey: LandSurvey,
  conflict: LandConflict,
): string {
  return [
    `You are in a git worktree at ${conflict.directory}. A squash of the branch ${survey.workspace.branch} onto ${survey.onto} left conflict markers in these files:`,
    ...conflict.paths.map((file) => `  ${file}`),
    "",
    "Resolve every conflict, keeping the intent of both sides, then `git add` each resolved file. Do not commit: something else will. Do not change anything the conflict did not touch.",
  ].join("\n");
}

/** What a landing prints when the caller reads it rather than a machine. */
export function renderSurvey(ctx: WerkContext, survey: LandSurvey): string {
  const { workspace, commits, files } = survey;
  const lines = [
    `${ctx.style.emphasis(workspace.name)} → ${ctx.style.emphasis(survey.onto)}`,
    ctx.style.muted(
      `${commits.length} ${commits.length === 1 ? "commit" : "commits"}, ${files.length} ${files.length === 1 ? "file" : "files"}`,
    ),
    ...commits
      .slice()
      .reverse()
      .map((commit) =>
        ctx.style.muted(`  ${commit.sha.slice(0, 8)} ${commit.subject}`),
      ),
  ];
  if (workspace.parent === undefined)
    lines.push(
      ctx.style.muted(
        `${workspace.name} was made on a detached HEAD, so werk does not know which branch it came from`,
      ),
    );
  return lines.join("\n");
}

export function buildLand(): Command {
  const land: Command = defineCommand({
    name: "land",
    summary: "Put a workspace's changes onto the branch it came from",
    description:
      "Squash the commits a workspace made into one and put it on the " +
      "branch you are standing on. The change is applied to a throwaway copy " +
      "of that branch first, so a conflict or a bad commit message never " +
      "leaves your checkout half-merged; only a finished commit is moved " +
      "across, and only as a fast-forward. werk asks before landing onto a " +
      "branch other than the one the workspace was made from. Uncommitted " +
      "work in the workspace does not land. The workspace and its branch are " +
      "left exactly as they were.",
    usage: "[options] [WORKSPACE]",
    examples: [
      { run: "werk land fix-login", note: "onto the branch you are on" },
      { run: "werk land", note: "pick from the workspaces of this repository" },
      {
        run: "werk land fix-login --dry-run",
        note: "say what would land, change nothing",
      },
      {
        run: 'werk land fix-login -m "fix the login redirect"',
        note: "your own message; no agent and no editor",
      },
    ],
    notes:
      "The commit message comes from the agent you configured, or from the " +
      "workspace's own commits when you have none, and your editor opens on " +
      "it unless --no-edit. `werk config set agent claude` picks the agent; " +
      "werk asks once if you have not.",
  });
  land
    .argument("[WORKSPACE]", "the workspace to land")
    .option(
      "-m, --message <TEXT>",
      "the commit message; skips the agent and the editor",
    )
    .option("--no-edit", "use the drafted message without opening an editor")
    .option("--dry-run", "say what would land and change nothing")
    .action(
      withContext(
        async (
          ctx,
          opts: { message?: string; edit: boolean; dryRun?: boolean },
          given?: string,
        ) => {
          // The two routes that are not built refuse in those words. Falling
          // back to landing straight onto the parent would land something the
          // caller had asked to have reviewed first.
          if (ctx.landRoute !== "parent")
            throw new UsageError(
              `landRoute is ${ctx.landRoute}, and werk can only land straight onto the parent; set landRoute to parent`,
            );
          const here = process.cwd();
          const toplevel = gitToplevel(here);
          if (toplevel === undefined)
            throw new UsageError(
              `${here} is not inside a git repository, so there is nothing to land onto`,
            );

          const root = workspaceRoot(ctx);
          const name =
            given ??
            (await chooseWorkspace(
              ctx,
              await workspaceRecords(root, toplevel).list(),
            ));

          const lander = createLander({
            root,
            scratchRoot: landingRoot(ctx),
          });
          const survey = await lander.survey(toplevel, name);

          if (opts.dryRun === true)
            return result(
              {
                workspace: survey.workspace.name,
                branch: survey.workspace.branch,
                onto: survey.onto,
                parent: survey.workspace.parent ?? null,
                ontoIsParent: survey.ontoIsParent,
                commits: survey.commits,
                files: survey.files,
                uncommitted: survey.uncommitted,
                inTheWay: survey.inTheWay,
                landed: false,
              },
              (c) =>
                [
                  renderSurvey(c, survey),
                  c.style.muted("nothing changed"),
                ].join("\n"),
            );

          // The question the whole command exists to ask. `ontoIsParent` is
          // false both when the caller is on a different branch and when the
          // workspace was made on a detached HEAD, and those want different
          // sentences: one is probably a mistake, the other is werk not
          // knowing.
          if (!survey.ontoIsParent)
            await confirm(
              ctx,
              survey.workspace.parent === undefined
                ? `${name} was made on a detached HEAD, so werk does not know which branch it came from. Land it onto ${survey.onto}?`
                : `${name} was made from ${survey.workspace.parent}, and you are landing it onto ${survey.onto}. Land it anyway?`,
            );
          if (survey.uncommitted > 0)
            await confirm(
              ctx,
              `${survey.uncommitted} ${survey.uncommitted === 1 ? "file is" : "files are"} changed in ${name} and not committed, and will not land. Land the committed work?`,
            );

          const agent =
            opts.message === undefined ? await resolveAgent(ctx) : "";
          const command = agentCommand(agent);
          const progress = createProgress(ctx, "this machine");
          const cancelling = new AbortController();
          const cancel = () =>
            cancelling.abort(new CancelledError("cancelled"));
          process.once("SIGINT", cancel);
          try {
            const message = await composeMessage(ctx, survey, {
              given: opts.message,
              command,
              edit: opts.edit !== false,
              signal: cancelling.signal,
              progress,
            });
            if (message.trim() === "")
              throw new UsageError(
                "the commit message is empty, so nothing was landed",
              );

            const landed = await lander.land(survey, {
              message,
              signal: cancelling.signal,
              onProgress: progress.onLandProgress,
              ...(command === undefined
                ? {}
                : {
                    resolve: async (conflict: LandConflict) => {
                      progress.say(
                        `asking ${command[0]} to resolve ${conflict.paths.length} ${conflict.paths.length === 1 ? "conflict" : "conflicts"}`,
                      );
                      const answer = await askAgent({
                        command,
                        prompt: conflictPrompt(survey, conflict),
                        cwd: conflict.directory,
                        signal: cancelling.signal,
                      });
                      if (!answer.ok && answer.problem !== undefined)
                        progress.say(answer.problem);
                      return answer.ok;
                    },
                  }),
            });
            progress.stop();
            return result({ ...landed, landed: true }, (c) =>
              [
                `${c.style.success("landed")} ${c.style.emphasis(landed.workspace)} onto ${c.style.emphasis(landed.onto)} as ${landed.commit.slice(0, 12)}`,
                c.style.muted(
                  `${landed.squashed} ${landed.squashed === 1 ? "commit" : "commits"} squashed, ${landed.files} ${landed.files === 1 ? "file" : "files"} changed`,
                ),
                // What ends a workspace is question 14, so nothing here ends
                // one. Saying it is still there is cheaper than a person
                // finding out later.
                c.style.muted(
                  `${landed.workspace} and its branch ${landed.branch} are still there`,
                ),
              ].join("\n"),
            );
          } finally {
            progress.stop();
            process.off("SIGINT", cancel);
          }
        },
      ),
    );
  return land;
}

interface MessagePlan {
  readonly given?: string;
  readonly command?: readonly string[];
  readonly edit: boolean;
  readonly signal: AbortSignal;
  readonly progress: { say(message: string): void; stop(): void };
}

/**
 * The commit message: what the caller typed, or what the agent wrote, or what
 * the workspace's commits say — and then, unless told otherwise, whatever the
 * caller leaves in their editor.
 *
 * An agent that is not installed, exits badly or says nothing falls through to
 * the commits rather than failing the landing. That is the direction worth
 * being wrong in: a message werk wrote is easy to fix in the editor that is
 * about to open, and a landing refused because an agent was missing is not
 * something the caller asked for.
 */
async function composeMessage(
  ctx: WerkContext,
  survey: LandSurvey,
  plan: MessagePlan,
): Promise<string> {
  if (plan.given !== undefined) return plan.given;

  let draft = "";
  if (plan.command !== undefined) {
    plan.progress.say(`asking ${plan.command[0]} for a commit message`);
    const commits = survey.commits
      .slice()
      .reverse()
      .map((commit) => `${commit.sha.slice(0, 8)} ${commit.subject}`)
      .join("\n");
    const answer = await askAgent({
      command: plan.command,
      prompt: messagePrompt(survey, commits, await changeForAgent(survey)),
      cwd: survey.workspace.directory,
      signal: plan.signal,
    });
    if (answer.ok) draft = answer.stdout.trim();
    else if (answer.problem !== undefined)
      plan.progress.say(
        `${answer.problem}; writing the message from your commits`,
      );
  }
  if (draft === "") draft = await messageFromCommits(survey);
  plan.progress.stop();

  // The editor takes the terminal, so it is not opened when there is not one,
  // and never under `--json`, where the one value on stdout is the answer.
  if (!plan.edit || ctx.json || !canPrompt(ctx)) return draft;
  const edited = await editMessage(
    [
      draft,
      "",
      "# Landing " +
        `${survey.workspace.name} onto ${survey.onto}. Lines starting with # are dropped.`,
      "# An empty message stops the landing.",
    ].join("\n"),
    survey.toplevel,
  );
  if (edited.problem !== undefined)
    ctx.writeError(`${ctx.style.muted(edited.problem)}\n`);
  return edited.message;
}
