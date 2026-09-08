# werk product specification

This is the current specification of what werk does.

It covers what a person can do with werk, what sharing and logging are for, and
what a company installs. It does not cover how any of it is built, beyond what
is already there. Almost nothing here is settled, and the words used are the
words we are thinking with rather than words anyone has committed to.

This file holds the vocabulary, the loop werk exists for, and what is already
true. The subjects have a document each in [`product/`](product/):
[the client](product/client.md), [landing](product/landing.md),
[sharing](product/sharing.md), [mappers](product/mappers.md) and
[the portal](product/portal.md). [Workspaces and git](workspaces-and-git.md)
works through the model the client's workspaces would sit on. The 24 questions
nobody has answered are in [open-questions.md](open-questions.md).

Several documents refer to **the earlier work**. That means the product
documents `docs/product/00-what-werk-is.md` through `04-open-questions.md` and
the research dossiers `docs/research/01-libghostty-vt.md` through
`13-landscape.md`, which this specification replaced. They were removed in
commit `42d3475` and any of them can still be read, for example with
`git show 42d3475^:docs/research/06-vocabulary.md`.

## Words used in these documents

| Word                  | What it means here                                                                                | Where it stands today                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **workspace**         | A named, isolated place for work: somewhere to run, a copy of the repository, its own branch.     | `werk create` makes one: a git worktree on this machine.                                                                                   |
| **terminal process**  | One long-lived process with a terminal, inside a workspace. A workspace holds several.            | The code calls this a session.                                                                                                             |
| **host**              | A machine a workspace runs on, whether somebody already had it or a provider made it.             | Absent from the code. See [what we are currently trying](#what-we-are-currently-trying).                                                                                                                      |
| **provider**          | Something that creates and manages hosts, such as incus, Kubernetes, Docker or a cloud VM API.    | Nothing makes hosts. See [question 1](open-questions.md#1-what-do-we-call-a-machine-and-what-do-we-call-the-thing-that-makes-machines). |
| **parent**            | The branch a workspace was created from, and the branch its changes go back to.                   | `create` records the checkout a workspace was branched from.                                                                               |
| **land**              | Get the changes made in a workspace onto its parent branch.                                       | Nothing lands anything yet. The route is meant to be configurable; see [Landing](product/landing.md).                                      |
| **mapper**            | A component that reports what a running process is doing, using more than its terminal output.    | Nothing reports this yet.                                                                                                                  |
| **daemon**            | The long-lived process on a host that owns the terminal processes. Shorthand `werkd`.             | One runs, started by `werk daemon serve`. The binary is `werk`.                                                                            |
| **portal**            | The thing a company installs to configure hosts, workspaces, terminals and agents for its people. | Nothing of it exists.                                                                                                                      |
| **transcript**        | The record of what happened in a terminal process, readable after the process has ended.          | Does not exist yet.                                                                                                                        |
| **containment graph** | Hosts and any providers that made them, the workspaces on those hosts, and the processes in them. | Nothing computes it. See [Workspaces and git](workspaces-and-git.md).                                                                      |
| **derivation graph**  | Workspaces and the workspaces they were derived from, wherever those live.                        | Nothing computes it. See [Workspaces and git](workspaces-and-git.md).                                                                      |
| **workspace record**  | Whatever werk stores about a workspace: where it is, what it came from, what state it is in.      | Nothing is stored. See [question 19](open-questions.md#19-where-does-the-record-of-a-workspace-live).                                      |
| **log**               | The record of who did what to a shared terminal, kept for review.                                 | Does not exist yet.                                                                                                                        |
| **chrome**            | The status row werk paints on the bottom line of the terminal while an attachment holds it.       | `werk attach` paints one. See [cli.md](cli.md#the-chrome).                                                                                 |
| **output mode**       | Which shape a command's answer takes: text for a person, or one JSON value for a machine.         | Both are built; `--json` selects the second. See [cli.md](cli.md#two-output-modes).                                                        |
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

Four things this specification needs are absent today:

- git beyond making a worktree and a branch;
- anything remote: the transport is a Unix socket or loopback TCP;
- sharing as a product feature, which the protocol supports and nothing uses;
- a durable log.

What is on disk now is a bounded screen checkpoint, roughly 10 MB of scrollback
by default, which is not a record of everything a process printed.

## What we are currently trying

Four things are being tried in the work going on now. None of them is a
decision. They are written down so that the next person works on the same shape
rather than a different one, and any of them can be replaced as soon as it turns
out to be wrong.

**Hosts are `[hosts.<name>]` tables in `~/.werk/config.toml`.** A host gets a
name in the file, and that name is what a person types and what a reference
would carry. It puts
hosts in the layered configuration the CLI already reads, described in
[cli.md](cli.md#configuration), rather than in a store of their own. What a
provider looks like in the same file is question 2.

**werk ships its own compiled daemon to a host and reaches it by forwarding the
daemon's unix socket over ssh.** OpenSSH's `-L` takes a socket path at either
end, so the daemon on the host binds an ordinary unix socket exactly as the
local one does, and the client speaks the same protocol to a remote daemon as to
a local one. There is then no remote protocol and no second transport. This is
the same trick `DOCKER_HOST` over ssh uses, so the ground is well trodden.
Windows is the known gap: Win32-OpenSSH forwards unix sockets in neither
direction, so a
Windows client's forward has to land on a loopback TCP port and the daemon it
reaches has to be listening on one.

**Code reaches a host through the client.** The client pushes from the local
checkout to the workspace it made, rather than the two hosts talking to each
other or both talking to a shared forge. It is the only path guaranteed to
exist, because the client is by definition able to reach the workspaces it made.
It costs the bytes twice and it makes the client's connectivity the limit.
Whether a shared remote should be used when there is one, as an optimisation
rather than a requirement, is not worked out.

**A wizard, `werk config setup`, reads `~/.ssh/config` and offers the machines
the user already reaches.** Question 2 records that no comparable tool reads
another tool's configuration to discover what you already have, and that doing
it is either an opportunity or a warning. This is taking the opportunity, and it
will find out which it was.

## Open questions

Genuinely open. Where there is a lean it is labelled as a lean.

### 1. What do we call the thing that makes machines?

A host is a machine a workspace runs on, and that is what host means throughout
these documents. What is not settled is the noun for the thing that makes
machines. A Mac mini in someone's
house and a rented VPS are machines that already exist and that you reach over
ssh. Fly.io is not a machine at all: it is an API that makes machines, as are
Kubernetes, Docker and incus. You ask that second kind of thing for a machine
and what it hands back is a host, so it needs a noun of its own.

What comparable products use:

| Pair                      | Who uses it                                                | What a user would assume                                                                                       |
| ------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| host / **provider**       | DevPod (`devpod provider add docker`), Terraform providers | A pluggable backend that knows how to create and destroy compute. Closest fit.                                 |
| machine / **provisioner** | Coder provisioner daemons, Fly.io Machines                 | Coder's meaning, which collides with Terraform's unrelated `provisioner` block.                                |
| node / **runner**         | Nomad and Tailscale use node; Gitpod Flex uses runner      | Node collides with the Kubernetes Node object when Kubernetes is a backend. Runner reads as a CI job executor. |
| target / **backend**      | Nobody, as a pair                                          | Under-specified, and backend collides with Terraform state backends.                                           |

**Lean:** provider. It carries the right meaning to anyone who has used DevPod
or Terraform, and it leaves host meaning what the ssh and Docker worlds already
mean by it. The cost is that "provider" is also what people call the vendor of
an AI model, which werk will also have to talk about.

### 2. How is a provider configured?

Hosts are being given `[hosts.<name>]` tables in `~/.werk/config.toml`, so what
is left of this question is the provider half, and that half is harder: a
provider is something that makes hosts, and nothing makes hosts yet.

Four patterns exist in comparable tools:

- An interactive add command with named instances, so one provider type can be
  configured several times. DevPod: `devpod provider add kubernetes --name prod
-o NAMESPACE=devpods`.
- A declarative config file plus an init step. Terraform.
- A daemon that registers itself with the control plane using a key. Coder
  provisioners, Tailscale nodes.
- Generating entries into config from another tool. `aws eks update-kubeconfig`
  writes a kubeconfig context.

None of them reads another tool's existing configuration to discover what you
already have. Doing it is unusual, which is either an opportunity or a warning.
`werk config setup` reading `~/.ssh/config` takes that route for hosts. Whether
there is anything equivalent for a provider, such as Docker contexts or a
kubeconfig, is untried.

Where a provider would live in the file has at least three shapes:

- **Its own `[providers.<name>]` table**, parallel to a host. Reads well for a
  provider you reach at an address, such as a Fly.io organisation or a
  Kubernetes cluster.
- **A field on a host**, saying that this machine runs incus or Docker and that
  werk may ask it for containers. Reads well for the case where the provider is
  software on a machine werk already knows how to reach.
- **A kind on a host**, so that a host entry says what sort of thing it is, and
  a container something made is another host entry with a different kind. One
  table and one name space, at the cost of a host entry meaning several
  different things.

The wrinkle under all three is that a provider is often itself on a host, and
the hosts it makes are contained by it, so whatever the file holds has to point
in both directions.

No lean. What the file should hold is much easier to answer once something makes
a host, and nothing does.

### 3. Are a person's hosts shared between their own machines?

Configuration lives with the local client, and the file being tried for hosts is
`~/.werk/config.toml`, which is that client's own. That settles most of this. What is left is narrower: whether two clients
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
documents gets that port to that browser.

One level of this has got cheap. werk holds an ssh connection to a host with the
daemon's socket forwarded over it, so a port on that host is another `-L` on a
connection werk already has, and werk is the thing holding it. What is left at
that level is a choice about behaviour rather than mechanism: forward
automatically, forward on request, give the workspace a URL, or leave it to the
user's own tunnel.

It stops being simple one level down. A port a container publishes binds on the
machine running the provider, where that provider's network rules live, and not
anywhere the client can see. Reaching it takes a forward to the host and
something on the host that reaches the container, and that second half is
different for every provider.

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

Nothing records one today. Where a workspace has to be named after the fact, as
`werk list` and the chrome both do, it is reconstructed from the directory the
session was started in, by asking whether this host's layout is what put it
there. That reaches exactly as far as this host: a workspace on another machine,
or one a differently shaped host laid out, has no route through it, and neither
does anything wanting to know a workspace exists when no session is running in
it.

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

### 21. Is there a way to run a command without making a workspace?

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

### 22. How much of a terminal's own choices should werk's theme override?

The palette is Catppuccin, behind `@werk/palette`, and everywhere werk puts
colour on a screen asks that library for a use rather than for a colour. All four
flavours ship, one is selectable, and `auto` asks the terminal what colour its
background is before choosing between a light flavour and a dark one.

Two things about that are settled and one is not.

**What werk writes is settled by depth.** At truecolour it writes the flavour's
own hex, at 256 colours the nearest point in the cube, and on a sixteen-colour
terminal the slot, so the hue survives where the flavour cannot. Catppuccin has
no position on any of this: its ports require 24-bit colour and several name the
terminals they will not work on, so the degradation is werk's own and the eight
accents Catppuccin places in no slot are given one by werk. `docs/cli.md` says
what each depth produces.

**Overriding a child's colours is settled by asking first.** The replica paints
a child's first sixteen colours from the flavour, but only the entries the child
has left as the engine gave them, so a program that sets its own with `OSC 4`
keeps what it asked for. Before this, a page could show Catppuccin chrome around
a terminal painted in the engine's own theme, which is two themes on one screen
and the thing worth avoiding.

**What is not settled is how far to take it.**

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

### 23. What is the host component of a workspace reference?

There is one notation for writing down which workspace is meant, at three levels
of verbosity: `fix-login`, `fix-login:/path/to/checkout`, and
`fix-login@host:/path/to/checkout`. The name and the path are read from the
workspace. The host is not, and the component is absent everywhere today.

Half of what to write there now has an answer. A host somebody configured has
the name they gave it, the `<name>` in `[hosts.<name>]`, and that is a short
label a person would recognise. A host a provider made was never named in a
file, so it would have to be named by whatever made it, and nothing makes hosts.

What an absent component should mean is open.

- **Absence means the machine werk is running on.** A reference that names no
  host is about here. Nothing has to be invented while there is one host, and a
  reference stays short in the case that is currently every case. A reference
  then changes meaning depending on where it is read, which matters as soon as
  one is written down somewhere and read somewhere else.
- **Every reference names a host, with a literal for this machine.** A reference
  means the same thing wherever it is read. It costs picking that literal now,
  and it puts a word in front of every reference that anybody types.
- **The component carries enough to reach the host**, rather than a label for it.
  That is what somebody typing a reference at another machine would want. It
  collides with the `@` and `:` the grammar already spends, and it duplicates
  what a host's own entry in the configuration already holds.

**Lean: absence means the machine werk is running on**, and this is a lean rather
than a decision. It is the only option that adds no claim, and it is what the
code does today. The cost lands when a reference first travels between machines,
which is the point at which this wants answering properly.

This is question 19 seen from the other end. That question asks where the record
of a workspace lives; this one asks how a workspace is written down once
something has to name one it did not make.

### 24. What does werk store about a host once it has been to one?

A host somebody configured is described by what they wrote in the file. What
werk learns by going there is not: which operating system and architecture it
turned out to be, where the daemon binary was put, which build of it is there,
when werk last reached it, and whether it answered. None of that has anywhere to
go today.

- **Nowhere. Ask the host every time.** Nothing can go stale, and a machine
  reinstalled behind werk's back is not a problem. It costs a round trip before
  anything else can happen, on a connection that may be slow or down.
- **Beside the host's entry in the configuration.** One file to read, and a
  person can see what werk thinks. It mixes what the user wrote with what werk
  learned, in a file the user edits by hand.
- **In werk's own state directory, keyed by host.** Keeps the two apart. Adds a
  second place to look and a way for the two to disagree about which hosts
  exist.

This is question 19 asked about hosts rather than workspaces, and question 3
asked about a different kind of thing, so all three probably want answering
together. No lean.

### 25. What has to match between a client and the daemon it ships to a host?

werk puts its own compiled daemon on a host, and the client then speaks the
session protocol to it. A client and a daemon of different builds can therefore
meet, which is a thing that happens the first time somebody upgrades a laptop
and reattaches to a machine they set up a month ago.

The strictness available runs from exact to negotiated:

- **The exact build.** VS Code Remote-SSH matches by commit hash, installs to a
  path carrying it, and redownloads whenever the client changes. Nothing can
  skew, and every client upgrade costs a transfer to every host.
- **A protocol version the two agree on.** The wire in `@werk/session` already
  has a shape a version could be negotiated in. It costs keeping older
  behaviours alive, which is the kind of thing that is cheap to add and
  expensive to remove.
- **Whatever is there, and fail loudly when it does not work.** Cheapest to
  build, and the failure lands on the user at the worst moment.

What makes this harder than it looks is that the terminal replica is part of the
compatibility question too, not only the protocol: a checkpoint written by one
build of the libghostty WASM engine is read by whichever build the client has.
No lean.

### 26. Is a host owned or borrowed, and what does that mean for cleanup?

A machine somebody already had and a machine something made for werk differ in
one way that matters: who is responsible for the machine ending. werk would be a
guest on the first and would have made the second, so destroying a workspace on
the first should leave the machine alone, while destroying the last workspace on
the second raises whether the machine goes too. Those two probably want showing
differently as well as treating differently, because a person reasons about a
box they own and a container werk made in different ways.

The distinction is clear at the extremes and not in the middle. werk shipping a
daemon, a binary and a directory of workspaces onto a machine it borrowed has
left things behind that somebody has to be able to remove, and there is no
answer yet to what removing werk from a host means, which command does it, or
whether it is werk's job at all rather than the user's.

### 27. When are two routes to the same machine the same host?

Two `[hosts.<name>]` entries can name one machine. So can a host entry and the
machine werk is running on, the moment somebody adds their own desktop by its
ssh alias. Nothing stops that today, and nothing notices it either.

It matters because the containment graph is a tree. A machine appearing twice
puts one set of workspaces under two roots, so `werk list` shows each workspace
twice, and a workspace created against one entry is invisible from the other.

- **Do not care.** Two entries are two hosts, and a person who made a duplicate
  can see it. Wrong in the one case a person is least likely to expect, which is
  their own machine reached over ssh.
- **Ask the host who it is.** A machine identifier that werk reads once and
  stores, which is question 24's material. Reliable, and it needs an identifier
  that survives a reboot and a reinstall, which is a thing operating systems are
  inconsistent about.
- **Compare what the workspaces say.** Two entries holding the same workspace at
  the same path are probably the same machine. Cheap, and it only works once
  there is a workspace on both.

No lean.

### 28. What does a workspace on an unreachable host look like?

Once werk reaches machines it does not own, "I cannot see it right now" stops
being a failure and becomes an ordinary state, which is why `unreachable` is one
of the status words question 16 is about. What that means in use is not worked
out.

It is open in at least three places:

- **What the list shows.** Whether an unreachable host is one row saying so, or
  one row per workspace on it each failing separately.
- **How long werk waits before saying so.** ssh to a machine that is asleep can
  hang for a long time, and a list that blocks on the slowest host is a list
  nobody waits for.
- **What a command aimed at an unreachable workspace does.** Fail, wait, or be
  remembered and run when the host comes back. That last one is the difference
  between werk being a client and werk being a queue.

The cheap version is honest and does nothing: say what is unreachable, fail
anything aimed at it, and let the person retry. Whether that reads as broken or
as trustworthy is the thing nobody has evidence about yet.

### 29. Does werk own how it reaches a host, or does ssh?

A host entry has to say enough to open a connection. There are two ways to get
that, and they differ in which file is authoritative.

- **Copy the connection details into `~/.werk/config.toml`.** A host name, a
  user, a port, an identity file. werk holds everything it needs and depends on
  no file it does not own. The details then drift out of step with
  `~/.ssh/config`, and they cannot express what ssh's own configuration can.
- **Record the ssh alias and let ssh resolve it.** The entry is one word, and
  everything the user has already configured keeps working, including `Match`
  blocks and `ProxyJump` through a bastion. werk then depends on a file it does
  not own, cannot fully predict what a connection will do, and has nothing to
  read on a machine where the alias is absent.

`werk config setup` reading `~/.ssh/config` points at the second, because a
wizard that offers you the machines you already reach and then copies their
details out has already accepted a copy that can go stale. That is an argument,
not a lean, and nobody has taken one. The two can also be combined, with the
alias as the normal case and explicit fields for a host ssh knows nothing about,
at the cost of two shapes of host entry to explain.

## The questions nobody has answered

Twenty-four of them, in [open-questions.md](open-questions.md): what a machine
and a machine-maker are called, how a person configures hosts, where landing
runs, what a transcript is made of, what a mapper may read, where the record of
a workspace lives, and the rest. They are genuinely open, and where there is a
lean it is labelled as a lean.