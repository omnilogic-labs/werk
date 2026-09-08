/**
 * A `file://` URL's `pathname` is not a filesystem path. On Windows the URL
 * keeps a slash in front of the drive letter, so `D:\a\werk` reads back as
 * `/D:/a/werk`, which nothing on that platform can open. A path next to a
 * module comes from `import.meta.dir`, or from `fileURLToPath`.
 *
 * This runs under `bun test scripts`, which every leg of the native matrix
 * runs, so the Windows leg grades it too.
 */
import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const skippedDirectories = new Set([
  ".git",
  "node_modules",
  "dist",
  "werk-poc",
]);
const self = join(import.meta.dir, "paths.test.ts");

/**
 * A directory with its own `.git` is another checkout, not this one: the
 * worktrees the agents keep under `.claude/worktrees/` hold their own copies of
 * every source, at whatever commit they branched from.
 */
async function sources(directory: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  if (directory !== root && entries.some((entry) => entry.name === ".git")) {
    return found;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (skippedDirectories.has(entry.name)) continue;
      found.push(...(await sources(full)));
      continue;
    }
    if (entry.name.endsWith(".ts") && full !== self) found.push(full);
  }
  return found;
}

const forbidden = [
  /import\.meta\.url\s*\)\s*\.pathname/,
  /import\.meta\.resolve\s*\([^)]*\)\s*\.pathname/,
  /pathToFileURL\s*\([^)]*\)\s*\.pathname/,
];

/** The text with runs of whitespace collapsed, and where each byte came from. */
function flatten(text: string): { flat: string; origins: number[] } {
  let flat = "";
  const origins: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (/\s/.test(text[i]!)) {
      if (flat.endsWith(" ")) continue;
      flat += " ";
    } else flat += text[i];
    origins.push(i);
  }
  return { flat, origins };
}

test("no source turns a file:// URL into a path through .pathname", async () => {
  const offences: string[] = [];
  for (const file of await sources(root)) {
    const text = await readFile(file, "utf8");
    if (!text.includes(".pathname")) continue;
    const { flat, origins } = flatten(text);
    for (const pattern of forbidden) {
      const match = pattern.exec(flat);
      if (!match) continue;
      const line = text
        .slice(0, origins[match.index])
        .split("\n")
        .length.toString();
      offences.push(`${relative(root, file)}:${line}`);
    }
  }
  expect(offences).toEqual([]);
});
