import { describe, expect, test } from "bun:test";
import {
  MouseButton,
  type KeyEvent,
  type MouseEvent,
  type TerminalModes,
} from "../types.ts";
import { ghosttyWasmBytes } from "./bytes.ts";
import { GhosttyError, GhosttyWasmEngine, keyMemberName } from "./index.ts";

const engine = await GhosttyWasmEngine.load(await ghosttyWasmBytes());
const enc = new TextEncoder();

/** Bytes from a mix of strings and byte values, so expectations read as sequences. */
function b(...parts: (string | number)[]): Uint8Array {
  const out: number[] = [];
  for (const p of parts)
    if (typeof p === "number") out.push(p);
    else out.push(...enc.encode(p));
  return new Uint8Array(out);
}

const ESC = 0x1b;

function press(
  key: string,
  mods: KeyEvent["mods"] = {},
  utf8?: string,
): KeyEvent {
  return { action: "press", key, mods, utf8 };
}

function withTerminal<T>(
  vt: string,
  body: (t: ReturnType<typeof engine.create>) => T,
): T {
  const t = engine.create({ cols: 80, rows: 24, scrollback: 100 });
  try {
    t.write(enc.encode(vt));
    return body(t);
  } finally {
    t.dispose();
  }
}

describe("key names", () => {
  test("W3C codes map onto GhosttyKey members", () => {
    const cases: [string, string][] = [
      ["KeyA", "A"],
      ["Digit0", "DIGIT_0"],
      ["ArrowUp", "ARROW_UP"],
      ["Enter", "ENTER"],
      ["F1", "F1"],
      ["F12", "F12"],
      ["Numpad0", "NUMPAD_0"],
      ["NumpadAdd", "NUMPAD_ADD"],
      ["NumpadClearEntry", "NUMPAD_CLEAR_ENTRY"],
      ["BracketLeft", "BRACKET_LEFT"],
      ["IntlBackslash", "INTL_BACKSLASH"],
      ["LaunchApp1", "LAUNCH_APP_1"],
      ["AudioVolumeUp", "AUDIO_VOLUME_UP"],
      ["MetaLeft", "META_LEFT"],
      ["PageUp", "PAGE_UP"],
      ["ARROW_DOWN", "ARROW_DOWN"],
    ];
    const known = engine.module.layout.enum("GhosttyKey").values;
    for (const [code, member] of cases) {
      expect(keyMemberName(code)).toBe(member);
      expect(known[member]).toBeDefined();
    }
  });
});

describe("encodeKey", () => {
  const plain: TerminalModes = {};

  test("printable keys, control keys and modifiers in legacy mode", () => {
    expect(engine.encodeKey(press("KeyA", {}, "a"), plain)).toEqual(b("a"));
    expect(
      engine.encodeKey(press("KeyA", { shift: true }, "A"), plain),
    ).toEqual(b("A"));
    expect(engine.encodeKey(press("KeyC", { ctrl: true }, "c"), plain)).toEqual(
      b(0x03),
    );
    // the encoder derives Ctrl from the key, not from the text
    expect(engine.encodeKey(press("KeyC", { ctrl: true }), plain)).toEqual(
      b(0x03),
    );
    expect(engine.encodeKey(press("Enter"), plain)).toEqual(b(0x0d));
    expect(engine.encodeKey(press("Backspace"), plain)).toEqual(b(0x7f));
    expect(engine.encodeKey(press("Tab"), plain)).toEqual(b(0x09));
    expect(engine.encodeKey(press("Tab", { shift: true }), plain)).toEqual(
      b(ESC, "[Z"),
    );
    expect(engine.encodeKey(press("F1"), plain)).toEqual(b(ESC, "OP"));
    expect(engine.encodeKey(press("KeyX", { alt: true }, "x"), plain)).toEqual(
      b(ESC, "x"),
    );
    expect(engine.encodeKey(press("Escape"), plain)).toEqual(b(ESC));
  });

  test("events that produce nothing produce an empty array, not Unsupported", () => {
    expect(
      engine.encodeKey(press("ShiftLeft", { shift: true }), plain),
    ).toEqual(b());
    expect(
      engine.encodeKey(
        { action: "release", key: "KeyA", mods: {}, utf8: "a" },
        plain,
      ),
    ).toEqual(b());
    expect(
      engine.encodeKey(
        { action: "press", key: "KeyA", mods: {}, utf8: "a", composing: true },
        plain,
      ),
    ).toEqual(b());
  });

  test("an unknown code still delivers its text", () => {
    expect(engine.encodeKey(press("Lang1", {}, "é"), plain)).toEqual(b("é"));
    const long = "日本語の入力を確定しました".repeat(4);
    expect(engine.encodeKey(press("Unidentified", {}, long), plain)).toEqual(
      b(long),
    );
  });

  test("arrow up follows DECCKM, read off the terminal", () => {
    withTerminal("", (t) => {
      expect(t.modes().cursorKeyApplication).toBe(false);
      expect(engine.encodeKey(press("ArrowUp"), t.modes())).toEqual(
        b(ESC, "[A"),
      );
      t.write(enc.encode("\x1b[?1h"));
      expect(t.modes().cursorKeyApplication).toBe(true);
      expect(engine.encodeKey(press("ArrowUp"), t.modes())).toEqual(
        b(ESC, "OA"),
      );
      t.write(enc.encode("\x1b[?1l"));
      expect(engine.encodeKey(press("ArrowUp"), t.modes())).toEqual(
        b(ESC, "[A"),
      );
    });
  });

  test("Kitty keyboard protocol, enabled by the program, read back as flags", () => {
    withTerminal("\x1b[>1u", (t) => {
      const m = t.modes();
      expect(m.kittyKeyboardFlags).toBe(1);
      expect(engine.encodeKey(press("KeyC", { ctrl: true }, "c"), m)).toEqual(
        b(ESC, "[99;5u"),
      );
      expect(engine.encodeKey(press("Escape"), m)).toEqual(b(ESC, "[27u"));
      // plain text is still plain text under disambiguate
      expect(engine.encodeKey(press("KeyA", {}, "a"), m)).toEqual(b("a"));
      t.write(enc.encode("\x1b[<u"));
      expect(t.modes().kittyKeyboardFlags).toBe(0);
      expect(engine.encodeKey(press("Escape"), t.modes())).toEqual(b(ESC));
    });
    // and with every flag on, a release is reported too
    const all: TerminalModes = { kittyKeyboardFlags: 0b11111 };
    expect(
      engine.encodeKey(
        { action: "release", key: "KeyA", mods: {}, utf8: "a" },
        all,
      ),
    ).toEqual(b(ESC, "[97;1:3u"));
  });

  test("backarrow key mode (DEC 67) turns Backspace into BS", () => {
    withTerminal("\x1b[?67h", (t) => {
      expect(t.modes().backarrowKeyMode).toBe(true);
      expect(engine.encodeKey(press("Backspace"), t.modes())).toEqual(b(0x08));
    });
    expect(
      engine.encodeKey(press("Backspace"), { backarrowKeyMode: true }),
    ).toEqual(b(0x08));
  });

  test("modifyOtherKeys 2, read back through the formatter's keyboard extra", () => {
    const ev = press("KeyA", { ctrl: true, shift: true }, "A");
    withTerminal("", (t) => {
      expect(t.modes().modifyOtherKeys2).toBe(false);
      expect(engine.encodeKey(ev, t.modes())).toEqual(b(ESC, "[97;5u"));
    });
    withTerminal("\x1b[>4;2m", (t) => {
      expect(t.modes().modifyOtherKeys2).toBe(true);
      expect(engine.encodeKey(ev, t.modes())).toEqual(b(ESC, "[27;6;65~"));
      t.write(enc.encode("\x1b[>4;0m"));
      expect(t.modes().modifyOtherKeys2).toBe(false);
    });
    // and it is not confused by screen content
    withTerminal("\x1b[>4;2m\x1b[31mred\x1b[0m\r\nmore", (t) => {
      expect(t.modes().modifyOtherKeys2).toBe(true);
    });
  });

  test("keypad application mode (DEC 66)", () => {
    const ev = press("NumpadAdd", { numLock: true }, "+");
    expect(engine.encodeKey(ev, {})).toEqual(b("+"));
    expect(
      engine.encodeKey(ev, {
        keypadApplication: true,
        ignoreKeypadWithNumlock: false,
      }),
    ).toEqual(b(ESC, "Ok"));
  });

  test("modes() agrees with libghostty's setopt_from_terminal on every key", () => {
    const streams = [
      "",
      "\x1b[?1h",
      "\x1b[?66h\x1b[?1035l",
      "\x1b[?1036l",
      "\x1b[>1u",
      "\x1b[>31u",
      "\x1b[?67h",
      "\x1b[>4;2m",
      "\x1b[?1h\x1b[?66h\x1b[>3u",
    ];
    const events: KeyEvent[] = [
      press("KeyA", {}, "a"),
      press("KeyA", { shift: true }, "A"),
      press("KeyA", { ctrl: true, shift: true }, "A"),
      press("Digit1", { ctrl: true }, "1"),
      press("Enter", { shift: true }),
      press("KeyC", { ctrl: true }, "c"),
      press("KeyX", { alt: true }, "x"),
      press("ArrowUp"),
      press("Home"),
      press("Enter"),
      press("Backspace"),
      press("Tab", { shift: true }),
      press("Escape"),
      press("F5"),
      press("NumpadAdd", { numLock: true }, "+"),
      press("Numpad1", {}, "1"),
      { action: "release", key: "KeyA", mods: {}, utf8: "a" },
      { action: "repeat", key: "ArrowDown", mods: { ctrl: true } },
    ];
    for (const vt of streams) {
      withTerminal(vt, (t) => {
        const m = t.modes();
        for (const ev of events) {
          expect([vt, ev, engine.encodeKey(ev, m)]).toEqual([
            vt,
            ev,
            engine.encodeKeySynced(t, ev),
          ]);
        }
      });
    }
  });
});

describe("encodeMouse", () => {
  const click = (x: number, y: number, mods = {}): MouseEvent => ({
    action: "press",
    button: MouseButton.left,
    x,
    y,
    mods,
  });
  const sgr: TerminalModes = { mouseTracking: "normal", mouseFormat: "sgr" };

  test("no tracking mode: a click encodes to nothing", () => {
    expect(engine.encodeMouse(click(10, 5), {})).toEqual(b());
    withTerminal("", (t) => {
      expect(t.modes().mouseTracking).toBe("none");
      expect(engine.encodeMouse(click(10, 5), t.modes())).toEqual(b());
    });
  });

  test("normal tracking with SGR, from the terminal", () => {
    withTerminal("\x1b[?1000h\x1b[?1006h", (t) => {
      const m = t.modes();
      expect(m.mouseTracking).toBe("normal");
      expect(m.mouseFormat).toBe("sgr");
      expect(engine.encodeMouse(click(10, 5), m)).toEqual(b(ESC, "[<0;11;6M"));
      expect(
        engine.encodeMouse({ ...click(10, 5), action: "release" }, m),
      ).toEqual(b(ESC, "[<0;11;6m"));
      expect(
        engine.encodeMouse({ ...click(10, 5), button: MouseButton.wheelUp }, m),
      ).toEqual(b(ESC, "[<64;11;6M"));
      expect(
        engine.encodeMouse(
          { ...click(10, 5), button: MouseButton.wheelDown },
          m,
        ),
      ).toEqual(b(ESC, "[<65;11;6M"));
      expect(engine.encodeMouse(click(1, 1, { shift: true }), m)).toEqual(
        b(ESC, "[<4;2;2M"),
      );
      // fractions inside a cell are that cell
      expect(engine.encodeMouse(click(10.7, 5.2), m)).toEqual(
        b(ESC, "[<0;11;6M"),
      );
      // motion is not reported in normal mode
      expect(
        engine.encodeMouse(
          { action: "motion", button: MouseButton.none, x: 11, y: 5, mods: {} },
          m,
        ),
      ).toEqual(b());
    });
  });

  test("button-event (1002) reports drags only; any-event (1003) reports all motion", () => {
    const motion = (button: number): MouseEvent => ({
      action: "motion",
      button,
      x: 12,
      y: 5,
      mods: {},
    });
    withTerminal("\x1b[?1002h\x1b[?1006h", (t) => {
      const m = t.modes();
      expect(m.mouseTracking).toBe("button");
      expect(engine.encodeMouse(motion(MouseButton.none), m)).toEqual(b());
      expect(engine.encodeMouse(motion(MouseButton.left), m)).toEqual(
        b(ESC, "[<32;13;6M"),
      );
    });
    withTerminal("\x1b[?1003h\x1b[?1006h", (t) => {
      const m = t.modes();
      expect(m.mouseTracking).toBe("any");
      expect(engine.encodeMouse(motion(MouseButton.none), m)).toEqual(
        b(ESC, "[<35;13;6M"),
      );
      // the encoder does not deduplicate; the same cell reports again
      expect(engine.encodeMouse(motion(MouseButton.none), m)).toEqual(
        b(ESC, "[<35;13;6M"),
      );
    });
  });

  test("the other formats", () => {
    expect(
      engine.encodeMouse(click(10, 5), {
        mouseTracking: "normal",
        mouseFormat: "x10",
      }),
    ).toEqual(b(ESC, "[M", 32, 32 + 11, 32 + 6));
    expect(
      engine.encodeMouse(click(10, 5), {
        mouseTracking: "normal",
        mouseFormat: "urxvt",
      }),
    ).toEqual(b(ESC, "[32;11;6M"));
    const px = { x: 84, y: 88, cellWidth: 8, cellHeight: 16 };
    expect(
      engine.encodeMouse(
        { ...click(10, 5), pixels: px },
        { mouseTracking: "normal", mouseFormat: "sgr-pixels" },
      ),
    ).toEqual(b(ESC, "[<0;84;88M"));
    // with pixel geometry, cell formats still report the cell
    expect(engine.encodeMouse({ ...click(10, 5), pixels: px }, sgr)).toEqual(
      b(ESC, "[<0;11;6M"),
    );
    // without it, pixel mode reports the cell position as pixels
    expect(
      engine.encodeMouse(click(10, 5), {
        mouseTracking: "normal",
        mouseFormat: "sgr-pixels",
      }),
    ).toEqual(b(ESC, "[<0;10;5M"));
  });

  test("modes() agrees with libghostty's setopt_from_terminal on every mode pair", () => {
    const tracking = [
      "",
      "\x1b[?9h",
      "\x1b[?1000h",
      "\x1b[?1002h",
      "\x1b[?1003h",
    ];
    const format = [
      "",
      "\x1b[?1005h",
      "\x1b[?1006h",
      "\x1b[?1015h",
      "\x1b[?1016h",
    ];
    const events: MouseEvent[] = [
      click(10, 5),
      { ...click(10, 5), action: "release" },
      { ...click(3, 2), button: MouseButton.right, mods: { ctrl: true } },
      { ...click(0, 0), button: MouseButton.wheelUp },
      { action: "motion", button: MouseButton.none, x: 7, y: 7, mods: {} },
      { action: "motion", button: MouseButton.left, x: 7, y: 7, mods: {} },
    ];
    for (const tr of tracking)
      for (const f of format)
        withTerminal(tr + f, (t) => {
          const m = t.modes();
          for (const ev of events)
            expect([tr + f, ev, engine.encodeMouse(ev, m)]).toEqual([
              tr + f,
              ev,
              engine.encodeMouseSynced(t, ev),
            ]);
        });
  });
});

describe("modes()", () => {
  test("a fresh terminal reports libghostty's reset defaults", () => {
    withTerminal("", (t) => {
      expect(t.modes()).toEqual({
        cursorKeyApplication: false,
        keypadApplication: false,
        ignoreKeypadWithNumlock: true,
        altEscPrefix: true,
        backarrowKeyMode: false,
        bracketedPaste: false,
        focusEvents: false,
        kittyKeyboardFlags: 0,
        modifyOtherKeys2: false,
        mouseTracking: "none",
        mouseFormat: "x10",
      });
    });
  });

  test("bracketed paste and focus events are readable for a client that wraps input", () => {
    withTerminal("\x1b[?2004h\x1b[?1004h", (t) => {
      expect(t.modes().bracketedPaste).toBe(true);
      expect(t.modes().focusEvents).toBe(true);
    });
  });

  test("a mode libghostty does not know is INVALID_VALUE", () => {
    withTerminal("", (t) => {
      expect(() => t.decMode(9999)).toThrow(GhosttyError);
    });
  });
});
