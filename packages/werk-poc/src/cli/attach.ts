// The interactive half of `wp run` and `wp attach`: the local terminal in
// raw mode, bytes relayed both ways, the detach key, SIGWINCH, and a
// restoration path that runs however the process leaves.
//
// What Bun offers, as measured under a PTY (findings/m2.md):
//   - `process.stdin.setRawMode(true)` exists and works; `process.stdin`
//     `data` events then carry every byte, ^C and ^\ included, as bytes.
//     `Bun.stdin.stream()` does the same; `process.stdin` is used because
//     it can be paused and resumed and carries `isRaw`.
//   - Bun leaves fds 0 and 1 blocking (no O_NONBLOCK), so `fs.writeSync(1)`
//     is a synchronous, ordered write with no EAGAIN in practice. It is used
//     for every byte that reaches the terminal: a render frame written after
//     an output frame must land after it, and a synchronous write is the
//     simplest way to make that true. `process.stdout.write` and
//     `Bun.write(Bun.stdout)` both preserved order in a 4 MiB test too, but
//     neither says so, and the async one cannot be followed by a
//     `process.exit` without draining first.
//   - A blocking write also means a slow terminal slows *this process*, not
//     the daemon: the socket to us fills, the daemon marks us lagging and
//     drops output for us alone, then sends a render when we drain. That is
//     the §4 rule reaching the terminal end to end.

import fs from "node:fs";
import type { Attachment, Client } from "../client/index.ts";

/** `WP_TRACE=<file>` appends one timestamped line per event, for the fidelity harness. */
const traceFile = process.env.WP_TRACE;
const trace = traceFile
  ? (line: string) => {
      try {
        fs.appendFileSync(traceFile, `${Date.now()} ${process.pid} ${line}\n`);
      } catch {}
    }
  : () => {};

/** ctrl-\ (FS, 0x1c): detach. Chosen because ^C, ^Z and ^D all belong to the session. */
export const DETACH_KEY = 0x1c;

const ENTER_ALT = "\x1b[?1049h";
const LEAVE_ALT = "\x1b[?1049l";

export interface AttachCliOptions {
  readOnly?: boolean;
  cols?: number;
  rows?: number;
  /**
   * Mirror the session's alternate-screen state onto the local terminal:
   * enter it before the first paint when the session is on it, leave it on
   * detach. On by default; `WP_ALT_SCREEN=0` turns it off for comparison.
   */
  altScreen?: boolean;
  /** Where to write; stdout by default. */
  fd?: number;
}

export function terminalSize(): { cols: number; rows: number } {
  const cols = process.stdout.columns;
  const rows = process.stdout.rows;
  return {
    cols: Number.isInteger(cols) && cols > 0 ? cols : 80,
    rows: Number.isInteger(rows) && rows > 0 ? rows : 24,
  };
}

export function age(since: number): string {
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** A synchronous, ordered write of every byte. */
export function writeAll(fd: number, bytes: Uint8Array): void {
  let off = 0;
  while (off < bytes.length) {
    try {
      off += fs.writeSync(fd, bytes, off, bytes.length - off);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EAGAIN") {
        Bun.sleepSync(1);
        continue;
      }
      throw e;
    }
  }
}

/**
 * Attaches `id` to the terminal on fds 0/1 and returns the process's exit
 * code once the session ends or the user detaches. The caller exits with
 * it; `process.exit` is not called here so tests can drive this in-process.
 */
export async function attachInteractive(
  client: Client,
  id: string,
  opts: AttachCliOptions = {},
): Promise<number> {
  const fd = opts.fd ?? 1;
  const enc = new TextEncoder();
  const stdin = process.stdin as NodeJS.ReadStream & {
    setRawMode?(v: boolean): void;
  };
  if (typeof stdin.setRawMode !== "function" || !stdin.isTTY) {
    throw new Error("stdin is not a terminal; nothing to attach to");
  }
  const mirrorAlt = opts.altScreen ?? process.env.WP_ALT_SCREEN !== "0";
  const size = {
    cols: opts.cols ?? terminalSize().cols,
    rows: opts.rows ?? terminalSize().rows,
  };

  let done: (code: number) => void = () => {};
  const finished = new Promise<number>((r) => (done = r));
  let restored = false;
  /** Bytes from the daemon before the attach reply is in hand; see below. */
  let held: Uint8Array[] | null = [];
  let lagging = false;
  let lagEpisodes = 0;

  const restore = (leaveAlt: boolean) => {
    trace(`restore leaveAlt=${leaveAlt} already=${restored}`);
    if (restored) return;
    restored = true;
    try {
      stdin.setRawMode?.(false);
    } catch {}
    try {
      stdin.pause();
    } catch {}
    if (leaveAlt) writeAll(fd, enc.encode(LEAVE_ALT));
    writeAll(fd, enc.encode("\r\n"));
  };
  const say = (line: string) => writeAll(fd, enc.encode(line + "\r\n"));

  const emit = (bytes: Uint8Array) => {
    trace(`emit ${bytes.length} held=${held !== null}`);
    if (held) held.push(bytes);
    else writeAll(fd, bytes);
  };
  /**
   * A line on the terminal's bottom row, inverse video, with the cursor
   * put back where it was: for a corpse's label and for notices. A corpse's
   * screen never changes, so nothing repaints over it until the user
   * detaches; on a live session the next output that scrolls will.
   */
  const banner = (text: string) => {
    const line = text.slice(0, size.cols);
    emit(
      enc.encode(`\x1b7\x1b[${size.rows};1H\x1b[0;7m${line}\x1b[K\x1b[0m\x1b8`),
    );
  };

  // Every route out of the process restores the terminal. SIGINT and SIGTERM
  // to this process (not ^C, which raw mode turns into a byte for the
  // session) restore and leave the session running; `exit` covers throws.
  const onSignal = (sig: string) => {
    restore(false);
    say(`[wp: ${sig}; session ${id} still running]`);
    done(1);
  };
  const onExit = () => restore(false);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  process.on("exit", onExit);

  // Raw mode goes on before the request, so a key pressed during the round
  // trip reaches the session as a byte rather than being echoed cooked. The
  // `data` listener is installed before `resume()`: in Node semantics a
  // flowing stream with no listener discards what it reads, and Bun follows
  // them. Bytes that arrive before the attach reply wait in `early`.
  let att: Attachment | null = null;
  let detaching = false;
  const early: Uint8Array[] = [];
  const onStdin = (chunk: Buffer) => {
    trace(
      `stdin ${chunk.length} bytes: ${JSON.stringify([...chunk.subarray(0, 8)])}`,
    );
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length);
    if (!att) {
      early.push(bytes);
      return;
    }
    feed(bytes);
  };
  const feed = (bytes: Uint8Array) => {
    if (detaching || !att) return;
    const at = bytes.indexOf(DETACH_KEY);
    if (at < 0) {
      att.input(bytes);
      return;
    }
    if (at > 0) att.input(bytes.subarray(0, at));
    void detach();
  };
  stdin.on("data", onStdin);
  stdin.setRawMode(true);
  stdin.resume();
  trace(`raw mode on; isRaw=${(stdin as { isRaw?: boolean }).isRaw}`);

  try {
    att = await client.attach(id, {
      cols: size.cols,
      rows: size.rows,
      readOnly: opts.readOnly,
      onOutput: emit,
      onRender: emit,
      onExited: ({ exitCode, signalCode }) => {
        // The child left the alternate screen itself if it was polite; the
        // daemon's answer to `detach` is not asked for because the session is
        // over.
        restore(false);
        say(
          signalCode
            ? `[exited ${id}: ${signalCode}]`
            : `[exited ${id}: code ${exitCode ?? 0}]`,
        );
        done(exitCode ?? 1);
      },
      onLag: () => {
        lagging = true;
        lagEpisodes++;
      },
      onResumed: () => {
        lagging = false;
      },
      onNotice: (message) => banner(message),
    });
  } catch (e) {
    restore(false);
    stdin.off("data", onStdin);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    process.off("exit", onExit);
    throw e;
  }
  const attached: Attachment = att;

  // The render frame can be parsed from the same socket read as the attach
  // reply, and handlers fire synchronously while the reply resolves through
  // a microtask, so the first paint may already have arrived. Bytes are
  // held until here, where the alternate-screen switch can precede them.
  trace(
    `attached status=${attached.status} altScreen=${attached.altScreen} held=${held?.length}`,
  );
  if (mirrorAlt && attached.altScreen) writeAll(fd, enc.encode(ENTER_ALT));
  const pending = held;
  held = null;
  for (const b of pending) writeAll(fd, b);
  if (attached.status === "corpse") {
    // Restored from a snapshot: read-only, nothing will ever change, and
    // the user leaves with the detach key as with a live session. The
    // label is one line on the bottom row, so what matters comes first
    // and the command, which can be long, is what truncation drops.
    const info = (await client.ls().catch(() => []))?.find((s) => s.id === id);
    const when = info?.snapshotAt
      ? `snapshotted ${age(info.snapshotAt)} ago`
      : "snapshot";
    const label =
      info?.corpse?.reason === "mismatch"
        ? `[corpse: not decoded, ghostty ${info.corpse.snapshotEngine.slice(0, 8)} vs this wp's ${info.corpse.daemonEngine.slice(0, 8)}; ctrl-\\ to leave]`
        : `[corpse: ${when}, read-only; ctrl-\\ to leave] ${(info?.argv ?? [id]).join(" ")}`;
    banner(label);
  }

  const detach = async () => {
    if (detaching) return;
    detaching = true;
    trace("detach: requesting");
    let altScreen = false;
    try {
      altScreen = (await attached.detach()).altScreen;
    } catch (e) {
      trace(`detach: request failed: ${String(e)}`);
    }
    trace(`detach: reply altScreen=${altScreen}`);
    restore(mirrorAlt && altScreen);
    say(
      `[detached ${id}]` +
        (lagEpisodes ? ` (lagged ${lagEpisodes}×)` : "") +
        (lagging ? " (still lagging)" : ""),
    );
    done(0);
  };

  for (const b of early.splice(0)) feed(b);

  const onWinch = () => {
    const s = terminalSize();
    attached.resize(s.cols, s.rows).catch(() => {});
  };
  process.on("SIGWINCH", onWinch);

  const code = await finished;
  stdin.off("data", onStdin);
  process.off("SIGWINCH", onWinch);
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  process.off("SIGHUP", onSignal);
  process.off("exit", onExit);
  return code;
}
