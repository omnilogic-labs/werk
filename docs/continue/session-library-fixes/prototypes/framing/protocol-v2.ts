// Prototype of a binary framing for @werk/session/protocol.
// Copied shape from packages/session/src/protocol.ts; the message validation is
// unchanged, the byte encoding and the decoder are replaced.
//
// Frame layout (all integers big-endian):
//
//   u32 bodyLength      bytes that follow this field
//   u32 jsonLength      length of the JSON header
//   json                UTF-8 JSON; every Uint8Array in the message tree is
//                       replaced by the reserved singleton {"$b": index}
//   repeat              u32 blobLength, blob bytes    (index 0, 1, 2, ...)
//
// Control messages carry no blobs and cost 4 bytes over the old frame.
// Byte payloads are copied once into the frame and returned to the receiver
// as zero-copy views into the received frame.

import {
  SessionError,
  type AttachmentEvent,
  type DaemonEvent,
  type DaemonInfo,
  type Principal,
  type ErrorCode,
} from "/home/mike/Development/omnilogic-labs/werk/packages/session/src/types.ts";

export const PROTOCOL_VERSION = 2;
export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export type WireMessage =
  | {
      type: "hello";
      protocolVersion: number;
      credential?: string;
      daemon?: DaemonInfo;
      principal?: Principal;
    }
  | { type: "request"; id: string; method: string; params: unknown }
  | {
      type: "response";
      id: string;
      result?: unknown;
      error?: { code: ErrorCode; message: string; outcomeUnknown?: boolean };
    }
  | { type: "event"; event: AttachmentEvent }
  | { type: "daemon-event"; event: DaemonEvent };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeFrame(
  message: WireMessage,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
): Uint8Array {
  const blobs: Uint8Array[] = [];
  const json = encoder.encode(
    JSON.stringify(message, function (key, value) {
      // JSON calls toJSON before its replacer (notably for Node Buffer), so
      // look at the original property rather than the replaced value.
      const original = this[key];
      if (original instanceof Uint8Array) {
        blobs.push(original);
        return { $b: blobs.length - 1 };
      }
      return value;
    }),
  );
  let body = 4 + json.byteLength;
  for (const blob of blobs) body += 4 + blob.byteLength;
  if (body > maxFrameBytes)
    throw new SessionError("LIMIT", "Frame exceeds limit");
  const frame = new Uint8Array(4 + body);
  const view = new DataView(frame.buffer);
  view.setUint32(0, body);
  view.setUint32(4, json.byteLength);
  frame.set(json, 8);
  let offset = 8 + json.byteLength;
  for (const blob of blobs) {
    view.setUint32(offset, blob.byteLength);
    frame.set(blob, offset + 4);
    offset += 4 + blob.byteLength;
  }
  return frame;
}

/** Decode one complete frame body (everything after the u32 bodyLength). */
export function decodeBody(body: Uint8Array): WireMessage {
  try {
    if (body.byteLength < 4) throw new Error("Short frame");
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const jsonLength = view.getUint32(0);
    if (4 + jsonLength > body.byteLength) throw new Error("Bad header length");
    const blobs: Uint8Array[] = [];
    let offset = 4 + jsonLength;
    while (offset < body.byteLength) {
      if (body.byteLength - offset < 4) throw new Error("Bad blob table");
      const length = view.getUint32(offset);
      offset += 4;
      if (length > body.byteLength - offset) throw new Error("Bad blob length");
      blobs.push(body.subarray(offset, offset + length));
      offset += length;
    }
    let used = 0;
    const seen = new Uint8Array(blobs.length);
    const message = JSON.parse(
      decoder.decode(body.subarray(4, 4 + jsonLength)),
      (_key, value) => {
        if (
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          "$b" in value &&
          Object.keys(value).length === 1
        ) {
          const index = value.$b;
          if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= blobs.length ||
            seen[index]
          )
            throw new Error("Invalid byte reference");
          seen[index] = 1;
          used++;
          return blobs[index];
        }
        return value;
      },
    );
    if (used !== blobs.length) throw new Error("Unreferenced bytes");
    validate(message);
    return message;
  } catch (error) {
    if (error instanceof SessionError) throw error;
    throw new SessionError("PROTOCOL", `Malformed frame: ${String(error)}`);
  }
}

/**
 * Linear-time decoder. The 4-byte length is assembled in a fixed header
 * buffer; the frame body is allocated once at its final size and chunks are
 * copied straight into it. Decoded byte payloads alias that body.
 */
export class FrameDecoder {
  private readonly header = new Uint8Array(4);
  private headerFilled = 0;
  private body?: Uint8Array;
  private filled = 0;
  constructor(private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {}
  push(chunk: Uint8Array): WireMessage[] {
    const messages: WireMessage[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (!this.body) {
        const take = Math.min(4 - this.headerFilled, chunk.byteLength - offset);
        this.header.set(
          chunk.subarray(offset, offset + take),
          this.headerFilled,
        );
        this.headerFilled += take;
        offset += take;
        if (this.headerFilled < 4) break;
        const length = new DataView(this.header.buffer).getUint32(0);
        if (length < 4 || length > this.maxFrameBytes)
          throw new SessionError("PROTOCOL", "Invalid frame length");
        this.headerFilled = 0;
        this.body = new Uint8Array(length);
        this.filled = 0;
      }
      const take = Math.min(
        this.body.byteLength - this.filled,
        chunk.byteLength - offset,
      );
      this.body.set(chunk.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.body.byteLength) {
        const body = this.body;
        this.body = undefined;
        messages.push(decodeBody(body));
      }
    }
    return messages;
  }
  finish(): void {
    if (this.headerFilled || this.body)
      throw new SessionError("PROTOCOL", "Truncated frame");
  }
}

// Unchanged from packages/session/src/protocol.ts, lifted out of the decoder.
function validate(message: any): void {
  if (
    !message ||
    typeof message !== "object" ||
    !["hello", "request", "response", "event", "daemon-event"].includes(
      message.type,
    )
  )
    throw new Error("Invalid message type");
  if (
    ["request", "response"].includes(message.type) &&
    typeof message.id !== "string"
  )
    throw new Error("Missing request id");
  if (message.type === "request" && typeof message.method !== "string")
    throw new Error("Missing method");
  if (message.type === "hello" && !Number.isInteger(message.protocolVersion))
    throw new Error("Missing protocol version");
  if (
    ["event", "daemon-event"].includes(message.type) &&
    (!message.event || typeof message.event.type !== "string")
  )
    throw new Error("Missing event");
  if (message.type === "event") {
    const e = message.event;
    if (
      typeof e.attachmentId !== "string" ||
      !Number.isSafeInteger(e.generation) ||
      e.generation < 0 ||
      !Number.isSafeInteger(e.position) ||
      e.position < 0
    )
      throw new Error("Invalid attachment identity or ordering");
    if (
      ![
        "snapshot",
        "resync",
        "output",
        "resize",
        "effect",
        "exit",
        "size-holder",
        "ended",
      ].includes(e.type)
    )
      throw new Error("Invalid attachment event");
    if (
      ["snapshot", "resync", "resize"].includes(e.type) &&
      (!e.size ||
        !Number.isSafeInteger(e.size.cols) ||
        e.size.cols <= 0 ||
        !Number.isSafeInteger(e.size.rows) ||
        e.size.rows <= 0)
    )
      throw new Error("Invalid terminal size");
    if (
      ["snapshot", "resync"].includes(e.type) &&
      !(e.snapshot instanceof Uint8Array)
    )
      throw new Error("Invalid snapshot bytes");
    if (e.type === "output" && !(e.data instanceof Uint8Array))
      throw new Error("Invalid output bytes");
    if (
      e.type === "effect" &&
      (!e.effect ||
        typeof e.effect.kind !== "string" ||
        !Number.isFinite(e.effect.time))
    )
      throw new Error("Invalid effect");
    if (
      e.type === "ended" &&
      !["detached", "session-ended", "connection-closed", "revoked"].includes(
        e.reason,
      )
    )
      throw new Error("Invalid end reason");
    if (e.type === "size-holder" && typeof e.holdsSize !== "boolean")
      throw new Error("Invalid size holder");
    if (
      e.type === "exit" &&
      (!e.exit || (e.exit.code !== null && !Number.isInteger(e.exit.code)))
    )
      throw new Error("Invalid exit");
  }
}

// --- Comparison encoder used only by the benchmark --------------------------

/** Option (b): base64 inside JSON, same frame header as today. */
export function encodeFrameBase64(
  message: WireMessage,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
): Uint8Array {
  const body = encoder.encode(
    JSON.stringify(message, function (key, value) {
      const original = this[key];
      return original instanceof Uint8Array
        ? { $b64: (original as any).toBase64() }
        : value;
    }),
  );
  if (body.length > maxFrameBytes)
    throw new SessionError("LIMIT", "Frame exceeds limit");
  const frame = new Uint8Array(4 + body.length);
  new DataView(frame.buffer).setUint32(0, body.length);
  frame.set(body, 4);
  return frame;
}
export function decodeBodyBase64(body: Uint8Array): WireMessage {
  const message = JSON.parse(decoder.decode(body), (_key, value) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "$b64" in value &&
    Object.keys(value).length === 1 &&
    typeof value.$b64 === "string"
      ? (Uint8Array as any).fromBase64(value.$b64)
      : value,
  );
  validate(message);
  return message;
}
