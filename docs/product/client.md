# The client

Part of the [werk product specification](../product-specification.md). Nothing
here is settled.

What one person should be able to do. These are capabilities rather than
commands: the command surface is not designed yet, and most of what follows is
not built. `werk create` makes a workspace as a local git worktree today; the
specification's table records what each of the rest still lacks.

## Workspaces

- **Create a workspace.** It would get somewhere to run, a copy of the
  repository, and a branch of its own.
- **Create a workspace based on another workspace.** The new workspace's branch
  would start from that workspace's branch instead of from the default branch,
  which is how someone builds on work that has not landed yet.
- **See the status of every workspace**, across every machine, in one list.
- **Land the changes from a workspace** onto its parent branch, by whichever
  route is configured. See [Landing](landing.md).
- **Have several workspaces on one host.** Many people will probably want one
  workspace per host, and that looks like a preference rather than a limit.

## Terminal processes

- **Launch a terminal process in a workspace.** One or two looks like the common
  shape: the agent in one, and a second terminal in the same directory for you
  to use yourself. That second one runs the dev server, or is just a shell you keep
  around to run whatever you want against the same files the agent is working
  on. More than two happens, but designing for ten panes would be designing for
  the wrong thing.
- **Open a utility terminal in a workspace you already have.** Common enough
  that it should probably be one action rather than a sequence of them.
- **Detach**, and the process keeps running. Close the laptop, lose the wifi,
  walk to another building.
- **Reattach**, and get the screen back as it actually was, with scrollback,
  rather than whatever the program happens to redraw. This one is built:
  `werk attach` restores the screen and the scrollback the daemon kept.
- **See the status of every terminal process in every workspace.** The two
  questions this list exists to answer are probably "which of these needs me?"
  and "what is that one doing right now?".
- **Be told when one of them wants you**, rather than having to go and look. How
  that reaches you, and on which devices, is not worked out.

## Configuration

The lean is that all configuration lives with the local client: which hosts
exist, how workspaces are made on them, how landing works, which agent is used
and for what. The client would then be both the thing that holds the settings
and the thing that acts on them.

Registering a client with a portal would cede control over some of that
configuration to the portal. How much, which parts, and how the two combine is
not worked out. See
[question 12](../product-specification.md#12-what-does-registering-a-client-with-a-portal-take-over).

## Credentials

Running an agent on a machine that is not your laptop means the agent's
credentials have to be on that machine. `claude` does not work in a workspace
without them, and neither does `codex` or anything else. The lean that follows
is that the client sends the user's subscription credentials to every host it
operates on.

That lean rests on an assumption which nobody has tested: a host werk can reach
is a host the client owns exclusively, or at least one where the account werk
logs into belongs to that user. The home directory would then be theirs, which
makes it a reasonable place to put their credentials. What werk should do on a
shared machine where that does not hold has not been worked out.

## Sharing

What each of these would mean is in [Sharing](sharing.md).

- **Share a terminal by registering someone's public key** with your werk
  instance.
- **Share a terminal by sending someone a web link.**
- **Share the transcript of a terminal process** with someone, for them to read
  after the process has finished.
