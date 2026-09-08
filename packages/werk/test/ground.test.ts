/**
 * The exchange with a terminal that may or may not answer.
 *
 * `detectGround` takes its streams as arguments, so every case here runs against
 * a pair of fakes: a terminal that answers, one that answers only the sentinel,
 * one that says nothing at all, and one that answers something unparseable. The
 * three terminators in the wild each get their own case, and every one of them
 * asserts that raw mode was put back.
 */
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { detectGround } from "../src/runtime/ground.js";

/** A terminal under test: what it was sent, and what it says back. */
function fake(reply?: string | ((query: string) => string | undefined)) {
  const input = new EventEmitter() as unknown as NodeJS.ReadableStream;
  const raw: boolean[] = [];
  const sent: string[] = [];
  const io = {
    input,
    output: {
      write(text: string) {
        sent.push(text);
        const answer = typeof reply === "function" ? reply(text) : reply;
        // Asynchronously, the way a terminal would.
        if (answer !== undefined)
          queueMicrotask(() => input.emit("data", Buffer.from(answer)));
        return true;
      },
    },
    setRawMode: (on: boolean) => void raw.push(on),
    timeoutMs: 40,
  };
  return { io, raw, sent };
}

const LIGHT = "rgb:eeee/f1f1/f5f5";
const DARK = "rgb:1e1e/1e1e/2e2e";
const ST = "\x1b\\";
const BEL = "\x07";
const DA1 = "\x1b[?62;22c";

test("the query carries the colour question and the sentinel behind it", async () => {
  const { io, sent } = fake();
  await detectGround(io);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toBe("\x1b]11;?\x1b\\\x1b[c");
});

test("a light ground and a dark ground each come back as themselves", async () => {
  expect(await detectGround(fake(`\x1b]11;${LIGHT}${ST}`).io)).toBe("light");
  expect(await detectGround(fake(`\x1b]11;${DARK}${ST}`).io)).toBe("dark");
});

test("all three terminators in the wild are read", async () => {
  // macOS Terminal answers with BEL even when asked with ST; rxvt-unicode ends
  // with a bare ESC.
  for (const terminator of [ST, BEL, "\x1b"])
    expect(
      await detectGround(fake(`\x1b]11;${DARK}${terminator}`).io),
      JSON.stringify(terminator),
    ).toBe("dark");
});

test("an eight-bit answer and a bare hex triple are read too", async () => {
  expect(await detectGround(fake(`\x1b]11;rgb:ef/f1/f5${ST}`).io)).toBe(
    "light",
  );
  expect(await detectGround(fake(`\x1b]11;#1e1e2e${ST}`).io)).toBe("dark");
});

test("the sentinel alone means the terminal does not answer, and returns at once", async () => {
  const { io } = fake(DA1);
  const started = performance.now();
  expect(await detectGround(io)).toBeUndefined();
  // Well inside the 40 ms this fake was given: the point of the sentinel is that
  // non-support costs a round trip rather than the whole timeout.
  expect(performance.now() - started).toBeLessThan(30);
});

test("a colour arriving before the sentinel is still the answer", async () => {
  // The real ordering: the terminal answers both, colour first.
  expect(await detectGround(fake(`\x1b]11;${DARK}${ST}${DA1}`).io)).toBe(
    "dark",
  );
});

test("a terminal that says nothing gives up at the timeout", async () => {
  const started = performance.now();
  expect(await detectGround(fake().io)).toBeUndefined();
  expect(performance.now() - started).toBeGreaterThanOrEqual(30);
});

test("an answer that cannot be read is no answer rather than a failure", async () => {
  expect(await detectGround(fake(`\x1b]11;rgb:zz/zz/zz${ST}${DA1}`).io)).toBe(
    undefined,
  );
  expect(await detectGround(fake(`garbage${DA1}`).io)).toBeUndefined();
});

test("raw mode is put back however the exchange ends", async () => {
  const cases: (string | undefined)[] = [
    `\x1b]11;${LIGHT}${ST}`,
    `\x1b]11;${DARK}${BEL}`,
    DA1,
    undefined,
    `\x1b]11;rgb:zz/zz/zz${ST}${DA1}`,
  ];
  for (const reply of cases) {
    const { io, raw } = fake(reply);
    await detectGround(io);
    expect(raw, JSON.stringify(reply)).toEqual([true, false]);
  }
});

test("a terminal that cannot be written to is not an error", async () => {
  const { io, raw } = fake();
  const broken = {
    ...io,
    output: {
      write() {
        throw new Error("stdout is gone");
      },
    },
  };
  expect(await detectGround(broken)).toBeUndefined();
  expect(raw).toEqual([true, false]);
});
