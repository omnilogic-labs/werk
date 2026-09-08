# Mappers

Part of the [werk product specification](../product-specification.md). Nothing
here is settled, and nothing described here is built: the specification lists
"mapper" as something nothing reports yet.

A **mapper** would answer one question about one program: what is this process
doing right now. It would answer it using more than the bytes the process has
printed. The name is provisional.

## A mapper probably wants to be code rather than a running thing

The shape this leans towards is an interface in the werk codebase with an
implementation per program. werk knows what a terminal process is running, so
when it is `claude` it could pick the claude mapper and ask that. Someone asks
for the status of a terminal process, the mapper runs, works it out, returns an
answer, and keeps nothing. Where it needed historical context it would read the
logs rather than remembering anything itself.

Three things would follow from that shape, and they are the reasons it looks
attractive. A mapper that is never asked costs nothing. A mapper can be replaced
or upgraded between one status check and the next without losing anything.
Supporting a new agent means writing one more implementation of the interface.

The alternative nobody has ruled out is a mapper that runs continuously and
accumulates a view of a terminal: a process installed on the host, or a part of
the daemon that watches output as it arrives. That would cost something per
terminal whether or not anyone asked, and it would have state to lose, which is
why the on-demand shape is the current lean. It would also be able to notice
things as they happen, which the on-demand shape cannot. Nobody has worked out
which of those matters more.

## The example that prompted it

A mapper for the `claude` binary is the case that motivated the idea. A good one
would probably understand the Claude agent SDK, and beyond that would read the
user's Claude history, memories and session state, so that it could say what a
live agent is actually doing rather than what it has printed on screen.

Where a mapper runs is unresolved. It might have to run in the daemon on the
host, next to the files it reads, or the `werk` client might run it. This
probably does not matter much: when someone asks for status, the information the
mapper needs can be transferred to wherever the mapper is. A mapper written
against a small read interface (read this file, list this directory, read this
much log) would not care which side it ran on, which is a reason to write them
that way.
[Question 10](../product-specification.md#10-what-may-a-mapper-read-and-what-of-that-leaves-the-host)
covers what such an interface should be allowed to reach.

## Where mappers sit in the core loop

Mappers look like they belong in the middle of it. Step 3 is "what is this doing
right now?" and "does it need me?", which is what a mapper would compute. Step 4
is "what did it do while I was away", which is the same computation with more
history behind it.

## Processes with no mapper still need a status

The earlier work recorded a way to get one without knowing anything about the
program: the signals well behaved terminal programs already emit. Those are the
bell, desktop notification sequences (OSC 9 and OSC 777), progress reports
(OSC 9;4), process exit, and going quiet after being busy. Those five look like
enough for a usable "does this need me?" with no mapper at all, though nothing
has been built to find out.

Mappers would make some processes much better understood. They are probably not
a replacement for that floor. Being asked on demand would also stop them
replacing it for notifications: something has to notice that an agent wants you
without anyone having asked.
