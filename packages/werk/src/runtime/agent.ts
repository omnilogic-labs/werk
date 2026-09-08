/**
 * Asking an agent something, one shot.
 *
 * [Landing](../../../../docs/product/landing.md) has two jobs for an agent:
 * writing the commit message, and resolving a conflict when the change does not
 * apply cleanly. Both are the same shape — hand it a prompt, let it work in a
 * directory, read what it says — so both go through here.
 *
 * The prompt goes on stdin rather than in the argv. An argument list has a
 * length limit that a diff reaches easily, and a prompt containing a shell
 * metacharacter is a hazard the moment anybody puts a shell in the middle.
 * Nothing here does: the command is spawned directly, with its words split on
 * whitespace and no shell to reinterpret them.
 *
 * Where the agent runs is
 * [question 4](../../../../docs/open-questions.md#4-where-does-the-landing-agent-run).
 * It runs on the client today because that is where landing is coordinated and
 * where the copy of the parent is, and that is what is being tried rather than
 * an answer.
 */
import { spawn } from "node:child_process";

/**
 * The one-shot spelling of the agents werk knows by name.
 *
 * A person writes `agent = "claude"` and means the thing they type at a
 * terminal; `-p` is what makes that one-shot rather than a session. Anything
 * not in here is run as it was written, so an agent werk has never heard of
 * works without this table growing.
 */
const KNOWN: Readonly<Record<string, readonly string[]>> = {
  claude: ["claude", "-p"],
};

/**
 * The command a configured agent means, or undefined for "ask nobody".
 *
 * Splitting on whitespace is the whole of the parsing. It has no quoting, so an
 * agent whose arguments contain spaces cannot be spelled here; that is a real
 * limit and a smaller one than putting a shell in the path of every prompt werk
 * sends.
 */
export function agentCommand(agent: string): readonly string[] | undefined {
  const trimmed = agent.trim();
  if (trimmed === "") return undefined;
  const known = KNOWN[trimmed];
  if (known !== undefined) return known;
  const words = trimmed.split(/\s+/);
  return words.length === 0 ? undefined : words;
}

/** The agents werk has a one-shot spelling for, for a prompt offering them. */
export const KNOWN_AGENTS = Object.keys(KNOWN) as readonly string[];

/** Long enough for an agent to read a diff and think; short enough not to hang a landing. */
export const AGENT_TIMEOUT_MS = 300_000;

export interface AgentRun {
  readonly command: readonly string[];
  readonly prompt: string;
  /** Where it runs. The copy of the parent, for both of landing's jobs. */
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface AgentAnswer {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** Why it did not work, in a sentence, when it did not. */
  readonly problem?: string;
}

/**
 * Run the agent and read what it said.
 *
 * It never throws. An agent that is not installed, that exits non-zero or that
 * takes too long is a fact the caller reports and works around — landing
 * without an agent writes its own commit message and reports its own conflicts
 * — and a thrown error at this point would turn a degraded landing into a
 * failed one.
 */
export function askAgent(run: AgentRun): Promise<AgentAnswer> {
  const [program, ...args] = run.command;
  if (program === undefined)
    return Promise.resolve({
      ok: false,
      stdout: "",
      stderr: "",
      problem: "no agent to run",
    });
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd: run.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      ...(run.signal ? { signal: run.signal } : {}),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (answer: AgentAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({
        ok: false,
        stdout,
        stderr,
        problem: `${program} did not answer within ${Math.round((run.timeoutMs ?? AGENT_TIMEOUT_MS) / 1000)}s`,
      });
    }, run.timeoutMs ?? AGENT_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) =>
      done({
        ok: false,
        stdout,
        stderr,
        problem:
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? `${program} is not installed, or is not on PATH`
            : error.message,
      }),
    );
    child.on("close", (code) =>
      done(
        code === 0
          ? { ok: true, stdout, stderr }
          : {
              ok: false,
              stdout,
              stderr,
              problem: `${program} exited ${code ?? "on a signal"}`,
            },
      ),
    );
    child.stdin.on("error", () => {
      // A program that never reads its stdin closes the pipe under us. That is
      // its business, not a failure of the run.
    });
    child.stdin.end(run.prompt);
  });
}
