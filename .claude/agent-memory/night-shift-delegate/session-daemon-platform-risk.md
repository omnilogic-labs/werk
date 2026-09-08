---
name: session-daemon-platform-risk
description: The two traps in packages/session-daemon platform code — platformCapabilities is wire-visible, and exactly three tests cannot run on Linux
metadata:
  type: project
---

`packages/session-daemon` holds werk's load-bearing platform code and is the
least covered by tests that run on a Linux development machine. Two facts about
it are easy to miss and expensive to get wrong.

**Why:** both were found while planning issue #26. Either one could let a
change look green on Linux while being wrong in a way nobody can observe from
here.

**How to apply:** check both before changing anything under
`packages/session-daemon/src/`.

## `platformCapabilities` is wire-visible

`src/platform/index.ts` exports `platformCapabilities`. `src/index.ts` spreads
it into the daemon's reported capabilities:

```ts
capabilities: {
  termination: ...,
  snapshots: ...,
  scrollbackMaxBytes: ...,
  ...platformCapabilities,
},
```

That object is returned by `daemonInfo()` and travels over the wire. The type
in `packages/session/src/types.ts` ends with `[key: string]: unknown`, so
**adding a field to `platformCapabilities` typechecks silently and changes the
observable protocol payload**.

So when a task says behaviour must not change, new internal platform predicates
must go in a separately-named export, not into `platformCapabilities`.

## Exactly three tests never run on a Linux dev box

Confirmed from junit output, on Linux as a non-root user, 348 tests pass and 3
skip. The three are:

- `test/native.test.ts` — "Windows kernel job cleans descendants after abrupt
  owner death"
- `test/native.test.ts` — "Windows endpoint requires its per-start credential"
- `test/local.test.ts` — "client rejects another owner's runtime directory"
  (needs root)

Those three are the whole of what a green local run does not tell you about
this package. Anything touching Windows job objects, the Windows loopback
credential, or directory-ownership rejection is verified by inspection only
here, and should be reported that way rather than passed.

## Useful baselines

A clean tree cannot typecheck until `bun run build` has run — build first, this
is pre-existing and not a regression. `bun run test:soak` accepts
`SOAK_SECONDS` and reports `initialHandles` / `finalHandles`; those matching is
a good cheap signal that a daemon change leaked nothing.

`bun test scripts --bail` runs on all three native runners in CI, so a check
written as `scripts/*.test.ts` is enforced on Linux, macOS and Windows without
touching the workflow file.
