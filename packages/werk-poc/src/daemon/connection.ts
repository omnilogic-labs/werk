// One client connection: its socket, its parser, and the bounded outbound
// queue that implements the proposal's §4 rule.
//
// Every frame the daemon wants to send goes through `send`. Control frames
// and render frames are always queued. Raw output frames are droppable:
// when the queue would grow past QUEUE_BOUND the queued output is thrown
// away, the connection is marked lagging and told so, and no further output
// is queued until the kernel has drained what was already in flight. At
// that point the session re-emits its screen into one render frame, the
// client is told it has resumed, and streaming continues. The PTY is never
// paused for a viewer, and a slow viewer never holds a fast one back,
// because each connection has its own queue and its own socket.
//
// The kernel's own buffer is the first stage: `socket.write` returns the
// bytes it accepted and `drain` fires when there is room again. The queue
// is the second stage, holding what the kernel would not take.

import type { Socket } from "bun";
import {
  encodeControl,
  encodeFrame,
  FrameParser,
  FrameType,
  type ConnectionStats,
  type DaemonMessage,
} from "../protocol/index.ts";

export const QUEUE_BOUND = 256 * 1024;

interface Queued {
  bytes: Uint8Array;
  offset: number;
  droppable: boolean;
}

export interface ConnectionHost {
  /** Bytes to send when this connection catches up after lagging. */
  renderFor(conn: Connection): Uint8Array | null;
  log(line: string): void;
}

export class Connection {
  readonly parser = new FrameParser();
  /** The session this connection is attached to, if any. */
  attached: { id: string; readOnly: boolean } | null = null;
  helloDone = false;
  closed = false;
  /** This connection has been told once that its input is going nowhere (a corpse). */
  noticed = false;

  private queue: Queued[] = [];
  private queuedBytes = 0;
  private waitingDrain = false;
  lagging = false;
  private lastShortAt: number | null = null;

  // accounting for findings/m2.md
  private maxQueuedBytes = 0;
  private droppedBytes = 0;
  private lagCount = 0;
  private shortWrites = 0;
  private drains = 0;
  private firstShortWriteAfterBytes: number | null = null;
  private lastDrainLatencyMs: number | null = null;
  private bytesSent = 0;

  constructor(
    readonly socket: Socket<Connection>,
    private readonly host: ConnectionHost,
    readonly seq: number,
  ) {}

  sendControl(msg: DaemonMessage): void {
    this.send(encodeControl(msg), false);
  }

  /** Live PTY output; droppable. `frame` is already encoded so sessions can share one buffer across clients. */
  sendOutputFrame(frame: Uint8Array): void {
    this.send(frame, true);
  }

  sendRender(bytes: Uint8Array): void {
    this.send(encodeFrame(FrameType.render, bytes), false);
  }

  private send(frame: Uint8Array, droppable: boolean): void {
    if (this.closed) return;
    if (droppable) {
      if (this.lagging) {
        this.droppedBytes += frame.length;
        return;
      }
      if (this.queuedBytes + frame.length > QUEUE_BOUND) {
        this.enterLag(frame.length);
        return;
      }
    }
    this.queue.push({ bytes: frame, offset: 0, droppable });
    this.queuedBytes += frame.length;
    if (this.queuedBytes > this.maxQueuedBytes)
      this.maxQueuedBytes = this.queuedBytes;
    if (!this.waitingDrain) this.flush();
  }

  private enterLag(incoming: number): void {
    let dropped = incoming;
    const keep: Queued[] = [];
    this.queue.forEach((q, i) => {
      // A frame the kernel has taken part of cannot be dropped without
      // corrupting the stream, so a partially written head stays.
      const partial = i === 0 && q.offset > 0;
      if (q.droppable && !partial) {
        dropped += q.bytes.length - q.offset;
        this.queuedBytes -= q.bytes.length - q.offset;
      } else keep.push(q);
    });
    this.queue = keep;
    this.lagging = true;
    this.lagCount++;
    this.droppedBytes += dropped;
    this.host.log(
      `conn ${this.seq}: lagging, dropped ${dropped} bytes, ${this.queuedBytes} control bytes still queued`,
    );
    if (this.attached) {
      this.sendControl({
        t: "lagging",
        id: this.attached.id,
        droppedBytes: dropped,
      });
    }
  }

  /** Writes as much of the queue as the kernel will take. */
  private flush(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0]!;
      const remaining = head.bytes.length - head.offset;
      const n = this.socket.write(head.bytes, head.offset, remaining);
      if (n < 0) {
        this.closed = true;
        return;
      }
      this.bytesSent += n;
      this.queuedBytes -= n;
      if (n < remaining) {
        head.offset += n;
        this.shortWrites++;
        this.lastShortAt = performance.now();
        if (this.firstShortWriteAfterBytes === null)
          this.firstShortWriteAfterBytes = this.bytesSent;
        this.waitingDrain = true;
        // A short write on a control frame means a reply is now waiting on
        // `drain`; worth a line in the log, since a drain that never comes
        // would look like a daemon that never answers.
        if (!head.droppable)
          this.host.log(
            `conn ${this.seq}: short write on a control frame (${n} of ${remaining}), ${this.queuedBytes} B queued, waiting for drain`,
          );
        return;
      }
      this.queue.shift();
    }
    this.waitingDrain = false;
    if (this.lagging) this.resume();
  }

  private resume(): void {
    this.lagging = false;
    const render = this.host.renderFor(this);
    if (render && this.attached) {
      this.host.log(
        `conn ${this.seq}: resumed with a ${render.length}-byte render`,
      );
      this.sendRender(render);
      this.sendControl({ t: "resumed", id: this.attached.id });
    }
  }

  /** The socket's `drain` handler: the kernel has room again. */
  onDrain(): void {
    this.drains++;
    if (this.lastShortAt !== null) {
      this.lastDrainLatencyMs = performance.now() - this.lastShortAt;
      this.lastShortAt = null;
    }
    this.waitingDrain = false;
    this.flush();
  }

  stats(): ConnectionStats {
    return {
      attached: this.attached?.id ?? null,
      readOnly: this.attached?.readOnly ?? false,
      lagging: this.lagging,
      queuedBytes: this.queuedBytes,
      maxQueuedBytes: this.maxQueuedBytes,
      droppedBytes: this.droppedBytes,
      lagCount: this.lagCount,
      shortWrites: this.shortWrites,
      drains: this.drains,
      firstShortWriteAfterBytes: this.firstShortWriteAfterBytes,
      lastDrainLatencyMs: this.lastDrainLatencyMs,
      bytesSent: this.bytesSent,
    };
  }

  end(): void {
    this.closed = true;
    try {
      this.socket.end();
    } catch {}
  }
}
