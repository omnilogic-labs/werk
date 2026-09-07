# Workspaces and git

How werk makes a workspace, what it needs to remember about one, and which git
operations follow from that. This is a model being worked through rather than a
design anyone has agreed. Almost every position below is a lean or an option,
and the places where nobody has taken one are marked as such.

It sits under [the client](product/client.md) in the
[product specification](product-specification.md), which describes creating a
workspace, deriving one from another, and landing as capabilities. This document
is about the shape underneath those capabilities: what the objects are, how they
relate, and where the seam goes.

## What exists today

The session packages own processes, not repositories. A workspace, a host and a
branch are all absent from the code.

The one git call the client makes is `git rev-parse --show-toplevel`, in the
configuration loader, to find the root of the repository the caller is standing
in so that the project configuration layer can be read from `<repository>/.werk`.
It is there because asking git is the only way to get the answer git would give
for a worktree, a submodule or a `.git` file, and it fails softly outside a
repository. That is the whole of it. There is no clone, no branch, no fetch and
no push anywhere in the product packages.

So this is a design for something that does not exist yet, written before the
first line of it, which is the cheapest time to be wrong about it.

## The containment graph

A **containment graph** is what you get by asking where things physically are.

- Its nodes are hosts, workspaces and terminal processes.
- Its roots are hosts. A host is a machine; nothing contains it.
- An edge means "lives on" or "runs in". A host has many workspaces. A workspace
  has many terminal processes.

It is a tree, and it is a tree for a solid reason rather than by convention: a
directory is on exactly one machine, and a process runs in exactly one
directory. Nothing about werk changes that.

This is the graph the product already leans on without naming it. "See the
status of every workspace, across every machine, in one list" is a walk of this
tree. Question 13 in the specification, about whether you attach to a workspace
or to a terminal process, is a question about which level of this tree an action
addresses.

Most of what werk does today would be at the bottom two levels of it. The
daemon owns terminal processes; give it a workspace to sit inside and a host to
sit on, and the tree is complete.

## The derivation graph

A **derivation graph** is what you get by asking where a workspace's code came
from.

- Its nodes are workspaces, plus whatever the client is standing in.
- Its root is wherever the client is executing. That is usually a checkout on a
  laptop, and whether that checkout should itself count as a workspace is
  question 20.
- An edge means "was derived from". The child's branch starts at the parent's
  branch, and the child's changes are expected to go back to it.

The specification already has the user-facing half of this: creating a workspace
based on another workspace, so that work can build on work that has not landed
yet. The graph is what that capability implies once there is more than one of
them.

Two things about it are not settled. Whether a workspace can have more than one
parent — whether this is a tree or a wider graph — is question 18. Whether werk
keeps tracking the relationship after the workspace is made, or whether "derived
from" is only a fact about where a branch started, is question 6, and the answer
decides whether this graph exists as an object at all or only as history.

## Why they are not the same graph

They share their middle layer and nothing else.

|                         | Containment                           | Derivation                                |
| ----------------------- | ------------------------------------- | ----------------------------------------- |
| Nodes                   | Hosts, workspaces, terminal processes | Workspaces, and the place the client runs |
| Roots                   | Hosts                                 | Wherever the client is executing          |
| An edge means           | Lives on, or runs in                  | Was derived from                          |
| Crosses a host boundary | Never                                 | Freely                                    |
| Shape                   | A tree, necessarily                   | Probably a tree at first, see question 18 |

The last two rows are the whole point. A workspace on a Fly.io machine can
perfectly well be derived from a workspace on a Mac mini in someone's house, and
that edge is invisible in the containment graph, where the two workspaces sit
under different roots and have no relationship at all.

The practical consequence is that the two graphs want different code and
probably different storage. Walking containment is asking each host what it has.
Walking derivation is following pointers that may lead anywhere, including to a
host that is currently unreachable, which is a normal state rather than a
failure. Anything that tries to serve both from one traversal would be fighting
one of them.

It also means git does not follow the containment tree. A change moving from a
parent workspace to a child is moving between two hosts that may have no route
to each other, and how it gets there is question 21.

## Creating a workspace goes behind an interface

Making a workspace today would be roughly: get a machine, put a checkout on it,
make a branch. That is small enough to write inline and it is very unlikely to
stay that size. Provisioning through a provider API, waiting for a machine to
come up, getting credentials onto it, choosing between a clone and a worktree,
deriving from a parent that lives somewhere else, and rolling back a creation
that failed halfway are all things that would land on the same operation, and
most of them would arrive one at a time.

So the reason for the seam is not that the interface is hard to design. It is
that creation is expected to grow, and whatever calls it should not have to
change each time it does.

What the seam would have to survive, if the rest of this document is roughly
right:

- **Creation becoming slow and multi-step**, so the interface probably cannot be
  a function that returns a workspace. Something that reports progress, or
  returns a workspace that is not ready yet, seems more likely.
- **Creation failing partway**, with a machine made and no checkout on it.
  Whether the caller sees a half-made workspace or nothing at all is a choice
  the interface makes, and nobody has made it.
- **More than one kind of host behind it**, since a Mac mini reached over ssh
  and a machine an API creates on demand have almost nothing in common except
  the result. The nouns for those two are question 1.
- **Deriving from a workspace that is somewhere else**, which turns creation
  into an operation involving two hosts rather than one.

A reasonable guess at the boundary is that callers ask for a workspace by naming
what it should be derived from and where it should run, and everything about how
that happens sits behind the interface. That is a guess, not a decision, and it
is worth revisiting once there is a second kind of host to build against.

## What a package would own

The specification's capabilities are spread across three concerns that all touch
the same objects: making and destroying workspaces, running git against them,
and remembering what exists. Those three are hard to separate, because a git
operation needs to know where a workspace is and the answer to "where is it"
comes out of creating it. Putting them together in one package is the obvious
first cut.

That package would probably own:

- **The creation interface** described above, and the implementations behind it.
- **The git operations werk performs on its own behalf**: making a branch from a
  parent, moving a change between workspaces, and whatever
  [landing](product/landing.md) needs, which is the largest consumer.
- **The workspace record.** Whatever werk knows about a workspace: which host it
  is on, what it was derived from, which branch it holds, what state it is in.
  Where that record lives is question 19, and the state words the earlier work
  fixed are question 16.
- **Both traversals**, since it is the only thing that would hold enough to
  compute either.

What it would probably not own is anything about terminal processes, which the
session packages already do well, or anything about
[sharing](product/sharing.md), which is a layer above. A workspace would be
somewhere a terminal process runs, and the existing daemon would keep owning the
process itself.

## What the first version can be

A local git worktree, and nothing beyond it.

That means: one host, the machine werk is running on; a workspace made with
`git worktree add` from the repository the client is standing in; a branch made
at the same time; and a terminal process started in that directory by the daemon
that already exists. No remote, no provisioning, no transport, no derivation
across machines.

It is worth building in that order because it exercises the parts that are
easiest to get wrong and hardest to change later — the interface shape, the
workspace record, and the two traversals — while every hard problem in this
document stays absent. A worktree is a real workspace with a real branch, so
creating, listing, deriving one from another and destroying them are all
genuinely exercised. The derivation graph is real too, just with every node on
one host, which is exactly the case where an edge crossing a host boundary
cannot yet embarrass anyone.

What it deliberately leaves untested is the thing most likely to break the
model: a derivation edge between two machines. That would come next, and it is
the point at which question 21 has to have an answer.

## The questions this raises

Each of these is open in the specification, and none of them is answered here.

- [Question 1: what do we call a machine, and what do we call the thing that makes machines?](product-specification.md#1-what-do-we-call-a-machine-and-what-do-we-call-the-thing-that-makes-machines)
- [Question 3: are a person's hosts shared between their own machines?](product-specification.md#3-are-a-persons-hosts-shared-between-their-own-machines)
- [Question 5: how does a workspace tell that its changes have already landed?](product-specification.md#5-how-does-a-workspace-tell-that-its-changes-have-already-landed)
- [Question 6: what happens to a workspace when its parent lands?](product-specification.md#6-what-happens-to-a-workspace-when-its-parent-lands)
- [Question 13: do you attach to a workspace, or to a terminal process?](product-specification.md#13-do-you-attach-to-a-workspace-or-to-a-terminal-process)
- [Question 14: what ends a workspace?](product-specification.md#14-what-ends-a-workspace)
- [Question 16: which of the old words survive?](product-specification.md#16-which-of-the-old-words-survive)
- [Question 18: is the derivation graph a tree, or can a workspace come from more than one?](product-specification.md#18-is-the-derivation-graph-a-tree-or-can-a-workspace-come-from-more-than-one)
- [Question 19: where does the record of a workspace live?](product-specification.md#19-where-does-the-record-of-a-workspace-live)
- [Question 20: is the place the client is running a workspace?](product-specification.md#20-is-the-place-the-client-is-running-a-workspace)
- [Question 21: how does a change move between two workspaces on different hosts?](product-specification.md#21-how-does-a-change-move-between-two-workspaces-on-different-hosts)
