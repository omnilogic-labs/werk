# Session browser example

## What this is

A single-page browser client for a running werk daemon. It imports the werk
packages the way an outside consumer would, through their published `exports`
entries rather than through source, so it proves those packages work from
outside the workspace.

The browser speaks `@werk/session/protocol` over a binary WebSocket to a bridge,
which relays it onto the daemon's local transport. Closing the page or the
bridge releases that page's attachments; the daemon keeps the sessions running.

## Running it

From the repository root, install and build the workspace packages, then:

```sh
bun run --cwd examples/session-web build
bun examples/session-web/dist/server.js /absolute/runtime/endpoint.json 4319
```

Open `http://127.0.0.1:4319`.

## What the page does

Enter command argv as a JSON array, for example `["/bin/sh"]` on POSIX or
`["powershell.exe"]` on Windows. Create or select a session, attach, and type or
paste in the focused terminal. The attachment holding the size may resize.

Listing uses `list` and daemon-wide `watch`, without opening terminal streams.

A **preview tile** is a small read-only text picture of a screen, refreshed on a
timer. The preview strip above the terminal holds one `preview` attachment per
listed session, delivering a text frame at most twice a second. A small
SGR-to-span converter turns each frame into markup, rather than a second
replica. So a page of tiles costs neither a terminal engine nor a snapshot per
update. Clicking a tile attaches the terminal to that session.

Switching renderer detaches and reattaches with a fresh replica. DOM is the
default; beamterm's JavaScript and WASM load only when it is selected.

## The access boundary

The bridge binds to `127.0.0.1`, validates the Host and WebSocket Origin, and
requires an unguessable launch token embedded in its local page. This is
explicitly a single-user owner bridge: anyone who can read its local page has
owner access. It is not a remote hosting or sharing policy. Daemon TCP
credentials are supplied to the authenticated local page when needed. Keep the
endpoint file private.

## What `dist` contains

- `index.html`, `style.css`, `palette.css`, `client.js` and its chunks: the page.
- `server.js` and `bridge.js`: the bridge.
- `terminal.wasm`, and `beamterm_renderer_bg.wasm` for the optional renderer.
- `terminal.PROVENANCE.md` and `terminal.LICENSE`.
- `beamterm.PROVENANCE.md` and `LICENSE.beamterm`.
- `LICENSE.wterm-dom`.

The build verifies the beamterm WASM digest against its pin. Keep the licence
and provenance files beside the copied assets.

Server static assets are resolved beside the built server. The bridge's Bun
bundle uses the installed public daemon and session package dependencies, and no
asset lookup falls back to source. To deploy the built bridge outside the
checkout, install the built public `@werk/session-daemon`, `@werk/session` and
`@werk/terminal` packages with their runtime dependencies. The browser assets
themselves are self-contained.

## Tests

`bun run test:browser` from the repository root builds the assets and checks
origin and token refusal, a real WebSocket-to-local-socket exchange, and
Chromium behaviour.

Install Playwright Chromium with `bunx playwright install chromium` from this
example, or set `CHROMIUM_PATH` to a Chromium executable. The browser test
copies the built assets and the runtime package allowlists to a temporary
directory outside the checkout.

It verifies attachment, application cursor keys, bracketed paste, resize, bridge
connection loss followed by reload recovery, and DOM to beamterm to DOM renderer
swaps. That includes actual coloured canvas pixels, a preserved shared screen and
size, and that the preview strip paints a coloured tile while holding no size.
