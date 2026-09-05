import {
  connectSessionClient,
  type Attachment,
  type SessionInfo,
} from "@werk/session";
import {
  createTerminalEngine,
  createTerminalReplica,
  encodeKey,
  type RendererFactory,
  type TerminalReplica,
} from "@werk/terminal";
import { createWtermRenderer } from "@werk/terminal/dom";
import { openWebSocketTransport } from "./websocket.js";
const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const status = element("status"),
  screen = element("screen");
const report = (error: unknown) => {
  status.textContent = error instanceof Error ? error.message : String(error);
};
const run = (operation: () => Promise<unknown>) => {
  void operation().catch(report);
};
const token = (
  document.querySelector('meta[name="bridge-token"]') as HTMLMetaElement
).content;
const transport = await openWebSocketTransport(
  `${location.origin.replace(/^http/, "ws")}/connect?token=${encodeURIComponent(token)}`,
);
const client = await connectSessionClient({
  transport,
  credential:
    decodeURIComponent(
      (
        document.querySelector(
          'meta[name="daemon-credential"]',
        ) as HTMLMetaElement
      ).content,
    ) || undefined,
  onCallbackError: report,
});
const wasm = await fetch("./terminal.wasm");
if (!wasm.ok) throw new Error("Terminal asset missing");
const engine = await createTerminalEngine(
  new Uint8Array(await wasm.arrayBuffer()),
);
let attachment: Attachment | undefined,
  replica: TerminalReplica | undefined,
  selected: string | undefined;
let sessions: SessionInfo[] = [];
let busy = false;
async function refresh() {
  sessions = await client.list();
  const list = element<HTMLSelectElement>("sessions");
  const prior = list.value;
  list.replaceChildren(
    ...sessions.map((session) => {
      const option = document.createElement("option");
      option.value = session.id;
      option.textContent = `${session.name} · ${session.state} · ${session.attachments.length} viewers`;
      return option;
    }),
  );
  if (sessions.some((session) => session.id === prior)) list.value = prior;
}
async function detach() {
  await attachment?.detach();
  attachment = undefined;
  replica?.dispose();
  replica = undefined;
  screen.replaceChildren();
  selected = undefined;
}
async function attach(sessionId: string) {
  if (busy) return;
  busy = true;
  try {
    await detach();
    selected = sessionId;
    let factory: RendererFactory = createWtermRenderer;
    if (element<HTMLSelectElement>("renderer").value === "beamterm") {
      const module = await import("@werk/terminal-beamterm");
      factory = module.beamtermRenderer({
        wasmUrl: new URL("./beamterm_renderer_bg.wasm", location.href).href,
      });
    }
    const renderer = await factory({ mount: screen });
    const currentReplica = createTerminalReplica(engine, renderer);
    replica = currentReplica;
    attachment = await client.attach(sessionId, {
      permissions: { read: true, input: true },
      onEvent(event) {
        if (event.type === "ended") {
          status.textContent = `Attachment ended: ${event.reason}`;
          return;
        }
        void currentReplica.apply(event).catch(report);
      },
    });
    status.textContent = `Attached as ${attachment.principal.id}. ${attachment.holdsSize ? "You hold terminal size." : "Following shared size."}`;
    screen.focus();
  } catch (error) {
    replica?.dispose();
    replica = undefined;
    throw error;
  } finally {
    busy = false;
  }
}
element("attach").onclick = () =>
  run(() => attach(element<HTMLSelectElement>("sessions").value));
element("detach").onclick = () => run(detach);
element("renderer").onchange = () => {
  if (selected) run(() => attach(selected!));
};
element("create").onclick = () =>
  run(async () => {
    const argv = JSON.parse(element<HTMLInputElement>("argv").value);
    if (
      !Array.isArray(argv) ||
      !argv.length ||
      !argv.every((value) => typeof value === "string")
    )
      throw new Error("Command must be a non-empty JSON string array");
    const session = await client.create({
      argv,
      name: element<HTMLInputElement>("name").value || undefined,
      size: { cols: 80, rows: 24 },
      labels: { consumer: "session-web" },
    });
    await refresh();
    await attach(session.id);
  });
element("resize").onclick = () =>
  run(async () => {
    if (!attachment) throw new Error("Attach first");
    await attachment.resize({
      cols: Number(element<HTMLInputElement>("cols").value),
      rows: Number(element<HTMLInputElement>("rows").value),
    });
  });
element("terminate").onclick = () =>
  run(async () => {
    await client.terminate(element<HTMLSelectElement>("sessions").value);
  });
screen.addEventListener("keydown", (event) => {
  if (!attachment || event.metaKey || event.altKey) return;
  if (
    event.key.length !== 1 &&
    ![
      "Enter",
      "Backspace",
      "Escape",
      "Tab",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
    ].includes(event.key)
  )
    return;
  event.preventDefault();
  const bytes =
    event.ctrlKey && event.key.length === 1
      ? new Uint8Array([event.key.toUpperCase().charCodeAt(0) & 31])
      : encodeKey(event.key);
  run(() => attachment!.writeInput(bytes));
});
screen.addEventListener("paste", (event) => {
  if (!attachment) return;
  event.preventDefault();
  run(() =>
    attachment!.writeInput(
      new TextEncoder().encode(event.clipboardData?.getData("text") ?? ""),
    ),
  );
});
let refreshQueued = false;
const stop = client.watch(() => {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => {
    refreshQueued = false;
    run(refresh);
  }, 50);
});
await stop.ready;
await refresh();
status.textContent = `Connected to ${client.daemon.id}`;
void client.closed.then(() => {
  status.textContent =
    "Connection closed. Reload to reconnect; sessions continue in the daemon.";
});
window.addEventListener("pagehide", () => {
  stop();
  replica?.dispose();
  void client.close();
});
