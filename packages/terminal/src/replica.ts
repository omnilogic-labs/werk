import type {
  TerminalEngineFactory,
  TerminalHandle,
  Size,
  Renderer,
  Frame,
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
export class TerminalReplica {
  private terminal?: TerminalHandle;
  private attachmentId?: string;
  private generation = -1;
  private position = -1;
  private closed = false;
  private queue = Promise.resolve();
  constructor(
    private factory: TerminalEngineFactory,
    private renderer?: Renderer,
  ) {}
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
    if (this.terminal && this.renderer)
      this.renderer.paint(this.terminal.frame());
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
    this.terminal?.dispose();
    this.renderer?.dispose();
  }
}
export function createTerminalReplica(
  factory: TerminalEngineFactory,
  renderer?: Renderer,
) {
  return new TerminalReplica(factory, renderer);
}
