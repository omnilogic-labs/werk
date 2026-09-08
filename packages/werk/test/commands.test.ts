import { expect, test } from "bun:test";
import path from "node:path";
import { createStyles } from "../src/runtime/style.js";
import type { SessionInfo, TerminationResult } from "@werk/session";
import {
  formatWorkspaceReference,
  isWorkspaceName,
  workspaceReference,
} from "@werk/workspace";
import { sizeValid } from "@werk/session-daemon";
import type { WerkContext } from "../src/runtime/context.js";
import { setChildArgv } from "../src/commands/shared.js";
import {
  buildCreate,
  renderCreated,
  workspaceRecord,
  wholeNumber,
  windowSize,
  workspaceNameFor,
} from "../src/commands/create.js";
import { reachHost, workspaceMakerFor } from "../src/host/place.js";
import { builtInHosts } from "../src/config/hosts.js";
import {
  buildAttach,
  outcomeNote,
  remoteDropNote,
  sizeIntent,
} from "../src/commands/attach.js";
import { buildKill, renderTermination } from "../src/commands/kill.js";
import { renderInspection, type Inspection } from "../src/commands/inspect.js";
import { describeEndpoint, renderEndpoint } from "../src/commands/daemon.js";
import { aliasesOf, resolveSession } from "../src/commands/session-argument.js";
import { listResult, sourcesResult } from "../src/commands/config.js";
import { builtInDefaults, CONFIG_KEYS } from "../src/config/schema.js";
import type { MergedConfig } from "../src/config/load.js";

/** A context with no terminal and no colour, so a rendering is plain text. */
function context(overrides: Partial<WerkContext> = {}): WerkContext {
  const written: string[] = [];
  return {
    write: (text) => void written.push(text),
    writeError: (text) => void written.push(text),
    stdoutTTY: false,
    stdinTTY: false,
    columns: 80,
    style: createStyles(0),
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
    ...overrides,
  };
}
const session = (over: Partial<SessionInfo> = {}): SessionInfo =>
  ({
    id: "8f2c1b04e9d1",
    daemonId: "d1",
    state: "running",
    argv: ["/bin/sh"],
    cwd: "/home/mike",
    size: { cols: 80, rows: 24 },
    scrollbackBytes: 1000,
    createdAt: 0,
    name: "demo",
    labels: {},
    attachments: [],
    processTree: { children: 0 },
    ...over,
  }) as SessionInfo;

test("an exit status is reported with the reason the daemon gave", () => {
  expect(outcomeNote("s1", { code: 3 })).toBe(
    "session s1 has ended with status 3",
  );
  expect(outcomeNote("s1", { code: null, signal: "SIGKILL" })).toBe(
    "session s1 has ended with signal SIGKILL",
  );
  expect(outcomeNote("s1", { code: null })).toBe(
    "session s1 has ended with an unknown status",
  );
  expect(outcomeNote("s1", { code: 0, reason: "removed" })).toBe(
    "session s1 has ended with status 0 (removed)",
  );
});
test("a lost record says the daemon never saw the process finish", () => {
  expect(outcomeNote("s1", undefined, "lost")).toBe(
    "session s1 was lost: the daemon stopped watching the process before it finished",
  );
  expect(outcomeNote("s1", undefined, "exited")).toBe(
    "session s1 has ended with no recorded outcome",
  );
  expect(outcomeNote("s1", undefined)).toBe(
    "session s1 has ended with no recorded outcome",
  );
});
test("only a writable attachment that was not told otherwise takes the size", () => {
  expect(sizeIntent({})).toBe("if-free");
  expect(sizeIntent({ readOnly: true })).toBe("never");
  expect(sizeIntent({ follow: true })).toBe("never");
  expect(sizeIntent({ claimSize: true })).toBe("claim");
  // Reading and claiming contradict each other less than following and
  // claiming do: the claim wins and the daemon refuses it without input.
  expect(sizeIntent({ readOnly: true, claimSize: true })).toBe("claim");
});
test("a count is rejected here so the message names the flag", () => {
  const cols = wholeNumber("--cols");
  expect(cols("40")).toBe(40);
  expect(cols("0")).toBe(0);
  expect(() => cols("-1")).toThrow("--cols must be a whole number");
  expect(() => cols("1.5")).toThrow("--cols must be a whole number");
  expect(() => cols("lots")).toThrow("--cols must be a whole number");
  expect(() => wholeNumber("--scrollback", " of bytes")("x")).toThrow(
    "--scrollback must be a whole number of bytes",
  );
});
test("the window is what was asked for, or what the terminal reports", () => {
  expect(windowSize({ cols: 40, rows: 8 })).toEqual({ cols: 40, rows: 8 });
  expect(windowSize({}, { columns: 120, rows: 40 })).toEqual({
    cols: 120,
    rows: 40,
  });
  // A flag beats the terminal, one axis at a time.
  expect(windowSize({ cols: 40 }, { columns: 120, rows: 40 })).toEqual({
    cols: 40,
    rows: 40,
  });
});
test("a terminal that cannot say how big it is gets 80x24, not zero", () => {
  // `process.stdout.columns` is `0` rather than undefined on a pty whose size
  // was never set: under `script`, in containers, on an ssh session that lost
  // its window size. `0` passes straight through `??`, which is the defect.
  expect(windowSize({}, { columns: 0, rows: 0 })).toEqual({
    cols: 80,
    rows: 24,
  });
  // A pipe reports neither.
  expect(windowSize({}, {})).toEqual({ cols: 80, rows: 24 });
  // One axis can be reported while the other is not.
  expect(windowSize({}, { columns: 0, rows: 40 })).toEqual({
    cols: 80,
    rows: 40,
  });
  expect(windowSize({}, { columns: 120, rows: 0 })).toEqual({
    cols: 120,
    rows: 24,
  });
});
test("the grid a zero-sized terminal produces is one the daemon accepts", () => {
  // Asserted against the daemon's own rule rather than a restatement of it, so
  // the client and the daemon cannot drift into disagreeing about what a valid
  // grid is. Before the guard this threw: `sizeValid` refuses anything under 1.
  expect(() =>
    sizeValid(windowSize({}, { columns: 0, rows: 0 })),
  ).not.toThrow();
  expect(() => sizeValid(windowSize({}, {}))).not.toThrow();
  expect(() => sizeValid({ cols: 0, rows: 0 })).toThrow();
});
const workspace = (name = "fix-login") => ({
  name,
  directory: `/state/werk/workspaces/werk-1a2b3c4d/${name}`,
  branch: name,
  from: { kind: "local-checkout" as const, path: "/home/mike/werk" },
});
test("a detached session tells you how to go back to it", () => {
  const text = renderCreated(
    session({ argv: ["claude", "-p"], size: { cols: 40, rows: 8 } }),
    context(),
    workspace(),
    true,
  );
  expect(text).toContain("created 8f2c1b04e9d1 demo");
  expect(text).toContain("claude -p · 40x8");
  expect(text).toContain("werk attach 8f2c1b04e9d1");
});
test("an attached session is not told how to get to where it already is", () => {
  const text = renderCreated(session(), context(), workspace(), false);
  expect(text).toContain("created 8f2c1b04e9d1 demo");
  expect(text).not.toContain("werk attach ");
  expect(text.split("\n")).toHaveLength(3);
});
test("a workspace on another machine reads as name@host:/path in both registers", () => {
  const away = {
    ...workspace(),
    directory: "/srv/w/x/fix-login",
    host: "beast",
  };
  // The record a script reads.
  expect(workspaceRecord(away)).toEqual({
    name: "fix-login",
    directory: "/srv/w/x/fix-login",
    branch: "fix-login",
    host: "beast",
    reference: "fix-login@beast:/srv/w/x/fix-login",
  });
  // And the line a person reads, which has been formatting at `full` all along
  // and only now has a host to show.
  expect(renderCreated(session(), context(), away, false)).toContain(
    "workspace fix-login@beast:/srv/w/x/fix-login on branch fix-login",
  );
  // And the way back names the machine, because a bare `werk attach` would
  // look at this machine's daemon and find nothing.
  expect(renderCreated(session(), context(), away, true)).toContain(
    "werk attach --host beast 8f2c1b04e9d1",
  );
  // A workspace here carries no host at all, in any of the three.
  expect(workspaceRecord(workspace())).not.toHaveProperty("host");
  expect(workspaceRecord(workspace()).reference).not.toContain("@");
  expect(renderCreated(session(), context(), workspace(), true)).toContain(
    "werk attach 8f2c1b04e9d1",
  );
});
test("a remote connection that drops says which machine, and that the work is still there", () => {
  // "connection closed" is what a person would otherwise read, and it sends
  // them to look at the wrong machine: the commonest remote fault is a forward
  // that came up and then ended the stream at once.
  const note = remoteDropNote("agent-sandboxes", "8f2c1b04e9d1");
  expect(note).toContain("lost the connection to agent-sandboxes");
  expect(note).toContain("still running there");
  // The way back names the machine, so it is a command that works rather than
  // one that looks at this machine's daemon and finds nothing.
  expect(note).toContain("werk attach --host agent-sandboxes 8f2c1b04e9d1");
});
test("termination reports delivery and outcome as the separate facts they are", () => {
  const ctx = context();
  expect(
    renderTermination("s1", { delivered: true, intent: "force" }, ctx),
  ).toBe("force sent to s1");
  expect(
    renderTermination("s1", { delivered: false, intent: "terminate" }, ctx),
  ).toBe("terminate was not delivered to s1");
  const ended: TerminationResult = {
    delivered: true,
    intent: "interrupt",
    exit: { code: 130 },
  };
  expect(renderTermination("s1", ended, ctx).split("\n")).toEqual([
    "interrupt sent to s1",
    "session s1 has ended with status 130",
  ]);
});
const inspection = (over: Partial<Inspection> = {}): Inspection => ({
  version: "0.1.0",
  paths: { runtimeDir: "/run/werk", log: "/state/werk/daemon.log" },
  lockMechanism: "flock",
  recorded: { pid: 42, bootId: "boot-1" },
  daemon: null,
  ...over,
});
test("info names the paths, the lock and the recorded daemon", () => {
  const text = renderInspection(inspection(), context());
  // The report's own version, not the CLI's — `werk --version` answers that one.
  expect(text).toContain("report 0.1.0");
  expect(text).toContain("lock      flock");
  expect(text).toContain("pid 42 · boot boot-1");
  expect(text).toContain("/state/werk/daemon.log");
});
test("a daemon that did not answer is reported as why, not as absence", () => {
  const text = renderInspection(
    inspection({ connection: "Error: ENOENT endpoint.json" }),
    context(),
  );
  expect(text).toContain("connection");
  expect(text).toContain("ENOENT endpoint.json");
});
test("a daemon that answered is described by what it can do", () => {
  const text = renderInspection(
    inspection({
      daemon: {
        id: "d1",
        version: "0.1.0",
        protocolVersion: 2,
        engine: { buildId: "ghostty-abc", snapshotFormatVersion: 1 },
        capabilities: {
          termination: ["interrupt", "terminate", "force"],
          snapshots: true,
          scrollbackMaxBytes: 10000000,
        },
      },
    }),
    context(),
  );
  expect(text).toContain("interrupt, terminate, force");
  expect(text).toContain("10000000 bytes at most");
  expect(text).toContain("snapshot format 1");
});
test("doctor adds the checks and the log tail", () => {
  const text = renderInspection(
    inspection({
      checks: { lock: "not-held", state: { writable: true, freeBytes: 10 } },
      log: { tail: ["one", "two"], lastError: "boom" },
    }),
    context(),
  );
  expect(text).toContain("lock");
  expect(text).toContain("not-held");
  expect(text).toContain('{"writable":true,"freeBytes":10}');
  expect(text).toContain("last error");
  expect(text).toContain("boom");
  expect(text).toContain("  two");
});
test("an empty log says so rather than showing nothing", () => {
  expect(
    renderInspection(
      inspection({ checks: {}, log: { tail: [], lastError: null } }),
      context(),
    ),
  ).toContain("the log is empty");
});
test("an endpoint is named in the form somebody would dial it", () => {
  expect(
    describeEndpoint({ kind: "unix", path: "/run/werk/daemon.sock" }),
  ).toBe("unix /run/werk/daemon.sock");
  expect(
    describeEndpoint({
      kind: "tcp",
      host: "127.0.0.1",
      port: 49731,
      credential: "s3cret",
    }),
  ).toBe("tcp 127.0.0.1:49731");
});
test("the endpoint block keeps a TCP credential out of the terminal", () => {
  const text = renderEndpoint(
    {
      endpoint: {
        kind: "tcp",
        host: "127.0.0.1",
        port: 49731,
        credential: "s3cret",
      },
      runtimeDir: "/run/werk",
      stateDir: "/state/werk",
      pid: 42,
      version: "0.0.0-a1b2c3d",
      build: "0.0.0-a1b2c3d",
    },
    context(),
  );
  expect(text).toContain("tcp 127.0.0.1:49731");
  expect(text).toContain("pid       42");
  expect(text).toContain("0.0.0-a1b2c3d");
  expect(text).not.toContain("s3cret");
});
test("a daemon with no record on disk says so rather than showing a pid", () => {
  const text = renderEndpoint(
    {
      endpoint: { kind: "unix", path: "/run/werk/daemon.sock" },
      runtimeDir: "/run/werk",
      stateDir: "/state/werk",
      pid: null,
      version: "0.0.0-a1b2c3d",
      build: "0.0.0-source",
    },
    context(),
  );
  expect(text).toContain("not recorded");
  // Two identities, which is the case the two rows exist to make visible.
  expect(text).toContain("0.0.0-a1b2c3d");
  expect(text).toContain("0.0.0-source");
});
test("create refuses to start nothing, and says what it needs", async () => {
  setChildArgv([]);
  await expect(
    buildCreate().parseAsync(["--name", "demo"], { from: "user" }),
  ).rejects.toThrow("command to run");
});
test("following and claiming the size are refused together, before connecting", async () => {
  await expect(
    buildAttach().parseAsync(["s1", "--follow", "--claim-size"], {
      from: "user",
    }),
  ).rejects.toThrow(/--follow.*--claim-size/);
});
test("kill offers exactly the intents the protocol has", () => {
  const intent = buildKill().options.find((o) => o.long === "--intent");
  expect(intent?.argChoices).toEqual(["interrupt", "terminate", "force"]);
  expect(intent?.defaultValue).toBe("terminate");
});

test("a session is found by id, by name, or by an unambiguous prefix", () => {
  const sessions = [
    { id: "eb86a3dc-bc8f", name: "hello" },
    { id: "7f21ba90-1c44", name: "worker" },
  ];
  expect(resolveSession(sessions, "eb86a3dc-bc8f")).toBe("eb86a3dc-bc8f");
  expect(resolveSession(sessions, "hello")).toBe("eb86a3dc-bc8f");
  expect(resolveSession(sessions, "eb86")).toBe("eb86a3dc-bc8f");
  expect(resolveSession(sessions, "work")).toBe("7f21ba90-1c44");
});
test("an exact match wins over a prefix of something else", () => {
  // `we` names one session and prefixes another; the name is what was meant.
  const sessions = [
    { id: "a1", name: "we" },
    { id: "a2", name: "web" },
  ];
  expect(resolveSession(sessions, "we")).toBe("a1");
});
test("an ambiguous prefix names what it matched rather than guessing", () => {
  const sessions = [
    { id: "a1", name: "web" },
    { id: "a2", name: "welder" },
  ];
  expect(() => resolveSession(sessions, "we")).toThrow(/matches 2 sessions/);
});
test("a name two sessions share is ambiguous rather than first-wins", () => {
  // The daemon keeps generated names unique; two sessions given the same name
  // over the wire must still not silently resolve to whichever came back first.
  const sessions = [
    { id: "a1", name: "claude" },
    { id: "a2", name: "claude" },
  ];
  expect(() => resolveSession(sessions, "claude")).toThrow(
    /matches 2 sessions/,
  );
  // Ambiguity is reported in the one spelling that can settle it.
  expect(() => resolveSession(sessions, "claude")).toThrow(/a1.*a2/);
});
test("a session is found by the workspace it is running in", () => {
  const sessions = [
    { id: "a1", name: "claude", workspace: "fix-login-a3f2b1c9" },
    { id: "a2", name: "claude", workspace: "docs-9e01ff42" },
  ];
  expect(resolveSession(sessions, "fix-login-a3f2b1c9")).toBe("a1");
  expect(resolveSession(sessions, "docs")).toBe("a2");
});
test("a name beats a workspace of the same spelling", () => {
  const sessions = [
    { id: "a1", name: "docs" },
    { id: "a2", name: "claude", workspace: "docs" },
  ];
  expect(resolveSession(sessions, "docs")).toBe("a1");
});
test("aliases carry the workspace a session was started in", () => {
  const root = path.join(path.sep, "state", "workspaces");
  const info = (id: string, cwd: string) =>
    ({ id, name: "claude", cwd }) as unknown as SessionInfo;
  expect(
    aliasesOf(
      [
        info("a1", path.join(root, "werk-1234abcd", "fix-login-a3f2b1c9")),
        info("a2", path.join(path.sep, "home", "mike", "elsewhere")),
      ],
      root,
    ),
  ).toEqual([
    { id: "a1", name: "claude", workspace: "fix-login-a3f2b1c9" },
    { id: "a2", name: "claude", workspace: undefined },
  ]);
});
test("a session that is not there says so", () => {
  expect(() => resolveSession([{ id: "a1", name: "x" }], "nope")).toThrow(
    /no session called nope/,
  );
});

test("a created session says which workspace it landed in, in the one notation", () => {
  const made = workspace();
  const info = session({ cwd: made.directory });
  const text = renderCreated(info, context(), made, true);
  // Read off the notation rather than restated here, so the line and the
  // reference cannot drift into two spellings of the same fact.
  expect(text).toContain(
    `workspace ${formatWorkspaceReference(workspaceReference(made), "full")} on branch ${made.branch}`,
  );
  // The directory is the reference's, and is not also spelled out a second
  // time on the size line.
  expect(text).toContain(made.directory);
  expect(text.split(made.directory)).toHaveLength(2);
  expect(text).toContain("created 8f2c1b04e9d1 demo");
  expect(text).toContain("werk attach 8f2c1b04e9d1");
  expect(text.split("\n")).toHaveLength(4);
});
test("a workspace is named for the caller, or generated from the command", () => {
  // Typed names are taken as typed, so the branch is the branch that was asked
  // for and asking twice is the conflict it looks like.
  expect(workspaceNameFor({ workspace: "fix-login" }, ["claude"])).toBe(
    "fix-login",
  );
  // Generated names carry a readable leaf and enough entropy that a second
  // `create` in one repository does not collide.
  const first = workspaceNameFor({}, ["/bin/sh"]);
  const second = workspaceNameFor({}, ["/bin/sh"]);
  expect(first).toMatch(/^sh-[0-9a-f]{8}$/);
  expect(second).not.toBe(first);
  // The session's name is the better leaf when there is one.
  expect(workspaceNameFor({ name: "demo" }, ["claude"])).toMatch(
    /^demo-[0-9a-f]{8}$/,
  );
  // Whatever the command was called, the result is a name a branch and a
  // directory can both carry.
  for (const argv of [["../weird name"], ["..."], [""], ["-x"]])
    expect(isWorkspaceName(workspaceNameFor({}, argv))).toBe(true);
});
test("workspaces live under the state directory, not a setting of their own", async () => {
  const here = await reachHost(context({ stateDir: "/state/werk" }));
  expect(here.root).toBe(path.join("/state/werk", "workspaces"));
  expect(here.session).toBeUndefined();
  expect(here.reference).toBeUndefined();
  // Moving the state directory moves them, which is why no config key was added.
  expect((await reachHost(context({ stateDir: "/elsewhere" }))).root).toBe(
    path.join("/elsewhere", "workspaces"),
  );
  expect(workspaceMakerFor(here).kind).toBe("local-worktree");
});

/**
 * A merge werk never made, so the rendering can be driven without files, an
 * environment or a repository anywhere near it.
 */
const merged = (over: Partial<MergedConfig> = {}): MergedConfig => ({
  config: builtInDefaults({}, "/home/nobody"),
  from: Object.fromEntries(
    CONFIG_KEYS.map((key) => [key, "defaults"]),
  ) as MergedConfig["from"],
  hosts: {},
  hostFrom: {},
  shadowed: [],
  problems: [],
  layers: [],
  ...over,
});
const hostRows = (over: Partial<MergedConfig> = {}) =>
  merged({
    hosts: {
      local: { kind: "local" },
      "agent-sandboxes": { kind: "ssh", sshHost: "agent-sandboxes" },
    },
    hostFrom: { local: "defaults", "agent-sandboxes": "user" },
    ...over,
  });

test("config list carries a host and the layer that supplied it", () => {
  const ctx = context();
  const shown = listResult(hostRows(), ctx);
  const text = shown.human(ctx);
  // Piped output is TSV, so a row can be asserted as the row it is.
  expect(text).toContain(
    "hosts.agent-sandboxes\tssh agent-sandboxes\tuser file",
  );
  expect(text).toContain("hosts.local\tlocal\tdefaults");
  // The settings still come first and still say where they came from.
  expect(text).toContain("defaultHost\tlocal\tdefaults");
  // The machine shape keeps the whole block, because summarising it is a thing
  // a person wants and a script does not.
  expect(shown.json.find((row) => row.key === "hosts.agent-sandboxes")).toEqual(
    {
      key: "hosts.agent-sandboxes",
      value: { kind: "ssh", sshHost: "agent-sandboxes" },
      layer: "user",
    },
  );
  // The element shape is unchanged, so the jq in the help still works.
  for (const row of shown.json)
    expect(Object.keys(row).sort()).toEqual(["key", "layer", "value"]);
});
test("a host block werk could not read is a row that says so", () => {
  const ctx = context();
  const shown = listResult(
    hostRows({
      problems: [
        {
          name: "broken",
          layer: "project",
          file: "/repo/.werk/config.toml",
          message:
            "unknown key sshHosts in hosts.broken (/repo/.werk/config.toml)",
        },
      ],
    }),
    ctx,
  );
  // Leaving it out would say the name is not configured, when what happened is
  // that it is configured wrongly.
  expect(shown.human(ctx)).toContain("hosts.broken\tunreadable\tproject file");
  expect(shown.json.find((row) => row.key === "hosts.broken")).toEqual({
    key: "hosts.broken",
    value: null,
    layer: "project",
  });
});
test("config sources says which host block lost and which one could not be read", () => {
  const ctx = context();
  const user = "/home/nobody/.werk/config.toml";
  const project = "/repo/.werk/config.toml";
  const shown = sourcesResult(
    hostRows({
      hostFrom: { local: "defaults", "agent-sandboxes": "project" },
      layers: [
        {
          name: "user",
          origin: user,
          values: {},
          hosts: { "agent-sandboxes": { kind: "ssh", sshHost: "old" } },
        },
        {
          name: "project",
          origin: project,
          values: {},
          hosts: {
            "agent-sandboxes": { kind: "ssh", sshHost: "agent-sandboxes" },
          },
          problems: [
            {
              name: "broken",
              file: project,
              message: `unknown key sshHosts in hosts.broken (${project})`,
            },
          ],
        },
      ],
      shadowed: [{ name: "agent-sandboxes", layer: "user", by: "project" }],
      problems: [
        {
          name: "broken",
          layer: "project",
          file: project,
          message: `unknown key sshHosts in hosts.broken (${project})`,
        },
      ],
    }),
    {
      paths: {
        userDir: "/home/nobody/.werk",
        user,
        projectDir: "/repo/.werk",
        project,
      },
      envVariables: [],
    },
    ctx,
  );
  const text = shown.human(ctx);
  // A block a stronger layer replaced looks like nothing happening from
  // anywhere else, which is why it is said against the layer that lost it.
  expect(text).toContain(
    "shadowed\thosts.agent-sandboxes replaced by project file",
  );
  expect(text).toContain(
    `unreadable\tunknown key sshHosts in hosts.broken (${project})`,
  );
  // The user layer still counts as holding something, so it does not read as
  // an absent file.
  const [layer] = shown.json.filter((record) => record.source === "user");
  expect(layer!.state).toBe("overridden");
  expect(layer!.where).toBe(user);
});
