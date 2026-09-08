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
 * attributes request. A terminal processes escape sequences in order, so the
 * attributes reply comes back behind the colour reply when there is one and on
 * its own when there is not.
 *
 * The attributes reply is therefore the end of the exchange either way, and the
 * colour is only the payload that may or may not arrive in front of it. Almost
 * every terminal answers device attributes, including werk's own replica, which
 * answers `ESC [ ? 62 ; 22 c` and nothing else, so a terminal that does not
 * answer the colour question is found out in one round trip rather than at the
 * timeout.
 *
 * Reading to the sentinel rather than stopping at the colour is also what keeps
 * the answer off the next reader's input. werk asked the question, so the whole
 * answer is werk's to take off the stream; a reply left behind is read by
 * whatever reads stdin next, and for `attach` that means it is forwarded to the
 * session and arrives in the child as keystrokes.
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
 * The timeout is the one hole this cannot close. A reply that arrives after it
 * has fired is read by whoever reads next, because there is nobody left to take
 * it off the stream.
 *
 * ## Putting the input back
 *
 * The exchange leaves the stream exactly as it found it, on every path,
 * including the one where parsing throws. Three things have to be undone and the
 * last two are easy to miss.
 *
 * Raw mode is restored because leaving a shell without its echo is worse than
 * getting the wrong flavour.
 *
 * The read is stopped because starting one holds the process open. Listening
 * for `data` puts the stream into flowing mode, and a flowing stdin keeps the
 * event loop alive for as long as the terminal stays open, which is forever.
 * Removing the listener is not enough: the stream carries on reading with
 * nobody to hand the bytes to, so the read has to be stopped as well as
 * ignored. Every command pays for this, because the probe runs before the
 * command line is parsed.
 *
 * Anything read that was not the answer was typed by a person, so it goes back
 * on the stream rather than into the bin. The bytes are accumulated as latin-1,
 * one character to a byte, so cutting the two replies out of the text cuts them
 * out of the bytes and what is handed back is what was sent. Unshifting onto a
 * paused stream leaves it buffered for the next reader.
 *
 * Pausing is safe for whatever reads next. `attach` resumes the stream itself
 * after attaching its own handler, and a prompt goes through readline, which
 * resumes the stream when it is constructed.
 */
import { type Ground, groundFromRgb } from "./theme.js";

/** The query, and the sentinel that ends the exchange. */
const QUERY = "\x1b]11;?\x1b\\\x1b[c";
/** A primary device attributes reply: `ESC [ ? … c`. */
const ATTRIBUTES = /\x1b\[\?[0-9;]*c/;
/**
 * `OSC 11 ; ` then a colour, then BEL, ST or a bare ESC. Channels are one to
 * four hex digits each, because the width varies by terminal.
 */
const REPLY =
  /\x1b\]11;(?:rgb:)?#?([0-9a-fA-F]{1,4})\/?([0-9a-fA-F]{1,4})\/?([0-9a-fA-F]{1,4})/;
/**
 * The colour reply whatever it says, for cutting it back out. `REPLY` reads a
 * colour and this one only finds the answer, so a reply nobody could parse is
 * still werk's and still comes off the stream.
 */
const ANSWER = /\x1b\]11;[^\x07\x1b]*(?:\x07|\x1b\\|\x1b)?/;

/** Scale a channel of any width to eight bits. `ff` and `ffff` are both white. */
function channel(digits: string): number {
  const value = Number.parseInt(digits, 16);
  const max = 16 ** digits.length - 1;
  return Math.round((value / max) * 255);
}

/**
 * Where the terminal's reply arrives.
 *
 * Only the four methods the exchange uses are named, and all four are required.
 * A wider type would let a fake leave `pause` or `unshift` off and still satisfy
 * the compiler, and a fake that cannot record the read being stopped cannot
 * catch it going missing again.
 */
export interface GroundInput {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  /** Give bytes that were not part of the answer back to the next reader. */
  unshift(chunk: Buffer): unknown;
  pause(): unknown;
}

/** What the exchange needs, so that a test can supply all of it. */
export interface GroundIO {
  readonly input: GroundInput;
  /** Where the query goes. */
  readonly output: { write(text: string): unknown };
  /** Put the input into and out of raw mode. */
  setRawMode(on: boolean): void;
  readonly timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 150;

/** Run one step of the teardown, where failing is not worth reporting. */
function settle(action: () => void): void {
  try {
    action();
  } catch {
    // The stream may already be gone.
  }
}

export function detectGround(io: GroundIO): Promise<Ground | undefined> {
  const timeoutMs = io.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<Ground | undefined>((resolve) => {
    let read = Buffer.alloc(0);
    let ground: Ground | undefined;
    let answered = false;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      // Each undo is attempted whatever the ones before it did, so a stream
      // that has already gone cannot leave the terminal in raw mode.
      settle(() => io.input.off("data", onData));
      // Stopping the read is what lets the process exit. Removing the listener
      // alone leaves the stream flowing and the handle held.
      settle(() => io.input.pause());
      // Onto the paused stream, so it is buffered rather than emitted to
      // nobody. Whatever is left is somebody's typing.
      const rest = read
        .toString("latin1")
        .replace(ANSWER, "")
        .replace(ATTRIBUTES, "");
      if (rest.length > 0)
        settle(() => io.input.unshift(Buffer.from(rest, "latin1")));
      settle(() => io.setRawMode(false));
      resolve(ground);
    };

    function onData(chunk: Buffer | string): void {
      read = Buffer.concat([
        read,
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      ]);
      // latin-1 so that one character is one byte: the sequences being looked
      // for are ASCII, and what is cut out of the text is cut out of the bytes.
      const seen = read.toString("latin1");
      try {
        if (!answered) {
          const reply = REPLY.exec(seen);
          if (reply) {
            answered = true;
            ground = groundFromRgb(
              channel(reply[1]!),
              channel(reply[2]!),
              channel(reply[3]!),
            );
          }
        }
        // The sentinel means the terminal has said everything it is going to.
        if (ATTRIBUTES.test(seen)) finish();
      } catch {
        ground = undefined;
        finish();
      }
    }

    try {
      io.setRawMode(true);
      io.input.on("data", onData);
      io.output.write(QUERY);
    } catch {
      finish();
      return;
    }
    timer = setTimeout(finish, timeoutMs);
    // A pending read must not be the reason the process stays alive.
    timer.unref?.();
  });
}
