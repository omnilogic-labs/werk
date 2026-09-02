// The two input encoders over libghostty: key events and mouse events to
// the bytes a program on the PTY expects. Each is a handle plus a reusable
// event handle plus an output buffer; the options mirror the terminal's
// modes and are applied on every encode, so one encoder serves any number
// of terminals and any number of clients. Nothing here needs a terminal:
// `configure(modes)` takes the seam's TerminalModes, and
// `syncFromTerminal(handle)` is libghostty's own shortcut for callers
// holding a terminal handle.
//
// Neither encoder keeps state between calls: motion deduplication
// (TRACK_LAST_CELL) stays off, so a client that wants it does it itself.

import type { KeyEvent, Mods, MouseEvent, TerminalModes } from "../types.ts";
import { GhosttyError, type GhosttyModule } from "./loader.ts";

const MOD_BITS: [keyof Mods, number][] = [
  ["shift", 1 << 0],
  ["ctrl", 1 << 1],
  ["alt", 1 << 2],
  ["super", 1 << 3],
  ["capsLock", 1 << 4],
  ["numLock", 1 << 5],
];

/** The seam's Mods as a GhosttyMods bitmask. Side bits (left/right) are never set. */
export function modsBits(mods: Mods): number {
  let bits = 0;
  for (const [name, bit] of MOD_BITS) if (mods[name]) bits |= bit;
  return bits;
}

/**
 * A W3C `KeyboardEvent.code` as a GhosttyKey member name. libghostty's key
 * enum is the W3C list in SCREAMING_SNAKE, so the mapping is mechanical:
 * "KeyA" → A, "Digit0" → DIGIT_0, "ArrowUp" → ARROW_UP, "Numpad0" →
 * NUMPAD_0, "LaunchApp1" → LAUNCH_APP_1, "F12" → F12. A name already in
 * that form passes through.
 */
export function keyMemberName(code: string): string {
  if (/^[A-Z0-9_]+$/.test(code)) return code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^F\d+$/.test(code)) return code;
  return code
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/([A-Za-z])(\d)/g, "$1_$2")
    .toUpperCase();
}

/** Shared by both encoders: an output buffer grown on OUT_OF_SPACE, and a 4-byte value slot for setopt. */
abstract class EncoderBase {
  protected out: number;
  protected outCap = 128;
  protected readonly outLen: number;
  protected readonly val: number;
  protected disposed = false;

  constructor(protected readonly g: GhosttyModule) {
    this.out = g.alloc(this.outCap);
    this.outLen = g.alloc(4);
    this.val = g.alloc(4);
  }

  /** Call `encode(buf, cap, outLen)` until the buffer is large enough, then copy the bytes out. */
  protected encodeInto(
    what: string,
    encode: (buf: number, cap: number, outLen: number) => number,
  ): Uint8Array {
    for (;;) {
      const code = encode(this.out, this.outCap, this.outLen);
      const len = this.g.read(this.outLen, "u32") as number;
      if (code === 0) return this.g.readBytes(this.out, len);
      if (this.g.resultName(code) !== "OUT_OF_SPACE")
        throw new GhosttyError(code, this.g.resultName(code), what);
      this.g.free(this.out, this.outCap);
      this.outCap = Math.max(len, this.outCap * 2);
      this.out = this.g.alloc(this.outCap);
    }
  }

  protected setBool(fn: string, handle: number, option: number, v: boolean) {
    this.g.write(this.val, "bool", v);
    this.g.call(fn, handle, option, this.val);
  }

  protected setU8(fn: string, handle: number, option: number, v: number) {
    this.g.write(this.val, "u8", v);
    this.g.call(fn, handle, option, this.val);
  }

  protected setI32(fn: string, handle: number, option: number, v: number) {
    this.g.write(this.val, "i32", v);
    this.g.call(fn, handle, option, this.val);
  }

  protected freeBase(): void {
    this.g.free(this.out, this.outCap);
    this.g.free(this.outLen, 4);
    this.g.free(this.val, 4);
  }

  protected assertLive(): void {
    if (this.disposed) throw new Error("encoder is disposed");
  }
}

export class KeyEncoder extends EncoderBase {
  private readonly encoder: number;
  private readonly event: number;
  private utf8: number;
  private utf8Cap = 32;

  constructor(g: GhosttyModule) {
    super(g);
    this.encoder = g.withOpaque("ghostty_key_encoder_new", (slot) =>
      g.call("ghostty_key_encoder_new", 0, slot),
    );
    this.event = g.withOpaque("ghostty_key_event_new", (slot) =>
      g.call("ghostty_key_event_new", 0, slot),
    );
    this.utf8 = g.alloc(this.utf8Cap);
  }

  /**
   * Apply the seam's modes to the encoder. Every option is set on every
   * call, an undefined field meaning the terminal's reset default, so the
   * encoder never carries a previous caller's configuration.
   */
  configure(m: TerminalModes): void {
    this.assertLive();
    const O = (name: string) =>
      this.g.enumValue("GhosttyKeyEncoderOption", name);
    const set = "ghostty_key_encoder_setopt";
    const e = this.encoder;
    this.setBool(set, e, O("CURSOR_KEY_APPLICATION"), !!m.cursorKeyApplication);
    this.setBool(set, e, O("KEYPAD_KEY_APPLICATION"), !!m.keypadApplication);
    this.setBool(
      set,
      e,
      O("IGNORE_KEYPAD_WITH_NUMLOCK"),
      m.ignoreKeypadWithNumlock ?? true,
    );
    this.setBool(set, e, O("ALT_ESC_PREFIX"), m.altEscPrefix ?? true);
    this.setBool(set, e, O("MODIFY_OTHER_KEYS_STATE_2"), !!m.modifyOtherKeys2);
    this.setU8(set, e, O("KITTY_FLAGS"), m.kittyKeyboardFlags ?? 0);
    this.setI32(
      set,
      e,
      O("MACOS_OPTION_AS_ALT"),
      this.g.enumValue(
        "GhosttyOptionAsAlt",
        (m.optionAsAlt ?? "false").toUpperCase(),
      ),
    );
    this.setBool(set, e, O("BACKARROW_KEY_MODE"), !!m.backarrowKeyMode);
  }

  /** libghostty's own configuration path, from a terminal handle; resets option-as-alt to false. */
  syncFromTerminal(terminal: number): void {
    this.assertLive();
    this.g.call(
      "ghostty_key_encoder_setopt_from_terminal",
      this.encoder,
      terminal,
    );
  }

  /** Encode with whatever configure() or syncFromTerminal() last set. */
  encode(ev: KeyEvent): Uint8Array {
    this.assertLive();
    const g = this.g;
    const e = this.event;
    g.call(
      "ghostty_key_event_set_action",
      e,
      g.enumValue("GhosttyKeyAction", ev.action.toUpperCase()),
    );
    const member = keyMemberName(ev.key);
    const keys = g.layout.enum("GhosttyKey").values;
    g.call(
      "ghostty_key_event_set_key",
      e,
      keys[member] ?? keys["UNIDENTIFIED"]!,
    );
    g.call("ghostty_key_event_set_mods", e, modsBits(ev.mods));
    g.call("ghostty_key_event_set_consumed_mods", e, 0);
    g.call("ghostty_key_event_set_composing", e, ev.composing ? 1 : 0);
    let unshifted = ev.unshiftedCodepoint ?? 0;
    if (ev.utf8) {
      const bytes = new TextEncoder().encode(ev.utf8);
      if (bytes.byteLength > this.utf8Cap) {
        g.free(this.utf8, this.utf8Cap);
        this.utf8Cap = Math.max(bytes.byteLength, this.utf8Cap * 2);
        this.utf8 = g.alloc(this.utf8Cap);
      }
      g.writeBytes(this.utf8, bytes);
      g.call("ghostty_key_event_set_utf8", e, this.utf8, bytes.byteLength);
      if (!unshifted) unshifted = ev.utf8.codePointAt(0) ?? 0;
    } else {
      g.call("ghostty_key_event_set_utf8", e, 0, 0);
    }
    g.call("ghostty_key_event_set_unshifted_codepoint", e, unshifted);
    return this.encodeInto("ghostty_key_encoder_encode", (buf, cap, outLen) =>
      g.call("ghostty_key_encoder_encode", this.encoder, e, buf, cap, outLen),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.g.call("ghostty_key_event_free", this.event);
    this.g.call("ghostty_key_encoder_free", this.encoder);
    this.g.free(this.utf8, this.utf8Cap);
    this.freeBase();
  }
}

/**
 * Geometry the mouse encoder converts positions with. Without pixel
 * information a cell is one pixel square, so a cell position passes
 * straight through; the screen is left large so nothing is clamped.
 */
const CELL_SCREEN = 0x7fff;

export class MouseEncoder extends EncoderBase {
  private readonly encoder: number;
  private readonly event: number;
  private readonly pos: number;
  private readonly size: number;

  constructor(g: GhosttyModule) {
    super(g);
    this.encoder = g.withOpaque("ghostty_mouse_encoder_new", (slot) =>
      g.call("ghostty_mouse_encoder_new", 0, slot),
    );
    this.event = g.withOpaque("ghostty_mouse_event_new", (slot) =>
      g.call("ghostty_mouse_event_new", 0, slot),
    );
    this.pos = g.allocType("GhosttyMousePosition");
    this.size = g.allocType("GhosttyMouseEncoderSize");
    this.setBool(
      "ghostty_mouse_encoder_setopt",
      this.encoder,
      g.enumValue("GhosttyMouseEncoderOption", "TRACK_LAST_CELL"),
      false,
    );
  }

  /** Tracking mode and format from the seam's modes; an undefined field means off / X10. */
  configure(m: TerminalModes): void {
    this.assertLive();
    const g = this.g;
    const O = (name: string) => g.enumValue("GhosttyMouseEncoderOption", name);
    const set = "ghostty_mouse_encoder_setopt";
    this.setI32(
      set,
      this.encoder,
      O("EVENT"),
      g.enumValue(
        "GhosttyMouseTrackingMode",
        (m.mouseTracking ?? "none").toUpperCase(),
      ),
    );
    this.setI32(
      set,
      this.encoder,
      O("FORMAT"),
      g.enumValue(
        "GhosttyMouseFormat",
        (m.mouseFormat ?? "x10").toUpperCase().replace("-", "_"),
      ),
    );
  }

  /** libghostty's own configuration path; sets tracking mode and format only. */
  syncFromTerminal(terminal: number): void {
    this.assertLive();
    this.g.call(
      "ghostty_mouse_encoder_setopt_from_terminal",
      this.encoder,
      terminal,
    );
  }

  /**
   * Encode one event. The geometry (SIZE) and the any-button-pressed state
   * are set per event: a motion event carrying a button counts as a drag.
   */
  encode(ev: MouseEvent): Uint8Array {
    this.assertLive();
    const g = this.g;
    const e = this.event;
    const O = (name: string) => g.enumValue("GhosttyMouseEncoderOption", name);
    const set = "ghostty_mouse_encoder_setopt";
    const px = ev.pixels;
    g.writeStruct(this.size, "GhosttyMouseEncoderSize", {
      screen_width: px ? CELL_SCREEN * px.cellWidth : CELL_SCREEN,
      screen_height: px ? CELL_SCREEN * px.cellHeight : CELL_SCREEN,
      cell_width: px ? px.cellWidth : 1,
      cell_height: px ? px.cellHeight : 1,
      padding_top: 0,
      padding_bottom: 0,
      padding_right: 0,
      padding_left: 0,
    });
    g.call(set, this.encoder, O("SIZE"), this.size);
    this.setBool(
      set,
      this.encoder,
      O("ANY_BUTTON_PRESSED"),
      ev.action === "motion" && ev.button !== 0,
    );
    g.call(
      "ghostty_mouse_event_set_action",
      e,
      g.enumValue("GhosttyMouseAction", ev.action.toUpperCase()),
    );
    if (ev.button === 0) g.call("ghostty_mouse_event_clear_button", e);
    else g.call("ghostty_mouse_event_set_button", e, ev.button);
    g.call("ghostty_mouse_event_set_mods", e, modsBits(ev.mods));
    g.writeStruct(this.pos, "GhosttyMousePosition", {
      x: px ? px.x : ev.x,
      y: px ? px.y : ev.y,
    });
    // GhosttyMousePosition is by value in C and a pointer under wasm32.
    g.call("ghostty_mouse_event_set_position", e, this.pos);
    return this.encodeInto("ghostty_mouse_encoder_encode", (buf, cap, outLen) =>
      g.call("ghostty_mouse_encoder_encode", this.encoder, e, buf, cap, outLen),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.g.call("ghostty_mouse_event_free", this.event);
    this.g.call("ghostty_mouse_encoder_free", this.encoder);
    this.g.freeType(this.pos, "GhosttyMousePosition");
    this.g.freeType(this.size, "GhosttyMouseEncoderSize");
    this.freeBase();
  }
}
