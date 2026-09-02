// The wire protocol between a client (the CLI, the web server, a test) and
// the daemon, over a Unix socket. One file, no Bun-specific imports, so the
// CLI and the web server can both use it and a browser bundle could too.
//
// Framing: a 4-byte little-endian length, then that many bytes: one type
// byte and the payload. Control frames carry UTF-8 JSON; the four data
// frame types carry raw bytes and skip the JSON cost on the hot path.
//
//   ┌────────────┬──────┬─────────────────────┐
//   │ u32 LE len │ type │ payload (len-1 bytes)│
//   └────────────┴──────┴─────────────────────┘
//
// Requests from a client carry a `rid`; the daemon answers each with one
// `reply` or `error` carrying the same `rid`. Notices from the daemon
// (`exited`, `lagging`, `resumed`, `effect`) carry no `rid`.

export const PROTOCOL_VERSION = 1;

/** The proof-of-concept's own version; both ends must agree exactly. */
export const WP_VERSION = "0.0.0-poc";

/** Frame types. */
export const FrameType = {
  control: 0,
  /** client → daemon: bytes for the session's PTY */
  input: 1,
  /** daemon → client: live PTY output, verbatim */
  output: 2,
  /**
   * daemon → client: a re-emission of the session's screen. The bytes begin
   * with a clear (`CSI H CSI 2 J`) and are written to the client's terminal
   * verbatim. Sent after every attach and whenever the client catches up
   * after lagging.
   */
  render: 3,
  /**
   * daemon → client: the session's emulator as `GHOSTSNP` bytes, for a
   * client running the same libghostty (the browser). Sent in place of
   * `render` when the client attached with `mode: "snapshot"`: after the
   * attach and whenever the client catches up after lagging. Every
   * `output` frame that follows carries bytes the emulator consumed after
   * the encode, so feeding them into the decoded terminal keeps it exact.
   */
  snapshot: 4,
} as const;
export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const HEADER_BYTES = 4;

export interface Frame {
  type: FrameTypeValue;
  payload: Uint8Array;
}

// ---------------------------------------------------------------------------
// Control messages

export type SessionStatus = "running" | "exited" | "corpse";

/** The two reattach mechanisms of the proposal's §2, as a client chooses between them. */
export type AttachMode = "vt" | "snapshot";

/**
 * Why a session is a corpse: restored from a snapshot the daemon could
 * decode, or listed from one whose libghostty commit differs from the
 * daemon's, which is not decoded at all (proposal §3: a mismatch is stated
 * plainly, not bridged).
 */
export type CorpseInfo =
  | { reason: "restored" }
  | { reason: "mismatch"; snapshotEngine: string; daemonEngine: string };

/** How the two-stage decode went for a restored corpse; the M3 evidence. */
export interface RestoreStats {
  /** `decodeState()` + `ready()`: the session was attachable after this. */
  readyMs: number;
  /** Driving `next()` to completion after `ready()`. */
  historyMs: number;
  /** Rows the terminal held after `ready()`. */
  readyRows: number;
  /** Rows after the last page. */
  totalRows: number;
  pages: number;
  snapshotBytes: number;
}

export interface SessionInfo {
  id: string;
  argv: string[];
  cwd: string;
  engine: string;
  status: SessionStatus;
  exitCode: number | null;
  signalCode: string | null;
  title: string;
  pwd: string;
  createdAt: number;
  exitedAt: number | null;
  attachedClients: number;
  cols: number;
  rows: number;
  /** When the session's snapshot file was last written; null if never. */
  snapshotAt: number | null;
  corpse: CorpseInfo | null;
  restore: RestoreStats | null;
}

export interface HelloInfo {
  protocol: number;
  wp: string;
  /** The libghostty commit the engine bytes are pinned to. */
  engine: string;
}

/** What a client sends. */
export type ClientMessage =
  | ({ t: "hello" } & HelloInfo)
  | {
      t: "run";
      rid: number;
      argv: string[];
      cwd: string;
      env: Record<string, string>;
      cols: number;
      rows: number;
      engine: string;
    }
  | {
      t: "attach";
      rid: number;
      id: string;
      cols: number;
      rows: number;
      readOnly: boolean;
      /**
       * How the first paint and every post-lag repaint arrive: `vt` (the
       * default) is a `render` frame of re-emitted escape sequences for a
       * client in someone else's terminal; `snapshot` is a `snapshot` frame
       * for a client running the same emulator.
       */
      mode?: AttachMode;
    }
  | { t: "detach"; rid: number }
  /**
   * Send this attacher a fresh paint (a `render` or a `snapshot`, per its
   * attach mode) in the frame stream now. What the daemon does on its own
   * when a lagging client drains; a client with a slow consumer of its
   * own behind it (the web server's WebSocket) asks for the same thing
   * when that consumer drains.
   */
  | { t: "repaint"; rid: number }
  | { t: "resize"; rid: number; cols: number; rows: number }
  | { t: "ls"; rid: number }
  | { t: "kill"; rid: number; id: string; signal?: string }
  | { t: "logs"; rid: number; id: string; format: "text" | "vt" }
  | { t: "screen"; rid: number; id: string }
  | { t: "snapshot"; rid: number; id: string }
  | { t: "stats"; rid: number }
  | { t: "shutdown"; rid: number };

/** Per-connection backpressure accounting, reported by `stats`. */
export interface ConnectionStats {
  attached: string | null;
  readOnly: boolean;
  lagging: boolean;
  /** Bytes currently held in the daemon-side queue for this connection. */
  queuedBytes: number;
  maxQueuedBytes: number;
  /** Raw output bytes discarded because the client was lagging. */
  droppedBytes: number;
  /** Times the connection entered the lagging state. */
  lagCount: number;
  /** Writes that the kernel accepted only partially or not at all. */
  shortWrites: number;
  drains: number;
  /** Bytes the kernel had accepted when the first short write happened. */
  firstShortWriteAfterBytes: number | null;
  /** Milliseconds from the last short write to the next drain. */
  lastDrainLatencyMs: number | null;
  bytesSent: number;
}

/** The daemon's snapshot accounting, reported by `stats`. */
export interface SnapshotStats {
  stateDir: string;
  intervalMs: number;
  /** Timer ticks so far. */
  ticks: number;
  /** Files written, by what prompted them. */
  written: Record<"timer" | "exit" | "shutdown", number>;
  /** The most expensive encode seen: which session, how many bytes, how long the event loop was held. */
  slowest: { id: string; bytes: number; encodeMs: number } | null;
  /** How long the whole restore pass took at start, and how many files it saw. */
  restore: { files: number; ms: number };
}

export interface DaemonStats {
  pid: number;
  rssBytes: number | null;
  uptimeMs: number;
  sessions: number;
  connections: ConnectionStats[];
  queueBound: number;
  snapshots: SnapshotStats;
}

/** What the daemon sends. */
export type DaemonMessage =
  | ({ t: "hello"; pid: number } & HelloInfo)
  | { t: "reply"; rid: number; result: unknown }
  | { t: "error"; rid?: number; code: string; message: string }
  | {
      t: "exited";
      id: string;
      exitCode: number | null;
      signalCode: string | null;
    }
  | { t: "lagging"; id: string; droppedBytes: number }
  | { t: "resumed"; id: string }
  /** Something the attached client should show the user; a corpse ignoring input, for one. */
  | { t: "notice"; id: string; message: string }
  | {
      t: "effect";
      id: string;
      kind: "title" | "pwd" | "bell";
      value?: string;
    };

export type RunResult = { id: string };
export type AttachResult = {
  id: string;
  status: SessionStatus;
  exitCode: number | null;
  signalCode: string | null;
  /** The session's emulator is on the alternate screen (DEC 1049). */
  altScreen: boolean;
};
export type DetachResult = { altScreen: boolean };
export type KillResult = { id: string; action: "signalled" | "removed" };
export type LogsResult = { id: string; format: "text" | "vt"; data: string };
/** A session's emulator state as `GHOSTSNP` bytes, base64 in the JSON reply; what a browser running the same libghostty decodes. */
export type SnapshotResult = {
  id: string;
  engine: string;
  /** The libghostty commit that encoded it; a decoder on another commit should not try. */
  ghostty: string;
  cols: number;
  rows: number;
  bytes: string;
  encodeMs: number;
};
/** The session's viewport as the daemon's emulator sees it; for tests that compare it with a client's terminal. */
export type ScreenResult = {
  id: string;
  cols: number;
  rows: number;
  /** `rows` lines joined by "\n", trailing whitespace trimmed. */
  text: string;
  cursor: { x: number; y: number };
  altScreen: boolean;
};

// ---------------------------------------------------------------------------
// Encoding

const utf8enc = new TextEncoder();
const utf8dec = new TextDecoder();

export function encodeFrame(
  type: FrameTypeValue,
  payload: Uint8Array,
): Uint8Array {
  const len = 1 + payload.length;
  if (len > MAX_FRAME_BYTES) throw new Error(`frame too large: ${len} bytes`);
  const out = new Uint8Array(HEADER_BYTES + len);
  new DataView(out.buffer).setUint32(0, len, true);
  out[HEADER_BYTES] = type;
  out.set(payload, HEADER_BYTES + 1);
  return out;
}

export function encodeControl(msg: ClientMessage | DaemonMessage): Uint8Array {
  return encodeFrame(FrameType.control, utf8enc.encode(JSON.stringify(msg)));
}

export function decodeControl<T = ClientMessage | DaemonMessage>(
  payload: Uint8Array,
): T {
  return JSON.parse(utf8dec.decode(payload)) as T;
}

/**
 * Reassembles frames from a byte stream. Socket reads arrive in arbitrary
 * pieces; `push` returns every frame completed by the bytes so far. Payload
 * views are copies, so a caller may keep them.
 */
export class FrameParser {
  private buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    if (this.buf.length === 0) {
      this.buf = chunk;
    } else {
      const joined = new Uint8Array(this.buf.length + chunk.length);
      joined.set(this.buf, 0);
      joined.set(chunk, this.buf.length);
      this.buf = joined;
    }
    const frames: Frame[] = [];
    let off = 0;
    const buf = this.buf;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    while (buf.length - off >= HEADER_BYTES) {
      const len = view.getUint32(off, true);
      if (len < 1 || len > MAX_FRAME_BYTES) {
        throw new Error(`bad frame length ${len}`);
      }
      if (buf.length - off < HEADER_BYTES + len) break;
      const type = buf[off + HEADER_BYTES] as FrameTypeValue;
      if (type > FrameType.snapshot) throw new Error(`bad frame type ${type}`);
      const payload = buf.slice(
        off + HEADER_BYTES + 1,
        off + HEADER_BYTES + len,
      );
      frames.push({ type, payload });
      off += HEADER_BYTES + len;
    }
    this.buf = off === buf.length ? new Uint8Array(0) : buf.slice(off);
    return frames;
  }

  /** Bytes buffered and not yet forming a whole frame. */
  get pending(): number {
    return this.buf.length;
  }
}

/** The clear sequence that begins every render frame. */
export const RENDER_CLEAR = "\x1b[H\x1b[2J";
