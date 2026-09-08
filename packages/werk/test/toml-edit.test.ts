/**
 * The splicer, and the property that licenses it to be incomplete.
 *
 * Two things are being asserted here. The first is that everything outside the
 * region being replaced comes back byte for byte: the comments a person wrote
 * above, inside and below a block, the blank lines, the CRLF endings, the file
 * with no trailing newline. That is the whole reason `applyEdit` exists instead
 * of a parse and a restringify.
 *
 * The second is the refusal. The scanner does not understand every spelling
 * TOML has, and it is not supposed to: it parses the result and compares it
 * against the value the edit asked for, and raises `CONFIG_WRITE_FAILED` when
 * they differ. So the last two cases are inputs crafted to defeat the splice,
 * and what they prove is that a defeated splice is a refusal rather than a
 * damaged file.
 */
import { expect, test } from "bun:test";
import { applyEdit } from "../src/config/toml-edit.js";
import { ConfigError } from "../src/config/errors.js";
import type { Host } from "../src/config/hosts.js";

const beast: Host = {
  kind: "ssh",
  sshHost: "beast.example",
  workspaceRoot: "/srv/werk",
};

const cases: {
  name: string;
  source: string;
  edit: Parameters<typeof applyEdit>[1];
  want: string;
}[] = [
  {
    name: "keeps the comments above, inside and below the file's other blocks",
    source: [
      "# the top of the file",
      "",
      "# about the level",
      'logLevel = "warn"',
      "",
      "# about beast",
      "[hosts.beast]",
      'kind = "ssh"',
      "# inside beast",
      'sshHost = "old"',
      "",
      "# about tiny",
      "[hosts.tiny]",
      'kind = "ssh"',
      'sshHost = "tiny"',
      "",
      "# a note at the bottom",
      "",
    ].join("\n"),
    edit: { hosts: { beast } },
    want: [
      "# the top of the file",
      "",
      "# about the level",
      'logLevel = "warn"',
      "",
      "# about beast",
      "[hosts.beast]",
      'kind = "ssh"',
      'sshHost = "beast.example"',
      'workspaceRoot = "/srv/werk"',
      "",
      "# about tiny",
      "[hosts.tiny]",
      'kind = "ssh"',
      'sshHost = "tiny"',
      "",
      "# a note at the bottom",
      "",
    ].join("\n"),
  },
  {
    name: "writes CRLF into a file that uses CRLF",
    source: '# a windows file\r\nlogLevel = "warn"\r\n',
    edit: { set: { logLevel: "debug" } },
    want: '# a windows file\r\nlogLevel = "debug"\r\n',
  },
  {
    name: "is not fooled by a header inside a multi-line array",
    source: [
      "list = [",
      '  ["[hosts.beast]"],',
      "]",
      "",
      "[hosts.beast]",
      'kind = "ssh"',
      'sshHost = "old"',
      "",
    ].join("\n"),
    edit: { hosts: { beast } },
    want: [
      "list = [",
      '  ["[hosts.beast]"],',
      "]",
      "",
      "[hosts.beast]",
      'kind = "ssh"',
      'sshHost = "beast.example"',
      'workspaceRoot = "/srv/werk"',
      "",
    ].join("\n"),
  },
  {
    name: "is not fooled by a header inside a multi-line basic string",
    source: [
      'description = """',
      "[hosts.beast]",
      'kind = "not really"',
      '"""',
      "",
      "[hosts.beast]",
      'kind = "ssh"',
      'sshHost = "old"',
      "",
    ].join("\n"),
    edit: { hosts: { beast } },
    want: [
      'description = """',
      "[hosts.beast]",
      'kind = "not really"',
      '"""',
      "",
      "[hosts.beast]",
      'kind = "ssh"',
      'sshHost = "beast.example"',
      'workspaceRoot = "/srv/werk"',
      "",
    ].join("\n"),
  },
  {
    name: "is not fooled by a header inside a multi-line literal string",
    source: [
      "description = '''",
      "[hosts.beast]",
      "'''",
      "",
      "[hosts.beast]",
      'kind = "ssh"',
      'sshHost = "old"',
      "",
    ].join("\n"),
    edit: { hosts: { beast } },
    want: [
      "description = '''",
      "[hosts.beast]",
      "'''",
      "",
      "[hosts.beast]",
      'kind = "ssh"',
      'sshHost = "beast.example"',
      'workspaceRoot = "/srv/werk"',
      "",
    ].join("\n"),
  },
  {
    name: "gives a file with no trailing newline one",
    source: 'logLevel = "warn"',
    edit: { set: { scrollbackBytes: 4096 } },
    want: 'logLevel = "warn"\nscrollbackBytes = 4096\n',
  },
  {
    name: "writes into an empty file",
    source: "",
    edit: { hosts: { beast } },
    want: [
      "[hosts.beast]",
      'kind = "ssh"',
      'sshHost = "beast.example"',
      'workspaceRoot = "/srv/werk"',
      "",
    ].join("\n"),
  },
  {
    name: "adds the first host to a file that has no hosts at all",
    source: 'logLevel = "warn"\n',
    edit: { hosts: { beast } },
    want: [
      'logLevel = "warn"',
      "",
      "[hosts.beast]",
      'kind = "ssh"',
      'sshHost = "beast.example"',
      'workspaceRoot = "/srv/werk"',
      "",
    ].join("\n"),
  },
  {
    name: "puts a new setting above the comment introducing the first table",
    source: [
      "# about beast",
      "[hosts.beast]",
      'kind = "ssh"',
      'sshHost = "b"',
      "",
    ].join("\n"),
    edit: { set: { logLevel: "debug" } },
    want: [
      'logLevel = "debug"',
      "",
      "# about beast",
      "[hosts.beast]",
      'kind = "ssh"',
      'sshHost = "b"',
      "",
    ].join("\n"),
  },
  {
    name: "removes a block without taking the next block's comment with it",
    source: [
      "[hosts.beast]",
      'kind = "ssh"',
      'sshHost = "b"',
      "",
      "# about tiny",
      "[hosts.tiny]",
      'kind = "ssh"',
      'sshHost = "t"',
      "",
    ].join("\n"),
    edit: { hosts: { beast: null } },
    want: [
      "# about tiny",
      "[hosts.tiny]",
      'kind = "ssh"',
      'sshHost = "t"',
      "",
    ].join("\n"),
  },
  {
    name: "replaces the last block in the file",
    source: [
      'logLevel = "warn"',
      "",
      "[hosts.beast]",
      'kind = "ssh"',
      'sshHost = "old"',
      "",
    ].join("\n"),
    edit: { hosts: { beast } },
    want: [
      'logLevel = "warn"',
      "",
      "[hosts.beast]",
      'kind = "ssh"',
      'sshHost = "beast.example"',
      'workspaceRoot = "/srv/werk"',
      "",
    ].join("\n"),
  },
  {
    name: "removes a setting's line and leaves the rest alone",
    source: ["# why", 'logLevel = "warn"', 'defaultHost = "local"', ""].join(
      "\n",
    ),
    edit: { set: { logLevel: null } },
    want: ["# why", 'defaultHost = "local"', ""].join("\n"),
  },
  {
    name: "replaces a setting whose value runs over several lines",
    source: ["list = [", '  "a",', '  "b",', "]", 'logLevel = "warn"', ""].join(
      "\n",
    ),
    edit: { set: { logLevel: "debug" } },
    want: ["list = [", '  "a",', '  "b",', "]", 'logLevel = "debug"', ""].join(
      "\n",
    ),
  },
];

for (const one of cases)
  test(`applyEdit ${one.name}`, () => {
    expect(applyEdit(one.source, one.edit)).toBe(one.want);
  });

test("applyEdit escapes a value that would otherwise break the file", () => {
  const written = applyEdit("", {
    hosts: { odd: { kind: "ssh", sshHost: 'a"b\\c\nd' } },
  });
  expect(written).toContain('sshHost = "a\\"b\\\\c\\nd"');
  expect(Bun.TOML.parse(written)).toEqual({
    hosts: { odd: { kind: "ssh", sshHost: 'a"b\\c\nd' } },
  });
});

test("applyEdit writes an env as an inline table and reads it back", () => {
  const written = applyEdit("", {
    hosts: {
      beast: {
        kind: "ssh",
        sshHost: "beast",
        env: { EDITOR: "werk edit --wait", CARGO_HOME: "/opt/cargo" },
      },
    },
  });
  expect(written).toContain(
    'env = { EDITOR = "werk edit --wait", CARGO_HOME = "/opt/cargo" }',
  );
  // One line, so the block stays a span this module can replace whole.
  expect(
    written.split("\n").filter((line) => line.includes("env")),
  ).toHaveLength(1);
  expect(Bun.TOML.parse(written)).toEqual({
    hosts: {
      beast: {
        kind: "ssh",
        sshHost: "beast",
        env: { EDITOR: "werk edit --wait", CARGO_HOME: "/opt/cargo" },
      },
    },
  });
});
test("applyEdit escapes inside an inline table, key and value alike", () => {
  const written = applyEdit("", {
    hosts: {
      odd: {
        kind: "ssh",
        sshHost: "a",
        env: { PROMPT: 'a"b\\c\nd', "with.dot": "x" },
      },
    },
  });
  expect(written).toContain('PROMPT = "a\\"b\\\\c\\nd"');
  expect(written).toContain('"with.dot" = "x"');
  expect(Bun.TOML.parse(written)).toEqual({
    hosts: {
      odd: {
        kind: "ssh",
        sshHost: "a",
        env: { PROMPT: 'a"b\\c\nd', "with.dot": "x" },
      },
    },
  });
});
test("applyEdit removes an env with the block that carried it", () => {
  const source = [
    "[hosts.beast]",
    'kind = "ssh"',
    'sshHost = "beast"',
    'env = { EDITOR = "vi" }',
    "",
  ].join("\n");
  expect(applyEdit(source, { hosts: { beast } })).toBe(
    [
      "[hosts.beast]",
      'kind = "ssh"',
      'sshHost = "beast.example"',
      'workspaceRoot = "/srv/werk"',
      "",
    ].join("\n"),
  );
});

/**
 * A hand-written `[hosts.beast.env]`, under a block werk is being asked to
 * rewrite.
 *
 * Reading one is fine: `Bun.TOML.parse` puts it exactly where an inline table
 * would go. Rewriting the block over it is not, because `spanOf` ends the span
 * at that header and the sub-table survives. With an `env` in the edit the
 * result defines the table twice and does not parse; without one the sub-table
 * is still there afterwards, saying something the edit did not ask for. Either
 * way it is a refusal, which is why werk only ever writes the inline form.
 */
test("applyEdit refuses to rewrite a block whose env is a sub-table", () => {
  const source = [
    "[hosts.beast]",
    'kind = "ssh"',
    'sshHost = "old"',
    "",
    "[hosts.beast.env]",
    'EDITOR = "vi"',
    "",
  ].join("\n");
  const refused = (edit: Parameters<typeof applyEdit>[1]) => {
    try {
      applyEdit(source, edit);
    } catch (error) {
      return error;
    }
    return undefined;
  };
  const twice = refused({
    hosts: { beast: { kind: "ssh", sshHost: "new", env: { EDITOR: "vi" } } },
  });
  expect(twice).toBeInstanceOf(ConfigError);
  expect((twice as ConfigError).code).toBe("CONFIG_WRITE_FAILED");
  expect((twice as ConfigError).message).toContain("redefine");
  const orphaned = refused({
    hosts: { beast: { kind: "ssh", sshHost: "new" } },
  });
  expect(orphaned).toBeInstanceOf(ConfigError);
  expect((orphaned as ConfigError).code).toBe("CONFIG_WRITE_FAILED");
  expect((orphaned as ConfigError).message).toContain("hosts");
});

test("applyEdit refuses a file that is not TOML at all", () => {
  expect(() =>
    applyEdit("this is not = = toml\n", { set: { logLevel: "debug" } }),
  ).toThrow(ConfigError);
  try {
    applyEdit("this is not = = toml\n", { set: { logLevel: "debug" } });
  } catch (error) {
    expect((error as ConfigError).code).toBe("CONFIG_UNREADABLE");
  }
});

/**
 * A sub-table werk did not write, under a block werk is being asked to remove.
 *
 * The span of `[hosts.beast]` stops at the next header, so removing it leaves
 * `[hosts.beast.extra]` behind, and `hosts.beast` still exists afterwards with
 * a different shape. That is exactly the class of damage the last step is for:
 * the result parses, and it does not say what the edit asked for.
 */
test("applyEdit refuses rather than half-removing a block with a sub-table", () => {
  const source = [
    "[hosts.beast]",
    'kind = "ssh"',
    'sshHost = "b"',
    "",
    "[hosts.beast.extra]",
    "note = 1",
    "",
  ].join("\n");
  let raised: unknown;
  try {
    applyEdit(source, { hosts: { beast: null } });
  } catch (error) {
    raised = error;
  }
  expect(raised).toBeInstanceOf(ConfigError);
  expect((raised as ConfigError).code).toBe("CONFIG_WRITE_FAILED");
  expect((raised as ConfigError).message).toContain("hosts");
});

/**
 * A host written as a dotted key rather than a table. There is no header to
 * find, so the block would be appended and the file would then define
 * `hosts.beast` twice, which is not TOML at all.
 */
test("applyEdit refuses when a host is written as a dotted key", () => {
  let raised: unknown;
  try {
    applyEdit('hosts.beast.kind = "ssh"\nhosts.beast.sshHost = "b"\n', {
      hosts: { beast },
    });
  } catch (error) {
    raised = error;
  }
  expect(raised).toBeInstanceOf(ConfigError);
  expect((raised as ConfigError).code).toBe("CONFIG_WRITE_FAILED");
});
