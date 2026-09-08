/**
 * Relaying "open this path" from a session to whoever is attached to it.
 *
 * Every case here needs two connections, and that is the shape of the thing
 * rather than an accident of the test: the process inside the session asks,
 * and a client somewhere else answers. A daemon holds a waiting request on the
 * connection that made it, so the connection that answers has to be a
 * different one — which is what a session and an attached terminal already
 * are, and what the daemon refuses outright when they are not.
 */
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  connectSessionClient,
  type AttachmentEvent,
  type SessionClient,
} from "@werk/session";
import { loadTerminalEngine } from "@werk/terminal/bun";
import {
  serveSessionDaemon,
  openLocalTransport,
  openPathValid,
  type DaemonConfig,
} from "../src/index";
import { shellArgv, endpointCredential } from "./commands.js";

async function setup(limits?: DaemonConfig["limits"]) {
  const dir = await mkdtemp(join(tmpdir(), "werk-open-"));
  const daemon = await serveSessionDaemon({
    runtimeDir: join(dir, "run"),
    stateDir: join(dir, "state"),
    version: "test",
    engineFactory: await loadTerminalEngine(),
    ...(limits ? { limits } : {}),
  });
  const clients: SessionClient[] = [];
  const connect = async () => {
    const client = await connectSessionClient({
      transport: await openLocalTransport(daemon.endpoint),
      credential: endpointCredential(daemon.endpoint),
    });
    clients.push(client);
    return client;
  };
  const session = await (
    await connect()
  ).create({
    argv: shellArgv,
    size: { cols: 80, rows: 24 },
  });
  return {
    dir,
    daemon,
    session,
    connect,
    /** The connection the session's own `werk edit` would be. */
    inside: clients[0]!,
    /** A path on this machine with the things a filename may hold in it. */
    file: resolve(dir, "a file 'with' quotes.txt"),
    async close() {
      for (const client of clients) await client.close();
      await daemon.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Attach on a connection of its own and collect what it is told. */
async function watcher(client: SessionClient, sessionId: string) {
  const events: AttachmentEvent[] = [];
  const attachment = await client.attach(sessionId, {
    permissions: { read: true, input: true },
    onEvent: (event) => void events.push(event),
  });
  return { attachment, events };
}
async function until(check: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition timed out");
}
const opens = (events: AttachmentEvent[]) =>
  events.filter((event) => event.type === "open");

test("nobody attached is a refusal rather than a wait", async () => {
  const t = await setup();
  try {
    await expect(t.inside.openPath(t.session.id, t.file)).rejects.toMatchObject(
      { code: "CONFLICT" },
    );
  } finally {
    await t.close();
  }
}, 20000);

test("the path reaches every attached client, whatever is in it", async () => {
  const t = await setup();
  try {
    const one = await watcher(await t.connect(), t.session.id);
    const two = await watcher(await t.connect(), t.session.id);
    const outcome = await t.inside.openPath(t.session.id, t.file);
    expect(outcome.attachments).toBe(2);
    expect(outcome.finished).toBe(false);
    await until(
      () => opens(one.events).length > 0 && opens(two.events).length > 0,
    );
    for (const events of [one.events, two.events])
      expect(opens(events)[0]).toMatchObject({
        type: "open",
        openId: outcome.openId,
        // The path arrives byte for byte: nothing quotes it, escapes it or
        // splits it on the way, because nothing on this path is a shell.
        path: t.file,
        wait: false,
      });
  } finally {
    await t.close();
  }
}, 20000);

test("a wait is held until the client that was asked answers", async () => {
  const t = await setup();
  try {
    const one = await watcher(await t.connect(), t.session.id);
    const held = t.inside.openPath(t.session.id, t.file, {
      wait: true,
      timeoutMs: 10_000,
    });
    await until(() => opens(one.events).length > 0);
    const event = opens(one.events)[0] as { openId: string };
    // Still waiting: nothing has answered yet.
    expect(
      await Promise.race([
        held.then(
          () => "answered",
          () => "refused",
        ),
        Bun.sleep(50),
      ]),
    ).toBeUndefined();
    // A connection that was not asked cannot end somebody else's wait.
    await expect(
      (await t.connect()).finishOpen(event.openId),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await one.attachment.detach();
    // Detaching ended the only attachment that was asked, so the wait is
    // refused rather than left running until the bound.
    await expect(held).rejects.toMatchObject({ code: "CONFLICT" });
  } finally {
    await t.close();
  }
}, 20000);

test("what the client reports comes back, failure and all", async () => {
  const t = await setup();
  try {
    const client = await t.connect();
    const one = await watcher(client, t.session.id);
    const held = t.inside.openPath(t.session.id, t.file, {
      wait: true,
      timeoutMs: 10_000,
    });
    await until(() => opens(one.events).length > 0);
    const event = opens(one.events)[0] as { openId: string };
    await client.finishOpen(event.openId, "code exited with status 1");
    expect(await held).toMatchObject({
      finished: true,
      attachments: 1,
      error: "code exited with status 1",
    });
    // The request is over, so the same answer a second time finds nothing.
    await expect(client.finishOpen(event.openId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  } finally {
    await t.close();
  }
}, 20000);

test("a client that goes away mid-wait ends the wait", async () => {
  const t = await setup();
  try {
    const client = await t.connect();
    const one = await watcher(client, t.session.id);
    const held = t.inside.openPath(t.session.id, t.file, {
      wait: true,
      timeoutMs: 10_000,
    });
    await until(() => opens(one.events).length > 0);
    // Not a detach: the whole connection goes, which is what a laptop closing
    // looks like from here.
    await client.close();
    await expect(held).rejects.toMatchObject({ code: "CONFLICT" });
  } finally {
    await t.close();
  }
}, 20000);

test("a wait is bounded, and the daemon says by how much", async () => {
  const t = await setup({ openWaitMs: 50 });
  try {
    expect((await t.inside.daemonInfo()).capabilities.openWaitMs).toBe(50);
    await watcher(await t.connect(), t.session.id);
    await expect(
      t.inside.openPath(t.session.id, t.file, {
        wait: true,
        timeoutMs: 10_000,
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  } finally {
    await t.close();
  }
}, 20000);

test("a connection cannot wait on its own attachment", async () => {
  const t = await setup();
  try {
    // One connection doing both would park its own request loop, so the answer
    // it is waiting for could never be read. Refused, rather than hung.
    await watcher(t.inside, t.session.id);
    await expect(
      t.inside.openPath(t.session.id, t.file, { wait: true }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // Without a wait there is nothing to read back, so it is allowed.
    expect((await t.inside.openPath(t.session.id, t.file)).attachments).toBe(1);
  } finally {
    await t.close();
  }
}, 20000);

test("a path the daemon cannot use is refused before anything is told", async () => {
  const t = await setup();
  try {
    await watcher(await t.connect(), t.session.id);
    for (const [path, code] of [
      ["", "INVALID_ARGUMENT"],
      ["relative/file.txt", "INVALID_ARGUMENT"],
      ["/tmp/a\0b", "INVALID_ARGUMENT"],
      [`/${"x".repeat(4096)}`, "LIMIT"],
    ] as const)
      await expect(t.inside.openPath(t.session.id, path)).rejects.toMatchObject(
        { code },
      );
  } finally {
    await t.close();
  }
}, 20000);

test("the path rule is a function, so a client can check its own input", () => {
  expect(() => openPathValid(resolve("/tmp", "a file.txt"))).not.toThrow();
  // A newline and a quote are legal in a filename and are not refused: what
  // makes the client safe is that it spawns rather than shells out.
  expect(() => openPathValid(resolve("/tmp", "a'b\nc"))).not.toThrow();
  for (const bad of ["", "b/c", 7, undefined, "/tmp/a\0b"])
    expect(() => openPathValid(bad)).toThrow();
});
