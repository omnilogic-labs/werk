# Landing

Part of the [werk product specification](../product-specification.md). Nothing
here is settled, and nothing described here is built: the specification records
that nothing lands anything yet.

Landing would get the changes made in a workspace onto its **parent**, the
branch the workspace was created from. How it gets there probably wants to be
configurable, because the routes people want are genuinely different.

## The client is the likely place to coordinate it

A client that cannot reach the parent cannot land, and what it should do instead
has not been worked out. Where it can reach the parent, it has everything a
landing needs, because it can already reach the workspaces it made. Where the
parent physically lives would then make no difference to how any of this
works.

## Three routes

1. **Straight onto the parent.** The change is applied to the parent branch and
   that is the end of it.
2. **Through review.** Open a pull request from the workspace against its parent
   branch, or otherwise ask for review, and land onto the parent once the review
   is done.
3. **Through an external system.** Hand the change to something else that owns
   merging: a GitHub merge queue, or a company CI system.

Whether the change arrives as a squash, a merge or a cherry-pick probably wants
to be configurable separately from the route.

The lean is to start with two of these: land straight onto the parent as a
squash, or open and update a pull request and then land as a squash.

## An agent could write the commit message and resolve the conflicts

Landing would shell out to whichever agent the user prefers, as a one-shot
command such as `claude -p`, for two jobs: writing the commit message, and
resolving merge conflicts when the change does not apply cleanly.

Both probably want to be configurable. Each probably also wants to be settable
to pause for review, so the person landing sees what the agent produced before
it is used. Generating the commit message and then opening the user's editor on
it seems a reasonable default: close the editor to accept it, edit it first if it is wrong.
The same person could then configure werk never to show it to them, or never to
generate one at all. Conflict resolution would work the same way, and someone
who would rather resolve conflicts with their own tool, such as the VS Code
merge editor, should probably be able to say so.

## Landing on a copy first

The lean is that werk should not apply the change directly to the parent branch.
It would take a copy of the parent, apply the change there, and only move the
result across once there is a good commit sitting on the copy.

1. Generate the commit message with the configured agent.
2. Make a place to work: a copy of the parent branch. Another workspace, or just
   a git worktree when hosts are expensive enough that a whole one is not worth
   it.
3. Apply the workspace's change to that copy, as a squash or however it is
   configured.
4. If it conflicts, resolve the conflict there, with the agent or with whatever
   the user configured.
5. Copy the resulting commit onto the real parent.

What that would buy is a parent that is never left half-landed, and a failed
landing that leaves a copy which can be thrown away. What it costs is a second
place to make and clean up per landing, which on an expensive host is not
nothing. Nobody has weighed the two against each other on a real host.

## A workspace noticing that its changes have already landed

Changes often reach the parent without werk doing it. A pull request gets merged
on GitHub, or a colleague applies the same commit. A workspace should probably
recognise that its work is already on the parent and say so, rather than
offering to land something that is already there or reporting itself as
unfinished work.

Phabricator solved this by attaching something to the commit: every commit
carried the review it came from, so finding it later was a lookup rather than a
guess. werk could do the same and write a marker into the commit it produces.
Comparing commit messages is another angle. How to do it well is unresolved, and
[question 5](../open-questions.md#5-how-does-a-workspace-tell-that-its-changes-have-already-landed)
has the trouble with the obvious alternatives.
