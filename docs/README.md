# werk docs

**werk starts a process somewhere and lets you come back to it later.**

[`CLAUDE.md`](../CLAUDE.md) at the repository root says what that means and what
the repository holds today.

Eight documents carry the project:

| document                                                 | what it covers                                                                                                                                                              |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[product-specification.md](product-specification.md)** | What werk does. The words used in these documents, what werk is, the core loop, what exists today, and what is being tried now. Its five subjects have a document each in `product/`.                |
| **[open-questions.md](open-questions.md)**               | The twenty-four questions the specification has not answered. The options for each, and any lean labelled as a lean.                                                        |
| **[workspaces-and-git.md](workspaces-and-git.md)**       | How a workspace gets made and how git follows. The containment graph and the derivation graph, the interface creation sits behind, and what a first version can be.         |
| **[session-library.md](session-library.md)**             | What the session packages do. The package boundaries, the wire, the scheduler, attachments and permissions, the limits, the consumers, and the soak baseline.               |
| **[cli.md](cli.md)**                                     | What the `werk` command does. The command tree, the two output modes, exit codes, colour, configuration, completion, and how a session is started and reattached to.        |
| **[ci.md](ci.md)**                                       | What runs on a pull request and how to start a run by hand. The lanes, the step order, the two layers of re-run on failure, and where each platform stands.                 |
| **[platforms.md](platforms.md)**                         | How much brokenness the project tolerates on each platform. The tiering, which lanes observe each platform, how to read a lane that fails, and what nobody has settled yet. |
| **[platform-code.md](platform-code.md)**                 | Where platform-specific code lives. The two places a platform branch is allowed to be, and the check that fails on a branch in neither.                                     |
`product/` holds the subjects of the specification, one document each:
[the client](product/client.md), [landing](product/landing.md),
[sharing](product/sharing.md), [mappers](product/mappers.md) and
[the portal](product/portal.md). `session-library/` holds the checked-in soak
baseline that `session-library.md` quotes.

Three more documents sit beside one of the eight, for somebody changing the code
rather than using it:

- [cli-internals.md](cli-internals.md): how a `werk` command is declared, the
  grammar its help text follows, why a missing option value is reported on its
  own, and what the CLI depends on with the version of each.
- [terminal-engine-defects.md](terminal-engine-defects.md): the pinned Ghostty
  WASM build leaves a row clean when a combining mark is appended to a cell that
  already holds a codepoint. The reproduction, the workaround in
  `@werk/terminal`, what it costs per frame, and the note that nobody has
  reported the defect upstream.
- [testing-terminal-behaviour.md](testing-terminal-behaviour.md): what a test
  learns from running werk under a real terminal, and what a run under a pty can
  be compared against.

`continue/` is scratch for work in flight rather than part of the documentation
set. It holds [cleanup.md](continue/cleanup.md), on getting the browser lane to
run locally, and [pitches.md](continue/pitches.md), on the branding and pitch
round, with that round's concepts, imagery and tools beside it.

## Start here

- New to the project → [product-specification.md](product-specification.md)
- Changing or questioning a decision → [open-questions.md](open-questions.md)
- Working on how workspaces are made or how git moves between them →
  [workspaces-and-git.md](workspaces-and-git.md)
- About to build on the session packages →
  [session-library.md](session-library.md)
- Using or changing the `werk` command → [cli.md](cli.md)
- Changing how a command is declared, or what the CLI depends on →
  [cli-internals.md](cli-internals.md)
- Reading a red run, or starting one before opening a pull request →
  [ci.md](ci.md)
- Deciding how hard to fight a failure on one platform →
  [platforms.md](platforms.md)
- Writing code that differs by platform → [platform-code.md](platform-code.md)
