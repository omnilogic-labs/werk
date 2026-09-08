/**
 * Getting the work done in a workspace onto the branch it came from.
 *
 * [Landing](../../../docs/product/landing.md) describes three routes and this
 * file is the first of them: squash the workspace's commits into one and put it
 * on the parent. The other two — through review, and through something else
 * that owns merging — are not built, and nothing here is shaped to exclude
 * them.
 *
 * It is done on a copy rather than in the caller's checkout, which is what that
 * document leans towards. A throwaway worktree is checked out at the parent's
 * tip, the change is squashed onto it, the commit message and any conflict are
 * settled there, and only a finished commit is moved across — as a fast-forward,
 * so the caller's branch either gains a whole commit or is untouched. What that
 * buys is a checkout that is never left mid-merge; what it costs is a second
 * directory per landing, and on a machine where a workspace is expensive that
 * may turn out not to be worth it. Nobody has weighed the two on a real host.
 *
 * The caller supplies the commit message and, if it wants one, whatever resolves
 * a conflict. Neither is decided here: `docs/product/landing.md` has both going
 * to an agent the person configured, and which agent, whether they get to read
 * what it wrote, and where it runs are all questions for the client rather than
 * for this package.
 *
 * Two things this deliberately does not do. It does not touch the workspace
 * afterwards — what ends a workspace is
 * [question 14](../../../docs/open-questions.md#14-what-ends-a-workspace) — and
 * it writes no marker into the commit saying where the change came from, which
 * is the strongest candidate for
 * [question 5](../../../docs/open-questions.md#5-how-does-a-workspace-tell-that-its-changes-have-already-landed)
 * and has nothing reading one yet.
 */
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  branchAt,
  isMissingExecutable,
  runGit,
  type GitRunner,
} from "./git.js";
import { repositorySlot } from "./local.js";
import { workspaceRecords, type WorkspaceRecord } from "./record.js";
import { WorkspaceError } from "./types.js";

/** One commit on the workspace branch that the branch being landed onto lacks. */
export interface LandCommit {
  readonly sha: string;
  readonly subject: string;
}

/**
 * Everything known about a landing before anything has been changed.
 *
 * It is what `--dry-run` prints and what the confirmations are asked from, so
 * it carries the facts a person would want to be shown rather than only the
 * ones the landing needs. Reading it changes nothing.
 */
export interface LandSurvey {
  readonly workspace: WorkspaceRecord;
  /** The repository the change is landing in. */
  readonly toplevel: string;
  /** The branch checked out there, which is what the change lands on. */
  readonly onto: string;
  /** The commit `onto` is at. */
  readonly ontoAt: string;
  /**
   * True when `onto` is the branch the workspace was made from. False means the
   * change is being landed somewhere other than its parent, which is a thing a
   * person may well mean and should be asked about.
   */
  readonly ontoIsParent: boolean;
  /** Commits the workspace has that `onto` does not, newest first. */
  readonly commits: readonly LandCommit[];
  /** The files the change touches. */
  readonly files: readonly string[];
  /**
   * How many files are changed in the workspace and not committed. They do not
   * land: only committed work does, which is the same rule `create` follows
   * when it puts a workspace on another machine.
   */
  readonly uncommitted: number;
  /**
   * The tracked files changed in the landing checkout, in
   * `git status --porcelain` form. Anything here stops the branch being moved,
   * so it is reported by the survey and refused by the landing. Untracked files
   * are not counted: they only get in the way when the change would write over
   * one, and git says so itself when it refuses the fast-forward.
   */
  readonly inTheWay: readonly string[];
}

/** The copy, and what git could not merge in it. */
export interface LandConflict {
  /** The throwaway worktree, checked out at the parent's tip. */
  readonly directory: string;
  /** The paths git left with conflict markers, relative to `directory`. */
  readonly paths: readonly string[];
}

export type LandStep =
  "copy" | "apply" | "resolve" | "commit" | "move" | "clean-up";

export interface LandProgress {
  readonly step: LandStep;
  readonly state: "begin" | "end";
  readonly detail?: string;
}

export interface LandPlan {
  /**
   * The commit message. The caller composed it — from an agent, an editor, a
   * flag, or the workspace's own commits — because none of those is this
   * package's business.
   */
  readonly message: string;
  /**
   * What resolves a conflict, when the change does not apply cleanly. It is
   * given the copy and the paths git could not merge, and answers true when it
   * has resolved and staged them. Without one, a conflict ends the landing.
   */
  readonly resolve?: (conflict: LandConflict) => Promise<boolean>;
  readonly signal?: AbortSignal;
  /** Never throws into the landing: every call is wrapped. */
  readonly onProgress?: (event: LandProgress) => void;
}

export interface LandResult {
  /** The commit now on `onto`. */
  readonly commit: string;
  readonly onto: string;
  readonly workspace: string;
  readonly branch: string;
  readonly files: number;
  /** How many commits were squashed into the one. */
  readonly squashed: number;
}

export interface LanderOptions {
  /** Where workspaces and their records live: the same root `create` was given. */
  readonly root: string;
  /**
   * Where a landing's throwaway copy goes. Kept out of `root` so that a
   * half-finished landing left behind is never mistaken for a workspace by the
   * reconstruction in `workspaceAt`.
   */
  readonly scratchRoot: string;
  /** How git is run. Injected so the failure mapping can be tested. */
  readonly git?: GitRunner;
}

export interface Lander {
  /** What a landing would be. Changes nothing. */
  survey(toplevel: string, name: string): Promise<LandSurvey>;
  /** Do it. */
  land(survey: LandSurvey, plan: LandPlan): Promise<LandResult>;
}

/** Wraps `onProgress` so a caller whose renderer throws does not fail a landing. */
function reportProgress(report?: (event: LandProgress) => void) {
  return (step: LandStep, state: "begin" | "end", detail?: string) => {
    if (!report) return;
    try {
      report(detail === undefined ? { step, state } : { step, state, detail });
    } catch {
      // A renderer that breaks is the renderer's problem.
    }
  };
}

const lines = (out: string): string[] =>
  out
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");

export function createLander(options: LanderOptions): Lander {
  const git = options.git ?? runGit;
  const root = path.resolve(options.root);
  const scratchRoot = path.resolve(options.scratchRoot);

  /** Every git call goes through here, so "there is no git" is decided once. */
  const run = async (args: readonly string[], cwd: string) => {
    try {
      return await git(args, cwd);
    } catch (error) {
      if (isMissingExecutable(error))
        throw new WorkspaceError(
          "GIT_MISSING",
          "git is not installed, or is not on PATH",
        );
      throw error;
    }
  };

  /** git ran and refused, for a reason this file did not anticipate. */
  const refused = (
    summary: string,
    result: { stderr: string; stdout: string },
  ) =>
    new WorkspaceError(
      "GIT_FAILED",
      summary,
      result.stderr.trim() || result.stdout.trim(),
    );

  return {
    async survey(where: string, name: string): Promise<LandSurvey> {
      const from = path.resolve(where);
      const top = await run(["rev-parse", "--show-toplevel"], from);
      const toplevel = top.stdout.trim();
      if (top.exitCode !== 0 || toplevel === "")
        throw new WorkspaceError(
          "NOT_A_REPOSITORY",
          `${from} is not inside a git repository`,
        );

      const record = await workspaceRecords(root, toplevel).get(name);
      if (record === undefined)
        throw new WorkspaceError(
          "NO_SUCH_WORKSPACE",
          `${toplevel} has no record of a workspace called ${name}`,
        );
      // Landing reads the workspace's branch out of the repository it is
      // standing in, which only works while the workspace shares that
      // repository. A workspace on another machine needs its history fetched
      // back first, and nothing does that yet.
      if (record.host !== undefined)
        throw new WorkspaceError(
          "WORKSPACE_ELSEWHERE",
          `${name} is on ${record.host}, and landing only reaches workspaces on this machine`,
        );

      const onto = await branchAt(run, toplevel);
      if (onto === undefined)
        throw new WorkspaceError(
          "DETACHED_HEAD",
          `${toplevel} is not on a branch, so there is nothing to land onto`,
        );

      const at = await run(["rev-parse", "--verify", onto], toplevel);
      if (at.exitCode !== 0) throw refused(`git could not read ${onto}`, at);
      const ontoAt = at.stdout.trim();

      const known = await run(
        ["rev-parse", "--verify", "--quiet", `refs/heads/${record.branch}`],
        toplevel,
      );
      if (known.exitCode !== 0)
        throw new WorkspaceError(
          "NO_SUCH_WORKSPACE",
          `${name} has a record but no branch ${record.branch} in ${toplevel}`,
        );

      const log = await run(
        ["log", "--format=%H%x00%s", `${onto}..${record.branch}`],
        toplevel,
      );
      if (log.exitCode !== 0)
        throw refused(`git could not list ${onto}..${record.branch}`, log);
      const commits: LandCommit[] = lines(log.stdout).map((line) => {
        const [sha = "", subject = ""] = line.split("\0");
        return { sha, subject };
      });
      if (commits.length === 0)
        throw new WorkspaceError(
          "NOTHING_TO_LAND",
          `${name} has no commits that ${onto} does not already have`,
        );

      // Three dots: the change as it will be applied is everything on the
      // workspace branch since the two parted, not everything the two differ
      // by. Landing onto a branch that has moved on would otherwise report the
      // other branch's files as part of this change.
      const changed = await run(
        ["diff", "--name-only", `${onto}...${record.branch}`],
        toplevel,
      );

      // A count, never a failure, for the reason the ssh maker gives for the
      // same call: somebody about to be told their uncommitted work stays
      // behind is not helped by being told `git status` exited 128 instead.
      const dirty = await run(["status", "--porcelain"], record.directory);
      // Tracked changes only. An untracked file does not stop a fast-forward
      // unless the change would write over it, and git refuses that itself with
      // a better sentence than a guess made here — so counting untracked files
      // as being in the way would refuse landings that were perfectly fine,
      // which for a repository with build output in it is most of them.
      const here = await run(
        ["status", "--porcelain", "--untracked-files=no"],
        toplevel,
      );

      return {
        workspace: record,
        toplevel,
        onto,
        ontoAt,
        ontoIsParent: record.parent === onto,
        commits,
        files: changed.exitCode === 0 ? lines(changed.stdout) : [],
        uncommitted: dirty.exitCode === 0 ? lines(dirty.stdout).length : 0,
        inTheWay: here.exitCode === 0 ? lines(here.stdout) : [],
      };
    },

    async land(survey: LandSurvey, plan: LandPlan): Promise<LandResult> {
      const progress = reportProgress(plan.onProgress);
      const { toplevel, onto, ontoAt, workspace } = survey;
      // The fast-forward at the end writes the working tree, so anything
      // uncommitted there is in the way. Refused before the copy is made,
      // because a landing that cannot finish should cost nothing.
      if (survey.inTheWay.length > 0)
        throw new WorkspaceError(
          "WORKTREE_DIRTY",
          `${toplevel} has uncommitted changes in ${survey.inTheWay.length} ${
            survey.inTheWay.length === 1 ? "file" : "files"
          }; commit or stash them and land again`,
          survey.inTheWay.slice(0, 10).join("\n"),
        );
      plan.signal?.throwIfAborted();

      // A copy per landing, named so two at once in one repository cannot
      // collide. Detached rather than on a branch of its own: nothing here
      // needs a name for it, and a branch would be one more thing left behind
      // when a landing fails.
      const copy = path.join(
        scratchRoot,
        repositorySlot(toplevel),
        `${workspace.name}-${randomBytes(4).toString("hex")}`,
      );
      progress("copy", "begin", copy);
      await mkdir(path.dirname(copy), { recursive: true });
      const added = await run(
        ["worktree", "add", "--detach", "--quiet", copy, ontoAt],
        toplevel,
      );
      if (added.exitCode !== 0)
        throw refused(`git could not make a copy of ${onto} at ${copy}`, added);
      progress("copy", "end");

      /** Take the copy back. Best-effort: a landing is not failed by its tidying. */
      const clearUp = async () => {
        progress("clean-up", "begin");
        await run(["worktree", "remove", "--force", copy], toplevel).catch(
          () => undefined,
        );
        progress("clean-up", "end");
      };

      let commit: string;
      try {
        plan.signal?.throwIfAborted();
        progress("apply", "begin", `${workspace.branch} onto ${onto}`);
        const squashed = await run(
          ["merge", "--squash", workspace.branch],
          copy,
        );
        if (squashed.exitCode !== 0) {
          const conflicted = await run(
            ["diff", "--name-only", "--diff-filter=U"],
            copy,
          );
          const paths =
            conflicted.exitCode === 0 ? lines(conflicted.stdout) : [];
          if (paths.length === 0)
            throw refused(
              `git could not apply ${workspace.branch} onto ${onto}`,
              squashed,
            );
          // Only said when something is going to try. Announcing a resolution
          // with nothing to resolve it would be werk narrating a step it is
          // about to skip.
          let settled = false;
          let still = paths;
          if (plan.resolve !== undefined) {
            progress("resolve", "begin", `${paths.length} in conflict`);
            settled = await plan.resolve({ directory: copy, paths });
            const left = await run(
              ["diff", "--name-only", "--diff-filter=U"],
              copy,
            );
            still = left.exitCode === 0 ? lines(left.stdout) : paths;
          }
          if (!settled || still.length > 0)
            // The copy is deliberately left where it is. It holds the conflict
            // exactly as git wrote it, so a person can finish the merge there
            // by hand, and a landing that failed leaving something to throw
            // away is what the landing document asks for.
            throw new WorkspaceError(
              "LAND_CONFLICT",
              `${workspace.branch} does not apply cleanly onto ${onto}; the copy is at ${copy} and can be deleted with \`git worktree remove --force ${copy}\``,
              still.join("\n"),
            );
          progress("resolve", "end");
        }
        progress("apply", "end");

        plan.signal?.throwIfAborted();
        progress("commit", "begin");
        const committed = await run(["commit", "-m", plan.message], copy);
        if (committed.exitCode !== 0) {
          // `merge --squash` stages the change and commits nothing, so an empty
          // index here means the change makes no difference to the parent —
          // which is a thing to say plainly rather than to report as git
          // refusing.
          const staged = await run(["diff", "--cached", "--quiet"], copy);
          await clearUp();
          if (staged.exitCode === 0)
            throw new WorkspaceError(
              "NOTHING_TO_LAND",
              `${workspace.name} changes nothing that ${onto} does not already have`,
            );
          throw refused(
            `git could not commit the landing in ${copy}`,
            committed,
          );
        }
        const head = await run(["rev-parse", "HEAD"], copy);
        if (head.exitCode !== 0) {
          await clearUp();
          throw refused(`git could not read the commit it just made`, head);
        }
        commit = head.stdout.trim();
        progress("commit", "end", commit.slice(0, 12));

        // The move across. `--ff-only` is the whole guarantee: the commit sits
        // directly on the tip `onto` was at, so either the branch has not moved
        // and gains exactly this commit, or something moved it while the
        // landing was being prepared and git refuses rather than merging.
        progress("move", "begin", onto);
        const moved = await run(["merge", "--ff-only", commit], toplevel);
        if (moved.exitCode !== 0) {
          await clearUp();
          throw refused(
            `${onto} could not be moved onto the landed commit; it may have moved while the landing was being prepared`,
            moved,
          );
        }
        progress("move", "end");
      } catch (error) {
        // Every failure from here on takes its copy back with it, in one place
        // rather than at each throw — except a conflict, which is the one whose
        // copy is worth keeping, and which says where it left it.
        if (!(
          error instanceof WorkspaceError && error.code === "LAND_CONFLICT"
        ))
          await clearUp();
        throw error;
      }

      await clearUp();
      return {
        commit,
        onto,
        workspace: workspace.name,
        branch: workspace.branch,
        files: survey.files.length,
        squashed: survey.commits.length,
      };
    },
  };
}
