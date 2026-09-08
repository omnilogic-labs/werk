# Workspaces and git

How werk makes a workspace, what it needs to remember about one, and which git
operations follow from that. This is a model being worked through rather than a
design anyone has agreed. Almost every position below is a lean or an option,
and the places where nobody has taken one are marked as such.

It sits under [the client](product/client.md) in the
[product specification](product-specification.md), which describes creating a
workspace, deriving one from another, and landing as capabilities. This document
is about the shape underneath those capabilities: what the objects are, how they
relate, and where the boundary goes between code that asks for a workspace and
code that makes one.

## What exists today

The session packages own processes, not repositories. `@werk/workspace` owns the
two pieces of this document that are built. `werk create` makes a git worktree
on a new branch, from the checkout the caller is standing in, and starts the
session in it; `--host` makes the same thing on a machine reached over ssh.
`werk land` takes the commits made in a workspace on this machine, squashes them
onto a throwaway copy of the branch the caller is standing on, and fast-forwards
that branch onto the result. [Landing](product/landing.md) is what it is the
first route of.

`create` also writes a small record beside the worktree, on the machine werk was
run on, holding the branch the workspace was made from and the commit it started
at. That exists because landing needs the parent branch and nothing can recover
it afterwards. It is not the workspace record this document describes below, and
[question 19](open-questions.md#19-where-does-the-record-of-a-workspace-live)
is not closed by it: it holds no state, carries no derivation, and nothing
reconciles it with anything.

There is one notation for writing a workspace down, at three levels of
verbosity, and everywhere that names a workspace uses it. Nothing reads the
record above for this: the places that hold a directory rather than a workspace
work back to one from the path, which reaches as far as this host's own layout. The host half of the notation has nothing to read from yet and is
absent; question 24 carries what its absence should mean.

The other git call the client makes is `git rev-parse --show-toplevel`, in the
configuration loader, to find the root of the repository the caller is standing
in so that the project configuration layer can be read from `<repository>/.werk`.
It is there because asking git is the only way to get the answer git would give
for a worktree, a submodule or a `.git` file, and it fails softly outside a
repository. Beyond those there is no clone and no fetch anywhere in the product packages,
and the only push is the one that sends a history to a machine `--host` named.

So nearly all of this is a design for something that does not exist yet, written
before the first line of it, which is the cheapest time to be wrong about it.

## What the first version can be

A local git worktree, and nothing beyond it.

That means: one host, the machine werk is running on; a workspace made with
`git worktree add` from the repository the client is standing in; a branch made
at the same time; and a terminal process started in that directory by the daemon
that already exists. No remote, no provisioning, no transport, no derivation
across machines.

Three things make that a good order to build in. It exercises the parts that are
easiest to get wrong and hardest to change later: the shape of the creation
interface, the workspace record, and the two traversals below. A worktree is a
real workspace with a real branch, so creating, listing, deriving one from
another and destroying them are all genuinely exercised. And every hard problem
in this document stays absent, because with one host no derivation edge can
cross a host boundary.

What it deliberately leaves untested is the thing most likely to break the
model: a derivation edge between two machines. That would come next, and it is
the point at which
[question 21](open-questions.md#21-how-does-a-change-move-between-two-workspaces-on-different-hosts)
has to have an answer.

## Two graphs, sharing one middle layer

werk needs two different answers about a workspace, and they come from two
graphs rather than from two views of one.

A **containment graph** is what you get by asking what holds what. Its nodes are
hosts, providers, workspaces and terminal processes, where a host is a machine
and a provider is something that makes hosts, such as incus, Kubernetes or
Docker. An edge means "lives on", "was made by" or "runs in". It is a tree for a
solid reason rather than by convention: a directory is on exactly one machine, a
process runs in exactly one directory, and a container is on exactly one machine.

Its roots are the hosts and providers werk reaches directly, because somebody
configured them, rather than through something werk already knows about.
Reaching a thing is not containing it, and that is what decides the roots: turn
this machine off and a machine it reaches over ssh keeps running. A provider is
more often on a host than not, so the graph nests. A machine reached over ssh
can run incus, a container incus makes is another host, and the path from the
root down to a terminal process is five nodes rather than three. A provider werk
reaches at an address instead, such as Fly.io or a sandbox API, sits on no
machine anybody here owns and is a root of its own.

A **derivation graph** is what you get by asking where a workspace's code came
from. Its root is wherever the client is executing, and an edge means "was
derived from": the child's branch starts at the parent's branch, and the child's
changes are expected to go back to it.

|                      | Containment                                      | Derivation                                       |
| -------------------- | ------------------------------------------------ | ------------------------------------------------ |
| Nodes                | Hosts, providers, workspaces, terminal processes | Workspaces, and the place the client runs        |
| Roots                | What werk reaches directly                       | Wherever the client is executing                 |
| An edge means        | Lives on, was made by, or runs in                | Was derived from                                 |
| Relates two machines | Only when one contains the other                 | Freely, including two with no route between them |
| Shape                | A tree, necessarily                              | Probably a tree at first, see question 18        |

A workspace on a Fly.io machine can be derived from a workspace on a Mac mini in
someone's house. That edge is invisible in the containment graph, where the two
workspaces sit under different roots and have no relationship at all.

Two consequences follow from that. Git does not follow the containment tree: a
change moving from a parent workspace to a child is moving between two machines
that may have no route to each other, so it moves through the client, which
fetches from the parent and pushes to the child. That is what is being tried
rather than an answer: [hosts.md](hosts.md) says what it costs.
And the two graphs want different code and probably different storage, because
walking containment is asking each host what it has, while walking derivation is
following pointers that may lead to a host that is currently unreachable, which
is a normal state rather than a failure.

Three things about the derivation graph are unsettled: whether a workspace can
have more than one parent
([question 18](open-questions.md#18-is-the-derivation-graph-a-tree-or-can-a-workspace-come-from-more-than-one)),
whether werk tracks a derivation after the workspace is made or whether "derived
from" is only a fact about where a branch started
([question 6](open-questions.md#6-what-happens-to-a-workspace-when-its-parent-lands)),
and whether the checkout the client is standing in counts as a node in it at all
([question 20](open-questions.md#20-is-the-place-the-client-is-running-a-workspace)).
The answer to question 6 decides whether the graph exists as an object or only
as history.

## Creating a workspace goes behind an interface

Making a workspace today would be roughly: get a machine, put a checkout on it,
make a branch. That is small enough to write inline and it is very unlikely to
stay that size. Provisioning through a provider API, waiting for a machine to
come up, getting credentials onto it, choosing between a clone and a worktree,
deriving from a parent that lives somewhere else, and rolling back a creation
that failed halfway are all things that would land on the same operation, and
most of them would arrive one at a time.

So the reason for the interface is not that it is hard to design. It is that
creation is expected to grow, and whatever calls it should not have to change
each time it does.

What that interface would have to survive, if the rest of this document is
roughly right:

- **Creation becoming slow and multi-step**, which is why `create` takes an
  options argument carrying a progress callback and a signal. It still resolves
  to a finished workspace; returning one that is not ready yet was the other
  shape available and nothing needed it, so a workspace has no lifecycle and
  [question 16](open-questions.md#16-which-of-the-old-words-survive) stays open.
- **Creation failing partway**, with a machine made and no checkout on it. The
  ssh maker undoes what it made, in reverse and best-effort, and leaves the bare
  mirror alone because every workspace of that repository shares it. Whether a
  caller should ever see a half-made workspace instead is still a choice nobody
  has made.
- **More than one way of getting a host**, since a Mac mini that already exists
  and is reached over ssh, and a container something makes on demand, have
  almost nothing in common except the result. What to call the thing that makes
  machines is
  [question 1](open-questions.md#1-what-do-we-call-a-machine-and-what-do-we-call-the-thing-that-makes-machines).
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
  [landing](product/landing.md) needs, which is the largest consumer. Two of
  those are there: the branch, and a landing onto a parent in the same
  repository. Moving a change between two workspaces is not, and it is the one
  that would cross a host boundary.
- **The workspace record.** Whatever werk knows about a workspace: which host it
  is on, what it was derived from, which branch it holds, what state it is in.
  Where that record lives is
  [question 19](open-questions.md#19-where-does-the-record-of-a-workspace-live),
  and the state words the earlier work fixed are
  [question 16](open-questions.md#16-which-of-the-old-words-survive). It would
  also be what a reference is resolved against, in place of the reconstruction
  from a path that stands in for one today.
- **Both traversals**, since it is the only thing that would hold enough to
  compute either.

What it would probably not own is anything about terminal processes, which the
session packages already do well, or anything about
[sharing](product/sharing.md), which is a layer above. A workspace would be
somewhere a terminal process runs, and the existing daemon would keep owning the
process itself.
