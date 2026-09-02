# web

`wp serve` (M4): a loopback web UI over the daemon, and the browser page
that runs the daemon's own emulator as a replica.

| File                              | What it is                                                                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.ts`                       | `Bun.serve` on 127.0.0.1: the one-time token → cookie, the session list, the terminal page, `/wasm`, `/app.js`, and one WebSocket per open terminal (a snapshot-mode attach) |
| `pages.ts`                        | The two pages as strings                                                                                                                                                     |
| `wire.ts`                         | What crosses the WebSocket: tagged binary (output / snapshot), JSON notices and commands, the per-socket stats. Shared by server and page                                    |
| `build.ts`                        | `Bun.build` of `client/main.ts` for the browser into `bundle/app.js`; `bun run build:web`                                                                                    |
| `bundle/app.d.ts`                 | Lets tsc resolve the server's `import ... with { type: "text" }` of the bundle; `app.js` itself is built, not committed                                                      |
| `client/main.ts`                  | The page: fetch `/wasm`, open the socket, decode, render, keys and mouse through the WASM encoders, resize, status line, `window.__wp` for measurements                      |
| `client/replica.ts`               | The Bun-free core: the two-stage decode, live output, one render consumer; driven by the page and by `server.test.ts` without a DOM                                          |
| `client/renderer.ts`              | The `Renderer` interface and the minimal canvas renderer behind it                                                                                                           |
| `client/renderer-ghostty-web.ts`  | ghostty-web's canvas renderer rebased onto `Frame`, behind the same interface; `?renderer=ghostty-web` selects it. MIT, Copyright (c) 2025 Coder                             |
| `client/selection-ghostty-web.ts` | ghostty-web's mouse selection rebased: the drag state machine kept, the text taken from libghostty's selection formatter. Used with the renderer above                       |
| `client/input.ts`                 | DOM key/mouse/wheel events to the seam's `KeyEvent` / `MouseEvent`                                                                                                           |
| `client/tsconfig.json`            | The browser files typecheck with the DOM lib and without `bun-types`, which is what keeps them Bun-free                                                                      |

`findings/m4.md` records what was built and measured.
