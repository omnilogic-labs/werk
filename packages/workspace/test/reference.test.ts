import { expect, test } from "bun:test";
import path from "node:path";
import {
  fitWorkspaceReference,
  formatWorkspaceReference,
  isWorkspaceName,
  localWorkspaceAt,
  workspaceReference,
  WORKSPACE_REFERENCE_LEVELS,
  type WorkspaceReference,
} from "../src/index.js";
import { repositorySlot } from "../src/local.js";

const local: WorkspaceReference = {
  name: "fix-login",
  directory: "/state/werk/workspaces/werk-1a2b3c4d/fix-login",
};
const remote: WorkspaceReference = { ...local, host: "somehost" };

test("one notation, written at three levels of verbosity", () => {
  expect(formatWorkspaceReference(local, "name")).toBe("fix-login");
  expect(formatWorkspaceReference(local, "path")).toBe(
    "fix-login:/state/werk/workspaces/werk-1a2b3c4d/fix-login",
  );
  expect(formatWorkspaceReference(remote, "full")).toBe(
    "fix-login@somehost:/state/werk/workspaces/werk-1a2b3c4d/fix-login",
  );
  // With no host there is nothing for the widest level to add, so it is the
  // same string. Nothing stands in for the absent host.
  expect(formatWorkspaceReference(local, "full")).toBe(
    formatWorkspaceReference(local, "path"),
  );
  // Every level names the workspace, which is what makes it one notation
  // rather than three.
  for (const level of WORKSPACE_REFERENCE_LEVELS)
    expect(formatWorkspaceReference(local, level)).toStartWith(local.name);
});

test("the grammar stays readable back to front", () => {
  // The name carries no `@`, `:` or `/`, so the first `:` ends the prefix.
  const full = formatWorkspaceReference(remote, "full");
  expect(full.slice(0, full.indexOf(":"))).toBe(`${remote.name}@somehost`);
  // A Windows path survives, because the drive's colon is never the first one.
  const windows = formatWorkspaceReference(
    { name: "demo", directory: "C:\\checkouts\\demo" },
    "path",
  );
  expect(windows).toBe("demo:C:\\checkouts\\demo");
  expect(windows.slice(0, windows.indexOf(":"))).toBe("demo");
});

test("the widest level that fits is what a caller with a budget gets", () => {
  const full = formatWorkspaceReference(local, "path");
  expect(fitWorkspaceReference(local, full.length)).toBe(full);
  // One column short of the path, and the path is what is given up.
  expect(fitWorkspaceReference(local, full.length - 1)).toBe(local.name);
  expect(fitWorkspaceReference(local, local.name.length)).toBe(local.name);
  // One column short of the name, and there is nothing left to show.
  expect(fitWorkspaceReference(local, local.name.length - 1)).toBeUndefined();
  // The host is the first thing given up, before the path.
  const widest = formatWorkspaceReference(remote, "full");
  expect(fitWorkspaceReference(remote, widest.length - 1)).toBe(
    formatWorkspaceReference(remote, "path"),
  );
});

test("a reference carries a host only when the workspace has one", () => {
  expect(workspaceReference(local)).toEqual(local);
  expect(workspaceReference(local).host).toBeUndefined();
  expect(workspaceReference(remote).host).toBe("somehost");
});

test("the workspace a directory is, when this host's layout put it there", () => {
  const root = path.resolve("/state/werk/workspaces");
  const slot = repositorySlot("/home/someone/werk");
  const directory = path.join(root, slot, "fix-login");
  expect(localWorkspaceAt(root, directory)).toEqual({
    name: "fix-login",
    directory,
  });
  // A slot with no workspace under it is not a workspace.
  expect(localWorkspaceAt(root, path.join(root, slot))).toBeUndefined();
  // Nor is somewhere further down inside one.
  expect(
    localWorkspaceAt(root, path.join(directory, "packages", "werk")),
  ).toBeUndefined();
  // Nor is anywhere outside the root at all.
  expect(localWorkspaceAt(root, "/home/someone/werk")).toBeUndefined();
  expect(localWorkspaceAt(root, root)).toBeUndefined();
  // A leaf that is not a legal workspace name did not come from here. The
  // leaves are read against `isWorkspaceName` rather than assumed illegal, and
  // each one is checked to still sit directly under the slot, so the call
  // reaches the name check instead of normalising to a path an earlier guard
  // turns away.
  for (const leaf of ["-bad", "has space", "a:b", "we..ird"]) {
    expect(isWorkspaceName(leaf)).toBe(false);
    const illegal = path.join(root, slot, leaf);
    expect(path.dirname(illegal)).toBe(path.join(root, slot));
    expect(localWorkspaceAt(root, illegal)).toBeUndefined();
  }
});

test("the reference recovered from a directory is the one the notation writes", () => {
  const root = path.resolve("/state/werk/workspaces");
  const directory = path.join(
    root,
    repositorySlot("/home/someone/werk"),
    "fix-login",
  );
  const recovered = localWorkspaceAt(root, directory)!;
  expect(formatWorkspaceReference(recovered, "path")).toBe(
    `fix-login:${directory}`,
  );
});
