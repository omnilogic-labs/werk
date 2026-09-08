/**
 * What werk writes down about a workspace, and what happens when it cannot read
 * it back.
 *
 * The interesting half is the second one. Nothing else in werk fails because a
 * record is missing, so every way a file can be unusable — absent, truncated,
 * JSON that is not a record — has to come back as "no record" rather than as an
 * exception from somewhere three layers down.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { repositorySlot } from "../src/local.js";
import { workspaceRecords, type WorkspaceRecord } from "../src/record.js";

const made: string[] = [];
async function scratch(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), `werk-rec-${label}-`));
  made.push(directory);
  return directory;
}
afterAll(async () => {
  for (const directory of made)
    await rm(directory, { recursive: true, force: true }).catch(() => {});
});

const record = (over: Partial<WorkspaceRecord> = {}): WorkspaceRecord => ({
  name: "fix-login",
  directory: "/state/werk/workspaces/repo-a3f2b1c9/fix-login",
  branch: "fix-login",
  parent: "main",
  base: "a".repeat(40),
  source: "/home/somebody/repo",
  createdAt: 1_700_000_000_000,
  ...over,
});

test("a record survives being written and read back", async () => {
  const root = await scratch("round-trip");
  const records = workspaceRecords(root, "/home/somebody/repo");
  await records.put(record());
  expect(await records.get("fix-login")).toEqual(record());
});

test("records are keyed by the repository they were made from", async () => {
  const root = await scratch("keyed");
  await workspaceRecords(root, "/home/somebody/one").put(record());
  // The same name, made from a different checkout, is a different workspace.
  expect(
    await workspaceRecords(root, "/home/somebody/two").get("fix-login"),
  ).toBeUndefined();
  expect(await readdir(root)).toEqual([repositorySlot("/home/somebody/one")]);
});

test("a record replaces the one it was written over", async () => {
  const root = await scratch("replace");
  const records = workspaceRecords(root, "/home/somebody/repo");
  await records.put(record());
  await records.put(record({ parent: "release", base: "b".repeat(40) }));
  const held = await records.get("fix-login");
  expect(held?.parent).toBe("release");
  expect(held?.base).toBe("b".repeat(40));
});

test("a record with no parent is one made on a detached HEAD", async () => {
  const root = await scratch("detached");
  const records = workspaceRecords(root, "/home/somebody/repo");
  const { parent: _dropped, ...loose } = record();
  await records.put(loose);
  const held = await records.get("fix-login");
  expect(held?.parent).toBeUndefined();
  expect(held?.base).toBe("a".repeat(40));
});

test("the list is newest first, and leaves out what it cannot read", async () => {
  const root = await scratch("list");
  const records = workspaceRecords(root, "/home/somebody/repo");
  await records.put(record({ name: "older", createdAt: 1 }));
  await records.put(record({ name: "newer", createdAt: 2 }));
  await writeFile(path.join(records.directory, "broken.json"), "{ not json");
  await writeFile(
    path.join(records.directory, "wrong.json"),
    JSON.stringify({ name: "wrong" }),
  );
  // A directory whose name ends in .json is not a record either.
  await mkdir(path.join(records.directory, "adirectory.json"));
  expect((await records.list()).map((r) => r.name)).toEqual(["newer", "older"]);
});

test("no records at all is an empty list, not a failure", async () => {
  const root = await scratch("nothing");
  const records = workspaceRecords(root, "/home/somebody/repo");
  expect(await records.list()).toEqual([]);
  expect(await records.get("anything")).toBeUndefined();
});

test("forgetting a record werk never had is not a failure", async () => {
  const root = await scratch("forget");
  const records = workspaceRecords(root, "/home/somebody/repo");
  await records.forget("never-existed");
  await records.put(record());
  await records.forget("fix-login");
  expect(await records.get("fix-login")).toBeUndefined();
});

test("a file that is JSON but not a record reads as no record", async () => {
  const root = await scratch("shape");
  const records = workspaceRecords(root, "/home/somebody/repo");
  await mkdir(records.directory, { recursive: true });
  for (const [name, body] of [
    ["missing-base", JSON.stringify({ ...record(), base: undefined })],
    ["wrong-type", JSON.stringify({ ...record(), createdAt: "yesterday" })],
    ["an-array", "[]"],
    ["a-number", "7"],
    ["null", "null"],
  ] as const)
    await writeFile(path.join(records.directory, `${name}.json`), body);
  for (const name of [
    "missing-base",
    "wrong-type",
    "an-array",
    "a-number",
    "null",
  ])
    expect(await records.get(name)).toBeUndefined();
});
