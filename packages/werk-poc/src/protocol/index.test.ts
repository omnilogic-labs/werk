import { describe, expect, test } from "bun:test";
import {
  decodeControl,
  encodeControl,
  encodeFrame,
  FrameParser,
  FrameType,
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  type ClientMessage,
} from "./index.ts";

const enc = new TextEncoder();

describe("frame encoding", () => {
  test("header is little-endian length of type+payload", () => {
    const f = encodeFrame(FrameType.output, enc.encode("abc"));
    expect(f.length).toBe(HEADER_BYTES + 1 + 3);
    expect([...f.subarray(0, 4)]).toEqual([4, 0, 0, 0]);
    expect(f[4]).toBe(FrameType.output);
    expect(new TextDecoder().decode(f.subarray(5))).toBe("abc");
  });

  test("empty payload is a one-byte frame", () => {
    const f = encodeFrame(FrameType.input, new Uint8Array(0));
    expect([...f]).toEqual([1, 0, 0, 0, FrameType.input]);
  });

  test("control frames round-trip JSON", () => {
    const msg: ClientMessage = { t: "ls", rid: 7 };
    const [frame] = new FrameParser().push(encodeControl(msg));
    expect(frame!.type).toBe(FrameType.control);
    expect(decodeControl<ClientMessage>(frame!.payload)).toEqual(msg);
  });

  test("oversized frames are refused", () => {
    expect(() =>
      encodeFrame(FrameType.output, new Uint8Array(MAX_FRAME_BYTES)),
    ).toThrow(/too large/);
  });
});

describe("FrameParser", () => {
  test("one frame per push", () => {
    const p = new FrameParser();
    const frames = p.push(encodeFrame(FrameType.render, enc.encode("x")));
    expect(frames.length).toBe(1);
    expect(frames[0]!.type).toBe(FrameType.render);
    expect(p.pending).toBe(0);
  });

  test("many frames in one push", () => {
    const a = encodeFrame(FrameType.output, enc.encode("one"));
    const b = encodeControl({ t: "resumed", id: "abc123" });
    const c = encodeFrame(FrameType.input, enc.encode("three"));
    const joined = new Uint8Array(a.length + b.length + c.length);
    joined.set(a, 0);
    joined.set(b, a.length);
    joined.set(c, a.length + b.length);
    const frames = new FrameParser().push(joined);
    expect(frames.map((f) => f.type)).toEqual([
      FrameType.output,
      FrameType.control,
      FrameType.input,
    ]);
    expect(new TextDecoder().decode(frames[2]!.payload)).toBe("three");
  });

  test("a frame split byte by byte across pushes", () => {
    const f = encodeFrame(FrameType.output, enc.encode("hello world"));
    const p = new FrameParser();
    const got = [];
    for (let i = 0; i < f.length; i++) {
      got.push(...p.push(f.subarray(i, i + 1)));
      if (i < f.length - 1) expect(got.length).toBe(0);
    }
    expect(got.length).toBe(1);
    expect(new TextDecoder().decode(got[0]!.payload)).toBe("hello world");
    expect(p.pending).toBe(0);
  });

  test("a split inside the header, then two frames plus a partial third", () => {
    const a = encodeFrame(FrameType.output, enc.encode("aaaa"));
    const b = encodeFrame(FrameType.output, enc.encode("bb"));
    const c = encodeFrame(FrameType.output, enc.encode("cccccc"));
    const all = new Uint8Array([...a, ...b, ...c]);
    const p = new FrameParser();
    expect(p.push(all.subarray(0, 2)).length).toBe(0);
    expect(p.pending).toBe(2);
    const mid = p.push(all.subarray(2, a.length + b.length + 3));
    expect(mid.length).toBe(2);
    expect(p.pending).toBe(3);
    const last = p.push(all.subarray(a.length + b.length + 3));
    expect(last.length).toBe(1);
    expect(new TextDecoder().decode(last[0]!.payload)).toBe("cccccc");
  });

  test("payloads are copies, not views of the input buffer", () => {
    const f = encodeFrame(FrameType.output, enc.encode("keep"));
    const [frame] = new FrameParser().push(f);
    f.fill(0);
    expect(new TextDecoder().decode(frame!.payload)).toBe("keep");
  });

  test("a bad length or type throws", () => {
    expect(() =>
      new FrameParser().push(new Uint8Array([0, 0, 0, 0, 0])),
    ).toThrow(/length/);
    expect(() =>
      new FrameParser().push(new Uint8Array([0xff, 0xff, 0xff, 0xff])),
    ).toThrow(/length/);
    expect(() =>
      new FrameParser().push(new Uint8Array([1, 0, 0, 0, 9])),
    ).toThrow(/type/);
  });

  test("a large data frame in 1 KiB pieces", () => {
    const payload = new Uint8Array(300_000);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    const f = encodeFrame(FrameType.output, payload);
    const p = new FrameParser();
    const got = [];
    for (let off = 0; off < f.length; off += 1024)
      got.push(...p.push(f.subarray(off, off + 1024)));
    expect(got.length).toBe(1);
    expect(got[0]!.payload).toEqual(payload);
  });
});
