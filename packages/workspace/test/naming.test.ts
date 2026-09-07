/**
 * The two pure decisions: what counts as a name, and where a repository's
 * workspaces go. Neither needs git, so both are asserted directly.
 */
import { expect, test } from "bun:test";
import path from "node:path";
import { isWorkspaceName, repositorySlot } from "../src/local.js";

test("a name is one string a branch and a directory can both carry", () => {
  for (const name of ["demo", "fix-login", "a", "v1.2", "A_b-2", "9lives"])
    expect(isWorkspaceName(name), name).toBe(true);
});
test("a name that would need escaping anywhere is refused", () => {
  for (const name of [
    "",
    "a/b",
    "-x",
    ".hidden",
    "..",
    "a..b",
    "with space",
    "quote'd",
    "semi;colon",
    "star*",
    "back\\slash",
    "new\nline",
  ])
    expect(isWorkspaceName(name), name).toBe(false);
});

test("a repository's slot names it and still tells two of them apart", () => {
  const one = repositorySlot("/tmp/checkouts/werk");
  const two = repositorySlot("/home/someone/werk");
  expect(one).toMatch(/^werk-[0-9a-f]{8}$/);
  expect(two).toMatch(/^werk-[0-9a-f]{8}$/);
  expect(one).not.toBe(two);
});
test("the slot is stable for a path however it was spelled", () => {
  expect(repositorySlot("/tmp/checkouts/werk")).toBe(
    repositorySlot("/tmp/checkouts/./werk"),
  );
  expect(repositorySlot("/tmp/checkouts/werk")).toBe(
    repositorySlot("/tmp/checkouts/werk/"),
  );
});
test("a directory name that could not be a leaf is made into one", () => {
  expect(repositorySlot("/tmp/my project (old)")).toMatch(
    /^my-project--old--[0-9a-f]{8}$/,
  );
  expect(repositorySlot(path.parse(process.cwd()).root)).toMatch(
    /^repository-[0-9a-f]{8}$/,
  );
});
