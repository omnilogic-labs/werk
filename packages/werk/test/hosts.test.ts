/**
 * Hosts as configuration: what a `[hosts.<name>]` block may say, what happens
 * when one of them is wrong, and how two layers naming the same host settle it.
 *
 * All pure. No filesystem, no environment, no machine anywhere.
 */
import { expect, test } from "bun:test";
import path from "node:path";
import { ConfigError } from "../src/config/errors.js";
import {
  HOST_FIELDS,
  HOST_KINDS,
  builtInHosts,
  hostFor,
  isBlockName,
  parseHost,
  parseHosts,
  summariseHost,
  workspaceRootFor,
  type Host,
} from "../src/config/hosts.js";
import { DAEMON_OWNED } from "../src/environment.js";
import { mergeLayers, type ConfigLayer } from "../src/config/load.js";
import { builtInDefaults } from "../src/config/schema.js";
import { exitCodeFor, errorPayload } from "../src/runtime/exit.js";

/** A defaults layer with every setting in it, plus whatever hosts are wanted. */
const defaults = (
  hosts: Record<string, Host> = builtInHosts(),
): ConfigLayer => ({
  name: "defaults",
  values: builtInDefaults({}, "/home/nobody"),
  hosts,
});
const layer = (
  name: ConfigLayer["name"],
  hosts: Record<string, Host>,
  problems: ConfigLayer["problems"] = [],
): ConfigLayer => ({ name, values: {}, hosts, problems });

test("a host block is replaced whole, never merged field by field", () => {
  // The user file says where the workspaces go; the project file names a
  // different machine. Merging the two would compose a block neither file
  // contains, pointing werk at machine b with machine a's paths.
  const { hosts, hostFrom } = mergeLayers([
    defaults(),
    layer("user", {
      beast: { kind: "ssh", sshHost: "a", workspaceRoot: "/x" },
    }),
    layer("project", { beast: { kind: "ssh", sshHost: "b" } }),
  ]);
  expect(hosts.beast).toEqual({ kind: "ssh", sshHost: "b" });
  expect(hosts.beast).not.toHaveProperty("workspaceRoot");
  expect(hostFrom.beast).toBe("project");
});
test("a replaced block is recorded, naming the layer that lost it", () => {
  const { shadowed } = mergeLayers([
    defaults({ beast: { kind: "local" } }),
    layer("user", { beast: { kind: "ssh", sshHost: "a" } }),
    layer("project", { beast: { kind: "ssh", sshHost: "b" } }),
  ]);
  expect(shadowed).toEqual([
    { table: "hosts", name: "beast", layer: "defaults", by: "user" },
    { table: "hosts", name: "beast", layer: "user", by: "project" },
  ]);
});
test("provenance is per host, so two layers each keep the host they named", () => {
  const { hosts, hostFrom, shadowed } = mergeLayers([
    defaults(),
    layer("user", { beast: { kind: "ssh", sshHost: "beast" } }),
    layer("project", { sandbox: { kind: "ssh", sshHost: "mike@10.0.0.7" } }),
  ]);
  expect(Object.keys(hosts).sort()).toEqual(["beast", "local", "sandbox"]);
  expect(hostFrom).toEqual({
    local: "defaults",
    beast: "user",
    sandbox: "project",
  });
  // Nothing named `local` above the defaults, so the built-in host survives
  // every layer that had something else to say.
  expect(hosts.local).toEqual({ kind: "local" });
  expect(shadowed).toEqual([]);
});
test("a collection with no entries is legitimate, unlike a setting with none", () => {
  const { hosts, hostFrom } = mergeLayers([defaults({})]);
  expect(hosts).toEqual({});
  expect(hostFrom).toEqual({});
});
test("problems ride the merge in layer order, each naming its layer", () => {
  const { problems } = mergeLayers([
    defaults(),
    layer("user", {}, [
      { name: "beast", file: "/u/config.toml", message: "no" },
    ]),
    layer("project", {}, [
      { name: "sandbox", file: "/p/config.toml", message: "no" },
    ]),
  ]);
  expect(problems.map((one) => [one.name, one.layer])).toEqual([
    ["beast", "user"],
    ["sandbox", "project"],
  ]);
});

test("a host block names its kind and the keys that kind takes", () => {
  expect(parseHost("beast", { kind: "ssh", sshHost: "beast" })).toEqual({
    kind: "ssh",
    sshHost: "beast",
  });
  expect(parseHost("here", { kind: "local" })).toEqual({ kind: "local" });
  expect(
    parseHost("sandbox", {
      kind: "ssh",
      sshHost: "mike@10.0.0.7",
      workspaceRoot: "/srv/werk/workspaces",
    }),
  ).toEqual({
    kind: "ssh",
    sshHost: "mike@10.0.0.7",
    workspaceRoot: "/srv/werk/workspaces",
  });
  expect(HOST_KINDS).toEqual(["local", "ssh"]);
  expect(Object.keys(HOST_FIELDS.ssh)).toEqual([
    "sshHost",
    "workspaceRoot",
    "provider",
    "setup",
    "env",
  ]);
});
test("a key inside a host block that werk does not know is refused by name", () => {
  // The asymmetry with a setting is the point: a setting has a default under
  // it and a typo costs a preference, where this typo costs a machine.
  expect(() => parseHost("beast", { kind: "ssh", sshHosts: "beast" })).toThrow(
    /unknown key sshHosts/,
  );
  expect(() => parseHost("here", { kind: "local", sshHost: "beast" })).toThrow(
    /unknown key sshHost/,
  );
  // And the message says where to go and fix it.
  expect(() =>
    parseHost("beast", { kind: "ssh", port: 22 }, "/home/x/.werk/config.toml"),
  ).toThrow("in hosts.beast (/home/x/.werk/config.toml)");
});
test("a key the kind requires is refused by name when it is missing", () => {
  expect(() => parseHost("beast", { kind: "ssh" })).toThrow(
    /sshHost is required/,
  );
  expect(() => parseHost("beast", {})).toThrow(
    /kind must be one of local, ssh/,
  );
  expect(() => parseHost("beast", { kind: "podman" })).toThrow(
    /kind must be one of local, ssh/,
  );
  expect(() => parseHost("beast", "ssh beast")).toThrow(/a host is a table/);
  expect(() => parseHost("beast", { kind: "ssh", sshHost: "" })).toThrow(
    /sshHost must be an ssh destination/,
  );
});
test("provider is accepted and nothing is done with it", () => {
  const host = parseHost("made", {
    kind: "ssh",
    sshHost: "a",
    provider: "incus",
  });
  expect(host).toEqual({ kind: "ssh", sshHost: "a", provider: "incus" });
  // No registry, no kinds, no meaning: a name werk carries around.
  expect(HOST_FIELDS.local.provider.required).toBe(false);
});
test("both kinds take an env and a setup, and carry them untouched", () => {
  const env = { EDITOR: "werk edit --wait", CARGO_HOME: "/opt/cargo" };
  expect(
    parseHost("beast", { kind: "ssh", sshHost: "a", env, setup: "my-boxes" }),
  ).toEqual({ kind: "ssh", sshHost: "a", env, setup: "my-boxes" });
  expect(parseHost("here", { kind: "local", env, setup: "my-boxes" })).toEqual({
    kind: "local",
    env,
    setup: "my-boxes",
  });
  // Whether anything defines that block is a question about the collection, so
  // a name nothing defines is still a block that reads.
  expect(HOST_FIELDS.local.setup.required).toBe(false);
  expect(HOST_FIELDS.ssh.env.required).toBe(false);
});
test("setup names a block, spelled the way every other block name is", () => {
  expect(() =>
    parseHost("beast", { kind: "ssh", sshHost: "a", setup: "my boxes" }),
  ).toThrow(/setup must name a \[setup\.<name>\] block/);
  expect(() =>
    parseHost("beast", { kind: "ssh", sshHost: "a", setup: 3 }),
  ).toThrow(/setup must name a \[setup\.<name>\] block/);
});
test("an env werk would not be able to send is refused where it is written", () => {
  const bad = (env: unknown) => () =>
    parseHost("beast", { kind: "ssh", sshHost: "a", env });
  expect(bad("EDITOR=vi")).toThrow(/env is a table of variables/);
  expect(bad(["EDITOR"])).toThrow(/env is a table of variables/);
  expect(bad({ "2FA": "x" })).toThrow(/env cannot set "2FA"/);
  expect(bad({ "no-dashes": "x" })).toThrow(/env cannot set "no-dashes"/);
  expect(bad({ EDITOR: 3 })).toThrow(/env must give EDITOR a string/);
  expect(bad({ EDITOR: "a\0b" })).toThrow(/env cannot give EDITOR a value/);
  // The daemon's own bounds, said by the file that carries the map rather than
  // by a session that would not start an hour later.
  expect(
    bad(Object.fromEntries([...Array(1025).keys()].map((n) => [`A${n}`, "x"]))),
  ).toThrow(/env takes at most 1024 variables/);
  expect(bad({ [`A${"b".repeat(256)}`]: "x" })).toThrow(
    /env cannot set a name longer than 256 bytes/,
  );
  expect(bad({ BIG: "x".repeat(128 * 1024 + 1) })).toThrow(
    /env gives BIG more than 131072 bytes/,
  );
  expect(
    bad(
      Object.fromEntries(
        [...Array(16).keys()].map((n) => [`A${n}`, "x".repeat(100_000)]),
      ),
    ),
  ).toThrow(/env comes to more than 1048576 bytes in total/);
});
test("the names the daemon writes last are refused rather than discarded", () => {
  // Read off the list `sessionEnvironment` merges over the client's map, so the
  // two cannot drift into disagreeing about which names are werk's.
  for (const name of DAEMON_OWNED)
    expect(() =>
      parseHost("beast", { kind: "ssh", sshHost: "a", env: { [name]: "x" } }),
    ).toThrow(`env cannot set ${name}`);
  // Everything else about the terminal is somebody's to set.
  expect(
    parseHost("beast", { kind: "ssh", sshHost: "a", env: { TERMINFO: "/t" } }),
  ).toEqual({ kind: "ssh", sshHost: "a", env: { TERMINFO: "/t" } });
});
test("an env werk cannot read is a problem in a file, not a throw", () => {
  const { hosts, problems } = parseHosts(
    {
      hosts: {
        beast: { kind: "ssh", sshHost: "beast" },
        broken: { kind: "ssh", sshHost: "b", env: { TERM: "dumb" } },
      },
    },
    "/home/x/.werk/config.toml",
  );
  expect(hosts).toEqual({ beast: { kind: "ssh", sshHost: "beast" } });
  expect(problems[0]!.name).toBe("broken");
  expect(problems[0]!.message).toContain("env cannot set TERM");
  expect(problems[0]!.message).toContain("/home/x/.werk/config.toml");
});
test("a stronger layer's block drops the env under it, whole", () => {
  // By name and never by field: a project file that re-points a machine takes
  // the whole block with it, rather than leaving the user file's variables on
  // an address nobody wrote them against.
  const { hosts } = mergeLayers([
    defaults(),
    layer("user", {
      beast: { kind: "ssh", sshHost: "a", env: { EDITOR: "vi" } },
    }),
    layer("project", { beast: { kind: "ssh", sshHost: "b" } }),
  ]);
  expect(hosts.beast).toEqual({ kind: "ssh", sshHost: "b" });
  expect(hosts.beast).not.toHaveProperty("env");
});
test("a table name that is not a host name is refused as the name it is", () => {
  const error = (() => {
    try {
      parseHost("beast:2", { kind: "local" });
    } catch (thrown) {
      return thrown as ConfigError;
    }
  })();
  expect(error).toBeInstanceOf(ConfigError);
  expect(error!.code).toBe("HOST_NAME_INVALID");
});
test("a host name is a bare TOML key with no @ and no : in it", () => {
  for (const name of [
    "local",
    "beast",
    "agent-sandboxes",
    "a",
    "10.0.0.7",
    "a_b.c-d",
  ])
    expect(isBlockName(name), name).toBe(true);
  for (const name of [
    "",
    "-leading",
    ".leading",
    "_leading",
    "mike@beast",
    "beast:2",
    "two words",
    "has/slash",
    "a".repeat(65),
  ])
    expect(isBlockName(name), JSON.stringify(name)).toBe(false);
  expect(isBlockName("a".repeat(64))).toBe(true);
});

test("a block werk cannot read is a problem, not a reason to stop", () => {
  const { hosts, problems } = parseHosts(
    {
      logLevel: "debug",
      hosts: {
        beast: { kind: "ssh", sshHost: "beast" },
        broken: { kind: "ssh", sshHosts: "typo" },
      },
    },
    "/home/x/.werk/config.toml",
  );
  // The good block beside it still loads, which is the whole point: werk starts.
  expect(hosts).toEqual({ beast: { kind: "ssh", sshHost: "beast" } });
  expect(problems).toHaveLength(1);
  expect(problems[0]!.name).toBe("broken");
  expect(problems[0]!.file).toBe("/home/x/.werk/config.toml");
  expect(problems[0]!.message).toContain("unknown key sshHosts");
  expect(problems[0]!.message).toContain("/home/x/.werk/config.toml");
});
test("a file with no hosts in it contributes no hosts and no problems", () => {
  expect(parseHosts({ logLevel: "debug" })).toEqual({
    hosts: {},
    problems: [],
  });
  expect(parseHosts(null)).toEqual({ hosts: {}, problems: [] });
  // A top-level table werk has no meaning for is left alone, which is what lets
  // a new table arrive without a flag day.
  expect(parseHosts({ providers: { incus: { remote: "local" } } })).toEqual({
    hosts: {},
    problems: [],
  });
});
test("hosts that is not a table of blocks is one problem, not a throw", () => {
  const { hosts, problems } = parseHosts({ hosts: "beast" }, "/x/config.toml");
  expect(hosts).toEqual({});
  expect(problems[0]!.message).toContain("hosts is a table of host blocks");
});

test("a host summarises as the machine and how it is reached", () => {
  expect(summariseHost({ kind: "local" })).toBe("local");
  expect(summariseHost({ kind: "ssh", sshHost: "agent-sandboxes" })).toBe(
    "ssh agent-sandboxes",
  );
});
test("local is a host werk has without being told, with an ordinary provenance", () => {
  expect(builtInHosts()).toEqual({ local: { kind: "local" } });
  expect(mergeLayers([defaults()]).hostFrom.local).toBe("defaults");
});
test("workspaces on this machine go where werk already puts them", () => {
  // The same path `werk create` uses today, so this describes the present
  // rather than introducing a place to put them.
  expect(workspaceRootFor("local", { kind: "local" }, "/state/werk")).toBe(
    path.join("/state/werk", "workspaces"),
  );
  expect(
    workspaceRootFor(
      "local",
      { kind: "local", workspaceRoot: "/elsewhere" },
      "/state/werk",
    ),
  ).toBe("/elsewhere");
  expect(
    workspaceRootFor(
      "beast",
      { kind: "ssh", sshHost: "beast", workspaceRoot: "/srv/werk" },
      "/state/werk",
    ),
  ).toBe("/srv/werk");
  // werk has no answer for a machine it has not looked at, and says so rather
  // than guessing a path on somebody else's disk.
  expect(
    workspaceRootFor("beast", { kind: "ssh", sshHost: "beast" }, "/state/werk"),
  ).toBeUndefined();
});

test("configuration werk cannot act on exits like anything else typed wrong", () => {
  expect(exitCodeFor(new ConfigError("HOST_INVALID", "x"))).toBe(2);
  expect(exitCodeFor(new ConfigError("HOST_NAME_INVALID", "x"))).toBe(2);
  expect(exitCodeFor(new ConfigError("UNKNOWN_HOST", "x"))).toBe(2);
  expect(exitCodeFor(new ConfigError("CONFIG_UNREADABLE", "x"))).toBe(2);
  // The machine did not do it, which is the other register entirely.
  expect(exitCodeFor(new ConfigError("CONFIG_WRITE_FAILED", "x"))).toBe(1);
});
test("the machine shape reports a config code as itself", () => {
  const payload = errorPayload(
    new ConfigError("HOST_INVALID", "unknown key sshHosts", {
      table: "hosts.beast",
      file: "/home/x/.werk/config.toml",
    }),
  );
  expect(payload.error.code).toBe("HOST_INVALID");
  expect(payload.error.message).toBe(
    "unknown key sshHosts in hosts.beast (/home/x/.werk/config.toml)",
  );
});

/* --------------------------------------- which host a command acts on */

/** The three answers `hostFor` reads, without a context anywhere near it. */
const selection = (
  hosts: Record<string, Host>,
  over: { defaultHost?: string; requestedHost?: string } = {},
) => ({
  hosts,
  hostProblems: [],
  defaultHost: over.defaultHost ?? "local",
  ...(over.requestedHost === undefined
    ? {}
    : { requestedHost: over.requestedHost }),
});

test("the flag beats defaultHost, and defaultHost answers when nothing does", () => {
  const hosts: Record<string, Host> = {
    local: { kind: "local" },
    beast: { kind: "ssh", sshHost: "beast" },
    spare: { kind: "ssh", sshHost: "spare" },
  };
  expect(hostFor(selection(hosts, { defaultHost: "beast" })).name).toBe(
    "beast",
  );
  expect(
    hostFor(selection(hosts, { defaultHost: "beast", requestedHost: "spare" }))
      .name,
  ).toBe("spare");
  // An argument beats both, which is what lets a caller resolve a name it got
  // from somewhere other than the command line.
  expect(
    hostFor(
      selection(hosts, { defaultHost: "beast", requestedHost: "spare" }),
      "local",
    ).host.kind,
  ).toBe("local");
});

test("a host nothing defines names what is defined, because it is usually a typo", () => {
  const hosts: Record<string, Host> = {
    local: { kind: "local" },
    beast: { kind: "ssh", sshHost: "beast" },
  };
  let raised: unknown;
  try {
    hostFor(selection(hosts, { requestedHost: "beest" }));
  } catch (error) {
    raised = error;
  }
  expect(raised).toBeInstanceOf(ConfigError);
  expect((raised as ConfigError).code).toBe("UNKNOWN_HOST");
  expect((raised as ConfigError).message).toContain("beest");
  expect((raised as ConfigError).message).toContain("beast");
  expect((raised as ConfigError).message).toContain("local");
  // A mistyped name is a mistake in what werk was told, which is exit 2.
  expect(exitCodeFor(raised)).toBe(2);
});

test("a host block that could not be read fails with why, and not as unknown", () => {
  const file = "/home/nobody/.werk/config.toml";
  let raised: unknown;
  try {
    hostFor({
      hosts: builtInHosts(),
      hostProblems: [
        {
          name: "beast",
          file,
          message: `unknown key sshHosts in hosts.beast (${file})`,
        },
      ],
      defaultHost: "local",
      requestedHost: "beast",
    });
  } catch (error) {
    raised = error;
  }
  expect(raised).toBeInstanceOf(ConfigError);
  expect((raised as ConfigError).code).toBe("HOST_INVALID");
  // The sentence `parseHosts` already wrote, file and all, rather than a
  // second, vaguer one.
  expect((raised as ConfigError).message).toContain("sshHosts");
  expect((raised as ConfigError).message).toContain(file);
});
