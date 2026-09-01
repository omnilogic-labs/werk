# 10 — Git workspaces: getting the repo there, and the work back

Baseline: **git 2.55.0** (released 2026-06-29). Git 3.0 — which defaults the
reftable backend — has not shipped and is expected late 2026. Design against
2.55.x semantics with no back-compat, per the stated posture, and treat reftable
as forward-looking only.

## The headline findings

1. **`git stash export` / `git stash import`, new in git 2.51, is the answer to
   the dirty-working-tree problem** — and it is _upstream's own recommendation_
   for the exact question werk is asking. **No surveyed tool uses it yet.**
2. **Streaming a bundle over ssh genuinely works**, verified at the source level,
   not just in the docs. One round trip, into an empty directory, no bare repo.
3. **Do not use partial or shallow clone.** It breaks exactly the commands agents
   run most, and it defeats the entire point of the remote copy.
4. Branch naming has converged industry-wide on `<tool>/<slug>[-<suffix>]`.
5. **Dirty-state handling is the least-documented area in every competitor.**
   That is an opportunity, and it is also a warning about how hard it is.

---

## 1. Getting the repo onto the target

| Method                                                                    | Best for                                          | Trade                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bundle stream over ssh**                                                | Cold start, one hop, no bare repo                 | **Verified safe at the git source level**: `bundle.c`'s `read_bundle_header()` uses `strbuf_getwholeline_fd()` — pure sequential reads, no `lseek`/`fstat`/`S_ISREG` check — and `create_bundle()` writes straight to the destination fd, the same path pack-objects uses for network transfer. One round trip. No incremental negotiation: always the full content of the given refs |
| **Push to a bare repo**                                                   | Simple, well understood                           | Two hops (push, then clone from the bare repo) unless you work in the bare repo directly, which has no working tree                                                                                                                                                                                                                                                                   |
| **Push to a live checkout** via `receive.denyCurrentBranch=updateInstead` | Repeated pushes into a persistent remote checkout | Needs config _and_ usually a hook. See below                                                                                                                                                                                                                                                                                                                                          |
| `git clone --local` / `git worktree add`                                  | Same machine, or a bind-mounted container         | Not a transfer at all — only applies when host and target share a filesystem                                                                                                                                                                                                                                                                                                          |
| `rsync`/`tar` of `.git`                                                   | No ability to run `git-receive-pack` remotely     | **git's own FAQ warns against this** for a live repo. Copies reflogs, hooks, stale tracking refs, and the source machine's absolute paths. Needs the repo fully quiescent plus a `git fsck` after                                                                                                                                                                                     |
| Bundle URIs / `--bundle-uri`                                              | **Not applicable**                                | Built for CDN-bootstrapping one big public repo for _many_ clients, not a single ad-hoc hop where you already have ssh                                                                                                                                                                                                                                                                |

The cold-start incantation:

```sh
git bundle create - --all \
  | ssh host 'mkdir -p /w && cd /w && git init -q && git bundle unbundle -'
```

### `updateInstead` and the `push-to-checkout` hook

The default `receive.denyCurrentBranch=refuse` exists for a good reason —
updating the checked-out branch brings `HEAD` out of sync with the index and
working tree. `updateInstead` allows it, but **refuses if the checkout has any
difference from `HEAD`**. For a disposable remote checkout that is exactly wrong,
and the override is a hook:

```sh
# remote: .git/hooks/push-to-checkout
#!/bin/sh
exec git read-tree -u -m --reset "$1"
```

That makes the push always succeed, discarding whatever was in the remote tree.
Correct for a workspace werk owns; dangerous anywhere else.

**Open decision:** is werk willing to own a hook file's lifecycle on every
provisioned target as a hard dependency of its core flow? The alternative is
bundle-into-an-empty-dir universally, and reserve `updateInstead` for the
"repeatedly sync into a live checkout" case.

### Partial, shallow, sparse: mostly don't

| Technique                       | Speeds up               | Breaks                                                                                                                                                                                                                                 |
| ------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--filter=blob:none` / `tree:0` | Initial transfer size   | **Requires staying connected to the promisor remote.** `log -p`, `blame`, cross-commit `diff` and `bisect` all trigger on-demand fetch and **error outright** if origin is unreachable. Those are precisely the commands an agent runs |
| `--depth=N`                     | Repos with long history | `merge-base` and rebase against pre-boundary commits fail; pushing a shallow clone as a normal ref update is non-trivial                                                                                                               |
| `--single-branch`               | Skips other branches    | The agent can't diff other branches without a fetch. **Low-risk win** when one workspace is one branch, which is werk's model                                                                                                          |
| sparse-checkout (cone)          | Huge monorepos          | Repo-wide grep and refactor miss everything outside the cone. Only safe if the agent is explicitly scoped                                                                                                                              |
| `--no-tags`                     | Tag negotiation         | Loses `git describe` context. **Low-risk win**                                                                                                                                                                                         |

**Verdict: full clone or bundle by default.** The whole point of the remote copy
is usually that the agent works _offline from origin_, and partial clone's
on-demand fetch requirement destroys that.
[The docs say so directly](https://git-scm.com/docs/partial-clone): it "requires
that the user be online and the origin remote… be available for on-demand
fetching." `--single-branch --no-tags` are the safe trims.

Note Terragon did use `--filter=blob:none` and had to run `git fsck` to catch
blobless-clone corruption. That is the failure mode, in production, from someone
who tried it.

---

## 2. Uncommitted state — the interesting part

### `git stash export` / `import` (git 2.51, 2025)

```
git stash export (--print | --to-ref <ref>) [<stash>...]
git stash import <commit>
```

The 2.51 release notes describe it as "an interchange format for stash entries";
2.53's frame it explicitly as the tool for **"synching two separate
repositories."** And `gitfaq(7)`'s own answer to _"How do I sync a working tree
across systems?"_ recommends exactly this, over rsync or cloud-syncing the repo.

```sh
# local
git stash push -u -m werk:transfer
git stash export --to-ref refs/heads/stashes
git push <target> stashes && git stash pop     # keep working locally

# target
git fetch <origin> +stashes:stashes
git stash import stashes
git stash apply --index                        # preserves the staged/unstaged split
```

**Why it's the right primitive:** it preserves the staged-versus-unstaged
distinction that a flat WIP commit collapses, it produces ordinary transferable
objects, and it is a documented interchange format rather than a trick.

Three caveats:

- **Requires git ≥2.51 on both ends.** Fine for the local side (we bundle git);
  the question is the target, and whether werk's bundled git goes with it. See
  [08 §open-questions](08-bundled-tooling.md).
- The FAQ deliberately uses `refs/heads/stashes` because many forges only
  replicate `refs/heads/*`. werk routes over direct ssh, so a tidier
  `refs/werk/...` namespace is available and preferable.
- **The FAQ calls out `--include-untracked` as the path secrets travel.** werk
  should make untracked/ignored inclusion **opt-in per path, never a blanket
  `-a`.**

**No surveyed tool uses this.** It shipped a year ago. That is a genuine
opportunity to be first, and it is also why there is no prior art to learn from.

### The fallbacks

**Scratch-ref WIP commit** (works on any git):

```sh
git add -A && tree=$(git write-tree)
commit=$(git commit-tree "$tree" -p HEAD -m werk:wip)
git update-ref refs/werk/wip/<id> "$commit"
git push <target> refs/werk/wip/<id>
```

Loses the staged/unstaged split. `git add -A` never touches ignored paths.

**`git stash create`** makes a stash-shaped commit and prints its SHA **without
touching any ref** — dangling until referenced. Its shape is parent 1 = `HEAD`,
parent 2's tree = the index, own tree = the working tree. An ordinary,
pushable object graph, and the primitive `export` was built on top of.

**`git diff | ssh host git apply`** is the worst option: it requires the remote's
index and worktree to _exactly_ match the diff's base, content and mode, with
**no 3-way fallback**. Needs `--binary` for binary hunks and `-M -C` for renames,
and misses untracked files entirely.

### Ignored-but-necessary files

No git primitive touches ignored content. Enumerate and ship separately:

```sh
git ls-files --others -i --exclude-standard   # ignored files
git status --porcelain=v2 --untracked-files=all
```

…then `tar` or `rsync --files-from=-` alongside the git payload.

### What everyone else actually does

| Tool                                  | Dirty state                                                                                                                                                                                                                                                          | Ignored config                                                                                                                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conductor, claude-squad, uzi, crystal | **Non-problem by construction** — local worktrees share the object DB. "Commit or stash first" is the documented workaround                                                                                                                                          | Conductor: configurable "Files to Copy" + setup scripts                                                                                                                                                                            |
| **Container Use**                     | Explicitly does **not** auto-commit dirty state; warns instead                                                                                                                                                                                                       | **Reference-based secrets**: `container-use config secret set API_KEY op://vault/item/field`. The agent sees only the reference; the value is resolved and injected at container runtime. `op://`, `env://`, `vault://`, `file://` |
| **vibe-kanban**                       | `is_worktree_clean()` gates PR creation                                                                                                                                                                                                                              | **Explicit `copy_files` project setting** — the clearest real "copy these ignored paths too" config found anywhere                                                                                                                 |
| **Devin**                             | **`/handoff` explicitly ships the live WIP diff**: _"your work-in-progress diff carries over. Commit or stash anything you don't want sent."_ Without it, uncommitted files are deleted on teardown                                                                  | `.devin/config.local.json`, manual `.env.template → .env`                                                                                                                                                                          |
| Cursor / Codex / Jules cloud          | **Committed and pushed state only.** Jules: _"cannot help with local branches, uncommitted experiments, or code not yet in GitHub."_ Cursor forum reports local sessions destructively `git stash`/`reset` the user's tree without warning — a cautionary data point | Cursor: opt-in `.env.local` bake. **Codex's docs recommend denying the agent read access to `.env` entirely**                                                                                                                      |

**The pattern**: local worktree tools never had to solve carrying dirty state.
Cloud tools split between clone-committed-only and explicit diff handoff, and
**Devin's `/handoff` is the only production example of the latter.** The real gap
everywhere is ignored config, and vibe-kanban's `copy_files` is the reference
design.

---

## 3. Getting work back

**One-off, no remote config** — preferred, leaves no litter in `.git/config`:

```sh
git fetch ssh://user@host/abs/path/repo.git \
  refs/heads/werk/<name>:refs/werk/results/<name>
```

**From a container with no shared filesystem** — bundles are read-only, so this
is the direction that works. Confirmed from `git bundle --help`: _"a git push
into a bundle is not supported."_

```sh
docker exec <c> git bundle create /tmp/out.bundle refs/heads/werk/<name>
docker cp <c>:/tmp/out.bundle ./out.bundle
git fetch ./out.bundle refs/heads/werk/<name>:refs/werk/results/<name>
```

**`git daemon` inside a container** works but `--enable=receive-pack` is
_"disabled by default, as there is no authentication in the protocol… solely
meant for a closed LAN setting."_ Only for trusted, short-lived,
network-isolated containers.

### Not losing work in an ephemeral container

Four mechanisms, none sufficient alone, and **no tool combines them**:

1. **Dirty-gate on destroy.** Never auto-delete a workspace whose
   `git status --porcelain` is non-empty. Cheap, and it is the mechanism behind
   the refusal in [`../product/02-journeys.md`](../product/02-journeys.md) §9.
   Adopt regardless of everything else.
2. **post-commit push** — `git push werk HEAD:refs/werk/live/<id> &` on every
   commit, routed via `core.hooksPath` so it survives rebuilds. Misses
   uncommitted state between commits.
3. **Periodic sidecar** — `git stash export --to-ref` plus push on a timer.
   Catches uncommitted state; trades churn against the loss window.
4. **Exit trap** — bundle and ship on teardown. Catches graceful shutdown only,
   not `SIGKILL` or an OOM kill.

Devin's `/handoff` (explicit, manual) and Sandcastle's preserve-on-dirty
(automatic, local disk) are the only production examples found.

### The `ssh -R` reverse tunnel

**No surveyed tool does this.** Worth flagging as a real technique for the one
case that earns its complexity: **the local machine cannot reach the target at
all** — a NAT'd host, or an outbound-only cloud sandbox.

```sh
# local: open the reverse tunnel, then run a receive-capable daemon behind it
ssh -R 9999:localhost:9418 -N -f user@remote
git daemon --reuseaddr --base-path=/repo --export-all \
  --enable=receive-pack --listen=localhost --port=9418 /repo
# remote: push as if the daemon were local
git push git://localhost:9999/ werk/<name>:refs/werk/incoming/<id>
```

The remote-side bind is loopback-only by default, which is exactly the "closed
LAN" condition `git daemon`'s docs require. **`receive.denyCurrentBranch` still
applies** — the push must target a distinct ref, never the user's checked-out
branch, and `updateInstead` is not a free lunch here because the user's tree is
usually dirty.

For the common case where the local machine _can_ reach the target, plain
`git fetch <ssh-url>` is far less machinery. Defer this.

---

## 4. Worktrees, and what everyone names things

### `git worktree` mechanics worth knowing before relying on it

- Linked worktrees share history, refs and the object store. Only the working
  directory, index and `HEAD` are per-worktree. Admin files live at
  `$GIT_DIR/worktrees/<name>/` in the **main** repo; the linked worktree's `.git`
  is a _file_ pointing back there.
- **Two worktrees cannot check out the same branch.** `add` refuses; `--force`
  overrides. `-b` creates and refuses if it exists; `-B` creates or resets.
- **Submodules**: an explicit BUGS-section warning — _"support for submodules is
  incomplete… NOT recommended to make multiple checkouts of a superproject."_ A
  worktree with submodules can't be `git worktree move`d.
- **Hooks are shared by default.** `core.hooksPath` is repo-wide; per-worktree
  hooks need `extensions.worktreeConfig`.
- Refs are shared **except** `refs/bisect/*`, `refs/worktree/*` and
  `refs/rewritten/*`. `HEAD`, `ORIG_HEAD`, `MERGE_HEAD` are always per-worktree.
- `rm -rf` of a worktree leaves it `prunable`; the admin dir clears after
  `gc.worktreePruneExpire` or on `git worktree prune`.
- **`git worktree lock`** protects from pruning and removal. **Use it on
  create** so `prune` cannot race an in-use workspace.
- **2.54–2.55 additions**: `--orphan` (unborn-branch worktree) and
  `--relative-paths` / `worktree.useRelativePaths` — useful for worktrees that
  move between machines.

GitHub's own June 2026 post notes Copilot's app adopted worktrees as a default
mode for AI parallelism, and flags the same two pitfalls: **per-worktree
dependency duplication** (disk bloat — the reason Sculptor rejected worktrees for
containers) and needing to gitignore worktree directories created inside the
repo.

### The tool survey, git-handling only

| Tool              | Isolation                                                                                                                    | Branch naming                                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conductor         | worktree                                                                                                                     | free-form + a friendly workspace dir name (`warsaw-v2`)                                                                                                                                                  |
| **Sculptor**      | **Fresh Docker container per agent, explicitly not worktrees** — to avoid per-worktree dependency reinstalls                 | not documented                                                                                                                                                                                           |
| **Container Use** | Container **and** branch: "each agent gets a fresh container in its own git branch"                                          | `cu-<env-id>`, e.g. `cu-fancy-mallard`                                                                                                                                                                   |
| claude-squad      | tmux + worktree                                                                                                              | `<prefix>/<sessionName>`, prefix defaults to the lowercased OS username                                                                                                                                  |
| vibe-kanban       | worktree per workspace                                                                                                       | `vk/<id>-<task-slug>`                                                                                                                                                                                    |
| Terragon          | Cloud sandbox, **blobless clone**                                                                                            | `terragon/<ai-slug>-<6-char-nanoid>`                                                                                                                                                                     |
| Codex cloud       | Container, `universal` image, cached ≤12h                                                                                    | `codex/<slug>`, no random suffix                                                                                                                                                                         |
| Cursor            | Isolated VMs with snapshots                                                                                                  | `cursor/<slug>-<4-char-hex>`                                                                                                                                                                             |
| Jules             | Short-lived VM per task                                                                                                      | `jules/<slug>-<numeric-id>`                                                                                                                                                                              |
| **Devin**         | VM snapshot; each session boots a clean copy                                                                                 | **`devin/<unix-ts>-<branch-name>`**, officially documented. **The only tool confirmed to open PRs under its own bot identity** (`app/devin-ai-integration`) — everyone else acts as the connecting human |
| OpenHands         | Pluggable runtime: Docker, Process, Remote/API, Apptainer, K8s+Sysbox. Shared sandbox explicitly _"not a security boundary"_ | not documented                                                                                                                                                                                           |

**Naming has converged near-universally on `<tool>/<slug>[-<random-suffix>]`.**
`werk/<name>` fits the convention exactly.

Worktree helper CLIs worth knowing: **`worktrunk`** (6.8k★, built explicitly for
parallel AI-agent workflows, `wt switch pr:123`, LLM commit messages) and **`gtr`**
(coderabbit, 1.8k★, `gtr pr 123`). `gwq`/`wtp`/`git-wt` are pure CRUD. Note
**"wt" is a five-way name collision**, and "git-workspace" is a false positive —
it syncs fleets of separate repos, nothing to do with worktrees.

---

## 5. Recent git features worth exploiting

| Feature                                      | Status                                                                                             | Verdict                                                                                                                                                                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git worktree --orphan` / `--relative-paths` | 2.54–2.55                                                                                          | Useful for worktrees that move between machines                                                                                                                                                                                           |
| `scalar`                                     | in core since 2.38                                                                                 | `scalar clone` bundles good defaults (background maintenance, `commitGraph.changedPaths=true`) but **defaults to partial clone and sparse-checkout**. Use `scalar clone --full-clone` to get the maintenance wins without the §1 breakage |
| `core.fsmonitor`                             | built-in daemon, no Watchman                                                                       | **Linux caveat**: inotify's default 8,192-watch-per-user cap. Bake a raised `fs.inotify.max_user_watches` into container images. Refuses network-mounted repos unless `fsmonitor.allowRemote=true`                                        |
| commit-graph `--changed-paths`               | stable                                                                                             | **Run `git commit-graph write --changed-paths --reachable` after transfer** on deep-history repos. Speeds `log -p -- <file>`, which agents run constantly                                                                                 |
| `core.untrackedCache`                        | stable                                                                                             | Cheap win paired with fsmonitor for status-heavy loops                                                                                                                                                                                    |
| **reftable**                                 | **not default** — opt-in via `git init --ref-format=reftable`; default in Git 3.0, not yet shipped | Low priority. Possibly worth it now for a long-lived bare staging repo with one ref per job                                                                                                                                               |
| `git maintenance` / cruft packs              | stable                                                                                             | Marginal for ephemeral per-job clones; worth it on any long-lived staging repo                                                                                                                                                            |
| **`git replay`**                             | **still explicitly experimental in 2.55** — "BEHAVIOR MAY CHANGE"                                  | **Doesn't touch the working tree or index**, so it's a good fit for headless rebase of a finished branch onto latest upstream, directly on a bare repo. Gate behind a flag and pin the git version                                        |
| sparse-index                                 | experimental but usable                                                                            | Only with an explicitly scoped sparse checkout                                                                                                                                                                                            |

---

## 6. Naming

| Package                                       | Shape                                     | Pool               | Last publish   | Maintained                                                  |
| --------------------------------------------- | ----------------------------------------- | ------------------ | -------------- | ----------------------------------------------------------- |
| **`human-id`**                                | `adjective+noun+verb` → `rare-geckos-jam` | **15,000,000**     | **2026-08-19** | **Yes, zero deps, MIT**                                     |
| moby `namesgenerator`                         | `adjective_surname`                       | 25,596 (108 × 237) | in Docker CE   | **Moved from `pkg/` to `internal/` — no longer importable** |
| `docker-names`                                | Docker's lists                            | 25,596             | 2022           | Stale                                                       |
| `unique-names-generator`                      | configurable                              | claims 28M+        | 2022           | Stale                                                       |
| `random-word-slugs`                           | configurable POS, kebab                   | claims 30M+        | 2023           | Lightly stale                                               |
| `friendly-words`                              | Glitch's list                             | —                  | 2024           | Lightly maintained                                          |
| haikunator / sillyname / codenamize / petname | 2-word or hash-derived                    | small              | 2015–2019      | Abandoned                                                   |

**`human-id` is the only actively maintained package with the right shape** —
and `affectionate-badgers-writing` is exactly its `adjective+noun+verb` form.

`codenamize`'s deterministic hash-to-name pattern is worth noting separately if
werk ever wants **idempotent** naming (the same repo+branch always yielding the
same workspace name) rather than random.

**Collision math is moot.** Birthday approximation gives human-id ~0.03% at 100
concurrent and ~3.3% at 1,000; Docker-style would be ~19.5% at 100, which is why
Docker appends a retry digit. But werk already keeps a session registry, so
uniqueness is enforced by check-and-retry in O(1) regardless of pool size.

### The name → branch → container → directory mapping

- **git** ([`check-ref-format`](https://git-scm.com/docs/git-check-ref-format)):
  no control chars, space, or `~^:?*[`; no `..`, no `@{`, not literally `@`; no
  component starting `.` or ending `.lock`; no leading/trailing/doubled `/`; no
  trailing `.`; no `\`. `--branch` mode additionally forbids a leading `-`.
- **Docker** (verified from `daemon/names/names.go`):
  `^[a-zA-Z0-9][a-zA-Z0-9_.-]+$` — must start alphanumeric.
- **Filesystem**: lowercase-ascii-hyphen is safe everywhere. Windows adds
  reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`…) and path length, which
  matter if werk ever hosts on Windows.

**Common denominator: `[a-z][a-z0-9]*(-[a-z0-9]+)*`.** Never emit a leading
hyphen; reject accidental `--` or `..` when composing from user input; and
**validate any user-supplied name by shelling out to `git check-ref-format
--branch <name>`** rather than reimplementing the rules.

---

## 7. Repo identity

The grouping key for [`../product/01-object-model.md`](../product/01-object-model.md#project).

| Candidate                                             | Problem                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Normalized remote URL**                             | No git-native normalizer exists — git never compares URLs. [`git-url-parse`](https://www.npmjs.com/package/git-url-parse) (v16.1.0) handles scp-like/ssh/https forms. A minimal homegrown version: lowercase host, strip `user@` and protocol, strip trailing `.git` and `/`, compare `host + "/" + path` |
| **Root commit** (`git rev-list --max-parents=0 HEAD`) | The docs say "gives all root commits" — **plural is deliberate**. `merge --allow-unrelated-histories`, grafts, and independently-authored branches later joined all produce multiple roots. It also **conflates a fork with its upstream**, which is usually wrong                                        |
| **UUID in `.git/config`**                             | `git config --local werk.repo-id <uuid>`. Custom sections are the sanctioned extension point. Survives moves and renames of the existing checkout, unlike path identity — but **does not survive a fresh clone elsewhere**                                                                                |
| Path                                                  | Breaks on move or rename                                                                                                                                                                                                                                                                                  |

**Recommended: normalized remote URL as the primary key when a remote exists;
fall back to a `werk`-namespaced UUID in `.git/config` for remote-less repos.**

A fork shares root-commit history with upstream but has a different remote URL,
so URL matching correctly treats it as distinct — which is what you want. A fully
local repo has no URL at all, which is what the UUID is for.

The unsolved half: a **fresh clone on a new machine** has neither the UUID nor
any memory of werk. If the fleet is to be user-scoped rather than laptop-scoped
([`../product/04-open-questions.md`](../product/04-open-questions.md) §1), that
needs a third mechanism — a tracked `.werk-repo-id` file, or keying by normalized
remote URL and accepting the fork ambiguity.

---

## Open questions

1. **Does werk pin git ≥2.51 on both ends** so `stash export`/`import` is always
   available, or does it need the WIP-commit fallback in v1? Interacts directly
   with whether the bundled git goes to the remote
   ([08](08-bundled-tooling.md)).
2. **Own a `push-to-checkout` hook's lifecycle on every target**, or use
   bundle-into-empty-dir universally and reserve `updateInstead` for repeated
   syncs?
3. **Ship a feature gated on `git replay`**, which is explicitly experimental?
   Fallback to `fetch && rebase` when unavailable.
4. **Does werk get its own bot identity for commits and PRs?** Devin is the only
   surveyed tool that does; everyone else acts as the connecting human. Only
   matters if [`../product/04-open-questions.md`](../product/04-open-questions.md)
   §3 is answered "yes, werk touches origin".
5. **Which combination of the four loss-prevention mechanisms ships in v1?** None
   is sufficient alone and no surveyed tool combines them.
6. **Build the `ssh -R` reverse tunnel now** as a differentiator for NAT'd
   targets, or defer given zero precedent and the far simpler common case?
7. **Ignored-file policy**: vibe-kanban's `copy_files` allowlist, Container Use's
   reference-based secrets (`op://`, `env://`, `vault://`), or both — one for
   arbitrary runtime files, one specifically for secrets?
8. **Depend on `human-id`, or vendor the word list?** It's a single-maintainer
   package and workspace names appear in branches, containers, directories and
   URLs — about as core to the product's identity as a dependency gets.
9. **Repo-identity propagation to a fresh clone** — see §7.
10. **reftable now**, opt-in, for werk's own long-lived bare staging repos with
    heavy ref churn?

## Sources

Inline throughout. The four to read:
[`gitfaq(7)`'s "How do I sync a working tree across systems?"](https://git-scm.com/docs/gitfaq) ·
[`git-stash` docs](https://git-scm.com/docs/git-stash) (the `export`/`import` section) ·
[`git-worktree` docs](https://git-scm.com/docs/git-worktree) (especially BUGS) ·
[partial clone docs](https://git-scm.com/docs/partial-clone).
