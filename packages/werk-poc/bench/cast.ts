// asciicast v2 as the corpus format: a JSON header line, then one JSON
// event per line, `[time, code, data]`. The runner replays "o" (output,
// a UTF-8 string) and "r" (resize, "COLSxROWS") events. One extension: a
// "b" event carries base64 bytes, for a chunk that is not valid UTF-8 —
// a PTY read cut in the middle of a multibyte character, or a synthetic
// case that cuts one on purpose. asciinema players skip codes they do not
// know, so the files still play. Files without "b" events are plain
// asciicast.

import fs from "node:fs";

export interface CastHeader {
  version: 2;
  width: number;
  height: number;
  timestamp?: number;
  title?: string;
  env?: Record<string, string>;
}

export type CastEvent =
  | { t: number; kind: "output"; bytes: Uint8Array }
  | { t: number; kind: "resize"; cols: number; rows: number };

export interface Cast {
  header: CastHeader;
  events: CastEvent[];
}

const dec = new TextDecoder("utf-8", { fatal: true });
const enc = new TextEncoder();

export function parseCast(text: string): Cast {
  const lines = text.split("\n").filter((l) => l.length > 0);
  const header = JSON.parse(lines[0]!) as CastHeader;
  if (header.version !== 2) throw new Error("not an asciicast v2 file");
  const events: CastEvent[] = [];
  for (const line of lines.slice(1)) {
    const [t, code, data] = JSON.parse(line) as [number, string, string];
    if (code === "o")
      events.push({ t, kind: "output", bytes: enc.encode(data) });
    else if (code === "b")
      events.push({ t, kind: "output", bytes: Buffer.from(data, "base64") });
    else if (code === "r") {
      const [c, r] = data.split("x").map(Number);
      events.push({ t, kind: "resize", cols: c!, rows: r! });
    }
    // "i" (input) and "m" (marker) are not replayed.
  }
  return { header, events };
}

export function readCast(path: string): Cast {
  return parseCast(fs.readFileSync(path, "utf8"));
}

export function formatCast(cast: Cast): string {
  const out = [JSON.stringify(cast.header)];
  for (const e of cast.events) {
    if (e.kind === "resize")
      out.push(JSON.stringify([round(e.t), "r", `${e.cols}x${e.rows}`]));
    else {
      let s: string | null = null;
      try {
        s = dec.decode(e.bytes);
      } catch {
        s = null;
      }
      out.push(
        s !== null
          ? JSON.stringify([round(e.t), "o", s])
          : JSON.stringify([
              round(e.t),
              "b",
              Buffer.from(e.bytes).toString("base64"),
            ]),
      );
    }
  }
  return out.join("\n") + "\n";
}

export function writeCast(path: string, cast: Cast): void {
  fs.writeFileSync(path, formatCast(cast));
}

function round(t: number): number {
  return Math.round(t * 1e6) / 1e6;
}

/** A cast built in code: `o(text|bytes)` and `r(cols, rows)` steps, each a separate write. */
export class CastBuilder {
  private events: CastEvent[] = [];
  private t = 0;
  constructor(
    private cols: number,
    private rows: number,
    private title?: string,
  ) {}
  o(data: string | Uint8Array): this {
    this.events.push({
      t: this.t,
      kind: "output",
      bytes: typeof data === "string" ? enc.encode(data) : data,
    });
    this.t += 0.01;
    return this;
  }
  r(cols: number, rows: number): this {
    this.events.push({ t: this.t, kind: "resize", cols, rows });
    this.t += 0.01;
    return this;
  }
  build(): Cast {
    return {
      header: {
        version: 2,
        width: this.cols,
        height: this.rows,
        title: this.title,
      },
      events: this.events,
    };
  }
}

/** Every output event's bytes, concatenated; for a case that only needs the stream. */
export function castBytes(cast: Cast): Uint8Array {
  const parts = cast.events.filter((e) => e.kind === "output");
  const len = parts.reduce(
    (n, e) => n + (e as { bytes: Uint8Array }).bytes.length,
    0,
  );
  const out = new Uint8Array(len);
  let off = 0;
  for (const e of parts) {
    const b = (e as { bytes: Uint8Array }).bytes;
    out.set(b, off);
    off += b.length;
  }
  return out;
}
