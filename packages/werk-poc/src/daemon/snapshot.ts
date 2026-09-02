// Session snapshots on disk: one file per session in the state directory,
// written atomically, read back at daemon start.
//
// File format, `<state>/<id>.snap`:
//
//   ┌──────────────────────────────┬────┬──────────────────────────────┐
//   │ one line of JSON (the header)│ \n │ the GHOSTSNP bytes, verbatim │
//   └──────────────────────────────┴────┴──────────────────────────────┘
//
// One file rather than two so that a rename is the whole commit: the
// header names the libghostty commit that encoded the bytes, and a header
// without its bytes (or the reverse) is a torn snapshot. The JSON never
// contains a raw newline, so the first `\n` is the boundary. A file whose
// header parses but whose bytes do not begin with `GHOSTSNP` is reported
// as corrupt, not decoded. A header with no bytes (`bytes: 0`) is legal
// and restores as a listed-only corpse with nothing to render.

import fs from "node:fs";
import path from "node:path";
import type { CorpseInfo, SessionStatus } from "../protocol/index.ts";

export const SNAPSHOT_MAGIC = "GHOSTSNP";
export const SNAPSHOT_SUFFIX = ".snap";

export interface SnapshotHeader {
  /** The proof of concept's version; the file layout is tied to it. */
  wp: string;
  /** The engine id the session ran on, `ghostty-wasm`. */
  engine: string;
  /** The libghostty commit whose encoder produced the bytes. */
  ghostty: string;
  id: string;
  argv: string[];
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  title: string;
  pwd: string;
  /** The status at the moment of the snapshot. Restored sessions are corpses whatever this says. */
  status: SessionStatus;
  exitCode: number | null;
  signalCode: string | null;
  exitedAt: number | null;
  /** When this file was written. */
  snapshotAt: number;
  /** Set when the session was itself a restored corpse whose file is being carried forward. */
  corpse: CorpseInfo | null;
  /** Length of the `GHOSTSNP` bytes that follow; 0 when there are none. */
  bytes: number;
}

export interface Snapshot {
  header: SnapshotHeader;
  bytes: Uint8Array;
  file: string;
}

export function snapshotPath(stateDir: string, id: string): string {
  return path.join(stateDir, `${id}${SNAPSHOT_SUFFIX}`);
}

export function ensureStateDir(stateDir: string): void {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
}

/**
 * Writes the header and bytes to a temp file in the same directory and
 * renames it into place, so a reader never sees a half-written file and a
 * crash mid-write leaves the previous snapshot intact. Returns the size.
 */
export function writeSnapshot(
  stateDir: string,
  header: SnapshotHeader,
  bytes: Uint8Array,
): number {
  ensureStateDir(stateDir);
  const target = snapshotPath(stateDir, header.id);
  const tmp = `${target}.${process.pid}.tmp`;
  const head = new TextEncoder().encode(
    JSON.stringify({ ...header, bytes: bytes.byteLength }) + "\n",
  );
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, head);
    if (bytes.byteLength) fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  return head.byteLength + bytes.byteLength;
}

export class SnapshotFormatError extends Error {}

/** Parses one snapshot file. Throws `SnapshotFormatError` for a torn or foreign file. */
export function readSnapshot(file: string): Snapshot {
  const buf = fs.readFileSync(file);
  const nl = buf.indexOf(0x0a);
  if (nl < 0) throw new SnapshotFormatError(`${file}: no header line`);
  let header: SnapshotHeader;
  try {
    header = JSON.parse(buf.subarray(0, nl).toString("utf8"));
  } catch (e) {
    throw new SnapshotFormatError(`${file}: header is not JSON: ${String(e)}`);
  }
  if (typeof header !== "object" || header === null || !header.id)
    throw new SnapshotFormatError(`${file}: header has no id`);
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset + nl + 1);
  if (bytes.byteLength !== header.bytes)
    throw new SnapshotFormatError(
      `${file}: header says ${header.bytes} bytes, file holds ${bytes.byteLength}`,
    );
  if (
    bytes.byteLength > 0 &&
    new TextDecoder().decode(bytes.subarray(0, 8)) !== SNAPSHOT_MAGIC
  )
    throw new SnapshotFormatError(`${file}: bytes do not begin with GHOSTSNP`);
  return { header, bytes: bytes.slice(), file };
}

/** Every `.snap` file in the directory, sorted by name; an absent directory is empty. */
export function listSnapshotFiles(stateDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(stateDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(SNAPSHOT_SUFFIX))
    .map((n) => path.join(stateDir, n))
    .sort();
}

export function deleteSnapshot(stateDir: string, id: string): boolean {
  try {
    fs.unlinkSync(snapshotPath(stateDir, id));
    return true;
  } catch {
    return false;
  }
}
