# Sharing

Part of the [werk product specification](../product-specification.md). Nothing
here is settled.

Sharing is a secondary feature. The
[core loop](../product-specification.md#the-core-loop) is the product, and most
werk use involves nobody but you.

When sharing does happen, there are two kinds of it, and they are not equally
common. Handing someone the transcript of a session to read afterwards is
expected to be more common than handing someone a live terminal to watch or type
into. That is a ranking of the two kinds of share against each other, nothing
more.

## Sharing a live terminal

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

## Sharing a transcript

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
them in bulk, are all open.
[Questions 7](../product-specification.md#7-what-is-a-transcript-made-of-and-what-is-the-unit-you-share),
[8](../product-specification.md#8-a-registered-key-and-a-link-are-two-different-kinds-of-identity) and
[9](../product-specification.md#9-what-is-recorded-by-default-and-kept-for-how-long) cover the parts that
are product decisions rather than implementation.
