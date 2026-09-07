# Mappers

Part of the [werk product specification](../product-specification.md). Nothing
here is settled.

A **mapper** answers one question about one program: what is this process doing
right now. It answers it using more than the bytes the process has printed. The
name is provisional.

**A mapper is code, not a running thing.** It is an interface in the werk
codebase with an implementation per program, not a process installed anywhere or
a daemon that watches a terminal and accumulates a view of it. werk knows what a
terminal process is running, so when it is `claude` it uses the claude mapper to
work out what to show. Someone asks for the status of a terminal process, the
mapper runs, works it out, returns an answer, and keeps nothing. Where it needs
historical context it reads the logs rather than remembering anything itself.

Three consequences follow: a mapper that is never asked costs nothing, a mapper
can be replaced or upgraded between one status check and the next without losing
anything, and supporting a new agent means writing one more implementation of
the interface.

The example that prompted it is a mapper for the `claude` binary. A good one
would understand the Claude agent SDK, and beyond that would read the user's
Claude history, memories and session state, so that it can say what a live agent
is actually doing rather than what it has printed on screen.

Where a mapper runs is unresolved. It might have to run in the daemon on the
host, next to the files it reads, or the `werk` client might run it. This
probably does not matter much: when someone asks for status, the information the
mapper needs can be transferred to wherever the mapper is. A mapper written
against a small read interface (read this file, list this directory, read this
much log) would not care which side it ran on, which is a reason to write them
that way.
[Question 10](../product-specification.md#10-what-may-a-mapper-read-and-what-of-that-leaves-the-host)
covers what such an interface should be allowed to reach.

This puts mappers in the middle of the core loop. Step 3 is "what is this doing
right now?" and "does it need me?", which is exactly what a mapper computes.
Step 4 is "what did it do while I was away", which is the same computation with
more history behind it.

Processes with no mapper still need a status. The earlier work recorded a way to
get one without knowing anything about the program: the signals well behaved
terminal programs already emit, which are the bell, desktop notification
sequences (OSC 9 and OSC 777), progress reports (OSC 9;4), process exit, and
going quiet after being busy. Those five give every process a usable "does this
need me?" with no mapper at all. Mappers make some processes much better
understood. They are probably not a replacement for that floor, and being asked
on demand means they cannot replace it for notifications: something has to
notice that an agent wants you without anyone having asked.
