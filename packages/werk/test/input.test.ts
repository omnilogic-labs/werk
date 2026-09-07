import { expect, test } from "bun:test";
import {
  createInputPump,
  INPUT_CHUNK_BYTES,
  INPUT_MAX_BYTES,
  INPUT_MAX_REQUESTS,
  inputSliceBytes,
  type InputPumpOptions,
} from "../src/input.js";
interface Recorder {
  writes: Uint8Array[];
  peakRequests: number;
  peakBytes: number;
  pauses: number;
  resumes: number;
  release(): void;
  releaseAll(): void;
  outstanding(): number;
}
/** A fake attachment whose writes settle only when the test releases them. */
function harness(
  overrides: Partial<InputPumpOptions> = {},
  reject?: (index: number) => unknown,
) {
  const settle: (() => void)[] = [];
  const recorder: Recorder = {
    writes: [],
    peakRequests: 0,
    peakBytes: 0,
    pauses: 0,
    resumes: 0,
    release() {
      settle.shift()?.();
    },
    releaseAll() {
      while (settle.length) settle.shift()!();
    },
    outstanding: () => settle.length,
  };
  const pump = createInputPump({
    sink: {
      writeInput(data) {
        const index = recorder.writes.length;
        recorder.writes.push(data);
        return new Promise<void>((resolve, rejectWrite) => {
          settle.push(() => {
            const failure = reject?.(index);
            if (failure) rejectWrite(failure);
            else resolve();
          });
        });
      },
    },
    pause: () => {
      recorder.pauses += 1;
    },
    resume: () => {
      recorder.resumes += 1;
    },
    onError: () => {},
    ...overrides,
  });
  const sample = () => {
    recorder.peakRequests = Math.max(
      recorder.peakRequests,
      pump.requestsInFlight,
    );
    recorder.peakBytes = Math.max(recorder.peakBytes, pump.bytesInFlight);
  };
  return { pump, recorder, sample };
}
const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);
test("input pipelines up to the request bound without waiting for each ack", async () => {
  const { pump, recorder, sample } = harness();
  for (let i = 0; i < 100; i += 1) {
    pump.offer(new Uint8Array([i]));
    sample();
  }
  // The window, not the round trip, is what limits how much is outstanding.
  expect(recorder.writes.length).toBe(INPUT_MAX_REQUESTS);
  expect(recorder.peakRequests).toBe(INPUT_MAX_REQUESTS);
  expect(recorder.pauses).toBe(1);
  // Each acknowledgement admits exactly one queued keystroke.
  recorder.release();
  await Promise.resolve();
  expect(recorder.writes.length).toBe(INPUT_MAX_REQUESTS + 1);
  const done = pump.drained();
  while (recorder.outstanding()) {
    recorder.releaseAll();
    await Promise.resolve();
  }
  await done;
  expect(recorder.writes.length).toBe(100);
  expect(recorder.writes.map((w) => w[0])).toEqual(
    Array.from({ length: 100 }, (_, i) => i),
  );
  expect(pump.requestsInFlight).toBe(0);
  expect(pump.bytesInFlight).toBe(0);
});
test("a large paste is bounded by bytes in flight and resumes when it drains", async () => {
  const { pump, recorder, sample } = harness();
  pump.offer(bytes(1024 * 1024, 65));
  sample();
  expect(pump.bytesInFlight).toBeLessThanOrEqual(INPUT_MAX_BYTES);
  expect(recorder.writes.length).toBe(INPUT_MAX_BYTES / INPUT_CHUNK_BYTES);
  expect(recorder.pauses).toBe(1);
  expect(recorder.resumes).toBe(0);
  const done = pump.drained();
  let delivered = 0;
  while (recorder.outstanding()) {
    recorder.releaseAll();
    await Promise.resolve();
    sample();
    delivered += 1;
    expect(pump.bytesInFlight).toBeLessThanOrEqual(INPUT_MAX_BYTES);
  }
  await done;
  expect(delivered).toBeGreaterThan(1);
  expect(recorder.peakBytes).toBeLessThanOrEqual(INPUT_MAX_BYTES);
  expect(recorder.writes.reduce((n, w) => n + w.byteLength, 0)).toBe(
    1024 * 1024,
  );
  // Backpressure is released once the window empties.
  expect(recorder.resumes).toBe(1);
});
test("the pump copies the source buffer", async () => {
  const { pump, recorder } = harness();
  const reused = new Uint8Array([1, 2, 3]);
  pump.offer(reused);
  reused.fill(9);
  expect(Array.from(recorder.writes[0]!)).toEqual([1, 2, 3]);
});
test("stdin stays flowing while the window has room", () => {
  const { pump, recorder } = harness();
  pump.offer(new Uint8Array([7]));
  expect(recorder.pauses).toBe(0);
  expect(recorder.resumes).toBe(0);
  expect(pump.requestsInFlight).toBe(1);
});
test("a rejected write reports once, drops the backlog and drains", async () => {
  const failures: unknown[] = [];
  const { pump, recorder } = harness(
    { onError: (error) => failures.push(error) },
    (index) => (index < 2 ? new Error(`refused ${index}`) : undefined),
  );
  for (let i = 0; i < 100; i += 1) pump.offer(new Uint8Array([i]));
  const done = pump.drained();
  recorder.releaseAll();
  await done;
  expect(failures.length).toBe(1);
  expect((failures[0] as Error).message).toBe("refused 0");
  // Nothing queued behind the failure is sent.
  expect(recorder.writes.length).toBe(INPUT_MAX_REQUESTS);
  expect(pump.requestsInFlight).toBe(0);
  // Later offers are refused too, so a finished attachment cannot resurrect it.
  pump.offer(new Uint8Array([200]));
  expect(recorder.writes.length).toBe(INPUT_MAX_REQUESTS);
});
test("detaching after offering still delivers the bytes already accepted", async () => {
  // The attach loop finishes on Ctrl-] and then awaits drained(), so input
  // sharing a chunk with the detach byte is written before the attachment ends.
  const { pump, recorder } = harness();
  const chunk = new Uint8Array([104, 105, 29, 120]);
  const at = chunk.indexOf(29);
  pump.offer(chunk.subarray(0, at));
  let detached = false;
  const done = pump.drained().then(() => {
    detached = true;
  });
  expect(detached).toBe(false);
  recorder.releaseAll();
  await done;
  expect(detached).toBe(true);
  expect(recorder.writes.length).toBe(1);
  expect(Array.from(recorder.writes[0]!)).toEqual([104, 105]);
});
test("a window smaller than one slice still makes progress", async () => {
  const { pump, recorder } = harness({ maxBytes: 4, chunkBytes: 8 });
  pump.offer(bytes(24, 66));
  expect(recorder.writes.length).toBe(1);
  const done = pump.drained();
  while (recorder.outstanding()) {
    recorder.releaseAll();
    await Promise.resolve();
  }
  await done;
  expect(recorder.writes.length).toBe(3);
});
/**
 * A sink that behaves as `Attachment.writeInput` does: it splits anything
 * larger than `chunk` and awaits each request serially. Two concurrent calls
 * with oversized slices therefore interleave their requests.
 */
function splittingSink(chunk: number, delivered: number[][]) {
  return {
    async writeInput(data: Uint8Array) {
      for (let offset = 0; offset < data.byteLength; offset += chunk) {
        const piece = data.subarray(offset, offset + chunk);
        await Promise.resolve();
        delivered.push(Array.from(piece));
      }
    },
  };
}
test("a slice never spans more than one request of the negotiated chunk", async () => {
  // inputSliceBytes is what keeps one slice equal to one request; without the
  // clamp the pump would hand oversized slices to a serially splitting sink.
  const clientChunk = 4;
  const delivered: number[][] = [];
  const pump = createInputPump({
    sink: splittingSink(clientChunk, delivered),
    chunkBytes: inputSliceBytes(clientChunk),
    pause: () => {},
    resume: () => {},
    onError: (error) => {
      throw error;
    },
  });
  const source = new Uint8Array(64);
  for (let i = 0; i < source.length; i += 1) source[i] = i;
  // Several chunks in one burst, as a paste or a held key arrives.
  for (let offset = 0; offset < source.length; offset += 16)
    pump.offer(source.subarray(offset, offset + 16));
  await pump.drained();
  expect(delivered.flat()).toEqual(Array.from(source));
});
test("an unclamped slice does interleave, which is why the clamp exists", async () => {
  const delivered: number[][] = [];
  const pump = createInputPump({
    sink: splittingSink(4, delivered),
    chunkBytes: 16,
    pause: () => {},
    resume: () => {},
    onError: (error) => {
      throw error;
    },
  });
  const source = new Uint8Array(64);
  for (let i = 0; i < source.length; i += 1) source[i] = i;
  for (let offset = 0; offset < source.length; offset += 16)
    pump.offer(source.subarray(offset, offset + 16));
  await pump.drained();
  expect(delivered.flat()).not.toEqual(Array.from(source));
});
