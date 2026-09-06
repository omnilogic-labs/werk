export interface Size {
  cols: number;
  rows: number;
}
export interface Principal {
  id: string;
  displayName?: string;
  [key: string]: unknown;
}
export interface Permissions {
  list?: boolean;
  read: boolean;
  input: boolean;
}
export type SessionState =
  "starting" | "running" | "exited" | "failed" | "lost";
export type TerminationIntent = "interrupt" | "terminate" | "force";
export interface ExitOutcome {
  code: number | null;
  signal?: string;
  reason?: string;
}
export interface Effect {
  kind: string;
  payload: unknown;
  time: number;
}
export interface AttachmentInfo {
  id: string;
  sessionId: string;
  generation: number;
  principal: Principal;
  permissions: Permissions;
  holdsSize: boolean;
}
export interface SessionInfo {
  id: string;
  daemonId: string;
  state: SessionState;
  argv: string[];
  cwd: string;
  size: Size;
  createdAt: number;
  name: string;
  labels: Record<string, string>;
  lastOutputAt?: number;
  lastInputAt?: number;
  title?: string;
  reportedCwd?: string;
  lastEffect?: Effect;
  exit?: ExitOutcome;
  attachments: AttachmentInfo[];
  checkpoint?: { time: number; decodable: boolean; reason?: string };
  processTree: { foreground?: string; children: number };
}
export interface CreateSessionOptions {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  size: Size;
  name?: string;
  labels?: Record<string, string>;
}
export interface ListOptions {
  labels?: Record<string, string>;
  states?: SessionState[];
}
export interface DaemonInfo {
  id: string;
  version: string;
  protocolVersion: number;
  engine: { buildId: string; snapshotFormatVersion: number };
  capabilities: {
    termination: TerminationIntent[];
    snapshots: boolean;
    [key: string]: unknown;
  };
}
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export type Representation = "snapshot" | "vt" | "preview";
/** signal owns the attachment lifetime, including after attach resolves. */
export interface AttachOptions extends RequestOptions {
  representation?: Representation;
  permissions?: Permissions;
  onEvent: (event: AttachmentEvent) => void;
}
export type EndReason =
  "detached" | "session-ended" | "connection-closed" | "revoked";
export type AttachmentEvent = {
  attachmentId: string;
  generation: number;
  position: number;
} & (
  | {
      type: "snapshot" | "resync";
      size: Size;
      snapshot: Uint8Array;
      engineBuildId?: string;
      snapshotFormatVersion?: number;
    }
  | { type: "output"; data: Uint8Array }
  | { type: "resize"; size: Size }
  | { type: "effect"; effect: Effect }
  | { type: "exit"; exit: ExitOutcome }
  | { type: "size-holder"; attachmentId: string; holdsSize: boolean }
  | { type: "ended"; reason: EndReason }
);
export interface DaemonEvent {
  type:
    | "created"
    | "state"
    | "exited"
    | "effect"
    | "activity"
    | "attached"
    | "detached"
    | "attachments-updated"
    | "resized"
    | "checkpoint"
    | "removed";
  sessionId: string;
  session?: SessionInfo;
  effect?: Effect;
  attachment?: AttachmentInfo;
  time: number;
  [key: string]: unknown;
}
export interface TerminationResult {
  delivered: boolean;
  intent: TerminationIntent;
  exit?: ExitOutcome;
}
export type ErrorCode =
  | "PROTOCOL"
  | "CLOSED"
  | "TIMEOUT"
  | "CANCELLED"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "INVALID_ARGUMENT"
  | "CONFLICT"
  | "LIMIT"
  | "INTERNAL"
  | "UNSUPPORTED";
export class SessionError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = "SessionError";
  }
}
