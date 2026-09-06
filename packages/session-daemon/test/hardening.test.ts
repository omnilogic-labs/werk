import {
  shellArgv,
  printCommand,
  floodCommand,
  endpointCredential,
} from "./commands.js";
import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectSessionClient, type AttachmentEvent } from "@werk/session";
import type { Transport } from "@werk/session/protocol";
import { loadTerminalEngine } from "@werk/terminal/bun";
import {
  createTerminalReplica,
  type TerminalEngineFactory,
  type TerminalHandle,
} from "@werk/terminal";
import {
  createSessionDaemon,
  serveSessionDaemon,
  openLocalTransport,
  resolveSessionDaemonPaths,
  type DaemonConfig,
} from "../src/index";
const encode = (text: string) => new TextEncoder().encode(text);
async function until(check: () => boolean | Promise<boolean>, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Condition timed out");
}
async function directory() {
  return mkdtemp(join(tmpdir(), "werk-hardening-"));
}
function duplex() {
  let a: ReadableStreamDefaultController<Uint8Array>,
    b: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let blocked = false,
    release: (() => void) | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    release?.();
    try {
      a.close();
    } catch {}
    try {
      b.close();
    } catch {}
  };
  const client: Transport = {
    readable: new ReadableStream({
      start(c) {
        a = c;
      },
    }),
    writable: new WritableStream({
      write(bytes) {
        if (closed) throw new Error("closed");
        b.enqueue(bytes);
      },
    }),
    close,
  };
  const server: Transport = {
    readable: new ReadableStream({
      start(c) {
        b = c;
      },
    }),
    writable: new WritableStream({
      async write(bytes) {
        if (blocked)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        if (closed) throw new Error("closed");
        a.enqueue(bytes);
      },
    }),
    close,
  };
  return {
    client,
    server,
    block() {
      blocked = true;
    },
    unblock() {
      blocked = false;
      release?.();
      release = undefined;
    },
  };
}
async function fixture(options: Partial<DaemonConfig> = {}) {
  const dir = await directory();
  const factory = await loadTerminalEngine();
  const config = {
    runtimeDir: join(dir, "run"),
    stateDir: join(dir, "state"),
    engineFactory: factory,
    ...options,
  };
  const daemon = await createSessionDaemon(config);
  const pipe = duplex();
  daemon.accept(pipe.server, { id: "test-owner" });
  const client = await connectSessionClient({ transport: pipe.client });
  return {
    dir,
    factory,
    config,
    daemon,
    client,
    async close() {
      await client.close();
      await daemon.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("real snapshots recover a blocked viewer while fast viewer and input continue", async () => {
  const t = await fixture({ limits: { outputQueueBytes: 4096 } });
  const slow = duplex();
  t.daemon.accept(slow.server, { id: "viewer" });
  const viewer = await connectSessionClient({ transport: slow.client });
  const fastReplica = createTerminalReplica(t.factory),
    slowReplica = createTerminalReplica(t.factory);
  const errors: unknown[] = [];
  let fastApply = Promise.resolve(),
    slowApply = Promise.resolve(),
    resyncs = 0;
  try {
    const session = await t.client.create({
      argv: shellArgv,
      size: { cols: 80, rows: 24 },
    });
    const fast = await t.client.attach(session.id, {
      permissions: { read: true, input: true },
      onEvent(event) {
        fastApply = fastReplica.apply(event).catch((e) => {
          errors.push(e);
        });
      },
    });
    await viewer.attach(session.id, {
      onEvent(event) {
        if (event.type === "resync") resyncs++;
        slowApply = slowReplica.apply(event).catch((e) => {
          errors.push(e);
        });
      },
    });
    await slowApply;
    slow.block();
    await fast.writeInput(encode(floodCommand()));
    await until(async () =>
      (await t.client.readScreen(session.id))
        .split("\n")
        .some((line) => line.trim() === "finished-stream"),
    );
    await fast.resize({ cols: 93, rows: 27 });
    await fast.writeInput(encode(printCommand("after-resize\n")));
    await until(async () =>
      (await t.client.readScreen(session.id))
        .split("\n")
        .some((line) => line.trim() === "after-resize"),
    );
    slow.unblock();
    await until(() => resyncs > 0);
    await Bun.sleep(100);
    await fastApply;
    await slowApply;
    expect(errors).toEqual([]);
    expect(slowReplica.readScreen()).toBe(
      await t.client.readScreen(session.id),
    );
    expect(fastReplica.readScreen()).toBe(slowReplica.readScreen());
    expect(slowReplica.frame()?.cols).toBe(93);
    await fast.detach();
    const replacement = createTerminalReplica(t.factory);
    let applied = Promise.resolve();
    const again = await t.client.attach(session.id, {
      onEvent(event) {
        applied = replacement.apply(event);
      },
    });
    await until(() => replacement.frame() !== undefined);
    await applied;
    expect(replacement.readScreen()).toBe(slowReplica.readScreen());
    await again.detach();
    replacement.dispose();
  } finally {
    slow.unblock();
    fastReplica.dispose();
    slowReplica.dispose();
    await viewer.close();
    await t.close();
  }
}, 15000);

test("effects remain ordered and replies are consumed inside daemon", async () => {
  const t = await fixture();
  const replica = createTerminalReplica(t.factory);
  const events: AttachmentEvent[] = [];
  const errors: unknown[] = [];
  let applied = Promise.resolve();
  try {
    const session = await t.client.create({
      argv: shellArgv,
      size: { cols: 70, rows: 20 },
    });
    const a = await t.client.attach(session.id, {
      permissions: { read: true, input: true },
      onEvent(e) {
        events.push(e);
        applied = replica.apply(e).catch((error) => {
          errors.push(error);
        });
      },
    });
    const daemonEvents: any[] = [];
    const stop = t.client.watch((e) => daemonEvents.push(e));
    await stop.ready;
    await a.writeInput(
      encode(printCommand("\x1b]0;daemon-title\x07\x07hello-effect\n")),
    );
    await until(() =>
      events.some((e) => e.type === "effect" && e.effect.kind === "title"),
    );
    await Bun.sleep(50);
    await applied;
    expect(errors).toEqual([]);
    expect(
      events.some((e) => e.type === "effect" && e.effect.kind === "bell"),
    ).toBe(true);
    expect(
      daemonEvents.some(
        (e) => e.type === "effect" && e.effect.kind === "title",
      ),
    ).toBe(true);
    expect(
      events.some((e) => e.type === "effect" && e.effect.kind === "reply"),
    ).toBe(false);
    expect((await t.client.get(session.id)).title).toBe("daemon-title");
    expect(replica.readScreen()).toBe(await t.client.readScreen(session.id));
    stop();
  } finally {
    replica.dispose();
    await t.close();
  }
});

test("engine write and snapshot faults end only their session; failed attach retains earlier grant", async () => {
  const real = await loadTerminalEngine();
  let created = 0,
    failNextSnapshot = false;
  const factory: TerminalEngineFactory = { ...real };
  factory.create = async (size) => {
    const terminal = await real.create(size),
      bad = created++ === 0;
    return {
      get size() {
        return terminal.size;
      },
      write(bytes) {
        if (bad && new TextDecoder().decode(bytes).includes("trigger-fault"))
          throw new Error("deliberate write fault");
        return terminal.write(bytes);
      },
      snapshot() {
        if (failNextSnapshot) {
          throw new Error("deliberate snapshot fault");
        }
        return terminal.snapshot();
      },
      resize: (s) => terminal.resize(s),
      readScreen: () => terminal.readScreen(),
      readHistory: () => terminal.readHistory(),
      frame: () => terminal.frame(),
      inputModes: () => terminal.inputModes(),
      viewport: () => terminal.viewport(),
      scrollViewport: (delta) => terminal.scrollViewport(delta),
      readSelection: (selection) => terminal.readSelection(selection),
      dispose: () => terminal.dispose(),
    };
  };
  const t = await fixture({ engineFactory: factory });
  try {
    const bad = await t.client.create({
      argv: shellArgv,
      size: { cols: 80, rows: 24 },
    });
    const good = await t.client.create({
      argv: shellArgv,
      size: { cols: 80, rows: 24 },
    });
    let ended = false;
    const a = await t.client.attach(bad.id, {
      permissions: { read: true, input: true },
      onEvent: (e) => {
        if (e.type === "ended") ended = true;
      },
    });
    const b = await t.client.attach(good.id, {
      permissions: { read: true, input: true },
      onEvent: () => {},
    });
    failNextSnapshot = true;
    await expect(
      t.client.attach(good.id, { onEvent: () => {} }),
    ).rejects.toThrow("snapshot fault");
    failNextSnapshot = false;
    expect((await t.client.get(good.id)).attachments).toHaveLength(1);
    await a.writeInput(encode(printCommand("trigger-fault\n")));
    await until(() => ended);
    expect((await t.client.get(bad.id)).state).toBe("failed");
    await b.writeInput(encode(printCommand("healthy-session\n")));
    await until(async () =>
      (await t.client.readScreen(good.id)).includes("healthy-session"),
    );
    expect((await t.client.get(good.id)).state).toBe("running");
  } finally {
    await t.close();
  }
});

test("mismatched and corrupt checkpoints remain byte-for-byte preserved with lost metadata", async () => {
  const t = await fixture();
  const session = await t.client.create({
    argv: shellArgv,
    size: { cols: 80, rows: 24 },
    name: "saved-name",
    labels: { project: "saved" },
  });
  await t.client.close();
  await t.daemon.close();
  const file = join(t.config.stateDir, `${session.id}.json`);
  const saved = JSON.parse(await readFile(file, "utf8"));
  saved.info.state = "running";
  saved.snapshot.engineBuild = "unknown-engine";
  const text = JSON.stringify(saved);
  await writeFile(file, text);
  await writeFile(join(t.config.stateDir, "corrupt.json"), "{broken");
  const recovered = await createSessionDaemon(t.config);
  const pipe = duplex();
  recovered.accept(pipe.server);
  const client = await connectSessionClient({ transport: pipe.client });
  try {
    const info = await client.get(session.id);
    expect(info.state).toBe("lost");
    expect(info.name).toBe("saved-name");
    expect(info.labels).toEqual({ project: "saved" });
    expect(info.checkpoint?.decodable).toBe(false);
    await expect(client.readScreen(session.id)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  } finally {
    await client.close();
    await recovered.close();
  }
  expect(await readFile(file, "utf8")).toBe(text);
  expect(await readFile(join(t.config.stateDir, "corrupt.json"), "utf8")).toBe(
    "{broken",
  );
  await rm(t.dir, { recursive: true, force: true });
});

test("invalid sizes and metadata refuse before allocation; cancelled attach keeps live session", async () => {
  const t = await fixture();
  try {
    for (const size of [
      { cols: 0, rows: 2 },
      { cols: 1000, rows: 1000 },
      { cols: NaN, rows: 20 },
    ])
      await expect(
        t.client.create({ argv: shellArgv, size }),
      ).rejects.toThrow();
    await expect(
      t.client.create({
        argv: shellArgv,
        size: { cols: 80, rows: 24 },
        labels: { invalid: 42 } as any,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await t.client.list()).toEqual([]);
    const session = await t.client.create({
      argv: shellArgv,
      size: { cols: 80, rows: 24 },
    });
    await expect(
      t.client.attach(session.id, {
        signal: AbortSignal.abort(),
        onEvent: () => {},
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect((await t.client.get(session.id)).attachments).toHaveLength(0);
  } finally {
    await t.close();
  }
});

test("malformed transport and hello timeout close resources without harming another connection", async () => {
  const t = await fixture({ limits: { helloTimeoutMs: 30 } });
  try {
    const malformed = duplex();
    t.daemon.accept(malformed.server);
    await malformed.client.writable
      .getWriter()
      .write(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    expect((await malformed.client.readable.getReader().read()).done).toBe(
      true,
    );
    const idle = duplex();
    t.daemon.accept(idle.server);
    expect((await idle.client.readable.getReader().read()).done).toBe(true);
    expect((await t.client.daemonInfo()).id).toBe(t.daemon.info.id);
  } finally {
    await t.close();
  }
});

test("kernel lock rejects concurrent ownership and failed startup releases it", async () => {
  const dir = await directory();
  const config = {
    runtimeDir: join(dir, "run"),
    stateDir: join(dir, "state"),
    engineFactory: await loadTerminalEngine(),
  };
  const first = await serveSessionDaemon(config);
  try {
    await expect(serveSessionDaemon(config)).rejects.toThrow("already running");
    const client = await connectSessionClient({
      transport: await openLocalTransport(first.endpoint),
      credential: endpointCredential(first.endpoint),
    });
    expect((await client.daemonInfo()).id).toBe(first.info.id);
    await client.close();
  } finally {
    await first.close();
  }
  const second = await serveSessionDaemon(config);
  await second.close();
  const broken = {
    ...config,
    runtimeDir: join(dir, "failed-start"),
    limits: { sessions: 0 },
  };
  await expect(serveSessionDaemon(broken)).rejects.toThrow();
  const paths = resolveSessionDaemonPaths(broken);
  expect(
    (await readdir(paths.runtimeDir)).filter((x) => x !== "daemon.lock"),
  ).toEqual([]);
  await rm(dir, { recursive: true, force: true });
});

test("bounded controls close a stalled connection and preserve its session", async () => {
  const t = await fixture({
    limits: {
      controlQueueBytes: 2048,
      controlQueueMessages: 8,
      outputQueueBytes: 4096,
    },
  });
  const stalled = duplex();
  t.daemon.accept(stalled.server);
  const client = await connectSessionClient({ transport: stalled.client });
  try {
    const session = await t.client.create({
      argv: shellArgv,
      size: { cols: 80, rows: 24 },
    });
    stalled.block();
    const requests = Array.from({ length: 30 }, () =>
      client.daemonInfo().catch(() => null),
    );
    await until(() => t.daemon.diagnostics().connections === 1);
    expect(t.daemon.diagnostics().controlQueueBytes).toBeLessThanOrEqual(2048);
    expect((await t.client.get(session.id)).state).toBe("running");
    stalled.unblock();
    await Promise.all(requests);
  } finally {
    stalled.unblock();
    await client.close();
    await t.close();
  }
});

test("wire snapshot limits refuse attachment before granting it", async () => {
  const t = await fixture({ limits: { maxFrameBytes: 2048 } });
  try {
    const session = await t.client.create({
      argv: shellArgv,
      size: { cols: 80, rows: 24 },
    });
    await expect(
      t.client.attach(session.id, { onEvent: () => {} }),
    ).rejects.toMatchObject({ code: "LIMIT" });
    expect((await t.client.get(session.id)).attachments).toHaveLength(0);
  } finally {
    await t.close();
  }
});
