/**
 * The one implementation of `ReadAccess` that touches a disk.
 *
 * Everything here is about the promise the interface makes rather than about
 * the filesystem: absence is `null` and never an exception, a tail is a tail,
 * and nothing a mapper asks for can pull an unbounded amount of a file into
 * memory.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { localReadAccess } from "../src/local.js";

const made: string[] = [];
async function scratch(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), `werk-map-${label}-`));
  made.push(directory);
  return directory;
}
afterAll(async () => {
  for (const directory of made)
    await rm(directory, { recursive: true, force: true }).catch(() => {});
});

test("nothing that is not there raises anything", async () => {
  const root = await scratch("absent");
  const access = localReadAccess();
  const missing = access.join(root, "no-such-thing");
  expect(await access.read(missing)).toBeNull();
  expect(await access.list(missing)).toBeNull();
  expect(await access.facts(missing)).toBeNull();
  expect(await access.readEach(missing)).toBeNull();
  // A directory is not a file, and asking for it as one is not an error either.
  expect(await access.read(root)).toBeNull();
});

test("a tail is the end of the file, and the ceiling is one too", async () => {
  const root = await scratch("tail");
  const file = path.join(root, "log");
  await writeFile(file, "abcdefghij");
  const access = localReadAccess({ ceilingBytes: 4 });
  expect(await access.read(file, { tailBytes: 3 })).toBe("hij");
  // Asked for more than the ceiling, or asked for no limit at all, the answer
  // is still bounded and it is still the end.
  expect(await access.read(file, { tailBytes: 100 })).toBe("ghij");
  expect(await access.read(file)).toBe("ghij");
});

test("a directory of records is read in one call, by suffix", async () => {
  const root = await scratch("each");
  await mkdir(path.join(root, "a-directory"));
  await writeFile(path.join(root, "1.json"), "one");
  await writeFile(path.join(root, "2.json"), "two");
  await writeFile(path.join(root, "notes.txt"), "ignored");
  const access = localReadAccess();
  const read = await access.readEach(root, { suffix: ".json" });
  expect([...(read ?? new Map()).entries()].sort()).toEqual([
    ["1.json", "one"],
    ["2.json", "two"],
  ]);
  expect(await access.list(root)).toEqual([
    "1.json",
    "2.json",
    "a-directory",
    "notes.txt",
  ]);
});

test("facts say what a path is", async () => {
  const root = await scratch("facts");
  const file = path.join(root, "one");
  await writeFile(file, "12345");
  const access = localReadAccess();
  expect((await access.facts(root))?.directory).toBe(true);
  const facts = await access.facts(file);
  expect(facts?.directory).toBe(false);
  expect(facts?.size).toBe(5);
  expect(facts?.modifiedAt).toBeGreaterThan(0);
});
