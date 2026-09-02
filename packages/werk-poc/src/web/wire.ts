// What crosses the WebSocket between `wp serve` and the page. No Bun or
// DOM imports: the server and the browser bundle both use this file.
//
// Binary messages are tagged with one leading byte, so the page can tell a
// snapshot from live output without parsing anything:
//
//   server → page   [0] + raw PTY output bytes, verbatim
//   server → page   [1] + GHOSTSNP bytes: replace the replica with this
//   page → server   raw input bytes for the PTY (no tag; every binary
//                   message from the page is input)
//
// Text messages are JSON, `WsNotice` one way and `WsCommand` the other.

export const WsTag = {
  output: 0,
  snapshot: 1,
} as const;

/** Where a lag happened: the daemon's socket to the web server, or the web server's WebSocket to the page. */
export type LagWhere = "daemon" | "ws";

/** Server → page. */
export type WsNotice =
  | {
      t: "hello";
      id: string;
      argv: string[];
      status: "running" | "exited" | "corpse";
      corpse: string | null;
      exitCode: number | null;
      signalCode: string | null;
      cols: number;
      rows: number;
      title: string;
    }
  | { t: "exited"; exitCode: number | null; signalCode: string | null }
  | { t: "lagging"; where: LagWhere; droppedBytes: number }
  | { t: "resumed"; where: LagWhere }
  | { t: "notice"; message: string }
  | { t: "effect"; kind: "title" | "pwd" | "bell"; value?: string }
  | { t: "error"; message: string };

/** Page → server. */
export type WsCommand = { t: "resize"; cols: number; rows: number };

export function tagged(tag: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 1);
  out[0] = tag;
  out.set(payload, 1);
  return out;
}

/** Per-socket backpressure accounting for the web server's side of the §4 rule; served at `/api/ws`. */
export interface WsStats {
  id: string;
  /** `ws.send` calls, by what they returned: bytes (sent), -1 (enqueued under backpressure), 0 (dropped by Bun). */
  sends: number;
  backpressured: number;
  droppedByBun: number;
  bytesSent: number;
  /** Output bytes this server discarded because the socket was lagging. */
  droppedBytes: number;
  lagEpisodes: number;
  lagging: boolean;
  drains: number;
  /** Milliseconds from the send that started the current or last lag to the drain that ended it. */
  lastDrainLatencyMs: number | null;
  /** Snapshots sent: the first one, plus one per resume (either stage). */
  snapshots: number;
  /** Lags the daemon reported on its socket to this server, as opposed to the WebSocket. */
  daemonLagEpisodes: number;
}
