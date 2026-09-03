// The two pages `wp serve` renders: the session list and the terminal
// page. Plain strings; no templating. The list refreshes itself from
// `/api/ls` every two seconds; the terminal page is a status line, a
// canvas, and the bundle.
//
// The bundle is a module script. `Bun.build` emits ESM, and the renderer
// adapters pull in glue that reads `import.meta.url`, which is a parse-time
// error in a classic script whether or not the line ever runs.

import { createRequire } from "node:module";
import type { SessionInfo } from "../protocol/index.ts";

// escape-html is CommonJS; createRequire is what pulls a `module.exports =`
// default into an ESM build without a synthetic-default flag.
const require = createRequire(import.meta.url);
const esc: typeof import("escape-html") = require("escape-html");

const CSS = `
  :root { color-scheme: dark; }
  body { margin: 0; background: #1e1e1e; color: #d4d4d4; font: 14px system-ui, sans-serif; }
  body.bell { background: #3a3a1e; }
  a { color: #9cdcfe; }
  header { padding: 8px 12px; background: #252526; border-bottom: 1px solid #3c3c3c; }
  table { border-collapse: collapse; margin: 12px; }
  th, td { text-align: left; padding: 4px 12px 4px 0; border-bottom: 1px solid #3c3c3c; font-family: ui-monospace, monospace; font-size: 13px; }
  th { color: #9d9d9d; font-weight: normal; }
  #status { padding: 4px 8px; background: #252526; border-bottom: 1px solid #3c3c3c; font: 12px ui-monospace, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; height: 16px; }
  #wrap { position: absolute; top: 25px; left: 0; right: 0; bottom: 0; overflow: hidden; }
  #term { display: block; outline: none; }
`;

export function age(since: number): string {
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function statusOf(s: SessionInfo): string {
  if (s.status === "exited") return `exited(${s.signalCode ?? s.exitCode})`;
  if (s.status === "corpse" && s.corpse?.reason === "mismatch")
    return `corpse(mismatch ${s.corpse.snapshotEngine.slice(0, 8)}/${s.corpse.daemonEngine.slice(0, 8)})`;
  return s.status;
}

export function listRows(sessions: SessionInfo[]): string {
  if (sessions.length === 0)
    return `<tr><td colspan="7">no sessions; start one with <code>wp run -- &lt;command&gt;</code></td></tr>`;
  return sessions
    .map(
      (s) =>
        `<tr><td><a href="/s/${encodeURIComponent(s.id)}">${esc(s.id)}</a></td>` +
        `<td>${esc(s.argv.join(" "))}</td><td>${esc(s.engine)}</td>` +
        `<td>${esc(statusOf(s))}</td><td>${esc(s.title)}</td>` +
        `<td>${age(s.createdAt)}</td><td>${s.attachedClients}</td></tr>`,
    )
    .join("");
}

export function listPage(
  sessions: SessionInfo[] | null,
  error?: string,
): string {
  const body =
    sessions === null
      ? `<tr><td colspan="7">daemon unreachable: ${esc(error ?? "")}</td></tr>`
      : listRows(sessions);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>wp serve</title><style>${CSS}</style></head>
<body>
<header>wp serve — sessions on this machine</header>
<table id="sessions"><thead><tr><th>id</th><th>command</th><th>engine</th><th>status</th><th>title</th><th>age</th><th>clients</th></tr></thead>
<tbody>${body}</tbody></table>
<script>
setInterval(async () => {
  try {
    const r = await fetch("/api/ls");
    if (!r.ok) return;
    document.querySelector("#sessions tbody").innerHTML = await r.text();
  } catch {}
}, 2000);
</script>
</body></html>`;
}

export function terminalPage(id: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>wp ${esc(id)}</title><style>${CSS}</style></head>
<body>
<div id="status">${esc(id)} loading…</div>
<div id="wrap"><canvas id="term" tabindex="0"></canvas></div>
<script type="module" src="/app.js"></script>
</body></html>`;
}
