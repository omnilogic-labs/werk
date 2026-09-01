# 12 — Placement backends: containers, and the other "somewheres"

`werk create` has to produce a machine. This is the research on what those
machines can be, how you talk to them, and how much of "always over ssh" survives
contact with reality.

## The finding that challenges a stated assumption

The premise is _"all interaction with machines will happen over ssh, with the
exception of your local machine."_ That is a good instinct — one transport, one
security model, tooling everyone already understands — and it is **right for
remote hosts and wrong for containers.**

For a container, `docker exec -it` and `docker attach` already give you
everything ssh would: a real PTY, live resize via `POST /exec/{id}/resize`, raw
bidirectional byte streaming. Putting an sshd inside every container to get the
same thing costs image weight, per-container host-key generation, a non-root
sshd permissions dance, and — most annoyingly — a **direct conflict over PID 1**
between sshd and any werk daemon you want in there.

distrobox is the existence proof from the other direction: `distrobox-enter` uses
`podman exec` and reaches a shell in ~400ms with no host key, no `known_hosts`,
no control socket, treating the container as _"this machine, differently"_ rather
than as a remote peer.

**The reframing that keeps the spirit intact:** ssh is how werk reaches a
_machine_. Once werk is on a machine, reaching a container it owns there is a
local operation. So:

| Placement                    | How werk gets there                                                          |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `local`                      | Directly.                                                                    |
| `ssh:host`                   | ssh, with the daemon's Unix socket forwarded ([09](09-remote-transport.md)). |
| `container` on local docker  | Locally, via the Docker API. No ssh.                                         |
| `container` on remote docker | ssh to the host, then the Docker API locally there.                          |

One ssh hop, never two, and never an sshd in an image. Keep sshd-in-container as
an opt-in for the power user who wants `scp`, `rsync` and `-L` against a
workspace with stock tooling.

---

## 1. Talking to Docker

| Library                                                  | State (2026-09)                                                                             | Verdict                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`dockerode`](https://github.com/apocas/dockerode)       | v5.0.1, 6.9M weekly downloads, last push 2026-08-10; used internally by testcontainers-node | **The pick.** Already solves connection hijacking, the 8-byte multiplex framing, and resize |
| [`@docker/node-sdk`](https://github.com/docker/node-sdk) | v0.0.17, official, generated from the API spec                                              | Too immature. Revisit                                                                       |
| `@docker/actions-toolkit`                                | v0.76.0                                                                                     | Wraps Buildx for Docker's own Actions. Not a general client                                 |
| `node-docker-api`                                        | Last published 8 years ago                                                                  | Dead                                                                                        |

**Shelling out to the `docker` CLI is the wrong default for the core loop.**
Piping a live TTY through `docker exec -it` from a child process means stacking a
second PTY layer on top of the exec'd one, with fragile resize propagation and no
structured errors. Raw HTTP over the socket means reimplementing what dockerode
already did. Shell out only where Docker's own tooling is genuinely more mature
than reimplementing it — `docker buildx`, `docker context`.

**Pin the API version.** Engine API is versioned in the path (`/v1.51/…`);
`GET /_ping` advertises the daemon's max in an `Api-Version` header. Engine 29.7.2
speaks 1.55, minimum 1.40. Negotiating to newest means behaviour drifts across a
fleet with different Docker versions — pin a tested version instead.

The core loop, concretely:

```js
docker.createContainer({…}) → container.start()
container.exec({ Cmd:['claude'], Tty:true, AttachStdin:true, … })
exec.start({ hijack:true, stdin:true })   // → raw duplex stream
exec.resize({ h, w })                     // on SIGWINCH
```

The transport is invisible to this code — dockerode is only ever handed a socket
path or a host/port at construction. That is the mechanism behind "one client
path for local and remote".

### `attach` vs `exec`

|                  | `docker attach`                                                 | `docker exec`                        |
| ---------------- | --------------------------------------------------------------- | ------------------------------------ |
| Connects to      | **PID 1 directly**                                              | A new process                        |
| Multiple clients | **Yes, concurrently**                                           | One per exec                         |
| Risk             | `^C` kills PID 1 without `--sig-proxy=false`; detach is `^P ^Q` | Killing it doesn't touch the session |

`attach`'s concurrent-client property is a free win for werk's exact use case:
the web UI and the CLI watching one live agent session, with no fan-out logic of
our own.

### Remote docker: `DOCKER_HOST=ssh://` and `docker context`

The local client runs `ssh user@host -- docker system dial-stdio` and speaks the
normal Engine API over that process's stdio. Plain ssh key auth; you can lock a
key to `command="docker system dial-stdio"` in `authorized_keys` for least
privilege. This genuinely unifies local and remote for create/start/exec/attach/
inspect.

Three limits worth knowing:

- **The remote host needs the `docker` CLI installed**, not just a daemon. That's
  a bootstrap prerequisite werk has to either require or satisfy.
- **`-p` published ports are not tunnelled.** They bind on the _remote_ host's
  interface, where dockerd's NAT rules live. `remote:8080` is not
  `localhost:8080` without a separate `ssh -L`, which Docker will not create for
  you. This is the single most surprising thing in this section.
- dockerode has no native `ssh://` dialer. The clean integration is
  `ssh -L local.sock:remote.sock` presenting the remote daemon as a local socket —
  which is the same trick as [09 §0](09-remote-transport.md), so we get it once
  and use it twice.

### The container's process model

**werk daemon as PID 1**, via `exec tini -- werkd`, speaking werk's protocol over
the `docker attach` stream. No sshd, no port, no host keys, no image weight, and
multi-viewer for free. It works identically whether the daemon socket is local or
reached through an ssh-tunnelled context.

What it loses: nobody can walk up and `ssh` in with stock tooling, and werk owns
its own framing, auth and reconnect on that channel — some of which ssh already
solved. That trade is worth making for the default path, with sshd available as
an opt-in.

Whichever way: **`--init` is non-negotiable.** PID 1 has no default signal
handlers and does not reap zombies; over a multi-day session with an agent
spawning subprocesses, the process table leaks.

---

## 2. Dev Containers

[`devcontainer up`](https://containers.dev/implementors/spec/) does: run
`initializeCommand` on the host → resolve the image (pull/build/compose, Features
as build layers) → create the container (UID/GID sync, mounts, env, user) → run
the lifecycle hooks.

| Hook                   | Where     | When                                         |
| ---------------------- | --------- | -------------------------------------------- |
| `initializeCommand`    | host      | every up/start                               |
| `onCreateCommand`      | container | once, at creation                            |
| `updateContentCommand` | container | creation + on new content (prebuild refresh) |
| `postCreateCommand`    | container | once, last creation hook                     |
| `postStartCommand`     | container | every start                                  |
| `postAttachCommand`    | container | every attach                                 |

Discovery order: `.devcontainer/devcontainer.json` → `.devcontainer.json` →
`.devcontainer/<folder>/devcontainer.json` (multiple configs per repo; the tool
should let the user pick).

**What it buys werk:** if a repo ships one, image resolution, toolchain install
and readiness hooks are handled — a real answer to "the container is already set
up for this repo". Implementors include VS Code, Codespaces, Visual Studio,
JetBrains, Coder, Daytona, Ona (formerly Gitpod, which reversed from
`.gitpod.yml`-only) and CodeSandbox.

**What it does not touch — i.e. all of werk's hard problems:** provisioning the
backend; getting the **dirty working tree** in (the spec assumes bind-mount or
clone); branch creation; remote access transport (the spec is silent; VS Code and
Codespaces use a proprietary tunnel); a persistent interactive session (`exec` is
one-shot); secrets and egress policy; and what to do for the majority of repos
that have no `.devcontainer/` at all.

**Weaknesses, stated plainly:** the spec has
[zero tagged releases](https://github.com/devcontainers/spec/releases) — versionless
and rolling, no 1.0, with open design debates including undefined Feature install
order. `@devcontainers/cli` is v0.89.0. Feature installs are serial Docker layers
with inconsistent caching and are a known slow path. Linux containers only.
Bind-mount I/O on macOS/Windows is a recurring complaint.

**Recommendation: honour `devcontainer.json` if present; fall back to a
werk-authored default image otherwise.** Do not make it a hard dependency for the
common case.

---

## 3. Claude Code's own container story

Directly relevant, since `claude` is the motivating payload — and Anthropic has
already published a reference architecture that maps almost one-to-one onto
werk's placement tiers.

**The reference devcontainer**
([anthropics/claude-code/.devcontainer](https://github.com/anthropics/claude-code/tree/main/.devcontainer),
explicitly "a working example, not a maintained base image"):

- Named volumes keyed per devcontainer (`claude-code-config-${devcontainerId}`)
  so multiple checkouts don't collide.
- **Non-root `node` user** — required, see below.
- `NET_ADMIN`/`NET_RAW` plus a `postStartCommand` firewall script installing a
  **default-deny iptables/ipset egress policy**, allowlisting GitHub, npm,
  `api.anthropic.com`, telemetry, DNS and SSH — and self-testing that
  `example.com` is blocked while GitHub is reachable.

Claude Code also ships as a **Dev Container Feature**
(`ghcr.io/anthropics/devcontainer-features/claude-code:1.0`), which is the
supported way to add it to any existing `devcontainer.json`.

**`--dangerously-skip-permissions` is rejected outright when running as root.**
That is why the reference container is non-root, and it is a hard constraint on
any image werk ships. Anthropic's own warning is worth quoting in our docs: a
malicious repo can still exfiltrate anything reachable in the container
**including `~/.claude` credentials**; don't mount host secrets; prefer
short-lived scoped tokens; pair with egress restriction.

**Anthropic's six isolation tiers**
([sandbox-environments](https://code.claude.com/docs/en/sandbox-environments))
are a ready-made framing for werk's own backend ladder:

| Tier                      | Mechanism                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Sandboxed Bash tool    | macOS **Seatbelt** (`sandbox-exec`), Linux/WSL2 **bubblewrap**. No Docker. Bash and children only                                                                                                                                                                                                                                                  |
| 2. Sandbox runtime        | [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime) — wraps the whole process tree; default-deny network; hard-denies writes to `.git/hooks`, `.git/config`, `.mcp.json`, `.claude/commands`, shell rc files, specifically so a sandboxed session can't plant something that runs unsandboxed next launch |
| 3. Dev container          | The recommended way to run unattended with permissions skipped                                                                                                                                                                                                                                                                                     |
| 4. Custom container       | Any OCI image                                                                                                                                                                                                                                                                                                                                      |
| 5. Virtual machine        | Strongest. Cites Docker Sandboxes (microVM, free, no Docker Desktop)                                                                                                                                                                                                                                                                               |
| 6. Claude Code on the web | Anthropic-managed VM                                                                                                                                                                                                                                                                                                                               |

Note tier 2's denylist. It is a well-thought-out list of "files that turn a
one-shot compromise into persistence", and werk should probably enforce something
similar for workspaces it owns.

**Claude Code on the web** is the convergent product and deserves a head-to-head
in the design doc: managed isolated VM per session, egress-allowlisting proxy,
and a _separate_ proxy holding the GitHub token outside the sandbox so the raw
PAT never enters it. Orgs can route to a
[self-hosted environment](https://code.claude.com/docs/en/self-hosted-environments).
`--teleport` pulls a cloud session to the local terminal; `--cloud` sends a local
task up.

**The gap: handoff is one-directional.** Cloud → local only. There is no way to
push a running local terminal session up
([#56687](https://github.com/anthropics/claude-code/issues/56687),
[#73639](https://github.com/anthropics/claude-code/issues/73639)). Bidirectional
session portability — start local, move it to a container, move it to a big
box — is a genuine differentiator werk could own, and it falls naturally out of
the placement model rather than being a bolt-on.

**Community prior art:** [textcortex/claude-code-sandbox](https://github.com/textcortex/claude-code-sandbox)
— **now archived** — did Docker-isolated Claude sessions with an auto-created git
branch per session, commit watching, interactive diff review and PR creation.
That is functionally werk's create→container→branch→handoff flow, local-Docker
only with no remote or provisioning story. Read it before designing that flow.

---

## 4. The other somewheres

**Podman.** Daemonless (each container is a child of the launching process),
rootless by default, `pasta` networking. `podman machine` on macOS
(Virtualization.framework) and Windows (backed by WSL2). Crucially:
`podman system service` exposes a **Docker Engine API v1.40-compatible** socket
alongside its native Libpod API — so dockerode works unmodified against it. v6.1.0,
RHEL's default engine since 2019. **Supporting Podman is nearly free if we target
the Docker API**; do that rather than writing a second backend.

**Apple `container`.** One lightweight VM per container via
Virtualization.framework ([repo](https://github.com/apple/container)). macOS 26,
Apple Silicon only. Reached 1.0.0 in June 2026, so ~3 months of history; v1.1.0
added `container machine` for persistent environments. Interesting trajectory,
too early to bet on.

**OrbStack / Colima / Rancher Desktop.** OrbStack is macOS-only and **$8/user/mo
for business use**. Colima is free and open source, VZ backend by default. Rancher
Desktop is Apache-2.0 and cross-platform. Docker Desktop is free only for
companies under 250 employees *and* under $10M revenue. **This licensing matters
to our docs** — "install Docker Desktop" is not free advice for a business user.

**WSL2 as a placement.** Real kernel in a lightweight VM,
[open-sourced](https://github.com/microsoft/WSL) in 2025, systemd supported.
Scriptable via `wsl -d <distro> -u <user> -- <cmd>` plus `--export`/`--import`.
**The risk is real**: there is no guarantee for unattended long-running
processes — `wsl --shutdown` tears down the whole VM, and community reports
suggest a Windows-side supervising process is needed to prevent teardown
([WSL#14261](https://github.com/microsoft/WSL/discussions/14261)). For a product
whose first promise is "the process outlives the connection", that is a problem
to solve deliberately, not discover later. Note Claude Code's own sandbox
supports WSL2 and **not native Windows**.

**MicroVMs.**

| Tech                                                                     | Boot                                          | Used by                                                         | Directly usable?                                                                         |
| ------------------------------------------------------------------------ | --------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [Firecracker](https://github.com/firecracker-microvm/firecracker)        | **≤125ms** to guest init, ≤5 MiB VMM overhead | Lambda, Fargate, Fly Machines, E2B                              | No — REST-over-socket, you supply kernel+rootfs, needs `/dev/kvm`                        |
| [Cloud Hypervisor](https://github.com/cloud-hypervisor/cloud-hypervisor) | ~200ms (unofficial)                           | Fly.io **GPU** Machines (VFIO passthrough Firecracker won't do) | No                                                                                       |
| [libkrun / krunvm](https://github.com/libkrun)                           | not published                                 | Podman Desktop macOS backend                                    | **Closest** — builds a microVM straight from an OCI image; Hypervisor.framework on macOS |

Scale: microVM ~125ms → warm container tens of ms–2s → cloud VM 30–60s. gVisor is
_not_ a microVM — a userspace syscall interceptor with container-class startup
and a software-only boundary. None of these are a v1 backend; `libkrun` is the
one to watch.

**Local isolation without a runtime**, worth knowing because it is the cheapest
tier and Anthropic already ships it:

- **bubblewrap** — unprivileged, no daemon, user namespaces. Used by Flatpak and
  by Claude Code's own Linux sandbox. A mechanism, not a policy.
- **macOS Seatbelt / `sandbox-exec`** — deprecated and undocumented, and still
  exactly what Claude Code uses on macOS today. No install required.
- **Landlock** — Linux LSM since 5.13. Unprivileged self-restriction that only
  ever tightens. Genuinely useful as defence-in-depth _inside_ a container:
  the agent restricts its own writes to the project directory beneath whatever
  boundary werk provides.
- **systemd-nspawn** — "chroot on steroids", no image/registry model.

---

## 5. Lifecycle for sessions that last days

**Restart policy: `--restart unless-stopped`.** Survives host reboot and daemon
restart; does _not_ resurrect containers werk deliberately stopped, which
`always` would. Policy only arms after 10s uptime. Docker's own docs warn against
combining restart policies with host-level process managers.

**Understand what survives what:**

| Event                      | Behaviour                                                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `systemctl restart docker` | Containers stop, **unless `live-restore: true`** in `daemon.json` — then containerd keeps them running. Patch releases only, not major upgrades |
| Host reboot                | Nothing survives. Containers return only via restart-policy replay when dockerd next starts — which requires dockerd to be enabled at boot      |

And a point that matters for the product's honesty: **a restart is a fresh start,
not a resume.** The agent's conversation is gone regardless of what Docker does.
Continuity is werk's problem — a terminal snapshot for the screen
([01](01-libghostty-vt.md)), and `claude --resume` or equivalent for the process.
This is the "read-only corpse" case from
[`../product/02-journeys.md`](../product/02-journeys.md) §9 and it must be
labelled honestly.

**Limits are not optional.** `--memory`, `--cpus`, and especially
**`--pids-limit`**: a runaway forking agent subprocess exhausts the _host's_ PID
table, not just its own container. That is a host-wide DoS from one bad
workspace.

**Workspace storage — three options, and the recommendation:**

| Option                      | Trade                                                                                                                                                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Live bind mount**         | Zero-copy, live host visibility, simplest. Fine on Linux. On macOS/Windows pays a real VirtioFS tax — improved from osxfs's ~5–6× to ~3× slower than native, still a meaningful cost for an agent doing heavy file I/O for days. Also risks host/container lock races |
| **`docker cp`**             | One-shot, no ongoing tax, no live visibility, racy against a concurrently-committing agent                                                                                                                                                                            |
| **Named volume + git sync** | The working tree lives on fast container-local storage; commits move in and out by git. Real git semantics, incremental, conflict-visible                                                                                                                             |

**Recommended: named volume for the tree, git push/fetch as the sync channel,
`docker cp` as an escape hatch for non-git artifacts** (build outputs, logs).
This aligns with [10-git-workspaces.md](10-git-workspaces.md) and it is the
option that does not degrade over a multi-day session.

**Garbage collection.** `docker container prune` only touches _stopped_
containers — useless for a still-running-but-abandoned workspace. The composite
design:

1. Label at creation with a reverse-DNS namespace (`com.docker.*` and `io.docker.*`
   are reserved): session id, owner, created-at, ttl.
2. Keep ground truth (last activity, expected end) in **werk's own state**, since
   labels are immutable after creation.
3. A periodic reconciliation sweep cross-referencing `docker ps -a --filter label=…`
   against that state.
4. `docker events --filter type=container` for immediate reaction to `die`/`oom`.
5. Both — events for latency, polling as the backstop for werk's own downtime.

**Credentials.**

| Mechanism                   | Leak surface                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `--env` / `-e`              | **High** — visible in `docker inspect`, `/proc/<pid>/environ`, inherited by every child, trivially logged |
| `--env-file`                | Same at runtime; only avoids shell history                                                                |
| `docker secret`             | Low — but **Swarm only**, unusable for plain `docker run`                                                 |
| `--mount type=secret`       | **Does not exist at runtime.** BuildKit build-time only                                                   |
| Read-only bind-mounted file | Low — standard Unix perms, not in `inspect` or env                                                        |
| SSH agent forwarding        | Low for the key itself; grants signing for as long as the mount is live                                   |
| Short-lived vended token    | **Lowest** — bounded, revocable, host-controlled                                                          |

Docker's [own docs](https://docs.docker.com/compose/how-tos/use-secrets/) warn
against env vars directly. **For werk: read-only file mounts, `chmod 400`,
non-root owner; short-lived scoped tokens wherever the credential type supports
it.** For git, prefer agent forwarding over mounting a key — but note Docker
Desktop on macOS/Windows does not expose the host's `$SSH_AUTH_SOCK` inside the
VM and bridges it at the fixed path `/run/host-services/ssh-auth.sock`, and that
agent forwarding doesn't work at all for a container on a _remote_ docker host
without a separate tunnel. Combined with the trust argument in
[09 §2.5](09-remote-transport.md) — the far side is an autonomous agent, not a
predictable human — **scope the forwarding window to the push step rather than
leaving it mounted for days.**

---

## 6. Cloud sandboxes as a pluggable placement

Assessed against werk's actual requirements: **run for days, give us a PTY, let
us push and pull git.**

| Provider                                                                                           | Primitive                    | Cold start               | Lifetime cap                                                      | SSH?                                | Price shape                         | Fit                                                                                       |
| -------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------ | ----------------------------------------------------------------- | ----------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| [**Daytona**](https://www.daytona.io)                                                              | undisclosed                  | "<90ms creation"         | **"Run indefinitely — built for long-running persistent agents"** | **Yes**                             | $0.0504/vCPU-hr, $0.0162/GiB-hr     | **Good**                                                                                  |
| [**Fly.io Machines**](https://fly.io/docs/machines/overview/)                                      | Firecracker                  | restart <1s; create ~10s | None                                                              | **Yes** (cert-based) + SFTP         | ~$2/mo for shared-1x/256MB          | **Good**                                                                                  |
| [Northflank](https://northflank.com/pricing)                                                       | Containers on k8s            | —                        | None                                                              | Yes                                 | $0.01667/vCPU-hr, per-second        | Good, general PaaS                                                                        |
| [Coder](https://coder.com/pricing)                                                                 | Self-hosted workspaces       | your infra               | Persistent                                                        | **Yes, by default**                 | Free ≤5 agents                      | Good conceptually — but it's infra you run via Terraform, so werk provisions _through_ it |
| [GitHub Codespaces](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces) | Persistent devcontainer VM   | —                        | **30-min idle default, 4h max**                                   | Yes (`gh codespace ssh`)            | $0.18–2.88/hr                       | Marginal — the 4h ceiling forces pause/resume                                             |
| [E2B](https://e2b.dev)                                                                             | Firecracker                  | "<200ms"                 | **1h free, 24h on Pro ($150/mo)**                                 | **No** — exec API only              | $0.0504/vCPU-hr                     | Poor — built for ephemeral code execution                                                 |
| [Modal Sandboxes](https://modal.com/docs/guide/sandbox)                                            | Container                    | —                        | **5 min default, 24h max**                                        | **No**                              | ~$0.047/core-hr                     | Poor                                                                                      |
| [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/)                               | Container via Durable Object | —                        | sleeps after unspecified idle                                     | **No** — exec + browser WS terminal | ~$0.072/vCPU-hr, needs Workers Paid | Marginal                                                                                  |
| Depot                                                                                              | "Agent sandboxes"            | —                        | Explicitly ephemeral                                              | —                                   | $0.01/min                           | Not a fit                                                                                 |
| Blacksmith                                                                                         | Bare-metal CI runners        | —                        | CI-job only                                                       | **No persistence primitive at all** | $0.004/min                          | Not applicable                                                                            |

**The clustering is sharp.** Only **Daytona** and **Fly.io Machines** are built
for indefinite persistence _with_ real SSH — those are the two to prototype
against if a cloud backend is wanted. Northflank is the general always-on PaaS
option. Coder and Codespaces are dev-workspace platforms rather than
spin-up-by-API sandboxes. **E2B and Modal are the wrong shape entirely** — they
are code-execution products with a 24-hour ceiling, and a lot of the "agent
sandbox" marketing in this space points at them.

That table is also the argument for treating placement as a plugin boundary from
the start: the fit differences are large, they will move, and none of them should
be able to reach into werk's core.

---

## Open questions

1. **Does `dockerode` run cleanly under Bun** — unix-socket dialing, stream
   hijacking? Needs a spike, not a docs read.
2. If the PID-1-daemon-over-`attach` transport is the default, what is the
   auth/framing story when the docker socket is shared by several werk sessions?
   Does that reintroduce what ssh already solved?
3. Does werk require `docker` CLI pre-installed on every remote host, or does
   `werk create` bootstrap it?
4. Default local image: derive from Anthropic's reference devcontainer (free
   firewall + non-root pattern) or a leaner werk-authored one?
5. **Prototype bidirectional session portability?** Claude Code only goes cloud →
   local today. This may be werk's clearest narrative differentiator.
6. Do Daytona / Fly / Northflank support pushing a _dirty_ working tree
   efficiently, or does every backend force the same git-sync design?
7. WSL2's unattended-process risk — does Windows need a keep-alive service, and
   is that scope creep against shipping Windows at all in v1?
8. Should GC state be recoverable from Docker labels alone if werk's state is
   lost? Cheap to design in, expensive to retrofit.

## Sources

Inline throughout. Read first:
[Anthropic's sandbox-environments docs](https://code.claude.com/docs/en/sandbox-environments)
(the tier framing is directly reusable),
[the Dev Container spec](https://containers.dev/implementors/spec/),
and [dockerode](https://github.com/apocas/dockerode).
