# werk — docs

**werk starts a process somewhere and lets you come back to it later.**

Locally, on a machine you can ssh to, or in a container it provisions for you.
It puts your repository there on a fresh branch, gives you a terminal that
survives your laptop closing, and shows you every one of those — across every
machine — in one list you can open from a terminal or a browser.

The current product specification is
[product-specification.md](product-specification.md). It replaces `product/`
and most of `research/`, which are being retired.

There are four other parts:

|                                              |                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[product/](product/)**                     | What werk _does_. Scope, the object model, worked journeys, the surfaces, and the decisions still open.                                                                   |
| **[research/](research/)**                   | What we found out before deciding anything. Thirteen dossiers, from terminal internals to the competitive landscape.                                                      |
| **[proposals/](proposals/)**                 | Technical specifications for what to build. The stack proof of concept, its cross-platform execution, and the proposed session workspace libraries for the early product. |
| **[session-library.md](session-library.md)** | What the session packages actually do: the wire, the scheduler, the limits, the consumers, and the soak baseline in [session-library/](session-library/).                 |

## Start here

- New to the project → [product-specification.md](product-specification.md)
- Want to see it → [product/02-journeys.md](product/02-journeys.md)
- About to argue about a decision → [product/04-open-questions.md](product/04-open-questions.md)
- About to write code → [proposals/00-stack-proof-of-concept.md](proposals/00-stack-proof-of-concept.md),
  [research/README.md](research/README.md) for the three spikes behind it, and
  [proposals/01-cross-platform.md](proposals/01-cross-platform.md) for what
  changes per operating system
- About to build on the session packages → [session-library.md](session-library.md),
  with [proposals/02-session-library.md](proposals/02-session-library.md) for
  why they are shaped that way
- Want to know what the proof of concept found →
  [`../packages/werk-poc/findings/README.md`](../packages/werk-poc/findings/README.md)
