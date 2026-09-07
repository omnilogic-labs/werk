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
  /** Absolute path to the working directory. */
  readonly directory: string;
  readonly branch: string;
  readonly from: WorkspaceSource;
}

/**
 * The seam. One method, because creating a workspace is the one thing werk
 * needs done to a place it does not yet have.
 *
 * It returns a promise of a finished workspace, which is the shape that fits
 * `git worktree add` and probably not the shape that fits provisioning a
 * machine. `docs/workspaces-and-git.md` leans towards creation eventually
 * reporting progress, or handing back a workspace that is not ready yet, and
 * neither is built here. The shape leaves room for both: an options argument
 * carrying a signal or a progress callback is an addition rather than a break,
 * and so is widening what `create` resolves to.
 */
export interface WorkspaceHost {
  /** Which kind of place this makes workspaces in, for a caller reporting what it did. */
  readonly kind: string;
  create(request: CreateWorkspaceRequest): Promise<Workspace>;
}

/**
 * Why a workspace could not be made.
 *
 * These are the caller's failures and git's, separated, because a client
 * turning them into an exit status and a message wants to tell "you are not in
 * a repository" from "git is not installed". They are decided by asking the
 * repository before running `git worktree add` rather than by reading git's
 * stderr: that wording moves between git versions and locales, and the exit
 * status of a refusal is not dependable either.
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
  /** There is no git to run. */
  | "GIT_MISSING"
  /** git ran and refused, for a reason this package did not anticipate. */
  | "GIT_FAILED";

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
