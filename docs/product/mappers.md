# Mappers

Part of the [werk product specification](../product-specification.md). The
interface and one implementation of it exist; everything about where a mapper
should run and what it should be allowed to reach is still open. The name is
provisional.

A **mapper** answers one question about one program: what is this process doing
right now. It answers it using more than the bytes the process has printed.

## The interface

`@werk/mapper` holds it. A mapper is asked and then forgotten: it keeps nothing
between calls, so one that is never asked costs nothing and one that is replaced
between two status checks loses nothing.

| piece           | what it is                                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MapperSubject` | What werk knows about a terminal process before anyone reads anything: its argv, where it was started, the foreground command, whether it is running, and when.  |
| `ReadAccess`    | The only thing a mapper may do. Four operations: a file, a directory listing, whether a path is there, and every file in a directory in one call.                |
| `ProcessStatus` | One reading. An activity, a line for a person, whether it wants somebody, what it is working on, when the source last wrote, and whatever flat facts it can add. |
| `Mapper`        | `claims`, which reads nothing and says whether this mapper knows the program, and `read`, which is only called on a subject the mapper claimed.                  |

The activities are `working`, `waiting`, `idle`, `ended` and `unknown`.
`waiting` and `idle` both mean nothing will happen until a person does
something, which is what `needsAttention` says; they are two words rather than
one because a prompt on screen and a finished turn look different to whoever is
deciding what to look at next.

Two properties follow from the shape. Supporting another agent is one more
implementation and one more entry in the registry, so the cost of a new one
stays small. And because a mapper reads through `ReadAccess` and nothing else —
no `node:fs`, no spawning, no network — where a mapper runs is still a question
that can be answered later rather than one the first implementation settled.

## What is built

`werk status` asks. With no argument it answers for every session the daemon
holds, which is the core loop's third step: one look that says which of them
wants you. `--attention` cuts it to those that do. A session running a program no
mapper knows is listed with what the daemon knows and nothing more, rather than
left out.

The only implementation of `ReadAccess` reads the filesystem of the machine werk
is running on, so `werk status --host beast` is refused rather than answered
about the wrong machine.

## The claude mapper

`claude` is the case that prompted the idea and the one implementation there is.
It reads two things, both under `~/.claude`.

`sessions/<pid>.json` is a record each running claude writes about itself. It
carries the answer almost directly: a status of `busy`, `waiting` or `idle`, a
sentence saying what it is waiting for, the directory it was started in and the
id of its transcript. werk finds the record belonging to a terminal process by
matching that directory against the one werk started the process in, because
nothing on either side records the other. A pid that `/proc` says is gone is a
record left behind by a claude that has ended, and is not believed; a machine
with no `/proc` cannot be asked, and the reading says so rather than assuming.

`projects/<encoded cwd>/<session id>.jsonl` is the transcript. The last
kilobytes of it say what the agent titled the work, the prompt it is answering,
and what its last turn amounted to — a tool and that tool's own description, or
thinking, or replying. That is what turns "busy" into "running Bash: run the
integration tests".

Reading `~/.claude` means a claude started with `CLAUDE_CONFIG_DIR` pointing
somewhere else is invisible to it. `MapperSubject` carries no environment and
werk's own session records keep none, so there is nothing to read that from yet.

## Where a mapper should run

Nobody has worked this out, and the interface exists partly to keep it from
being decided by accident.

Running in the client is what happens today, and it means every read crosses the
network when the process is on another machine. Running in the daemon on the
host puts the mapper next to the files, at the cost of a request on the wire and
of the daemon carrying mappers. A third route is a `ReadAccess` that does its
reads over the connection werk already holds to that machine, which needs
neither a protocol change nor a mapper in the daemon, and costs a round trip per
read.

A mapper written against a small read interface does not care which of those it
gets, which is a reason to keep writing them that way whatever the answer turns
out to be.
[Question 10](../open-questions.md#10-what-may-a-mapper-read-and-what-of-that-leaves-the-host)
covers what such an interface should be allowed to reach, and the answer
probably matters more when the reads leave the host than when they do not.

## The alternative nobody has ruled out

A mapper that runs continuously and accumulates a view of a terminal: a process
installed on the host, or a part of the daemon that watches output as it
arrives. That would cost something per terminal whether or not anyone asked, and
it would have state to lose, which is why the on-demand shape is what got built
first. It would also be able to notice things as they happen, which the
on-demand shape cannot. Nobody has worked out which of those matters more.

## Where mappers sit in the core loop

In the middle of it. Step 3 is "what is this doing right now?" and "does it need
me?", which is what a reading is. Step 4 is "what did it do while I was away",
which is the same computation with more history behind it: `werk status` on a
session that has ended reports what its agent was doing when it stopped, read
out of the transcript.

## Processes with no mapper still need a status

The earlier work recorded a way to get one without knowing anything about the
program, in `docs/product/01-object-model.md`: the signals well behaved terminal
programs already emit. Those are the bell, desktop notification sequences (OSC 9
and OSC 777), progress reports (OSC 9;4), process exit, and going quiet after
being busy. Those five look like enough for a usable "does this need me?" with
no mapper at all, though nothing has been built to find out.

Mappers make some processes much better understood. They are probably not a
replacement for the five signals above. Being asked on demand also stops them
replacing it for notifications: something has to notice that an agent wants you
without anyone having asked, and nothing does.
