/**
 * What the claude mapper makes of what claude leaves behind.
 *
 * The fixtures are the shapes a real claude writes, cut down to the fields the
 * mapper reads. The cases that matter are the ones where werk would otherwise
 * report something false: a record belonging to a claude in another directory, a
 * record left behind by a process that has gone, and a transcript from a run
 * that finished before this terminal process started.
 */
import { expect, test } from "bun:test";
import {
  claudeMapper,
  projectDirectoryName,
  readSessionRecord,
  readTranscriptTail,
} from "../src/claude.js";
import { statusOf } from "../src/registry.js";
import type { MapperSubject } from "../src/types.js";
import { memoryReadAccess } from "./support/memory.js";

const HOME = "/home/somebody";
const CWD = "/state/werk/workspaces/repo-a3f2b1c9/fix-login";
const SESSION = "11111111-2222-3333-4444-555555555555";

const subject = (over: Partial<MapperSubject> = {}): MapperSubject => ({
  id: "s1",
  argv: ["/home/somebody/.local/bin/claude"],
  cwd: CWD,
  running: true,
  startedAt: 1_000,
  ...over,
});

const record = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    pid: 4242,
    sessionId: SESSION,
    cwd: CWD,
    status: "busy",
    updatedAt: 5_000,
    statusUpdatedAt: 5_000,
    name: "fix-login-a1",
    version: "2.1.266",
    ...over,
  });

/** A transcript of three lines: a title, a prompt, and one assistant turn. */
const transcript = (...turns: Record<string, unknown>[]): string =>
  [
    { type: "ai-title", aiTitle: "Fixing the login redirect" },
    { type: "last-prompt", lastPrompt: "the login page loops" },
    ...turns,
  ]
    .map((one) => JSON.stringify(one))
    .join("\n");

const assistant = (
  content: Record<string, unknown>[],
  timestamp = "2026-09-09T02:10:00.000Z",
) => ({
  type: "assistant",
  timestamp,
  message: { model: "claude-opus-5", content },
});

const transcriptPath = (cwd = CWD, session = SESSION) =>
  `${HOME}/.claude/projects/${projectDirectoryName(cwd)}/${session}.jsonl`;

test("a directory becomes the name claude keeps its transcripts under", () => {
  expect(projectDirectoryName("/home/mike/.local/state")).toBe(
    "-home-mike--local-state",
  );
  expect(projectDirectoryName("/a/b-c/d.e")).toBe("-a-b-c-d-e");
});

test("a record missing anything the mapper needs is not a record", () => {
  expect(readSessionRecord("not json")).toBeNull();
  expect(readSessionRecord("[]")).toBeNull();
  expect(readSessionRecord(JSON.stringify({ pid: 1 }))).toBeNull();
  const read = readSessionRecord(record({ waitingFor: "input needed" }));
  expect(read?.pid).toBe(4242);
  expect(read?.waitingFor).toBe("input needed");
});

test("a tail drops its first line and skips anything unreadable", () => {
  const whole = transcript(assistant([{ type: "text", text: "done" }]));
  const reading = readTranscriptTail(`half a line\n${whole}\n{ partial`);
  expect(reading.title).toBe("Fixing the login redirect");
  expect(reading.prompt).toBe("the login page loops");
  expect(reading.did).toBe("replying");
  expect(reading.said).toBe("done");
  expect(reading.model).toBe("claude-opus-5");
});

test("a turn that thought and then called a tool is a tool call", () => {
  const reading = readTranscriptTail(
    `x\n${transcript(
      assistant([
        { type: "thinking", thinking: "hmm" },
        { type: "tool_use", name: "Bash", input: { description: "run tests" } },
      ]),
    )}`,
  );
  expect(reading.did).toBe("Bash");
  expect(reading.detail).toBe("run tests");
});

test("claims claude however werk came to be running it", () => {
  expect(claudeMapper.claims(subject())).toBe(true);
  expect(
    claudeMapper.claims(subject({ argv: ["/bin/bash"], foreground: "claude" })),
  ).toBe(true);
  expect(claudeMapper.claims(subject({ argv: ["/bin/bash"] }))).toBe(false);
});

test("a busy claude is working, and says what on", async () => {
  const access = memoryReadAccess({
    home: HOME,
    files: {
      [`${HOME}/.claude/sessions/4242.json`]: record(),
      [transcriptPath()]: `x\n${transcript(
        assistant([
          { type: "tool_use", name: "Edit", input: { description: "fix it" } },
        ]),
      )}`,
    },
  });
  const status = await statusOf(subject(), access);
  expect(status?.activity).toBe("working");
  expect(status?.summary).toBe("running Edit: fix it");
  expect(status?.working).toBe("Fixing the login redirect");
  expect(status?.needsAttention).toBe(false);
  expect(status?.observedAt).toBe(5_000);
});

test("a waiting claude wants a person, and says what it is waiting on", async () => {
  const access = memoryReadAccess({
    home: HOME,
    files: {
      [`${HOME}/.claude/sessions/4242.json`]: record({
        status: "waiting",
        waitingFor: "input needed",
      }),
      [transcriptPath()]: `x\n${transcript(
        assistant([{ type: "tool_use", name: "Bash", input: {} }]),
      )}`,
    },
  });
  const status = await statusOf(subject(), access);
  expect(status?.activity).toBe("waiting");
  expect(status?.summary).toBe("input needed");
  expect(status?.needsAttention).toBe(true);
  // The tool the turn ended on is the thing the prompt on screen is about.
  expect(status?.facts?.pending).toBe("Bash");
});

test("an idle claude wants a person too; it has simply not been asked", async () => {
  const access = memoryReadAccess({
    home: HOME,
    files: {
      [`${HOME}/.claude/sessions/4242.json`]: record({ status: "idle" }),
      [transcriptPath()]: `x\n${transcript(
        assistant([{ type: "text", text: "That is done." }]),
      )}`,
    },
  });
  const status = await statusOf(subject(), access);
  expect(status?.activity).toBe("idle");
  expect(status?.needsAttention).toBe(true);
  expect(status?.summary).toBe("idle after replying");
  expect(status?.facts?.said).toBe("That is done.");
});

test("a record for another directory is not this session's", async () => {
  const access = memoryReadAccess({
    home: HOME,
    files: {
      [`${HOME}/.claude/sessions/4242.json`]: record({
        cwd: "/somewhere/else",
      }),
    },
  });
  expect(await statusOf(subject(), access)).toBeNull();
});

test("a record whose process is gone is not believed", async () => {
  const files: Record<string, string> = {
    [`${HOME}/.claude/sessions/4242.json`]: record(),
    [transcriptPath()]: `x\n${transcript(
      assistant([{ type: "text", text: "done" }]),
    )}`,
    // A `/proc` the mapper can look pids up in, without 4242 in it.
    "/proc/self/status": "Name:\tbun\n",
    "/proc/1/status": "Name:\tinit\n",
  };
  const status = await statusOf(
    subject(),
    memoryReadAccess({
      home: HOME,
      files,
      modifiedAt: { [transcriptPath()]: 9_000 },
    }),
  );
  // Nothing live matched, so the only thing left is the transcript, and it
  // cannot say whether anything is happening.
  expect(status?.activity).toBe("unknown");
  expect(status?.facts?.source).toBe("transcript");
});

test("with no /proc to look in, the record is taken at its word", async () => {
  const access = memoryReadAccess({
    home: HOME,
    files: {
      [`${HOME}/.claude/sessions/4242.json`]: record(),
      [transcriptPath()]: `x\n${transcript(
        assistant([{ type: "text", text: "done" }]),
      )}`,
    },
  });
  const status = await statusOf(subject(), access);
  expect(status?.activity).toBe("working");
  expect(status?.facts?.livenessUnknown).toBe(true);
});

test("a session werk knows has ended is ended, whatever the record says", async () => {
  const access = memoryReadAccess({
    home: HOME,
    files: {
      [`${HOME}/.claude/sessions/4242.json`]: record(),
      [transcriptPath()]: `x\n${transcript(
        assistant([{ type: "text", text: "All done." }]),
      )}`,
    },
  });
  const status = await statusOf(subject({ running: false }), access);
  expect(status?.activity).toBe("ended");
  expect(status?.summary).toBe("ended after replying");
  expect(status?.working).toBe("Fixing the login redirect");
});

test("a transcript from before this session started is somebody else's", async () => {
  const access = memoryReadAccess({
    home: HOME,
    files: {
      [transcriptPath()]: `x\n${transcript(
        assistant([{ type: "text", text: "yesterday" }]),
      )}`,
    },
    modifiedAt: { [transcriptPath()]: 500 },
  });
  expect(await statusOf(subject({ startedAt: 1_000 }), access)).toBeNull();
});

test("a transcript written since this session started is read for what it can say", async () => {
  const access = memoryReadAccess({
    home: HOME,
    files: {
      [transcriptPath()]: `x\n${transcript(
        assistant([{ type: "tool_use", name: "Bash", input: {} }]),
      )}`,
    },
    modifiedAt: { [transcriptPath()]: 9_000 },
  });
  const status = await statusOf(subject({ startedAt: 1_000 }), access);
  expect(status?.activity).toBe("unknown");
  expect(status?.needsAttention).toBe(false);
  expect(status?.working).toBe("Fixing the login redirect");
  expect(status?.facts?.lastDid).toBe("Bash");
});

test("a program no mapper knows gets no reading at all", async () => {
  const access = memoryReadAccess({ home: HOME, files: {} });
  expect(await statusOf(subject({ argv: ["/bin/bash"] }), access)).toBeNull();
});
