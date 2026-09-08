# Landing

Part of the [werk product specification](../product-specification.md). Almost
nothing here is settled. One route is built, described below and referenced in
[cli.md](../cli.md#landing-a-workspace); everything else is a lean or an option.

Landing gets the changes made in a workspace onto its **parent**, the branch the
workspace was created from. How it gets there probably wants to be configurable,
because the routes people want are genuinely different.

## The client is the likely place to coordinate it

A client that cannot reach the parent cannot land, and what it should do instead
has not been worked out. Where it can reach the parent, it has everything a
landing needs, because it can already reach the workspaces it made. Where the
parent physically lives would then make no difference to how any of this works.

`werk land` is coordinated by the client, and today it reaches exactly as far as
a workspace sharing this machine's repository: the workspace's branch is read
out of the repository the caller is standing in. A workspace on another machine
needs its history fetched back first, which is
[question 21](../open-questions.md#21-how-does-a-change-move-between-two-workspaces-on-different-hosts)
and is not built, so landing one is refused in those words.

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

The lean is to have two of these: land straight onto the parent as a squash, or
open and update a pull request and then land as a squash. The first is built.
The `landRoute` setting names all three — `parent`, `pull-request`, `external` —
so that the other two have somewhere to arrive rather than changing the shape of
the setting when they do. Asking for one that is not built is refused in those
words rather than falling back to `parent`, which would land something the
caller had asked to have reviewed.

Nothing is configurable about the shape of the change yet. It is a squash,
because that is the lean and because it is the one shape the copy below makes
straightforward.

## An agent could write the commit message and resolve the conflicts

Landing shells out to whichever agent the user prefers, as a one-shot command
such as `claude -p`, for two jobs: writing the commit message, and resolving
merge conflicts when the change does not apply cleanly.

Both probably want to be configurable separately. Today one `agent` setting
answers for both, which is the smaller thing to have built and not a position on
whether that is right. Each probably also wants to be settable to pause for
review, so the person landing sees what the agent produced before it is used.
Generating the commit message and then opening the user's editor on it is what
`werk land` does: close the editor to accept it, edit it first if it is wrong.
`--no-edit` skips that for one landing, and whether somebody should be able to
say in configuration that they never want to see it, or never want one
generated, is not worked out. Conflict resolution has no equivalent pause:
someone who would rather resolve conflicts with their own tool, such as the VS
Code merge editor, has no way to say so, and probably should.

Nothing ships with an agent configured. Naming one would be a claim about what
is installed, so the first landing that needs a commit message asks which agent
to use and writes the answer down, including the answer "none". Where the agent
runs is [question 4](../open-questions.md#4-where-does-the-landing-agent-run);
it runs on the client, which is where the copy of the parent is, and that is
what is being tried rather than an answer.

## Landing on a copy first

werk does not apply the change directly to the parent branch. It takes a copy of
the parent, applies the change there, and only moves the result across once
there is a good commit sitting on the copy.

1. Make a place to work: a copy of the parent branch. Today that is a throwaway
   git worktree at the parent's tip, under `$stateDir/landings`. Another
   workspace is the other option, and on a host expensive enough that a whole
   one is not worth it, a worktree is the cheap version of the same idea.
2. Apply the workspace's change to that copy, as a squash.
3. If it conflicts, resolve the conflict there, with the agent.
4. Generate the commit message with the configured agent, show it to the person,
   and commit on the copy.
5. Move the resulting commit onto the real parent, as a fast-forward.

What that buys is a parent that is never left half-landed, and a failed landing
that leaves a copy which can be thrown away. What it costs is a second place to
make and clean up per landing, which on an expensive host is not nothing. Nobody
has weighed the two against each other on a real host, and the local case is not
the one that would settle it.

The message is generated before the copy is made rather than after, because the
diff it is written from is `parent...workspace` and does not need the squash to
have happened. That is an ordering rather than a position: it means a person is
not shown an editor after werk has already made a directory.

## A workspace noticing that its changes have already landed

Changes often reach the parent without werk doing it. A pull request gets merged
on GitHub, or a colleague applies the same commit. A workspace should probably
recognise that its work is already on the parent and say so, rather than
offering to land something that is already there or reporting itself as
unfinished work.

Nothing does this. `werk land` will happily squash a change onto a branch that
already carries an equivalent one, and what a person sees is either a landing
that changes nothing or a conflict, depending on how the change arrived.

Phabricator solved this by attaching something to the commit: every commit
carried the review it came from, so finding it later was a lookup rather than a
guess. werk could do the same and write a marker into the commit it produces; it
does not, because a marker with nothing reading it would be speculative
machinery in every commit werk makes. Comparing commit messages is another
angle. How to do it well is unresolved, and
[question 5](../open-questions.md#5-how-does-a-workspace-tell-that-its-changes-have-already-landed)
has the trouble with the obvious alternatives.

## What happens to the workspace

Nothing. `werk land` leaves the workspace, its directory and its branch exactly
as they were, and says so. That is not a position that a landed workspace should
survive — it is [question 14](../open-questions.md#14-what-ends-a-workspace)
being left open, since deleting one would be answering it.
