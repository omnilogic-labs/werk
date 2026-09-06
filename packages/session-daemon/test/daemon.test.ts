import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSessionClient } from "@werk/session";
import {
  createSessionDaemon,
  serveSessionDaemon,
  openLocalTransport,
} from "../src/index";
import type { TerminalEngineFactory } from "@werk/terminal";
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
function engine(): TerminalEngineFactory {
  let allocated = 0;
  const factory: any = {
    buildId: "test",
    snapshotFormatVersion: 1,
    capabilities: { snapshot: true },
    allocated: () => allocated,
    async create(size: any) {
      allocated++;
      let screen = "",
        disposed = false;
      return {
        size,
        write(data: Uint8Array) {
          screen += decoder.decode(data);
          return [];
        },
        resize(next: any) {
          size = next;
        },
        snapshot() {
          return {
            engineBuild: "test",
            formatVersion: 1,
            size,
            bytes: encoder.encode(screen),
          };
        },
        readScreen() {
          return screen;
        },
        readHistory() {
          return screen;
        },
        dispose() {
          if (!disposed) {
            disposed = true;
            allocated--;
          }
        },
      };
    },
    async restore(snapshot: any) {
      if (snapshot.engineBuild !== "test") throw new Error("wrong build");
      const terminal = await factory.create(snapshot.size);
      terminal.write(snapshot.bytes);
      return terminal;
    },
  };
  return factory;
}
async function setup(authorize?: any) {
  const dir = await mkdtemp(join(tmpdir(), "werk-daemon-"));
  const engineFactory = engine();
  const config = {
    runtimeDir: join(dir, "run"),
    stateDir: join(dir, "state"),
    engineFactory,
    authorize,
  };
  const daemon = await serveSessionDaemon(config);
  const client = await connectSessionClient({
    transport: await openLocalTransport(daemon.endpoint),
  });
  return {
    dir,
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
async function until(fn: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await Bun.sleep(10);
  }
  throw new Error("condition timed out");
}
test("PTY survives clients, grants, size ownership, watch and retained recovery", async () => {
  const t = await setup();
  try {
    const events: any[] = [];
    const stop = t.client.watch((event) => events.push(event));
    await stop.ready;
    const session = await t.client.create({
      argv: ["/bin/sh"],
      size: { cols: 80, rows: 24 },
      name: "durable",
      labels: { project: "example" },
    });
    const a = await t.client.attach(session.id, {
      permissions: { read: true, input: true },
      onEvent: () => {},
    });
    const b = await t.client.attach(session.id, {
      permissions: { read: true, input: false },
      onEvent: () => {},
    });
    await expect(b.writeInput(encoder.encode("bad"))).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(b.resize({ cols: 90, rows: 25 })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await a.transferSize(b.id);
    await b.resize({ cols: 90, rows: 25 });
    await a.writeInput(encoder.encode("printf 'survival-marker\\n'\n"));
    await until(async () =>
      (await t.client.readScreen(session.id)).includes("survival-marker"),
    );
    await a.detach();
    await b.detach();
    await t.client.close();
    const other = await connectSessionClient({
      transport: await openLocalTransport(t.daemon.endpoint),
    });
    expect(
      (await other.list({ labels: { project: "example" } }))[0]?.state,
    ).toBe("running");
    expect(events.some((e) => e.type === "created")).toBe(true);
    await other.terminate(session.id, "force");
    await until(async () => (await other.get(session.id)).state === "exited");
    await other.close();
    await t.daemon.close();
    const recovered = await createSessionDaemon(t.config);
    expect(recovered.info.id).toBe(t.daemon.info.id);
    await recovered.close();
  } finally {
    await t.close();
  }
});
test("failed spawn releases terminal and refused attachment creates no grant", async () => {
  const t = await setup((_p: any, action: string) => action !== "attach");
  try {
    await expect(
      t.client.create({
        argv: ["/definitely/missing/werk"],
        size: { cols: 80, rows: 24 },
      }),
    ).rejects.toThrow();
    expect((t.config.engineFactory as any).allocated()).toBe(0);
    const session = await t.client.create({
      argv: ["/bin/sh"],
      size: { cols: 80, rows: 24 },
    });
    await expect(
      t.client.attach(session.id, { onEvent: () => {} }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect((await t.client.get(session.id)).attachments).toHaveLength(0);
  } finally {
    await t.close();
  }
});
test("ending another attachment revokes it without ending process", async () => {
  const t = await setup();
  try {
    const session = await t.client.create({
      argv: ["/bin/sh"],
      size: { cols: 80, rows: 24 },
    });
    const events: any[] = [];
    const a = await t.client.attach(session.id, {
      onEvent: (event) => events.push(event),
    });
    await t.client.endAttachment(a.id);
    await until(async () =>
      events.some((e) => e.type === "ended" && e.reason === "revoked"),
    );
    expect((await t.client.get(session.id)).state).toBe("running");
  } finally {
    await t.close();
  }
});
