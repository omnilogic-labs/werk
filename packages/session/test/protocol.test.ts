import { expect, test } from "bun:test";
import { connectSessionClient } from "../src/index.js";
import {
  encodeFrame,
  FrameDecoder,
  FramedTransport,
  PROTOCOL_VERSION,
  type WireMessage,
} from "../src/protocol.js";

function raw(json: unknown, blobs: Uint8Array[] = []) {
  const header = new TextEncoder().encode(JSON.stringify(json));
  const bytes = new Uint8Array(
    8 + header.length + blobs.reduce((n, b) => n + 4 + b.length, 0),
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length - 4);
  view.setUint32(4, header.length);
  bytes.set(header, 8);
  let offset = 8 + header.length;
  for (const blob of blobs) {
    view.setUint32(offset, blob.length);
    bytes.set(blob, offset + 4);
    offset += 4 + blob.length;
  }
  return bytes;
}
const request = (params: unknown): WireMessage => ({
  type: "request",
  id: "1",
  method: "input",
  params,
});

test("v2 carries multiple, nested and empty blobs as raw bytes at every split", () => {
  expect(PROTOCOL_VERSION).toBe(2);
  const message = request({
    a: new Uint8Array([0, 255]),
    nested: [new Uint8Array(), new Uint8Array([3])],
  });
  const frame = encodeFrame(message);
  expect(new DataView(frame.buffer).getUint32(0)).toBe(frame.length - 4);
  for (let split = 0; split <= frame.length; split++) {
    const decoder = new FrameDecoder();
    expect([
      ...decoder.push(frame.subarray(0, split)),
      ...decoder.push(frame.subarray(split)),
    ]).toEqual([message]);
    decoder.finish();
  }
  const joined = new Uint8Array(frame.length * 2);
  joined.set(frame);
  joined.set(frame, frame.length);
  const decoded = new FrameDecoder().push(joined);
  expect(decoded).toEqual([message, message]);
  const params = (decoded[0] as any).params;
  expect(params.a.buffer).toBe(params.nested[1].buffer);
  expect(params.a.buffer).not.toBe(joined.buffer);
});

test("body cap includes binary metadata and handles large fragmented blobs", () => {
  const message = request(new Uint8Array(2 * 1024 * 1024).fill(255));
  const frame = encodeFrame(message);
  expect(frame.length).toBeLessThan(2 * 1024 * 1024 + 128);
  expect(encodeFrame(message, frame.length - 4)).toEqual(frame);
  expect(() => encodeFrame(message, frame.length - 5)).toThrow();
  expect(() =>
    new FrameDecoder(frame.length - 5).push(frame.subarray(0, 4)),
  ).toThrow();
  const decoder = new FrameDecoder(frame.length - 4);
  const messages: WireMessage[] = [];
  for (let offset = 0; offset < frame.length; offset += 4096)
    messages.push(...decoder.push(frame.subarray(offset, offset + 4096)));
  decoder.finish();
  expect(messages).toEqual([message]);
});

test("malformed binary headers, tables, references, JSON and message shapes fail", () => {
  const byte = new Uint8Array([1]);
  const malformed = [
    raw(request({ $b: 0 })),
    raw(request([{ $b: 0 }, { $b: 0 }]), [byte]),
    raw(request({ $b: -1 }), [byte]),
    raw(request({ $b: 0.5 }), [byte]),
    raw(request({ $b: "0" }), [byte]),
    raw(request(null), [byte]),
    raw({ type: "request", id: 1, method: "input" }),
    raw({
      type: "event",
      event: {
        type: "output",
        attachmentId: "a",
        generation: 1,
        position: 0,
        data: [],
      },
    }),
  ];
  const header = raw(request(null));
  new DataView(header.buffer).setUint32(4, header.length);
  malformed.push(header);
  const blob = raw(request({ $b: 0 }), [byte]);
  new DataView(blob.buffer).setUint32(blob.length - 5, 2);
  malformed.push(blob);
  const utf8 = raw(request(null));
  utf8[8] = 255;
  malformed.push(utf8);
  const json = raw(request(null));
  json[8] = 33;
  malformed.push(json);
  const shortTable = new Uint8Array(raw(request(null)).length + 1);
  shortTable.set(raw(request(null)));
  new DataView(shortTable.buffer).setUint32(0, shortTable.length - 4);
  malformed.push(shortTable);
  for (const bytes of malformed)
    expect(() => new FrameDecoder().push(bytes)).toThrow();
  for (const length of [0, 1, 2, 3, 0xffffffff]) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, length);
    expect(() => new FrameDecoder().push(bytes)).toThrow();
  }
  const frame = encodeFrame(request(byte));
  for (let length = 1; length < frame.length; length++) {
    const decoder = new FrameDecoder();
    decoder.push(frame.subarray(0, length));
    expect(() => decoder.finish()).toThrow();
  }
});

test("sendFrame preserves encoded bytes, enforces queue bounds and releases capacity", async () => {
  let release!: () => void;
  const received: Uint8Array[] = [];
  const frame = encodeFrame(request(null));
  const wire = new FramedTransport(
    {
      readable: new ReadableStream(),
      writable: new WritableStream({
        write(bytes) {
          received.push(bytes);
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      }),
      close() {},
    },
    frame.length - 4,
    frame.length,
  );
  const pending = wire.sendFrame(frame);
  await Promise.resolve();
  await expect(wire.sendFrame(frame)).rejects.toMatchObject({ code: "LIMIT" });
  expect(received[0]).toBe(frame);
  release();
  await pending;
  const next = wire.send(request(null));
  await Promise.resolve();
  release();
  await next;
  await expect(
    wire.sendFrame(encodeFrame(request("longer"))),
  ).rejects.toMatchObject({ code: "LIMIT" });
  await expect(wire.sendFrame(new Uint8Array(8))).rejects.toMatchObject({
    code: "PROTOCOL",
  });
  await wire.close();
  await expect(wire.sendFrame(frame)).rejects.toMatchObject({ code: "CLOSED" });
});

test("client applies its configured receive cap during hello", async () => {
  const hello = encodeFrame({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    credential: "x".repeat(300),
  });
  let closed = false;
  await expect(
    connectSessionClient({
      maxFrameBytes: 128,
      transport: {
        readable: new ReadableStream({
          start(controller) {
            controller.enqueue(hello);
          },
        }),
        writable: new WritableStream(),
        close() {
          closed = true;
        },
      },
    }),
  ).rejects.toMatchObject({ code: "PROTOCOL" });
  expect(closed).toBe(true);
});
