# Session browser example

A local owner view using only public built library entries. The browser speaks
`@werk/session/protocol` through a binary WebSocket bridge to an already running
daemon. Closing the page or bridge releases attachments; the daemon keeps sessions.

From the repository root, install and build the workspace packages, then:

```sh
bun run --cwd examples/session-web build
bun examples/session-web/dist/server.js /absolute/runtime/endpoint.json 4319
```

Open `http://127.0.0.1:4319`. Enter command argv as a JSON array (for example
`["/bin/sh"]` on POSIX or `["powershell.exe"]` on Windows). Create or select a
session, attach, type or paste in the focused terminal. The size holder may resize.
The preview strip above holds one `preview` attachment per listed session: a text
frame at most twice a second, turned into markup by a small SGR-to-span converter
rather than a second replica, so a page of tiles costs neither a terminal engine
nor a snapshot per update. Clicking a tile attaches the terminal to that session.
Switching renderer detaches and reattaches with a fresh replica. DOM is the default;
beamterm's JS and WASM load only when selected. Listing uses `list` and daemon-wide
`watch` without opening terminal streams.

The bridge binds to `127.0.0.1`, validates the Host and WebSocket Origin, and requires
an unguessable launch token embedded in its local page. This is explicitly a
single-user owner bridge: anyone who can read its local page has owner access. It
is not a remote hosting or sharing policy. Daemon TCP credentials are supplied to
the authenticated local page when needed. Keep the endpoint file private.

`dist` contains the browser bundle, HTML/CSS, terminal WASM and optional beamterm
WASM; server static assets are resolved beside the built server. The bridge's Bun
bundle uses installed public daemon/session package dependencies. No asset lookup
falls back to source. The output includes `terminal.PROVENANCE.md`, `terminal.LICENSE`,
`beamterm.PROVENANCE.md`, `LICENSE.beamterm`, and `LICENSE.wterm-dom`; the build
verifies the beamterm WASM digest against its pin. Keep these beside copied assets.
To deploy the built bridge outside the checkout, install the built public
`@werk/session-daemon`, `@werk/session`, and `@werk/terminal` packages with their
runtime dependencies. The browser assets themselves are self-contained.

`bun run test:browser` from the root builds the assets and checks origin/token
refusal, a real WebSocket-to-local-socket exchange, and Chromium visual behavior.
Install Playwright Chromium (`bunx playwright install chromium` from this example)
or set `CHROMIUM_PATH` to a Chromium executable. The browser test copies the built
assets and runtime package allowlists to a temporary directory outside the checkout.
It verifies attachment, application cursor keys, bracketed paste, resize, bridge
connection loss followed by reload recovery, and DOM → beamterm → DOM swaps,
including actual coloured canvas pixels and preserved shared screen and size, and
that the preview strip paints a coloured tile while holding no size.
