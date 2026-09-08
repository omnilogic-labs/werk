/**
 * Reading a colour the way the terminal that sent it reads one.
 *
 * A terminal asked for its background answers `OSC 11` with a colour in
 * whatever spelling it prefers: XParseColor's `rgb:` at one to four hex digits
 * a channel, `rgbi:` in floating point, a hex triple in three, six, nine or
 * twelve digits with or without a leading `#`, or an X11 colour name. Reading
 * that by hand is how `#1e1e2e` comes out blue.
 *
 * The engine already carries ghostty's own parser — the same one it reads its
 * configuration and a child's `OSC 4` with — so this is a binding rather than
 * an implementation, and the syntax it accepts is a fact about the artefact
 * rather than a list somebody has to keep up to date.
 *
 * It is separate from the terminal engine because it needs none of it: no
 * grid, no size, no snapshot, no callbacks. A caller that only wants to know
 * what colour a terminal is does not pay for a terminal.
 */
import { Abi } from "./abi.js";

/** A colour, eight bits a channel, which is what the parser answers in. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface ColourReader {
  /** The colour, or nothing when the text does not name one. */
  parse(value: string): Rgb | undefined;
}

export async function createColourReader(
  source: Uint8Array | ArrayBuffer | WebAssembly.Module,
): Promise<ColourReader> {
  const module =
    source instanceof WebAssembly.Module
      ? source
      : await WebAssembly.compile(source as BufferSource);
  const a = new Abi(await WebAssembly.instantiate(module, {}));
  const SUCCESS = a.enum("GhosttyResult", "SUCCESS");
  return {
    parse(value: string): Rgb | undefined {
      const bytes = new TextEncoder().encode(value);
      return a.temporary(bytes.length, (text) => {
        // After the allocation, because allocating can grow the memory and
        // growth replaces the buffer the view was made over.
        a.bytes().set(bytes, text);
        return a.object("GhosttyColorRgb", (out) => {
          const result = a.call("ghostty_color_parse", text, bytes.length, out);
          // A value that is not a colour is an answer, not a failure: a
          // terminal is allowed to say something this does not understand.
          return result === SUCCESS
            ? (a.read(out, "GhosttyColorRgb") as Rgb)
            : undefined;
        });
      });
    },
  };
}
