/**
 * The two pure halves of asking an agent: what a configured name means, and
 * what comes back out of an editor.
 *
 * Both are pure functions with an effectful sibling, and both are the sort of
 * thing that is easy to get subtly wrong and hard to notice: a name that
 * expands to the wrong flags asks an agent for a session instead of one answer,
 * and a cleanup that keeps a comment line puts werk's own instructions into a
 * commit message.
 */
import { expect, test } from "bun:test";
import { agentCommand, askAgent, KNOWN_AGENTS } from "../src/runtime/agent.js";
import { cleanMessage } from "../src/runtime/editor.js";

test("a bare known name expands to its one-shot spelling", () => {
  expect(agentCommand("claude")).toEqual(["claude", "-p"]);
  expect(agentCommand("  claude  ")).toEqual(["claude", "-p"]);
});

test("every name werk offers is a name it can expand", () => {
  for (const name of KNOWN_AGENTS) expect(agentCommand(name)).toBeDefined();
});

test("anything else is run as it was written", () => {
  expect(agentCommand("codex exec")).toEqual(["codex", "exec"]);
  expect(agentCommand("/opt/bin/my-agent --one-shot")).toEqual([
    "/opt/bin/my-agent",
    "--one-shot",
  ]);
  // Not a known name, so no flags are added to it: a person who writes their
  // own command line gets exactly that command line.
  expect(agentCommand("claude-ish")).toEqual(["claude-ish"]);
});

test("empty means ask nobody", () => {
  expect(agentCommand("")).toBeUndefined();
  expect(agentCommand("   ")).toBeUndefined();
});

test("an agent that is not installed answers with a sentence, not a throw", async () => {
  const answer = await askAgent({
    command: ["definitely-not-installed-anywhere"],
    prompt: "hello",
    cwd: process.cwd(),
  });
  expect(answer.ok).toBe(false);
  expect(answer.problem).toContain("not installed");
});

test("the prompt goes in on stdin and the answer comes back on stdout", async () => {
  const answer = await askAgent({
    command: ["cat"],
    prompt: "a prompt long enough to be a diff",
    cwd: process.cwd(),
  });
  expect(answer.ok).toBe(true);
  expect(answer.stdout).toBe("a prompt long enough to be a diff");
});

test("an agent that exits badly is not ok, and says so", async () => {
  const answer = await askAgent({
    command: ["sh", "-c", "cat > /dev/null; exit 4"],
    prompt: "hello",
    cwd: process.cwd(),
  });
  expect(answer.ok).toBe(false);
  expect(answer.problem).toContain("4");
});

test("an agent that never reads its prompt is still an answer", async () => {
  const answer = await askAgent({
    command: ["sh", "-c", "echo answered"],
    prompt: "x".repeat(200_000),
    cwd: process.cwd(),
  });
  expect(answer.ok).toBe(true);
  expect(answer.stdout.trim()).toBe("answered");
});

test("an agent that takes too long is killed and reported", async () => {
  const answer = await askAgent({
    command: ["sh", "-c", "sleep 30"],
    prompt: "hello",
    cwd: process.cwd(),
    timeoutMs: 200,
  });
  expect(answer.ok).toBe(false);
  expect(answer.problem).toContain("did not answer");
});

test("comment lines are dropped, the way git drops them", () => {
  expect(
    cleanMessage("a subject\n\nsome body\n# an instruction werk wrote\n"),
  ).toBe("a subject\n\nsome body");
});

test("a message that is only comments is an abandoned one", () => {
  expect(cleanMessage("# all of it\n# every line\n")).toBe("");
  expect(cleanMessage("\n\n  \n")).toBe("");
});

test("blank runs collapse and the ends are trimmed", () => {
  expect(cleanMessage("\n\nsubject\n\n\n\nbody   \n\n\n")).toBe(
    "subject\n\nbody",
  );
});

test("a # that is not at the start of a line survives", () => {
  expect(cleanMessage("fix issue #12\n")).toBe("fix issue #12");
});
