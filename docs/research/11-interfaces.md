# 11 — Interfaces: TUI, web, desktop, notifications

The stated ask is "a nice snazzy sexy terminal interface and a nice snazzy sexy
web interface", with a desktop app later, all shipped inside one Bun-compiled
binary. This is the library and pattern landscape for that, verified against npm
and vendor docs on 2026-09-01.

> **One correction to fold in.** This research flagged `node-pty` as the most
> foundational native-addon risk in the whole plan. That risk is now much
> smaller: **Bun ships a native `Bun.Terminal` PTY API** (v1.3.5 POSIX, v1.3.14
> Windows ConPTY), purpose-built to replace `node-pty`. See
> [07-packaging.md §4](07-packaging.md). The remaining native-addon risk is
> OpenTUI's Zig core; libghostty arrives as WebAssembly with no imports, which
> is an embedded asset rather than an addon.

## Decision matrix

| Area                    | Lean toward                                                                       | Why                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| TUI framework           | **Ink** for v1; watch **OpenTUI**                                                 | Ink is proven in Claude Code and Gemini CLI. OpenTUI is snazzier and Bun-native but ships prebuilt Zig binaries — unverified inside `--compile`   |
| Terminal-inside-the-TUI | **Build it** on libghostty's render state                                         | Nothing ships this off the shelf; the daemon's emulator and its dirty-row iterator are already there                                              |
| CLI parsing             | **citty** or **`util.parseArgs`**                                                 | Zero-dep, `--compile`-safe. Avoid oclif                                                                                                           |
| Browser terminal        | **libghostty via upstream WASM**; renderer by rebasing **ghostty-web** or our own | One emulator everywhere, state transfer as the wire format. The renderer route is open — [proposal §3](../proposals/00-stack-proof-of-concept.md) |
| Server                  | **Bare `Bun.serve`**                                                              | Routes + WS pub/sub + HTML-import bundling already covers the whole surface                                                                       |
| Frontend                | **Svelte 5 or Solid** on merit; React if Ink familiarity wins                     | Both beat React on bundle size and per-widget update cost                                                                                         |
| Desktop                 | **Tauri v2**, the Bun binary as a signed sidecar                                  | The only shell with a documented story for reusing the compiled binary as-is                                                                      |
| Notifications           | **ntfy.sh** default, webhook for teams                                            | Near-zero setup, phone-native, actually solves "away from keyboard"                                                                               |

---

## 1. TUI frameworks

| Library                                                       | Version / stars               | Maintained               | Notes                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------- | ----------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**Ink**](https://github.com/vadimdemedes/ink)                | v7.1.1, 39.8k★                | Yes                      | React → Yoga flexbox → ANSI. **Used by Claude Code and Gemini CLI** — the incumbent for exactly this kind of tool. Weak spot: full-tree re-render on every state change can tear at high update frequency; throttle or drop to imperative writes on the hot path |
| [**OpenTUI**](https://github.com/sst/opentui) `@opentui/core` | v0.5.10, 13.2k★, 1131 commits | **Very active**          | By Anomaly Co., **used in production by opencode**. React and Solid renderers. Ships QR rendering, WebGPU/Three.js, and an SSH-server integration package. Requires Bun ≥1.3.0. **Core is Zig compiled to prebuilt per-platform native binaries**                |
| [terminal-kit](https://github.com/cronvel/terminal-kit)       | v3.1.x, 3.4k★                 | Alive, single maintainer | Imperative API, not component-based                                                                                                                                                                                                                              |
| **blessed**                                                   | **0.1.81, published 2015**    | **Dead**                 | Historically the only JS lib with a real terminal-emulator widget (`type: 'terminal'`, backed by term.js) — which is why it keeps getting cited. Do not build on it                                                                                              |
| neo-blessed                                                   | 0.2.0, 2018                   | **Dead**                 | Fork, also stalled                                                                                                                                                                                                                                               |
| [@clack/prompts](https://github.com/bombshell-dev/clack)      | 0.9.x, 8.0k★                  | Yes                      | Best-in-class _prompts_ (used by create-vite, drizzle-kit, astro). For `werk init`, not for a dashboard                                                                                                                                                          |
| prompts                                                       | 2.4.2, **2021**               | Dead                     | —                                                                                                                                                                                                                                                                |
| inquirer / enquirer                                           | 14.2.0 / 2.4.1                | Yes / stalled            | Heavier, more legacy-flavoured than clack                                                                                                                                                                                                                        |
| picocolors vs chalk                                           | both maintained               | Yes                      | **picocolors** is ~10× smaller and faster; used by Vite and PostCSS. Prefer it when every KB and cold-start ms is embedded in a binary                                                                                                                           |
| `log-update`, `ansi-escapes`, `cli-table3`                    | maintained, low-churn         | Yes                      | `log-update` is the standard in-place multi-line redraw trick — worth using directly if the TUI stays light rather than adopting a framework wholesale                                                                                                           |

**The `--compile` question.** Ink, clack and terminal-kit are pure JS and bundle
cleanly. **OpenTUI is the risk case** — its Zig core ships as prebuilt
per-platform native binaries (the esbuild/swc pattern), so `--compile` must
either target one platform per build and embed that one addon, or ship several
and pick at runtime. Given [07 §4](07-packaging.md) documents live bugs with
multiple embedded native addons, **spike this before committing**. OpenTUI would
be the only native addon in the binary; libghostty is WASM and does not count.

### The bar for "snazzy"

Cross-language reference points worth actually reading, not just name-checking:

| Project                                                                                 | What to steal                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**Bubble Tea / Lip Gloss / Bubbles**](https://github.com/charmbracelet/bubbletea) (Go) | The Elm `Model/Update/View` loop maps cleanly onto Ink's React model. **Lip Gloss's declarative border/padding/colour chaining is the look to hit** — rounded boxed panels, adaptive light/dark palettes. Bubbles' `viewport` (scrollable pane) and `spinner`/`progress` are exactly werk's primitives                                                   |
| [**Ratatui**](https://github.com/ratatui/ratatui) (Rust)                                | Its `Constraint::Percentage/Min/Length` layout system is a cleaner mental model than manual flex for a fixed sidebar + flexible main pane. Its immediate-mode redraw-the-whole-frame model is worth copying for the many-live-sessions case — cheaper to reason about when content changes every frame anyway                                            |
| [**Textual**](https://github.com/Textualize/textual) (Python)                           | **CSS-like stylesheets for TUI widgets** (real `.tcss` files with `:hover`/`:focus`). Its `textual console` live inspector — streaming a running TUI's logs to a second terminal — is a debugging pattern to copy for werk itself. And `textual-web` runs the same app in a browser, which is directly relevant to wanting one model behind two surfaces |
| [Vaxis](https://github.com/rockorager/libvaxis) (Zig)                                   | Kitty graphics / Sixel rendering and synchronized-output (`CSI ?2026h`) for tear-free redraws                                                                                                                                                                                                                                                            |

### The gap nobody fills

**No TS TUI framework has a terminal-emulator widget.** Not Ink, not OpenTUI.
The only library that ever had one is dead. werk's TUI wants a **live preview
pane of a session's last N lines** — the feature that justifies building a TUI
over the flat list at all — so this has to be built: libghostty holds the VT
state through the same loader the daemon uses, fed by state transfer, and a
custom renderer paints its dirty rows into Ink's or OpenTUI's render tree.
**Spike this before choosing a framework**, because it is the one thing the
framework choice actually has to support.

---

## 2. CLI parsing

| Library                                                                   | Version                | Passthrough to a child process                                                                                                                          | Help                      | `--compile` fit                                                                                                                                                                       |
| ------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**citty**](https://registry.npmjs.org/citty) (unjs)                      | **v0.2.2, 2026-04-01** | Built on `util.parseArgs`; rest via `args._`                                                                                                            | Clean                     | **Zero-dep, very safe**                                                                                                                                                               |
| [**@stricli/core**](https://registry.npmjs.org/@stricli/core) (Bloomberg) | **v1.3.0, 2026-07-16** | No documented rest-passthrough pattern; manual slicing                                                                                                  | Generated from types      | Zero-dep. Solid dark horse                                                                                                                                                            |
| **`util.parseArgs`** (built in)                                           | ships with Bun         | `strict:false` + `allowPositionals` gives raw leftovers                                                                                                 | **None — bring your own** | Cannot break                                                                                                                                                                          |
| [clipanion](https://github.com/arcanis/clipanion) (Yarn's)                | 4.0.0-rc.4             | **Best-in-class**: `Command.Rest` / `Command.Proxy` exist precisely to slurp everything after a point — literally Yarn's `yarn run x -- args` mechanism | Good, command trees       | Pure JS, good track record                                                                                                                                                            |
| commander                                                                 | v15.0.0                | Weak — `.allowUnknownOption()` + manual `--`                                                                                                            | Good                      | Safest, zero-dep                                                                                                                                                                      |
| yargs                                                                     | v18.1.0                | `--` well supported via `populate--`                                                                                                                    | Very good                 | Heavier but fine                                                                                                                                                                      |
| cac                                                                       | v7.0.0                 | via `cli.args` after `--`                                                                                                                               | Minimal                   | Tiny                                                                                                                                                                                  |
| **oclif**                                                                 | v5.0.0                 | Yes, but…                                                                                                                                               | **Excellent**             | **Avoid.** Its whole architecture — plugin discovery, per-command file loading, topic trees — assumes an installed npm package it can introspect on disk. Bad fit for a single binary |

**Don't over-index on "passthrough support".** The architectural need for
`werk claude --dangerously-skip-permissions` isn't a parser feature — it's
"parse werk's own flags, then hand everything past the command boundary to
`Bun.spawn` untouched". The robust implementation is: find the index of the first
positional subcommand token in `argv`, parse only the slice before it, pass the
remainder through verbatim. That works with _any_ parser. So choose on `--help`
quality and `--compile` safety instead.

---

## 3. Terminals in the browser

| Option                                                              | State                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **upstream `ghostty-vt.wasm`**                                      | rolling `tip`, pinned by SHA | **The engine, in the browser as in the daemon.** Ghostty's VT as a freestanding WASM with zero imports: snapshot decoder, render state with dirty rows, key and mouse encoders. It draws nothing — a renderer over it is the open item, and the two rows below are the candidates for that                                                                                                                                             |
| [**ghostty-web**](https://github.com/coder/ghostty-web)             | 2.8k★, **119 commits**, MIT  | The only existing **browser renderer over Ghostty's VT**: canvas rendering, keyboard, selection, behind an xterm.js-shaped API. ~400 KB. Pinned to a December 2025 Ghostty behind a 1,620-line private patch, so it does not decode upstream `tip` snapshots as-is. Built by **Coder**, "originally created for Mux" — a near-exact werk analogue. **The lean is to rebase it onto the pinned upstream artifact**                      |
| [**`@xterm/xterm`**](https://registry.npmjs.org/@xterm/xterm)       | **v6.0.0**                   | **Not the engine, and not reducible to a renderer.** Its DOM, canvas and WebGL renderers read xterm's own buffer, with no supported way to drive them from foreign state; the only way to show libghostty's screen in it is re-emitting VT, which puts a second emulator in the browser. Individual parts — `fit`'s measurement, `web-links`, the search UI — may detach cleanly; whether any do is a finding for the proof of concept |
| [**`@xterm/headless`**](https://registry.npmjs.org/@xterm/headless) | v6.0.0                       | A second, independent emulator with no DOM. **Used only as a differential test oracle** in the proposal's corpus — its `parser.registerOscHandler` reports the same effects libghostty does, so disagreements on text, style or effects flag a bug in one of the two                                                                                                                                                                   |
| [asciinema player](https://github.com/asciinema/asciinema-player)   | maintained                   | Playback only. Wrong tool for live, right tool for replaying a finished or crashed run — and [03 §recording](03-prior-art.md) already argues for writing asciicast alongside every session                                                                                                                                                                                                                                             |
| hterm, wterm                                                        | legacy                       | Not serious 2026 contenders                                                                                                                                                                                                                                                                                                                                                                                                            |

**Why the same emulator in the browser is worth a renderer.** The browser runs
**the same libghostty build as the daemon**, and receives state as `GHOSTSNP`
bytes: the two-stage `READY`-then-history decode paints the viewport before the
scrollback arrives, soft-wrapped lines survive a resize, and mosh-style
speculative echo and diff reconciliation become tractable instead of a research
project. That argument is made in [05 §E](05-control-surfaces.md). The cost is
that every libghostty in the fleet and the browser bundle have to agree on a
snapshot format that carries no compatibility guarantee — see
[proposal §3](../proposals/00-stack-proof-of-concept.md).

### Rendering many terminals at once

There is no official pattern, but the architecture falls out of the constraints:

| Tier                         | Where                    | Cost                                                  | When                                           |
| ---------------------------- | ------------------------ | ----------------------------------------------------- | ---------------------------------------------- |
| Headless VT, one per session | werk daemon              | Cheap, always current                                 | Always — source of truth regardless of viewers |
| **Static snapshot tile**     | Browser grid             | Very cheap — a text blob or one canvas paint per push | **Every tile in the fleet overview**           |
| Live libghostty, canvas      | Browser, focused session | Moderate — ghostty-web's renderer is canvas           | Default for the expanded session               |
| Live libghostty, WebGL       | Browser, focused session | Cheapest live option, if a WebGL renderer gets built  | Later, and only if canvas proves insufficient  |

**List view = cheap static; detail view = expensive live.** Virtualise the grid
once session count reaches dozens.

One wrinkle specific to werk: because sessions run on remote machines and in
containers, "N live terminals" is a **fan-in transport** problem before it is a
rendering one. That argues for hub-and-spoke — per-machine daemons → the `werk
serve` process (WS pub/sub, one topic per session) → browser tiles — rather than
the browser opening a connection per remote machine. Which is the same conclusion
[05 §A](05-control-surfaces.md) reached about the web server holding no session
state.

---

## 4. The server

`Bun.serve` alone covers the whole surface:

- **Native WebSocket pub/sub** — `ws.subscribe(topic)`, `server.publish(topic,
data)`, `subscriberCount`, per-message deflate, backpressure limits, auto-ping,
  configurable idle timeout. A direct fit for "broadcast one session's output to
  every subscribed tab" with **no Redis and no second pub/sub layer**.
- **Static routes and HTML imports** — `routes: { "/": indexHtml, "/api/x":
handler }`. `bun --hot` does on-demand bundling and HMR in dev; production
  precompiles to a manifest. No separate Vite dev server.
- **Embedding the frontend in the binary** — importing an `.html` entrypoint into
  a `Bun.serve` routes map auto-bundles its JS, CSS and assets into the
  executable. This is a documented recipe, not a hack, and **opencode ships its
  entire web UI this way** ([07 §8](07-packaging.md)).

Hono (v4.13.5) earns its weight only if the route count or middleware needs grow.
Elysia (v1.4.30) earns its weight only if we want its end-to-end typed client
(Eden) shared between the web frontend and the TUI — which is a real possibility
worth revisiting later, not now.

**SSE vs WebSocket**: the focused session needs bidirectional (keystrokes and
resize go back up), so WebSocket is required regardless. One WS per browser tab
with N topic subscriptions is simplest; don't run two transports.

---

## 5. Frontend

| Framework    | Version | Fit for "small, offline, embedded, desktop later"                                                                                                                   |
| ------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Svelte 5** | v5.57.0 | Compiles the framework away — smallest shipped JS. Runes (`$state`, `$derived`) suit "many independently-updating live widgets" far better than re-rendering a tree |
| **SolidJS**  | v1.9.15 | Fine-grained reactivity, no VDOM, React-like JSX. **Arguably the best technical fit** for N tiles updating at different rates. Smaller ecosystem is the cost        |
| React        | —       | Largest ecosystem, heaviest runtime. **The real argument for it is Ink**: if the TUI is React, business-logic hooks and the mental model are shared with the web    |
| Vue          | —       | Middle ground, no compelling edge here                                                                                                                              |

That React synergy is not nothing — one team, one model, potentially shared
hooks. It is a legitimate trade against bundle size, not a clear loss.

| Styling         | Notes                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tailwind v4** | CSS-first config (`@theme` in CSS, no JS config file), ~5× faster builds, native cascade layers and container queries. Compiles to plain CSS in the binary — no CDN   |
| **shadcn/ui**   | **Copy-paste, not a dependency.** Code lives in your repo, zero runtime cost beyond what you use, nothing to embed. Ideal under a binary-size constraint. React-first |
| Radix           | Mature, React-only, low-churn — what shadcn is built on                                                                                                               |
| Base UI         | By people from Radix, Floating UI and MUI. Claims to fix Radix's gaps (combobox, autocomplete). Worth evaluating as the substrate                                     |
| **Ark UI**      | **The only framework-agnostic option** — same headless API for React, Vue, Solid and Svelte. Matters if we want to keep the framework choice reversible               |

### Design references worth stealing from, concretely

| Reference         | The specific idea                                                                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Warp**          | Command-palette-first navigation. And the **"blocks" model** — each command plus its output as a discrete, collapsible, individually-copyable unit. Directly applicable to a per-agent-turn view, since an agent turn is naturally block-shaped |
| **Raycast**       | Fuzzy-searchable list with a live-updating right-hand detail pane, keyboard-only start to finish. A literal template for "jump to any session on any machine"                                                                                   |
| **Linear**        | **Status as a small coloured ring or segment icon, not a pill badge** — encodes category and progress at a glance. Sub-second optimistic updates over websockets                                                                                |
| **GitHub Primer** | Octicon-style state icons and the **colour-plus-icon, never colour alone** convention. Important: werk's states must be distinguishable without colour                                                                                          |
| **Vercel**        | Deployment-list-with-inline-live-log-tail — click a row, the log streams in without navigating away. The direct analogue of "click a session row, the terminal streams in"                                                                      |
| **Zed**           | Not a usable stack (bespoke Rust GPU renderer) but the right _register_: minimal chrome, everything reachable from a palette, subtle status accents                                                                                             |

---

## 6. Desktop, later

**Bun has no desktop story.** Verified through the Bun 1.4 release: the only
GUI-adjacent API is `Bun.WebView`, which is **headless browser automation** — a
Puppeteer replacement, not a windowed app framework. That settles it.

| Shell        | Baseline      | Bun backend reuse                                                                                                                                                                                                                                                                                 |
| ------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tauri v2** | ~3–10 MB core | **Confirmed fit.** [Sidecar docs](https://tauri.app/develop/sidecar/) support bundling an arbitrary external binary named per target triple, declared in `bundle.externalBin`, spawned via the Shell plugin. A `--compile`'d werk binary is a textbook case — Tauri doesn't care what produced it |
| Electron     | ~150–200 MB   | Same sidecar pattern works, but you pay for two runtimes unless the renderer talks to the Bun sidecar over HTTP/WS — which is realistic, since that server already exists                                                                                                                         |
| Wails        | ~10–15 MB     | Go host. Awkward two-backend story                                                                                                                                                                                                                                                                |
| Neutralino   | ~5 MB         | Plausible for a pure sidecar model; much smaller community                                                                                                                                                                                                                                        |

**Two real costs of the Tauri path:**

1. **Size is dominated by the sidecar**, not by Tauri. Tauri's core is ~600 KB–few
   MB; the Bun binary is 100 MB+.
2. **macOS signing**: Apple's notarisation scans **every executable in the
   bundle**, so the sidecar must be signed and notarised separately. This is real
   added CI complexity on top of the already-fragile signing story in
   [07 §5](07-packaging.md). **Get a real timing estimate before assuming it's a
   line item.**

Comparable stacks: **Wave Terminal** is React/TS + a Go backend in Electron
(22.2k★). **vibe-kanban** is a Rust/SQLx backend with a Node frontend — and is
being sunset, so treat as a design reference, not a dependency.

**Given the plan is web now, desktop later**, the desktop app's job reduces to:
bundle the compiled binary as a sidecar, point the webview at
`http://127.0.0.1:<port>` — the same frontend the browser already gets — and add
native-only affordances (tray, notifications, autostart) in Rust. **That reuses
100% of the web work with no desktop-specific UI codebase**, which is exactly
what [`../product/03-surfaces.md`](../product/03-surfaces.md) asks for: keep the
web UI talking to a documented API over a configurable base URL, and the desktop
app is packaging rather than a rewrite.

---

## 7. Multi-machine information architecture

> Lower confidence on specifics, high confidence on the pattern — this section
> leans on documented UIs rather than a fresh teardown. Worth a pass with real
> screenshots before locking the IA.

| Tool                            | The pattern                                                                                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Portainer**                   | **Groups by environment/endpoint first**, then by container. Directly analogous: machine is the top-level key, sessions nest under it                                                                |
| Coder / Gitpod                  | Flat filterable table (owner, template, status, last-used), status as an inline coloured pill. A workspace needing action gets an **inline action button**, not a separate "needs attention" section |
| **lazydocker / lazygit**        | **List pane + detail pane**, fully keyboard-driven. The exact shape for werk's TUI                                                                                                                   |
| **k9s**                         | Adds a **`:`-prefixed command bar** (vim-style) on top of the list/detail split                                                                                                                      |
| Grafana / Netdata / Uptime Kuma | Grid of small status tiles, **failing items floated to the top** with a distinct border                                                                                                              |
| Conductor / vibe-kanban         | Organise by **workspace as the unit**, not by machine. vibe-kanban's kanban-by-stage is a distinct alternative IA                                                                                    |

**The synthesis: two orthogonal groupings both matter.** Portainer argues for
machine as the primary tree; Grafana argues for a status-sorted flat view. Offer
both as a toggle, in both surfaces, over the same set.

A concrete IA to prototype against:

| Element     | TUI                                                                                                                                                | Web                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Primary nav | Left pane, flat list, **sorted needs-attention-first by default**; `g` toggles group-by-machine                                                    | Same toggle as a segmented control, **URL-addressable** (`/?group=machine`) so a link is shareable |
| Status      | Coloured glyph column — `●` running, `◐` waiting on you, `✕` errored, `○` done. Avoid 256-colour-only distinctions; ssh sessions clip colour depth | Coloured ring plus a text label. **Never colour alone**                                            |
| Attention   | Sorts to top **and** gets a highlighted row. Never a separate notifications pane the user has to remember to open                                  | Same, plus a persistent header badge ("3 need you") visible regardless of scroll or view           |
| Detail      | Right pane on selection (`j`/`k`+`Enter`, or `1`–`9`). Live terminal takes the pane                                                                | Expand inline (Vercel-style) or route to `/session/:id`                                            |
| Commands    | `:`-prefixed bar (k9s) — `:ssh`, `:kill`, `:restart`                                                                                               | `Cmd+K` palette mirroring **the same verbs**, so muscle memory transfers                           |
| Machines    | Collapsible tree headers with a reachability dot                                                                                                   | Collapsible section headers                                                                        |

That last row matters more than it looks: **the same verbs in both palettes** is
what makes the TUI and the web feel like one product rather than two.

---

## 8. Notifications

| Channel                                                                                      | Setup                                                                                                   | Time to first alert | Verdict                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **[ntfy.sh](https://ntfy.sh)**                                                               | Pick a topic, subscribe in the app. `curl -d "message" ntfy.sh/mytopic` — no signup, topic auto-created | **~2 min**          | **The default.** Near-zero setup, native iOS/Android apps, self-hostable later. A `werk notify` subcommand is a same-day feature                                                                                                                                         |
| ntfy self-hosted                                                                             | Single Go binary or a Docker image                                                                      | ~15 min             | The privacy answer                                                                                                                                                                                                                                                       |
| Pushover                                                                                     | $5 one-time, API token + user key                                                                       | ~5 min              | Paid reliability if wanted                                                                                                                                                                                                                                               |
| Telegram bot                                                                                 | BotFather + capture a chat ID                                                                           | ~5–10 min           | Free, ubiquitous, more friction                                                                                                                                                                                                                                          |
| **Slack / Discord webhook**                                                                  | Create an incoming webhook                                                                              | ~3 min              | **The team channel option** — a different use case from personal phone alerting. Offer as additional, not primary                                                                                                                                                        |
| OS-native (`node-notifier` v10.0.1, or shell out to `notify-send`/`terminal-notifier`/toast) | none                                                                                                    | 0 min               | **Only reaches you at that machine — doesn't solve the actual failure mode at all.** A nice-to-have, not the answer                                                                                                                                                      |
| **Web Push**                                                                                 | —                                                                                                       | —                   | **Skip it.** The Push API needs a secure context; localhost is exempt but **LAN IPs generally are not** — and werk's web UI is explicitly meant to be reached across machines, usually at a LAN or VPN address. Not worth the HTTPS friction for what ntfy solves better |

Shelling out directly rather than depending on `node-notifier` is a reasonable
call given werk is already OS-detecting for everything else, and it keeps one
more dependency out of the binary.

This lines up with [`../product/03-surfaces.md`](../product/03-surfaces.md):
**one good outbound webhook plus a documented recipe** beats building
integrations. werk running push infrastructure is a different company.

---

## Open questions

1. **`Bun.Terminal` inside `--compile`.** The first spike, before any framework
   bake-off. Everything else is moot without it.
2. **OpenTUI's prebuilt Zig binaries inside `--compile`** — does `--asset` pick
   them up cleanly, or is per-platform handling needed?
3. **Does anything support a live terminal _inside_ a TUI frame?** Nothing found.
   Assume we build it on headless VT state and a custom cell renderer, and spike
   it before choosing between Ink and OpenTUI.
4. **How much of ghostty-web survives a rebase onto upstream `tip`?** If the
   answer is the shell and none of the internals, the renderer is werk's own
   from the start and should be sized as such. Whether Coder itself has adopted
   it in production is the other useful signal.
5. **Tauri sidecar signing cost** for a 100 MB+ Bun binary. Get a real number.
6. **SSE vs one-WS-with-topics at scale** — dozens of machines × dozens of
   sessions. No load data found either way.
7. Get real screenshots of Coder's and Conductor's dashboards before locking the
   IA in §7.

## Sources

Verified against the npm registry and vendor docs. The ones to read:
[Bun HTTP/WS docs](https://bun.sh/docs/api/http) ·
[Tauri sidecar](https://tauri.app/develop/sidecar/) ·
[OpenTUI](https://github.com/sst/opentui) ·
[ghostty-web](https://github.com/coder/ghostty-web) ·
[Ink](https://github.com/vadimdemedes/ink) ·
plus Lip Gloss, Ratatui and Textual for the "snazzy" bar.
