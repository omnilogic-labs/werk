/**
 * The one kind of workspace that exists: a git worktree on this machine.
 *
 * `git worktree add` gives a real workspace for very little — a second working
 * directory, its own branch, sharing one object store — which is why it is the
 * first version rather than a clone. Everything the eventual product needs and
 * this does not do (a machine to run on, a transport to reach it, a record of
 * what exists) is absent rather than stubbed.
 *
 * The failures are decided by asking the repository first and running
 * `git worktree add` last. Reading git's stderr would be the obvious
 * alternative and it is not dependable: the wording moves between versions and
 * locales, and the exit status of a refusal is not a fixed value either — a
 * branch that already exists was observed exiting 255 where an existing
 * directory exited 128. The pre-checks can lose a race against something else
 * writing the repository, so the add is still classified, and `GIT_FAILED`
 * carries git's own stderr for everything this file did not anticipate.
 */
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { isMissingExecutable, runGit, type GitRunner } from "./git.js";
import { reportProgress } from "./progress.js";
import type { WorkspaceReference } from "./reference.js";
import { repositorySlotFor } from "./slot.js";
import {
  WorkspaceError,
  type CreateWorkspaceOptions,
  type CreateWorkspaceRequest,
  type Workspace,
  type WorkspaceMaker,
} from "./types.js";

/**
 * A name a branch and a directory can both carry without either being escaped.
 *
 * `/` is excluded, which rules out `feature/login`. A legal branch name is a
 * larger set than a legal directory leaf, and for a version whose whole job is
 * one worktree, one string that is simultaneously the workspace name, the
 * branch name and the directory leaf is worth more than the names it turns
 * away. Widening this is a change to make when something asks for it.
 */
export const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const isWorkspaceName = (name: string): boolean =>
  WORKSPACE_NAME.test(name) && !name.includes("..");

/**
 * Where a repository's workspaces live under the root.
 *
 * The checkout's absolute path is what is digested, which is exactly right for
 * a worktree on this machine and exactly wrong for one anywhere else — see
 * `slot.ts`.
 */
export function repositorySlot(toplevel: string): string {
  const absolute = path.resolve(toplevel);
  return repositorySlotFor(path.basename(absolute), absolute);
}

/**
 * The workspace a directory is, when a werk layout is what put it there.
 *
 * The inverse of the join `create` performs below, and it lives beside that
 * join so the two cannot drift apart. It answers from the path alone: nothing
 * records which workspaces exist, so there is no index to consult, and where
 * that record should live is
 * [question 19](../../../docs/product-specification.md#19-where-does-the-record-of-a-workspace-live).
 *
 * Reconstruction reaches exactly as far as the layout both makers share:
 * `<root>/<repository slot>/<workspace name>`. One a differently shaped maker
 * laid out has no route through here, which is one of the things question 19
 * costs.
 *
 * A path is a workspace when it is a direct child of a repository slot, so
 * `root/slot/leaf` answers and `root/slot`, `root/slot/leaf/src` and anything
 * outside `root` do not. The slot itself is not checked beyond its position:
 * the digest in it is not recomputable without the checkout it was made from.
 *
 * `host` names the machine the path is on, and is stamped onto the answer. It
 * also decides which path grammar the strings are read with: a path on another
 * machine is not a path on this one, so a Windows client reading
 * `/srv/werk/workspaces/repo-a3f2b1c9/fix-login` would split it on `\` and find
 * nothing. A host being given means the posix grammar, which is what every
 * machine werk reaches over ssh uses; a Windows machine reached that way is a
 * thing to work out when there is one.
 */
export function workspaceAt(
  root: string,
  directory: string,
  host?: string,
): WorkspaceReference | undefined {
  const p = host === undefined ? path : path.posix;
  const absolute = host === undefined ? path.resolve(directory) : directory;
  const relative = p.relative(
    host === undefined ? path.resolve(root) : root,
    absolute,
  );
  if (relative === "" || relative.startsWith("..") || p.isAbsolute(relative))
    return undefined;
  const parts = relative.split(p.sep);
  if (parts.length !== 2) return undefined;
  const name = parts[1]!;
  if (!isWorkspaceName(name)) return undefined;
  return host === undefined
    ? { name, directory: absolute }
    : { name, directory: absolute, host };
}

export interface LocalWorktreeMakerOptions {
  /**
   * The directory workspaces are made under. Passed in rather than resolved
   * here: where werk keeps its own files is the client's business, and a test
   * hands this a temporary directory.
   */
  readonly root: string;
  /** How git is run. Injected so the failure mapping can be tested without a repository. */
  readonly git?: GitRunner;
}

/**
 * True when nothing is in the way. git accepts an empty directory as a worktree
 * target and refuses one with anything in it, so existence is the wrong
 * question and emptiness is the right one.
 *
 * Anything that stops the directory being read — it is absent, it is a file, it
 * cannot be listed — is treated as clear, because none of those is this
 * function's to diagnose. `git worktree add` refuses them with a better
 * sentence than a guess made here, and that arrives as `GIT_FAILED`.
 */
async function nothingInTheWay(directory: string): Promise<boolean> {
  try {
    return (await readdir(directory)).length === 0;
  } catch {
    return true;
  }
}

export function createLocalWorktreeMaker(
  options: LocalWorktreeMakerOptions,
): WorkspaceMaker {
  const git = options.git ?? runGit;
  const root = path.resolve(options.root);

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

  return {
    kind: "local-worktree",
    async create(
      request: CreateWorkspaceRequest,
      options?: CreateWorkspaceOptions,
    ): Promise<Workspace> {
      const progress = reportProgress(options?.onProgress);
      const { name, from } = request;
      if (!isWorkspaceName(name))
        throw new WorkspaceError(
          "INVALID_NAME",
          `${JSON.stringify(name)} is not a workspace name: use letters, digits, dot, dash and underscore, starting with a letter or a digit`,
        );

      // Two of the seven stages, because two is what a worktree on this machine
      // costs. They are emitted rather than skipped so that a caller rendering
      // progress is exercised by the maker that runs in every test.
      progress("resolve-source", "begin");
      const source = path.resolve(from.path);
      const top = await run(["rev-parse", "--show-toplevel"], source);
      const toplevel = top.stdout.trim();
      if (top.exitCode !== 0 || toplevel === "")
        throw new WorkspaceError(
          "NOT_A_REPOSITORY",
          `${source} is not inside a git repository`,
        );

      // A repository with no commits has no HEAD to branch from, and
      // `git worktree add` refuses it with `fatal: invalid reference: HEAD`.
      // Asking first turns the first thing a person meets after `git init`
      // into a sentence about commits rather than about references.
      const head = await run(["rev-parse", "--verify", "HEAD"], toplevel);
      if (head.exitCode !== 0)
        throw new WorkspaceError(
          "NO_COMMITS",
          `${toplevel} has no commits yet, so there is nothing to branch from`,
        );

      const branch = name;
      const existing = await run(
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        toplevel,
      );
      if (existing.exitCode === 0)
        throw new WorkspaceError(
          "BRANCH_EXISTS",
          `branch ${branch} already exists in ${toplevel}`,
        );

      const directory = path.join(root, repositorySlot(toplevel), name);
      progress("resolve-source", "end", toplevel);
      if (!(await nothingInTheWay(directory)))
        throw new WorkspaceError(
          "DIRECTORY_EXISTS",
          `${directory} already exists and is not empty`,
        );

      await mkdir(path.dirname(directory), { recursive: true });
      progress("check-out", "begin");
      // `HEAD` rather than the current branch's name: it is what "branch from
      // where I am standing" means, and it is the only spelling that works on
      // a detached HEAD.
      const added = await run(
        ["worktree", "add", "-b", branch, directory, "HEAD"],
        toplevel,
      );
      if (added.exitCode !== 0)
        throw new WorkspaceError(
          "GIT_FAILED",
          `git worktree add failed for ${directory}`,
          added.stderr.trim() || added.stdout.trim(),
        );
      progress("check-out", "end", directory);

      // No `host`: this is the machine werk is running on, and an absent host
      // is what says so.
      return { name, directory, branch, from };
    },
  };
}
