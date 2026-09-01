# 08 — Bundling git and ssh

The stated intent: ship `git` and `ssh` inside the werk binary so nothing needs
installing anywhere. Use the newest git and don't carry compatibility for old
versions; be more conservative with ssh. This is what that actually costs.

## Summary of findings

- **There is exactly one good template for bundling git**, and it is
  `dugite-native`. This is closer to novel territory than it looks — outside the
  Electron world, essentially nobody vendors the real git binary.
- **git is GPLv2-only.** Shelling out to an unmodified binary is textbook mere
  aggregation and does not infect werk, but distributing the binary still carries
  §3 obligations. GitHub Desktop's compliance pattern is cheap to copy.
- **git is never one file**, even statically linked. Plan on shipping a tree.
- **Bundling `ssh` is defensible; bundling `ssh-agent` is not.**
- **Windows' in-box OpenSSH is old and cannot do ControlMaster at all**, which is
  the strongest single argument for shipping our own uniform client.
- **We may not need ControlMaster anyway** — werk is a persistent daemon, and an
  in-process ssh library gives real channel multiplexing on every platform.

---

## 1. Prior art: dugite-native is the template

Two repos, cleanly split:
[`dugite-native`](https://github.com/desktop/dugite-native) builds and publishes a
trimmed portable git per platform/arch;
[`dugite`](https://github.com/desktop/dugite) is the npm package that downloads
the right tarball and execs it.

**What it strips**: no linking to system libraries, symlinks instead of duplicate
files, **no Perl runtime**, **no OpenSSL** (platform-native TLS — Secure
Transport on macOS, Schannel on Windows, a bundled `cacert.pem` on Linux), **no
Tcl/Tk** (so no `gitk`, no `git-gui`), no translated messages. It _adds_
`git-lfs`, Git Credential Manager, and the Linux CA bundle.

**What it costs**: macOS arm64 59.5 MB `.tar.gz` / 39.1 MB lzma; macOS x64 63.1 /
43.5. There is an open complaint that the Linux bundle got too big
([#47](https://github.com/desktop/dugite-native/issues/47)) with no public
resolution.

**The environment isolation is the part to copy verbatim**
([`git-environment.ts`](https://github.com/desktop/dugite/blob/main/lib/git-environment.ts)):

| Variable            | Set to                                           | Why                                         |
| ------------------- | ------------------------------------------------ | ------------------------------------------- |
| `PATH`              | bundled `bin` prepended (+ `usr\bin` on Windows) | bundled tools shadow system ones            |
| `GIT_EXEC_PATH`     | bundled `libexec/git-core`                       | git's own subcommands resolve to our copies |
| `GIT_CONFIG_SYSTEM` | bundled `etc/gitconfig`                          | **stops reading `/etc/gitconfig`**          |
| `GIT_TEMPLATE_DIR`  | bundled `share/git-core/templates`               | `git init` doesn't pull system templates    |
| `GIT_SSL_CAINFO`    | bundled `ssl/cacert.pem` (Linux)                 | TLS trust isolated from the OS store        |

Note carefully what dugite **does not** isolate: `~/.gitconfig`. The _system_
config is replaced; the user's global config still applies. That is the right
call — the user's `user.name`, aliases, and `credential.helper` should work — and
it is also the source of the failure modes in §6.

There is an escape hatch (`LOCAL_GIT_DIRECTORY`, `GIT_EXEC_PATH`) that lets a
host app point dugite at a _different_ git. GitHub Desktop itself never uses it;
there are open requests to change that
([#4039](https://github.com/desktop/desktop/issues/4039)).

### The others

| Client         | Approach                                                                              |
| -------------- | ------------------------------------------------------------------------------------- |
| GitHub Desktop | Always bundled, no system fallback by design                                          |
| Tower          | Bundles a full git; no system git required                                            |
| GitKraken      | Bundled by default, **experimental preference to use system git**                     |
| Sourcetree     | Bundles git _and its own credential helper_, specifically so it doesn't need the OS's |
| **VS Code**    | **Does not bundle git.** Thin UI over system git ≥2.0                                 |

**MinGit** ([gitforwindows.org/mingit](https://gitforwindows.org/mingit.html)) is
the right Windows base: an intentionally minimal, non-interactive git distribution
built for embedding. ~40 MB compressed. Four zip variants per release. The
**BusyBox variant** replaces the MSYS2 userland with a single exe — no
`msys-2.0.dll`, faster process startup, and it dodges a genuinely nasty bug class
(MSYS2 pins a fixed DLL base address, so two different builds in related
processes corrupt the cygheap — this is a real GitHub Desktop bug). It is flagged
**experimental** by git-for-windows themselves. Given we want one uniform
pipeline, evaluate it seriously rather than defaulting to the MSYS2 build out of
caution.

### The thin category

Searching for a Go or Rust CLI that embeds the actual git _executable_ — via
`go:embed` or `include_bytes!` — turns up nothing comparable. The ecosystem
splits two ways instead: shell out to whatever git is on `PATH` and require it
(`gh`, `lazygit`, most of them), or use an in-process library (§5).

**So: dugite-native is a template to copy, not one option among several.** That
is worth knowing before estimating the work.

---

## 2. Licensing

**git is GPLv2-only**, not "or later" —
[`COPYING`](https://raw.githubusercontent.com/git/git/master/COPYING) says so
explicitly. Individual files may opt into "v2 or later"; the project as a whole
does not.

**Shelling out to an unmodified binary is mere aggregation.** Two independent
programs communicating over argv and stdio, no linking, no shared address space,
is the textbook non-derivative case per the
[GPL FAQ](https://www.gnu.org/licenses/gpl-faq.en.html). werk's own licence is
unaffected. This is precisely _why_ shelling out is the safe choice and linking
libgit2-against-GPL-anything would not be.

**But aggregation does not excuse the obligations of distributing the GPL binary
itself.** GPLv2 §3 requires one of: ship the corresponding source; ship a written
offer valid three years to provide it at cost; or (non-commercial only) pass along
an offer you received. Plus §1/§4 — keep notices intact, add no further
restrictions.

**GitHub Desktop's compliance is a clean, reusable pattern.** Its
[EULA](https://github.com/apps/desktop/eula) states that components are under
licences requiring source availability, bundles the licence texts, and makes the
written offer explicit in the EULA text — _"such offer is hereby made, and you
may exercise it by contacting support@github.com"_. Option 2, satisfied
contractually rather than by shipping a tarball with every install.

**For werk, concretely:** build from an unmodified upstream tag, bundle `COPYING`,
publish or offer the exact source (tag/commit _plus any build patches and the
scripts controlling compilation_ — "corresponding source" includes those), and
state the offer somewhere the user will actually see it.

| Component      | Licence    | Copyleft    | What it costs us                                                                                                                   |
| -------------- | ---------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **git core**   | GPLv2-only | Yes, strong | `COPYING` + written offer of source for the exact build                                                                            |
| gitk / git-gui | GPLv2      | Yes         | Moot — stripped                                                                                                                    |
| **OpenSSH**    | BSD/ISC    | No          | Ship the licence file. Done.                                                                                                       |
| OpenSSL ≥3.0   | Apache-2.0 | No          | LICENSE + NOTICE if statically linked; avoidable with platform TLS                                                                 |
| curl / libcurl | MIT/X      | No          | Copyright header                                                                                                                   |
| libssh2        | BSD        | No          | Copyright header                                                                                                                   |
| **libssh**     | **LGPL**   | Weak        | Different project from libssh2. Static linking carries re-linkability obligations — **avoid if we want a clean fat static binary** |
| git-lfs        | MIT        | No          | Trivial — but do we need it at all?                                                                                                |

**Get a lawyer for:** the exact wording and hosting of the written offer; whether
any build-time patch counts as a §2 modification; the OpenSSL 3.x NOTICE
propagation if we statically link it. This document is not legal advice.

---

## 3. git is never one file

A static musl build is feasible (`CFLAGS="-static" make NO_OPENSSL=1 NO_CURL=1`
against musl-cross-make) but **does not give you a single distributable**. A large
part of git's functionality lives in separate scripts and executables it shells
out to — `libexec/git-core`, `share/git-core` templates, hook samples,
`git-sh-setup`, credential helpers. Static linking buys you independence from the
target's glibc and OpenSSL versions; it does not collapse the tree.

So the packaging shape is: **embed a compressed tree, unpack it once to a
version-scoped cache directory, set the dugite environment variables at it.** That
also happens to be exactly what
[07-packaging.md](07-packaging.md) §3 says you must do to run _any_ embedded
executable from a Bun binary — so this costs nothing extra.

**Strippable without touching anything werk needs**: gitk/git-gui and Tcl/Tk
entirely; Perl and its dependent subcommands (`git add -i`, `git send-email`, the
SVN/CVS adapters); message catalogues; man pages and HTML docs.

Existing static builds
([ryanwoodsmall/static-binaries](https://github.com/ryanwoodsmall/static-binaries),
[probonopd/static-tools](https://github.com/probonopd/static-tools)) sometimes
include git but are not maintained for "always latest". Given the stated
posture — newest git, no back-compat — **building our own in CI against the
current tag is the right call**, not depending on someone else's snapshot.

---

## 4. Bundling ssh

### The case against

ssh's value to a user _is_ its integration with everything else on their machine.

| Integration point                                     | Broken by a naive bundled ssh                                              | Notes                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------- |
| `~/.ssh/config` — `Host`, `IdentityFile`, `ProxyJump` | Aliased and jump-host connections fail outright                            | The single biggest risk   |
| `known_hosts` location                                | Re-prompts or fails for already-trusted hosts                              | Trust continuity lost     |
| `ssh-agent` / `SSH_AUTH_SOCK`                         | **Usually fine** — it's just a socket path, inherited from the environment | The one that mostly works |
| PKCS#11 / YubiKey / Secretive                         | Fine if our build supports `PKCS11Provider`/`SecurityKeyProvider`          | ABI compatibility matters |
| **macOS Keychain keys**                               | **Invisible** to any agent we spawn ourselves                              | See below                 |

**The macOS Keychain point is the sharp one.** `ssh-add --apple-use-keychain`
stores keys _in_ Keychain, reloaded at login into the `launchd`-managed agent via
`org.openbsd.ssh-agent.plist`. Apple's OpenSSH fork carries a patch upstream does
not have. A werk-spawned agent would not see those keys.

**Therefore: bundle the ssh _client_, never an ssh-agent.** Inherit
`SSH_AUTH_SOCK`, respect the user's real `~/.ssh/config` and `known_hosts` by
default, and let whatever agent is already running do the signing.

### The case for, which is Windows

Windows 10/11 ship `C:\Windows\System32\OpenSSH\ssh.exe`, and it is **materially
behind upstream** — reports of 7.7p1–8.1p1 on current builds against
[OpenSSH 10.5p1](https://www.openssh.com/releasenotes.html), because Windows
Update does not refresh it. And **`ControlMaster` does not work there at all** —
it needs a Unix socket the Windows client cannot create, giving
`getsockname failed: Not a socket`
([Win32-OpenSSH#1761](https://github.com/PowerShell/Win32-OpenSSH/issues/1761)).

So the situation inverts relative to git: for git, "always bundle latest" is
low-risk because git is fast-moving and self-contained. For ssh, the argument for
bundling is not "we want new features" — it is **uniformity**, so that werk
behaves identically on three platforms instead of being at the mercy of a
five-year-old Windows binary.

### The version posture

Conservative, as stated. New enough for `ProxyJump` and modern kex/ciphers; not so
bleeding-edge that it fails against the older `sshd` on the user's actual
infrastructure. That is roughly "current OpenSSH portable, one release behind
head".

---

## 5. The library alternative

### git libraries: none of them, and that's settled

| Library                                                    | push/fetch over ssh                                                  | Partial clone                                                                                                       | Verdict                                                                      |
| ---------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [libgit2](https://libgit2.org)                             | Only if built against libssh2; cert-checking needs a caller callback | No protocol-v2 completeness                                                                                         | Mature but drifting from real git. `nodegit` effectively unmaintained        |
| [gitoxide / gix](https://github.com/GitoxideLabs/gitoxide) | Yes — real send-pack/receive-pack, sideband, atomic push             | Protocol v2 at plumbing level                                                                                       | The most credible "real git in a library". Still younger than upstream C git |
| [go-git](https://github.com/go-git/go-git)                 | Works, with `SSH_AUTH_SOCK` edge cases                               | `--filter` exists but **explicitly not full partial clone** ([#1381](https://github.com/go-git/go-git/issues/1381)) | Gaps exactly where we'd care                                                 |
| [isomorphic-git](https://isomorphic-git.org)               | **No SSH support at all**, by design                                 | shallow only                                                                                                        | Disqualified                                                                 |

The team's decision to shell out sidesteps all of this, and the reasoning holds:
git's on-the-wire and on-disk behaviour needs to be indistinguishable from real
git — protocol v2 negotiation, partial clone filters, LFS, custom transports,
credential helpers, hooks, GPG signing, submodules — and no library replicates
100% of an actively-moving surface that large.

### ssh libraries: a genuinely open question

| Library                                           | Notes                                                                                        |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [ssh2](https://www.npmjs.com/package/ssh2) (Node) | libssh2 bindings, mature, widely used. **A native addon — see [07 §4](07-packaging.md)**     |
| [russh](https://github.com/Eugeny/russh)          | Pure Rust, Tokio, no C dependency                                                            |
| `golang.org/x/crypto/ssh`                         | Pure Go, multiple channels per `ssh.Client` natively                                         |
| [libssh](https://www.libssh.org)                  | **LGPL** — different project from libssh2                                                    |
| [`openssh` crate](https://docs.rs/openssh)        | Wraps the _external_ ssh binary's ControlMaster. A convenience layer, not a reimplementation |

**The insight that matters:** ControlMaster exists to fake multiplexing across
_independent short-lived processes_. werk is already a persistent daemon. One
connection held open in-process, with a new channel per operation, is what
ControlMaster is imitating — and it is a first-class SSH protocol primitive
(RFC 4254). An in-process client gets real multiplexing **on every platform
including Windows**, with no control socket, no 104-byte path limit, and no
`ControlPersist` tuning.

That is a strong argument for an ssh library, independent of the git decision:
**ssh's protocol surface is small, standardised and stable; git's is enormous and
moving.** A library plausibly covers 100% of what we need from ssh; none covers
100% of what we need from git.

**The caveat that cuts back:** git does not speak SSH. `git fetch`/`push` over ssh
shells out to an ssh binary (`GIT_SSH_COMMAND` / `core.sshCommand`) which runs
`ssh host 'git-upload-pack …'`. So even with an in-process connection for werk's
own traffic, **git subprocesses still need some `ssh` binary**. Options:

1. Bundle a plain `ssh` CLI purely for git's use, and hold a separate in-process
   connection for everything else. Two connections per host. Simple, works today.
2. Point `GIT_SSH_COMMAND` at a **shim that proxies through werk's existing
   connection**. One authenticated session for everything. More work; genuinely
   elegant.

Option 1 for a first cut, option 2 as a known upgrade. Worth prototyping (2) once
the architecture is real, not before.

---

## 6. Hybrid strategies, and what actually breaks

Three postures in the wild: **always bundled** (GitHub Desktop, Tower), **bundled
with an escape hatch** (GitKraken), **always system** (VS Code — which
reintroduces exactly the problem werk exists to avoid).

Given the "nothing installed anywhere" promise, always-bundled is the direction.
These are the failure modes it buys, and each is a real reported bug class, not a
hypothetical:

- **Credential helpers.** The user's `~/.gitconfig` says
  `credential.helper = osxkeychain`; our bundled git can't find
  `git-credential-osxkeychain` because it isn't in our tree or on our `PATH`.
  This is the exact
  [Sourcetree bug](https://support.atlassian.com/sourcetree/kb/sourcetree-throws-credential-osxkeychain-is-not-a-git-command-error-when-pushing-changes/),
  and it is why dugite bundles Git Credential Manager. **Decide deliberately:
  bundle a helper, or document that we defer to the user's PATH.**
- **Global config.** Since only the _system_ config is isolated, the user's
  aliases, `user.email`, `core.editor` and signing config all apply to our git —
  desirable, but it means a broken global alias breaks werk.
- **Hooks.** `.git/hooks/*` run regardless of which git invoked them. A hook that
  shells out to `git` expecting a subcommand we stripped fails silently. Be
  conservative about _which_ subcommands get dropped, and smoke-test.
- **Corporate CA bundles.** A bundled `cacert.pem` will **not** trust an org's
  internal CA from the OS trust store, breaking HTTPS remotes behind a
  TLS-inspecting proxy. Platform-native TLS (Schannel, Secure Transport) sidesteps
  this on Windows and macOS; Linux needs either a deliberate default pointing at
  `/etc/ssl/certs/ca-certificates.crt` or clear user-facing config.
- **GPG signing.** `commit.gpgsign` shells out to `gpg`, which nobody bundles.
  Falls through to the user's system, or breaks — the same either way.

---

## 7. Windows specifics

| Setting          | Git-for-Windows default                  | Upstream default | What werk should do                                                                                                  |
| ---------------- | ---------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `core.autocrlf`  | `true`                                   | unset/`false`    | **Set explicitly.** Otherwise behaviour silently differs between our bundle and a system Git-for-Windows             |
| `core.longpaths` | `false`                                  | `false`          | **Default `true`** — agent worktrees nest deeply                                                                     |
| `core.symlinks`  | `true` only with Admin or Developer Mode | `true` on POSIX  | **Detect and warn.** Without it git writes text placeholders instead of links, silently breaking repos that use them |

`core.autocrlf=true` is a Git-for-Windows _installer_ default, not a core-git
default. Inheriting it accidentally is how you get a fleet where the same repo
behaves differently in two workspaces.

The MSYS2 runtime DLL question from §1 recurs here: regular MinGit needs
`msys-2.0.dll` shipped alongside `git.exe` for its shell scripts and POSIX
emulation. The BusyBox variant avoids it and is faster to spawn, at the cost of
"experimental".

---

## Open questions

1. **Do we bundle a credential helper?** It's the difference between "push works"
   and a support thread. Affects size and adds a licence entry.
2. Is BusyBox MinGit stable enough today? It would meaningfully simplify Windows.
3. Do we need `git-lfs` at all? dugite bundles it; our users may not need it.
4. Real on-disk (not compressed) size of a trimmed werk-git per platform. None of
   the published numbers are apples-to-apples.
5. **Prototype the `GIT_SSH_COMMAND` shim?** It is the only way git's ssh traffic
   and werk's own end up on one authenticated session. Probably defer.
6. Legal review of the §2 items before shipping anything.
7. Does the _remote_ werk need bundled git too, or does it use the remote host's?
   Bundling is consistent; using the host's is smaller and respects local
   config. Leaning: bundle, for the same uniformity reason as ssh — but this
   doubles the payload we push over ssh, so it interacts with
   [09-remote-transport.md](09-remote-transport.md) §1.

## Sources

[dugite-native](https://github.com/desktop/dugite-native) ·
[dugite `git-environment.ts`](https://github.com/desktop/dugite/blob/main/lib/git-environment.ts) ·
[MinGit](https://gitforwindows.org/mingit.html) ·
[git `COPYING`](https://raw.githubusercontent.com/git/git/master/COPYING) ·
[GPL FAQ](https://www.gnu.org/licenses/gpl-faq.en.html) ·
[GitHub Desktop EULA](https://github.com/apps/desktop/eula) ·
[OpenSSH release notes](https://www.openssh.com/releasenotes.html) ·
gitoxide, go-git and libgit2 issue trackers, cited inline.
