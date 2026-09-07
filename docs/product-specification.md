# werk product specification

This is the current specification of what werk does.

Written 2026-09-06. It covers what a person can do with werk, what sharing and
logging are for, and what a company installs. It does not cover how any of it is
built, beyond the two language decisions in
[What is settled](#what-is-settled). Almost nothing else here is settled, and
the words used are the words we are thinking with rather than words anyone has
committed to.

## Words used in this file

| Word                 | What it means here                                                                                | Settled?                                   |
| -------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **workspace**        | A named, isolated place for work: somewhere to run, a copy of the repository, its own branch.     | The concept is. The word is not.           |
| **terminal process** | One long-lived process with a terminal, inside a workspace. A workspace holds several.            | No. The code calls this a session.         |
| **host**             | A machine a workspace runs on.                                                                    | No.                                        |
| **provider**         | Something that produces hosts on demand, such as Kubernetes, Docker, or a cloud VM API.           | No. See question 1.                        |
| **parent**           | The branch a workspace was created from, and the branch its changes go back to.                   | The concept is. The word is not.           |
| **land**             | Get the changes made in a workspace onto its parent branch.                                       | The concept is. The route is configurable. |
| **mapper**           | A component that reports what a running process is doing, using more than its terminal output.    | No.                                        |
| **daemon**           | The long-lived process on a host that owns the terminal processes. Shorthand `werkd`.             | The thing is. The binary name is not.      |
| **portal**           | The thing a company installs to configure hosts, workspaces, terminals and agents for its people. | No.                                        |
| **transcript**       | The record of what happened in a terminal process, readable after the process has ended.          | Concept only. Nothing like it exists yet.  |
| **log**              | The record of who did what to a shared terminal, kept for review.                                 | Concept only. Nothing like it exists yet.  |

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

The rest of this document is either a part of that loop or something built on
top of it. werk is three pieces:

| Part        | What it is                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------- |
| **Client**  | What one person runs, and where the loop above lives.                                         |
| **Sharing** | Letting someone else see a terminal, live or after the fact.                                  |
| **Portal**  | What a company runs. How hosts, workspaces, terminals and agents are configured for everyone. |

## What is settled

**TypeScript everywhere.** The client, the daemon, the libraries, the web
surfaces and the portal are TypeScript. This is the default and no package needs
to argue for it.

**WASM to embed libghostty.** Terminal interpretation is libghostty compiled to
WASM and shipped as an asset, rather than a native addon or a reimplementation.
This is already how it works: `packages/terminal/assets/terminal.wasm`.

**WASM anywhere the benefit is clear.** Beyond libghostty, WASM is available
where it buys a real performance win, or access to an ecosystem with no good
TypeScript equivalent. Each use should be able to say which of those two reasons
it is claiming.

## What exists today

The session libraries are built and working. Everything below is real, and it is
the foundation the rest of this specification sits on. Nothing else described in
this file exists yet.

- A daemon owns the terminal processes. Its word for one is a **session**: an
  argv, a working directory, a size, and a state of `starting`, `running`,
  `exited`, `failed` or `lost`.
- A viewer of a session is an **attachment**, carrying a principal and separate
  read and input permissions. Several attachments can watch one session.
- The CLI (`packages/werk`) has `create`, `list`, `attach`, `logs`, `kill`,
  `remove`, `watch`, `info`, `doctor` and `session-daemon`. Detach is `Ctrl-]`.
- Reattach restores the real screen, decoded from a checkpoint by the libghostty
  WASM engine. `examples/session-web` does the same in a browser.
- Checkpoints are written per session to the state directory. Records of ended
  sessions survive a daemon restart, up to 512 of them. Live processes do not:
  killing the daemon abruptly leaves a `lost` record with its last screen and no
  process.
- Everything is TypeScript. `bun:ffi` is used for `flock` and for Windows job
  objects. PTYs come from Bun's own spawn support rather than a native addon.

Four things this specification needs that are absent today: git of any kind,
anything remote (the transport is a Unix socket or loopback TCP), sharing as a
product feature (the protocol supports it, nothing uses it), and a durable log.
What is on disk now is a bounded screen checkpoint, roughly 10 MB of scrollback
by default, which is not a record of everything a process printed.

## The client

What one person can do. These are capabilities, not commands: the command
surface is not designed yet.

### Workspaces

- **Create a workspace.** It gets somewhere to run, a copy of the repository, and
  a branch of its own.
- **Create a workspace based on another workspace.** The new workspace's branch
  starts from that workspace's branch instead of from the default branch. This is
  how you build on work that has not landed yet.
- **See the status of every workspace**, across every machine, in one list.
- **Land the changes from a workspace** onto its parent branch, by whichever
  route is configured. See [Landing](#landing).
- **Have several workspaces on one host.** Many people will want one workspace
  per host, and that is a preference rather than a limit.

### Terminal processes

- **Launch a terminal process in a workspace.** One or two is the common shape:
  the agent in one, and a second terminal in the same directory for you to use
  yourself. That second one runs the dev server, or is just a shell you keep
  around to run whatever you want against the same files the agent is working
  on. More than two happens, but designing for ten panes would be designing for
  the wrong thing.
- **Open a utility terminal in a workspace you already have.** Common enough
  that it should be one action, not a sequence of them.
- **Detach**, and the process keeps running. Close the laptop, lose the wifi,
  walk to another building.
- **Reattach**, and get the screen back as it actually was, with scrollback,
  rather than whatever the program happens to redraw.
- **See the status of every terminal process in every workspace.** The two
  questions this list exists to answer are probably "which of these needs me?"
  and "what is that one doing right now?".
- **Be told when one of them wants you**, rather than having to go and look. How
  that reaches you, and on which devices, is not worked out.

### Configuration

All configuration lives with the local client: which hosts exist, how workspaces
are made on them, how landing works, which agent is used and for what. The
client is the thing that holds the settings and the thing that acts on them.

Registering a client with a portal cedes control over some of that
configuration to the portal. How much, which parts, and how the two combine is
not worked out. See question 12.

### Credentials

Running an agent on a machine that is not your laptop means the agent's
credentials have to be on that machine. `claude` does not work in a workspace
without them, and neither does `codex` or anything else. So the client sends the
user's subscription credentials to every host it operates on.

This rests on an assumption, and for now the assumption is deliberate: a host
werk can reach is a host the client owns exclusively, or at least one where the
account werk logs into belongs to that user. The home directory is theirs, which
makes it a reasonable place to put their credentials. A shared machine where
that is not true is not something this specification covers yet.

### Sharing

- **Share a terminal by registering someone's public key** with your werk
  instance.
- **Share a terminal by sending someone a web link.**
- **Share the transcript of a terminal process** with someone, for them to read
  after the process has finished.

## Landing

Landing gets the changes made in a workspace onto its **parent**, the branch the
workspace was created from. How it gets there is configurable, because the
routes people want are genuinely different.

### The client coordinates it

Landing is driven by the client. The client can reach the workspaces it made, so
the only other requirement is that it can reach the parent. If it cannot, the
landing cannot happen. If it can, where the parent physically lives makes no
difference to how any of this works.

### Three routes

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

### An agent does the awkward parts, and you decide how much to look

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

### Landing happens on a copy first

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

### A workspace notices when its changes have already landed

Changes often reach the parent without werk doing it. A pull request gets merged
on GitHub, or a colleague applies the same commit. A workspace should recognise
that its work is already on the parent and say so, rather than offering to land
something that is already there or reporting itself as unfinished work.

Phabricator solved this by attaching something to the commit: every commit
carried the review it came from, so finding it later was a lookup rather than a
guess. werk could do the same and write a marker into the commit it produces.
Comparing commit messages is another angle. How to do it well is unresolved, and
question 5 has the trouble with the obvious alternatives.

## Sharing

Sharing is a secondary feature. The loop above is the product, and most werk use
involves nobody but you.

When sharing does happen, there are two kinds of it, and they are not equally
common. Handing someone the transcript of a session to read afterwards is
expected to be more common than handing someone a live terminal to watch or type
into. That is a ranking of the two kinds of share against each other, nothing
more.

### Sharing a live terminal

There are two ways to share one: register the other person's public key with
your werk instance, or send them a web link.

There are three levels of access:

| Level               | What the person can do                         |
| ------------------- | ---------------------------------------------- |
| **Read only**       | Watch the terminal.                            |
| **Read and write**  | Watch it and type into it.                     |
| **Full ssh access** | The above, plus send files into the workspace. |

Sending files is what motivates the third level. Someone you have shared a
terminal with often needs to put a file in the workspace, and giving them ssh to
the workspace is the obvious way to allow it. That level does considerably more
than the other two, and what else it grants (a shell of their own, port
forwarding, reach beyond the one terminal) is not worked out.

Once a terminal is shared, what happens in it is recorded: what the owner does
and what the people it was shared with do. A share carries a record of what
happened under it.

### Sharing a transcript

A transcript is the record of what happened in a terminal process, readable
after that process has ended. Giving one to someone is the more useful half of
sharing, because it does not need both people present.

The transcript people want is probably a record of what the agent did rather
than a record of what the terminal printed. Recovering the first from the second
is hard. Reading it from the agent's own files is easy, if you know where to
look: `~/.claude` and the equivalents for other agents. That is the same
knowledge a mapper has, applied to a process that has already finished.

Little of this is worked out. What a transcript contains, whether the terminal
output and the agent's activity are one artefact or two views of one thing, how
one is handed over, whether that can be taken back, and how a company reviews
them in bulk, are all open. Questions 7, 8 and 9 cover the parts that are
product decisions rather than implementation.

## Mappers

A **mapper** answers one question about one program: what is this process doing
right now. It answers it using more than the bytes the process has printed. The
name is provisional.

**A mapper is code, not a running thing.** It is an interface in the werk
codebase with an implementation per program, not a process installed anywhere or
a daemon that watches a terminal and accumulates a view of it. werk knows what a
terminal process is running, so when it is `claude` it uses the claude mapper to
work out what to show. Someone asks for the status of a terminal process, the
mapper runs, works it out, returns an answer, and keeps nothing. Where it needs
historical context it reads the logs rather than remembering anything itself.

Three consequences follow: a mapper that is never asked costs nothing, a mapper
can be replaced or upgraded between one status check and the next without losing
anything, and supporting a new agent means writing one more implementation of
the interface.

The example that prompted it is a mapper for the `claude` binary. A good one
would understand the Claude agent SDK, and beyond that would read the user's
Claude history, memories and session state, so that it can say what a live agent
is actually doing rather than what it has printed on screen.

Where a mapper runs is unresolved. It might have to run in the daemon on the
host, next to the files it reads, or the `werk` client might run it. This
probably does not matter much: when someone asks for status, the information the
mapper needs can be transferred to wherever the mapper is. A mapper written
against a small read interface (read this file, list this directory, read this
much log) would not care which side it ran on, which is a reason to write them
that way. Question 10 covers what such an interface should be allowed to reach.

This puts mappers in the middle of the core loop. Step 3 is "what is this doing
right now?" and "does it need me?", which is exactly what a mapper computes.
Step 4 is "what did it do while I was away", which is the same computation with
more history behind it.

Processes with no mapper still need a status. The earlier work recorded a way to
get one without knowing anything about the program: the signals well behaved
terminal programs already emit, which are the bell, desktop notification
sequences (OSC 9 and OSC 777), progress reports (OSC 9;4), process exit, and
going quiet after being busy. Those five give every process a usable "does this
need me?" with no mapper at all. Mappers make some processes much better
understood. They are probably not a replacement for that floor, and being asked
on demand means they cannot replace it for notifications: something has to
notice that an agent wants you without anyone having asked.

## The portal

The portal is what a company installs. The name is a placeholder and the design
has not been worked through.

It lets someone configure how terminals are used at that company. The part that
carries the most weight is configuring the **hosts** those terminals run on, and
configuring the **workspaces** provisioned on those hosts. That is the broad
capability. Specific things built on it include central management of which
agents people are allowed to use and how those agents authenticate.

This is plausibly useful beyond running AI agents. Making everyone's development
tools the same (the same editor, the same diff tool, managed dev containers on
managed machines) looks like the first broad capability the portal enables, and
it does not mention agents at all.

The logs are the portal's other half. Logs plus sharing let people search and
review each other's sessions. A CTO should be able to see who is running which
agents, and what those agents are doing right now.

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
only a fact about where the branch started, is unresolved.

### 7. What is a transcript made of, and what is the unit you share?

The transcript is the least specified thing in this document. Open: whether the
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
this document.

### 13. Do you attach to a workspace, or to a terminal process?

Detaching from and reattaching to a workspace is stated at the workspace level,
but a workspace holds more than one terminal process and each one is what
actually holds a screen. With one or two processes per workspace, the obvious
reading is that the agent is the workspace's main terminal and reattaching goes
there, with the utility terminal reached deliberately. That is a guess. It also
raises whether the two are equal, or whether one is the workspace's process and
the other is a shell werk offers next to it. The code today attaches to one
session at a time.

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
Fly.io machine, and the browser that needs it is on the laptop. Nothing in this
document gets that port to that browser. The options are the usual ones: werk
forwards it over the connection it already has, werk gives the workspace a URL,
or werk does nothing and you set up your own tunnel. This is not exotic, and it
becomes visible the first time anyone runs a web project in a workspace that is
not local.
