# Inside the command-line client

What somebody changing `packages/werk` needs and a person using `werk` does not.
[cli.md](cli.md) is the reference for the behaviour itself.

## How a command is declared

Summaries and descriptions are written to different grammars, which is what
makes a help page read evenly. A command's summary is an imperative sentence
starting with a capital and carrying no full stop, because it stands on its own
line in the parent's command list and again in a shell completion menu. An
option's or an argument's description is a lowercase fragment with no full stop,
because it is read as a continuation of the flag beside it.

A command is built from a spec rather than a chain of calls.
`defineCommand` in `packages/werk/src/commands/define.ts` takes it. The spec
carries the one-line summary
that appears in the parent's list, the fuller description at the top of the
command's own help, the worked examples, and any rule about the invocation that
commander has no notation for. Summary, description and at least one example are
required fields, so a command that omits one does not compile, and the tests
check that every command in the tree was built this way and that the examples it
declares are examples a person is shown. No test pins the wording. The prose
moves with the product, and a test that has to be regenerated after every edit
to it stops being read.

## Why a missing option value reports alone

`werk` normally reports everything wrong with an invocation together: commander
stops at the first fault it finds, and werk then asks the command what else it
declared. Those extra rules are only gathered for faults raised once the operand
list has been assigned.

An option typed without its value fails earlier than that, while options are
still being parsed. A missing positional derived at that moment would be
invented rather than observed, so nothing is derived there. Holding a rule back
costs the caller a second run. Inventing one from a half-parsed command line
costs the caller's trust in the whole message.

## What the CLI depends on

Five runtime packages beyond the workspace's own. The list is short on purpose:
what a terminal client does is mostly its own, and everything here earns its
place by doing something that would otherwise be hand-written badly.

`package.json` gives every one a caret range except `c12`, which is pinned
exactly; the versions below are what those ranges resolve to.

| Package                       | Version    | Licence | Why                                                           |
| ----------------------------- | ---------- | ------- | ------------------------------------------------------------- |
| `commander`                   | 15.0.0     | MIT     | The command tree, parsing and help                            |
| `@commander-js/extra-typings` | 15.0.0     | MIT     | Types the options and positionals a command declares          |
| `@clack/prompts`              | 1.8.0      | MIT     | The searchable session picker and confirmations               |
| `chalk`                       | 6.0.0      | MIT     | Styling, with the colour level supplied rather than detected  |
| `c12`                         | 4.0.0-rc.1 | MIT     | Reads config files in several formats, and resolves `extends` |
| `chokidar`                    | 5.0.0      | MIT     | Never called; see below                                       |

### commander

It carries the whole shape of the CLI: subcommands, aliases, choice lists,
option value parsers and help layout. The completion walker reads that same tree
rather than keeping a description of its own. Two things about it are worth
knowing.

`exitOverride` is what separates a usage mistake from a failure the daemon
reported. Left alone, commander exits 1 for a mistyped flag, which is the code
werk uses for a refusal; throwing instead lets the entry point give usage
mistakes their own status. `--help` and `--version` arrive the same way and are
mapped back to 0.

`showHelpAfterError` and `addHelpText` are what carry the explanation, so there
is one help renderer rather than a second one to keep in step with it. Werk's
own rules reach the same path by wrapping `Command#error`, which is also where
the further faults are gathered onto the one commander noticed. An option value
werk rejects is raised as commander's `InvalidArgumentError`; anything else
thrown from an option parser is rethrown raw out of `_callParseArg` and escapes
the parse with no usage attached.

`addHelpText` is implemented as `beforeHelp` and `afterHelp` listeners that only
`outputHelp()` fires. `helpInformation()` returns the same page without them, so
anything asserting on help has to render it the way a person receives it or it
silently misses every examples block.

`addCommand` does not copy the parent's settings the way `.command()` does, so
help styling, the colour gate and `showGlobalOptions` are copied down the tree
explicitly. Commander also strips colour it did not decide on, so the gate is
handed to it directly; without that, styles are computed and then thrown away.

### @clack/prompts

The picker is a searchable autocomplete whose rows carry name, state and command
in the label, because clack shows a hint only for the row the cursor is on and
the label is what its search filters against. It reports a cancelled prompt by
resolving with a sentinel rather than by throwing, which is the shape that gets
mistaken for an answer. So every prompt goes through one wrapper, which turns
that sentinel into a cancellation. An expired deadline goes through the same
wrapper, because clack reports it the same way.

### chalk

The colour decision is werk's, not a library's, because every colour library's
built-in detection is wrong for at least one case werk cares about. picocolors
forces colour on when `CI` is set or the platform is Windows. yoctocolors
consults `tty.WriteStream.prototype.hasColors()`, the prototype with no stream
behind it, so it never learns whether this stdout is a terminal. chalk is constructed with an
explicit level, in `runtime/style.ts` and nowhere else, and does the styling
only; which colour each role is comes from `@werk/palette`.

### c12, and what the merge is

c12 is werk's config **reader**: it finds `<dir>/config.toml`, parses TOML,
JSON, JSONC, YAML and JavaScript through one interface, and resolves `extends`,
which is where the unimplemented remote layer would attach.

The merge is werk's own pure function. c12 has five fixed slots where werk has
six ordered layers with per-key provenance, `~/.werk/config.toml` fits none of
those slots, and c12's `layers` array reports which files it read rather than
which layer won each key. Layers go in; the resolved config and the layer every
value came from come out; no filesystem is touched. That is what makes
`werk config list` cheap to test and correct by construction.

Every route c12 would take on its own is switched off: `rcFile` reads a flat
`.werkrc`, `globalRc` wanders to the home directory on its own terms,
`packageJson` would let a dependency's manifest contribute, and `dotenv` would
merge a `.env` into the environment. werk's file is `<dir>/config.toml` and the
caller decides which directory. c12 does not walk up from a subdirectory, so the
repository root is resolved by asking git and handed to it as `cwd`.

It is imported dynamically, because importing it costs about 21 ms against
werk's 8.2 ms floor. Tab completion must never pay that, and neither should a
caller who only wants the pure merge, so the cost lands when a command actually
reads a config file.

The version is pinned exactly rather than by a range because 4.0.0-rc.1 is a
prerelease. v4 is what moves `jiti`, `giget`, `dotenv` and `chokidar` out of
hard dependencies and into optional peers, which is the difference between bundling a config reader and
bundling a config reader plus a TypeScript loader and a git-fetching
downloader.

### chokidar

`chokidar` is a direct dependency **only** so the build works, and werk never
calls it. c12 v4 declares it an optional peer and does `await import("chokidar")`
inside `watchConfig`; Bun's bundler resolves that dynamic import at build time
whether or not the code path is reachable. Removing the dependency because
nothing imports it breaks the build.
