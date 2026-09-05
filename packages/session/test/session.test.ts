import { test, expect } from "bun:test";
import { connectSessionClient, SessionError } from "../src/index.js";
import {
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
  protocolVersion: 1,
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
) {
  const [a, b] = pair();
  const server = new FramedTransport(b);
  const task = (async () => {
    for await (const message of server.messages()) {
      if (message.type === "hello")
        await server.send({
          type: "hello",
          protocolVersion: 1,
          daemon,
          principal,
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
