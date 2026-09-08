/**
 * Making a workspace, behind an interface.
 *
 * A **workspace** is a named, isolated place for work: somewhere to run, a copy
 * of the repository, and a branch of its own. This package makes one, and today
 * it makes exactly one kind — a git worktree on the machine werk is running on.
 *
 * The interface is the reason the package exists. Creating a workspace is
 * expected to grow a great deal: provisioning a machine and waiting for it,
 * getting credentials onto it, choosing between a clone and a worktree, and
 * deriving from a parent that lives on another host are all things that would
 * land on this one operation, and most of them would arrive one at a time. So
 * creation sits behind `WorkspaceHost`, and callers ask for a workspace rather
 * than describing how to build one.
 *
 * See `docs/workspaces-and-git.md` for the model this is heading towards. That
 * document is a set of leans and options rather than a design anyone has
 * agreed, and this package implements the smallest corner of it. The README
 * says which parts are decided and which are not.
 */
export type { GitResult, GitRunner } from "./git.js";
export { runGit } from "./git.js";
export { createLocalWorktreeHost, isWorkspaceName } from "./local.js";
export type { LocalWorktreeOptions } from "./local.js";
export type {
  CreateWorkspaceRequest,
  Workspace,
  WorkspaceErrorCode,
  WorkspaceHost,
  WorkspaceSource,
} from "./types.js";
export { WorkspaceError } from "./types.js";
