/**
 * A workspace on a machine reached over ssh: a bare mirror pushed to, and a
 * linked worktree checked out beside it.
 *
 * **Nothing in this file knows what ssh is.** Everything that touches the far
 * machine goes through the injected `RemoteRunner`, and the URL git pushes to is
 * built by the caller, exactly as `GitRunner` already stands between this
 * package and the `git` binary. That is what keeps `@werk/workspace` importing
 * `node:*` and nothing else, and it is what lets the whole failure table be
 * tested without a second computer.
 *
 * ## The layout
 *
 * ```
 * <root>/repos/<slot>.git/          bare — the push target and the shared object store
 * <root>/<slot>/<workspace-name>/   a linked worktree — where the session runs
 * ```
 *
 * The mirror is **bare**. That is what keeps werk out of the far machine's
 * configuration: pushing a branch into a repository that has a working tree runs
 * into `receive.denyCurrentBranch`,
 * whose ways out are `updateInstead` or a `push-to-checkout` hook — a piece of
 * configuration or a script that werk would then own on every machine it ever
 * touches, forever. A bare repository has no checked-out branch, so the rule
 * never applies and there is nothing to install. The worktrees hang off it, one
 * per workspace, sharing its object store the way `local.ts`'s worktrees share
 * the user's.
 *
 * `git worktree add --lock` marks the worktree as one that must not be pruned.
 * Without the lock a `git worktree prune` — run by a person tidying up, or by
 * git itself noticing an unreachable path — can race a workspace somebody is
 * working in.
 *
 * ## Why a push, and not a bundle
 *
 * A bundle looks like the obvious cold start: one file, no daemon, no protocol.
 * It is the wrong tool here because **a bundle has no incremental negotiation**.
 * It always contains the full content of the refs it was asked for, so the
 * second workspace made from a repository would ship the entire history again,
 * and the tenth would ship it a tenth time. A push against a persistent mirror
 * negotiates: git works out what the far end already has and sends the
 * difference. The mirror is kept for exactly that reason, and this is written
 * down here because somebody reading that bundles are the recommended way to
 * seed a repository over a thin link will otherwise "fix" it back.
 *
 * ## Uncommitted work does not travel
 *
 * Only committed history is pushed, so anything a person has not committed stays
 * on their machine. This maker counts it and reports the count through
 * `onProgress`, so the caller can say it once, in its own words. Not a prompt —
 * that would break `--json` — and not a refusal, which would answer a question
 * nobody has answered.
 *
 * `git stash export` and `git stash import`, which arrived in git 2.51, look
 * like the obvious next step: they turn a stash into an object a push can carry
 * and back again, so the dirty tree could travel as a stash rather than not at
 * all. Both ends of the machine this was written on have 2.53. That is a lean
 * and not a plan: nobody has worked out whether a workspace should start dirty,
 * or what happens when the far end is older.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  branchAt,
  isMissingExecutable,
  runGit,
  type GitRunner,
} from "./git.js";
import { isWorkspaceName } from "./local.js";
import { reportProgress } from "./progress.js";
import type { RemoteRunner } from "./remote.js";
import { repositorySlotFor } from "./slot.js";
import {
  WorkspaceError,
  type CreateWorkspaceOptions,
  type CreateWorkspaceRequest,
  type Workspace,
  type WorkspaceMaker,
} from "./types.js";

export interface SshWorkspaceOptions {
  /** The name this machine has in werk's configuration. Becomes the reference's host. */
  readonly host: string;
  /** Absolute path on that machine holding `repos/` and the workspace directories. */
  readonly root: string;
  /** How git is run on this machine. Injected so the failure mapping can be tested. */
  readonly git?: GitRunner;
  /** How a script is run on that machine. */
  readonly remote: RemoteRunner;
  /**
   * The URL git should push to, built from the mirror's path on the far machine.
   * Built by the caller, so this file knows nothing about ssh: `(p) =>
   * \`ssh://beast\${p}\`` and `(p) => \`beast:\${p}\`` are both it.
   */
  readonly pushUrl: (repositoryPath: string) => string;
  /**
   * Configuration prepended to the push, e.g. `["-c", "core.sshCommand=…"]`, for
   * a caller that has an identity or a control path to hand git.
   */
  readonly pushConfig?: readonly string[];
}

/**
 * Distinct numeric exits rather than parsed stderr, for the same reason
 * `local.ts` gives: git's wording moves between versions and locales, and the
 * exit status of a refusal is not fixed either. A script werk wrote can pick its
 * own numbers, so it does.
 */
const REMOTE_GIT_ABSENT = 90;
const REMOTE_DIRECTORY_IN_THE_WAY = 91;
const REMOTE_BRANCH_EXISTS = 92;
const REMOTE_ROLLBACK_INCOMPLETE = 93;
/** ssh's own status for "I could not do this at all", separate from anything the script said. */
const TRANSPORT_FAILED = 255;
/** The last thing the preparation script prints, so a shell that ran nothing is not mistaken for success. */
const READY = "werk-ready";
/** Rolling back is best-effort and must not hang; the failure it is cleaning up already happened. */
const ROLLBACK_TIMEOUT_MS = 15_000;

/**
 * A value going into a POSIX shell script. A workspace name is validated and a
 * root path is not, so everything interpolated is quoted rather than the ones
 * that look dangerous.
 */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * What identifies a repository across machines.
 *
 * The local maker digests the checkout's absolute path, which is a fact about
 * one computer: it cannot decide where anything lands on another, and moving the
 * checkout would strand every workspace already made from it. So a repository
 * gets a name of its own, written into its own config the first time werk needs
 * one and read back every time after.
 *
 * **This is the first thing werk writes into a user's repository.** It is one
 * line, in `werk.`, which is git's sanctioned extension point for exactly this,
 * and `git config --unset werk.repo-id` reverses it completely. `--local` puts
 * it in the common `.git/config`, so every worktree of the repository agrees
 * about which repository it is.
 */
async function repositoryIdentity(
  run: (
    args: readonly string[],
    cwd: string,
  ) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>,
  toplevel: string,
): Promise<string> {
  const read = await run(
    ["config", "--local", "--get", "werk.repo-id"],
    toplevel,
  );
  const existing = read.stdout.trim();
  if (read.exitCode === 0 && existing !== "") return existing;

  const identity = randomUUID();
  const written = await run(
    ["config", "--local", "werk.repo-id", identity],
    toplevel,
  );
  if (written.exitCode !== 0)
    throw new WorkspaceError(
      "GIT_FAILED",
      `could not record werk.repo-id in ${toplevel}`,
      written.stderr.trim() || written.stdout.trim(),
    );
  return identity;
}

/** "3 files" / "1 file", for a sentence a person reads. */
const files = (count: number): string =>
  `${count} ${count === 1 ? "file" : "files"}`;

export function createSshWorkspaceMaker(
  options: SshWorkspaceOptions,
): WorkspaceMaker {
  const git = options.git ?? runGit;
  const { host, remote, pushUrl } = options;
  const root = options.root;
  const pushConfig = options.pushConfig ?? [];

  /** Every local git call goes through here, so "there is no git" is decided once. */
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

  /**
   * Every remote call goes through here, so "the machine did not answer" is
   * decided once. A runner that can tell an authentication refusal from an
   * unreachable machine — which this file cannot, because ssh spends 255 on
   * both — raises the `WorkspaceError` it wants and it passes through untouched.
   */
  const away = async (script: string, timeoutMs?: number) => {
    try {
      const result = await remote(
        script,
        timeoutMs === undefined ? undefined : { timeoutMs },
      );
      if (result.exitCode === TRANSPORT_FAILED)
        throw new WorkspaceError(
          "HOST_UNREACHABLE",
          `${host} could not be reached`,
          result.stderr.trim(),
        );
      return result;
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError(
        "HOST_UNREACHABLE",
        `${host} could not be reached`,
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  return {
    kind: "ssh-worktree",
    async create(
      request: CreateWorkspaceRequest,
      createOptions?: CreateWorkspaceOptions,
    ): Promise<Workspace> {
      const progress = reportProgress(createOptions?.onProgress);
      const signal = createOptions?.signal;
      /** Checked between stages, which is as fine-grained as an injected runner allows. */
      const stop = (): void => {
        signal?.throwIfAborted();
      };
      const { name, from } = request;
      if (!isWorkspaceName(name))
        throw new WorkspaceError(
          "INVALID_NAME",
          `${JSON.stringify(name)} is not a workspace name: use letters, digits, dot, dash and underscore, starting with a letter or a digit`,
        );

      // Everything answerable here is answered here, before anything is sent
      // anywhere: a mistake the person made should cost them no network at all.
      progress("resolve-source", "begin");
      const source = path.resolve(from.path);
      const top = await run(["rev-parse", "--show-toplevel"], source);
      const toplevel = top.stdout.trim();
      if (top.exitCode !== 0 || toplevel === "")
        throw new WorkspaceError(
          "NOT_A_REPOSITORY",
          `${source} is not inside a git repository`,
        );

      const head = await run(["rev-parse", "--verify", "HEAD"], toplevel);
      if (head.exitCode !== 0)
        throw new WorkspaceError(
          "NO_COMMITS",
          `${toplevel} has no commits yet, so there is nothing to branch from`,
        );
      const base = head.stdout.trim();
      const parent = await branchAt(run, toplevel);

      const identity = await repositoryIdentity(run, toplevel);
      const slot = repositorySlotFor(path.posix.basename(toplevel), identity);
      const bare = path.posix.join(root, "repos", `${slot}.git`);
      const directory = path.posix.join(root, slot, name);

      // A count, never a failure. Anything that stops git answering is read as
      // nothing to report rather than as a reason to refuse: a person who is
      // about to be told their uncommitted work stays behind is not helped by
      // being told instead that `git status` exited 128.
      const dirty = await run(["status", "--porcelain"], toplevel);
      const uncommitted =
        dirty.exitCode === 0
          ? dirty.stdout.split("\n").filter((line) => line.trim() !== "").length
          : 0;
      progress("resolve-source", "end", toplevel);
      stop();

      // One idempotent script, so a creation that half-happened can be asked
      // for again. It is also the first contact with the machine, which is why
      // `HOST_UNREACHABLE` surfaces here: this maker assumes a machine that is
      // already reachable and already has git, so it emits nothing for
      // `reach-host`, `install-werk` or `start-daemon`. A maker that provisions
      // would.
      progress("prepare-repository", "begin", `${host}:${bare}`);
      const prepared = await away(
        [
          "set -e",
          `command -v git >/dev/null 2>&1 || exit ${REMOTE_GIT_ABSENT}`,
          `bare=${quote(bare)}`,
          `dir=${quote(directory)}`,
          `[ -d "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ] && exit ${REMOTE_DIRECTORY_IN_THE_WAY}`,
          `mkdir -p "$(dirname "$bare")" "$(dirname "$dir")"`,
          "created=no",
          `if ! git -C "$bare" rev-parse --git-dir >/dev/null 2>&1; then`,
          `  git init -q --bare "$bare"`,
          "  created=yes",
          "fi",
          `git -C "$bare" show-ref --verify --quiet ${quote(`refs/heads/${name}`)} && exit ${REMOTE_BRANCH_EXISTS}`,
          `echo "${READY} $created"`,
        ].join("\n"),
      );
      if (prepared.exitCode === REMOTE_GIT_ABSENT)
        throw new WorkspaceError(
          "REMOTE_GIT_MISSING",
          `git is not installed on ${host}, or is not on its PATH`,
        );
      if (prepared.exitCode === REMOTE_DIRECTORY_IN_THE_WAY)
        throw new WorkspaceError(
          "DIRECTORY_EXISTS",
          `${host}:${directory} already exists and is not empty`,
        );
      if (prepared.exitCode === REMOTE_BRANCH_EXISTS)
        throw new WorkspaceError(
          "BRANCH_EXISTS",
          `branch ${name} already exists in ${host}:${bare}`,
        );
      if (prepared.exitCode !== 0)
        throw new WorkspaceError(
          "GIT_FAILED",
          `preparing ${host}:${bare} failed`,
          prepared.stderr.trim() || prepared.stdout.trim(),
        );
      // A shell that ran none of the script also exits 0. The marker is what
      // separates "it worked" from "the far end is not a machine this maker
      // knows how to drive".
      const marker = prepared.stdout
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith(READY));
      if (marker === undefined)
        throw new WorkspaceError(
          "HOST_UNSUPPORTED",
          `${host} answered without running the script werk sent it`,
          prepared.stdout.trim() || prepared.stderr.trim(),
        );
      const madeTheMirror = marker.slice(READY.length).trim() === "yes";
      progress("prepare-repository", "end");
      stop();

      progress(
        "transfer",
        "begin",
        uncommitted === 0
          ? undefined
          : `uncommitted changes in ${files(uncommitted)} stay on this machine`,
      );
      // `HEAD:` rather than a branch name, because that is what "branch from
      // where I am standing" means and is the only spelling that works on a
      // detached HEAD — the same reasoning `local.ts` gives for its `HEAD`.
      //
      // A one-off URL rather than `git remote add`, and no `-u`: werk leaves
      // nothing behind in the user's `.git/config`. Never `--force`, because
      // the branch was checked for and anything that appeared since is somebody
      // else's work.
      const pushed = await run(
        [
          ...pushConfig,
          "push",
          "--quiet",
          pushUrl(bare),
          `HEAD:refs/heads/${name}`,
        ],
        toplevel,
      );
      if (pushed.exitCode !== 0)
        throw new WorkspaceError(
          "TRANSFER_FAILED",
          `pushing ${name} to ${host} failed`,
          pushed.stderr.trim() || pushed.stdout.trim(),
        );
      progress("transfer", "end");

      /**
       * Undo what got made, in reverse, best-effort and bounded. The mirror is
       * deliberately left: every workspace of this repository shares it, and
       * removing it because one creation failed would break the siblings.
       *
       * `worktree remove` failing is not news — the add may have got nowhere
       * near registering one — so only the prune and the branch deletion are
       * reported. Whatever this returns is a note on the failure, never the
       * failure: what a person needs to know first is why the workspace was not
       * made.
       */
      const rollBack = async (): Promise<readonly string[]> => {
        const notes: string[] = [];
        if (madeTheMirror)
          notes.push(
            `the mirror ${host}:${bare} was made by this attempt and is left in place, because every workspace of this repository shares it`,
          );
        try {
          const undone = await away(
            [
              `bare=${quote(bare)}`,
              `dir=${quote(directory)}`,
              `git -C "$bare" worktree remove --force "$dir" >/dev/null 2>&1 || true`,
              "left=",
              `git -C "$bare" worktree prune >/dev/null 2>&1 || left="$left worktree-prune"`,
              `git -C "$bare" branch -D ${quote(name)} >/dev/null 2>&1 || left="$left branch-delete"`,
              `[ -z "$left" ] || { echo "$left"; exit ${REMOTE_ROLLBACK_INCOMPLETE}; }`,
            ].join("\n"),
            ROLLBACK_TIMEOUT_MS,
          );
          if (undone.exitCode !== 0)
            notes.push(
              `clearing up on ${host} did not finish:${undone.stdout.trim() === "" ? ` exit ${undone.exitCode}` : ` ${undone.stdout.trim()}`}`,
            );
        } catch (error) {
          notes.push(
            `clearing up on ${host} did not finish: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return notes;
      };

      try {
        stop();
      } catch (error) {
        await rollBack();
        throw error;
      }

      progress("check-out", "begin");
      const added = await away(
        `git -C ${quote(bare)} worktree add --lock -q ${quote(directory)} ${quote(name)}`,
      );
      if (added.exitCode !== 0) {
        const notes = await rollBack();
        throw new WorkspaceError(
          "GIT_FAILED",
          [`git worktree add failed for ${host}:${directory}`, ...notes].join(
            "; ",
          ),
          added.stderr.trim() || added.stdout.trim(),
        );
      }
      progress("check-out", "end", directory);

      return {
        name,
        directory,
        branch: name,
        base,
        ...(parent === undefined ? {} : { parent }),
        from,
        host,
      };
    },
  };
}
