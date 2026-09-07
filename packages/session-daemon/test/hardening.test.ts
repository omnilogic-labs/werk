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
    await until(async () => {
      await fastApply;
      await slowApply;
      const screen = await t.client.readScreen(session.id);
      return (
        fastReplica.readScreen() === screen &&
        slowReplica.readScreen() === screen
      );
    });
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
    expect(events.filter((e) => e.type === "resync")).toHaveLength(0);
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
  factory.create = async (size, options) => {
    const terminal = await real.create(size, options),
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
      scrollback: () => terminal.scrollback(),
      formatScreen: (format) => terminal.formatScreen(format),
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
  const engine = await loadTerminalEngine();
  const t = await fixture({
    limits: { maxFrameBytes: 2048 },
    engineFactory: {
      ...engine,
      async create(size, options) {
        const terminal = await engine.create(size, options);
        const snapshot = terminal.snapshot.bind(terminal);
        terminal.snapshot = () => ({
          ...snapshot(),
          bytes: new Uint8Array(4096),
        });
        return terminal;
      },
    },
  });
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

test("fleet watch tracks grants, size ownership, resize and removal without attaching", async () => {
  const t = await fixture({
    authorize(principal, action, session) {
      if (principal.id === "fleet")
        return action === "list" && session?.labels.visibility !== "private";
      if (principal.id === "reader" && action === "attach")
        return { read: true, input: false };
      return true;
    },
  });
  const fleetPipe = duplex(),
    readerPipe = duplex();
  t.daemon.accept(fleetPipe.server, { id: "fleet" });
  t.daemon.accept(readerPipe.server, {
    id: "reader",
    displayName: "Read Only",
  });
  const fleet = await connectSessionClient({ transport: fleetPipe.client });
  const reader = await connectSessionClient({ transport: readerPipe.client });
  const events: import("@werk/session").DaemonEvent[] = [];
  const rows = new Map<string, import("@werk/session").SessionInfo>();
  const runningRows = new Map<string, import("@werk/session").SessionInfo>();
  // A fleet may apply the same label/state predicates used for its initial list.
  for (const row of await fleet.list({ labels: { team: "alpha" } }))
    rows.set(row.id, row);
  const stop = fleet.watch((event) => {
    events.push(event);
    if (event.type === "removed" || event.session?.labels.team !== "alpha") {
      rows.delete(event.sessionId);
      runningRows.delete(event.sessionId);
    } else if (event.session) {
      rows.set(event.sessionId, event.session);
      if (event.session.state === "running")
        runningRows.set(event.sessionId, event.session);
      else runningRows.delete(event.sessionId);
    }
  });
  try {
    await stop.ready;
    const hidden = await t.client.create({
      argv: shellArgv,
      size: { cols: 40, rows: 10 },
      labels: { team: "alpha", visibility: "private" },
    });
    const other = await t.client.create({
      argv: shellArgv,
      size: { cols: 40, rows: 10 },
      labels: { team: "beta" },
    });
    const session = await t.client.create({
      argv: shellArgv,
      size: { cols: 40, rows: 10 },
      labels: { team: "alpha" },
    });
    await until(() => rows.has(session.id));
    expect(rows.size).toBe(1);
    expect(events.some((e) => e.sessionId === hidden.id)).toBe(false);
    expect(rows.has(other.id)).toBe(false);
    await expect(fleet.get(hidden.id)).rejects.toThrow("refused");
    const a = await t.client.attach(session.id, {
      permissions: { read: true, input: true },
      onEvent() {},
    });
    const b = await reader.attach(session.id, {
      holdSize: "if-free",
      onEvent() {},
    });
    await until(() => rows.get(session.id)?.attachments.length === 2);
    expect(
      rows.get(session.id)!.attachments.find((x) => x.id === b.id),
    ).toMatchObject({
      principal: { id: "reader", displayName: "Read Only" },
      permissions: { read: true, input: false },
      representation: "snapshot",
      holdSize: "if-free",
      holdsSize: false,
    });
    expect(
      rows.get(session.id)!.attachments.find((x) => x.id === a.id),
    ).toMatchObject({ representation: "snapshot", holdSize: "if-free" });
    await a.transferSize(b.id);
    await until(() =>
      events.some(
        (e) =>
          e.type === "attachments-updated" &&
          e.session?.attachments.some((x) => x.id === b.id && x.holdsSize),
      ),
    );
    expect(
      rows.get(session.id)!.attachments.find((x) => x.id === a.id)!.holdsSize,
    ).toBe(false);
    await b.resize({ cols: 61, rows: 17 });
    await until(() => rows.get(session.id)?.size.cols === 61);
    await b.detach();
    await until(() => rows.get(session.id)?.attachments.length === 1);
    expect(rows.get(session.id)!.attachments[0]!.holdsSize).toBe(true);
    // Only a viewer that never takes the size remains, so nobody holds it.
    const tile = await reader.attach(session.id, { onEvent() {} });
    await a.detach();
    await until(() => rows.get(session.id)?.attachments.length === 1);
    expect(rows.get(session.id)!.attachments[0]).toMatchObject({
      id: tile.id,
      holdSize: "never",
      holdsSize: false,
    });
    await tile.detach();
    await until(() => rows.get(session.id)?.attachments.length === 0);
    await t.client.terminate(session.id, "force");
    await until(() => rows.get(session.id)?.state === "exited");
    expect(runningRows.has(session.id)).toBe(false);
    await t.client.remove(session.id);
    await until(() => !rows.has(session.id));
    expect(
      events.some((e) => e.type === "removed" && e.sessionId === session.id),
    ).toBe(true);
    expect(events.some((e) => e.sessionId === hidden.id)).toBe(false);
    expect((await fleet.list({ labels: { team: "alpha" } })).length).toBe(0);
  } finally {
    stop();
    await reader.close();
    await fleet.close();
    await t.close();
  }
});

test("environment limits reject before terminal allocation", async () => {
  const factory = await loadTerminalEngine();
  let allocations = 0;
  const t = await fixture({
    engineFactory: {
      ...factory,
      create: async (...args: Parameters<typeof factory.create>) => {
        allocations++;
        return factory.create(...args);
      },
    },
  });
  try {
    for (const env of [
      { KEY: "x".repeat(128 * 1024 + 1) },
      { "a=b": "value" },
    ]) {
      await expect(
        t.client.create({ argv: shellArgv, size: { cols: 80, rows: 24 }, env }),
      ).rejects.toMatchObject({ code: "LIMIT" });
    }
    await expect(
      t.client.create({
        argv: shellArgv,
        size: { cols: 80, rows: 24 },
        env: { KEY: 4 } as any,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(allocations).toBe(0);
  } finally {
    await t.close();
  }
});

test("native sessions receive caller environment without persisting secrets", async () => {
  const previous = process.env.SESSION_TEST_STALE_ENV;
  process.env.SESSION_TEST_STALE_ENV = "daemon-only";
  const t = await fixture();
  try {
    const output = join(t.dir, "environment.json");
    const session = await t.client.create({
      argv: [
        process.execPath,
        "-e",
        "await Bun.write(process.argv[1], JSON.stringify(process.env))",
        output,
      ],
      cwd: t.dir,
      size: { cols: 80, rows: 24 },
      env: { CALLER_SECRET: "fresh-private-value", TERM: "wrong" },
    });
    await until(
      async () => (await t.client.get(session.id)).state === "exited",
    );
    const env = JSON.parse(await readFile(output, "utf8"));
    expect(env.CALLER_SECRET).toBe("fresh-private-value");
    expect(env.SESSION_TEST_STALE_ENV).toBeUndefined();
    expect(env.TERM).toBe("xterm-256color");
    expect(env.WERK_SESSION).toBe(session.id);
    await t.daemon.close();
    for (const name of await readdir(t.config.stateDir)) {
      const text = await readFile(join(t.config.stateDir, name), "utf8");
      expect(text).not.toContain("fresh-private-value");
    }
  } finally {
    if (previous === undefined) delete process.env.SESSION_TEST_STALE_ENV;
    else process.env.SESSION_TEST_STALE_ENV = previous;
    await t.close();
  }
});

test("large raw snapshots pass the default queues and honour client receive caps", async () => {
  const engine = await loadTerminalEngine();
  const snapshotBytes = new Uint8Array(17 * 1024 * 1024);
  const t = await fixture({
    engineFactory: {
      ...engine,
      async create(size, options) {
        const terminal = await engine.create(size, options);
        const snapshot = terminal.snapshot.bind(terminal);
        terminal.snapshot = () => ({ ...snapshot(), bytes: snapshotBytes });
        return terminal;
      },
    },
  });
  const pipe = duplex();
  t.daemon.accept(pipe.server);
  const small = await connectSessionClient({
    transport: pipe.client,
    maxFrameBytes: 2048,
  });
  try {
    const session = await t.client.create({
      argv: shellArgv,
      size: { cols: 80, rows: 24 },
    });
    await expect(
      small.attach(session.id, { onEvent() {} }),
    ).rejects.toMatchObject({ code: "LIMIT" });
    expect((await t.client.get(session.id)).attachments).toHaveLength(0);
    let received = 0;
    await t.client.attach(session.id, {
      onEvent(event) {
        if (event.type === "snapshot") received = event.snapshot.byteLength;
      },
    });
    await until(() => received === snapshotBytes.byteLength);
    expect((await t.client.get(session.id)).attachments).toHaveLength(1);
  } finally {
    await small.close();
    await t.close();
  }
});

test.skipIf(process.platform !== "linux")(
  "abstract-socket fallback is exclusive when no libc can be loaded",
  async () => {
    const { acquireDaemonLock, libcCandidates } =
      await import("../src/platform/lock.js");
    expect(libcCandidates("linux", "x64")).toEqual([
      "libc.so.6",
      "libc.so",
      "libc.musl-x86_64.so.1",
    ]);
    expect(libcCandidates("darwin", "arm64")[0]).toBe("libSystem.B.dylib");
    const dir = await directory();
    const file = join(dir, "daemon.lock");
    const options = { libcCandidates: [] };
    const release = acquireDaemonLock(file, options);
    try {
      expect(release.mechanism).toBe("abstract-socket");
      expect(() => acquireDaemonLock(file, options)).toThrow("already running");
      const child = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `const { acquireDaemonLock } = await import(${JSON.stringify(
            join(import.meta.dir, "../src/platform/lock.ts"),
          )});
try { acquireDaemonLock(${JSON.stringify(file)}, { libcCandidates: [] })(); console.log("acquired"); }
catch (error) { console.log(String(error)); }`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(child.stdout.toString()).toContain("already running");
    } finally {
      release();
    }
    const again = acquireDaemonLock(file, options);
    expect(again.mechanism).toBe("abstract-socket");
    again();
    const kernel = acquireDaemonLock(file);
    expect(kernel.mechanism).toBe("flock");
    kernel();
    await rm(dir, { recursive: true, force: true });
  },
);

test("watch notifications coalesce per kind and drain before the exit", async () => {
  const t = await fixture({ limits: { notifyIntervalMs: 5000 } });
  try {
    const session = await t.client.create({
      argv: shellArgv,
      size: { cols: 80, rows: 24 },
    });
    const seen: AttachmentEvent[] = [];
    const a = await t.client.attach(session.id, {
      permissions: { read: true, input: true },
      onEvent: (event) => seen.push(event),
    });
    const daemonEvents: any[] = [];
    const stop = t.client.watch((event) => daemonEvents.push(event));
    await stop.ready;
    let script = "";
    for (let i = 1; i <= 20; i++) script += `\x1b]0;title-${i}\x07\x07`;
    await a.writeInput(encode(printCommand(script)));
    const kind = (events: any[], k: string) =>
      events.filter((e) => e.type === "effect" && e.effect.kind === k);
    await until(() => kind(seen, "title").length >= 10);
    await t.client.terminate(session.id, "force");
    await until(() => daemonEvents.some((e) => e.type === "exited"));
    // The attachment stream carries every effect; the watch stream carries the
    // leading edge and, because the window is longer than the test, whatever
    // the drain before `exited` still had pending.
    for (const k of ["title", "bell"]) {
      expect(kind(seen, k).length).toBeGreaterThanOrEqual(10);
      expect(kind(daemonEvents, k).length).toBeLessThanOrEqual(2);
      expect(kind(daemonEvents, k).at(-1)?.effect.payload).toEqual(
        kind(seen, k).at(-1)?.effect.payload,
      );
    }
    const activity = daemonEvents.filter((e) => e.type === "activity");
    expect(activity.length).toBeGreaterThanOrEqual(1);
    expect(activity.length).toBeLessThanOrEqual(2);
    const exited = daemonEvents.findIndex((e) => e.type === "exited");
    expect(exited).toBeGreaterThan(0);
    expect(
      daemonEvents
        .slice(exited)
        .some((e) => e.type === "effect" || e.type === "activity"),
    ).toBe(false);
    stop();
  } finally {
    await t.close();
  }
}, 15000);

test("a failing authorize callback is logged and hides no event from other watchers", async () => {
  const lines: Record<string, unknown>[] = [];
  const t = await fixture({
    log: {
      write: (level, event, fields) =>
        void lines.push({ level, event, ...fields }),
      close: () => {},
    },
    authorize(principal, action, session) {
      if (principal.id === "broken" && session)
        throw new Error("authorize exploded");
      if (principal.id === "refused" && session) return false;
      return true;
    },
  });
  const faulty = duplex();
  t.daemon.accept(faulty.server, { id: "broken" });
  const faultyClient = await connectSessionClient({ transport: faulty.client });
  const refused = duplex();
  t.daemon.accept(refused.server, { id: "refused" });
  const refusedClient = await connectSessionClient({
    transport: refused.client,
  });
  try {
    const faultyEvents: any[] = [];
    const stopFaulty = faultyClient.watch((event) => faultyEvents.push(event));
    await stopFaulty.ready;
    const refusedEvents: any[] = [];
    const stopRefused = refusedClient.watch((event) =>
      refusedEvents.push(event),
    );
    await stopRefused.ready;
    const events: any[] = [];
    const stop = t.client.watch((event) => events.push(event));
    await stop.ready;
    const session = await t.client.create({
      argv: shellArgv,
      size: { cols: 80, rows: 24 },
    });
    await until(() => events.some((e) => e.type === "created"));
    expect(faultyEvents).toEqual([]);
    expect(refusedEvents).toEqual([]);
    const internal = lines.filter((l) => l.event === "notify.internal");
    expect(internal.length).toBeGreaterThan(0);
    // A refusal is not an internal failure and must leave the log alone.
    expect(internal.every((l) => l.level === "error")).toBe(true);
    expect(internal.every((l) => l.principal === "broken")).toBe(true);
    expect(internal.every((l) => l.sessionId === session.id)).toBe(true);
    await t.client.terminate(session.id, "force");
    await until(() => events.some((e) => e.type === "exited"));
    stop();
    stopFaulty();
    stopRefused();
  } finally {
    await refusedClient.close();
    await faultyClient.close();
    await t.close();
  }
}, 15000);

test("a blocked tile skips preview frames instead of queueing them", async () => {
  const t = await fixture({
    limits: { previewIntervalMs: 60, previewMinIntervalMs: 50 },
  });
  const slow = duplex();
  t.daemon.accept(slow.server, { id: "tile" });
  const viewer = await connectSessionClient({ transport: slow.client });
  try {
    const session = await t.client.create({
      argv: shellArgv,
      size: { cols: 80, rows: 24 },
    });
    const terminal = await t.client.attach(session.id, {
      permissions: { read: true, input: true },
      onEvent: () => {},
    });
    const fastEvents: AttachmentEvent[] = [],
      slowEvents: AttachmentEvent[] = [];
    await t.client.attach(session.id, {
      representation: "preview",
      preview: { intervalMs: 50 },
      onEvent: (event) => fastEvents.push(event),
    });
    await viewer.attach(session.id, {
      representation: "preview",
      preview: { intervalMs: 50 },
      onEvent: (event) => slowEvents.push(event),
    });
    await until(() => fastEvents.length > 0 && slowEvents.length > 0);
    const held = slowEvents.length;
    slow.block();
    for (let i = 0; i < 20; i++) {
      await terminal.writeInput(encode(printCommand(`tick-${i}\n`)));
      await Bun.sleep(30);
    }
    await until(() => fastEvents.length >= held + 5);
    slow.unblock();
    await until(async () =>
      slowEvents.some((event) =>
        event.type === "preview" ? event.text.includes("tick-19") : false,
      ),
    );
    // The tile that could not keep up sees the newest screen, not the history
    // of every screen it missed: one frame in flight plus one in the slot.
    expect(slowEvents.length - held).toBeLessThanOrEqual(3);
    expect(fastEvents.length - held).toBeGreaterThan(4);
    // No preview viewer ever costs a snapshot, blocked or not.
    expect(
      [...fastEvents, ...slowEvents].every(
        (event) => event.type === "preview" || event.type === "ended",
      ),
    ).toBe(true);
    expect(slowEvents.map((event) => event.position)).toEqual(
      slowEvents.map((_, index) => index),
    );
  } finally {
    slow.unblock();
    await viewer.close();
    await t.close();
  }
}, 20000);

test("a real scrollback budget is capped, retained across a restart and restored on demand", async () => {
  const t = await fixture({
    limits: { scrollbackMaxBytes: 2_000_000, terminalIdleMs: 25 },
  });
  const size = { cols: 80, rows: 24 };
  const lines = 4000;
  try {
    expect(t.daemon.info.capabilities.scrollbackMaxBytes).toBe(2_000_000);
    await expect(
      t.client.create({ argv: shellArgv, size, scrollbackBytes: 2_000_001 }),
    ).rejects.toMatchObject({ code: "LIMIT" });
    const session = await t.client.create({
      argv: [
        process.execPath,
        "-e",
        `for (let i = 0; i < ${lines}; i++) process.stdout.write(String(i).padStart(6, "0") + " scrollback line\\r\\n")`,
      ],
      size,
    });
    expect(session.scrollbackBytes).toBe(2_000_000);
    await until(
      async () => (await t.client.get(session.id)).state === "exited",
    );
    // Page granularity keeps whole pages, so the retained count is an
    // estimate; four pages at 80 columns is far more than the two-page floor.
    const history = (await t.client.readHistory(session.id)).split("\n");
    expect(history.length).toBeGreaterThan(2000);
    expect(history.length).toBeLessThan(lines);
    await t.client.close();
    await t.daemon.close();
    const recovered = await createSessionDaemon(t.config);
    const pipe = duplex();
    recovered.accept(pipe.server, { id: "test-owner" });
    const client = await connectSessionClient({ transport: pipe.client });
    try {
      // The record comes back as bytes; nothing decodes them until asked.
      const record = await client.get(session.id);
      expect(record.state).toBe("exited");
      expect(record.scrollbackBytes).toBe(2_000_000);
      expect(record.checkpoint?.decodable).toBe(true);
      expect((await client.readHistory(session.id)).split("\n").length).toBe(
        history.length,
      );
      // Nothing is reading it any more, so the pages go back and the next read
      // decodes the checkpoint again.
      await Bun.sleep(60);
      expect((await client.readScreen(session.id)).length).toBeGreaterThan(0);
    } finally {
      await client.close();
      await recovered.close();
    }
  } finally {
    await t.close();
  }
}, 30000);
