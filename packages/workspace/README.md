# @werk/workspace

Make a workspace: a named, isolated place for work, with a copy of the
repository and a branch of its own. Creating one goes through an interface, so a
caller asks for a workspace rather than describing how to build one.

This is a private workspace package. Depend on it as `"@werk/workspace":
"workspace:*"` and import from `@werk/workspace`. Build it with `bun run build`.

**This package is under development and its interface is expected to change
shape.** It is the first thing written against
[`docs/workspaces-and-git.md`](../../docs/workspaces-and-git.md), which works
through the workspace and git model as a set of leans and options rather than a
design anyone has agreed. Most of what that document describes is not built
here, and several of the things it leaves open would change the interface below
if they were settled tomorrow. Treat what follows as the current shape rather
than as a boundary to build against.

## The interface

```ts
import { createLocalWorktreeMaker } from "@werk/workspace";

const maker = createLocalWorktreeMaker({ root: "/state/werk/workspaces" });
const workspace = await maker.create({
  name: "fix-login",
  from: { kind: "local-checkout", path: process.cwd() },
});
```

`WorkspaceMaker` has one method and one property: `create(request, options?)`,
and a `readonly kind: string` saying which kind of place this one makes
workspaces in, for a caller reporting what it did.

`options` carries an `AbortSignal` and an `onProgress` callback. Making a
workspace on another machine is a probe, an install, a daemon start, a
repository, a push and a check-out, and a caller that could say nothing for a
minute and a half is not one anybody would ship. `create` still resolves to a
finished workspace: returning one that is not ready yet was the other shape
available and nothing needed it.

`create` resolves to a `Workspace`: a `name`, an absolute `directory`, a
`branch`, the `base` commit that branch started at, the `parent` branch it was
made from, and the `from` it was made from. `parent` is absent on a detached
HEAD, which is a real state rather than a failure. There is no identity and no
state, because each of those is one of the open questions below.

`parent` and `base` are there because landing needs the parent branch and
nothing can work it out afterwards: several branches share a merge base, and the
reflog says `branch: Created from HEAD` without naming what HEAD was. Only the
maker is in a position to answer it.

`WorkspaceSource` is a union discriminated on `kind`, with one member today,
`local-checkout`. Deriving a workspace from another workspace, which may be on
another machine, would be a second member of that union rather than a change to
`create`'s signature. That is the main reason the source is a union rather than
a path.

## What this package exports

| Export                                       | What it does                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| `createLocalWorktreeMaker({ root, git? })`   | A `WorkspaceMaker` that makes git worktrees on this machine             |
| `createSshWorkspaceMaker(options)`           | One that makes them on a machine an injected runner reaches             |
| `createLander({ root, scratchRoot, git? })`  | Surveys and performs a landing: a workspace's commits onto a branch     |
| `workspaceRecords(root, toplevel)`           | Read and write what werk wrote down about a repository's workspaces     |
| `workspaceAt(root, directory, host?)`        | Which workspace a directory is, for a caller holding a path and no name |
| `repositorySlot(toplevel)`                   | The directory a repository's workspaces and records share               |
| `branchAt(git, cwd)`                         | The branch a checkout is on, or undefined on a detached HEAD            |
| `isWorkspaceName(name)`                      | Whether a string is a name a branch and a directory can share           |
| `workspaceReference(workspace)`              | Turn a `Workspace` into a `WorkspaceReference`                          |
| `formatWorkspaceReference(reference, level)` | Write one at `"name"`, `"path"` or `"full"`                             |
| `fitWorkspaceReference(reference, width)`    | The most detailed level that fits the room a caller has                 |
| `WORKSPACE_REFERENCE_LEVELS`                 | The three levels, in order                                              |
| `runGit(args, cwd)`                          | The default `GitRunner`                                                 |
| `WorkspaceError`                             | Carries a `code` and a `detail`                                         |

There is one notation for writing a workspace down, at three levels of
verbosity, so a column, a status row and a JSON record spell a workspace the
same way.

`workspaceAt` is the inverse of the join `create` performs, and it reaches
only as far as this host's layout.

## The local worktree host

`createLocalWorktreeMaker({ root, git })` makes workspaces under `root`, one
directory per repository: `<root>/<repository name>-<8 hex of the digest of its
absolute path>/<workspace name>`. The digest is there because the repository's
own directory name is not unique, so two checkouts of the same project would
otherwise want the same path for a `fix-login` workspace.

The workspace name is also the branch name and the directory leaf, so it is
restricted to `^[A-Za-z0-9][A-Za-z0-9._-]*$`. That turns away `feature/login`,
which is a legal branch name. For a version whose whole job is one worktree, one
string that needs no escaping anywhere is worth more than the names it refuses,
and widening it is a change to make when something asks for it.

Creation branches from `HEAD` rather than from the current branch by name, which
is what "branch from where I am standing" means and is the only spelling that
works on a detached HEAD. The source path may be any directory inside the
repository, including another worktree.

`git` is a `GitRunner`, `(args, cwd) => Promise<{ exitCode, stdout, stderr }>`,
and defaults to running the `git` on `PATH` through `node:child_process`. It is
injectable so that the failure mapping can be tested without a repository on
disk. Nothing in this package uses the Bun runtime.

## Why a workspace could not be made

`WorkspaceError` carries a `code`, and a `detail` holding what git said when git
is what said it.

| Code               | What happened                                                      |
| ------------------ | ------------------------------------------------------------------ |
| `INVALID_NAME`     | The name is not one a branch and a directory can share.            |
| `NOT_A_REPOSITORY` | The source path is not inside a git working tree.                  |
| `NO_COMMITS`       | The repository has no commits, so there is nothing to branch from. |
| `BRANCH_EXISTS`    | A branch of that name is already there.                            |
| `DIRECTORY_EXISTS` | The target directory is already there and is not empty.            |
| `GIT_MISSING`      | There is no git to run.                                            |
| `GIT_FAILED`       | git ran and refused for a reason this package did not anticipate.  |

The landing half uses the same union, because a caller turning either into an
exit status reads one list, and because the four rows above that mean the same
thing on both sides are not worth spelling twice.

| Code                  | What happened                                                         |
| --------------------- | --------------------------------------------------------------------- |
| `NO_SUCH_WORKSPACE`   | Nothing here is a workspace werk has a record of.                     |
| `WORKSPACE_ELSEWHERE` | It is on another machine, which landing does not reach yet.           |
| `DETACHED_HEAD`       | The checkout being landed onto is on no branch.                       |
| `NOTHING_TO_LAND`     | The workspace has no commits that branch does not already have.       |
| `WORKTREE_DIRTY`      | Something tracked and uncommitted is in the way of moving the branch. |
| `LAND_CONFLICT`       | The change does not apply cleanly, and nothing resolved it.           |

These are decided by asking the repository before running `git worktree add`,
not by reading git's stderr. The wording moves between git versions and locales,
and the exit status of a refusal is not dependable either: a branch that already
exists was observed exiting 255 where an existing directory exited 128. The
pre-checks can lose a race against something else writing the repository, so the
add is still classified, and `GIT_FAILED` carries git's own stderr for whatever
was not anticipated.

Two of these are worth knowing before meeting them. An **empty** target
directory is accepted, because git accepts one: existence is the wrong question
and emptiness is the right one. And a repository with no commits cannot have a
worktree made at all, which is the first thing anyone doing `git init` and then
asking for a workspace will hit.

## What it does today

- The package exists, and creating a workspace goes through it rather than being
  written inline wherever a workspace is wanted. `werk create` makes one every
  time. Whether there should also be a way to run a command without making one
  is
  [question 22](../../docs/open-questions.md#22-is-there-a-way-to-run-a-command-without-making-a-workspace).
- It makes two kinds of workspace. `createLocalWorktreeMaker` makes a git
  worktree on the machine werk is running on. `createSshWorkspaceMaker` makes
  one on another machine: a bare mirror the client pushes to, and a locked
  worktree checked out from it. Both branch from the repository they are
  pointed at. Everything that touches that machine goes through an
  injected runner, so this package still imports nothing but `node:*`.
- A workspace failing to be made is a set of named reasons rather than git's
  exit status, so a client can turn each one into its own message.
- It lands a workspace on this machine. `createLander` surveys what would land —
  the commits, the files, what is uncommitted, whether the branch being landed
  onto is the one the workspace came from — and then squashes the change onto a
  throwaway worktree at that branch's tip and fast-forwards the branch onto the
  result. The commit message and whatever resolves a conflict are the caller's,
  handed in, because which agent writes a message and whether a person gets to
  read it are the client's business. It is the first of the three routes
  [landing](../../docs/product/landing.md) describes.
- It writes a record per workspace, holding the branch that workspace came from.
  That is the one fact landing needs and cannot recover. It is not the workspace
  record the design document describes, and it does not close question 19.

## What it does not do

| Gap                                                                                                                                                                                                | Where it is open                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **What werk remembers about a workspace, and where that record lives.** `workspaceRecords` writes what landing needs and no more, on the client only, and nothing reads it back for `workspaceAt`. | [question 19](../../docs/open-questions.md#19-where-does-the-record-of-a-workspace-live)           |
| **Which machine a workspace is on.** A reference has room for a host and nothing supplies one, so the component is absent everywhere.                                                              | [question 24](../../docs/open-questions.md#24-what-is-the-host-component-of-a-workspace-reference) |
| **The state a workspace can be in.** `Workspace` has no state field, because the words for one are not settled.                                                                                    | [question 16](../../docs/open-questions.md#16-which-of-the-old-words-survive)                      |
| **Whether the checkout the client is standing in is itself a workspace.** `WorkspaceSource` calls it a `local-checkout` and does not claim either way.                                             | [question 20](../../docs/open-questions.md#20-is-the-place-the-client-is-running-a-workspace)      |
| **What ends a workspace.** Nothing here removes one.                                                                                                                                               | [question 14](../../docs/open-questions.md#14-what-ends-a-workspace)                               |
| **Reading a reference back from a string.** The grammar is built to be read back, and nothing needs it yet.                                                                                        | Not raised as a question; every caller starts from a directory or a workspace                      |

Two more are open without a numbered question behind them.

**Whether creation stays a single awaited call.**
`docs/workspaces-and-git.md` leans towards creation eventually reporting
progress, or handing back a workspace that is not ready yet, once there is a
machine to provision. Neither is built. The shape leaves room for both. An
options argument carrying a signal or a progress callback would fit, and so
would widening what `create` resolves to.

**What a caller sees when creation fails partway.** With one call to git there
is no partway. With a machine to provision there is, and who owns the half-made
thing is unresolved. A worktree left behind by a session that then fails to
start is not cleaned up. Rolling a creation back is one of the things the design
document raises and nobody has worked out where it stops.
