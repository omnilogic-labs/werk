# Landing

Part of the [werk product specification](../product-specification.md). Nothing
here is settled.

Landing gets the changes made in a workspace onto its **parent**, the branch the
workspace was created from. How it gets there is configurable, because the
routes people want are genuinely different.

## The client coordinates it

Landing is driven by the client. The client can reach the workspaces it made, so
the only other requirement is that it can reach the parent. If it cannot, the
landing cannot happen. If it can, where the parent physically lives makes no
difference to how any of this works.

## Three routes

1. **Straight onto the parent.** The change is applied to the parent branch and
   that is the end of it.
2. **Through review.** Open a pull request from the workspace against its parent
   branch, or otherwise ask for review, and land onto the parent once the review
   is done.
3. **Through an external system.** Hand the change to something else that owns
   merging: a GitHub merge queue, or a company CI system.

Whether the change arrives as a squash, a merge or a cherry-pick is configurable
separately from the route.

This team will start with two of these: land straight onto the parent as a
squash, or open and update a pull request and then land as a squash.

## An agent does the awkward parts, and you decide how much to look

Landing shells out to whichever agent the user prefers, as a one-shot command
such as `claude -p`, for two jobs: writing the commit message, and resolving
merge conflicts when the change does not apply cleanly.

Both are configurable, and both are configurable as reviewable. Generating the
commit message and then opening the user's editor on it seems a reasonable
default: close the editor to accept it, edit it first if it is wrong. The same
person could configure werk never to show it to them, or never to generate one
at all. Conflict resolution works the same way, and someone who would rather
resolve conflicts with their own tool, such as the VS Code merge editor, should
be able to say so.

## Landing happens on a copy first

werk does not apply the change directly to the parent branch. It takes a copy of
the parent, applies the change there, and only moves the result across once
there is a good commit sitting on the copy.

1. Generate the commit message with the configured agent.
2. Make a place to work: a copy of the parent branch. Another workspace, or just
   a git worktree when hosts are expensive enough that a whole one is not worth
   it.
3. Apply the workspace's change to that copy, as a squash or however it is
   configured.
4. If it conflicts, resolve the conflict there, with the agent or with whatever
   the user configured.
5. Copy the resulting commit onto the real parent.

The parent is never left half-landed, and a failed landing leaves a copy that
can be thrown away.

## A workspace notices when its changes have already landed

Changes often reach the parent without werk doing it. A pull request gets merged
on GitHub, or a colleague applies the same commit. A workspace should recognise
that its work is already on the parent and say so, rather than offering to land
something that is already there or reporting itself as unfinished work.

Phabricator solved this by attaching something to the commit: every commit
carried the review it came from, so finding it later was a lookup rather than a
guess. werk could do the same and write a marker into the commit it produces.
Comparing commit messages is another angle. How to do it well is unresolved, and
[question 5](../product-specification.md#5-how-does-a-workspace-tell-that-its-changes-have-already-landed)
has the trouble with the obvious alternatives.
