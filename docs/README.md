# werk — docs

**werk starts a process somewhere and lets you come back to it later.**

Locally, on a machine you can ssh to, or in a container it provisions for you.
It puts your repository there on a fresh branch, gives you a terminal that
survives your laptop closing, and shows you every one of those — across every
machine — in one list you can open from a terminal or a browser.

Three documents carry the project:

|                                                          |                                                                                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[product-specification.md](product-specification.md)** | What werk does. The client, landing, sharing, mappers and the portal, what exists today, and the questions still open.                                        |
| **[session-library.md](session-library.md)**             | What the session packages do. The package boundaries, the wire, the scheduler, attachments and permissions, the limits, the consumers, and the soak baseline. |
| **[cli.md](cli.md)**                                     | What the `werk` command does. The command tree, the two output registers, exit codes, colour, configuration, completion, and what it depends on.              |

`session-library/` holds the checked-in soak baseline that the second one
quotes. `continue/` is scratch for work in flight — the branding and pitch round
and its imagery — rather than part of the documentation set.

## Start here

- New to the project → [product-specification.md](product-specification.md)
- About to argue about a decision →
  [its open questions](product-specification.md#open-questions)
- About to build on the session packages →
  [session-library.md](session-library.md)
- Using or changing the `werk` command → [cli.md](cli.md)
- Want to know what the proof of concept found →
  [`../packages/werk-poc/findings/README.md`](../packages/werk-poc/findings/README.md)
