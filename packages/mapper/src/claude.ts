/**
 * The mapper for `claude`.
 *
 * This is the case that prompted mappers at all: the terminal shows an agent
 * mid-sentence, and the question a person actually has is whether it is working,
 * whether it is stuck on them, and what it is working on. None of that is on the
 * screen in a form anything can read.
 *
 * ## What it reads
 *
 * Claude keeps two things this needs, both under `~/.claude`.
 *
 * `sessions/<pid>.json` is one record per running claude, written by that
 * process, and it carries the answer directly: a `status` of `busy`, `waiting`
 * or `idle`, a `waitingFor` sentence when it is waiting, the `cwd` it was
 * started in and the `sessionId` of its transcript. werk finds the record for a
 * terminal process by matching that `cwd` against the directory werk started the
 * process in, because nothing on either side records the other.
 *
 * `projects/<encoded cwd>/<sessionId>.jsonl` is the transcript, and the last few
 * kilobytes of it say what the agent is on: the title it gave the work, the
 * prompt it is answering, and the last thing it did. Only the tail is read.
 *
 * ## What it does not do
 *
 * It does not run anything, so on a machine with a `/proc` it can tell a live
 * claude from a record left behind by a dead one, and on a machine without one
 * it cannot. It reports what it could establish rather than assuming.
 *
 * It reads `~/.claude`, so a claude started with `CLAUDE_CONFIG_DIR` pointing
 * elsewhere is invisible to it. `MapperSubject` carries no environment, and
 * werk's own session records do not keep one either, so there is nothing to read
 * that from yet.
 */
import type {
  Activity,
  Mapper,
  MapperSubject,
  ProcessStatus,
  ReadAccess,
} from "./types.js";

/** How much of a transcript is read. The end is the only part that is current. */
export const TRANSCRIPT_TAIL_BYTES = 96 * 1024;

/** The longest thing put in a fact meant to be read on one line. */
const LINE_LIMIT = 200;

/**
 * How claude names the directory it keeps a working directory's transcripts in.
 *
 * Every character that is not a letter or a digit becomes a hyphen, so
 * `/home/mike/.local/state` becomes `-home-mike--local-state`: the run of two
 * comes from the separator and the dot next to each other, and is not a
 * mistake.
 */
export const projectDirectoryName = (cwd: string): string =>
  cwd.replace(/[^a-zA-Z0-9]/g, "-");

/** The part of `sessions/<pid>.json` this reads. */
interface SessionRecord {
  readonly pid: number;
  readonly sessionId: string;
  readonly cwd: string;
  readonly status: string;
  readonly waitingFor?: string;
  readonly updatedAt: number;
  readonly statusUpdatedAt?: number;
  readonly name?: string;
  readonly version?: string;
  readonly kind?: string;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** A record werk can use, or nothing. Anything malformed is simply not there. */
export function readSessionRecord(raw: string): SessionRecord | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const pid = number(value.pid);
  const sessionId = text(value.sessionId);
  const cwd = text(value.cwd);
  const status = text(value.status);
  if (pid === undefined || sessionId === undefined) return null;
  if (cwd === undefined || status === undefined) return null;
  const record: {
    -readonly [K in keyof SessionRecord]: SessionRecord[K];
  } = {
    pid,
    sessionId,
    cwd,
    status,
    updatedAt: number(value.updatedAt) ?? number(value.statusUpdatedAt) ?? 0,
  };
  const waitingFor = text(value.waitingFor);
  if (waitingFor !== undefined) record.waitingFor = waitingFor;
  const statusUpdatedAt = number(value.statusUpdatedAt);
  if (statusUpdatedAt !== undefined) record.statusUpdatedAt = statusUpdatedAt;
  const name = text(value.name);
  if (name !== undefined) record.name = name;
  const version = text(value.version);
  if (version !== undefined) record.version = version;
  const kind = text(value.kind);
  if (kind !== undefined) record.kind = kind;
  return record;
}

/** What the tail of a transcript said, as much of it as was in the tail. */
export interface TranscriptReading {
  /** The title claude gave the work. */
  readonly title?: string;
  /** The prompt it is answering. */
  readonly prompt?: string;
  /** What the last assistant turn did: a tool name, `thinking`, or `replying`. */
  readonly did?: string;
  /** The tool call's own description, when the tool carried one. */
  readonly detail?: string;
  /** The end of the last thing it said in words. */
  readonly said?: string;
  readonly model?: string;
  /** When the last entry in the tail was written. */
  readonly at?: number;
}

const clip = (value: string): string =>
  value.length <= LINE_LIMIT ? value : `${value.slice(0, LINE_LIMIT - 1)}…`;

/**
 * Read the tail of a transcript.
 *
 * The first line is dropped: a tail taken at a byte offset almost always starts
 * halfway through one. Every other line that will not parse is skipped rather
 * than failing the read, because a transcript being appended to while it is read
 * ends in a partial line as often as not.
 */
export function readTranscriptTail(tail: string): TranscriptReading {
  const lines = tail.split("\n").slice(1);
  const reading: {
    title?: string;
    prompt?: string;
    did?: string;
    detail?: string;
    said?: string;
    model?: string;
    at?: number;
  } = {};
  for (const line of lines) {
    if (line.trim() === "") continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const stamp = text(entry.timestamp);
    if (stamp !== undefined) {
      const at = Date.parse(stamp);
      if (Number.isFinite(at)) reading.at = at;
    }
    if (entry.type === "ai-title") {
      reading.title = text(entry.aiTitle) ?? reading.title;
      continue;
    }
    if (entry.type === "last-prompt") {
      const prompt = text(entry.lastPrompt);
      if (prompt !== undefined) reading.prompt = clip(prompt.split("\n")[0]!);
      continue;
    }
    if (entry.type !== "assistant") continue;
    const message = entry.message as Record<string, unknown> | undefined;
    if (message === undefined || typeof message !== "object") continue;
    reading.model = text(message.model) ?? reading.model;
    const content = Array.isArray(message.content) ? message.content : [];
    // The last block of the turn is what the turn amounted to: a turn that
    // thought and then called a tool is a tool call.
    for (const block of content as Record<string, unknown>[]) {
      if (block === null || typeof block !== "object") continue;
      if (block.type === "tool_use") {
        reading.did = text(block.name) ?? "a tool";
        const input = block.input as Record<string, unknown> | undefined;
        const described =
          input && typeof input === "object"
            ? (text(input.description) ?? text(input.command))
            : undefined;
        reading.detail = described === undefined ? undefined : clip(described);
      } else if (block.type === "text") {
        const said = text(block.text);
        if (said === undefined) continue;
        reading.did = "replying";
        reading.detail = undefined;
        const last = said
          .split("\n")
          .map((one) => one.trim())
          .filter((one) => one !== "")
          .pop();
        if (last !== undefined) reading.said = clip(last);
      } else if (block.type === "thinking") {
        reading.did = "thinking";
        reading.detail = undefined;
      }
    }
  }
  return reading;
}

/** Trailing separators off, so two spellings of one directory compare equal. */
const normalise = (directory: string, separator: string): string => {
  let end = directory.length;
  while (end > 1 && directory[end - 1] === separator) end -= 1;
  return directory.slice(0, end);
};

/**
 * Whether pids can be checked at all from here.
 *
 * A mapper runs no processes, so the only way it can tell a live claude from a
 * record one left behind is a `/proc` to look the pid up in. Machines without
 * one are reported as "could not tell" rather than having either answer assumed
 * for them.
 */
const canSeeProcesses = async (access: ReadAccess): Promise<boolean> =>
  (await access.facts(access.join("/proc", "self"))) !== null;

const pidExists = async (access: ReadAccess, pid: number): Promise<boolean> =>
  (await access.facts(access.join("/proc", String(pid)))) !== null;

/** The base name of a path under either separator. */
const program = (command: string): string =>
  command.split(/[\\/]/).pop() ?? command;

/** How claude's own word for what it is doing maps onto the loop's words. */
function activityOf(status: string): Activity {
  if (status === "busy") return "working";
  if (status === "waiting") return "waiting";
  if (status === "idle") return "idle";
  return "unknown";
}

/** What the last assistant turn amounted to, as a phrase. */
function phrase(reading: TranscriptReading): string | undefined {
  if (reading.did === undefined) return undefined;
  if (reading.did === "thinking" || reading.did === "replying")
    return reading.did;
  return reading.detail === undefined
    ? `running ${reading.did}`
    : `running ${reading.did}: ${reading.detail}`;
}

/**
 * The one line a person reads, given everything that was legible.
 *
 * An ended process gets the same treatment as a live one rather than a bare
 * "it stopped", because the question about a session that finished while nobody
 * was watching is what it did, and the transcript is the only thing that says.
 */
function summarise(
  activity: Activity,
  record: SessionRecord | null,
  reading: TranscriptReading,
): string {
  const did = phrase(reading);
  if (activity === "ended")
    return did === undefined ? "ended" : `ended after ${did}`;
  if (activity === "waiting") return record?.waitingFor ?? "input needed";
  if (activity === "idle")
    return did === undefined ? "idle" : `idle after ${did}`;
  if (activity === "unknown")
    return record === null
      ? "running, and left no status of its own"
      : `claude says ${record.status}`;
  return did ?? "working";
}

export const claudeMapper: Mapper = {
  id: "claude",
  program: "claude",

  claims(subject) {
    const named = [subject.argv[0], subject.foreground].filter(
      (one): one is string => one !== undefined,
    );
    return named.some((one) => program(one) === "claude");
  },

  async read(subject, access): Promise<ProcessStatus | null> {
    const readAt = Date.now();
    const home = await access.home();
    if (home === null) return null;
    const root = access.join(home, ".claude");

    const files = await access.readEach(access.join(root, "sessions"), {
      suffix: ".json",
    });
    const here = [subject.cwd, subject.reportedCwd]
      .filter((one): one is string => one !== undefined)
      .map((one) => normalise(one, access.separator));
    const matched = [...(files?.values() ?? [])]
      .map(readSessionRecord)
      .filter((one): one is SessionRecord => one !== null)
      .filter((one) => here.includes(normalise(one.cwd, access.separator)))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    // A record whose process is gone is a record about a claude that used to be
    // in this directory, and believing it would report a finished agent as busy.
    const checkable = matched.length > 0 && (await canSeeProcesses(access));
    const live: SessionRecord[] = [];
    for (const record of matched)
      if (!checkable || (await pidExists(access, record.pid)))
        live.push(record);

    const record = live[0];
    if (record === undefined)
      return await fromTranscriptAlone(subject, access, root, readAt);

    const transcript = access.join(
      root,
      "projects",
      projectDirectoryName(record.cwd),
      `${record.sessionId}.jsonl`,
    );
    const tail = await access.read(transcript, {
      tailBytes: TRANSCRIPT_TAIL_BYTES,
    });
    const reading = tail === null ? {} : readTranscriptTail(tail);

    const activity = subject.running ? activityOf(record.status) : "ended";
    const facts: Record<string, string | number | boolean> = {
      source: "session record",
      claudeSession: record.sessionId,
      pid: record.pid,
      claudeStatus: record.status,
    };
    if (record.name !== undefined) facts.claudeName = record.name;
    if (record.version !== undefined) facts.version = record.version;
    if (reading.model !== undefined) facts.model = reading.model;
    if (reading.prompt !== undefined) facts.prompt = reading.prompt;
    if (reading.said !== undefined) facts.said = reading.said;
    if (activity === "waiting" && reading.did !== undefined)
      facts.pending = reading.did;
    if (live.length > 1) facts.otherClaudesHere = live.length - 1;
    if (!checkable) facts.livenessUnknown = true;
    if (tail === null) facts.transcript = "not readable";

    return {
      mapper: claudeMapper.id,
      activity,
      summary: summarise(activity, record, reading),
      // Both `waiting` and `idle` mean nothing moves until a person does
      // something. The words differ because one has a prompt on screen and the
      // other has finished its turn, which is worth seeing; the demand on a
      // person is the same.
      needsAttention: activity === "waiting" || activity === "idle",
      ...(reading.title === undefined ? {} : { working: reading.title }),
      observedAt: record.statusUpdatedAt ?? record.updatedAt,
      readAt,
      facts,
    };
  },
};

/**
 * What can be said when no session record matches.
 *
 * An older claude that writes no record, or one started with its state
 * elsewhere, still leaves a transcript. It says what the agent was on but
 * nothing about whether it is doing anything, so the activity is `unknown` and
 * stays that way. A transcript last touched before werk started this terminal
 * process belongs to some earlier claude in the same directory and is ignored,
 * which is the only thing keeping this from reporting yesterday's work as
 * today's.
 */
async function fromTranscriptAlone(
  subject: MapperSubject,
  access: ReadAccess,
  root: string,
  readAt: number,
): Promise<ProcessStatus | null> {
  const directory = access.join(
    root,
    "projects",
    projectDirectoryName(subject.cwd),
  );
  const names = await access.list(directory);
  if (names === null) return null;
  let newest: { file: string; modifiedAt: number } | null = null;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = access.join(directory, name);
    const facts = await access.facts(file);
    if (facts === null || facts.directory) continue;
    if (facts.modifiedAt < subject.startedAt) continue;
    if (newest === null || facts.modifiedAt > newest.modifiedAt)
      newest = { file, modifiedAt: facts.modifiedAt };
  }
  if (newest === null) return null;
  const tail = await access.read(newest.file, {
    tailBytes: TRANSCRIPT_TAIL_BYTES,
  });
  if (tail === null) return null;
  const reading = readTranscriptTail(tail);
  const facts: Record<string, string | number | boolean> = {
    source: "transcript",
  };
  if (reading.prompt !== undefined) facts.prompt = reading.prompt;
  if (reading.said !== undefined) facts.said = reading.said;
  if (reading.did !== undefined) facts.lastDid = reading.did;
  if (reading.model !== undefined) facts.model = reading.model;
  return {
    mapper: claudeMapper.id,
    activity: subject.running ? "unknown" : "ended",
    summary: summarise(subject.running ? "unknown" : "ended", null, reading),
    needsAttention: false,
    ...(reading.title === undefined ? {} : { working: reading.title }),
    observedAt: reading.at ?? newest.modifiedAt,
    readAt,
    facts,
  };
}
