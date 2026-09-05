import {
  SessionError,
  type AttachmentEvent,
  type DaemonEvent,
  type DaemonInfo,
  type Principal,
  type ErrorCode,
} from "./types.js";
export * from "./types.js";
export const PROTOCOL_VERSION = 1;
export interface Transport {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(reason?: unknown): void | Promise<void>;
}
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
  maxFrameBytes = 8 * 1024 * 1024,
): Uint8Array {
  const body = encoder.encode(
    JSON.stringify(message, (_key, value) =>
      value instanceof Uint8Array ? { $bytes: Array.from(value) } : value,
    ),
  );
  if (body.length > maxFrameBytes)
    throw new SessionError("LIMIT", "Frame exceeds limit");
  const frame = new Uint8Array(4 + body.length);
  new DataView(frame.buffer).setUint32(0, body.length);
  frame.set(body, 4);
  return frame;
}
export class FrameDecoder {
  private buffer = new Uint8Array(0);
  constructor(private readonly maxFrameBytes = 8 * 1024 * 1024) {}
  push(chunk: Uint8Array): WireMessage[] {
    const data = new Uint8Array(this.buffer.length + chunk.length);
    data.set(this.buffer);
    data.set(chunk, this.buffer.length);
    let offset = 0;
    const messages: WireMessage[] = [];
    while (data.length - offset >= 4) {
      const length = new DataView(
        data.buffer,
        data.byteOffset + offset,
        4,
      ).getUint32(0);
      if (length === 0 || length > this.maxFrameBytes)
        throw new SessionError("PROTOCOL", "Invalid frame length");
      if (data.length - offset - 4 < length) break;
      try {
        const message = JSON.parse(
          decoder.decode(data.subarray(offset + 4, offset + 4 + length)),
          (_key, value) => {
            if (
              value &&
              typeof value === "object" &&
              Object.keys(value).length === 1 &&
              "$bytes" in value
            ) {
              if (
                !Array.isArray(value.$bytes) ||
                !value.$bytes.every(
                  (n: unknown) =>
                    typeof n === "number" &&
                    Number.isInteger(n) &&
                    n >= 0 &&
                    n <= 255,
                )
              )
                throw new Error("Invalid byte array");
              return Uint8Array.from(value.$bytes);
            }
            return value;
          },
        );
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
        if (
          message.type === "hello" &&
          !Number.isInteger(message.protocolVersion)
        )
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
            ![
              "detached",
              "session-ended",
              "connection-closed",
              "revoked",
            ].includes(e.reason)
          )
            throw new Error("Invalid end reason");
          if (e.type === "size-holder" && typeof e.holdsSize !== "boolean")
            throw new Error("Invalid size holder");
          if (
            e.type === "exit" &&
            (!e.exit ||
              (e.exit.code !== null && !Number.isInteger(e.exit.code)))
          )
            throw new Error("Invalid exit");
        }
        messages.push(message);
      } catch (error) {
        throw new SessionError("PROTOCOL", `Malformed frame: ${String(error)}`);
      }
      offset += 4 + length;
    }
    this.buffer = data.slice(offset);
    return messages;
  }
  finish(): void {
    if (this.buffer.length)
      throw new SessionError("PROTOCOL", "Truncated frame");
  }
}
export class FramedTransport {
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private ended = false;
  private queuedBytes = 0;
  constructor(
    private readonly transport: Transport,
    private readonly maxFrameBytes = 8 * 1024 * 1024,
    private readonly maxQueuedBytes = 16 * 1024 * 1024,
  ) {
    this.writer = transport.writable.getWriter();
  }
  async send(message: WireMessage): Promise<void> {
    if (this.ended) throw new SessionError("CLOSED", "Transport closed");
    const bytes = encodeFrame(message, this.maxFrameBytes);
    if (this.queuedBytes + bytes.length > this.maxQueuedBytes)
      throw new SessionError("LIMIT", "Transport queue is full");
    this.queuedBytes += bytes.length;
    try {
      await this.writer.write(bytes);
    } finally {
      this.queuedBytes -= bytes.length;
    }
  }
  async *messages(): AsyncGenerator<WireMessage> {
    if (this.reader)
      throw new SessionError("CONFLICT", "Transport already has a reader");
    this.reader = this.transport.readable.getReader();
    const decoder = new FrameDecoder(this.maxFrameBytes);
    try {
      while (!this.ended) {
        const next = await this.reader.read();
        if (next.done) {
          decoder.finish();
          return;
        }
        for (const message of decoder.push(next.value)) yield message;
      }
    } finally {
      this.reader.releaseLock();
      this.reader = undefined;
    }
  }
  async close(reason?: unknown): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    // A writer's abort can wait forever behind a stalled underlying write.
    // Closing the owned transport is the cancellation boundary; do not await
    // stream aborts, which merely release stream consumers when possible.
    void this.reader?.cancel(reason).catch(() => {});
    void this.writer.abort(reason).catch(() => {});
    await this.transport.close(reason);
  }
}
