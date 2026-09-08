/**
 * Asking a terminal what colour its background is.
 *
 * This is the only part of the theme that does I/O, and it is a separate file so
 * that the deciding in `theme.ts` stays pure. The streams arrive as arguments
 * rather than being reached for, which is what makes the whole protocol — the
 * sentinel, the three terminators, the timeout, a malformed reply — testable
 * with a pair of fakes and no terminal at all.
 *
 * ## The exchange
 *
 * werk writes `OSC 11 ; ?` and then, immediately behind it, a primary device
 * attributes request. A terminal processes escape sequences in order, so if the
 * device attributes reply comes back with no colour reply in front of it, this
 * terminal does not answer `OSC 11` and there is nothing to wait for. That is
 * what makes a short timeout defensible: the common failure answers instantly
 * rather than running the clock out. Almost every terminal answers device
 * attributes, including werk's own replica, which answers `ESC [ ? 62 ; 22 c`
 * and nothing else.
 *
 * The reply is `OSC 11 ; rgb:RRRR/GGGG/BBBB` with sixteen bits a channel, and
 * three different terminators are in the wild: macOS Terminal always ends with
 * BEL even when asked with ST, and rxvt-unicode ends with a bare ESC. All three
 * are accepted. Some terminals answer with eight bits a channel or with a plain
 * hex triple, so those are read too.
 *
 * ## The timeout
 *
 * 150 ms, and it is a judgement rather than a measurement. A terminal that
 * answers either sequence replies in single figures of milliseconds; the wait is
 * only ever paid by one that answers neither, which is a small set. It is set
 * against a startup that is otherwise about 30 ms, and long enough to survive a
 * round trip over ssh. If it turns out to be short, the evidence will be a
 * terminal that answers late rather than a number anybody has measured.
 *
 * Raw mode is restored on every path, including the one where parsing throws,
 * because leaving a shell without its echo is worse than getting the wrong
 * flavour.
 */
import { type Ground, groundFromRgb } from "./theme.js";

/** The query, and the sentinel that tells werk the query went unanswered. */
const QUERY = "\x1b]11;?\x1b\\\x1b[c";
/** A primary device attributes reply: `ESC [ ? … c`. */
const ATTRIBUTES = /\x1b\[\?[0-9;]*c/;
/**
 * `OSC 11 ; ` then a colour, then BEL, ST or a bare ESC. Channels are one to
 * four hex digits each, because the width varies by terminal.
 */
const REPLY =
  /\x1b\]11;(?:rgb:)?#?([0-9a-fA-F]{1,4})\/?([0-9a-fA-F]{1,4})\/?([0-9a-fA-F]{1,4})/;

/** Scale a channel of any width to eight bits. `ff` and `ffff` are both white. */
function channel(digits: string): number {
  const value = Number.parseInt(digits, 16);
  const max = 16 ** digits.length - 1;
  return Math.round((value / max) * 255);
}

/** What the exchange needs, so that a test can supply all of it. */
export interface GroundIO {
  /** Where the terminal's reply arrives. */
  readonly input: NodeJS.ReadableStream;
  /** Where the query goes. */
  readonly output: { write(text: string): unknown };
  /** Put the input into and out of raw mode. */
  setRawMode(on: boolean): void;
  readonly timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 150;

export function detectGround(io: GroundIO): Promise<Ground | undefined> {
  const timeoutMs = io.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<Ground | undefined>((resolve) => {
    let seen = "";
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (ground: Ground | undefined): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      io.input.off?.("data", onData);
      try {
        io.setRawMode(false);
      } catch {
        // The stream may already be gone. Nothing here is worth failing over.
      }
      resolve(ground);
    };

    function onData(chunk: Buffer | string): void {
      seen += chunk.toString();
      try {
        const reply = REPLY.exec(seen);
        if (reply) {
          finish(
            groundFromRgb(
              channel(reply[1]!),
              channel(reply[2]!),
              channel(reply[3]!),
            ),
          );
          return;
        }
        // The sentinel arrived with no colour in front of it, so this terminal
        // does not answer the question. Stop rather than wait out the clock.
        if (ATTRIBUTES.test(seen)) finish(undefined);
      } catch {
        finish(undefined);
      }
    }

    try {
      io.setRawMode(true);
      io.input.on("data", onData);
      io.output.write(QUERY);
    } catch {
      finish(undefined);
      return;
    }
    timer = setTimeout(() => finish(undefined), timeoutMs);
    // A pending read must not be the reason the process stays alive.
    timer.unref?.();
  });
}
