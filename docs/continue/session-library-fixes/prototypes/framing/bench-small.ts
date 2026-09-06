// Capped re-run after the reboot: current JSON $bytes vs proposed binary
// framing (plus base64). No 4 MB case, 3 timed runs, one decoder pass.
import {
  encodeFrame as encodeV1,
  FrameDecoder as DecoderV1,
} from "/home/mike/Development/omnilogic-labs/werk/packages/session/src/protocol.ts";
import {
  encodeFrame as encodeV2,
  FrameDecoder as DecoderV2,
  decodeBody as decodeBodyV2,
  encodeFrameBase64,
  decodeBodyBase64,
} from "./protocol-v2.ts";

const BIG = 64 * 1024 * 1024;
const RUNS = 3;
const median = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
function time(fn: () => void, runs = RUNS) {
  const t: number[] = [];
  fn();
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    t.push(performance.now() - t0);
  }
  return median(t);
}
function randomBytes(n: number) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536)
    crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}
function textBytes(n: number) {
  const line =
    "\x1b[32muser@host\x1b[0m:~/werk$ ls -la packages/session/src  total 48 drwxr-xr-x\r\n";
  const enc = new TextEncoder().encode(line);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = enc[i % enc.length];
  return out;
}
const attachmentId = crypto.randomUUID();
const outputMessage = (position: number, data: Uint8Array) =>
  ({
    type: "event",
    event: { type: "output", attachmentId, generation: 1, position, data },
  }) as any;
const snapshotMessage = (snapshot: Uint8Array) =>
  ({
    type: "event",
    event: {
      type: "snapshot",
      attachmentId,
      generation: 1,
      position: 1,
      size: { cols: 120, rows: 40 },
      snapshot,
      engineBuildId: "ghostty-abc123",
      snapshotFormatVersion: 1,
    },
  }) as any;

const codecs = [
  {
    name: "current JSON $bytes",
    encode: (m: any) => encodeV1(m, BIG),
    decode: (f: Uint8Array) => new DecoderV1(BIG).push(f)[0] as any,
  },
  {
    name: "base64 in JSON",
    encode: (m: any) => encodeFrameBase64(m, BIG),
    decode: (f: Uint8Array) => decodeBodyBase64(f.subarray(4)) as any,
  },
  {
    name: "binary header+blobs (proposed)",
    encode: (m: any) => encodeV2(m, BIG),
    decode: (f: Uint8Array) => decodeBodyV2(f.subarray(4)) as any,
  },
];
const fmt = (n: number) => n.toLocaleString("en-GB");
const ms = (n: number) => n.toFixed(1);
console.log(
  "| Workload | Encoding | Wire bytes | Ratio | Encode ms | Decode ms |",
);
console.log("|---|---|---:|---:|---:|---:|");
{
  const data = textBytes(1.5 * 1024 * 1024);
  const messages: any[] = [];
  for (let i = 0; i < data.length; i += 32768)
    messages.push(
      outputMessage(messages.length + 1, data.subarray(i, i + 32768)),
    );
  for (const codec of codecs) {
    const frames = messages.map((m) => codec.encode(m));
    const wire = frames.reduce((s, f) => s + f.byteLength, 0);
    const enc = time(() => {
      for (const m of messages) codec.encode(m);
    });
    const dec = time(() => {
      for (const f of frames) codec.decode(f);
    });
    const back = codec.decode(frames[0]);
    if (
      !(back.event.data instanceof Uint8Array) ||
      back.event.data.byteLength !== 32768
    )
      throw new Error(`${codec.name}: roundtrip failed`);
    console.log(
      `| 1.5 MB output, 32 KB chunks, text | ${codec.name} | ${fmt(wire)} | ${(wire / data.length).toFixed(2)}x | ${ms(enc)} | ${ms(dec)} |`,
    );
  }
}
for (const size of [100 * 1024, 700 * 1024, 2 * 1024 * 1024]) {
  const label = `${size >= 1024 * 1024 ? size / 1024 / 1024 + " MB" : size / 1024 + " KB"} snapshot, random`;
  const message = snapshotMessage(randomBytes(size));
  for (const codec of codecs) {
    const frame = codec.encode(message);
    const enc = time(() => codec.encode(message));
    const dec = time(() => codec.decode(frame));
    const back = codec.decode(frame);
    if (
      !(back.event.snapshot instanceof Uint8Array) ||
      back.event.snapshot.byteLength !== size
    )
      throw new Error(`${codec.name}: roundtrip failed`);
    console.log(
      `| ${label} | ${codec.name} | ${fmt(frame.byteLength)} | ${(frame.byteLength / size).toFixed(2)}x | ${ms(enc)} | ${ms(dec)} |`,
    );
  }
}
{
  const messages = Array.from({ length: 10000 }, (_, i) => ({
    type: "request",
    id: String(i),
    method: "get",
    params: { sessionId: attachmentId },
  }));
  for (const codec of codecs) {
    const frames = messages.map((m) => codec.encode(m));
    const wire = frames.reduce((s, f) => s + f.byteLength, 0);
    const enc = time(() => {
      for (const m of messages) codec.encode(m);
    });
    const dec = time(() => {
      for (const f of frames) codec.decode(f);
    });
    console.log(
      `| 10,000 small requests | ${codec.name} | ${fmt(wire)} | - | ${ms(enc)} | ${ms(dec)} |`,
    );
  }
}

console.log(
  "\n## Decoder: 8 MiB frame in 4 KiB chunks, single run (buffering cost excluding the final parse)",
);
{
  const LIMIT = 9 * 1024 * 1024;
  const v1Frame = encodeV1(
    outputMessage(1, textBytes(Math.floor((8 * 1024 * 1024) / 3.62))),
    LIMIT,
  );
  const v2Frame = encodeV2(
    snapshotMessage(randomBytes(8 * 1024 * 1024 - 256)),
    LIMIT,
  );
  const feed = (
    frame: Uint8Array,
    make: () => { push(c: Uint8Array): any[] },
  ) => {
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < frame.length; i += 4096)
      chunks.push(frame.slice(i, i + 4096));
    const d = make();
    const t0 = performance.now();
    for (let i = 0; i < chunks.length - 1; i++) d.push(chunks[i]);
    const buffered = performance.now() - t0;
    const t1 = performance.now();
    const out = d.push(chunks[chunks.length - 1]);
    const parsed = performance.now() - t1;
    if (out.length !== 1) throw new Error("expected one message");
    return { buffered, parsed, chunks: chunks.length, bytes: frame.length };
  };
  const a = feed(v1Frame, () => new DecoderV1(LIMIT));
  const b = feed(v2Frame, () => new DecoderV2(LIMIT));
  console.log(
    "| Decoder | Frame bytes | Chunks | Buffering ms | Final parse ms |",
  );
  console.log("|---|---:|---:|---:|---:|");
  console.log(
    `| current (concatenate per chunk) | ${fmt(a.bytes)} | ${a.chunks} | ${ms(a.buffered)} | ${ms(a.parsed)} |`,
  );
  console.log(
    `| proposed (allocate once, copy in) | ${fmt(b.bytes)} | ${b.chunks} | ${ms(b.buffered)} | ${ms(b.parsed)} |`,
  );
}
{
  const m = {
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
  } as any;
  const d = new DecoderV2();
  const out: any[] = [];
  for (const byte of encodeV2(m)) out.push(...d.push(new Uint8Array([byte])));
  d.finish();
  const ok =
    out.length === 1 &&
    out[0].event.effect.payload instanceof Uint8Array &&
    out[0].event.effect.payload[1] === 255;
  console.log(
    `\nbyte-at-a-time roundtrip with nested Uint8Array payload: ${ok ? "ok" : "FAILED"}`,
  );
  class Bytes extends Uint8Array {
    toJSON() {
      return { bad: true };
    }
  }
  const two = {
    type: "request",
    id: "x",
    method: "input",
    params: { data: new Bytes([1, 255]), other: Buffer.from([7, 8, 9]) },
  } as any;
  const back = new DecoderV2().push(encodeV2(two))[0] as any;
  console.log(
    `two blobs, subclass and Buffer: ${back.params.data instanceof Uint8Array && back.params.data[1] === 255 && back.params.other[2] === 9 ? "ok" : "FAILED"}`,
  );
  const bad = (frame: Uint8Array) => {
    try {
      new DecoderV2().push(frame);
      return "accepted";
    } catch (e: any) {
      return e.code;
    }
  };
  const forged = (json: string, blobs: Uint8Array[]) => {
    const j = new TextEncoder().encode(json);
    let body = 4 + j.length;
    for (const b of blobs) body += 4 + b.length;
    const f = new Uint8Array(4 + body);
    const v = new DataView(f.buffer);
    v.setUint32(0, body);
    v.setUint32(4, j.length);
    f.set(j, 8);
    let off = 8 + j.length;
    for (const b of blobs) {
      v.setUint32(off, b.length);
      f.set(b, off + 4);
      off += 4 + b.length;
    }
    return f;
  };
  console.log(
    `dangling $b: ${bad(forged('{"type":"request","id":"1","method":"m","params":{"$b":3}}', []))}`,
  );
  console.log(
    `unreferenced blob: ${bad(forged('{"type":"request","id":"1","method":"m","params":{}}', [new Uint8Array(3)]))}`,
  );
  console.log(
    `double reference: ${bad(forged('{"type":"request","id":"1","method":"m","params":{"a":{"$b":0},"b":{"$b":0}}}', [new Uint8Array(3)]))}`,
  );
  console.log(
    `over-limit length header: ${bad(new Uint8Array([0, 128, 0, 1]))}`,
  );
  const truncated = forged(
    '{"type":"request","id":"1","method":"m","params":{"$b":0}}',
    [new Uint8Array(3)],
  );
  new DataView(truncated.buffer).setUint32(truncated.length - 7, 100);
  console.log(`blob length past frame end: ${bad(truncated)}`);
}
