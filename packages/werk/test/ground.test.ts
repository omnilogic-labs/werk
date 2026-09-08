/**
 * The exchange with a terminal that may or may not answer.
 *
 * `detectGround` takes its streams as arguments, so every case here runs against
 * a pair of fakes: a terminal that answers, one that answers only the sentinel,
 * one that says nothing at all, and one that answers something unparseable. The
 * three terminators in the wild each get their own case.
 *
 * A real terminal sends the colour and the sentinel as two writes, so a reply
 * here is a list of chunks and the fake delivers them one at a time. It stops
 * delivering when the read is stopped and keeps what was left, which is how a
 * reply werk provoked and did not read is visible as a leak rather than as
 * nothing at all. That is the bytes that were being typed into whatever ran
 * next: a shell, a prompt, or the session `attach` was about to hand the
 * keyboard to.
 *
 * However the exchange ends, it has to leave the input as it found it: raw mode
 * off, the read stopped, and anything read that was not the answer put back.
 * All three are asserted across every ending, because the cost of missing one is
 * paid by every command rather than by this one.
 */
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { detectGround, type GroundInput } from "../src/runtime/ground.js";

/** What a terminal says back: nothing, one write, or a write at a time. */
type Answer = string | string[] | undefined;

/**
 * A terminal under test: what it was sent, and what it says back.
 *
 * `stopped` records the read being stopped, because that is what lets a command
 * exit. It holds the number of `data` listeners still attached at each pause,
 * so a stop that left the exchange's own listener behind is visible rather than
 * counted as a pass.
 *
 * `unread` is what the terminal still had to say when the read stopped. On a
 * real terminal those bytes sit in the input buffer for the next reader, so
 * anything left here is what somebody would find themselves typing.
 *
 * `back` is what the exchange handed back for the next reader.
 */
function fake(reply?: Answer | ((query: string) => Answer)) {
  const emitter = new EventEmitter();
  const raw: boolean[] = [];
  const sent: string[] = [];
  const stopped: number[] = [];
  const back: string[] = [];
  let pending: string[] = [];
  let paused = false;
  const input: GroundInput = {
    on: (event, listener) => emitter.on(event, listener),
    off: (event, listener) => emitter.off(event, listener),
    unshift: (chunk) => back.push(chunk.toString("latin1")),
    pause: () => {
      paused = true;
      stopped.push(emitter.listenerCount("data"));
    },
  };
  const io = {
    input,
    output: {
      write(text: string) {
        sent.push(text);
        const answer = typeof reply === "function" ? reply(text) : reply;
        if (answer === undefined) return true;
        pending = typeof answer === "string" ? [answer] : [...answer];
        // Asynchronously and a write at a time, the way a terminal would, and
        // never after the read has stopped.
        const say = () => {
          if (paused || pending.length === 0) return;
          emitter.emit("data", Buffer.from(pending.shift()!, "latin1"));
          if (pending.length > 0) setTimeout(say, 1);
        };
        queueMicrotask(say);
        return true;
      },
    },
    setRawMode: (on: boolean) => void raw.push(on),
    timeoutMs: 40,
  };
  return { io, raw, sent, stopped, back, unread: () => pending };
}

const LIGHT = "rgb:eeee/f1f1/f5f5";
const DARK = "rgb:1e1e/1e1e/2e2e";
const ST = "\x1b\\";
const BEL = "\x07";
const DA1 = "\x1b[?62;22c";
/** What a terminal that answers both questions says, as it says it. */
const answers = (colour: string, terminator = ST) => [
  `\x1b]11;${colour}${terminator}`,
  DA1,
];

test("the query carries the colour question and the sentinel behind it", async () => {
  const { io, sent } = fake();
  await detectGround(io);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toBe("\x1b]11;?\x1b\\\x1b[c");
});

test("a light ground and a dark ground each come back as themselves", async () => {
  expect(await detectGround(fake(answers(LIGHT)).io)).toBe("light");
  expect(await detectGround(fake(answers(DARK)).io)).toBe("dark");
});

test("all three terminators in the wild are read", async () => {
  // macOS Terminal answers with BEL even when asked with ST; rxvt-unicode ends
  // with a bare ESC.
  for (const terminator of [ST, BEL, "\x1b"])
    expect(
      await detectGround(fake(answers(DARK, terminator)).io),
      JSON.stringify(terminator),
    ).toBe("dark");
});

test("an eight-bit answer and a bare hex triple are read too", async () => {
  expect(await detectGround(fake(answers("rgb:ef/f1/f5")).io)).toBe("light");
  expect(await detectGround(fake(answers("#1e1e2e")).io)).toBe("dark");
});

test("the sentinel alone means the terminal does not answer, and returns at once", async () => {
  const { io } = fake(DA1);
  const started = performance.now();
  expect(await detectGround(io)).toBeUndefined();
  // Well inside the 40 ms this fake was given: the point of the sentinel is that
  // non-support costs a round trip rather than the whole timeout.
  expect(performance.now() - started).toBeLessThan(30);
});

test("the colour is taken and the exchange still runs to the sentinel", async () => {
  // The real ordering, and the real timing: two writes, colour first. Stopping
  // at the colour leaves the sentinel to be read by whatever reads stdin next,
  // which for `attach` means it is typed into the session.
  const terminal = fake(answers(DARK));
  expect(await detectGround(terminal.io)).toBe("dark");
  expect(terminal.unread()).toEqual([]);
});

test("both replies arriving as one write are read as one write", async () => {
  const terminal = fake([`\x1b]11;${DARK}${ST}${DA1}`]);
  expect(await detectGround(terminal.io)).toBe("dark");
  expect(terminal.unread()).toEqual([]);
  expect(terminal.back).toEqual([]);
});

test("a terminal that says nothing gives up at the timeout", async () => {
  const started = performance.now();
  expect(await detectGround(fake().io)).toBeUndefined();
  expect(performance.now() - started).toBeGreaterThanOrEqual(30);
});

test("a colour with no sentinel behind it costs the timeout", async () => {
  // The one terminal that pays for reading to the sentinel: it answers the
  // question and not the device attributes request. It still gets its flavour.
  const started = performance.now();
  expect(await detectGround(fake(`\x1b]11;${DARK}${ST}`).io)).toBe("dark");
  expect(performance.now() - started).toBeGreaterThanOrEqual(30);
});

test("an answer that cannot be read is no answer rather than a failure", async () => {
  expect(await detectGround(fake([`\x1b]11;rgb:zz/zz/zz${ST}`, DA1]).io)).toBe(
    undefined,
  );
  expect(await detectGround(fake(["garbage", DA1]).io)).toBeUndefined();
});

test("a reply nobody could parse still comes off the stream", async () => {
  // It was werk's question, so it is werk's to take, whether or not it made
  // sense. Only `garbage` was somebody typing.
  const terminal = fake([`\x1b]11;rgb:zz/zz/zz${ST}`, `garbage${DA1}`]);
  expect(await detectGround(terminal.io)).toBeUndefined();
  expect(terminal.back).toEqual(["garbage"]);
});

/** Every way the exchange can end: answered, refused, timed out, unreadable. */
const ENDINGS: Answer[] = [
  answers(LIGHT),
  answers(DARK, BEL),
  DA1,
  undefined,
  [`\x1b]11;rgb:zz/zz/zz${ST}`, DA1],
];

test("raw mode is put back however the exchange ends", async () => {
  for (const reply of ENDINGS) {
    const { io, raw } = fake(reply);
    await detectGround(io);
    expect(raw, JSON.stringify(reply)).toEqual([true, false]);
  }
});

test("the read is stopped however the exchange ends", async () => {
  // A read left running holds the event loop open, so every command that pays
  // for the probe would print its output and then never exit.
  for (const reply of ENDINGS) {
    const { io, stopped } = fake(reply);
    await detectGround(io);
    // Stopped once, and with the exchange's own listener already taken off, so
    // a stream handed back to `attach` or a prompt carries nothing of ours.
    expect(stopped, JSON.stringify(reply)).toEqual([0]);
  }
});

test("the answer is kept and nothing else is, however the exchange ends", async () => {
  for (const reply of ENDINGS) {
    const { io, back } = fake(reply);
    await detectGround(io);
    expect(back, JSON.stringify(reply)).toEqual([]);
  }
});

test("what was typed during the exchange is given back", async () => {
  // Somebody typing ahead while the probe runs. The bytes are not werk's, so
  // they go back on the stream for the shell, the prompt or the session.
  const withColour = fake([`\x1b]11;${DARK}${ST}hi`, DA1]);
  expect(await detectGround(withColour.io)).toBe("dark");
  expect(withColour.back).toEqual(["hi"]);

  const between = fake([`\x1b]11;${DARK}${ST}`, `up${DA1}down`]);
  expect(await detectGround(between.io)).toBe("dark");
  expect(between.back).toEqual(["updown"]);
});

test("what was typed into a terminal that never answers is given back too", async () => {
  const silent = fake("typed");
  expect(await detectGround(silent.io)).toBeUndefined();
  expect(silent.back).toEqual(["typed"]);
});

test("bytes are handed back as they arrived", async () => {
  // Not decoded and re-encoded: a byte that is not this process's idea of text
  // still has to come back as itself.
  const bytes = "\x80\xff\xfe";
  const terminal = fake([`\x1b]11;${DARK}${ST}${bytes}`, DA1]);
  await detectGround(terminal.io);
  expect(terminal.back).toEqual([bytes]);
});

test("a terminal that cannot be written to is not an error", async () => {
  const { io, raw, stopped } = fake();
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
  expect(stopped).toEqual([0]);
});
