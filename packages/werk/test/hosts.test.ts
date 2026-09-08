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
  isHostName,
  parseHost,
  parseHosts,
  summariseHost,
  workspaceRootFor,
  type Host,
} from "../src/config/hosts.js";
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
    { name: "beast", layer: "defaults", by: "user" },
    { name: "beast", layer: "user", by: "project" },
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
    expect(isHostName(name), name).toBe(true);
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
    expect(isHostName(name), JSON.stringify(name)).toBe(false);
  expect(isHostName("a".repeat(64))).toBe(true);
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
