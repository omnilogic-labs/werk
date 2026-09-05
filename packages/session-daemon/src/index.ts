import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  FramedTransport,
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
  type DaemonInfo,
  type Size,
  type EndReason,
} from "@werk/session";
import type {
  TerminalEngineFactory,
  TerminalHandle,
  SnapshotEnvelope,
} from "@werk/terminal";
import { spawnPty, platformCapabilities } from "./platform/index.js";
import {
  resolveSessionDaemonPaths,
  socketTransport,
  type LocalEndpoint,
} from "./local.js";
export * from "./local.js";
export interface DaemonConfig {
  runtimeDir: string;
  stateDir: string;
  engineFactory: TerminalEngineFactory;
  limits?: {
    sessions?: number;
    attachments?: number;
    outputQueueBytes?: number;
    controlQueueMessages?: number;
    helloTimeoutMs?: number;
    checkpointIntervalMs?: number;
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
type RecordState = {
  info: SessionInfo;
  terminal?: TerminalHandle;
  child?: Child;
  position: number;
  checkpoint?: SnapshotEnvelope;
};
type Viewer = {
  info: AttachmentInfo;
  record: RecordState;
  connection: Connection;
  position: number;
  representation: string;
};
type Connection = {
  wire: FramedTransport;
  principal: Principal;
  watch: boolean;
  closed: boolean;
  control: WireMessage[];
  output: Map<string, { message: WireMessage; bytes: number }[]>;
  bytes: number;
  writing: boolean;
  dirty: Set<string>;
};
const owner = (): Principal => ({
  id: `uid:${process.getuid?.() ?? process.env.USERNAME ?? "local"}`,
});
function sizeValid(size: Size) {
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
  const limits = {
    sessions: 128,
    attachments: 128,
    outputQueueBytes: 256 * 1024,
    controlQueueMessages: 1024,
    helloTimeoutMs: 5000,
    checkpointIntervalMs: 5000,
    ...config.limits,
  };
  for (const [key, value] of Object.entries(limits))
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`Invalid limit ${key}`);
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
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
      ...platformCapabilities,
    },
  };
  const records = new Map<string, RecordState>(),
    viewers = new Map<string, Viewer>(),
    connections = new Set<Connection>();
  let closing = false,
    generation = 0;
  function publicInfo(record: RecordState): SessionInfo {
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
    c.output.clear();
    c.dirty.clear();
    void c.wire.close();
  }
  function queue(
    c: Connection,
    message: WireMessage,
    attachmentId?: string,
    bytes = 0,
  ) {
    if (c.closed) return;
    if (attachmentId) {
      if (c.dirty.has(attachmentId)) return;
      if (c.bytes + bytes > limits.outputQueueBytes) {
        const old = c.output.get(attachmentId) ?? [];
        c.bytes -= old.reduce((sum, x) => sum + x.bytes, 0);
        c.output.delete(attachmentId);
        c.dirty.add(attachmentId);
      } else {
        const queue = c.output.get(attachmentId) ?? [];
        queue.push({ message, bytes });
        c.output.set(attachmentId, queue);
        c.bytes += bytes;
      }
    } else {
      if (c.control.length >= limits.controlQueueMessages) {
        dropConnection(c);
        return;
      }
      c.control.push(message);
    }
    void flush(c);
  }
  function stateEvent(v: Viewer, type: "snapshot" | "resync") {
    const snapshot = v.record.terminal?.snapshot() ?? v.record.checkpoint;
    if (!snapshot)
      throw new SessionError("UNSUPPORTED", "No decodable saved screen");
    return {
      type: "event",
      event: {
        type,
        attachmentId: v.info.id,
        generation: v.info.generation,
        position: ++v.position,
        size: v.record.info.size,
        snapshot: snapshot.bytes,
        engineBuildId: snapshot.engineBuild,
        snapshotFormatVersion: snapshot.formatVersion,
      },
    } as WireMessage;
  }
  async function flush(c: Connection) {
    if (c.writing || c.closed) return;
    c.writing = true;
    try {
      while (!c.closed) {
        let message = c.control.shift();
        if (!message) {
          const dirty = c.dirty.values().next().value;
          if (dirty) {
            c.dirty.delete(dirty);
            const v = viewers.get(dirty);
            if (v) message = stateEvent(v, "resync");
          } else {
            const entry = c.output.entries().next().value;
            if (entry) {
              const [key, items] = entry,
                item = items.shift()!;
              c.bytes -= item.bytes;
              message = item.message;
              if (!items.length) c.output.delete(key);
            }
          }
        }
        if (!message) break;
        await c.wire.send(message);
      }
    } catch {
      dropConnection(c);
    } finally {
      c.writing = false;
    }
  }
  function emit(v: Viewer, event: any, droppable = false) {
    if (!droppable && event.type !== "ended") {
      const old = v.connection.output.get(v.info.id) ?? [];
      v.connection.bytes -= old.reduce((sum, x) => sum + x.bytes, 0);
      v.connection.output.delete(v.info.id);
      v.connection.dirty.delete(v.info.id);
      queue(v.connection, stateEvent(v, "resync"));
    }
    queue(
      v.connection,
      {
        type: "event",
        event: {
          ...event,
          attachmentId: v.info.id,
          generation: v.info.generation,
          position: ++v.position,
        },
      },
      droppable ? v.info.id : undefined,
      droppable ? (event.data?.byteLength ?? 512) : 0,
    );
  }
  function broadcast(r: RecordState, event: any, droppable = true) {
    for (const v of viewers.values())
      if (v.record === r) emit(v, event, droppable);
  }
  function notify(type: any, r: RecordState, extra: any = {}) {
    for (const c of connections)
      if (c.watch) {
        try {
          permission(c, "list", r);
          queue(c, {
            type: "daemon-event",
            event: {
              type,
              sessionId: r.info.id,
              session: publicInfo(r),
              time: Date.now(),
              ...extra,
            },
          });
        } catch {}
      }
  }
  function end(v: Viewer, reason: EndReason) {
    viewers.delete(v.info.id);
    v.record.info.attachments = v.record.info.attachments.filter(
      (a) => a.id !== v.info.id,
    );
    const queued = v.connection.output.get(v.info.id) ?? [];
    v.connection.bytes -= queued.reduce((sum, x) => sum + x.bytes, 0);
    v.connection.output.delete(v.info.id);
    v.connection.dirty.delete(v.info.id);
    if (reason === "session-ended") {
      queue(v.connection, stateEvent(v, "resync"));
      if (v.record.info.exit)
        emit(v, { type: "exit", exit: v.record.info.exit });
    }
    emit(v, { type: "ended", reason });
    if (v.info.holdsSize) {
      const next = [...viewers.values()].find((x) => x.record === v.record);
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
  let checkpointChain = Promise.resolve();
  function checkpoint(r: RecordState) {
    checkpointChain = checkpointChain.then(async () => {
      try {
        const snapshot = r.terminal?.snapshot() ?? r.checkpoint;
        r.info.checkpoint = { time: Date.now(), decodable: !!snapshot };
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
        await fs.writeFile(`${file}.tmp`, JSON.stringify(payload), {
          mode: 0o600,
        });
        await fs.rename(`${file}.tmp`, file);
      } catch (error) {
        r.info.checkpoint = {
          time: Date.now(),
          decodable: false,
          reason: String(error),
        };
      }
    });
    return checkpointChain;
  }
  for (const file of await fs.readdir(config.stateDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const saved = JSON.parse(
        await fs.readFile(path.join(config.stateDir, file), "utf8"),
      );
      if (!saved.info?.id || file !== `${saved.info.id}.json`) continue;
      const r: RecordState = { info: saved.info, position: 0 };
      r.info.attachments = [];
      r.info.processTree = { children: 0 };
      if (r.info.state === "running" || r.info.state === "starting")
        r.info.state = "lost";
      if (saved.snapshot) {
        r.checkpoint = {
          ...saved.snapshot,
          bytes: new Uint8Array(Buffer.from(saved.snapshot.bytes, "base64")),
        };
        try {
          r.terminal = await config.engineFactory.restore(r.checkpoint!);
          r.info.checkpoint = {
            time: r.info.checkpoint?.time ?? 0,
            decodable: true,
          };
        } catch (e) {
          r.info.checkpoint = {
            time: r.info.checkpoint?.time ?? 0,
            decodable: false,
            reason: String(e),
          };
        }
      }
      records.set(r.info.id, r);
    } catch {
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
        } catch {
          continue;
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
      if (records.size >= limits.sessions)
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
      const terminal = await config.engineFactory.create(p.size);
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
          createdAt: Date.now(),
          name: p.name ?? p.argv[0],
          labels: p.labels ?? {},
          attachments: [],
          processTree: { foreground: p.argv[0], children: 0 },
        },
      };
      try {
        r.child = spawnPty(
          p.argv,
          r.info.cwd,
          { ...process.env, TERM: "xterm-256color", ...p.env },
          p.size,
          (bytes) => {
            if (closing || r.info.state === "failed") return;
            try {
              const effects = terminal.write(bytes);
              r.info.lastOutputAt = Date.now();
              broadcast(r, { type: "output", data: bytes });
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
                broadcast(r, { type: "effect", effect: timed }, false);
                notify("effect", r, { effect: timed });
              }
              notify("activity", r);
            } catch (e) {
              r.info.state = "failed";
              r.info.exit = {
                code: null,
                reason: `Engine fault: ${String(e)}`,
              };
              r.child?.terminate("force");
              notify("state", r);
            }
          },
        );
      } catch (e) {
        terminal.dispose();
        throw new SessionError(
          "INVALID_ARGUMENT",
          `Spawn failed: ${String(e)}`,
        );
      }
      records.set(r.info.id, r);
      r.info.state = "running";
      notify("created", r);
      void checkpoint(r);
      void r.child.exited.then((code) => {
        if (r.info.state !== "failed") r.info.state = "exited";
        r.info.exit ??= { code };
        r.info.processTree = { children: 0 };
        for (const v of [...viewers.values()])
          if (v.record === r) end(v, "session-ended");
        r.child?.close();
        r.child = undefined;
        notify("exited", r);
        void checkpoint(r);
      });
      return { result: publicInfo(r) };
    }
    if (["input", "resize", "transferSize", "detach"].includes(method)) {
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
        notify("activity", v.record);
        return { result: null };
      }
      if (!v.info.holdsSize)
        throw new SessionError(
          "PERMISSION_DENIED",
          "Attachment does not hold the size",
        );
      if (method === "resize") {
        sizeValid(p.size);
        v.record.child?.resize(p.size);
        v.record.terminal?.resize(p.size);
        v.record.info.size = p.size;
        broadcast(v.record, { type: "resize", size: p.size });
      } else {
        const target = viewers.get(p.targetAttachmentId);
        if (!target || target.record !== v.record)
          throw new SessionError(
            "INVALID_ARGUMENT",
            "Size recipient must attach to the same session",
          );
        v.info.holdsSize = false;
        target.info.holdsSize = true;
        emit(v, { type: "size-holder", holdsSize: false });
        emit(target, { type: "size-holder", holdsSize: true });
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
      if (!r.terminal)
        throw new SessionError("UNSUPPORTED", "Saved screen cannot be decoded");
      return {
        result:
          method === "readScreen"
            ? r.terminal.readScreen()
            : r.terminal.readHistory(),
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
      for (const v of [...viewers.values()])
        if (v.record === r) end(v, "session-ended");
      await checkpointChain;
      await fs.rm(path.join(config.stateDir, `${r.info.id}.json`), {
        force: true,
      });
      r.terminal?.dispose();
      records.delete(r.info.id);
      return { result: null };
    }
    if (method === "attach") {
      if (viewers.size >= limits.attachments)
        throw new SessionError("LIMIT", "Attachment limit reached");
      if (!r.terminal)
        throw new SessionError("UNSUPPORTED", "Saved screen cannot be decoded");
      if (
        p.representation &&
        p.representation !== "snapshot" &&
        p.representation !== "vt"
      )
        throw new SessionError("UNSUPPORTED", "Representation is reserved");
      const requested = p.permissions ?? { read: true, input: false };
      const grant = permission(c, "attach", r, requested);
      const permissions = grant === true ? requested : grant;
      if (!permissions.read || (requested.input && !permissions.input))
        throw new SessionError(
          "PERMISSION_DENIED",
          "Requested permissions refused",
        );
      const v: Viewer = {
        info: {
          id: randomUUID(),
          sessionId: r.info.id,
          generation: ++generation,
          principal: c.principal,
          permissions,
          holdsSize: !r.info.attachments.length,
        },
        record: r,
        connection: c,
        position: 0,
        representation: p.representation ?? "snapshot",
      };
      viewers.set(v.info.id, v);
      r.info.attachments.push(v.info);
      return {
        result: v.info,
        after() {
          queue(c, stateEvent(v, "snapshot"));
          notify("attached", r, { attachment: v.info });
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
      wire: new FramedTransport(transport),
      principal: principal ?? owner(),
      watch: false,
      closed: false,
      control: [],
      output: new Map(),
      bytes: 0,
      writing: false,
      dirty: new Set(),
    };
    connections.add(c);
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
            if (config.authenticate)
              c.principal = await config.authenticate(message.credential);
            hello = true;
            clearTimeout(timer);
            queue(c, {
              type: "hello",
              protocolVersion: PROTOCOL_VERSION,
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
  const interval = setInterval(() => {
    for (const r of records.values()) void checkpoint(r);
  }, limits.checkpointIntervalMs);
  interval.unref();
  let closePromise: Promise<void> | undefined;
  function close() {
    return (closePromise ??= (async () => {
      closing = true;
      clearInterval(interval);
      for (const c of [...connections]) dropConnection(c);
      for (const r of records.values()) {
        r.child?.terminate("force");
      }
      await Promise.all([...records.values()].map((r) => r.child?.exited));
      for (const r of records.values()) {
        await checkpoint(r);
        r.terminal?.dispose();
      }
      await checkpointChain;
    })());
  }
  return { info, accept, close };
}
export async function serveSessionDaemon(config: DaemonConfig) {
  const paths = resolveSessionDaemonPaths(config);
  await fs.mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  const stat = await fs.stat(paths.runtimeDir);
  if (process.getuid && stat.uid !== process.getuid())
    throw new Error("Runtime directory belongs to another user");
  await fs.chmod(paths.runtimeDir, 0o700);
  let lock: Awaited<ReturnType<typeof fs.open>>;
  try {
    lock = await fs.open(paths.lock, "wx", 0o600);
  } catch {
    let pid = 0;
    try {
      pid = Number(await fs.readFile(paths.lock, "utf8"));
      process.kill(pid, 0);
      throw new Error("Daemon already running");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
    await fs.unlink(paths.lock);
    lock = await fs.open(paths.lock, "wx", 0o600);
  }
  await lock.writeFile(String(process.pid));
  let daemon: Awaited<ReturnType<typeof createSessionDaemon>> | undefined;
  let server: net.Server | undefined;
  try {
    daemon = await createSessionDaemon(config);
    await fs.rm(paths.socket, { force: true });
    const endpoint: LocalEndpoint = { kind: "unix", path: paths.socket };
    server = net.createServer((socket) =>
      daemon!.accept(socketTransport(socket), owner()),
    );
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(paths.socket, resolve);
    });
    await fs.chmod(paths.socket, 0o600);
    await fs.writeFile(paths.endpoint, JSON.stringify(endpoint), {
      mode: 0o600,
    });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      server!.close();
      await daemon!.close();
      await lock.close();
      await Promise.all([
        fs.rm(paths.lock, { force: true }),
        fs.rm(paths.endpoint, { force: true }),
        fs.rm(paths.socket, { force: true }),
      ]);
    };
    return { ...daemon, endpoint, close };
  } catch (e) {
    server?.close();
    await daemon?.close();
    await lock.close();
    await fs.rm(paths.lock, { force: true });
    throw e;
  }
}
