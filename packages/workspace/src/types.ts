/**
 * The vocabulary: what a workspace is, what is asked for to make one, and why
 * making one can fail.
 *
 * Kept apart from `index.ts` so that the implementation can import the words
 * without importing the module that re-exports the implementation.
 */
/**
 * Where a workspace's code comes from.
 *
 * A union rather than a path because the interesting case is ahead of us:
 * deriving a workspace from another workspace, which may live on a different
 * machine, is a second member rather than a changed signature. Whether the
 * checkout a person is standing in is itself a workspace is
 * [question 20](../../../docs/product-specification.md#20-is-the-place-the-client-is-running-a-workspace),
 * so `local-checkout` deliberately does not claim it is one.
 */
export type WorkspaceSource = {
  readonly kind: "local-checkout";
  /** A path inside the checkout. The repository is resolved from it. */
  readonly path: string;
};

export interface CreateWorkspaceRequest {
  /** What to call it. Today this is also the branch name and the directory leaf. */
  readonly name: string;
  readonly from: WorkspaceSource;
}

/**
 * A workspace that exists.
 *
 * Deliberately thin: no identity, no state and no parent pointer. What werk
 * remembers about a workspace, and where that record lives, is
 * [question 19](../../../docs/product-specification.md#19-where-does-the-record-of-a-workspace-live),
 * and the state words are
 * [question 16](../../../docs/product-specification.md#16-which-of-the-old-words-survive).
 * Inventing fields for either here would read back later as an answer.
 */
export interface Workspace {
  readonly name: string;
  /** Absolute path to the working directory, on whichever machine `host` names. */
  readonly directory: string;
  readonly branch: string;
  /**
   * The branch the workspace was made from, which is what
   * [landing](../../../docs/product/landing.md) calls the parent. Absent when
   * the checkout was on a detached HEAD: there was a commit to branch from and
   * no branch name to say it by.
   *
   * A maker answers this because it is the only thing that can. Afterwards it
   * cannot be worked back out — several branches share a merge base, and the
   * reflog says `branch: Created from HEAD` without naming what HEAD was.
   */
  readonly parent?: string;
  /** The commit the branch started at. */
  readonly base: string;
  readonly from: WorkspaceSource;
  /**
   * Which machine it is on, named as werk's configuration names it. Absent from
   * anything made on the machine werk is running on, which keeps the lean
   * recorded in
   * [question 23](../../../docs/product-specification.md#23-what-is-the-host-component-of-a-workspace-reference)
   * — that absence probably reads as "here" — intact rather than answering it.
   */
  readonly host?: string;
}

/**
 * The stages a maker can be in, in the order a remote creation walks them.
 *
 * A local worktree passes through two of these and a machine that has to be
 * reached, given a werk, given a daemon and given a history passes through most
 * of them. They are one list rather than one per maker so that a caller can
 * render any maker's progress without knowing which maker it has.
 */
export type WorkspaceStep =
  | "resolve-source"
  | "reach-host"
  | "install-werk"
  | "start-daemon"
  | "prepare-repository"
  | "transfer"
  | "check-out";

export interface WorkspaceProgress {
  readonly step: WorkspaceStep;
  readonly state: "begin" | "end";
  /** A sentence for a person — "sending 84 MiB". Absent when there is nothing to add. */
  readonly detail?: string;
}

export interface CreateWorkspaceOptions {
  /** Abandons the creation. What a maker leaves behind when it does is the maker's to say. */
  readonly signal?: AbortSignal;
  /**
   * Called as the maker moves between stages. It never throws into the maker:
   * every call is wrapped, so a caller whose renderer breaks does not turn a
   * working creation into a failure.
   */
  readonly onProgress?: (event: WorkspaceProgress) => void;
}

/**
 * The seam. One method, because creating a workspace is the one thing werk
 * needs done to a place it does not yet have.
 *
 * `create` still resolves to a finished workspace. Making one on another
 * machine is probe, ship a binary, start a daemon, prepare a repository, push a
 * history and check out, so a silent await of all that is not something a person
 * would sit through — hence the options argument, which carries a progress
 * callback and a signal.
 *
 * Handing back a workspace that is not ready yet was the other shape available,
 * and nothing needed it: no caller has anything to do with a workspace it cannot
 * run in, and a workspace with a lifecycle would be a set of state words written
 * into code, which is
 * [question 16](../../../docs/product-specification.md#16-which-of-the-old-words-survive).
 * A maker that wanted to report readiness separately could still grow one later.
 */
export interface WorkspaceMaker {
  /** Which kind of place this makes workspaces in, for a caller reporting what it did. */
  readonly kind: string;
  create(
    request: CreateWorkspaceRequest,
    options?: CreateWorkspaceOptions,
  ): Promise<Workspace>;
}

/**
 * Why a workspace could not be made.
 *
 * These are the caller's failures, git's and the machine's, separated, because
 * a client turning them into an exit status and a message wants to tell "you
 * are not in a repository" from "git is not installed" from "that machine did
 * not answer". They are decided by asking the repository before running
 * `git worktree add`, and by giving a remote script a distinct exit per
 * refusal, rather than by reading git's stderr: that wording moves between git
 * versions and locales, and the exit status of a refusal is not dependable
 * either.
 *
 * The `HOST_` codes and `REMOTE_GIT_MISSING` say something about a computer the
 * person reading the message is not sitting at, which is the reason they are
 * their own rows rather than shades of `GIT_FAILED`: the remedy is somewhere
 * else.
 */
export type WorkspaceErrorCode =
  /** The name is not one a branch and a directory can share. */
  | "INVALID_NAME"
  /** The source path is not inside a git working tree. */
  | "NOT_A_REPOSITORY"
  /** The repository has no commits, so there is nothing to branch from. */
  | "NO_COMMITS"
  /** A branch of that name is already there. */
  | "BRANCH_EXISTS"
  /** The target directory is already there and is not empty. */
  | "DIRECTORY_EXISTS"
  /** There is no git to run on the machine werk is running on. */
  | "GIT_MISSING"
  /** git ran and refused, for a reason this package did not anticipate. */
  | "GIT_FAILED"
  /** The machine did not answer. */
  | "HOST_UNREACHABLE"
  /** The machine answered and would not let werk in. */
  | "HOST_AUTH_DENIED"
  /** The machine answered and is not one this maker knows how to use. */
  | "HOST_UNSUPPORTED"
  /** Getting werk onto the machine, or starting it there, did not work. */
  | "HOST_BOOTSTRAP_FAILED"
  /**
   * There is no git to run on the far machine. Separate from `GIT_MISSING`
   * because the remedy is on a different computer from the one reading the
   * message.
   */
  | "REMOTE_GIT_MISSING"
  /** The history did not get there. Its own code because its remedy is "try again". */
  | "TRANSFER_FAILED"
  /**
   * The landing half. They are in the same union as the creation codes because
   * a caller turning either into an exit status reads one list, and because
   * `NOT_A_REPOSITORY`, `NO_COMMITS`, `GIT_MISSING` and `GIT_FAILED` mean the
   * same thing on both sides and are not worth spelling twice.
   */
  /** Nothing here is a workspace werk has a record of. */
  | "NO_SUCH_WORKSPACE"
  /** The workspace is on another machine, which landing does not reach yet. */
  | "WORKSPACE_ELSEWHERE"
  /** The checkout being landed onto is on a detached HEAD, so there is no branch to land on. */
  | "DETACHED_HEAD"
  /** The workspace has no commits the branch being landed onto does not already have. */
  | "NOTHING_TO_LAND"
  /** Something uncommitted is in the way of moving the branch being landed onto. */
  | "WORKTREE_DIRTY"
  /** The change does not apply cleanly, and nothing resolved it. */
  | "LAND_CONFLICT";

export class WorkspaceError extends Error {
  readonly name = "WorkspaceError";
  readonly code: WorkspaceErrorCode;
  /**
   * What git said, when git is what said it. It is folded into the message as
   * well as kept here, because the only thing a client prints is the message.
   */
  readonly detail?: string;
  constructor(code: WorkspaceErrorCode, summary: string, detail?: string) {
    const said = detail === undefined || detail === "" ? undefined : detail;
    super(said === undefined ? summary : `${summary}: ${said}`);
    this.code = code;
    if (said !== undefined) this.detail = said;
  }
}
