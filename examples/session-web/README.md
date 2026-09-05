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
falls back to source or the PoC. Asset pins and licences live with their packages.

`bun run --cwd examples/session-web test` checks origin/token refusal and a real
WebSocket-to-local-socket session protocol exchange. Browser visual validation is
covered by the workspace packaged-consumer checks when a browser is available.
