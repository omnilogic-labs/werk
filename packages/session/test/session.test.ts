import { test, expect } from "bun:test";
import { connectSessionClient, SessionError } from "../src/index.js";
import {
  PROTOCOL_VERSION,
  FrameDecoder,
  encodeFrame,
  FramedTransport,
  type Transport,
  type WireMessage,
} from "../src/protocol.js";
function pair(): [Transport, Transport] {
  const ab = new TransformStream<Uint8Array>();
  const ba = new TransformStream<Uint8Array>();
  return [
    { readable: ba.readable, writable: ab.writable, close() {} },
    { readable: ab.readable, writable: ba.writable, close() {} },
  ];
}
const daemon = {
  id: "d",
  version: "test",
  protocolVersion: PROTOCOL_VERSION,
  engine: { buildId: "different-build", snapshotFormatVersion: 1 },
  capabilities: { termination: ["force" as const], snapshots: true },
};
const principal = { id: "owner" };
async function mock(
  handler: (
    message: Extract<WireMessage, { type: "request" }>,
    server: FramedTransport,
  ) => Promise<void>,
  timeout = 1000,
  maxFrameBytes?: number,
) {
  const [a, b] = pair();
  const server = new FramedTransport(b);
  const task = (async () => {
    for await (const message of server.messages()) {
      if (message.type === "hello")
        await server.send({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          daemon,
          principal,
          maxFrameBytes,
        });
      else if (message.type === "request") await handler(message, server);
    }
  })().catch(() => {});
  const client = await connectSessionClient({
    transport: a,
    requestTimeoutMs: timeout,
  });
  return {
    client,
    async close() {
      await client.close();
      await server.close();
      await task;
    },
  };
}
test("framing survives arbitrary byte boundaries and unknown effect payloads", () => {
  const event = {
    type: "event",
    event: {
      type: "effect",
      attachmentId: "a",
      generation: 2,
      position: 3,
      effect: {
        kind: "future-osc",
        payload: new Uint8Array([0, 255]),
        time: 1,
      },
    },
  } satisfies WireMessage;
  const decoder = new FrameDecoder();
  const frames: WireMessage[] = [];
  for (const byte of encodeFrame(event))
    frames.push(...decoder.push(new Uint8Array([byte])));
  decoder.finish();
  expect(frames).toEqual([event]);
  expect(() =>
    new FrameDecoder(10).push(new Uint8Array([0, 0, 0, 11])),
  ).toThrow(SessionError);
  const truncated = new FrameDecoder();
  truncated.push(new Uint8Array([0]));
  expect(() => truncated.finish()).toThrow();
});
test("hello timeout closes transport, including blocked writes", async () => {
  let closed = false;
  const transport: Transport = {
    readable: new ReadableStream(),
    writable: new WritableStream({
      write() {
        return new Promise(() => {});
      },
    }),
    close() {
      closed = true;
    },
  };
  await expect(
    connectSessionClient({ transport, requestTimeoutMs: 10 }),
  ).rejects.toMatchObject({ code: "TIMEOUT" });
  expect(closed).toBe(true);
});
test("RPC timeout has explicit unknown outcome and does not retry creation", async () => {
  let calls = 0;
  const m = await mock(async () => {
    calls++;
  }, 15);
  await expect(
    m.client.create({ argv: ["sh"], size: { cols: 80, rows: 24 } }),
  ).rejects.toMatchObject({ code: "TIMEOUT", outcomeUnknown: true });
  expect(calls).toBe(1);
  await m.close();
});
test("attachment routing, callback isolation, old handles and failed attach", async () => {
  let count = 0;
  const seen: string[] = [];
  const requests: string[] = [];
  const m = await mock(async (message, server) => {
    requests.push(message.method);
    if (message.method === "attach") {
      if (++count === 3) {
        await server.send({
          type: "response",
          id: message.id,
          error: { code: "PERMISSION_DENIED", message: "denied" },
        });
        return;
      }
      const id = String(count);
      await server.send({
        type: "response",
        id: message.id,
        result: {
          id,
          sessionId: "s",
          generation: count,
          principal,
          permissions: { read: true, input: true },
          holdsSize: count === 1,
        },
      });
      await server.send({
        type: "event",
        event: {
          type: "snapshot",
          attachmentId: id,
          generation: count,
          position: 0,
          size: { cols: 2, rows: 2 },
          snapshot: new Uint8Array([1]),
        },
      });
    } else if (message.method === "detach") {
      const id = (message.params as any).attachmentId;
      await server.send({
        type: "event",
        event: {
          type: "ended",
          attachmentId: id,
          generation: Number(id),
          position: 1,
          reason: "detached",
        },
      });
      await server.send({ type: "response", id: message.id });
    } else await server.send({ type: "response", id: message.id });
  });
  const a = await m.client.attach("s", {
    onEvent: (e) => {
      seen.push(e.attachmentId);
      throw new Error("user callback");
    },
  });
  const b = await m.client.attach("s", {
    onEvent: (e) => seen.push(e.attachmentId),
  });
  await expect(m.client.attach("s", { onEvent() {} })).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await a.detach();
  await expect(a.writeInput(new Uint8Array([1]))).rejects.toMatchObject({
    code: "CLOSED",
  });
  await b.writeInput(new Uint8Array([2]));
  expect(seen).toContain("2");
  expect(requests.filter((x) => x === "input")).toHaveLength(1);
  await m.close();
});
test("size intent travels with attach and claims route to the daemon", async () => {
  const methods: string[] = [];
  const attaches: any[] = [];
  const m = await mock(async (message, server) => {
    methods.push(message.method);
    const params = message.params as any;
    if (message.method === "attach") attaches.push(params);
    await server.send({
      type: "response",
      id: message.id,
      result:
        message.method === "attach"
          ? {
              id: params.permissions.input ? "writer" : "reader",
              sessionId: "s",
              generation: attaches.length,
              principal,
              permissions: params.permissions,
              representation: params.representation,
              holdSize:
                params.holdSize ??
                (params.permissions.input ? "if-free" : "never"),
              holdsSize: false,
            }
          : null,
    });
  });
  try {
    const writer = await m.client.attach("s", {
      permissions: { read: true, input: true },
      holdSize: "claim",
      onEvent() {},
    });
    expect(attaches[0].holdSize).toBe("claim");
    expect([writer.holdSize, writer.representation, writer.holdsSize]).toEqual([
      "claim",
      "snapshot",
      false,
    ]);
    await writer.claimSize();
    expect(methods.filter((x) => x === "claimSize")).toHaveLength(1);
    writer.deliver({
      type: "snapshot",
      attachmentId: "writer",
      generation: 1,
      position: 1,
      size: { cols: 2, rows: 2 },
      snapshot: new Uint8Array([1]),
    });
    writer.deliver({
      type: "size-holder",
      attachmentId: "writer",
      generation: 1,
      position: 2,
      holdsSize: true,
    });
    expect(writer.holdsSize).toBe(true);
    // A watcher's default asks for nothing and cannot claim without a round trip.
    const reader = await m.client.attach("s", { onEvent() {} });
    expect(attaches[1].holdSize).toBeUndefined();
    expect([reader.holdSize, reader.holdsSize]).toEqual(["never", false]);
    await expect(reader.claimSize()).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(methods.filter((x) => x === "claimSize")).toHaveLength(1);
  } finally {
    await m.close();
  }
});
test("watch registers without attachments and exposes refusal", async () => {
  const m = await mock(async (message, server) => {
    await server.send({
      type: "response",
      id: message.id,
      error: { code: "PERMISSION_DENIED", message: "denied" },
    });
  });
  const stop = m.client.watch(() => {});
  await expect(stop.ready).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  stop();
  await m.close();
});
test("cancelled attach closes connection so late grants cannot become orphaned", async () => {
  const m = await mock(async () => {});
  const abort = new AbortController();
  const attaching = m.client.attach("s", {
    signal: abort.signal,
    onEvent() {},
  });
  abort.abort();
  await expect(attaching).rejects.toMatchObject({
    code: "CANCELLED",
    outcomeUnknown: true,
  });
  await m.client.closed;
  await m.close();
});

test("framing normalises Uint8Array subclasses before toJSON", () => {
  class Bytes extends Uint8Array {
    toJSON() {
      return { bad: true };
    }
  }
  const decoder = new FrameDecoder();
  const [message] = decoder.push(
    encodeFrame({
      type: "request",
      id: "b",
      method: "input",
      params: { data: new Bytes([1, 255]) },
    }),
  );
  expect((message as any).params.data).toEqual(new Uint8Array([1, 255]));
});

test("refused watch can retry and identical callbacks own independent subscriptions", async () => {
  let attempts = 0,
    calls = 0;
  const methods: string[] = [];
  const m = await mock(async (request, server) => {
    methods.push(request.method);
    if (request.method === "watch" && ++attempts === 1) {
      await server.send({
        type: "response",
        id: request.id,
        error: { code: "PERMISSION_DENIED", message: "denied" },
      });
    } else {
      await server.send({ type: "response", id: request.id });
      if (request.method === "get")
        await server.send({
          type: "daemon-event",
          event: { type: "removed", sessionId: "s" },
        });
    }
  });
  try {
    const denied = m.client.watch(() => {});
    await expect(denied.ready).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    const callback = () => {
      calls++;
    };
    const a = m.client.watch(callback),
      b = m.client.watch(callback);
    await Promise.all([a.ready, b.ready]);
    await m.client.get("s");
    await Bun.sleep(0);
    expect(calls).toBe(2);
    a();
    await m.client.get("s");
    await Bun.sleep(0);
    expect(calls).toBe(3);
    expect(methods).not.toContain("unwatch");
    b();
    await Bun.sleep(0);
    expect(methods.filter((method) => method === "unwatch")).toHaveLength(1);
    expect(attempts).toBe(2);
  } finally {
    await m.close();
  }
});

test("attachment lifetime abort invalidates handle and detaches only its grant", async () => {
  const methods: string[] = [];
  const m = await mock(async (request, server) => {
    methods.push(request.method);
    await server.send({
      type: "response",
      id: request.id,
      result:
        request.method === "attach"
          ? {
              id: "a",
              sessionId: "s",
              generation: 1,
              principal,
              permissions: { read: true, input: false },
              holdsSize: false,
            }
          : undefined,
    });
  });
  try {
    const controller = new AbortController();
    const events: string[] = [];
    const attachment = await m.client.attach("s", {
      signal: controller.signal,
      onEvent: (e) => events.push(e.type),
    });
    expect(() => {
      (attachment.info as any).id = "hijacked";
    }).toThrow();
    expect(() => {
      (attachment.permissions as any).input = true;
    }).toThrow();
    expect(() => {
      (attachment.principal as any).id = "other";
    }).toThrow();
    expect(() => {
      (m.client.daemon as any).id = "other";
    }).toThrow();
    controller.abort();
    await expect(
      attachment.writeInput(new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "CLOSED" });
    await m.client.get("s");
    expect(events).toEqual(["ended"]);
    expect(methods.filter((x) => x === "detach")).toHaveLength(1);
    expect(methods).not.toContain("input");
  } finally {
    await m.close();
  }
});

test("malformed hello metadata is refused before exposing client", async () => {
  for (const metadata of [
    {},
    { ...daemon, engine: {} },
    { ...daemon, capabilities: { snapshots: true, termination: ["invented"] } },
  ]) {
    const [a, b] = pair();
    const server = new FramedTransport(b);
    const task = (async () => {
      for await (const m of server.messages())
        if (m.type === "hello")
          await server.send({
            type: "hello",
            protocolVersion: PROTOCOL_VERSION,
            daemon: metadata as any,
            principal,
          });
    })().catch(() => {});
    await expect(connectSessionClient({ transport: a })).rejects.toMatchObject({
      code: "PROTOCOL",
    });
    await server.close();
    await task;
  }
});

test("input pastes respect the daemon-advertised raw body cap and preserve bytes", async () => {
  const received: Uint8Array[] = [];
  const m = await mock(
    async (message, server) => {
      if (message.method === "input") {
        expect(encodeFrame(message).byteLength - 4).toBeLessThanOrEqual(1024);
        received.push((message.params as { data: Uint8Array }).data);
      }
      await server.send({
        type: "response",
        id: message.id,
        result:
          message.method === "attach"
            ? {
                id: "attachment",
                sessionId: "s",
                generation: 1,
                principal,
                permissions: { read: true, input: true },
                holdsSize: true,
              }
            : null,
      });
    },
    1000,
    1024,
  );
  try {
    const attachment = await m.client.attach("s", {
      onEvent() {},
      permissions: { read: true, input: true },
    });
    const paste = Uint8Array.from({ length: 10000 }, (_, i) => i % 251);
    await attachment.writeInput(paste);
    expect(received.length).toBeGreaterThan(1);
    const combined = new Uint8Array(paste.length);
    let offset = 0;
    for (const chunk of received) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    expect(combined).toEqual(paste);
  } finally {
    await m.close();
  }
});
test("attachment to a session with no live process ends after its saved screen", async () => {
  const seen: any[] = [];
  const requests: string[] = [];
  const m = await mock(async (message, server) => {
    requests.push(message.method);
    if (message.method !== "attach") {
      await server.send({ type: "response", id: message.id });
      return;
    }
    await server.send({
      type: "response",
      id: message.id,
      result: {
        id: "a",
        sessionId: "s",
        generation: 1,
        principal,
        permissions: { read: true, input: true },
        holdsSize: false,
      },
    });
    const head = { attachmentId: "a", generation: 1 } as const;
    await server.send({
      type: "event",
      event: {
        ...head,
        type: "snapshot",
        position: 1,
        size: { cols: 2, rows: 2 },
        snapshot: new Uint8Array([1]),
      },
    });
    await server.send({
      type: "event",
      event: { ...head, type: "exit", position: 2, exit: { code: 0 } },
    });
    await server.send({
      type: "event",
      event: {
        ...head,
        type: "ended",
        position: 3,
        reason: "session-ended",
      },
    });
  });
  const attachment = await m.client.attach("s", {
    onEvent: (event) => seen.push(event),
  });
  expect(attachment.holdsSize).toBe(false);
  // The wire is ordered, so a completed round trip proves the three frames landed.
  await m.client.get("s");
  expect(seen.map((e) => e.type)).toEqual(["snapshot", "exit", "ended"]);
  expect(seen[1].exit).toEqual({ code: 0 });
  expect(seen[2].reason).toBe("session-ended");
  await expect(attachment.resize({ cols: 4, rows: 4 })).rejects.toMatchObject({
    code: "CLOSED",
  });
  await attachment.detach();
  expect(requests).toEqual(["attach", "get"]);
  await m.close();
});

test("a preview attachment opens on a frame and carries its rate to the daemon", async () => {
  const attaches: any[] = [];
  const m = await mock(async (message, server) => {
    const params = message.params as any;
    if (message.method === "attach") attaches.push(params);
    await server.send({
      type: "response",
      id: message.id,
      result: {
        id: "tile",
        sessionId: "s",
        generation: 1,
        principal,
        permissions: { read: true, input: false },
        representation: params.representation,
        holdSize: "never",
        holdsSize: false,
      },
    });
  });
  try {
    const events: any[] = [];
    const tile = await m.client.attach("s", {
      representation: "preview",
      preview: { intervalMs: 250, format: "plain" },
      onEvent: (event) => events.push(event),
    });
    expect(attaches[0].preview).toEqual({ intervalMs: 250, format: "plain" });
    // A tile has no replica to restore, so its first authoritative state is a
    // picture rather than a snapshot.
    tile.deliver({
      type: "preview",
      attachmentId: "tile",
      generation: 1,
      position: 0,
      size: { cols: 4, rows: 1 },
      format: "plain",
      text: "one",
      cursor: { x: 3, y: 0, visible: true },
      changedAt: 1,
    });
    tile.deliver({
      type: "preview",
      attachmentId: "tile",
      generation: 1,
      position: 1,
      size: { cols: 4, rows: 1 },
      format: "plain",
      text: "two",
      changedAt: 2,
    });
    expect(events.map((event) => event.text)).toEqual(["one", "two"]);
    await expect(tile.writeInput(new Uint8Array([1]))).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(tile.resize({ cols: 2, rows: 2 })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    tile.deliver({
      type: "ended",
      attachmentId: "tile",
      generation: 1,
      position: 2,
      reason: "session-ended",
    });
    expect(events.at(-1).type).toBe("ended");
  } finally {
    await m.close();
  }
});
