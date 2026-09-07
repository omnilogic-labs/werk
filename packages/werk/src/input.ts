/**
 * Bounded input pipelining for an attachment.
 *
 * The wire carries one framed stream and the daemon handles a connection's
 * requests serially, so input requests are applied in the order they are sent.
 * The pump therefore issues several unacknowledged `input` requests at once and
 * uses the window only for flow control: stdin pauses when the window is full
 * or a backlog is queued, and resumes once the window drains.
 */
export interface InputSink {
  writeInput(data: Uint8Array): Promise<void>;
}
export interface InputPumpOptions {
  sink: InputSink;
  /** Called when the source should stop delivering data. */
  pause(): void;
  /** Called when the source may deliver data again. */
  resume(): void;
  /** Called once, with the first rejection from an in-flight write. */
  onError(error: unknown): void;
  maxRequests?: number;
  maxBytes?: number;
  chunkBytes?: number;
}
export interface InputPump {
  /** Copy `data` into the window, sending as much of it as the window allows. */
  offer(data: Uint8Array): void;
  /** Resolves when nothing is queued and every issued write has settled. */
  drained(): Promise<void>;
  readonly requestsInFlight: number;
  readonly bytesInFlight: number;
}
/** Unacknowledged requests allowed before the source is paused. */
export const INPUT_MAX_REQUESTS = 32;
/** Unacknowledged bytes allowed before the source is paused. */
export const INPUT_MAX_BYTES = 64 * 1024;
/** Preferred slice size, subject to {@link inputSliceBytes}. */
export const INPUT_CHUNK_BYTES = 16384;
/**
 * A slice must not exceed the client's own input chunk. `Attachment.writeInput`
 * splits anything larger and awaits each piece serially, so two concurrent
 * writes of oversized slices interleave their requests (A1, B1, A2, B2) and the
 * bytes reach the PTY out of order. One slice being one request is what makes
 * pipelining safe; clamp rather than assume the negotiated budget is generous.
 */
export function inputSliceBytes(clientChunkBytes: number): number {
  return Math.max(1, Math.min(INPUT_CHUNK_BYTES, clientChunkBytes));
}
export function createInputPump(options: InputPumpOptions): InputPump {
  const maxRequests = options.maxRequests ?? INPUT_MAX_REQUESTS;
  const maxBytes = options.maxBytes ?? INPUT_MAX_BYTES;
  const chunkBytes = options.chunkBytes ?? INPUT_CHUNK_BYTES;
  const queue: Uint8Array[] = [];
  const waiters: (() => void)[] = [];
  let requests = 0;
  let bytes = 0;
  let failed = false;
  let flowing = true;
  const idle = () => queue.length === 0 && requests === 0;
  const wake = () => {
    if (!idle()) return;
    for (const waiter of waiters.splice(0)) waiter();
  };
  const flow = () => {
    const open =
      !failed &&
      queue.length === 0 &&
      requests < maxRequests &&
      bytes < maxBytes;
    if (open === flowing) return;
    flowing = open;
    if (open) options.resume();
    else options.pause();
  };
  const flush = () => {
    while (!failed && queue.length) {
      const slice = queue[0]!;
      if (requests >= maxRequests) break;
      // Always admit one slice, so a window smaller than a slice still drains.
      if (requests > 0 && bytes + slice.byteLength > maxBytes) break;
      queue.shift();
      requests += 1;
      bytes += slice.byteLength;
      void options.sink.writeInput(slice).then(
        () => {
          requests -= 1;
          bytes -= slice.byteLength;
          flush();
          wake();
        },
        (error: unknown) => {
          requests -= 1;
          bytes -= slice.byteLength;
          if (!failed) {
            failed = true;
            queue.length = 0;
            options.onError(error);
          }
          flow();
          wake();
        },
      );
    }
    flow();
  };
  return {
    offer(data) {
      if (failed || data.byteLength === 0) return;
      // Copy: the source may reuse its buffer once the handler returns.
      for (let offset = 0; offset < data.byteLength; offset += chunkBytes)
        queue.push(new Uint8Array(data.subarray(offset, offset + chunkBytes)));
      flush();
    },
    drained() {
      if (idle()) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    get requestsInFlight() {
      return requests;
    },
    get bytesInFlight() {
      return bytes;
    },
  };
}
