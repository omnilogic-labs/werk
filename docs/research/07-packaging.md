# 07 — Packaging: one fat binary, three platforms, nothing installed

The fifth product promise — _nothing to install, anywhere_ — is a distribution
problem before it is anything else. This is what `bun build --compile` can and
cannot do, verified against Bun ~v1.4.0 (the Rust rewrite, which shipped days
before this research; expect churn).

## The headline findings

1. **Bun ships a native PTY API.** `Bun.Terminal` landed in **v1.3.5** (POSIX)
   and **Windows ConPTY in v1.3.14**. It exists _because_ someone asked for
   exactly werk's use case. This removes `node-pty` — the single scariest
   dependency in a TypeScript version of this project — from the critical path.
2. **One Linux CI runner cross-compiles all eight targets.** Not theoretical:
   opencode does 12 variants from one Ubuntu runner in production.
3. **Embedding and executing a bundled `git`/`ssh` works**, but only via
   extract-to-a-real-path-then-spawn. `$bunfs` virtual paths are readable, not
   spawnable.
4. **Code signing is the real risk**, and it is a _recurring_ one — three
   separate macOS SIGKILL/invalid-signature regressions in 2026, the most recent
   fixed ten days before this research.

---

## 1. What `--compile` actually produces

One native executable embedding the JavaScriptCore-based Bun runtime plus your
bundled JS/TS plus any embedded assets. Nothing needed on the target.
([docs](https://bun.sh/docs/bundler/executables))

The mechanism, from
[`StandaloneModuleGraph.rs`](https://github.com/oven-sh/bun/blob/main/src/standalone_graph/StandaloneModuleGraph.rs) —
a length-prefixed blob (`[u64 LE len][payload]`) stored per-format:

| Format | Where the payload lives                                                                         |
| ------ | ----------------------------------------------------------------------------------------------- |
| ELF    | Appended after the image; a synthetic `BUN_COMPILED` symbol's size field carries the trailer VA |
| PE     | A dedicated `.bun` section                                                                      |
| Mach-O | A dedicated `__BUN` segment                                                                     |

A source comment explains the macOS pain directly: LIEF-based segment injection
cost a fixed 350ms per build, so Bun "gives up on codesigning support on macOS
for now" at compile time. **That is why macOS output needs a manual `codesign`
pass**, and it is the root of §5.

### Size

| Case                                           | Size                                 |
| ---------------------------------------------- | ------------------------------------ |
| Hello world, darwin-arm64                      | ~57 MB                               |
| **opencode** (TUI + CLI + embedded web UI)     | 46–63 MB depending on platform       |
| Rulesync CLI, `--compile --minify --sourcemap` | 63 MB (mac arm64) → 116 MB (win x64) |

Bun's own docs say it plainly: _"Bun's binary is still way too big and we need to
make it smaller."_ A minimal-runtime option is
[open and unaddressed](https://github.com/oven-sh/bun/issues/14546); so is
[built-in compression](https://github.com/oven-sh/bun/issues/10051).

**Budget for werk: 100–150 MB** once a trimmed git (~30–50 MB) and ssh (~2–5 MB)
are inside. That is a lot, and it is the price of the promise. Worth noting the
comparison honestly: a Go build of the same thing would be ~15 MB, a Rust one
~3 MB, before bundled tooling. See [02-language-choice.md](02-language-choice.md).

### `--bytecode`

Precompiles to JSC unlinked bytecode, moving parse+compile off the startup path.
Docs claim 1.5–2× for small CLIs, 2–4× for apps over 5 MB. Real-world reports are
more modest — 52.7ms → 38.3ms (1.38×) in one case, 87ms → 81ms in another.

Four caveats that matter:

- **It is not obfuscation.** JSC bytecode still validates against the original
  source, which remains in the binary. Jarred Sumner, in
  [#14422](https://github.com/oven-sh/bun/issues/14422): _"the bytecode
  compilation in JSC does need the source code to work. It's not useful for
  obscuring the source."_
- **It is pinned to the exact Bun version.** A mismatch silently falls back to
  parsing source. Regenerate on every Bun bump; never commit `.jsc`.
- **2–8× size cost** on the cached portion.
- ESM bytecode _requires_ `--compile`.

For werk, `werk` bare is the most-executed command in the product and its latency
budget is the tightest constraint we have (see
[`../product/03-surfaces.md`](../product/03-surfaces.md)). A 40ms floor from the
runtime is survivable; measure it early rather than assuming.

### Flags worth knowing

- `--asset <dir>` (repeatable) + `--asset-naming` — embeds whole directory trees,
  readable through normal `node:fs`. Skips symlinks and empty dirs.
- `--compile-autoload-dotenv` / `--compile-autoload-bunfig` default **on**.
  **Turn both off** for deterministic production behaviour — werk reading a
  stray `.env` from whatever directory it was launched in is a bug waiting to be
  filed.
- `--compile-executable-path` — use a local Bun binary instead of downloading one
  per target. Necessary for offline/air-gapped CI.
- `--windows-icon` / `--windows-title` / `-publisher` / `-version` etc. call real
  Windows resource APIs and **only work on a native Windows build**. Only
  `--windows-hide-console` survives cross-compilation.
- Unsupported with `--compile`: `--outdir`, `--public-path`, `--target=node`,
  `--no-bundle`.

---

## 2. Cross-compilation

Eight targets, all buildable from one host
([docs](https://bun.sh/docs/bundler/executables)):

```
bun-linux-x64          bun-linux-arm64          (glibc ≥2.17, kernel ≥3.10)
bun-linux-x64-musl     bun-linux-arm64-musl
bun-windows-x64        bun-windows-arm64        (arm64 since v1.3.10)
bun-darwin-x64         bun-darwin-arm64         (macOS 13+)
```

Cross-compiling just downloads the target's prebuilt Bun runtime and links your
bundle in — no QEMU, no target toolchain.
[opencode's build script](https://github.com/anomalyco/opencode/blob/main/packages/opencode/script/build.ts)
does 12 variants in a single Ubuntu job, with a separate Windows job used _only_
for Authenticode signing. That is the shape to copy.

Three gotchas:

- **`-baseline`/`-modern` suffixes now resolve to the same binary**, with Bun
  claiming runtime AVX2 dispatch. **Do not trust this yet** — open issues report
  "Illegal instruction" crashes on genuinely old CPUs
  ([#26353](https://github.com/oven-sh/bun/issues/26353),
  [#27090](https://github.com/oven-sh/bun/issues/27090)). Test on an AVX2-disabled
  VM before shipping.
- **musl targets are not fully static.** They still need `libstdc++.so.6` and
  `libgcc_s.so.1`, absent from minimal Alpine
  ([#29681](https://github.com/oven-sh/bun/issues/29681); fix PR was unmerged at
  research time). A truly static `FROM scratch` build is
  [requested and unimplemented](https://github.com/oven-sh/bun/issues/23910).
  Relevant to us because werk may want to run inside containers it provisions.
- **No `bun-darwin-universal` target.** Two builds plus `lipo` if a universal
  binary is wanted; not confirmed against a Bun-primary source in combination
  with `--compile`.

---

## 3. Embedding files — and other executables

```js
import blob from "./git.tar.gz" with { type: "file" }; // → /$bunfs/root/…
Bun.embeddedFiles; // Blob[] of all of them
Bun.isStandaloneExecutable; // am I compiled?
```

Reads are **in memory** — `Bun.file()` on a `$bunfs` path returns a Blob, nothing
touches disk.

**To run an embedded binary you must materialise it first.** `$bunfs` paths are
not spawnable. The confirmed pattern
([discussion #12235](https://github.com/oven-sh/bun/discussions/12235)):

```js
await Bun.write(dest, Bun.embeddedFiles[0]);
await chmod(dest, 0o755); // Bun.write leaves ~0644 — not executable
Bun.spawn([dest, ...args]); // absolute path; PATH lookup is unreliable in a compiled exe
```

Bun's own internals do the same thing for `.node` addons and FFI libraries
(`ModuleLoader.resolveEmbeddedFile()` extracts to a temp file before `dlopen`).
Since v1.2.13 the temp file is deleted immediately after load; before that it
leaked for up to three days on macOS.

For werk this means an explicit, cacheable **unpack step**: extract the bundled
git tree to `$XDG_CACHE_HOME/werk/tools/<version>/` on first use, verify, and
reuse it forever after. Version-scope the directory so two werk versions coexist
— the same trick VS Code and Mutagen use remotely
([09-remote-transport.md](09-remote-transport.md) §1). Note that git is never one
file anyway (see [08-bundled-tooling.md](08-bundled-tooling.md) §3), so a tree is
what we need regardless.

**Known bugs to route around:**

| Issue                                                 | Effect                                                                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [#25859](https://github.com/oven-sh/bun/pull/25859)   | **≥8 embedded files** produced a binary that silently exited (chunk sort bug). Merged — verify your Bun version includes it. |
| [#15374](https://github.com/oven-sh/bun/issues/15374) | Native binaries inside `node_modules` not embedded correctly                                                                 |
| [#10344](https://github.com/oven-sh/bun/issues/10344) | Windows crash with `--minify --sourcemap` + embedded binaries                                                                |

**macOS quarantine — better than expected.** Files written at runtime by
`Bun.write` do **not** inherit `com.apple.quarantine`; only download-path apps or
apps opting into `LSFileQuarantineEnabled` set it. And unlike an Electron app —
where every nested Mach-O inside a signed `.app` must be signed individually or
notarization fails — an embedded git is opaque _data_ inside one Mach-O segment,
which Apple's notary scanner does not walk into. **This is unverified against the
real notary service** and is worth a dry run early, because if it's wrong it
changes the packaging strategy.

Do source the bundled git and ssh from **already-signed upstream distributions**
rather than self-built unsigned binaries. Sonoma-era Gatekeeper assesses
essentially all executable code, quarantined or not.

---

## 4. PTYs, native addons, and FFI

### `Bun.Terminal` is the finding that changes the language calculus

Shipped in **Bun v1.3.5** ([blog](https://bun.com/blog/bun-v1.3.5),
[reference](https://bun.com/reference/bun/Terminal),
[PR #25415](https://github.com/oven-sh/bun/pull/25415)), from
[issue #22468](https://github.com/oven-sh/bun/issues/22468), which explicitly
argued for a native Zig/Rust `openpty()` implementation over `node-pty` FFI
bindings, citing "CLI dev tools / TUI apps need interactive PTY subprocesses" —
werk's exact scenario.

```js
Bun.spawn({ cmd: ["claude"], terminal: { … } })
// → .write() .resize() .setRawMode() .ref()/.unref() .close()
//   and process.stdout.isTTY is true in the child
```

**Windows ConPTY landed in v1.3.14** via `CreatePseudoConsole`
([#25565](https://github.com/oven-sh/bun/issues/25565),
[release notes](https://bun.com/blog/bun-v1.3.14)). Documented Windows caveats,
all of which we will hit:

- No termios — `inputFlags`/`outputFlags` always read 0.
- No echo without an attached child.
- **ConPTY re-encodes output** — semantically equivalent, not byte-identical to
  POSIX. For a project whose whole premise is faithful terminal state, that is
  worth knowing before promising Windows-host parity.
- `close()` can block on Windows builds before 26100.

**Unverified and important: nobody documents whether `Bun.Terminal` works inside
`--compile` output.** It is native runtime code rather than an embedded asset, so
there is no structural reason it wouldn't — but it is a smoke test to run in week
one, because the entire TypeScript plan rests on it.

### `.node` addons: possible, fragile

Bun implements Node-API from scratch and most addons work
([docs](https://bun.com/docs/runtime/node-api)). But:

- [#26045](https://github.com/oven-sh/bun/issues/26045) — `--compile` bundled
  **multiple** native NAPI modules incorrectly, mixing their exports. Fixed, but
  it tells you multi-addon embedding is thin ice.
- [#17312](https://github.com/oven-sh/bun/issues/17312) — DuckDB bindings fail
  under `--compile` on Windows. **Still open.**

This matters directly for
[`libghostty-vt-node`](https://github.com/coder/libghostty-vt-node), which is the
only way a TypeScript werk gets libghostty. Combined with that binding's own
immaturity (no render state, no key encoder, no incremental snapshot decoding —
see [02-language-choice.md](02-language-choice.md)), this is the sharpest
remaining risk in the all-TypeScript plan.

### `bun:ffi`

`dlopen` works inside compiled binaries, including for embedded shared libraries,
**after a recent fix** — [#30717](https://github.com/oven-sh/bun/issues/30717)
found the extraction path was wired for `.node` addons but was dead code for
general FFI libs. Fixed in #30720. Marked experimental; 2–6× faster than Node-API
but manual memory management.

This is the fallback route to `libghostty-vt.a`: a thin C-ABI shim over the
static library, loaded by `bun:ffi`, sidestepping the Node addon entirely. Worth
costing out as plan B.

---

## 5. Signing and notarization — the recurring bill

### macOS

The [official recipe](https://bun.com/docs/guides/runtime/codesign-macos-executable)
(Bun ≥1.2.4) needs JIT entitlements, because JSC JITs at runtime and the hardened
runtime blocks that by default:

```
com.apple.security.cs.allow-jit
com.apple.security.cs.allow-unsigned-executable-memory
com.apple.security.cs.disable-executable-page-protection
com.apple.security.cs.allow-dyld-environment-variables
com.apple.security.cs.disable-library-validation
```

Bun's doc covers Gatekeeper's "unidentified developer" warning and **not
notarization** — no `--options runtime`, no `notarytool`, no `stapler`.

**The bug trail is the point here.** Bun has repeatedly mis-sized its own
`LC_CODE_SIGNATURE` after appending the trailer:

| Issue                                                           | What happened                                                                                                                                                                                                                                             |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#29120](https://github.com/oven-sh/bun/issues/29120) (v1.3.12) | Compiled binaries SIGKILL'd; `codesign -dv` said "not signed at all". `sig_size` allocated 196,592 bytes where 537,138 were needed. Fixed in 1.3.13.                                                                                                      |
| [#32159](https://github.com/oven-sh/bun/issues/32159)           | "code or signature have been modified" — tolerated on macOS 26, **SIGKILL-enforced on macOS 27**. The signer zero-padded the final partial page before hashing; Apple's verifier hashes it truncated. **Latent in every prior release**, just unenforced. |
| [#39764](https://github.com/oven-sh/bun/issues/39764)           | Recurred after the v1.4 Rust rewrite. Fixed **2026-08-22**, ten days before this research.                                                                                                                                                                |

**Operational conclusion: `codesign -v` runs in CI on every Bun bump, not just on
release.** Keep `BUN_NO_CODESIGN_MACHO_BINARY=1` plus an external re-sign as the
standing fallback. Treat signing as ongoing maintenance, not one-time setup.

Notarization is effectively mandatory on macOS 15+: un-notarized binaries trigger
a YARA scan storm at 150–200% CPU on every launch.

### Windows

`signtool` appends the Authenticode block to the end of the PE — which collided
with where Bun located its trailer, and a signed binary **printed Bun's `--help`
instead of running the script**
([#20109](https://github.com/oven-sh/bun/issues/20109)). Fixed in
**v1.2.23** by stripping any pre-existing signature before appending the `.bun`
section. Use ≥1.2.23, full stop.

**Drop the assumption that EV certificates skip SmartScreen.**
[Microsoft's current doc](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
(updated 2026-08-17): _"EV certificates no longer bypass SmartScreen… Paying a
premium for EV solely to avoid SmartScreen warnings is no longer justified."_ OV
and EV both build reputation over weeks and hundreds of clean installs; a new
cert resets it; certificate validity is now capped at **460 days**. Only Store
distribution skips the process.

[Azure Trusted Signing](https://learn.microsoft.com/en-us/azure/trusted-signing/)
(~$10/mo, OIDC, no hardware token) is what opencode uses. US/Canada individuals
and orgs, EU/UK orgs only.

---

## 6. Bun on Windows

Workable, with sharp edges that land squarely on a process supervisor.

| Area              | Status                                                                                                                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PTY**           | `Bun.Terminal` + ConPTY (v1.3.14). Output re-encoded, no termios, no echo without an attached child.                                                                                                                                                      |
| **Signals**       | **`proc.kill(signal)` ignores the signal argument** — every kill is effectively hard. Bun's own docs say so. The `SIGHUP → grace → SIGKILL` teardown in [04 §6](04-daemon-best-practices.md) _does not work as designed_ on native Windows.               |
| **IPC**           | No `AF_UNIX`. Named pipes via `Bun.listen`/`node:net` (`\\.\pipe\name`), Node's model. Needs a literal double-backslash path. **werk's daemon IPC needs a Windows-specific path.**                                                                        |
| **Symlinks**      | Real bugs, including [#25113](https://github.com/oven-sh/bun/issues/25113) — `bun rm -rf` following symlinks and causing data loss, closed as a duplicate of an earlier one, i.e. a recurring class. Don't rely on symlinks in werk's Windows deployment. |
| **Long paths**    | Fixed — `\\?\` extended-length support merged in #16422.                                                                                                                                                                                                  |
| **File watching** | `fs.watch` reported unstable; add a polling fallback rather than trusting it.                                                                                                                                                                             |
| **Minimum**       | Windows 10 1809+. arm64 native since v1.3.10.                                                                                                                                                                                                             |

v1.4 claims 2.5× faster Windows startup and 17% smaller binaries — and
reintroduced a macOS signing regression within days. **Pin exact Bun versions and
budget for regressions after major bumps.**

---

## 7. The alternatives, honestly

|                      | Bun compile                                      | Node SEA                                       | pkg                                  | Deno compile            | Go                        | Rust                   |
| -------------------- | ------------------------------------------------ | ---------------------------------------------- | ------------------------------------ | ----------------------- | ------------------------- | ---------------------- |
| Baseline size        | ~50–60 MB                                        | ~80–110 MB                                     | similar                              | 100s of MB unless tuned | ~2–15 MB                  | ~1–3 MB                |
| Startup              | fast; `--bytecode` 1.4–2×                        | ~node                                          | ~node                                | slower cold             | ms                        | sub-ms                 |
| Cross-compile        | **excellent** — 8 targets, one host, prod-proven | poor — needs a runner per target               | poor                                 | excellent               | trivial                   | moderate               |
| Embed other binaries | yes, first-class                                 | yes, `assets` map                              | yes                                  | yes, `--include`        | n/a (ship alongside)      | n/a (`include_bytes!`) |
| Native modules       | works, multi-addon bugs                          | manual dlopen dance                            | addon-dependent                      | since 2.3               | cgo (costs cross-compile) | first-class            |
| Maturity             | young, moving                                    | **Node's own docs: Stability 1.1, not stable** | **archived**; fork is `@yao-pkg/pkg` | mature                  | very                      | very                   |

- **`pkg` is dead** — [archived](https://github.com/vercel/pkg), "deprecated with
  5.8.1 as the last release". `nexe` is unmaintained (156 open issues, Snyk flags
  it inactive). Neither is a 2026 choice.
- **Node SEA** is explicitly not stable per Node's own docs, and needs one native
  runner per target in practice — [1mcp-app/agent's
  workflow](https://raw.githubusercontent.com/1mcp-app/agent/main/.github/workflows/build-binaries.yml)
  uses a five-way OS matrix, exactly as the docs warn.
- **Deno compile** is Bun's only serious rival with comparable embed ergonomics,
  but produces dramatically larger binaries by default. A real migration case:
  **565 MB → 62.8 MB** switching Deno → Bun, and 5-platform build time 78s → 4s.
- **Go and Rust remain 5–20× smaller and start faster**, and cannot embed other
  binaries as a bundler feature (you ship alongside, or `go:embed`/`include_bytes!`
  at source level, which is a fine substitute). That is the real trade, and it
  belongs in [02-language-choice.md](02-language-choice.md), not here.

---

## 8. Prior art worth copying

**[opencode](https://github.com/anomalyco/opencode)** is the strongest real
example and is structurally almost identical to werk: a terminal AI coding agent
with a TUI, a CLI, and an embedded web UI, shipped as Bun-compiled binaries.

- 12 target variants from **one Ubuntu runner**, via `Bun.build()` programmatically.
- A separate Windows job **only** for Authenticode signing via Azure Trusted Signing.
- Its **entire web UI embedded** via `with { type: "file" }` — the answer to
  "how do we ship the frontend inside the binary".
- Hand-rolled auto-update: silently self-upgrades on **patch** releases, notifies
  on minor/major, respects an opt-out env var.
- 46–63 MB per platform.

Also: [Rulesync](https://zenn.dev/dyoshikawa/articles/deno-to-bun-single-binary)
(the Deno→Bun migration numbers), and `lazytui`, whose release workflow wraps the
compile step in `continue-on-error: true` — an honest admission that `--compile`
is not yet bulletproof.

Notably **not found**: any household-name JS tooling project shipping this way.
opencode is the ceiling of current practice.

---

## 9. Self-update

No `Bun.selfUpdate()`. The reference implementation is Bun's own
[`upgrade_command.rs`](https://github.com/oven-sh/bun/blob/main/src/runtime/cli/upgrade_command.rs):

- **POSIX**: overwrite/rename directly. The running process keeps the old inode.
- **Windows**: you cannot replace a running exe. Rename it to `<name>.outdated`,
  move the new one into the freed path, and rename back on failure. Bun
  deliberately does **not** delete `.outdated` immediately — a cleanup subprocess
  "would open a terminal window, which steals user focus (even if minimized)".

The same rename-aside trick appears in
[rclone selfupdate](https://rclone.org/commands/rclone_selfupdate/) and the Rust
[`self-replace`](https://docs.rs/self-replace) crate.

**For werk:**

1. Download to a temp file **on the same volume** (atomic rename needs the same
   filesystem).
2. Windows: rename current → `.old`, rename new → current, delete `.old` lazily
   on next launch.
3. POSIX: rename directly.
4. **Re-`codesign` on macOS after every self-download**, or Gatekeeper trips.

And remember the multi-machine version: `werk upgrade` has to do this on six
daemons, not one. See [`../product/02-journeys.md`](../product/02-journeys.md) §11.

---

## Open questions

1. **Does `Bun.Terminal` work inside `--compile` output?** Nobody documents it
   either way. Smoke-test in week one; the whole TypeScript plan depends on it.
2. Does Apple's notary service care about opaque embedded binary data in a
   Mach-O segment? Reasoned, not tested. Run a real notarization dry run early.
3. Is there any size ceiling on a single embedded asset? Only the ≥8-file _count_
   bug was found; a 40 MB embedded git is untested territory.
4. Are the AVX2 "illegal instruction" issues actually fixed?
5. Current merge status of the musl `libstdc++` fix — matters if werk runs inside
   the containers it provisions.
6. Does `libghostty-vt-node` survive `--compile`, given the multi-addon bugs? Or
   do we go `bun:ffi` over a C shim instead?

## Sources

[Bun executables docs](https://bun.sh/docs/bundler/executables) ·
[bytecode docs](https://bun.sh/docs/bundler/bytecode) ·
[`Bun.Terminal` reference](https://bun.com/reference/bun/Terminal) ·
[v1.3.5](https://bun.com/blog/bun-v1.3.5) · [v1.3.14](https://bun.com/blog/bun-v1.3.14) ·
[v1.4](https://bun.com/blog/bun-v1.4) ·
[codesign guide](https://bun.com/docs/guides/runtime/codesign-macos-executable) ·
[SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation) ·
[opencode build script](https://github.com/anomalyco/opencode/blob/main/packages/opencode/script/build.ts) ·
plus the Bun issue tracker, cited inline throughout.
