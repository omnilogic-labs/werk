# Sharing

Part of the [werk product specification](../product-specification.md). Nothing
here is settled, and nothing described here is built: the specification records
that neither the transcript nor the log exists yet.

Most werk use involves nobody but you. The
[core loop](../product-specification.md#the-core-loop) is the product, and
sharing looks like a secondary feature beside it.

When sharing does happen, there are two kinds of it, and they are probably not
equally common. Handing someone the transcript of a session to read afterwards
is expected to be more common than handing someone a live terminal to watch or
type into. That is a ranking of the two kinds of share against each other,
nothing more.

## Sharing a live terminal

Two ways to share one have been sketched: register the other person's public key
with your werk instance, or send them a web link.

Three levels of access have been sketched with them:

| Level               | What the person can do                         |
| ------------------- | ---------------------------------------------- |
| **Read only**       | Watch the terminal.                            |
| **Read and write**  | Watch it and type into it.                     |
| **Full ssh access** | The above, plus send files into the workspace. |

Sending files is what motivates the third level. Someone you have shared a
terminal with often needs to put a file in the workspace, and giving them ssh to
the workspace is the obvious way to allow it. That level would do considerably
more than the other two, and what else it grants (a shell of their own, port
forwarding, reach beyond the one terminal) is not worked out.

A shared terminal probably wants to be recorded: what the owner does and what
the people it was shared with do, kept as a record of what happened under that
share. Nothing records it today, and
[question 9](../open-questions.md#9-what-is-recorded-by-default-and-kept-for-how-long)
covers what should be recorded by default and for how long.

## Sharing a transcript

A transcript would be the record of what happened in a terminal process,
readable after that process has ended. Giving one to someone looks like the more
useful half of sharing, because it does not need both people present.

The transcript people want is probably a record of what the agent did rather
than a record of what the terminal printed. Recovering what the agent did from
what the terminal printed is hard. Reading it from the agent's own files is easy, if you know where to
look: `~/.claude` and the equivalents for other agents. That is the same
knowledge a mapper has, applied to a process that has already finished.

Little of this is worked out. What a transcript contains, whether the terminal
output and the agent's activity are one artefact or two views of one thing, how
one is handed over, whether that can be taken back, and how a company reviews
them in bulk, are all open.
[Questions 7](../open-questions.md#7-what-is-a-transcript-made-of-and-what-is-the-unit-you-share),
[8](../open-questions.md#8-a-registered-key-and-a-link-are-two-different-kinds-of-identity) and
[9](../open-questions.md#9-what-is-recorded-by-default-and-kept-for-how-long) cover the parts that
are product decisions rather than implementation.
