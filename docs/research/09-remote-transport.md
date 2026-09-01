# 09 — Remote transport: getting werk onto a machine, and talking to it

The scope expansion in [`../product/00-what-werk-is.md`](../product/00-what-werk-is.md)
turns two things that were non-problems into load-bearing ones: **werk has to
install itself on machines it has never seen**, and **the local client has to
talk to daemons it does not share a filesystem with**. This is the research on
both.

## The headline finding: forward the Unix socket

**OpenSSH's `-L` and `-R` accept Unix-domain socket paths on either end**, not
just `host:port`. This has been true since OpenSSH 6.7 (2014) and it collapses
werk's entire remote-transport problem into a one-line invocation.

```sh
ssh -N -L /tmp/werk-bigbox.sock:/run/user/1000/werk/daemon.sock bigbox
```

Forms, from [`ssh_config(5)`](https://man.openbsd.org/ssh_config) — the rule is
**if an argument contains a `/`, it is a socket path, not a port**:

```
-L local_socket:remote_socket
-L local_socket:host:hostport
-L [bind_address:]port:remote_socket
        …and the mirror image for -R
```

Why this matters so much: the remote `werkd` binds an ordinary Unix socket
exactly as it does locally — no TCP listener, no port allocation, no port
collisions between users, and filesystem permissions do access control for free
(see [04 §5](04-daemon-best-practices.md)). The local client connects to a
forwarded socket and speaks **the identical protocol it speaks to the local
daemon**. There is no remote protocol, no second transport, no auth layer of our
own. "Talk to the local daemon" and "talk to a daemon on bigbox" become the same
code path with a different socket path.

This is not exotic. It is the standard trick for `DOCKER_HOST` over ssh, and
[Lima/Colima use it routinely](https://www.skreutz.com/posts/unix-domain-socket-forwarding-with-openssh/).
DevPod reaches the same destination by a longer road (it runs an SSH _server_
over whatever tunnel the provider gives it).

**Adopt this as the default remote transport.** Two caveats, both real:

- **Unverified under our traffic pattern.** Every documented use is a
  request/response socket proxy (the Docker socket). A live PTY stream is many
  small frames with a low latency requirement. The syntax certainly works; the
  latency and buffering behaviour under our load is an experiment we have not
  run. **Do this experiment before committing the architecture.**
- **Windows-side sockets are unreliable.** Forwarding a _remote Linux_ socket to
  a macOS/Linux client is well-trodden. A _local Windows_ Unix socket endpoint
  has had real bugs ([Win32-OpenSSH#1564](https://github.com/PowerShell/Win32-OpenSSH/issues/1564)).
  Windows probably needs the forward to land on a loopback TCP port instead.

---

## 1. Bootstrap: how everyone else installs themselves on a remote box

Every mature tool in this space has converged on the same four steps. The
differences are in the details, and the details are where the bugs are.

> detect platform → fetch or push a version-pinned payload → run it detached →
> reconnect to it later

### VS Code Remote-SSH

The most-used implementation, and the one with the most public failure reports.

- **Version matching is by exact commit hash, not semver.** The server installs
  to `~/.vscode-server/bin/<commit-id>/`; a second connection from the same
  client build finds it and skips install. Any client update forces a full
  redownload. ([Remote Development FAQ](https://code.visualstudio.com/docs/remote/faq))
- **The remote downloads its own payload by default** from
  `https://update.code.visualstudio.com/commit:<commit>/server-linux-x64/stable`
  — which requires outbound HTTPS _from the remote_. The documented fallback,
  `remote.SSH.localServerDownload`, downloads locally and uploads over the ssh
  connection. **We need the upload path as the default**, not the fallback: a
  build box behind a firewall is the normal case, not the exception.
- **Platform detection is the recurring weak link.** It runs `uname -s`/`uname -m`
  and checks for `/lib/ld-musl-*`, and it gets it wrong on Yocto and other
  unusual distros ([#11293](https://github.com/microsoft/vscode-remote-release/issues/11293),
  [#423](https://github.com/microsoft/vscode-remote-release/issues/423)). It ships
  `remote.SSH.remotePlatform` as a manual override _because_ the heuristic
  fails. **Ship the override from day one.**
- The server is a detached background process, so a dropped ssh connection does
  not kill the extension host. A fresh connection re-attaches.
- Cautionary tale directly relevant to us: its local IPC sockets have hit the
  **~104-byte macOS `AF_UNIX` path limit** and broken the product outright
  ([vscode#320422](https://github.com/microsoft/vscode/issues/320422)). Keep werk's
  socket paths short and out of project directories.

### JetBrains Gateway

Same shape, and worth citing for one sentence in its own docs: closing the client
does **not** stop the backend — "the IDE backend will continue running" and you
reconnect from the recent-connections list
([Deep Dive](https://blog.jetbrains.com/blog/2021/12/03/dive-into-jetbrains-gateway/)).
A second independent vendor arriving at werk's exact contract. It also runs TLS
1.3 _inside_ the ssh tunnel, which is belt-and-braces we do not need.

### mosh — the cleanest bootstrap handshake in existence

`mosh` ssh's in, runs `mosh-server new`, which allocates a UDP port, generates a
session key, and prints **one line to stdout**:

```
MOSH CONNECT 60001 EPZ2sM6Alaaaad4AxWRIqg
```

The client parses that line and **tears the ssh connection down entirely**. SSH's
only job was to authenticate and hand off a port and a key.
([ArchWiki](https://wiki.archlinux.org/title/Mosh))

The _pattern_ — use ssh as a one-shot authenticated bootstrap channel, then hand
off — is the right one to have in mind. The _destination_ is not: mosh needs UDP
because it is solving roaming for a session whose state lives on the client. Our
state lives on the remote daemon, so we get the same resilience by simply
reconnecting the tunnel. Take the handshake idea, skip the second protocol.

### Mutagen — the closest match to our binary-push problem

Keeps a tarball of prebuilt per-platform agent binaries inside its own install,
SCPs the right one to a **version-scoped path**
(`.mutagen/agents/<version>/mutagen-agent`), `chmod +x`, then execs it with a
subcommand ([install.go](https://github.com/mutagen-io/mutagen/blob/master/cmd/mutagen-agent/install.go)).
The version-scoped path is the same trick as VS Code's commit-hashed directory
and it is how two client versions coexist on one host without fighting. Its
public bugs are, again, **detection failures** and `ProxyCommand` breakage
([#147](https://github.com/mutagen-io/mutagen/issues/147),
[#49](https://github.com/mutagen-io/mutagen/issues/49)).

### DevPod — the closest match to our whole architecture

Worth reading properly. ([How it works](https://devpod.sh/docs/how-it-works/overview))

- **One static Go binary that is also its own remote agent** (`devpod agent`).
  There is no separate server artifact to version-match — it just re-execs the
  same file. This is exactly the shape werk should have, and it is the single
  strongest argument for the fat-binary approach: the thing you push _is_ the
  thing you run.
- It "injects itself into the environment" and the injected agent handles
  container lifecycle, credential forwarding, an SSH server, and idle shutdown.
- The agent starts an SSH server **over the stdio of whatever tunnel the provider
  already gives it** — `aws ssm start-session`, `kubectl exec`, a plain ssh
  exec — rather than opening a listening port. The user then gets a real
  `ssh workspace.devpod` entry and _any_ ssh-speaking tool works against it.
- **The pattern to steal: expose every placement as one more ssh host,
  regardless of what is actually underneath.** That is precisely how werk should
  make `local`, `ssh:` and `container:` feel like one thing.

### Ansible — payload delivery without a temp file

AnsiballZ builds a zip of the module plus its dependencies, base64s it into a
bootstrap script, and ships that. The interesting knob is **pipelining**
(`ANSIBLE_PIPELINING=True`): pipe the script straight into the remote
interpreter's stdin over the existing exec channel, skipping write/chmod/exec/rm
entirely and saving several round trips
([Adam Johnson](https://adamj.eu/tech/2015/05/18/making-ansible-a-bit-faster/)).
Its default connection plugin uses `ControlMaster=auto` with a 60s
`ControlPersist`.

Known sharp edge worth remembering: **pipelining and `ControlPersist` interact
badly** — broken-pipe detection stops working reliably and tasks fail with rc
-13 ([ansible#78344](https://github.com/ansible/ansible/issues/78344)). If we
combine a persistent multiplexed connection with piped stdin exec, test for it.

### The rest, briefly

| Tool                    | Mechanism worth knowing                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Nix** `--target-host` | No bootstrap binary at all: copies store paths over `ssh-ng://` and activates remotely. Separates ssh transport config from behaviour via one env var (`NIX_SSHOPTS`).                                                    |
| **Teleport**            | Agent installed once, registers with a cluster; `tsh` gets **session resumption from its own protocol**, not from ssh multiplexing — which is why it works identically on Windows.                                        |
| **Tailscale SSH**       | No bootstrap: tailnet identity _is_ the credential, `tailscaled` intercepts :22 and uses ssh's `none` auth. Only applies if both ends already run Tailscale — which is exactly our documented remote-access story anyway. |
| **distrobox / toolbx**  | The negative case, and the useful one — see below.                                                                                                                                                                        |

### distrobox: the argument against ssh-everywhere

`distrobox-enter` uses `podman`/`docker exec` **directly** into the container
namespace and reaches a shell in ~400ms, with no host key, no known_hosts, no
sshd in the image, no control socket
([README](https://github.com/89luca89/distrobox)). It bind-mounts the home
directory, the Wayland/X11 sockets, the journal, D-Bus, `/dev`, and **the ssh
agent** — treating the container as "this machine, differently" rather than as a
remote peer.

The stated design intent is "all interaction with machines happens over ssh". For
a container on the user's _own_ machine, that is ceremony for no benefit. The
honest recommendation is **two transport branches**: `docker exec` for local
containers, ssh for anything genuinely remote (including a container on a remote
docker host, reached by ssh to the host and then exec into the container). See
[12-placement-backends.md](12-placement-backends.md).

---

## 2. SSH connection management for a long-lived daemon

### ControlMaster is an optimisation, never a foundation

`ControlMaster=auto` + `ControlPersist` lets independent short-lived ssh
invocations share one authenticated connection via a Unix socket
([ssh_config(5)](https://man.openbsd.org/ssh_config)). Ansible reports roughly
**0.9s cold vs 0.05s multiplexed** per exec, so the win is real.

Three reasons not to build on it:

1. **It does not exist on Windows.** Win32-OpenSSH cannot create the `AF_UNIX`
   control socket; you get `getsockname failed: Not a socket`
   ([vscode-remote-release#96](https://github.com/microsoft/vscode-remote-release/issues/96)).
   Any code that unconditionally passes `-o ControlMaster=auto` hard-fails there,
   so Windows needs an explicit `-o ControlMaster=no -o ControlPath=none`.
2. **`ControlPath` overflows the socket path limit.** 104 bytes on macOS/BSD, 108
   on Linux. Use `%C` (a hash of `%l%h%p%r%j`, added in 6.7; the ProxyJump chain
   folded in since 8.4) rather than literal `%h-%p-%r`. This broke VS Code
   Remote-SSH on macOS as recently as 2026.
3. **It fails by hanging, not by erroring.** A blackholed master leaves a socket
   that new connections block on — and `ssh -O check` can itself hang, because
   the check waits on the same dead pipe. The mitigation is
   `ServerAliveInterval`/`ServerAliveCountMax` on the master so it self-destructs
   within a bounded window (~90s at 30s×3).

**The better answer for us, and it comes free:** ControlMaster exists to fake
multiplexing across _separate processes_. werk is already one persistent daemon.
One ssh connection held open, with logical channels opened per operation, is what
ControlMaster is imitating — and the SSH protocol has supported it natively since
RFC 4254. An in-process ssh client gets real multiplexing on every platform,
Windows included, with no control socket, no path limit, no `ControlPersist`
tuning. That is a serious argument for an SSH _library_ over shelling out to the
`ssh` binary, and it is discussed in [08-bundled-tooling.md](08-bundled-tooling.md) §4.

Note `MaxSessions` on the _server_ defaults to **10** concurrent channels. Not a
problem for one werk connection; worth knowing before assuming it is unbounded.

### Keepalives, and detecting death

`ServerAliveInterval` (default 0 — off) and `ServerAliveCountMax` (default 3)
travel inside the encrypted channel and are the only reliable way to notice a
dead peer; TCP keepalive operates on a far coarser timescale and gets eaten by
NATs. **Every liveness check must be bounded.** A check that does not return
inside the window means "assume dead, tear down, reconnect" — never "block the
UI". This is the rule that keeps `werk` fast when a laptop in the fleet is
asleep.

### known_hosts for machines we create ourselves

`StrictHostKeyChecking=accept-new` is the right default for containers and VMs we
provision: it accepts a key on first contact but **still hard-fails if a recorded
key changes**, so key-rotation and MITM detection survive while the interactive
TOFU prompt goes away. `StrictHostKeyChecking=no` disables verification
permanently and must never be used for anything werk owns.

Two refinements:

- **Scope it, and give it its own file.** A `werk-*` `Host` block with a
  dedicated `UserKnownHostsFile` means container keys can be pruned wholesale
  when a workspace is destroyed, instead of accumulating in the user's
  `~/.ssh/known_hosts` forever with a real port-reuse collision risk. It also
  means a MITM against a _user-facing_ host still gets the full prompt.
- **Better still, pin the key at creation.** We create the container; we can read
  `/etc/ssh/ssh_host_ed25519_key.pub` out of it via `docker exec` before ever
  connecting, and pin exactly that. `accept-new` trusts whoever answers first,
  which is fine for a local docker socket and not fine once "container" can mean
  "cloud VM with a public IP".

### Agent forwarding is worse for us than for anyone else

The standard risk — anyone with root on the far side can use your forwarded agent
to authenticate as you anywhere, for as long as the connection is open
([Bernat](https://vincent.bernat.ch/en/blog/2020-safer-ssh-agent-forwarding)) —
gets sharper when **the thing on the far side is an autonomous agent**. The
"attacker" need not be a human on a shared box; it can be a prompt injection, or
a postinstall script in a dependency the agent just added. A human operator on a
bastion is predictable in a way `claude --dangerously-skip-permissions` is not.

**Default `ForwardAgent no`.** Prefer scoped, short-lived credentials injected
into the workspace — a deploy key, a narrowly-scoped token — over forwarding the
user's primary agent. Where forwarding is genuinely wanted, `ssh-add -c`
(confirm-per-use) and hardware-backed agents (Secretive, YubiKey) at least make
draining it noisy. This is a product decision as much as a security one and it
belongs in the docs, loudly.

---

## 3. Windows as a client

| Capability                          | Windows in-box OpenSSH                                                                                     | Source                                                                                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ships built in                      | Yes, since Win10 1809                                                                                      | [MS overview](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-overview)                                                           |
| Version                             | Materially behind upstream — reports of 7.7p1–8.1p1 on current builds; Windows Update does not refresh it  | [MS troubleshooting](https://learn.microsoft.com/en-us/troubleshoot/windows-server/system-management-components/upgrade-in-box-openssh-to-latest-openssh-release) |
| `ControlMaster`                     | **Unsupported.** `getsockname failed: Not a socket`                                                        | [vscode-remote-release#96](https://github.com/microsoft/vscode-remote-release/issues/96)                                                                          |
| `ssh-agent`                         | Ships as a Windows service, **disabled by default** — needs `Set-Service ssh-agent -StartupType Automatic` | [MS key management](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement)                                                |
| Windows-side Unix socket forwarding | Buggy; treat as unavailable                                                                                | [Win32-OpenSSH#1564](https://github.com/PowerShell/Win32-OpenSSH/issues/1564)                                                                                     |

What everyone else does: **stop depending on OS-level multiplexing**. Either
multiplex logical streams in your own protocol over one long-lived connection
(mosh natively; Teleport by design, which is why `tsh` is portable for free), or
accept per-command reconnect latency.

For werk the options are, in order of preference:

1. **One persistent connection per host, opened once, multiplexed in-process.**
   Works identically on all three platforms. Makes the Windows gap disappear
   rather than special-casing it.
2. One `ssh -N` process per host that werk manages itself, with the forwarded
   socket (or loopback port on Windows) as the single channel.
3. Per-command `ssh`, accepting ~1s each. Fine for a prototype, not for `werk`
   feeling like `ls`.

---

## 4. Moving bytes

| Method                   | Protocol today                                                                                    | Resumable                | Notes                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------- |
| `scp`                    | **SFTP-backed since OpenSSH 9.0**; legacy protocol needs `-O` and is disabled on hardened systems | No                       | Legacy protocol had real CVEs (CVE-2020-15778); that is why it was deprecated                 |
| `sftp`                   | SFTP subsystem                                                                                    | Yes (`reget`/`reput`)    | Same ~2 MB buffer ceiling — about **32 Mbps on high-RTT paths**                               |
| `rsync -e ssh`           | Rides ssh                                                                                         | Yes, plus delta transfer | **Requires rsync on both ends.** Huge win on repeated syncs, useless on a scratch container   |
| `tar \| ssh host tar -x` | Raw stream over one exec channel                                                                  | No                       | **Zero remote dependencies beyond POSIX and a shell.** Best raw throughput of the ssh options |
| `ssh host 'cat > f'`     | Raw pipe                                                                                          | No                       | Fine for one file, no permissions or directories                                              |

Sources: [OpenSSH 9.0 scp change](https://www.redhat.com/en/blog/openssh-scp-deprecation-rhel-9-what-you-need-know),
[ESnet: Say No to scp](https://fasterdata.es.net/data-transfer-tools/say-no-to-scp/).

**Recommendation.** `tar | ssh host tar -x` for the bootstrap push, because it
assumes nothing about the target — the same reasoning that lands VS Code on
"download locally and upload" and Mutagen on plain SCP. Promote `rsync` only for
repeated operations, and only after probing for it once per host and caching the
answer.

## 5. Detecting the remote environment in one round trip

Every fresh non-multiplexed ssh exec costs a full handshake RTT. **Bundle the
whole probe into one script with a delimiter**, never N separate `ssh host cmd`
calls.

```sh
uname -sm                                   # "Linux x86_64" / "Darwin arm64"
find /lib /lib64 /usr/lib -maxdepth 1 -name 'ld-musl-*' 2>/dev/null \
  | grep -q . && echo musl || echo glibc
```

**Detect musl by the presence of the dynamic linker file, not `ldd`.** glibc's
`ldd` prints a version banner; musl's is a shell wrapper that behaves differently
across distros, and `ldd` needs a binary to test against anyway
([musl FAQ](https://wiki.musl-libc.org/faq),
[detect-libc](https://github.com/lovell/detect-libc)).

And ship the manual override, because this heuristic _will_ be wrong on
somebody's NixOS or Yocto box, and when it is, the user needs a way to proceed
that isn't "file an issue".

---

## 6. Why reconnection is cheap for us

Mosh's problem statement: an ssh-attached session is bound to one TCP connection,
and any network change kills it. **werk's architecture already dissolves the hard
half of this.** The process is supervised by a daemon on the far side, so a
dropped connection loses the _view_, never the _work_. Reconnection is:

1. notice (bounded `ServerAlive*` timeout, or a failed read on the forwarded socket),
2. re-run the normal connect sequence,
3. re-attach to the still-running remote session.

No state migration, no session resurrection, no second protocol. This is exactly
the guarantee `ssh host -t tmux new-session -A` has always given, and werk is a
purpose-built version of it. **We do not need mosh.** We need the reconnect to be
fast and silent.

Two latency notes worth designing around:

- **Pre-warm.** Open the ssh connection the moment intent is known — concurrently
  with resolving which host, choosing an image, whatever else `werk create` is
  doing — so the 0.2–1s handshake is absorbed rather than sitting on the critical
  path.
- **Never block the list.** `werk` must render with an unreachable host marked as
  unreachable, on a short timeout, always.

---

## Open questions

1. **Does `-L local_socket:remote_socket` hold up under a live PTY stream?** Many
   small frames, latency-sensitive, bidirectional. Every citation is a
   request/response proxy. **Run this experiment first** — it determines whether
   the "no bespoke network protocol" plan survives.
2. Are we too coupled to vanilla OpenSSH client behaviour? Users on SSO-gated or
   bastion-heavy corporate setups may not be able to open arbitrary forwards.
   Teleport's answer (define reachability as "however you already reach the
   host") is more portable and much more work.
3. Windows: our own multiplexer process, require WSL2, or eat the per-command
   latency initially? Needs a decision, not a deferral — it shapes the client.
4. Do we pin container host keys at creation, or accept `accept-new`? Cheap to do
   properly; do it properly.
5. Detect-then-fetch (VS Code, Mutagen) or push-and-see-if-it-runs (DevPod)? The
   first has better errors; the second has fewer round trips. Prototype both.
6. Does the local binary carry every platform's remote payload, or fetch the
   right one from a release server? Carrying is huge; fetching needs network on
   one side and an air-gapped story. See [07-packaging.md](07-packaging.md).

## Sources

Inline throughout. The three to actually read:
[ssh_config(5)](https://man.openbsd.org/ssh_config) (the `-L` socket forms and
`%C`), [DevPod's "How it works"](https://devpod.sh/docs/how-it-works/overview),
and [VS Code's Remote Development FAQ](https://code.visualstudio.com/docs/remote/faq)
plus its issue tracker, which is a catalogue of every mistake available to make
here.
