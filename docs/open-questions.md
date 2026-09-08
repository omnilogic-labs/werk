# Open questions

The questions the [product specification](product-specification.md) has not
answered. They are genuinely open. Where there is a lean it is labelled as a
lean, and where nobody has taken a position that is said rather than filled in.

Several answers refer to **the earlier work**, which the specification
identifies: the product documents and research dossiers this specification
replaced, removed in commit `42d3475` and readable with
`git show 42d3475^:<path>`.

## 1. What do we call a machine, and what do we call the thing that makes machines?

A host is a machine a workspace runs on. The likely early targets are a Mac mini
in someone's house, a rented VPS, and Fly.io. The first two are machines that
already exist and that you reach over ssh. Fly.io is not a machine at all: it is
an API that makes machines, as are Kubernetes, Docker and the sandbox providers.
That second kind of thing probably needs its own noun.

What comparable products use:

| Pair                      | Who uses it                                                | What a user would assume                                                                                       |
| ------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| host / **provider**       | DevPod (`devpod provider add docker`), Terraform providers | A pluggable backend that knows how to create and destroy compute. Closest fit.                                 |
| machine / **provisioner** | Coder provisioner daemons, Fly.io Machines                 | Coder's meaning, which collides with Terraform's unrelated `provisioner` block.                                |
| node / **runner**         | Nomad and Tailscale use node; Gitpod Flex uses runner      | Node collides with the Kubernetes Node object when Kubernetes is a backend. Runner reads as a CI job executor. |
| target / **backend**      | Nobody, as a pair                                          | Under-specified, and backend collides with Terraform state backends.                                           |

**Lean:** host and provider. Provider carries the right meaning to anyone who
has used DevPod or Terraform, and host is already what the ssh and Docker worlds
call a machine. The cost is that "provider" is also what people call the vendor
of an AI model, which werk will also have to talk about.

## 2. How does a person configure their hosts and providers?

Unresolved, and it is the first thing a new user meets. Four patterns exist in
comparable tools:

- An interactive add command with named instances, so one provider type can be
  configured several times. DevPod: `devpod provider add kubernetes --name prod
-o NAMESPACE=devpods`.
- A declarative config file plus an init step. Terraform.
- A daemon that registers itself with the control plane using a key. Coder
  provisioners, Tailscale nodes.
- Generating entries into config from another tool. `aws eks update-kubeconfig`
  writes a kubeconfig context.

None of them read another tool's existing config to discover what you already
have. Reading `~/.ssh/config`, kubeconfig or Docker contexts to offer a starting
list would therefore have no precedent among the four. Whether that is because
it is a bad idea or because nobody has tried it is not known.

## 3. Are a person's hosts shared between their own machines?

Configuration lives with the local client, so the list of hosts is the client's.
That settles most of this. What is left is narrower: whether two clients
belonging to the same person share anything, so that werk on a second laptop
knows about the Mac mini without being told again.

The split in comparable tools is clean. Single-user tools keep it local: Docker
contexts in `~/.docker`, kubeconfig in `~/.kube/config`, DevPod providers in
`~/.devpod`. Products with an organisation in them keep it centrally: Coder
organisations and provisioners, Gitpod Flex runners, Tailscale tailnets, GitHub
Codespaces policies. The same split appears here, with the portal on the second
side.

Worth keeping from the earlier work, in `docs/product/04-open-questions.md`:
point werk at a machine, have it scan for what is already there, and adopt it.
That covers a new laptop, a lost index and a stale one, without anything being
synced.

## 4. Where does the landing agent run?

Landing invokes an agent, as a one-shot command such as `claude -p`, to write
commit messages and resolve conflicts. That invocation could happen on the
client, or on the host holding the copy of the parent. Both have the user's
credentials, so either works. What decides it is probably what the agent needs
to see: the diff alone, or the whole repository with its history.

## 5. How does a workspace tell that its changes have already landed?

Phabricator's answer was to put a marker in the commit, so the origin of a change
was recorded rather than inferred. werk writing its own marker into the commit it
produces is the strongest candidate, and comparing commit messages is another.

The obvious alternatives fail on exactly the route this team will use. Commit
containment does not work when the change was squashed, because the commit on the
parent is a new object. Patch equivalence is closer but breaks when anything was
rebased or edited on the way in. Asking the forge whether the pull request was
merged works for the pull request route and not for the others, and a marker only
works when the commit came through werk. This probably needs more than one check,
and it needs to be honest when it is unsure.

## 6. What happens to a workspace when its parent lands?

Workspaces based on other workspaces form a chain. When the parent lands, is
rebased, or is abandoned, the children sit on a branch that has moved or gone.
Whether werk tracks that relationship after creation, or whether "based on" is
only a fact about where the branch started, is unresolved. The relationship is
the derivation graph in [Workspaces and git](workspaces-and-git.md), and how
much of it werk has to hold is worked through there.

## 7. What is a transcript made of, and what is the unit you share?

The transcript is the least specified thing in these documents. Four things are
open. Whether the terminal output and the agent's activity are one thing or two
views of one thing. Whether a transcript covers one terminal process, a whole
workspace, or a stretch of time across both. What a reviewer sees when a process
had no mapper. Whether a transcript can be edited or trimmed before it is handed
over.

The live terminal has its own version of the same question. The three access
levels are described per terminal, but full ssh access and file upload are
capabilities of a workspace.

## 8. A registered key and a link are two different kinds of identity

Registering someone's public key names a person. Sending a web link grants
whoever holds it. They probably want different answers on revocation, on expiry,
and on what a record can say about someone whose only identity is a link. This
applies to a shared transcript as much as to a live terminal, and a transcript
handed to someone can be copied in a way a live session cannot.

## 9. What is recorded by default, and kept for how long?

Recording probably has to start when a process starts rather than when a share
happens, because the sessions worth handing to someone afterwards are mostly
sessions nobody thought to share while they were running. That leaves the real
questions: how long a transcript is kept, who can delete one, whether a company
can overrule the person who ran it, and what it costs to keep everything. Today
nothing durable is recorded at all.

## 10. What may a mapper read, and what of that leaves the host?

A mapper for `claude` reads the agent's files, and `~/.claude` holds credentials
as well as history. werk put those credentials there itself, so their presence
is by design and the host is assumed to be the user's own. The question is
narrower than it looks: what a mapper returns is shown to whoever asked for the
status, and that can be someone the terminal was shared with. So the line to
draw is what mapper output may contain, not whether secrets are nearby.

If mappers run in the client, those reads cross the network rather than staying
on the host, which makes the read interface the place the line gets drawn and
makes drawing it deliberately more important.

Being stateless helps: a mapper holds nothing between calls, so there is no
store of anything it read to protect.

## 11. What does a mapper read for history, and what happens when the host goes away?

A stateless mapper needs somewhere to read history from. Two candidates exist
and they are not the same thing: werk's own record of the terminal process, and
the agent's own files in the workspace. The second is richer, which is the whole
argument for mappers, and it belongs to the agent rather than to werk.

That creates a problem on a host that does not persist. When a Fly.io machine is
destroyed, `~/.claude` goes with it, and a mapper asked for the history of that
session afterwards has nothing to read. Either werk captures the agent's state
before the host goes away, or transcripts of ephemeral hosts are poorer than
transcripts of a Mac mini. Nobody has decided which.

## 12. What does registering a client with a portal take over?

All configuration lives with the local client until that client is registered
with a portal, at which point the portal takes over some of it. Which parts, how
a person sees what has been taken over, what happens to settings they already
had, and whether anything remains theirs to change, are all unresolved. This is
the mechanism the whole portal rests on and it is the least worked out part of
the specification.

## 13. Do you attach to a workspace, or to a terminal process?

Detaching from and reattaching to a workspace is stated at the workspace level,
but a workspace holds more than one terminal process and each one is what
actually holds a screen. With one or two processes per workspace, the obvious
reading is that the agent is the workspace's main terminal and reattaching goes
there, with the utility terminal reached deliberately. That is a guess. It also
raises whether the two are equal, or whether one is the workspace's process and
the other is a shell werk offers next to it. The code today attaches to one
session at a time. Both are nodes of the containment graph in
[Workspaces and git](workspaces-and-git.md).

## 14. What ends a workspace?

Nothing here says how a workspace stops existing, what happens to its branch,
its host resources, its logs and its shares when it does, or whether work that
has not landed can be destroyed. The earlier work stated "werk does not destroy
unreturned work" as close to a guarantee, in `docs/product/01-object-model.md`.
Whether that survives into this specification is worth deciding rather than
assuming.

## 15. Is the portal the thing that gets paid for?

The earlier research recorded that standalone paid terminal multiplexers keep
failing commercially, and that the survivors bundle into a larger product or
become infrastructure. It is in `docs/research/13-landscape.md`, which lists the
casualties it read that from. The portal is the first thing described here that a
company would buy. Nobody has said it is the commercial answer, and saying so
would change what gets built first, so it is a question rather than a plan.

## 16. Which of the old words survive?

The earlier docs established nouns this specification does not use, in
`docs/research/06-vocabulary.md` and `docs/product/01-object-model.md`:
**placement** (the machine or container a workspace lives on, which "host" and
"provider" split in two), **project** (a repository as a grouping key across
machines), and **fleet** (every workspace on every machine as one collection).
Workspace status words were also fixed: `provisioning`, `ready`, `running`,
`needs you`, `stopped`, `unreachable`, `archived`. Those are worth keeping or dropping
deliberately. `unreachable` in particular earns its place: once werk spans
machines, "I cannot see it right now" is a normal state and not a failure.

## 17. How do you reach a service running inside a workspace?

Starting the dev server in the second terminal is one of the two things that
terminal is for. The dev server then listens on a port on a Mac mini, a VPS or a
Fly.io machine, and the browser that needs it is on the laptop. Nothing in these
documents gets that port to that browser. The options are the usual ones: werk
forwards it over the connection it already has, werk gives the workspace a URL,
or werk does nothing and you set up your own tunnel. This is not exotic, and it
becomes visible the first time anyone runs a web project in a workspace that is
not local.

## 18. Is the derivation graph a tree, or can a workspace come from more than one?

A workspace created from another workspace has one parent, which makes the
derivation graph a tree. Nothing forces it to stay one. Someone with two
unlanded workspaces who wants a third that sees both work would be asking for a
second parent, and git merges as readily as it branches, so the shape is
available.

The cost of allowing it is that everything downstream gets harder: "has this
landed" (question 5) has more than one answer to reconcile, "what happens when
the parent lands" (question 6) has more than one parent to react to, and any
display of the graph stops being a list with indentation.

**Lean:** a tree first, because it is the shape people described and the cheaper
one to build, while writing down that the second parent is the thing most likely
to arrive next. Whether the stored shape should already allow a second parent
even while nothing creates one is a separate call nobody has made.

## 19. Where does the record of a workspace live?

Something has to know a workspace exists, which host it is on, what it was
derived from and what state it is in. Where that lives is open, and the options
carry different failure modes.

- **With the client that made it.** Consistent with configuration living with
  the local client. A second machine then knows nothing, and a lost index loses
  the graph.
- **On the host, next to the workspace.** Survives the client. Scattered across
  every host, and a host that is unreachable takes its part of the answer with
  it.
- **Both, with the client's copy treated as a cache.** Scanning a host and
  adopting what is there, the approach worth keeping from question 3, points
  this way. It costs a reconciliation nobody has designed.

Nothing records one today. Where a workspace has to be named after the fact, as
`werk list` and the status row `werk attach` paints on the bottom line of the
terminal both do, it is reconstructed from the directory the session was started
in, by asking whether this host's layout is what put it
there. That reaches exactly as far as this host: a workspace on another machine,
or one a differently shaped host laid out, has no route through it, and neither
does anything wanting to know a workspace exists when no session is running in
it.

This is question 3 asked about workspaces rather than hosts, and the two
probably want the same answer, which is a reason to decide them together rather
than separately. No lean.

## 20. Is the place the client is running a workspace?

The derivation graph is rooted wherever the client is executing, which is
usually a checkout on someone's laptop that werk did not create. Whether that
checkout is a workspace with everything a workspace has, or a different kind of
node that only ever appears as a root, is unresolved.

Treating it as a workspace makes the graph uniform and means "derive from what I
am standing in" is not a special case. Treating it as something else avoids
claiming werk owns a directory it did not make, and avoids questions about what
landing, ending, or sharing a workspace mean when applied to it. No lean, and
the answer probably falls out of question 14.

## 21. How does a change move between two workspaces on different hosts?

Deriving a workspace on one host from a workspace on another needs the second
host's branch to reach the first. The available shapes are the ordinary git
ones, and they differ in what they assume.

- **Through a shared remote.** The parent pushes to a forge both hosts can
  reach, and the child clones or fetches from it. Assumes a remote exists and
  that unlanded work is allowed to be pushed to it.
- **Client in the middle.** The client fetches from the parent and pushes to the
  child, which is the only path guaranteed to exist, because the client is by
  definition able to reach the workspaces it made. Costs the bytes twice and
  makes the client's connectivity the limit.
- **Host to host directly.** Fastest when it works, and it needs the two hosts
  to be able to reach each other, which for a Mac mini in a house and a Fly.io
  machine they generally cannot.

**Lean:** the client in the middle, because it is the only one that works
without an assumption about the network or a forge, and it is the same reasoning
that has the client coordinating [landing](product/landing.md). Whether a shared
remote should be used when there is one, as an optimisation rather than a
requirement, is not worked out.

## 22. Is there a way to run a command without making a workspace?

`werk create` makes a workspace, so it needs a repository and fails without one.
That is what the core loop describes. It also means the command cannot start a
process anywhere else — a shell in a home directory, or a long-running job in a
directory that is not a checkout.

- **Leave it.** A command that sometimes makes a workspace is the thing worth
  avoiding, and a person who wants a bare process has a terminal multiplexer.
- **A flag on `create`** that runs the command where the caller is standing.
- **Treat the checkout the client is running in as a workspace**, which is
  question 20, so that "here" is a workspace like any other and running in it
  is not a special case.

The third is the only one that adds no special case, which is a reason to answer
question 20 before adding a flag. That is a lean about the order to take them
in, not about the answer. Nobody has hit the failure in use yet, which is the
evidence this question is short of.

## 23. How much of a terminal's own choices should werk's theme override?

Two halves of this are settled and are described in [cli.md](cli.md#colour):
what werk writes at each colour depth, and the rule that the terminal replica
repaints only the colour entries a child has left alone, so a program that sets
its own with `OSC 4` keeps them. What is open is how far to take it.

- **Whether asking the terminal is worth its cost.** A terminal that answers
  neither the colour query nor the device attributes request behind it costs
  150 ms once, and the 150 ms is a guess rather than a measurement. The
  alternative is to make the question opt-in and default to a dark flavour, which
  costs nothing and gets it wrong on a light terminal for anyone who has not
  configured one. **Lean: keep asking**, because a reader who never configures
  anything is the one the question is for, and pinning a flavour already skips
  it. Nobody has run werk on a terminal that answers neither, which is the
  evidence this is short of.
- **How much the accent should reach.** It reaches a heading and an active
  border, and never anything that carries meaning. Ports that support accents at
  all mostly move a single token, so two is already more than most; but a CLI has
  almost no chrome, so two may also be too few for the accent to be worth
  choosing. Nobody has picked an accent in anger yet.
- **Whether an operating system's own appearance setting should be consulted**
  when the terminal will not answer. macOS, Windows and the freedesktop portal
  all publish one, and they describe the desktop rather than the terminal, so
  they are a proxy that is right most of the time and wrong for anyone running a
  light terminal on a dark desktop. `bat` offers it on macOS only and behind an
  explicit opt-in, which is evidence that the proxy is worth having and not worth
  trusting silently.
- **Whether werk's replica should answer the colour query itself.** It answers
  the device attributes request and not the colour one, so a program running
  inside werk cannot learn the background werk is painting it on — which is the
  same question this one asks, one level down, with werk on the other side of it.

## 24. What is the host component of a workspace reference?

A workspace reference is written at three levels of verbosity, and the most
verbose one names a host: [cli.md](cli.md#referencing-a-workspace) has the
notation. The host component is absent today, because there is no host in the
model to read one from, and what a host is even called is question 1. What its
absence should mean is open.

- **Absence means the machine werk is running on.** A reference that names no
  host is about here. Nothing has to be invented while there is one host, and a
  reference stays short in the case that is currently every case. A reference
  then changes meaning depending on where it is read, which matters as soon as
  one is written down somewhere and read somewhere else.
- **Every reference names a host, with a literal for this machine.** A reference
  means the same thing wherever it is read. It requires picking that literal now,
  which is naming a thing the model does not have, and question 1 has not fixed
  the noun.
- **The component carries enough to reach the host**, rather than a label for it.
  That is what somebody typing a reference at another machine would want. It
  collides with the `@` and `:` the grammar already spends, and question 21 has
  not settled how a change moves between hosts at all.

**Lean: absence means the machine werk is running on**, and this is a lean rather
than a decision. It is the only option that adds no claim, and it is what the
code does today. The cost lands when a reference first travels between machines,
which is the point at which this wants answering properly.

This is question 19 seen from the other end. That question asks where the record
of a workspace lives; this one asks how a workspace is written down once
something has to name one it did not make.
