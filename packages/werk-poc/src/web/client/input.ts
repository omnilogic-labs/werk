// DOM events to the seam's KeyEvent / MouseEvent, which the WASM key and
// mouse encoders turn into PTY bytes using the replica's own modes
// (findings/m1.md, encodeKey / encodeMouse). The mapping is mechanical:
// `KeyboardEvent.code` is the physical key libghostty's key enum is
// named after, and `KeyboardEvent.key` is the text the layout produces.

import {
  MouseButton,
  type KeyEvent,
  type Mods,
  type MouseEvent as SeamMouseEvent,
} from "../../engine/types.ts";
import type { CellSize } from "./renderer.ts";

function modsOf(e: KeyboardEvent | MouseEvent | WheelEvent): Mods {
  return {
    shift: e.shiftKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    super: e.metaKey,
    capsLock: e.getModifierState("CapsLock"),
    numLock: e.getModifierState("NumLock"),
  };
}

/** One printable character, or a single astral codepoint as a surrogate pair. */
function isText(key: string): boolean {
  if (key.length === 1) return true;
  return key.length === 2 && /^[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(key);
}

export function keyEventFromDom(e: KeyboardEvent): KeyEvent {
  return {
    action: e.repeat ? "repeat" : "press",
    key: e.code || "Unidentified",
    mods: modsOf(e),
    utf8: isText(e.key) ? e.key : undefined,
    composing: e.isComposing,
  };
}

/** DOM `MouseEvent.button` to libghostty's numbering. */
function buttonOf(e: MouseEvent): number {
  switch (e.button) {
    case 0:
      return MouseButton.left;
    case 1:
      return MouseButton.middle;
    case 2:
      return MouseButton.right;
    default:
      return 8 + (e.button - 3);
  }
}

/**
 * The terminal surface's top-left in client coordinates. A canvas renderer
 * needs none: `offsetX` is already relative to the canvas, because the
 * canvas is always the event's target. A renderer that paints DOM rows makes
 * a row element the target, so its events are re-based on the surface
 * instead. The page caches the origin rather than measuring per event.
 */
export interface SurfaceOrigin {
  x: number;
  y: number;
}

function pixelsIn(
  e: MouseEvent | WheelEvent,
  origin: SurfaceOrigin | undefined,
): { px: number; py: number } {
  if (!origin) return { px: e.offsetX, py: e.offsetY };
  return { px: e.clientX - origin.x, py: e.clientY - origin.y };
}

export function mouseEventFromDom(
  e: MouseEvent,
  action: "press" | "release" | "motion",
  cell: CellSize,
  /** Buttons held during a motion event, as `MouseEvent.buttons`. */
  heldButton?: number,
  origin?: SurfaceOrigin,
): SeamMouseEvent {
  const { px, py } = pixelsIn(e, origin);
  const button =
    action === "motion" ? (heldButton ?? MouseButton.none) : buttonOf(e);
  return {
    action,
    button,
    x: Math.floor(px / cell.width),
    y: Math.floor(py / cell.height),
    mods: modsOf(e),
    pixels: { x: px, y: py, cellWidth: cell.width, cellHeight: cell.height },
  };
}

/** A wheel tick is a press of a wheel button; one event per tick, however far the wheel moved. */
export function wheelEventFromDom(
  e: WheelEvent,
  cell: CellSize,
  origin?: SurfaceOrigin,
): SeamMouseEvent | null {
  let button: number;
  if (e.deltaY < 0) button = MouseButton.wheelUp;
  else if (e.deltaY > 0) button = MouseButton.wheelDown;
  else if (e.deltaX < 0) button = MouseButton.wheelLeft;
  else if (e.deltaX > 0) button = MouseButton.wheelRight;
  else return null;
  const { px, py } = pixelsIn(e, origin);
  return {
    action: "press",
    button,
    x: Math.floor(px / cell.width),
    y: Math.floor(py / cell.height),
    mods: modsOf(e),
    pixels: { x: px, y: py, cellWidth: cell.width, cellHeight: cell.height },
  };
}

/** The held button for a motion event, from `MouseEvent.buttons` (a bitmask: 1 left, 2 right, 4 middle). */
export function heldButtonOf(buttons: number): number {
  if (buttons & 1) return MouseButton.left;
  if (buttons & 4) return MouseButton.middle;
  if (buttons & 2) return MouseButton.right;
  return MouseButton.none;
}
