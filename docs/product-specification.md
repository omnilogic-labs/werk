# werk product specification

This is the current specification of what werk does.

It covers what a person can do with werk, what sharing and logging are for, and
what a company installs. It does not cover how any of it is built, beyond what
is already there. Almost nothing here is settled, and the words used are the
words we are thinking with rather than words anyone has committed to.

This file holds the vocabulary, the loop werk exists for, what is already true,
and the open questions. The subjects have a document each in
[`product/`](product/): [the client](product/client.md),
[landing](product/landing.md), [sharing](product/sharing.md),
[mappers](product/mappers.md) and [the portal](product/portal.md).
[Workspaces and git](workspaces-and-git.md) works through the model the client's
workspaces would sit on.

## Words used in these documents

| Word                  | What it means here                                                                                | Where it stands today                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **workspace**         | A named, isolated place for work: somewhere to run, a copy of the repository, its own branch.     | `werk create` makes one: a git worktree on this machine.                                              |
| **terminal process**  | One long-lived process with a terminal, inside a workspace. A workspace holds several.            | The code calls this a session.                                                                        |
| **host**              | A machine a workspace runs on.                                                                    | Absent from the code.                                                                                 |
| **provider**          | Something that produces hosts on demand, such as Kubernetes, Docker, or a cloud VM API.           | Nothing produces hosts. See question 1.                                                               |
| **parent**            | The branch a workspace was created from, and the branch its changes go back to.                   | `create` records the checkout a workspace was branched from.                                          |
| **land**              | Get the changes made in a workspace onto its parent branch.                                       | Nothing lands anything yet. The route is meant to be configurable; see [Landing](product/landing.md). |
| **mapper**            | A component that reports what a running process is doing, using more than its terminal output.    | Nothing reports this yet.                                                                             |
| **daemon**            | The long-lived process on a host that owns the terminal processes. Shorthand `werkd`.             | One runs, started by `werk daemon serve`. The binary is `werk`.                                       |
| **portal**            | The thing a company installs to configure hosts, workspaces, terminals and agents for its people. | Nothing of it exists.                                                                                 |
| **transcript**        | The record of what happened in a terminal process, readable after the process has ended.          | Does not exist yet.                                                                                   |
| **containment graph** | Host, the workspaces on it, and the terminal processes in those workspaces.                       | Nothing computes it. See [Workspaces and git](workspaces-and-git.md).                                 |
| **derivation graph**  | Workspaces and the workspaces they were derived from, wherever those live.                        | Nothing computes it. See [Workspaces and git](workspaces-and-git.md).                                 |
| **workspace record**  | Whatever werk stores about a workspace: where it is, what it came from, what state it is in.      | Nothing is stored. See question 19.                                                                   |
| **log**               | The record of who did what to a shared terminal, kept for review.                                 | Does not exist yet.                                                                                   |

## What werk is

werk starts a process somewhere and lets you come back to it later.

You run a lot of long-lived, interactive, semi-autonomous processes, mostly
coding agents. Each one wants a terminal, runs for tens of minutes to hours,
wants its own copy of a repository on its own branch, and periodically wants your
attention. werk provisions somewhere for that work to happen, puts your code
there on a branch, gives you a terminal into it that survives your laptop
closing, and shows you every one of those, across every machine, in one list you
can open from a terminal or a browser.

## The core loop

This is what werk does most of the time, and everything else is secondary to it:

1. **Start an agent somewhere that is not your laptop.** A Mac mini in your
   house, a VPS, a Fly.io machine.
2. **Detach.** Close the laptop and walk away. The agent keeps running.
3. **Check on it, or be told it wants you.** Its status, and the status of every
   other one, in a single list.
4. **Reattach**, see what it did, and deal with it.

The rest of the specification is either a part of that loop or something built
on top of it. werk is three pieces:

| Part                              | What it is                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| **[Client](product/client.md)**   | What one person runs, and where the loop above lives.                                         |
| **[Sharing](product/sharing.md)** | Letting someone else see a terminal, live or after the fact.                                  |
| **[Portal](product/portal.md)**   | What a company runs. How hosts, workspaces, terminals and agents are configured for everyone. |

Two parts of the client are large enough to have a document each.
[Landing](product/landing.md) is how the work done in a workspace gets onto the
branch that workspace came from. [Mappers](product/mappers.md) are how werk
works out what a running process is doing.

## What exists today

The session libraries are built and working. Everything below is real, and it is
the foundation the rest of the specification sits on. Nothing else described in
these documents exists yet.

- A daemon owns the terminal processes. Its word for one is a **session**: an
  argv, a working directory, a size, and a state of `starting`, `running`,
  `exited`, `failed` or `lost`.
- A viewer of a session is an **attachment**, carrying a principal and separate
  read and input permissions. Several attachments can watch one session.
- The CLI (`packages/werk`) has `create`, `list`, `attach`, `logs`, `kill`,
  `remove`, `watch`, `info`, `doctor`, `config`, `completion` and
  `daemon serve`. Detach is `Ctrl-]`. See [cli.md](cli.md).
- `create` makes a **workspace** and starts the command in it: a git worktree on
  this machine, on a branch of its own, branched from the checkout the caller is
  standing in. That is the whole of what a workspace is today — one host, no
  record of what exists, and nothing that ends one. `@werk/workspace` owns it
  and is explicitly under development.
- Reattach restores the real screen, decoded from a checkpoint by the libghostty
  WASM engine. `examples/session-web` does the same in a browser.
- Checkpoints are written per session to the state directory. Records of ended
  sessions survive a daemon restart, up to 512 of them. Live processes do not:
  killing the daemon abruptly leaves a `lost` record with its last screen and no
  process.
- Everything is TypeScript. `bun:ffi` is used for `flock` and for Windows job
  objects, and PTYs come from Bun's own spawn support rather than a native
  addon. Terminal interpretation is libghostty compiled to WASM and shipped as
  an asset, `packages/terminal/assets/terminal.wasm`. Where else WASM would earn
  its place is not worked out; a real performance win, or an ecosystem with no
  good TypeScript equivalent, are probably the cases that would.

Four things this specification needs that are absent today: git beyond making a
worktree and a branch, anything remote (the transport is a Unix socket or
loopback TCP), sharing as a product feature (the protocol supports it, nothing
uses it), and a durable log.
What is on disk now is a bounded screen checkpoint, roughly 10 MB of scrollback
by default, which is not a record of everything a process printed.

## Open questions

Genuinely open. Where there is a lean it is labelled as a lean.

### 1. What do we call a machine, and what do we call the thing that makes machines?

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

### 2. How does a person configure their hosts and providers?

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
list would be unusual, which is either an opportunity or a warning.

### 3. Are a person's hosts shared between their own machines?

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

Worth keeping from the earlier work: point werk at a machine, have it scan for
what is already there, and adopt it. That covers a new laptop, a lost index and
a stale one, without anything being synced.

### 4. Where does the landing agent run?

Landing invokes an agent, as a one-shot command such as `claude -p`, to write
commit messages and resolve conflicts. That invocation could happen on the
client, or on the host holding the copy of the parent. Both have the user's
credentials, so either works. What decides it is probably what the agent needs
to see: the diff alone, or the whole repository with its history.

### 5. How does a workspace tell that its changes have already landed?

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

### 6. What happens to a workspace when its parent lands?

Workspaces based on other workspaces form a chain. When the parent lands, is
rebased, or is abandoned, the children sit on a branch that has moved or gone.
Whether werk tracks that relationship after creation, or whether "based on" is
only a fact about where the branch started, is unresolved. The relationship is
the derivation graph in [Workspaces and git](workspaces-and-git.md), and how
much of it werk has to hold is worked through there.

### 7. What is a transcript made of, and what is the unit you share?

The transcript is the least specified thing in these documents. Open: whether
the
terminal output and the agent's activity are one thing or two views
of one thing; whether a transcript covers one terminal process, a whole
workspace, or a stretch of time across both; what a reviewer sees when a process
had no mapper; and whether a transcript can be edited or trimmed before it is
handed over.

The live terminal has its own version of the same question. The three access
levels are described per terminal, but full ssh access and file upload are
capabilities of a workspace.

### 8. A registered key and a link are two different kinds of identity

Registering someone's public key names a person. Sending a web link grants
whoever holds it. They probably want different answers on revocation, on expiry,
and on what a record can say about someone whose only identity is a link. This
applies to a shared transcript as much as to a live terminal, and a transcript
handed to someone can be copied in a way a live session cannot.

### 9. What is recorded by default, and kept for how long?

Recording probably has to start when a process starts rather than when a share
happens, because the sessions worth handing to someone afterwards are mostly
sessions nobody thought to share while they were running. That leaves the real
questions: how long a transcript is kept, who can delete one, whether a company
can overrule the person who ran it, and what it costs to keep everything. Today
nothing durable is recorded at all.

### 10. What may a mapper read, and what of that leaves the host?

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

### 11. What does a mapper read for history, and what happens when the host goes away?

A stateless mapper needs somewhere to read history from. Two candidates exist
and they are not the same thing: werk's own record of the terminal process, and
the agent's own files in the workspace. The second is richer, which is the whole
argument for mappers, and it belongs to the agent rather than to werk.

That creates a problem on a host that does not persist. When a Fly.io machine is
destroyed, `~/.claude` goes with it, and a mapper asked for the history of that
session afterwards has nothing to read. Either werk captures the agent's state
before the host goes away, or transcripts of ephemeral hosts are poorer than
transcripts of a Mac mini. Nobody has decided which.

### 12. What does registering a client with a portal take over?

All configuration lives with the local client until that client is registered
with a portal, at which point the portal takes over some of it. Which parts, how
a person sees what has been taken over, what happens to settings they already
had, and whether anything remains theirs to change, are all unresolved. This is
the mechanism the whole portal rests on and it is the least worked out part of
the specification.

### 13. Do you attach to a workspace, or to a terminal process?

Detaching from and reattaching to a workspace is stated at the workspace level,
but a workspace holds more than one terminal process and each one is what
actually holds a screen. With one or two processes per workspace, the obvious
reading is that the agent is the workspace's main terminal and reattaching goes
there, with the utility terminal reached deliberately. That is a guess. It also
raises whether the two are equal, or whether one is the workspace's process and
the other is a shell werk offers next to it. The code today attaches to one
session at a time. Both are nodes of the containment graph in
[Workspaces and git](workspaces-and-git.md).

### 14. What ends a workspace?

Nothing here says how a workspace stops existing, what happens to its branch,
its host resources, its logs and its shares when it does, or whether work that
has not landed can be destroyed. The earlier work treated "werk does not destroy
work that has not come back" as close to a promise. Whether that survives into
this specification is worth deciding rather than assuming.

### 15. Is the portal the thing that gets paid for?

The earlier research recorded that standalone paid terminal multiplexers keep
failing commercially, and that the survivors bundle into a larger product or
become infrastructure. The portal is the first thing described here that a
company would buy. Nobody has said it is the commercial answer, and saying so
would change what gets built first, so it is a question rather than a plan.

### 16. Which of the old words survive?

The earlier docs established nouns this specification does not use: **placement**
(the machine or container a workspace lives on, which "host" and "provider"
split in two), **project** (a repository as a grouping key across machines), and
**fleet** (every workspace on every machine as one collection). Workspace status
words were also fixed: `provisioning`, `ready`, `running`, `needs you`,
`stopped`, `unreachable`, `archived`. Those are worth keeping or dropping
deliberately. `unreachable` in particular earns its place: once werk spans
machines, "I cannot see it right now" is a normal state and not a failure.

### 17. How do you reach a service running inside a workspace?

Starting the dev server in the second terminal is one of the two things that
terminal is for. The dev server then listens on a port on a Mac mini, a VPS or a
Fly.io machine, and the browser that needs it is on the laptop. Nothing in these
documents gets that port to that browser. The options are the usual ones: werk
forwards it over the connection it already has, werk gives the workspace a URL,
or werk does nothing and you set up your own tunnel. This is not exotic, and it
becomes visible the first time anyone runs a web project in a workspace that is
not local.

### 18. Is the derivation graph a tree, or can a workspace come from more than one?

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

### 19. Where does the record of a workspace live?

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

This is question 3 asked about workspaces rather than hosts, and the two
probably want the same answer, which is a reason to decide them together rather
than separately. No lean.

### 20. Is the place the client is running a workspace?

The derivation graph is rooted wherever the client is executing, which is
usually a checkout on someone's laptop that werk did not create. Whether that
checkout is a workspace with everything a workspace has, or a different kind of
node that only ever appears as a root, is unresolved.

Treating it as a workspace makes the graph uniform and means "derive from what I
am standing in" is not a special case. Treating it as something else avoids
claiming werk owns a directory it did not make, and avoids questions about what
landing, ending, or sharing a workspace mean when applied to it. No lean, and
the answer probably falls out of question 14.

### 21. How does a change move between two workspaces on different hosts?

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

### 22. Is there a way to run a command without making a workspace?

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

### 23. Does werk's own output pin its colours, or borrow the reader's?

The palette is Catppuccin, behind `@werk/palette`, and everywhere werk puts
colour on a screen asks that library for a use rather than for a colour. Two of
the three surfaces have no question to answer: the replica's default foreground
and background, and the browser page, own their own pixels and take the hex.

The CLI's own output is the one that does, because it is a guest on a terminal
somebody else themed. Catppuccin publishes both halves — its colours, and which
of them sits in each of the sixteen slots a terminal theme defines — so there are
two ways to wear it.

- **Write the slot.** SGR 32 for green, 36 for teal. A reader whose terminal
  already wears Catppuccin sees the palette exactly, and a reader wearing
  anything else sees the contrast they chose. No truecolour is written, so the
  three depths the gate can report render identical bytes.
- **Write the hex.** Every reader sees the same colours whatever their terminal
  is set to, at the price of overriding a choice they made, and the output then
  differs by depth because a 16-colour terminal cannot be given a triple.

**Lean: write the slot**, which is what it does today. The reasoning is that a
reader who set their terminal's contrast deliberately is the reader most likely
to notice it being overridden, and the palette's own terminal mapping means a
Catppuccin user loses nothing by it. Upstream publishes no guidance either way:
the ports that hard-code hex are theming applications that own their whole
window, which a CLI writing to someone's shell does not. Nobody has asked to see
Catppuccin in werk's output on a terminal that is not themed for it, which is the
evidence this question is short of. Changing the answer is a change inside
`packages/werk/src/runtime/style.ts` and the help test that reads the roles.

Two smaller things hang off it.

- **Which flavour.** Mocha is what `dark` resolves to and Latte is exported
  beside it, unused. Catppuccin names no canonical flavour and its ports differ,
  so this is a pick rather than a finding. Whether the browser page should follow
  `prefers-color-scheme` into Latte is open; the generated `palette.css` makes it
  a small change.
- **The replica's sixteen.** A child program's SGR 31 is painted with whatever
  the ghostty engine holds in its own palette, which werk reads out rather than
  sets. Seeding it with Catppuccin's ANSI mapping would make a child's colours
  match werk's, and would also override a choice the child's own environment may
  be making. Nobody has looked at what that costs.
