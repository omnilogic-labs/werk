/**
 * Listing the machines somebody already wrote down.
 *
 * The scanner is not trying to be ssh. `ssh -G` resolves a destination
 * correctly and is what {@link resolveSshDestination} calls; what this does is
 * enumerate, which `ssh -G` cannot do. So the cases below are about the
 * enumeration going wrong in the ways that would show up as an empty or a
 * misleading picker: an `Include` that never terminates, a `Match` block whose
 * keywords are not a machine, and a config that is all wildcards.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readSshAliases,
  resolveSshDestination,
} from "../src/config/ssh-config.js";

const home = await mkdtemp("/tmp/wks-");
afterAll(() => rm(home, { recursive: true, force: true }));

let made = 0;
/** A `~/.ssh` of its own for each case, so one case cannot see another's. */
async function ssh(files: Record<string, string>): Promise<string> {
  const root = join(home, `h${made++}`);
  for (const [name, text] of Object.entries(files)) {
    const file = join(root, name);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, text);
  }
  return root;
}

const read = (root: string) =>
  readSshAliases({
    userFile: join(root, ".ssh", "config"),
    // A file that is not there, so the system layer contributes nothing and the
    // machine running the test cannot change the answer.
    systemFile: join(root, "etc", "ssh_config"),
    home: root,
  });

test("a missing file is not a failure", async () => {
  const found = await read(await ssh({}));
  expect(found.aliases).toEqual([]);
  expect(found.skipped).toBe(0);
});

test("Host a b c yields three, in the order they were written", async () => {
  const root = await ssh({
    ".ssh/config": "Host a b c\n  HostName one.example\n",
  });
  const found = await read(root);
  expect(found.aliases.map((one) => one.name)).toEqual(["a", "b", "c"]);
  expect(found.aliases.every((one) => one.hostName === "one.example")).toBe(
    true,
  );
});

test("wildcards and negations are skipped and counted", async () => {
  const root = await ssh({
    ".ssh/config": [
      "Host *",
      "  ForwardAgent yes",
      "Host *.example !secret dev?",
      "Host beast",
      "  HostName 10.0.0.7",
      "",
    ].join("\n"),
  });
  const found = await read(root);
  expect(found.aliases.map((one) => one.name)).toEqual(["beast"]);
  expect(found.skipped).toBe(4);
});

test("Host=name works as well as Host name", async () => {
  const root = await ssh({
    ".ssh/config": "Host=beast\nHostName = 10.0.0.7\nUser=mike\nPort = 2222\n",
  });
  const found = await read(root);
  expect(found.aliases).toHaveLength(1);
  expect(found.aliases[0]).toMatchObject({
    name: "beast",
    hostName: "10.0.0.7",
    user: "mike",
    port: "2222",
  });
});

test("a quoted pattern loses its quotes, and a comment loses its line", async () => {
  const root = await ssh({
    ".ssh/config": [
      "# a comment",
      'Host "beast"  # trailing',
      '  HostName "10.0.0.7"',
      "",
    ].join("\n"),
  });
  const found = await read(root);
  expect(found.aliases[0]).toMatchObject({
    name: "beast",
    hostName: "10.0.0.7",
  });
});

test("a Match block is skipped whole", async () => {
  const root = await ssh({
    ".ssh/config": [
      "Match host beast exec true",
      "  HostName never.example",
      "  User nobody",
      "Host tiny",
      "  HostName tiny.example",
      "",
    ].join("\n"),
  });
  const found = await read(root);
  expect(found.aliases.map((one) => one.name)).toEqual(["tiny"]);
  expect(found.aliases[0]?.hostName).toBe("tiny.example");
});

test("Include follows a glob and a relative path", async () => {
  const root = await ssh({
    ".ssh/config": "Include config.d/*.conf\nInclude work\nHost home\n",
    ".ssh/config.d/b.conf": "Host bravo\n  HostName b.example\n",
    ".ssh/config.d/a.conf": "Host alpha\n",
    ".ssh/config.d/ignored.txt": "Host nope\n",
    ".ssh/work": "Host office\n",
  });
  const found = await read(root);
  // Sorted within the glob, which is the order glob(3) gives ssh, then the
  // literal include, then the rest of the including file.
  expect(found.aliases.map((one) => one.name)).toEqual([
    "alpha",
    "bravo",
    "office",
    "home",
  ]);
});

test("an Include cycle terminates", async () => {
  const root = await ssh({
    ".ssh/config": "Include loop\nHost first\n",
    ".ssh/loop": "Include config\nHost second\n",
  });
  const found = await read(root);
  expect(found.aliases.map((one) => one.name)).toEqual(["second", "first"]);
});

test("an unreadable Include is skipped silently, as ssh does", async () => {
  const root = await ssh({ ".ssh/config": "Include nowhere\nHost beast\n" });
  const found = await read(root);
  expect(found.aliases.map((one) => one.name)).toEqual(["beast"]);
});

test("the first occurrence of a pattern wins", async () => {
  const root = await ssh({
    ".ssh/config": [
      "Host beast",
      "  HostName first.example",
      "Host beast",
      "  HostName second.example",
      "",
    ].join("\n"),
  });
  const found = await read(root);
  expect(found.aliases).toHaveLength(1);
  expect(found.aliases[0]?.hostName).toBe("first.example");
});

test("the system file is read and marked as the system file", async () => {
  const root = await ssh({
    ".ssh/config": "Host mine\n",
    "etc/ssh_config": "Host theirs\n",
  });
  const found = await read(root);
  expect(found.aliases.map((one) => [one.name, one.system])).toEqual([
    ["mine", false],
    ["theirs", true],
  ]);
});

test("resolveSshDestination reads what ssh -G printed", async () => {
  const resolved = await resolveSshDestination("beast", async (args) => {
    expect(args).toEqual(["-G", "beast"]);
    return {
      ok: true,
      stdout:
        "host beast\nhostname 10.0.0.7\nuser mike\nport 2222\nhostname again\n",
    };
  });
  expect(resolved).toMatchObject({
    hostname: "10.0.0.7",
    user: "mike",
    port: "2222",
  });
});

test("resolveSshDestination answers nothing when ssh could not", async () => {
  expect(
    await resolveSshDestination("beast", async () => ({
      ok: false,
      stdout: "",
    })),
  ).toBeUndefined();
  expect(
    await resolveSshDestination("beast", () =>
      Promise.reject(new Error("no ssh")),
    ),
  ).toBeUndefined();
});
