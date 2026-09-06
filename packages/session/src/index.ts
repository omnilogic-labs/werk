import {
  FramedTransport,
  PROTOCOL_VERSION,
  type Transport,
  type WireMessage,
} from "./protocol.js";
import {
  SessionError,
  type AttachmentInfo,
  type AttachmentEvent,
  type AttachOptions,
  type DaemonInfo,
  type Principal,
  type DaemonEvent,
  type RequestOptions,
  type CreateSessionOptions,
  type ListOptions,
  type SessionInfo,
  type Size,
  type TerminationIntent,
  type TerminationResult,
} from "./types.js";
export * from "./types.js";
export type { Transport } from "./protocol.js";
export interface ConnectOptions extends RequestOptions {
  transport: Transport;
  credential?: string;
  requestTimeoutMs?: number;
  maxPendingRequests?: number;
  onCallbackError?: (error: unknown) => void;
}
type Immutable<T> = T extends object
  ? { readonly [K in keyof T]: Immutable<T[K]> }
  : T;
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
};
export class Attachment {
  private ended = false;
  private position = -1;
  private state: AttachmentInfo;
  private removeAbort?: () => void;
  constructor(
    private client: SessionClient,
    info: AttachmentInfo,
    private listener: (event: AttachmentEvent) => void,
  ) {
    this.state = immutable(structuredClone(info));
  }
  get info(): Immutable<AttachmentInfo> {
    return this.state;
  }
  bindLifetime(signal?: AbortSignal): void {
    if (!signal) return;
    const abort = () => {
      if (this.ended) return;
      this.deliver({
        type: "ended",
        attachmentId: this.id,
        generation: this.generation,
        position: this.position + 1,
        reason: "detached",
      });
      void this.client
        .request("detach", { attachmentId: this.id })
        .catch((error) => this.client.close(error));
    };
    this.removeAbort = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  }
  get id() {
    return this.info.id;
  }
  get principal() {
    return this.info.principal;
  }
  get permissions() {
    return this.info.permissions;
  }
  get holdsSize() {
    return this.info.holdsSize;
  }
  get generation() {
    return this.info.generation;
  }
  get sessionId() {
    return this.info.sessionId;
  }
  /** Internal delivery also rejects stale generations and duplicate stream positions. */
  deliver(event: AttachmentEvent): void {
    if (
      this.ended ||
      event.generation !== this.generation ||
      event.position <= this.position
    )
      return;
    if (
      this.position < 0 &&
      event.type !== "snapshot" &&
      event.type !== "resync" &&
      event.type !== "ended"
    )
      throw new SessionError(
        "PROTOCOL",
        "Attachment must begin with authoritative state",
      );
    if (
      this.position >= 0 &&
      event.position !== this.position + 1 &&
      !["resync", "snapshot", "ended"].includes(event.type)
    )
      throw new SessionError(
        "PROTOCOL",
        "Attachment stream gap requires resynchronisation",
      );
    this.position = event.position;
    if (event.type === "size-holder")
      this.state = immutable({ ...this.state, holdsSize: event.holdsSize });
    if (event.type === "ended") {
      this.ended = true;
      this.removeAbort?.();
      this.client.forget(this.id);
    }
    this.client.invoke(() => this.listener(event));
  }
  connectionClosed(): void {
    this.deliver({
      type: "ended",
      attachmentId: this.id,
      generation: this.generation,
      position: this.position + 1,
      reason: "connection-closed",
    });
  }
  private active(): void {
    if (this.ended) throw new SessionError("CLOSED", "Attachment ended");
  }
  async writeInput(data: Uint8Array, options?: RequestOptions): Promise<void> {
    this.active();
    if (!this.permissions.input)
      throw new SessionError(
        "PERMISSION_DENIED",
        "Attachment cannot send input",
      );
    await this.client.request(
      "input",
      { attachmentId: this.id, data },
      options,
    );
  }
  async resize(size: Size, options?: RequestOptions): Promise<void> {
    this.active();
    if (!this.holdsSize)
      throw new SessionError(
        "PERMISSION_DENIED",
        "Attachment does not hold size",
      );
    await this.client.request(
      "resize",
      { attachmentId: this.id, size },
      options,
    );
  }
  async transferSize(
    targetAttachmentId: string,
    options?: RequestOptions,
  ): Promise<void> {
    this.active();
    await this.client.request(
      "transferSize",
      { attachmentId: this.id, targetAttachmentId },
      options,
    );
  }
  async detach(options?: RequestOptions): Promise<void> {
    if (this.ended) return;
    await this.client.request("detach", { attachmentId: this.id }, options);
  }
}
export type WatchSubscription = (() => void) & { ready: Promise<void> };
export class SessionClient {
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private ended = false;
  private serial = 0;
  private pending = new Map<string, Pending>();
  private attachments = new Map<string, Attachment>();
  private watchers = new Set<(event: DaemonEvent) => void>();
  private watchChain: Promise<unknown> = Promise.resolve();
  constructor(
    private wire: FramedTransport,
    public readonly daemon: DaemonInfo,
    public readonly principal: Principal,
    private options: ConnectOptions,
  ) {
    immutable(daemon);
    immutable(principal);
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }
  invoke(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      try {
        this.options.onCallbackError?.(error);
      } catch {}
    }
  }
  forget(id: string): void {
    this.attachments.delete(id);
  }
  async consume(messages: AsyncIterator<WireMessage>): Promise<void> {
    try {
      while (!this.ended) {
        const next = await messages.next();
        if (next.done) break;
        const message = next.value;
        if (message.type === "response") {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          pending.cleanup();
          if (message.error)
            pending.reject(
              new SessionError(
                message.error.code,
                message.error.message,
                message.error.outcomeUnknown,
              ),
            );
          else pending.resolve(message.result);
        } else if (message.type === "event")
          this.attachments
            .get(message.event.attachmentId)
            ?.deliver(message.event);
        else if (message.type === "daemon-event")
          for (const watcher of this.watchers)
            this.invoke(() => watcher(message.event));
        else throw new SessionError("PROTOCOL", "Unexpected server message");
      }
    } catch (error) {
      await this.close(error);
      return;
    }
    await this.close();
  }
  request<T = unknown>(
    method: string,
    params: unknown,
    options: RequestOptions = {},
    onResult?: (result: T) => void,
  ): Promise<T> {
    if (this.ended)
      return Promise.reject(new SessionError("CLOSED", "Connection closed"));
    if (options.signal?.aborted)
      return Promise.reject(
        new SessionError("CANCELLED", "Request cancelled before sending"),
      );
    if (this.pending.size >= (this.options.maxPendingRequests ?? 128))
      return Promise.reject(
        new SessionError("LIMIT", "Too many pending requests"),
      );
    const timeout = options.timeoutMs ?? this.options.requestTimeoutMs ?? 5000;
    if (!Number.isFinite(timeout) || timeout <= 0)
      return Promise.reject(
        new SessionError(
          "INVALID_ARGUMENT",
          "Request timeout must be finite and positive",
        ),
      );
    const id = String(++this.serial);
    return new Promise<T>((resolve, reject) => {
      const fail = (error: SessionError) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup();
        reject(error);
        if (method === "attach") void this.close(error);
      };
      const abort = () =>
        fail(
          new SessionError(
            "CANCELLED",
            "Request cancelled; remote outcome is unknown",
            true,
          ),
        );
      const timer = setTimeout(
        () =>
          fail(
            new SessionError(
              "TIMEOUT",
              "Request timed out; remote outcome is unknown",
              true,
            ),
          ),
        timeout,
      );
      this.pending.set(id, {
        resolve: (value) => {
          try {
            onResult?.(value as T);
            resolve(value as T);
          } catch (error) {
            reject(error);
            void this.close(error);
          }
        },
        reject,
        cleanup: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
        },
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      void this.wire
        .send({ type: "request", id, method, params })
        .catch((error) => {
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          pending.cleanup();
          reject(error);
        });
    });
  }
  create(options: CreateSessionOptions, request?: RequestOptions) {
    return this.request<SessionInfo>("create", options, request);
  }
  list(options: ListOptions = {}, request?: RequestOptions) {
    return this.request<SessionInfo[]>("list", options, request);
  }
  get(sessionId: string, request?: RequestOptions) {
    return this.request<SessionInfo>("get", { sessionId }, request);
  }
  daemonInfo(request?: RequestOptions) {
    return this.request<DaemonInfo>("daemonInfo", {}, request);
  }
  readScreen(sessionId: string, request?: RequestOptions) {
    return this.request<string>("readScreen", { sessionId }, request);
  }
  readHistory(sessionId: string, request?: RequestOptions) {
    return this.request<string>("readHistory", { sessionId }, request);
  }
  terminate(
    sessionId: string,
    intent: TerminationIntent = "terminate",
    request?: RequestOptions,
  ) {
    return this.request<TerminationResult>(
      "terminate",
      { sessionId, intent },
      request,
    );
  }
  remove(sessionId: string, request?: RequestOptions) {
    return this.request<void>("remove", { sessionId }, request);
  }
  endAttachment(attachmentId: string, request?: RequestOptions) {
    return this.request<void>("endAttachment", { attachmentId }, request);
  }
  async attach(sessionId: string, options: AttachOptions): Promise<Attachment> {
    let attachment!: Attachment;
    await this.request<AttachmentInfo>(
      "attach",
      {
        sessionId,
        representation: options.representation ?? "snapshot",
        permissions: options.permissions ?? { read: true, input: false },
      },
      options,
      (info) => {
        attachment = new Attachment(this, info, options.onEvent);
        this.attachments.set(info.id, attachment);
        attachment.bindLifetime(options.signal);
      },
    );
    return attachment;
  }
  watch(callback: (event: DaemonEvent) => void): WatchSubscription {
    const first = this.watchers.size === 0;
    const listener = (event: DaemonEvent) => callback(event);
    this.watchers.add(listener);
    let stopped = false;
    const ready = first
      ? this.watchChain
          .catch(() => {})
          .then(() => this.request<void>("watch", {}))
      : this.watchChain.then(() => {});
    this.watchChain = ready;
    const stop = (() => {
      if (stopped) return;
      stopped = true;
      this.watchers.delete(listener);
      if (!this.watchers.size)
        this.watchChain = this.watchChain
          .catch(() => {})
          .then(() => (this.ended ? undefined : this.request("unwatch", {})));
      void this.watchChain.catch(() => {});
    }) as WatchSubscription;
    stop.ready = ready;
    void ready.catch(() => {
      this.watchers.delete(listener);
    });
    return stop;
  }
  async close(
    reason: unknown = new SessionError("CLOSED", "Connection closed"),
  ): Promise<void> {
    if (this.ended) return this.closed;
    this.ended = true;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(reason);
    }
    this.pending.clear();
    for (const attachment of this.attachments.values())
      attachment.connectionClosed();
    this.watchers.clear();
    try {
      await this.wire.close(reason);
    } finally {
      this.resolveClosed();
    }
  }
}
export async function connectSessionClient(
  options: ConnectOptions,
): Promise<SessionClient> {
  const wire = new FramedTransport(options.transport);
  const messages = wire.messages();
  const timeout = options.timeoutMs ?? options.requestTimeoutMs ?? 5000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new SessionError(
        "INVALID_ARGUMENT",
        "Hello timeout must be finite and positive",
      );
    if (options.signal?.aborted)
      throw new SessionError("CANCELLED", "Connection cancelled");
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new SessionError("TIMEOUT", "Hello timed out")),
        timeout,
      );
      abort = () =>
        reject(new SessionError("CANCELLED", "Connection cancelled"));
      options.signal?.addEventListener("abort", abort, { once: true });
    });
    const handshake = async () => {
      await wire.send({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        credential: options.credential,
      });
      return messages.next();
    };
    const next = await Promise.race([handshake(), deadline]);
    if (
      next.done ||
      next.value.type !== "hello" ||
      next.value.protocolVersion !== PROTOCOL_VERSION ||
      !next.value.daemon ||
      !next.value.principal ||
      typeof next.value.principal.id !== "string" ||
      !next.value.principal.id ||
      typeof next.value.daemon.id !== "string" ||
      !next.value.daemon.id ||
      typeof next.value.daemon.version !== "string" ||
      next.value.daemon.protocolVersion !== PROTOCOL_VERSION ||
      typeof next.value.daemon.engine?.buildId !== "string" ||
      !Number.isSafeInteger(next.value.daemon.engine?.snapshotFormatVersion) ||
      next.value.daemon.engine.snapshotFormatVersion < 1 ||
      typeof next.value.daemon.capabilities?.snapshots !== "boolean" ||
      !Array.isArray(next.value.daemon.capabilities?.termination) ||
      !next.value.daemon.capabilities.termination.every((value) =>
        ["interrupt", "terminate", "force"].includes(value),
      )
    )
      throw new SessionError("PROTOCOL", "Incompatible or malformed hello");
    const client = new SessionClient(
      wire,
      next.value.daemon,
      next.value.principal,
      options,
    );
    void client.consume(messages);
    return client;
  } catch (error) {
    await wire.close(error);
    throw error;
  } finally {
    clearTimeout(timer);
    if (abort) options.signal?.removeEventListener("abort", abort);
  }
}
