/**
 * The machine a command acts on, and what a person is told while a workspace is
 * being made on it.
 *
 * No ssh anywhere. The `HostSession` is scripted, so the ssh half of
 * `host/place.ts` is exercised without a second computer and without opening a
 * connection to this one: real machines are `scripts/remote-smoke.ts`'s job.
 * The progress registers are driven by a fake `WorkspaceMaker` for the same
 * reason — what is being asserted is the rendering, and a real maker would drag
 * a repository in to prove nothing extra.
 */
import { expect, test } from "bun:test";
import { createStyles } from "../src/runtime/style.js";
import { defaultRoles } from "@werk/palette";
import type {
  CreateWorkspaceOptions,
  CreateWorkspaceRequest,
  Workspace,
  WorkspaceMaker,
  WorkspaceProgress,
} from "@werk/workspace";
import type { WerkContext } from "../src/runtime/context.js";
import { builtInHosts, type Host } from "../src/config/hosts.js";
import { reachHost, workspaceMakerFor } from "../src/host/place.js";
import type { HostSession } from "../src/host/session.js";
import type { ProbeAnswer } from "../src/host/probe.js";
import { createProgress, progressLine } from "../src/runtime/progress.js";

/** A context with no terminal, no colour and whatever hosts the test wants. */
function context(overrides: Partial<WerkContext> = {}): WerkContext {
  const written: string[] = [];
  return {
    write: (text) => void written.push(text),
    writeError: (text) => void written.push(text),
    stdoutTTY: false,
    stdinTTY: false,
    columns: 80,
    style: createStyles(0),
    theme: defaultRoles,
    colourLevel: 0,
    json: false,
    noInput: true,
    yes: false,
    runtimeDir: "/run/werk",
    stateDir: "/state/werk",
    entry: "/werk/main.ts",
    hosts: builtInHosts(),
    hostProblems: [],
    defaultHost: "local",
    setups: {},
    hostOrigin: {},
    ...overrides,
  };
}
/** A context that collects what was written to stderr, for the renderings. */
function recording(overrides: Partial<WerkContext> = {}) {
  const lines: string[] = [];
  return {
    lines,
    ctx: context({ writeError: (text) => void lines.push(text), ...overrides }),
  };
}

const beast: Host = { kind: "ssh", sshHost: "beast" };
const rooted: Host = {
  kind: "ssh",
  sshHost: "beast",
  workspaceRoot: "/srv/werk/workspaces",
};

/**
 * A `HostSession` that answers commands from a script and connects to nothing.
 * `ready` and `endpoint` throw, because reaching a daemon is not what any of
 * these tests are about and a call to either would be a bug in the code under
 * test rather than in the fake.
 */
function fakeSession(
  answer: (command: readonly string[]) => Partial<ProbeAnswer>,
): HostSession & { ran: string[][]; closed: number } {
  const ran: string[][] = [];
  const session = {
    name: "beast",
    sshHost: "beast",
    ran,
    closed: 0,
    async run(command: readonly string[]): Promise<ProbeAnswer> {
      ran.push([...command]);
      return {
        ok: true,
        code: 0,
        stdout: "",
        stderr: "",
        ...answer(command),
      };
    },
    ready(): never {
      throw new Error("nothing here should reach a daemon");
    },
    endpoint(): never {
      throw new Error("nothing here should open a forward");
    },
    async close() {
      session.closed += 1;
    },
  };
  return session;
}

test("a local host is a worktree here, under the state directory", async () => {
  const place = await reachHost(context({ stateDir: "/state/werk" }));
  expect(place.name).toBe("local");
  expect(place.session).toBeUndefined();
  // Absent, so a reference for a workspace on this machine keeps reading as it
  // always has.
  expect(place.reference).toBeUndefined();
  expect(workspaceMakerFor(place).kind).toBe("local-worktree");
});

test("a local host block with a workspaceRoot of its own is honoured", async () => {
  const place = await reachHost(
    context({ hosts: { local: { kind: "local", workspaceRoot: "/w" } } }),
  );
  expect(place.root).toBe("/w");
});

test("an ssh host with a configured root asks the machine nothing", async () => {
  const session = fakeSession(() => ({}));
  const place = await reachHost(
    context({
      hosts: { ...builtInHosts(), beast: rooted },
      requestedHost: "beast",
    }),
    { open: () => session },
  );
  expect(place.root).toBe("/srv/werk/workspaces");
  expect(place.reference).toBe("beast");
  expect(session.ran).toEqual([]);
  expect(workspaceMakerFor(place).kind).toBe("ssh-worktree");
});

test("an ssh host that said nothing about a root is asked, not guessed at", async () => {
  const session = fakeSession(() => ({ stdout: "/home/mike/.state/werk/w\n" }));
  const place = await reachHost(
    context({
      hosts: { ...builtInHosts(), beast },
      requestedHost: "beast",
      // The client's own state directory says nothing about a path on another
      // machine, so it must not appear in the answer.
      stateDir: "/state/werk",
    }),
    { open: () => session },
  );
  expect(place.root).toBe("/home/mike/.state/werk/w");
  expect(place.root).not.toContain("/state/werk/workspaces");
  // The same rule the probe applies, spelled for that machine's own shell.
  expect(session.ran[0]?.[2]).toContain("XDG_STATE_HOME");
});

test("a machine that will not say where workspaces go fails, and lets go", async () => {
  const session = fakeSession(() => ({ ok: false, code: 1 }));
  await expect(
    reachHost(
      context({
        hosts: { ...builtInHosts(), beast },
        requestedHost: "beast",
      }),
      { open: () => session },
    ),
  ).rejects.toThrow(/workspaceRoot/);
  // A failure on the way in must not leave an ssh holding a forward open.
  expect(session.closed).toBe(1);
});

/* ------------------------------------------------------------- progress */

/** A maker that reports a scripted run of stages and makes nothing. */
function scriptedMaker(events: readonly WorkspaceProgress[]): WorkspaceMaker {
  return {
    kind: "scripted",
    async create(
      request: CreateWorkspaceRequest,
      options?: CreateWorkspaceOptions,
    ): Promise<Workspace> {
      for (const event of events) options?.onProgress?.(event);
      return {
        name: request.name,
        directory: `/srv/${request.name}`,
        branch: request.name,
        from: request.from,
        host: "beast",
      };
    },
  };
}
const run: readonly WorkspaceProgress[] = [
  { step: "resolve-source", state: "begin" },
  { step: "resolve-source", state: "end", detail: "/home/mike/werk" },
  { step: "prepare-repository", state: "begin", detail: "beast:/srv/x.git" },
  { step: "prepare-repository", state: "end" },
  {
    step: "transfer",
    state: "begin",
    detail: "uncommitted changes in 3 files stay on this machine",
  },
  { step: "transfer", state: "end" },
  { step: "check-out", state: "begin" },
  { step: "check-out", state: "end", detail: "/srv/x/fix-login" },
];

async function render(ctx: WerkContext) {
  const progress = createProgress(ctx, "beast");
  await scriptedMaker(run).create(
    { name: "fix-login", from: { kind: "local-checkout", path: "/here" } },
    { onProgress: progress.onProgress },
  );
  progress.stop();
}

test("--json says nothing at all: one value on stdout is the whole contract", async () => {
  const { lines, ctx } = recording({ json: true });
  await render(ctx);
  expect(lines).toEqual([]);
});

test("--no-input says one line per stage begun, on stderr", async () => {
  const { lines, ctx } = recording({ noInput: true });
  await render(ctx);
  expect(lines).toEqual([
    "reading the repository\n",
    "preparing the repository on beast (beast:/srv/x.git)\n",
    "sending the history to beast (uncommitted changes in 3 files stay on this machine)\n",
    "checking out the workspace on beast\n",
  ]);
});

test("a terminal gets a spinner on stderr, and the cursor back at the end", async () => {
  const { ctx } = recording({
    noInput: false,
    stdoutTTY: true,
    stdinTTY: true,
  });
  // clack paints on the real stderr and animates on a timer, so what a
  // synchronous run can assert is which stream it used and that it tidied up
  // after itself. The words themselves are `progressLine`'s to answer for.
  const painted: string[] = [];
  const stdout: string[] = [];
  const stderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    painted.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await render(ctx);
  } finally {
    process.stderr.write = stderrWrite;
    process.stdout.write = stdoutWrite;
  }
  const said = painted.join("");
  // Started, so something was drawn, and stopped, so the terminal is usable by
  // whatever prints next — an attachment's alternate screen included.
  expect(said).toContain("\u001b[?25l");
  expect(said.endsWith("\u001b[?25h")).toBe(true);
  // Never on stdout, whatever else it did.
  expect(stdout).toEqual([]);
});

test("only a stage that has begun is worth a line, and the maker's own words survive", () => {
  expect(progressLine({ step: "reach-host", state: "begin" }, "beast")).toBe(
    "reaching beast",
  );
  // An end is the same stage said twice; nothing renders one.
  expect(
    progressLine({ step: "reach-host", state: "end" }, "beast"),
  ).toBeUndefined();
  expect(
    progressLine(
      { step: "transfer", state: "begin", detail: "sending 84 MiB" },
      "beast",
    ),
  ).toBe("sending the history to beast (sending 84 MiB)");
});
