/**
 * Making a workspace, behind an interface.
 *
 * A **workspace** is a named, isolated place for work: somewhere to run, a copy
 * of the repository, and a branch of its own. This package makes one, in one of
 * two kinds of place: on the machine werk is running on, or on a machine
 * something else knows how to reach.
 *
 * The interface is the reason the package exists. Creating a workspace is
 * expected to grow a great deal: provisioning a machine and waiting for it,
 * getting credentials onto it, choosing between a clone and a worktree, and
 * deriving from a parent that lives on another host are all things that would
 * land on this one operation, and most of them would arrive one at a time. So
 * creation sits behind `WorkspaceMaker`, and callers ask for a workspace rather
 * than describing how to build one.
 *
 * `createLander` is the other half: getting the work done in a workspace back
 * onto the branch it came from. It reads a `WorkspaceRecord` — what werk wrote
 * down when it made the workspace, which is the only thing that knows which
 * branch that was — and squashes the change onto a throwaway copy of the parent
 * before moving a finished commit across.
 *
 * There are two makers. `createLocalWorktreeMaker` makes a git worktree on the
 * machine werk is running on. `createSshWorkspaceMaker` describes one on another
 * machine — a bare mirror pushed to and a worktree checked out beside it — and
 * knows nothing about ssh: everything that reaches the far machine goes through
 * an injected `RemoteRunner`, the same seam `GitRunner` already is for git. That
 * is what keeps this package importing `node:*` and nothing else.
 *
 * See `docs/workspaces-and-git.md` for the model this is heading towards. That
 * document is a set of leans and options rather than a design anyone has
 * agreed, and this package implements the smallest corner of it. The README
 * says what it does today and what it does not.
 */
export type { GitResult, GitRunner } from "./git.js";
export { branchAt, runGit } from "./git.js";
export {
  createLocalWorktreeMaker,
  isWorkspaceName,
  repositorySlot,
  workspaceAt,
} from "./local.js";
export { createLander } from "./land.js";
export type {
  Lander,
  LanderOptions,
  LandCommit,
  LandConflict,
  LandPlan,
  LandProgress,
  LandResult,
  LandStep,
  LandSurvey,
} from "./land.js";
export { workspaceRecords } from "./record.js";
export type { WorkspaceRecord, WorkspaceRecords } from "./record.js";
export type { LocalWorktreeMakerOptions } from "./local.js";
export type { RemoteRunner } from "./remote.js";
export { createSshWorkspaceMaker } from "./ssh.js";
export type { SshWorkspaceOptions } from "./ssh.js";
export {
  formatWorkspaceReference,
  fitWorkspaceReference,
  workspaceReference,
  WORKSPACE_REFERENCE_LEVELS,
} from "./reference.js";
export type {
  WorkspaceReference,
  WorkspaceReferenceLevel,
} from "./reference.js";
export type {
  CreateWorkspaceOptions,
  CreateWorkspaceRequest,
  Workspace,
  WorkspaceErrorCode,
  WorkspaceMaker,
  WorkspaceProgress,
  WorkspaceSource,
  WorkspaceStep,
} from "./types.js";
export { WorkspaceError } from "./types.js";
