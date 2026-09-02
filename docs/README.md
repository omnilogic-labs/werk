# werk — docs

**werk starts a process somewhere and lets you come back to it later.**

Locally, on a machine you can ssh to, or in a container it provisions for you.
It puts your repository there on a fresh branch, gives you a terminal that
survives your laptop closing, and shows you every one of those — across every
machine — in one list you can open from a terminal or a browser.

Nothing here is a product design yet. There are three parts:

|                              |                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **[product/](product/)**     | What werk _does_. Scope, the object model, worked journeys, the surfaces, and the decisions still open.                                                                                    |
| **[research/](research/)**   | What we found out before deciding anything. Thirteen dossiers, from terminal internals to the competitive landscape.                                                                       |
| **[proposals/](proposals/)** | Technical specifications for what to build. Currently two: the proof of concept that tests whether the stack holds up, and how one binary from that stack runs on three operating systems. |

## Start here

- New to the project → [product/00-what-werk-is.md](product/00-what-werk-is.md)
- Want to see it → [product/02-journeys.md](product/02-journeys.md)
- About to argue about a decision → [product/04-open-questions.md](product/04-open-questions.md)
- About to write code → [proposals/00-stack-proof-of-concept.md](proposals/00-stack-proof-of-concept.md),
  [research/README.md](research/README.md) for the three spikes behind it, and
  [proposals/01-cross-platform.md](proposals/01-cross-platform.md) for what
  changes per operating system
- Want to know what the proof of concept found →
  [`../packages/werk-poc/findings/README.md`](../packages/werk-poc/findings/README.md)
