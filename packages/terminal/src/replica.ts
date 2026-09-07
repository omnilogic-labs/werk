import type {
  TerminalEngineFactory,
  TerminalHandle,
  Size,
  Renderer,
  Frame,
  InputModes,
} from "./types.js";
export interface ReplicaEvent {
  type: string;
  attachmentId: string;
  generation: number;
  position: number;
  size?: Size;
  snapshot?: Uint8Array;
  engineBuildId?: string;
  snapshotFormatVersion?: number;
  data?: Uint8Array;
}
/** Return a cancellation function when the scheduler supports cancellation. */
export type PaintScheduler = (paint: () => void) => void | (() => void);
export interface ReplicaOptions {
  schedulePaint?: PaintScheduler;
}
export const defaultScheduler: PaintScheduler = (paint) => {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(paint, 0);
  return () => clearTimeout(id);
};
export class TerminalReplica {
  private terminal?: TerminalHandle;
  private attachmentId?: string;
  private generation = -1;
  private position = -1;
  private closed = false;
  private queue = Promise.resolve();
  private pending?: { cancel?: () => void };
  private paintError?: { error: unknown };
  private schedule: PaintScheduler;
  constructor(
    private factory: TerminalEngineFactory,
    private renderer?: Renderer,
    options: ReplicaOptions = {},
  ) {
    this.schedule = options.schedulePaint ?? defaultScheduler;
  }
  apply(event: ReplicaEvent): Promise<void> {
    const next = this.queue.then(async () => {
      await this.accept(event);
      this.throwPaintError();
    });
    this.queue = next.catch(() => {});
    return next;
  }
  private async accept(e: ReplicaEvent) {
    if (this.closed) throw new Error("Replica is disposed");
    const establishes = e.type === "snapshot" || e.type === "resync";
    if (e.generation < this.generation) return;
    if (
      e.generation === this.generation &&
      this.attachmentId !== undefined &&
      e.attachmentId !== this.attachmentId
    )
      return;
    if (e.generation === this.generation && e.position <= this.position) return;
    if (establishes) {
      if (!e.snapshot || !e.size)
        throw new Error("Snapshot requires bytes and dimensions");
      const terminal = await this.factory.restore({
        engineBuild: e.engineBuildId ?? this.factory.buildId,
        formatVersion:
          e.snapshotFormatVersion ?? this.factory.snapshotFormatVersion,
        size: e.size,
        bytes: e.snapshot,
      });
      if (this.closed) {
        terminal.dispose();
        return;
      }
      this.terminal?.dispose();
      this.terminal = terminal;
      this.attachmentId = e.attachmentId;
      this.generation = e.generation;
    } else {
      if (
        e.generation !== this.generation ||
        e.attachmentId !== this.attachmentId ||
        e.position !== this.position + 1
      )
        throw new Error("Replica stream gap: resynchronisation required");
      if (e.type === "output" && e.data) this.terminal!.write(e.data);
      if (e.type === "resize" && e.size) this.terminal!.resize(e.size);
    }
    this.position = e.position;
    if (this.terminal && this.renderer) this.requestPaint();
    if (e.type === "ended") this.flush();
  }
  private requestPaint() {
    if (this.pending) return;
    const pending: { cancel?: () => void } = {};
    this.pending = pending;
    try {
      const cancel = this.schedule(() => {
        if (this.pending !== pending || this.closed) return;
        this.pending = undefined;
        try {
          this.renderer!.paint(this.terminal!.frame());
        } catch (error) {
          this.paintError = { error };
        }
      });
      if (typeof cancel === "function") pending.cancel = cancel;
    } catch (error) {
      this.pending = undefined;
      throw error;
    }
  }
  /** Paint applied events now; also surface any earlier scheduled paint failure. */
  flush(): void {
    if (this.closed) return;
    this.throwPaintError();
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    pending.cancel?.();
    this.renderer!.paint(this.terminal!.frame());
  }
  private throwPaintError() {
    if (!this.paintError) return;
    const { error } = this.paintError;
    this.paintError = undefined;
    throw error;
  }
  inputModes(): InputModes | undefined {
    return this.terminal?.inputModes();
  }
  readScreen() {
    return this.terminal?.readScreen() ?? "";
  }
  frame(): Frame | undefined {
    return this.terminal?.frame();
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    const pending = this.pending;
    this.pending = undefined;
    this.paintError = undefined;
    try {
      pending?.cancel?.();
    } finally {
      try {
        this.terminal?.dispose();
      } finally {
        this.renderer?.dispose();
      }
    }
  }
}
export function createTerminalReplica(
  factory: TerminalEngineFactory,
  renderer?: Renderer,
  options: ReplicaOptions = {},
) {
  return new TerminalReplica(factory, renderer, options);
}
