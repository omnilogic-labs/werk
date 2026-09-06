// Prototype of a paint-coalescing TerminalReplica. Scratch only.
// Events are applied to the terminal as they arrive (apply() still resolves
// or rejects per event); at most one paint runs per scheduler tick.
import type {
  TerminalEngineFactory,
  TerminalHandle,
  Size,
  Renderer,
  Frame,
  InputModes,
} from "/home/mike/Development/omnilogic-labs/werk/packages/terminal/src/types.ts";
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
export type PaintScheduler = (paint: () => void) => void;
export interface ReplicaOptions {
  /**
   * Runs the pending paint once per tick. Defaults to requestAnimationFrame
   * where it exists and setTimeout(0) elsewhere. queueMicrotask is not a
   * useful choice: apply() chains events through promises, so a microtask
   * paint runs between two events of the same burst.
   */
  schedulePaint?: PaintScheduler;
}
export const defaultScheduler: PaintScheduler =
  typeof requestAnimationFrame === "function"
    ? (paint) => requestAnimationFrame(() => paint())
    : (paint) => setTimeout(paint, 0);
export class TerminalReplica {
  private terminal?: TerminalHandle;
  private attachmentId?: string;
  private generation = -1;
  private position = -1;
  private closed = false;
  private queue = Promise.resolve();
  private paintPending = false;
  private paintScheduled = false;
  private schedule: PaintScheduler;
  paints = 0;
  constructor(
    private factory: TerminalEngineFactory,
    private renderer?: Renderer,
    options: ReplicaOptions = {},
  ) {
    this.schedule = options.schedulePaint ?? defaultScheduler;
  }
  apply(event: ReplicaEvent): Promise<void> {
    const next = this.queue.then(() => this.accept(event));
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
  }
  private requestPaint() {
    this.paintPending = true;
    if (this.paintScheduled) return;
    this.paintScheduled = true;
    this.schedule(() => {
      this.paintScheduled = false;
      this.flush();
    });
  }
  /** Paint now if anything is pending. Tests and synchronous consumers use this. */
  flush() {
    if (!this.paintPending || this.closed || !this.terminal || !this.renderer)
      return;
    this.paintPending = false;
    this.paints++;
    this.renderer.paint(this.terminal.frame());
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
    this.paintPending = false;
    this.terminal?.dispose();
    this.renderer?.dispose();
  }
}
