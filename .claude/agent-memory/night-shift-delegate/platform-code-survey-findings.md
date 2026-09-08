---
name: platform-code-survey-findings
description: What a wide survey established about isolating platform-specific code, and the Bun facts verified on this machine — reusable evidence, so the next agent need not re-survey
metadata:
  type: project
---

A wide survey (issue #26, 2026-09-07) established the landscape for sequestering
platform-specific code. Recording the findings because they are expensive to
re-derive and unlikely to change soon.

**Why:** #26 asked how mature projects solve this and named no answer. The
survey cost roughly 15 minutes of wide reading across Go, Rust, Node core, VS
Code, node-pty, Deno, esbuild, pnpm and a dozen npm packages. Re-running it to
answer the same question would be waste.

**How to apply:** treat these as evidence that informs a decision, never as a
decision — `CLAUDE.md` is explicit that what another project chose is evidence,
not werk's position. See [[claude-md-speculative-voice]].

## Firm negatives

- **There is no OS-based `exports` condition** in either Node or Bun. Node's
  recognised conditions are `import`, `require`, `node`, `node-addons`,
  `module-sync`, `default`, `types`, `browser`, `development`, `production`;
  Bun's order is `bun`, `node-addons`, `node`, `require`, `import`, `default`.
  Conditional exports cannot select a platform. This is the mechanism people
  reach for first, and it does not exist.
- **Every build-time and install-time mechanism requires one artefact per
  platform** — Go build tags, Rust `cfg`, `bun build --compile --target`, npm
  `os`/`cpu` with `optionalDependencies`, esbuild `define`.

## Verified on this machine (Bun 1.3.14, Linux x64)

- `bun build --define 'process.platform="linux"'` constant-folds the
  comparison; adding `--minify` fully eliminates the dead branch.
- `bun:bundle`'s `feature()` exists and works in 1.3.14, at build time
  (`bun build --feature X`) and at runtime (`bun run --feature X`), with full
  DCE under `--minify`.
- **An unset `feature()` flag silently evaluates to `false`.** For platform
  code that means a forgotten build flag ships the opposite branch with no
  error anywhere. This is why build-time selection is a poor fit for werk.

## The cautionary tale worth remembering

Go's old `// +build` constraints were **silently ignored** when misplaced
(after comments, inside doc comments, after the package declaration). A survey
of public Go code found roughly 159 constraints that did nothing. Go's fix was
new syntax (`//go:build`) plus an automated migrator, not a lint.

The lesson generalises: **a marker convention must fail loudly when the marker
is absent or misplaced, not only when it is wrong.**

## The only project that actually enforces isolation

Rust, via `src/tools/tidy/src/pal.rs` — a CI check whose stated objective is
isolating platform-specific code to `std::sys`. No JavaScript or TypeScript
project surveyed has an equivalent, including VS Code and Node core, both of
which have large custom-lint infrastructure and chose not to build one.

Two details worth copying:

- **The allowlist enumerates the debt in the file.** Temporary exceptions carry
  `// FIXME: platform-specific code should be moved to sys`; permanent ones
  carry a written justification inline. The exception list is the compatibility
  surface, readable in one place.
- **The check self-tests so it cannot rot into a no-op.** It is a hand-rolled
  text scanner, so it threads `saw_target_arch` / `saw_cfg_bang` booleans
  through the walk and asserts them at the end. A scanner that silently stops
  matching then fails loudly instead of reporting clean. Any text-scanning
  check werk writes wants this property.

Rust also deliberately exempts tests from the check and notes in the source
that it has not worked out how to handle them long term.

## What convention alone buys you

Node core has a central `isWindows` in `lib/internal/util.js`, a **second
independent copy** in `lib/internal/constants.js`, and 18 files under `lib/`
with a bare `process.platform ===`. A named predicate without enforcement
drifts, in the most disciplined JS codebase there is.

## Testing platform code you cannot run

The best answer found is a design consequence rather than a test trick: make
the platform code a **pure function that takes the platform as a parameter**,
so both branches run on every host. Node exposes `path.win32` and `path.posix`
and tests Windows path joining fully on Linux CI. `graceful-fs` reads
`process.env.GRACEFUL_FS_PLATFORM || process.platform` and `is-wsl` exports the
function rather than the value under test, both purely for testability.

werk already does this in several places (`daemonEnvironment(source, windows)`,
`libcCandidates(platform, arch)`, `defaultSessionRuntimeDir(env, platform,
uid)`). It is the repo's strongest existing idiom and the survey validates it.

## The dissolving move

`proper-lockfile` has **zero** platform branches, because it locks with `mkdir`,
which is atomic everywhere. Sometimes the compatibility surface is a
consequence of the primitive chosen, and picking a different primitive removes
it rather than organising it.
