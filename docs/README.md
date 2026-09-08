# werk — docs

**werk starts a process somewhere and lets you come back to it later.**

Locally, on a machine you can ssh to, or in a container it provisions for you.
It puts your repository there on a fresh branch, gives you a terminal that
survives your laptop closing, and shows you every one of those — across every
machine — in one list you can open from a terminal or a browser.

Six documents carry the project:

|                                                          |                                                                                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[product-specification.md](product-specification.md)** | What werk does. The vocabulary, the core loop, what exists today, and the questions still open. Its five subjects have a document each in `product/`.         |
| **[workspaces-and-git.md](workspaces-and-git.md)**       | How a workspace gets made and how git follows. The two graphs, the interface creation sits behind, and what a first version can be.                           |
| **[session-library.md](session-library.md)**             | What the session packages do. The package boundaries, the wire, the scheduler, attachments and permissions, the limits, the consumers, and the soak baseline. |
| **[cli.md](cli.md)**                                     | What the `werk` command does. The command tree, the two output registers, exit codes, colour, configuration, completion, and what it depends on.              |
| **[ci.md](ci.md)**                                       | What runs on a pull request and how to start a run by hand. The lanes, the step order, the two layers of re-run on failure, and where each platform stands.   |
| **[platforms.md](platforms.md)**                         | How much brokenness each platform gets. The tiering, which lanes observe each platform, how to read a lane that fails, and what nobody has settled yet.       |

`product/` holds the subjects of the specification, one document each:
[the client](product/client.md), [landing](product/landing.md),
[sharing](product/sharing.md), [mappers](product/mappers.md) and
[the portal](product/portal.md). `session-library/` holds the checked-in soak
baseline that the third document quotes. `continue/` is scratch for work in
flight — the branding and pitch round and its imagery — rather than part of the
documentation set.

[platform-code.md](platform-code.md) records where platform-specific code lives
and how the compatibility surface is kept enumerable.

## Start here

- New to the project → [product-specification.md](product-specification.md)
- About to argue about a decision →
  [its open questions](product-specification.md#open-questions)
- Working on how workspaces are made or how git moves between them →
  [workspaces-and-git.md](workspaces-and-git.md)
- About to build on the session packages →
  [session-library.md](session-library.md)
- Using or changing the `werk` command → [cli.md](cli.md)
- Reading a red run, or starting one before opening a pull request →
  [ci.md](ci.md)
- Deciding how hard to fight a failure on one platform →
  [platforms.md](platforms.md)
