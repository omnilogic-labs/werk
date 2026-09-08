/**
 * Holds the compatibility surface to two places: the implementations under
 * `packages/session-daemon/src/platform/`, and the list below.
 *
 * The list is the marker, and it is inverted on purpose. Nothing has to remember
 * to label a platform branch; a branch that nobody has declared is what fails.
 * Forgetting is the loud case rather than the silent one.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type Pattern = { name: string; re: RegExp };
export type Violation = {
  path: string;
  line: number;
  text: string;
  patterns: string[];
};
export type Exception = {
  path: string;
  allowed: number;
  reason: string;
  /** `stays` is a justified home for the branch. `wants-moving` is debt. */
  disposition: "stays" | "wants-moving";
};
export type SourceFile = { path: string; text: string };
export type Audit = {
  violations: Violation[];
  stale: { path: string; allowed: number; found: number }[];
  missing: string[];
  patternsSeen: Set<string>;
  filesSeen: number;
  perFile: Map<string, number>;
};

/** Every way the codebase currently has of asking which platform it is on. */
export const PATTERNS: Pattern[] = [
  { name: "process.platform", re: /process\.platform/ },
  { name: "process.getuid", re: /process\.getuid/ },
  { name: "process.geteuid", re: /process\.geteuid/ },
  { name: "os.platform", re: /\bos\.platform\s*\(/ },
  { name: "path.win32/path.posix", re: /\bpath\.(?:win32|posix)\b/ },
  { name: "process.env.USERNAME", re: /process\.env\.USERNAME/ },
  {
    name: "platform literal",
    re: /["'](?:win32|darwin|aix|freebsd|sunos)["']/,
  },
];

/** Directories that answer the question by being the answer. */
export const SEQUESTERED = "packages/session-daemon/src/platform/";

/**
 * Where the branching lives outside the platform directory, why, and whether
 * anyone means to keep it there. `allowed` is exact: a file that grows a branch
 * fails, and so does one that loses a branch without the count coming down.
 */
export const EXCEPTIONS: Exception[] = [
  {
    path: "packages/session-daemon/src/local.ts",
    allowed: 7,
    reason:
      "The runtime directory default takes its platform as a parameter and is exercised both ways. The mode-0700 and ownership rule, and the detached daemon's working directory, are each a single site on the daemon startup path.",
    disposition: "wants-moving",
  },
  {
    path: "packages/session-daemon/src/index.ts",
    allowed: 2,
    reason:
      "The owner principal reads a uid, and the loopback credential is decided once here so that everything downstream branches on the credential rather than on the platform.",
    disposition: "wants-moving",
  },
  {
    path: "packages/session-daemon/src/supervise.ts",
    allowed: 3,
    reason:
      "The runtime directory's owner is compared with the current uid, and SIGUSR1 is registered and removed only where the signal exists.",
    disposition: "wants-moving",
  },
  {
    path: "packages/session-daemon/src/diagnostics.ts",
    allowed: 4,
    reason:
      "Reports what a stat says rather than enforcing anything, so it describes a platform difference instead of deciding on one.",
    disposition: "stays",
  },
  {
    path: "packages/session-daemon/src/environment.ts",
    allowed: 2,
    reason:
      "Both are defaulted parameters, and the tests pass the Windows value explicitly on every platform.",
    disposition: "stays",
  },
  {
    path: "packages/werk/src/environment.ts",
    allowed: 1,
    reason: "A defaulted parameter, exercised both ways from the CLI tests.",
    disposition: "stays",
  },
  {
    path: "scripts/check-artefacts.ts",
    allowed: 2,
    reason:
      "Names the compiled binary, which carries an extension on Windows and none elsewhere.",
    disposition: "stays",
  },
  {
    path: "packages/workspace/src/local.ts",
    allowed: 1,
    reason:
      "`workspaceAt` reads a path on whichever machine holds it, so a host being given is what chooses the grammar. Not a branch on the machine the code is running on: it answers the same on every platform, which is what the test asserts.",
    disposition: "stays",
  },
  {
    path: "packages/workspace/src/ssh.ts",
    allowed: 3,
    reason:
      "Every path built here is on the far machine, which is posix whatever this one is. Unconditional rather than a branch, and using the host's separator would be the bug.",
    disposition: "stays",
  },
  {
    path: "scripts/session-soak.ts",
    allowed: 2,
    reason:
      "Counts open descriptors through /proc, which only Linux has, and records the platform in the report it prints.",
    disposition: "stays",
  },
];

const ROOTS = ["packages", "scripts", "examples"];

/** Compare paths one way whatever separator the host walked them with. */
export function normalise(file: string): string {
  return file.split(path.sep).join("/").replace(/\\/g, "/");
}

/**
 * Tests are not read today. Most of what they hold is `test.skipIf`, which is a
 * platform branch that exists so a test can decline to run, and nobody has
 * worked out what the rule for those should be.
 */
export function isExempt(file: string): boolean {
  const p = normalise(file);
  return (
    p.startsWith(SEQUESTERED) ||
    // This file names every pattern in order to look for it.
    p === "scripts/check-platform-code.ts" ||
    p === "scripts/check-platform-code.test.ts" ||
    p.includes("/test/") ||
    p.includes("/node_modules/") ||
    p.includes("/dist/")
  );
}

/** One entry per flagged line, carrying every pattern that fired on it. */
export function scanText(file: string, text: string): Violation[] {
  const found: Violation[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const patterns = PATTERNS.filter((p) => p.re.test(line)).map((p) => p.name);
    if (patterns.length)
      found.push({
        path: normalise(file),
        line: index + 1,
        text: line.trim(),
        patterns,
      });
  }
  return found;
}

export function audit(files: SourceFile[]): Audit {
  const allowance = new Map(EXCEPTIONS.map((e) => [e.path, e.allowed]));
  const patternsSeen = new Set<string>();
  const perFile = new Map<string, number>();
  const violations: Violation[] = [];
  const seenPaths = new Set<string>();
  for (const file of files) {
    const key = normalise(file.path);
    seenPaths.add(key);
    const hits = scanText(key, file.text);
    // Presence is counted everywhere, so a renamed API cannot make the
    // scanner quietly stop matching and still report a clean tree.
    if (!key.startsWith("scripts/check-platform-code"))
      for (const hit of hits)
        for (const name of hit.patterns) patternsSeen.add(name);
    if (isExempt(key)) continue;
    perFile.set(key, hits.length);
    const allowed = allowance.get(key);
    if (allowed === undefined) violations.push(...hits);
    else if (hits.length > allowed) violations.push(...hits.slice(allowed));
  }
  const stale = EXCEPTIONS.filter((e) => seenPaths.has(e.path))
    .map((e) => ({
      path: e.path,
      allowed: e.allowed,
      found: perFile.get(e.path) ?? 0,
    }))
    .filter((e) => e.found < e.allowed);
  const missing = EXCEPTIONS.map((e) => e.path).filter(
    (p) => !seenPaths.has(p),
  );
  return {
    violations,
    stale,
    missing,
    patternsSeen,
    filesSeen: files.length,
    perFile,
  };
}

export function report(result: Audit): string {
  const lines: string[] = [];
  for (const v of result.violations)
    lines.push(
      `${v.path}:${v.line} branches on the platform outside ${SEQUESTERED} (${v.patterns.join(", ")})\n    ${v.text}`,
    );
  for (const s of result.stale)
    lines.push(
      `${s.path} declares ${s.allowed} platform sites but has ${s.found}; lower the count in scripts/check-platform-code.ts`,
    );
  for (const m of result.missing)
    lines.push(`${m} is declared in EXCEPTIONS but was not found on disk`);
  if (!lines.length)
    return `The compatibility surface is ${SEQUESTERED} and ${EXCEPTIONS.length} declared files.`;
  return lines.join("\n");
}

export async function collectSourceFiles(root: string): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const key = normalise(path.relative(root, full));
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === ".git"
      )
        continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".ts"))
        files.push({ path: key, text: await readFile(full, "utf8") });
    }
  };
  for (const top of ROOTS) await walk(path.join(root, top));
  return files;
}

export async function main(root: string): Promise<number> {
  const result = audit(await collectSourceFiles(root));
  const text = report(result);
  const failed =
    result.violations.length + result.stale.length + result.missing.length > 0;
  console.log(text);
  return failed ? 1 : 0;
}

if (import.meta.main)
  process.exit(await main(path.join(import.meta.dir, "..")));
