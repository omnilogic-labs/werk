# The client

Part of the [werk product specification](../product-specification.md). Nothing
here is settled.

What one person can do. These are capabilities, not commands: the command
surface is not designed yet.

## Workspaces

- **Create a workspace.** It gets somewhere to run, a copy of the repository, and
  a branch of its own.
- **Create a workspace based on another workspace.** The new workspace's branch
  starts from that workspace's branch instead of from the default branch. This is
  how you build on work that has not landed yet.
- **See the status of every workspace**, across every machine, in one list.
- **Land the changes from a workspace** onto its parent branch, by whichever
  route is configured. See [Landing](landing.md).
- **Have several workspaces on one host.** Many people will want one workspace
  per host, and that is a preference rather than a limit.

## Terminal processes

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

## Configuration

All configuration lives with the local client: which hosts exist, how workspaces
are made on them, how landing works, which agent is used and for what. The
client is the thing that holds the settings and the thing that acts on them.

Registering a client with a portal cedes control over some of that
configuration to the portal. How much, which parts, and how the two combine is
not worked out. See
[question 12](../product-specification.md#12-what-does-registering-a-client-with-a-portal-take-over).

## Credentials

Running an agent on a machine that is not your laptop means the agent's
credentials have to be on that machine. `claude` does not work in a workspace
without them, and neither does `codex` or anything else. So the client sends the
user's subscription credentials to every host it operates on.

This rests on an assumption, and for now the assumption is deliberate: a host
werk can reach is a host the client owns exclusively, or at least one where the
account werk logs into belongs to that user. The home directory is theirs, which
makes it a reasonable place to put their credentials. A shared machine where
that is not true is not something this specification covers yet.

## Sharing

What each of these means is in [Sharing](sharing.md).

- **Share a terminal by registering someone's public key** with your werk
  instance.
- **Share a terminal by sending someone a web link.**
- **Share the transcript of a terminal process** with someone, for them to read
  after the process has finished.
