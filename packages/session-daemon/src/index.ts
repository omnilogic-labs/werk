import {
  createLogger,
  silentLogger,
  errorFields,
  type Logger,
  type LogLevel,
} from "./log.js";
import fs from "node:fs/promises";
import net from "node:net";
import { sessionEnvironment, validateEnvironment } from "./environment.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  FramedTransport,
  encodeFrame,
  CLIENT_MAX_FRAME_BYTES,
  DAEMON_MAX_FRAME_BYTES,
  DEFAULT_MAX_QUEUED_BYTES,
  PROTOCOL_VERSION,
  type Transport,
  type WireMessage,
} from "@werk/session/protocol";
import {
  SessionError,
  type SessionInfo,
  type Principal,
  type Permissions,
  type AttachmentInfo,
  type HoldSize,
  type Representation,
  type DaemonInfo,
  type DaemonEvent,
  type Size,
  type EndReason,
} from "@werk/session";
import type {
  TerminalEngineFactory,
  TerminalHandle,
  SnapshotEnvelope,
} from "@werk/terminal";
import {
  spawnPty,
  platformCapabilities,
  privateWindowsDirectory,
  socketPathTooLong,
} from "./platform/index.js";
import {
  resolveSessionDaemonPaths,
  socketTransport,
  type LocalEndpoint,
} from "./local.js";
import {
  acquireDaemonLock,
  lockableDirectory,
  type LockRelease,
} from "./platform/lock.js";
import {
  clearDaemonRecord,
  currentBootId,
  ensurePrivateDirectory,
  processStartedAt,
  recreateLockMarker,
  startDaemonSupervisor,
  writeDaemonRecord,
} from "./supervise.js";
export * from "./local.js";
export * from "./log.js";
export * from "./supervise.js";
export * from "./diagnostics.js";
export interface DaemonConfig {
  log?: Logger;
  logLevel?: LogLevel;
  runtimeDir: string;
  stateDir: string;
  engineFactory: TerminalEngineFactory;
  limits?: {
    sessions?: number;
    retainedSessions?: number;
    attachments?: number;
    notifyIntervalMs?: number;
    previewIntervalMs?: number;
    previewMinIntervalMs?: number;
    previewMaxIntervalMs?: number;
    outputQueueBytes?: number;
    resyncIntervalMs?: number;
    controlQueueMessages?: number;
    controlQueueBytes?: number;
    maxFrameBytes?: number;
    maxInputFrameBytes?: number;
    helloTimeoutMs?: number;
    checkpointIntervalMs?: number;
    shutdownTimeoutMs?: number;
    checkpointMaxBytes?: number;
    scrollbackMaxBytes?: number;
    terminalIdleMs?: number;
    superviseIntervalMs?: number;
    touchIntervalMs?: number;
  };
  authorize?: (
    principal: Principal,
    action: string,
    session?: SessionInfo,
    requested?: Permissions,
  ) => boolean | Permissions;
  authenticate?: (
    credential: string | undefined,
  ) => Principal | Promise<Principal>;
}
type Child = ReturnType<typeof spawnPty>;
type Pulse = {
  timer?: ReturnType<typeof setTimeout>;
  sent: Map<string, number>;
  effects: Map<string, unknown>;
  activity: boolean;
};
type PreviewFormat = "vt" | "plain";
type PreviewPayload = {
  type: "preview";
  size: Size;
  format: PreviewFormat;
  text: string;
  cursor?: { x: number; y: number; visible: boolean };
  changedAt: number;
};
// One tick per record, whatever is watching it: the formatter runs once per
// distinct format asked for and every tile on the record shares the result.
type Preview = {
  viewers: Set<Viewer>;
  timer?: ReturnType<typeof setTimeout>;
  intervalMs: number;
  dirty: boolean;
  sentAt: number;
};
type RecordState = {
  info: SessionInfo;
  terminal?: TerminalHandle;
  child?: Child;
  position: number;
  checkpoint?: SnapshotEnvelope;
  preserveCheckpoint?: boolean;
  /**
   * Something has happened to this record since its last saved screen, so the
   * next checkpoint has a reason to run. Records restored from disk start
   * clean and stay clean unless a process writes to them again.
   */
  dirty?: boolean;
  removed?: boolean;
  endedAt?: number;
  pulse?: Pulse;
  preview?: Preview;
  /** Disposes a saved record's terminal once nothing has read it for a while. */
  idle?: ReturnType<typeof setTimeout>;
  restoring?: Promise<TerminalHandle>;
};
type Viewer = {
  info: AttachmentInfo;
  record: RecordState;
  connection: Connection;
  position: number;
  representation: string;
  previewFormat: PreviewFormat;
  previewIntervalMs: number;
};
type Entry = {
  frame?: Uint8Array;
  bytes: number;
  position: number;
  output?: boolean;
  resync?: boolean;
  preview?: boolean;
  last?: boolean;
};
type Stream = {
  viewer: Viewer;
  entries: Entry[];
  /** The queued-but-unsent preview, which a newer frame overwrites in place. */
  preview?: Entry;
  outputBytes: number;
  dirty: boolean;
  held: boolean;
  ended: boolean;
  lastResync: number;
};
type Connection = {
  wire: FramedTransport;
  principal: Principal;
  watch: boolean;
  closed: boolean;
  control: { frame: Uint8Array; bytes: number }[];
  controlBytes: number;
  streams: Map<string, Stream>;
  wake?: ReturnType<typeof setTimeout>;
  bytes: number;
  writing: boolean;
  streamControlCount: number;
};
const owner = (): Principal => ({
  id: `uid:${process.getuid?.() ?? process.env.USERNAME ?? "local"}`,
});
/**
 * The rule every grid the daemon is given has to meet. Exported so a client can
 * assert its own size handling against this rather than against a restatement
 * of it: the two drifting apart is what makes a client ask for a grid that is
 * refused on arrival.
 */
export function sizeValid(size: Size) {
  if (
    !size ||
    !Number.isInteger(size.cols) ||
    !Number.isInteger(size.rows) ||
    size.cols < 1 ||
    size.rows < 1 ||
    size.cols > 1000 ||
    size.rows > 1000 ||
    size.cols * size.rows > 250000
  )
    throw new SessionError(
      "INVALID_ARGUMENT",
      "Terminal dimensions must be integers from 1 to 1000",
    );
}
export async function createSessionDaemon(config: DaemonConfig) {
  const log = config.log ?? silentLogger;
  const limits = {
    sessions: 128,
    retainedSessions: 512,
    attachments: 128,
    notifyIntervalMs: 250,
    previewIntervalMs: 500,
    previewMinIntervalMs: 250,
    previewMaxIntervalMs: 5000,
    outputQueueBytes: 256 * 1024,
    resyncIntervalMs: 250,
    controlQueueMessages: 8192,
    controlQueueBytes: DEFAULT_MAX_QUEUED_BYTES,
    maxFrameBytes: CLIENT_MAX_FRAME_BYTES,
    maxInputFrameBytes: DAEMON_MAX_FRAME_BYTES,
    helloTimeoutMs: 5000,
    checkpointIntervalMs: 5000,
    shutdownTimeoutMs: 5000,
    checkpointMaxBytes: 32 * 1024 * 1024,
    scrollbackMaxBytes: 10_000_000,
    terminalIdleMs: 60_000,
    ...config.limits,
  };
  for (const [key, value] of Object.entries(limits))
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`Invalid limit ${key}`);
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") privateWindowsDirectory(config.stateDir);
  const identityPath = path.join(config.stateDir, "identity");
  let id: string;
  try {
    id = (await fs.readFile(identityPath, "utf8")).trim();
  } catch {
    id = randomUUID();
    await fs.writeFile(identityPath, id, { mode: 0o600 });
  }
  const info: DaemonInfo = {
    id,
    version: "0.1.0",
    protocolVersion: PROTOCOL_VERSION,
    engine: {
      buildId: config.engineFactory.buildId,
      snapshotFormatVersion: config.engineFactory.snapshotFormatVersion,
    },
    capabilities: {
      termination: platformCapabilities.pty
        ? ["interrupt", "terminate", "force"]
        : [],
      snapshots: config.engineFactory.capabilities.snapshot,
      scrollbackMaxBytes: limits.scrollbackMaxBytes,
      ...platformCapabilities,
    },
  };
  const records = new Map<string, RecordState>(),
    viewers = new Map<string, Viewer>(),
    connections = new Set<Connection>();
  let pendingCreates = 0;
  let closing = false,
    generation = 0;
  function publicInfo(record: RecordState): SessionInfo {
    if (record.child) record.info.processTree = record.child.summary();
    return structuredClone(record.info);
  }
  function permission(
    c: Connection,
    action: string,
    r?: RecordState,
    requested?: Permissions,
  ) {
    const grant =
      config.authorize?.(c.principal, action, r?.info, requested) ?? true;
    if (grant === false)
      throw new SessionError("PERMISSION_DENIED", `${action} refused`);
    return grant;
  }
  function dropConnection(c: Connection) {
    if (c.closed) return;
    c.closed = true;
    connections.delete(c);
    for (const v of [...viewers.values()])
      if (v.connection === c) end(v, "connection-closed");
    c.control = [];
    c.controlBytes = 0;
    c.streams.clear();
    c.bytes = 0;
    c.streamControlCount = 0;
    clearTimeout(c.wake);
    void c.wire.close().catch(() => {});
  }
  function queue(c: Connection, message: WireMessage | Uint8Array) {
    if (c.closed) return;
    try {
      const frame =
        message instanceof Uint8Array
          ? message
          : encodeFrame(message, c.wire.maxSendFrameBytes);
      if (
        c.control.length + c.streamControlCount >=
          limits.controlQueueMessages ||
        c.controlBytes + frame.byteLength > limits.controlQueueBytes
      ) {
        dropConnection(c);
        return;
      }
      c.control.push({ frame, bytes: frame.byteLength });
      c.controlBytes += frame.byteLength;
      void flush(c);
    } catch {
      dropConnection(c);
    }
  }
  function newStream(v: Viewer, held = false): Stream {
    const stream: Stream = {
      viewer: v,
      entries: [],
      outputBytes: 0,
      dirty: false,
      held,
      ended: false,
      lastResync: -Infinity,
    };
    v.connection.streams.set(v.info.id, stream);
    return stream;
  }
  function pushControl(c: Connection, stream: Stream, entry: Entry) {
    if (
      c.control.length + c.streamControlCount >= limits.controlQueueMessages ||
      c.controlBytes + entry.bytes > limits.controlQueueBytes
    ) {
      dropConnection(c);
      return;
    }
    stream.entries.push(entry);
    c.streamControlCount++;
    c.controlBytes += entry.bytes;
  }
  function invalidate(c: Connection, stream: Stream) {
    // A control already queued after output must not encounter an unexplained
    // position gap. Replace each removed run at its reserved final position.
    const entries: Entry[] = [];
    for (const entry of stream.entries) {
      if (!entry.output) {
        entries.push(entry);
        continue;
      }
      const previous = entries.at(-1);
      if (previous?.resync) previous.position = entry.position;
      else {
        entries.push({ resync: true, position: entry.position, bytes: 0 });
        c.streamControlCount++;
      }
    }
    c.bytes -= stream.outputBytes;
    stream.outputBytes = 0;
    stream.entries = entries;
    if (!stream.dirty) {
      // A tail reservation covers output produced while earlier controls drain.
      const position = ++stream.viewer.position;
      const tail = stream.entries.at(-1);
      if (tail?.resync) tail.position = position;
      else pushControl(c, stream, { resync: true, position, bytes: 0 });
      stream.dirty = true;
    }
  }
  function stateEvent(
    v: Viewer,
    type: "snapshot" | "resync",
    position = ++v.position,
  ) {
    const snapshot = v.record.terminal?.snapshot() ?? v.record.checkpoint;
    if (!snapshot)
      throw new SessionError("UNSUPPORTED", "No decodable saved screen");
    return {
      type: "event",
      event: {
        type,
        attachmentId: v.info.id,
        generation: v.info.generation,
        position,
        size: v.record.info.size,
        snapshot: snapshot.bytes,
        engineBuildId: snapshot.engineBuild,
        snapshotFormatVersion: snapshot.formatVersion,
      },
    } as WireMessage;
  }
  function failStream(c: Connection, stream: Stream) {
    for (const entry of stream.entries) {
      if (entry.output) c.bytes -= entry.bytes;
      else {
        c.controlBytes -= entry.bytes;
        c.streamControlCount--;
      }
    }
    stream.entries = [];
    stream.preview = undefined;
    stream.outputBytes = 0;
    stream.dirty = false;
    stream.ended = false;
    if (viewers.has(stream.viewer.info.id)) end(stream.viewer, "session-ended");
    else emit(stream.viewer, { type: "ended", reason: "session-ended" });
  }
  async function flush(c: Connection) {
    if (c.writing || c.closed) return;
    clearTimeout(c.wake);
    c.wake = undefined;
    c.writing = true;
    try {
      while (!c.closed) {
        const control = c.control.shift();
        let frame = control?.frame;
        if (control) c.controlBytes -= control.bytes;
        if (!frame) {
          let selected: Stream | undefined;
          let delay = Infinity;
          for (const stream of c.streams.values()) {
            if (stream.held || !stream.entries.length) continue;
            const wait = stream.entries[0]!.resync
              ? stream.lastResync + limits.resyncIntervalMs - performance.now()
              : 0;
            if (wait > 0) {
              delay = Math.min(delay, wait);
              continue;
            }
            selected = stream;
            break;
          }
          if (!selected) {
            if (Number.isFinite(delay))
              c.wake = setTimeout(
                () => {
                  c.wake = undefined;
                  void flush(c);
                },
                Math.max(1, delay),
              );
            break;
          }
          const stream = selected;
          // Move the served stream behind its peers without retaining stale indices.
          c.streams.delete(stream.viewer.info.id);
          c.streams.set(stream.viewer.info.id, stream);
          const entry = stream.entries.shift()!;
          if (entry.output) {
            stream.outputBytes -= entry.bytes;
            c.bytes -= entry.bytes;
          } else {
            c.controlBytes -= entry.bytes;
            c.streamControlCount--;
          }
          if (stream.preview === entry) stream.preview = undefined;
          if (entry.resync) {
            stream.dirty = stream.entries.some((item) => item.resync);
            try {
              frame = encodeFrame(
                stateEvent(stream.viewer, "resync", entry.position),
                c.wire.maxSendFrameBytes,
              );
            } catch {
              failStream(c, stream);
              continue;
            }
            stream.lastResync = performance.now();
          } else frame = entry.frame;
          if (entry.last) c.streams.delete(stream.viewer.info.id);
        }
        if (frame) await c.wire.sendFrame(frame);
      }
    } catch {
      dropConnection(c);
    } finally {
      c.writing = false;
    }
  }
  function emit(v: Viewer, event: any) {
    const c = v.connection;
    if (c.closed) return;
    const stream = c.streams.get(v.info.id) ?? newStream(v);
    if (stream.ended) return;
    if (event.type === "resize") invalidate(c, stream);
    if (event.type === "output" && stream.dirty) return;
    const position = ++v.position;
    let frame: Uint8Array;
    try {
      frame = encodeFrame(
        {
          type: "event",
          event: {
            ...event,
            attachmentId: v.info.id,
            generation: v.info.generation,
            position,
          },
        },
        c.wire.maxSendFrameBytes,
      );
    } catch {
      if (event.type === "ended") dropConnection(c);
      else failStream(c, stream);
      return;
    }
    if (event.type === "output") {
      while (
        c.bytes + frame.byteLength > limits.outputQueueBytes &&
        !stream.dirty
      ) {
        let victim = stream;
        for (const other of c.streams.values())
          if (other.outputBytes > victim.outputBytes) victim = other;
        invalidate(c, victim);
      }
      if (!stream.dirty) {
        stream.entries.push({
          frame,
          bytes: frame.byteLength,
          position,
          output: true,
        });
        stream.outputBytes += frame.byteLength;
        c.bytes += frame.byteLength;
      }
    } else {
      pushControl(c, stream, {
        frame,
        bytes: frame.byteLength,
        position,
        last: event.type === "ended",
      });
      if (event.type === "ended") stream.ended = true;
    }
    void flush(c);
  }
  // Output, effects and resizes go to the attachments that replicate the
  // terminal. A preview viewer sees none of them: its screen arrives whole on
  // the next tick, so it also never triggers a snapshot or a resync.
  function broadcast(r: RecordState, event: any) {
    for (const v of viewers.values())
      if (v.record === r && v.representation !== "preview") emit(v, event);
  }
  function notify(
    type: DaemonEvent["type"],
    r: RecordState,
    extra: Partial<DaemonEvent> = {},
  ) {
    const time = Date.now();
    // One clone serves every watcher: the frame is encoded inside `queue`
    // before control returns, so no watcher observes a later mutation.
    let session: SessionInfo | undefined;
    for (const c of connections) {
      if (!c.watch) continue;
      try {
        permission(c, "list", r);
      } catch (e) {
        // Only a refusal hides the event; an internal failure in the
        // embedder's callback is recorded rather than silently dropping the
        // record from one watcher's view for the life of the connection.
        if (!(e instanceof SessionError && e.code === "PERMISSION_DENIED"))
          log.write("error", "notify.internal", {
            sessionId: r.info.id,
            notification: type,
            principal: c.principal.id,
            ...errorFields(e),
          });
        continue;
      }
      session ??= publicInfo(r);
      queue(c, {
        type: "daemon-event",
        event: { type, sessionId: r.info.id, session, time, ...extra },
      });
    }
  }
  // `activity` and `effect` are the only unbounded watch events: a busy session
  // produces one of each per PTY chunk. They coalesce per record, per kind: the
  // first goes out on the leading edge, then at most one more of that kind per
  // `limits.notifyIntervalMs`, latest payload winning. Callers force a drain
  // before a state change so nothing trails `exited`.
  function pulse(r: RecordState, effect?: { kind: string }) {
    const state: Pulse = (r.pulse ??= {
      sent: new Map(),
      effects: new Map(),
      activity: false,
    });
    if (effect) state.effects.set(effect.kind, effect);
    else state.activity = true;
    drainPulse(r);
  }
  function drainPulse(r: RecordState, force = false) {
    const state = r.pulse;
    if (!state) return;
    clearTimeout(state.timer);
    state.timer = undefined;
    const now = performance.now();
    let next = Infinity;
    const ready = (key: string) => {
      const due = (state.sent.get(key) ?? -Infinity) + limits.notifyIntervalMs;
      if (force || now >= due) {
        state.sent.set(key, now);
        return true;
      }
      next = Math.min(next, due);
      return false;
    };
    for (const [kind, effect] of [...state.effects])
      if (ready(`effect:${kind}`)) {
        state.effects.delete(kind);
        notify("effect", r, { effect } as Partial<DaemonEvent>);
      }
    if (state.activity && ready("activity")) {
      state.activity = false;
      notify("activity", r);
    }
    // An idle session arms nothing; only a coalesced pulse keeps a timer alive.
    if (!Number.isFinite(next)) return;
    state.timer = setTimeout(
      () => {
        state.timer = undefined;
        drainPulse(r);
      },
      Math.max(1, next - now),
    );
    state.timer.unref?.();
  }
  function clearPulse(r: RecordState) {
    clearTimeout(r.pulse?.timer);
    r.pulse = undefined;
  }
  // Previews are text frames scheduled per record rather than per viewer: one
  // tick asks the engine once for each distinct format the record's tiles want
  // and encodes that for each of them, so twenty tiles on one session cost one
  // formatter call. A record with no preview viewer arms nothing, so idle
  // sessions and ordinary terminals pay nothing at all. This deliberately does
  // not reuse `pulse`, whose window is fixed at `notifyIntervalMs`, whose keys
  // drain into watch notifications, and which is forced to drain before a state
  // change: a preview wants its own requested interval and has nothing useful
  // to say on the way out.
  function previewState(r: RecordState) {
    return (r.preview ??= {
      viewers: new Set<Viewer>(),
      intervalMs: limits.previewIntervalMs,
      dirty: false,
      sentAt: -Infinity,
    });
  }
  // A record ticks as fast as its most impatient tile asked for.
  function previewInterval(state: Preview) {
    let interval = Infinity;
    for (const v of state.viewers)
      interval = Math.min(interval, v.previewIntervalMs);
    state.intervalMs = Number.isFinite(interval)
      ? interval
      : limits.previewIntervalMs;
  }
  function previewPayload(
    r: RecordState,
    format: PreviewFormat,
  ): PreviewPayload {
    const terminal = r.terminal;
    if (!terminal)
      throw new SessionError("UNSUPPORTED", "No decodable saved screen");
    return {
      type: "preview",
      size: r.info.size,
      format,
      text: terminal.formatScreen(format),
      cursor: terminal.cursor(),
      changedAt: r.info.lastOutputAt ?? r.info.createdAt,
    };
  }
  function previewTick(r: RecordState) {
    const state = r.preview;
    if (!state) return;
    state.timer = undefined;
    if (!state.dirty || !state.viewers.size) return;
    state.dirty = false;
    state.sentAt = performance.now();
    const formatted = new Map<PreviewFormat, PreviewPayload>();
    for (const v of [...state.viewers]) {
      let payload = formatted.get(v.previewFormat);
      if (!payload) {
        try {
          payload = previewPayload(r, v.previewFormat);
        } catch (error) {
          // A screen that cannot be formatted is not worth ending tiles over;
          // the next change tries again and the watch stream carries the state.
          log.write("warn", "preview.failed", {
            sessionId: r.info.id,
            ...errorFields(error),
          });
          return;
        }
        formatted.set(v.previewFormat, payload);
      }
      emitPreview(v, payload);
    }
  }
  function schedulePreview(r: RecordState) {
    const state = r.preview;
    if (!state || state.timer || !state.dirty || !state.viewers.size) return;
    const wait = state.sentAt + state.intervalMs - performance.now();
    if (wait <= 0) {
      previewTick(r);
      return;
    }
    state.timer = setTimeout(() => previewTick(r), Math.max(1, wait));
    state.timer.unref?.();
  }
  // Called wherever the screen itself changes. Everything else a tile might
  // care about, effects among them, is on the watch stream already.
  function previewChanged(r: RecordState) {
    if (!r.preview?.viewers.size) return;
    r.preview.dirty = true;
    schedulePreview(r);
  }
  function clearPreview(r: RecordState) {
    clearTimeout(r.preview?.timer);
    r.preview = undefined;
  }
  // A preview describes the whole screen, so an unsent one is worth nothing
  // once a newer one exists: the queued frame is overwritten where it stands,
  // keeping the position it reserved. A tile behind a slow connection skips
  // frames instead of accumulating them, and its stream never gains a gap.
  function emitPreview(v: Viewer, payload: PreviewPayload) {
    const c = v.connection;
    if (c.closed) return;
    const stream = c.streams.get(v.info.id) ?? newStream(v);
    if (stream.ended) return;
    const slot = stream.preview;
    const position = slot ? slot.position : v.position + 1;
    let frame: Uint8Array;
    try {
      frame = encodeFrame(
        {
          type: "event",
          event: {
            ...payload,
            attachmentId: v.info.id,
            generation: v.info.generation,
            position,
          },
        },
        c.wire.maxSendFrameBytes,
      );
    } catch {
      failStream(c, stream);
      return;
    }
    if (slot) {
      if (
        c.controlBytes - slot.bytes + frame.byteLength >
        limits.controlQueueBytes
      ) {
        dropConnection(c);
        return;
      }
      c.controlBytes += frame.byteLength - slot.bytes;
      slot.frame = frame;
      slot.bytes = frame.byteLength;
    } else {
      const entry: Entry = {
        frame,
        bytes: frame.byteLength,
        position,
        preview: true,
      };
      pushControl(c, stream, entry);
      if (c.closed) return;
      v.position = position;
      stream.preview = entry;
    }
    void flush(c);
  }
  function sizeHolder(r: RecordState) {
    for (const v of viewers.values())
      if (v.record === r && v.info.holdsSize) return v;
    return undefined;
  }
  // Taking a size nobody holds is ordinary; taking it from a holder is a
  // takeover, so it goes through the embedder under its own action. A hook
  // written as an allowlist refuses `claimSize` by construction, which leaves
  // the holder where it was.
  function mayClaimSize(c: Connection, r: RecordState) {
    try {
      permission(c, "claimSize", r);
      return true;
    } catch (e) {
      if (e instanceof SessionError && e.code === "PERMISSION_DENIED")
        return false;
      throw e;
    }
  }
  // A holder that leaves passes the size to whichever remaining attachment is
  // likeliest to be driving the terminal: one that can type, then one that
  // asked to claim, then the most recent. `never` attachments, tiles among
  // them, are never successors, so the size can simply become free.
  function successor(r: RecordState) {
    const rank = (v: Viewer) =>
      (v.info.permissions.input ? 4 : 0) +
      (v.info.holdSize === "claim" ? 2 : 0);
    let best: Viewer | undefined;
    for (const v of viewers.values()) {
      if (v.record !== r || v.info.holdSize === "never") continue;
      if (
        !best ||
        rank(v) > rank(best) ||
        (rank(v) === rank(best) && v.info.generation > best.info.generation)
      )
        best = v;
    }
    return best;
  }
  function end(v: Viewer, reason: EndReason) {
    viewers.delete(v.info.id);
    const preview = v.record.preview;
    if (preview?.viewers.delete(v)) {
      if (preview.viewers.size) previewInterval(preview);
      else clearPreview(v.record);
    }
    v.record.info.attachments = v.record.info.attachments.filter(
      (a) => a.id !== v.info.id,
    );
    if (reason === "session-ended" && v.record.info.exit)
      emit(v, { type: "exit", exit: v.record.info.exit });
    emit(v, { type: "ended", reason });
    // Succession only matters while a process is there to resize; on a record
    // that has already ended every remaining viewer is leaving with this one.
    if (
      v.info.holdsSize &&
      (v.record.info.state === "running" || v.record.info.state === "starting")
    ) {
      const next = successor(v.record);
      if (next) {
        next.info.holdsSize = true;
        emit(next, { type: "size-holder", holdsSize: true });
      }
    }
    notify("detached", v.record, { attachment: v.info });
  }
  function recordFor(id: string) {
    const r = records.get(id);
    if (!r) throw new SessionError("NOT_FOUND", "Session not found");
    return r;
  }
  function viewerFor(c: Connection, id: string) {
    const v = viewers.get(id);
    if (!v) throw new SessionError("NOT_FOUND", "Attachment not found");
    if (v.connection !== c)
      throw new SessionError(
        "PERMISSION_DENIED",
        "Attachment belongs to another connection",
      );
    return v;
  }
  // Why a saved screen cannot be decoded, without decoding it. Startup reads
  // this instead of instantiating a terminal per retained record; a full decode
  // happens the first time something actually looks at the screen.
  function checkpointProblem(snapshot?: SnapshotEnvelope) {
    if (!snapshot) return "No saved screen";
    if (snapshot.engineBuild !== config.engineFactory.buildId)
      return `Saved screen came from engine ${snapshot.engineBuild}`;
    if (snapshot.formatVersion !== config.engineFactory.snapshotFormatVersion)
      return `Saved screen uses snapshot format ${snapshot.formatVersion}`;
    if (!snapshot.bytes?.length) return "Saved screen is empty";
    if (snapshot.bytes.length > limits.checkpointMaxBytes)
      return "Saved screen exceeds the checkpoint byte limit";
    return undefined;
  }
  // What stops this record serving a screen right now. A live terminal always
  // can; otherwise the checkpoint has to look right and not be known bad.
  function savedScreenProblem(r: RecordState) {
    if (r.terminal) return undefined;
    return (
      checkpointProblem(r.checkpoint) ??
      (r.info.checkpoint?.decodable === false
        ? (r.info.checkpoint.reason ?? "Saved screen cannot be decoded")
        : undefined)
    );
  }
  // A record's terminal is disposed once nothing has read it for a while, and
  // the checkpoint bytes are what bring it back. Only a record without a child
  // is a candidate: a live session's terminal is the one consuming its PTY.
  function armIdle(r: RecordState) {
    clearTimeout(r.idle);
    r.idle = undefined;
    if (r.child || r.removed || !r.terminal) return;
    r.idle = setTimeout(() => {
      r.idle = undefined;
      if (r.child || r.removed || !r.terminal) return;
      // Anything still watching the record keeps the terminal it reads from,
      // and the deadline starts again so the pages are offered back later.
      if (r.preview?.viewers.size) return armIdle(r);
      for (const v of viewers.values()) if (v.record === r) return armIdle(r);
      // Without decodable bytes to come back from, the live terminal is the
      // only copy of the screen and disposing it would lose the record.
      if (checkpointProblem(r.checkpoint) || !r.info.checkpoint?.decodable)
        return;
      const terminal = r.terminal;
      r.terminal = undefined;
      log.write("debug", "session.released", { sessionId: r.info.id });
      try {
        terminal?.dispose();
      } catch {}
    }, limits.terminalIdleMs);
    r.idle.unref?.();
  }
  function clearIdle(r: RecordState) {
    clearTimeout(r.idle);
    r.idle = undefined;
  }
  // Decodes the saved screen on demand. Concurrent callers share one restore,
  // so two connections asking at once cannot leave a second terminal behind.
  function ensureTerminal(r: RecordState): Promise<TerminalHandle> {
    if (r.terminal) {
      armIdle(r);
      return Promise.resolve(r.terminal);
    }
    if (r.restoring) return r.restoring;
    if (savedScreenProblem(r))
      return Promise.reject(
        new SessionError("UNSUPPORTED", "Saved screen cannot be decoded"),
      );
    return (r.restoring = (async () => {
      try {
        const terminal = await config.engineFactory.restore(r.checkpoint!, {
          scrollbackBytes: Math.min(
            r.info.scrollbackBytes,
            limits.scrollbackMaxBytes,
          ),
        });
        if (r.removed) {
          terminal.dispose();
          throw new SessionError("NOT_FOUND", "Session not found");
        }
        r.terminal = terminal;
        log.write("debug", "session.restored", {
          sessionId: r.info.id,
          bytes: r.checkpoint!.bytes.length,
        });
        armIdle(r);
        return terminal;
      } catch (error) {
        if (error instanceof SessionError) throw error;
        // The cheap check passed and the decode still failed, so the bytes are
        // worse than the header said. Say so and stop overwriting them.
        log.write("warn", "checkpoint.unreadable", {
          sessionId: r.info.id,
          ...errorFields(error),
        });
        r.preserveCheckpoint = true;
        r.info.checkpoint = {
          time: r.info.checkpoint?.time ?? 0,
          decodable: false,
          reason: String(error),
        };
        if (!r.removed) notify("checkpoint", r);
        throw new SessionError("UNSUPPORTED", "Saved screen cannot be decoded");
      } finally {
        r.restoring = undefined;
      }
    })());
  }
  let checkpointChain = Promise.resolve();
  let checkpointRunning = false;
  const checkpointPending = new Set<RecordState>();
  // Checkpoints follow changes, not the clock. A record with nothing new to
  // say costs no file write and no watch event, so an idle daemon holding
  // hundreds of retained records is silent.
  function checkpoint(r: RecordState) {
    if (r.removed || r.preserveCheckpoint || !r.dirty) return checkpointChain;
    checkpointPending.add(r);
    if (checkpointRunning) return checkpointChain;
    checkpointRunning = true;
    checkpointChain = (async () => {
      while (checkpointPending.size) {
        const r = checkpointPending.values().next().value!;
        checkpointPending.delete(r);
        if (r.removed) continue;
        // Cleared before the screen is read, so output arriving during the
        // write dirties the record again and is saved by the next tick.
        r.dirty = false;
        try {
          let snapshot = r.checkpoint;
          let snapshotError: unknown;
          try {
            snapshot = r.terminal?.snapshot() ?? snapshot;
          } catch (error) {
            snapshotError = error;
          }
          if (snapshotError)
            log.write("warn", "checkpoint.failed", {
              sessionId: r.info.id,
              ...errorFields(snapshotError),
            });
          if (snapshot) r.checkpoint = snapshot;
          r.info.checkpoint = {
            time: Date.now(),
            decodable: !!snapshot && !snapshotError,
            ...(snapshotError ? { reason: String(snapshotError) } : {}),
          };
          const payload = {
            info: r.info,
            snapshot: snapshot
              ? {
                  ...snapshot,
                  bytes: Buffer.from(snapshot.bytes).toString("base64"),
                }
              : undefined,
          };
          const file = path.join(config.stateDir, `${r.info.id}.json`);
          const json = JSON.stringify(payload);
          if (Buffer.byteLength(json) > limits.checkpointMaxBytes) {
            log.write("warn", "checkpoint.oversize", { sessionId: r.info.id });
            throw new Error("Checkpoint exceeds byte limit");
          }
          await fs.writeFile(`${file}.tmp`, json, {
            mode: 0o600,
          });
          await fs.rename(`${file}.tmp`, file);
          // A record whose screen is safely on disk can give its pages back.
          // Arming here rather than on exit means the terminal is only ever
          // released once there is something to restore it from, and an
          // already-armed timer keeps its own deadline.
          if (!r.child && r.terminal && !r.idle) armIdle(r);
        } catch (error) {
          log.write("warn", "checkpoint.failed", {
            sessionId: r.info.id,
            ...errorFields(error),
          });
          // Nothing reached the disk, so the record still owes a write.
          r.dirty = true;
          r.info.checkpoint = {
            time: Date.now(),
            decodable: false,
            reason: String(error),
          };
        }
        if (!r.removed) notify("checkpoint", r);
      }
    })().finally(() => {
      checkpointRunning = false;
    });
    return checkpointChain;
  }
  // `limits.sessions` bounds processes the daemon is responsible for, so a
  // retained record must not stand in the way of a new session.
  function liveSessions() {
    let live = 0;
    for (const r of records.values()) if (r.child) live++;
    return live;
  }
  function retainedRecords() {
    return [...records.values()].filter((r) => !r.child && !r.removed);
  }
  async function removeRecord(r: RecordState) {
    drainPulse(r, true);
    clearPulse(r);
    clearPreview(r);
    clearIdle(r);
    for (const v of [...viewers.values()])
      if (v.record === r) end(v, "session-ended");
    r.removed = true;
    // Claim the record before awaiting: `checkpoint` refuses a removed record
    // and the running chain skips it, so no write can follow the deletion.
    checkpointPending.delete(r);
    await checkpointChain;
    await fs.rm(path.join(config.stateDir, `${r.info.id}.json`), {
      force: true,
    });
    try {
      r.terminal?.dispose();
    } catch {}
    records.delete(r.info.id);
    notify("removed", r);
  }
  let evicting: Promise<void> | undefined;
  function evictRetained(): Promise<void> {
    // Serialised so concurrent exits cannot select the same oldest record.
    return (evicting = (evicting ?? Promise.resolve())
      .then(async () => {
        const retained = retainedRecords();
        if (retained.length <= limits.retainedSessions) return;
        retained.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
        for (const r of retained.slice(
          0,
          retained.length - limits.retainedSessions,
        )) {
          log.write("info", "session.evicted", {
            sessionId: r.info.id,
            state: r.info.state,
          });
          await removeRecord(r);
        }
      })
      .catch((error) => {
        log.write("warn", "session.evicted", errorFields(error));
      }));
  }
  for (const file of await fs.readdir(config.stateDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      // Retained files beyond the cap are left on disk untouched rather than
      // deleted at startup; eviction only ever drops records this daemon holds.
      if (records.size >= limits.retainedSessions) continue;
      if (
        (await fs.stat(path.join(config.stateDir, file))).size >
        limits.checkpointMaxBytes
      )
        continue;
      const saved = JSON.parse(
        await fs.readFile(path.join(config.stateDir, file), "utf8"),
      );
      if (!saved.info?.id || file !== `${saved.info.id}.json`) continue;
      if (
        typeof saved.info.id !== "string" ||
        !Array.isArray(saved.info.argv) ||
        !saved.info.labels ||
        typeof saved.info.labels !== "object"
      )
        continue;
      sizeValid(saved.info.size);
      const r: RecordState = { info: saved.info, position: 0 };
      // A configuration lowered since the record was written takes effect on
      // the next decode; the oldest pages are pruned as they come back.
      r.info.scrollbackBytes = Math.min(
        Number.isInteger(saved.info.scrollbackBytes) &&
          saved.info.scrollbackBytes >= 0
          ? saved.info.scrollbackBytes
          : limits.scrollbackMaxBytes,
        limits.scrollbackMaxBytes,
      );
      r.endedAt = r.info.checkpoint?.time ?? r.info.createdAt ?? 0;
      r.info.attachments = [];
      r.info.processTree = { children: 0 };
      if (r.info.state === "running" || r.info.state === "starting")
        r.info.state = "lost";
      // A record comes back as bytes, not as a terminal: the header is checked
      // here and the screen is decoded the first time something reads it.
      if (saved.snapshot) {
        r.checkpoint = {
          ...saved.snapshot,
          bytes: new Uint8Array(Buffer.from(saved.snapshot.bytes, "base64")),
        };
        const problem = checkpointProblem(r.checkpoint);
        if (problem) {
          log.write("warn", "checkpoint.unreadable", {
            sessionId: r.info.id,
            reason: problem,
          });
          r.preserveCheckpoint = true;
        }
        r.info.checkpoint = {
          time: r.info.checkpoint?.time ?? 0,
          decodable: !problem,
          ...(problem ? { reason: problem } : {}),
        };
      }
      records.set(r.info.id, r);
    } catch (error) {
      log.write("warn", "checkpoint.unreadable", {
        file,
        ...errorFields(error),
      });
      /* Preserve corrupt files for diagnosis. */
    }
  }
  async function request(
    c: Connection,
    method: string,
    p: any,
  ): Promise<{ result: any; after?: () => void }> {
    p ??= {};
    if (method === "daemonInfo") return { result: info };
    if (method === "watch" || method === "unwatch") {
      permission(c, "list");
      c.watch = method === "watch";
      return { result: null };
    }
    if (method === "list") {
      const result = [];
      for (const r of records.values()) {
        try {
          permission(c, "list", r);
        } catch (e) {
          // Only a refusal hides a record; anything else is an internal failure.
          if (e instanceof SessionError && e.code === "PERMISSION_DENIED")
            continue;
          throw e;
        }
        if (p.states && !p.states.includes(r.info.state)) continue;
        if (
          Object.entries(p.labels ?? {}).some(
            ([k, v]) => r.info.labels[k] !== v,
          )
        )
          continue;
        result.push(publicInfo(r));
      }
      return { result };
    }
    if (method === "create") {
      permission(c, "create");
      if (liveSessions() + pendingCreates >= limits.sessions)
        throw new SessionError("LIMIT", "Session limit reached");
      sizeValid(p.size);
      if (
        !Array.isArray(p.argv) ||
        !p.argv.length ||
        p.argv.some((x: unknown) => typeof x !== "string")
      )
        throw new SessionError(
          "INVALID_ARGUMENT",
          "argv must be a nonempty string array",
        );
      if (
        (p.name !== undefined && typeof p.name !== "string") ||
        (p.cwd !== undefined && typeof p.cwd !== "string") ||
        [p.labels, p.env].some(
          (value) =>
            value !== undefined &&
            (!value ||
              typeof value !== "object" ||
              Array.isArray(value) ||
              Object.values(value).some((x) => typeof x !== "string")),
        )
      )
        throw new SessionError("INVALID_ARGUMENT", "Invalid session metadata");
      if (
        (p.name?.length ?? 0) > 256 ||
        Object.entries(p.labels ?? {}).length > 128 ||
        Object.entries(p.labels ?? {}).some(
          ([key, value]) => key.length > 256 || (value as string).length > 1024,
        )
      )
        throw new SessionError("LIMIT", "Session metadata exceeds limits");
      validateEnvironment(p.env);
      if (
        p.scrollbackBytes !== undefined &&
        (!Number.isInteger(p.scrollbackBytes) || p.scrollbackBytes < 0)
      )
        throw new SessionError(
          "INVALID_ARGUMENT",
          "scrollbackBytes must be a non-negative integer",
        );
      // Refused rather than clamped: a caller that asked for more history than
      // this daemon serves should hear so instead of believing it has it.
      if ((p.scrollbackBytes ?? 0) > limits.scrollbackMaxBytes)
        throw new SessionError(
          "LIMIT",
          `scrollbackBytes exceeds the daemon cap of ${limits.scrollbackMaxBytes}`,
        );
      const scrollbackBytes = p.scrollbackBytes ?? limits.scrollbackMaxBytes;
      pendingCreates++;
      let terminal: TerminalHandle;
      try {
        terminal = await config.engineFactory.create(p.size, {
          scrollbackBytes,
        });
      } finally {
        pendingCreates--;
      }
      if (closing || c.closed) {
        terminal.dispose();
        throw new SessionError("CLOSED", "Connection closed during creation");
      }
      const r: RecordState = {
        terminal,
        position: 0,
        info: {
          id: randomUUID(),
          daemonId: id,
          state: "starting",
          argv: p.argv,
          cwd: p.cwd ?? process.cwd(),
          size: p.size,
          scrollbackBytes,
          createdAt: Date.now(),
          name: p.name ?? p.argv[0],
          labels: p.labels ?? {},
          attachments: [],
          processTree: { foreground: p.argv[0], children: 0 },
        },
        dirty: true,
      };
      try {
        r.child = spawnPty(
          p.argv,
          r.info.cwd,
          sessionEnvironment(p.env, r.info.id, id, info.version),
          p.size,
          (bytes) => {
            if (closing || r.info.state === "failed") return;
            try {
              const effects = terminal.write(bytes);
              r.dirty = true;
              r.info.lastOutputAt = Date.now();
              broadcast(r, { type: "output", data: bytes });
              previewChanged(r);
              for (const effect of effects) {
                if (effect.kind === "reply") {
                  r.child?.write(effect.payload as Uint8Array);
                  continue;
                }
                const timed = { ...effect, time: Date.now() };
                r.info.lastEffect = timed;
                if (effect.kind === "title")
                  r.info.title = String(effect.payload);
                if (effect.kind === "cwd")
                  r.info.reportedCwd = String(effect.payload);
                broadcast(r, { type: "effect", effect: timed });
                pulse(r, timed);
              }
              pulse(r);
            } catch (e) {
              log.write("error", "session.failed", {
                sessionId: r.info.id,
                ...errorFields(e),
              });
              r.dirty = true;
              r.info.state = "failed";
              r.info.exit = {
                code: null,
                reason: `Engine fault: ${String(e)}`,
              };
              try {
                r.child?.terminate("force");
              } catch {}
              const broken = r.terminal;
              r.terminal = undefined;
              clearPreview(r);
              clearIdle(r);
              try {
                broken?.dispose();
              } catch {}
              for (const viewer of [...viewers.values()])
                if (viewer.record === r) end(viewer, "session-ended");
              drainPulse(r, true);
              notify("state", r);
              clearPulse(r);
            }
          },
        );
      } catch (e) {
        log.write("warn", "session.spawn-failed", {
          sessionId: r.info.id,
          command: p.argv[0],
          ...errorFields(e),
        });
        terminal.dispose();
        throw new SessionError(
          "INVALID_ARGUMENT",
          `Spawn failed: ${String(e)}`,
        );
      }
      records.set(r.info.id, r);
      r.info.state = "running";
      log.write("info", "session.create", {
        sessionId: r.info.id,
        command: p.argv[0],
        cwd: r.info.cwd,
        principal: c.principal.id,
      });
      notify("created", r);
      void checkpoint(r);
      void r.child.exited.then((code) => {
        r.dirty = true;
        if (r.info.state !== "failed") r.info.state = "exited";
        r.info.exit ??= { code };
        r.info.processTree = { children: 0 };
        for (const v of [...viewers.values()])
          if (v.record === r) end(v, "session-ended");
        r.child?.close();
        r.child = undefined;
        r.endedAt = Date.now();
        log.write("info", "session.exit", { sessionId: r.info.id, code });
        drainPulse(r, true);
        notify("exited", r);
        clearPulse(r);
        void checkpoint(r);
        void evictRetained();
      });
      return { result: publicInfo(r) };
    }
    if (
      ["input", "resize", "transferSize", "claimSize", "detach"].includes(
        method,
      )
    ) {
      const v = viewerFor(c, p.attachmentId);
      if (method === "detach") {
        end(v, "detached");
        return { result: null };
      }
      if (method === "input") {
        if (!v.info.permissions.input)
          throw new SessionError("PERMISSION_DENIED", "Input refused");
        if (!(p.data instanceof Uint8Array))
          throw new SessionError("INVALID_ARGUMENT", "Input must be bytes");
        if (!v.record.child)
          throw new SessionError("CONFLICT", "Session has no live process");
        v.record.child.write(p.data);
        v.record.info.lastInputAt = Date.now();
        pulse(v.record);
        return { result: null };
      }
      if (method === "claimSize") {
        if (!v.info.permissions.input)
          throw new SessionError(
            "PERMISSION_DENIED",
            "Attachment cannot claim the size",
          );
        const holder = sizeHolder(v.record);
        if (holder === v) return { result: null };
        if (holder) {
          permission(c, "claimSize", v.record);
          holder.info.holdsSize = false;
          emit(holder, { type: "size-holder", holdsSize: false });
        }
        v.info.holdsSize = true;
        // The claim states an intent the listing and any later succession read.
        v.info.holdSize = "claim";
        emit(v, { type: "size-holder", holdsSize: true });
        notify("attachments-updated", v.record);
        return { result: null };
      }
      if (!v.info.holdsSize)
        throw new SessionError(
          "PERMISSION_DENIED",
          "Attachment does not hold the size",
        );
      if (method === "resize") {
        sizeValid(p.size);
        // A saved screen has no process to inform, so reflowing it would rewrite
        // the record a dead session left behind.
        if (!v.record.child)
          throw new SessionError("CONFLICT", "Session has no live process");
        v.record.child.resize(p.size);
        v.record.terminal?.resize(p.size);
        v.record.dirty = true;
        v.record.info.size = p.size;
        // Restore authoritative post-resize state: snapshot restore does not retain
        // all of the engine's scrollback reflow context. Resizing a replica alone
        // can therefore disagree with the daemon even with an ordered stream.
        broadcast(v.record, { type: "resize", size: p.size });
        previewChanged(v.record);
        notify("resized", v.record);
      } else {
        const target = viewers.get(p.targetAttachmentId);
        if (!target || target.record !== v.record)
          throw new SessionError(
            "INVALID_ARGUMENT",
            "Size recipient must attach to the same session",
          );
        if (target.info.holdSize === "never")
          throw new SessionError(
            "INVALID_ARGUMENT",
            "Size recipient does not take the size",
          );
        v.info.holdsSize = false;
        target.info.holdsSize = true;
        emit(v, { type: "size-holder", holdsSize: false });
        emit(target, { type: "size-holder", holdsSize: true });
        notify("attachments-updated", v.record);
      }
      return { result: null };
    }
    if (method === "endAttachment") {
      const v = viewers.get(p.attachmentId);
      if (!v) throw new SessionError("NOT_FOUND", "Attachment not found");
      permission(c, "endAttachment", v.record);
      end(v, "revoked");
      return { result: null };
    }
    const r = recordFor(p.sessionId);
    permission(c, method === "get" ? "list" : method, r);
    if (method === "get") return { result: publicInfo(r) };
    if (method === "readScreen" || method === "readHistory") {
      const terminal = await ensureTerminal(r);
      return {
        result:
          method === "readScreen"
            ? terminal.readScreen()
            : terminal.readHistory(),
      };
    }
    if (method === "terminate") {
      if (!["interrupt", "terminate", "force"].includes(p.intent))
        throw new SessionError(
          "INVALID_ARGUMENT",
          "Unknown termination intent",
        );
      const delivery = r.child?.terminate(p.intent);
      return {
        result: {
          delivered: !!delivery,
          intent: p.intent,
          exit: r.info.exit,
          ...delivery,
        },
      };
    }
    if (method === "remove") {
      if (r.child)
        throw new SessionError(
          "CONFLICT",
          "Terminate the session before removing it",
        );
      await removeRecord(r);
      return { result: null };
    }
    if (method === "attach") {
      if (viewers.size >= limits.attachments)
        throw new SessionError("LIMIT", "Attachment limit reached");
      // A record with no live terminal attaches from its checkpoint bytes; the
      // client decodes what the daemon has not.
      if (!config.engineFactory.capabilities.snapshot || savedScreenProblem(r))
        throw new SessionError("UNSUPPORTED", "Saved screen cannot be decoded");
      const representation: Representation = p.representation ?? "snapshot";
      if (!["snapshot", "vt", "preview"].includes(representation))
        throw new SessionError("UNSUPPORTED", "Representation is reserved");
      const preview = representation === "preview";
      if (preview && !config.engineFactory.capabilities.preview)
        throw new SessionError(
          "UNSUPPORTED",
          "Engine cannot format a screen for preview",
        );
      if (
        p.holdSize !== undefined &&
        !["never", "if-free", "claim"].includes(p.holdSize)
      )
        throw new SessionError("INVALID_ARGUMENT", "Unknown size intent");
      const previewFormat: PreviewFormat = p.preview?.format ?? "vt";
      if (!["vt", "plain"].includes(previewFormat))
        throw new SessionError("INVALID_ARGUMENT", "Unknown preview format");
      // A tile asks for a rate and takes what the daemon allows; asking for a
      // rate the daemon will not serve is not worth failing an attach over.
      const requestedInterval =
        p.preview?.intervalMs ?? limits.previewIntervalMs;
      if (
        typeof requestedInterval !== "number" ||
        !Number.isFinite(requestedInterval) ||
        requestedInterval <= 0
      )
        throw new SessionError("INVALID_ARGUMENT", "Invalid preview interval");
      const previewIntervalMs = Math.min(
        limits.previewMaxIntervalMs,
        Math.max(limits.previewMinIntervalMs, requestedInterval),
      );
      const requested = p.permissions ?? { read: true, input: false };
      const grant = permission(c, "attach", r, requested);
      const granted = grant === true ? requested : grant;
      if (!granted.read || (requested.input && !granted.input))
        throw new SessionError(
          "PERMISSION_DENIED",
          "Requested permissions refused",
        );
      // A tile watches; it has no way to type even where the grant allows it,
      // and the response says so rather than pretending otherwise.
      const permissions = preview ? { ...granted, input: false } : granted;
      // Whoever can type is presumed to want the grid to fit; a watcher takes
      // nothing unless it says so, and a tile never takes it at all.
      const holdSize: HoldSize = preview
        ? "never"
        : ((p.holdSize as HoldSize | undefined) ??
          (permissions.input ? "if-free" : "never"));
      // A record with no live process has only its saved screen to offer. The
      // attachment delivers that, the outcome when the daemon knows it, and
      // ends; it never becomes a viewer, so it holds no size, receives no
      // output, and is never listed as watching a session nobody can watch.
      const live = !!r.child;
      // The size is free until something takes it, so an attachment that only
      // watches leaves it where it is. `claim` degrades to attaching without
      // the size rather than failing, which spares a terminal a second round
      // trip when the daemon's policy refuses the takeover.
      // A tile is the one representation the daemon renders itself, so a saved
      // record has to decode its screen before it can serve one.
      if (preview) await ensureTerminal(r);
      let displaced: Viewer | undefined;
      let holdsSize = false;
      if (live && holdSize !== "never") {
        const holder = sizeHolder(r);
        if (!holder) holdsSize = true;
        else if (
          holdSize === "claim" &&
          permissions.input &&
          mayClaimSize(c, r)
        ) {
          displaced = holder;
          holdsSize = true;
        }
      }
      const v: Viewer = {
        info: {
          id: randomUUID(),
          sessionId: r.info.id,
          generation: ++generation,
          principal: c.principal,
          permissions,
          representation,
          holdSize,
          holdsSize,
        },
        record: r,
        connection: c,
        position: 0,
        representation,
        previewFormat,
        previewIntervalMs,
      };
      // A tile's first event is its picture, in place of the snapshot it has no
      // replica to restore. Formatting it here rather than waiting for the
      // record's next tick is one formatter call per tile attach, not per tick.
      const initial = encodeFrame(
        preview
          ? {
              type: "event",
              event: {
                ...previewPayload(r, previewFormat),
                attachmentId: v.info.id,
                generation: v.info.generation,
                position: v.position,
              },
            }
          : stateEvent(v, "snapshot"),
        c.wire.maxSendFrameBytes,
      );
      const stream = newStream(v, true);
      pushControl(c, stream, {
        frame: initial,
        bytes: initial.byteLength,
        position: v.position,
      });
      if (live) {
        viewers.set(v.info.id, v);
        r.info.attachments.push(v.info);
        if (preview) {
          const state = previewState(r);
          state.viewers.add(v);
          previewInterval(state);
        }
        // Only now that the attachment is certain does the holder lose it.
        if (displaced) {
          displaced.info.holdsSize = false;
          emit(displaced, { type: "size-holder", holdsSize: false });
        }
      }
      return {
        result: v.info,
        after() {
          if (c.closed) {
            if (live) end(v, "connection-closed");
            return;
          }
          if (!live) {
            // A lost record has no outcome to report; the state reaches the
            // consumer through `get` and the watch stream instead.
            if (r.info.exit) emit(v, { type: "exit", exit: r.info.exit });
            emit(v, { type: "ended", reason: "session-ended" });
          }
          stream.held = false;
          void flush(c);
          if (live) notify("attached", r, { attachment: v.info });
        },
      };
    }
    throw new SessionError("INVALID_ARGUMENT", `Unknown method ${method}`);
  }
  function accept(transport: Transport, principal?: Principal) {
    if (closing) {
      void transport.close();
      return;
    }
    const c: Connection = {
      wire: new FramedTransport(
        transport,
        limits.maxInputFrameBytes,
        Math.max(DEFAULT_MAX_QUEUED_BYTES, limits.maxFrameBytes + 4),
        limits.maxFrameBytes,
      ),
      principal: principal ?? owner(),
      watch: false,
      closed: false,
      control: [],
      controlBytes: 0,
      streams: new Map(),
      bytes: 0,
      writing: false,
      streamControlCount: 0,
    };
    connections.add(c);
    log.write("info", "connection.accept", { principal: c.principal.id });
    const timer = setTimeout(() => dropConnection(c), limits.helloTimeoutMs);
    void (async () => {
      try {
        let hello = false;
        for await (const message of c.wire.messages()) {
          if (!hello) {
            if (
              message.type !== "hello" ||
              message.protocolVersion !== PROTOCOL_VERSION
            )
              throw new SessionError("PROTOCOL", "Incompatible hello");
            c.wire.setSendLimit(
              Math.min(
                limits.maxFrameBytes,
                message.maxFrameBytes ?? CLIENT_MAX_FRAME_BYTES,
              ),
            );
            if (config.authenticate)
              c.principal = await config.authenticate(message.credential);
            hello = true;
            clearTimeout(timer);
            queue(c, {
              type: "hello",
              protocolVersion: PROTOCOL_VERSION,
              maxFrameBytes: limits.maxInputFrameBytes,
              daemon: info,
              principal: c.principal,
            });
            continue;
          }
          if (message.type !== "request")
            throw new SessionError("PROTOCOL", "Expected request");
          try {
            const { result, after } = await request(
              c,
              message.method,
              message.params,
            );
            queue(c, { type: "response", id: message.id, result });
            after?.();
          } catch (e) {
            const error =
              e instanceof SessionError
                ? e
                : new SessionError("INTERNAL", String(e));
            log.write(
              error.code === "INTERNAL" ? "error" : "debug",
              error.code === "INTERNAL" ? "request.internal" : "request.error",
              {
                method: message.method,
                code: error.code,
                ...(error.code === "INTERNAL" ? errorFields(e) : {}),
              },
            );
            queue(c, {
              type: "response",
              id: message.id,
              error: { code: error.code, message: error.message },
            });
          }
        }
      } catch {
      } finally {
        clearTimeout(timer);
        dropConnection(c);
      }
    })();
  }
  // The tick is an opportunity to save, not an obligation: only records that
  // have changed since their last write are offered to `checkpoint`.
  const interval = setInterval(() => {
    for (const r of records.values()) if (r.dirty) void checkpoint(r);
  }, limits.checkpointIntervalMs);
  interval.unref();
  let closePromise: Promise<void> | undefined;
  function close() {
    return (closePromise ??= (async () => {
      closing = true;
      clearInterval(interval);
      for (const c of [...connections]) dropConnection(c);
      for (const r of records.values()) {
        try {
          r.child?.terminate("force");
        } catch {}
      }
      let timer: ReturnType<typeof setTimeout>;
      await Promise.race([
        Promise.allSettled([...records.values()].map((r) => r.child?.exited)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, limits.shutdownTimeoutMs);
        }),
      ]);
      clearTimeout(timer!);
      for (const r of records.values()) {
        try {
          r.child?.close();
        } catch {}
      }
      for (const r of records.values()) {
        clearPulse(r);
        clearPreview(r);
        // Exits during the wait above have already saved their final screen;
        // a record that has not changed since its last write is left alone.
        await checkpoint(r);
        // After the write, so the checkpoint's own arming does not outlive it.
        clearIdle(r);
        try {
          r.terminal?.dispose();
        } catch {}
        r.terminal = undefined;
      }
      await checkpointChain;
      await evicting;
    })());
  }
  return {
    info,
    accept,
    close,
    /** Flushes every record that has changed since its last saved screen. */
    async checkpoint() {
      for (const r of records.values()) await checkpoint(r);
      await checkpointChain;
    },
    diagnostics() {
      return {
        sessions: records.size,
        attachments: viewers.size,
        connections: connections.size,
        pendingCheckpoints: checkpointPending.size,
        checkpointWriting: checkpointRunning,
        outputQueueBytes: [...connections].reduce((sum, c) => sum + c.bytes, 0),
        controlQueueBytes: [...connections].reduce(
          (sum, c) => sum + c.controlBytes,
          0,
        ),
      };
    },
  };
}
export async function serveSessionDaemon(config: DaemonConfig) {
  const paths = resolveSessionDaemonPaths(config);
  const suppliedLog = config.log;
  const log =
    config.log ??
    createLogger({
      file: path.join(paths.stateDir, "daemon.log"),
      level: config.logLevel,
    });
  config = { ...config, log };
  try {
    await ensurePrivateDirectory(paths.stateDir);
    await ensurePrivateDirectory(paths.runtimeDir);
    // The socket path is checked before anything is created, so a path that cannot work
    // leaves no lock file and no record behind.
    if (socketPathTooLong(paths.socket))
      throw new Error("Unix socket path exceeds portable length limit");
    // One daemon per state directory. Where the state directory cannot hold a lock at all
    // the runtime directory keeps the weaker "one daemon per runtime directory" guarantee,
    // and the record below is what stops a second daemon starting beside a live one.
    const lockable = lockableDirectory(paths.stateDir);
    const lockFile = lockable ? paths.lock : paths.fallbackLock;
    let releaseLock: LockRelease;
    try {
      releaseLock = acquireDaemonLock(lockFile);
    } catch (error) {
      log.write("error", "lock.refused", {
        path: lockFile,
        ...errorFields(error),
      });
      throw error;
    }
    log.write("info", "lock.acquired", {
      path: lockFile,
      mechanism: releaseLock.mechanism,
      ...(lockable
        ? {}
        : { fallback: "runtime-dir", reason: "state-dir-cannot-lock" }),
    });
    const relock = () => {
      // Only a `flock` follows the file it was taken on; the other mechanisms are held by a
      // handle or a socket name, so their file is a marker to put back.
      if (releaseLock.mechanism !== "flock")
        return recreateLockMarker(lockFile);
      const next = acquireDaemonLock(lockFile);
      const previous = releaseLock;
      releaseLock = next;
      previous();
      log.write("info", "lock.acquired", {
        path: lockFile,
        mechanism: next.mechanism,
        reason: "recreated",
      });
    };
    let daemon: Awaited<ReturnType<typeof createSessionDaemon>> | undefined;
    let server: net.Server | undefined;
    let supervisor: ReturnType<typeof startDaemonSupervisor> | undefined;
    try {
      const credential =
        process.platform === "win32" ? randomUUID() + randomUUID() : undefined;
      daemon = await createSessionDaemon(
        credential
          ? {
              ...config,
              authenticate: async (supplied) => {
                if (supplied !== credential)
                  throw new Error("Invalid local credential");
                return owner();
              },
            }
          : config,
      );
      const accept = (socket: net.Socket) =>
        daemon!.accept(socketTransport(socket), owner());
      // Listening again on the same path is how the daemon recovers a removed socket; the
      // previous server is closed only once the new one is bound.
      const listen = async () => {
        // A closing server unlinks the path it was bound to, so the old one goes first;
        // established connections keep their own sockets and are unaffected.
        const previous = server;
        server = undefined;
        previous?.close();
        const next = net.createServer(accept);
        // Bind under a private name and rename it into place: a client that reads the
        // endpoint record never finds a socket that is still world-accessible, and a client
        // holding the old record sees either the previous socket or this one.
        const temporary = credential
          ? ""
          : `${paths.socket}.${process.pid}.new`;
        if (temporary) await fs.rm(temporary, { force: true });
        await new Promise<void>((resolve, reject) => {
          next.once("error", reject);
          if (credential) next.listen(0, "127.0.0.1", resolve);
          else next.listen(temporary, resolve);
        });
        if (temporary) {
          await fs.chmod(temporary, 0o600);
          await fs.rename(temporary, paths.socket);
        }
        server = next;
      };
      let endpoint: LocalEndpoint = { kind: "unix", path: paths.socket };
      const writeEndpoint = async () => {
        if (credential)
          endpoint = {
            kind: "tcp",
            host: "127.0.0.1",
            port: (server!.address() as net.AddressInfo).port,
            credential,
          };
        else endpoint = { kind: "unix", path: paths.socket };
        await fs.writeFile(paths.endpoint, JSON.stringify(endpoint), {
          mode: 0o600,
        });
      };
      await listen();
      await writeEndpoint();
      log.write("info", "endpoint.written", { path: paths.endpoint });
      // The record is what `ensureSessionDaemon` reads to refuse to spawn beside a daemon
      // that is still alive but whose endpoint has gone.
      await writeDaemonRecord(paths.record, {
        pid: process.pid,
        bootId: currentBootId(),
        startedAt: processStartedAt(process.pid) ?? Date.now(),
        runtimeDir: paths.runtimeDir,
        stateDir: paths.stateDir,
        endpoint,
        version: daemon.info.version,
      });
      supervisor = startDaemonSupervisor({
        paths,
        log,
        socketBound: !credential,
        socketInode: credential ? null : (await fs.stat(paths.socket)).ino,
        relisten: listen,
        writeEndpoint,
        lockFile,
        relock,
        intervalMs: config.limits?.superviseIntervalMs,
        touchIntervalMs: config.limits?.touchIntervalMs,
      });
      log.write("info", "daemon.start", {
        version: daemon.info.version,
        pid: process.pid,
        bootId: currentBootId(),
        runtimeDir: paths.runtimeDir,
        stateDir: paths.stateDir,
        lock: lockFile,
        mechanism: releaseLock.mechanism,
        record: paths.record,
      });
      let closePromise: Promise<void> | undefined;
      const close = () =>
        (closePromise ??= (async () => {
          // Stop defending the files before removing them, or the supervisor puts them back.
          supervisor!.stop();
          server?.close();
          await daemon!.close();
          await Promise.all([
            fs.rm(paths.endpoint, { force: true }),
            fs.rm(paths.socket, { force: true }),
            clearDaemonRecord(paths.record),
          ]);
          releaseLock();
          log.write("info", "daemon.stop", { reason: "closed" });
          if (!suppliedLog) log.close();
        })());
      return {
        ...daemon,
        get endpoint() {
          return endpoint;
        },
        supervise: () => supervisor!.check(),
        close,
      };
    } catch (e) {
      supervisor?.stop();
      server?.close();
      await daemon?.close();
      await Promise.all([
        fs.rm(paths.socket, { force: true }),
        fs.rm(`${paths.socket}.${process.pid}.new`, { force: true }),
        fs.rm(paths.endpoint, { force: true }),
        clearDaemonRecord(paths.record),
      ]).catch(() => {});
      releaseLock();
      throw e;
    }
  } catch (error) {
    log.write("error", "daemon.stop", {
      reason: "startup-failed",
      ...errorFields(error),
    });
    if (!suppliedLog) log.close();
    throw error;
  }
}
