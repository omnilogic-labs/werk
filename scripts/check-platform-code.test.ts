import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  EXCEPTIONS,
  PATTERNS,
  SEQUESTERED,
  audit,
  collectSourceFiles,
  isExempt,
  normalise,
  report,
  scanText,
  type SourceFile,
} from "./check-platform-code.ts";

const root = path.join(import.meta.dir, "..");
const files = await collectSourceFiles(root);
const result = audit(files);

/**
 * A line each pattern must catch and a line it must not. The scanner is text
 * matching rather than a parser, so this is what stops a regex quietly
 * becoming one that matches nothing while the tree still reports clean.
 */
const FIXTURES: Record<string, { matches: string; misses: string }> = {
  "process.platform": {
    matches: 'if (process.platform === "linux") return 1;',
    misses: "if (platform === thing) return 1;",
  },
  "process.getuid": {
    matches: "const me = process.getuid?.();",
    misses: "const me = getuid();",
  },
  "process.geteuid": {
    matches: "const me = process.geteuid!();",
    misses: "const me = geteuid();",
  },
  "os.platform": {
    matches: "const which = os.platform();",
    misses: "const which = macos.platformName;",
  },
  "path.win32/path.posix": {
    matches: "return path.win32.join(a, b);",
    misses: "return filepath.win32join(a, b);",
  },
  "process.env.USERNAME": {
    matches: "const who = process.env.USERNAME;",
    misses: "const who = process.env.USER;",
  },
  "platform literal": {
    matches: 'const target = "darwin";',
    misses: "const target = windows;",
  },
};

describe("the matchers", () => {
  test("every pattern has a fixture, so a new pattern cannot arrive untested", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(
      PATTERNS.map((p) => p.name).sort(),
    );
  });

  for (const pattern of PATTERNS)
    test(`${pattern.name} catches its line and leaves the other alone`, () => {
      const fixture = FIXTURES[pattern.name]!;
      expect(pattern.re.test(fixture.matches)).toBe(true);
      expect(pattern.re.test(fixture.misses)).toBe(false);
    });

  test("a flagged line carries the patterns that fired on it", () => {
    const found = scanText(
      "packages/session/src/made-up.ts",
      'const a = 1;\nif (process.platform === "win32") return;\n',
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.line).toBe(2);
    expect(found[0]!.patterns).toContain("process.platform");
    expect(found[0]!.patterns).toContain("platform literal");
  });
});

describe("the walk", () => {
  test("it read a real number of files, and known ones among them", () => {
    // A walk that silently matches nothing would otherwise report a clean
    // tree. This is the assertion that makes a broken walk loud instead,
    // including on a host whose path separator is not the one written here.
    expect(result.filesSeen).toBeGreaterThan(20);
    const seen = files.map((f) => f.path);
    expect(seen).toContain("packages/session-daemon/src/local.ts");
    expect(seen).toContain("scripts/check-platform-code.ts");
  });

  test("paths are compared with one separator whatever the host walked", () => {
    expect(normalise("packages\\session-daemon\\src\\local.ts")).toBe(
      "packages/session-daemon/src/local.ts",
    );
    expect(isExempt(`${SEQUESTERED}win32.ts`)).toBe(true);
    expect(isExempt("packages/session-daemon/test/local.test.ts")).toBe(true);
    expect(isExempt("packages/session-daemon/src/local.ts")).toBe(false);
  });

  test("the patterns that the codebase actually uses are still found", () => {
    // If one of these is ever renamed away, the scanner stops matching it and
    // this fails, rather than the tree going quiet and looking compliant.
    expect(result.patternsSeen).toContain("process.platform");
    expect(result.patternsSeen).toContain("process.getuid");
  });
});

describe("the declared surface", () => {
  test("every declared file exists and carries what it declares", () => {
    expect(result.missing).toEqual([]);
    expect(result.stale).toEqual([]);
  });

  test("every entry says why, and whether anyone means to keep it", () => {
    for (const entry of EXCEPTIONS) {
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      expect(["stays", "wants-moving"]).toContain(entry.disposition);
      expect(entry.allowed).toBeGreaterThan(0);
    }
  });

  test("the declared counts account for every branch outside the platform directory", () => {
    const declared = EXCEPTIONS.reduce((total, e) => total + e.allowed, 0);
    const found = [...result.perFile.values()].reduce((a, b) => a + b, 0);
    expect(declared).toBe(found);
  });

  test("the tree passes, and no file outside the surface branches on a platform", () => {
    expect(result.violations).toEqual([]);
  });
});

describe("failing", () => {
  const withExtra = (extra: SourceFile) =>
    audit([...files.map((f) => ({ ...f })), extra]);

  test("an undeclared file that branches is caught and named", () => {
    const bad = withExtra({
      path: "packages/session/src/invented.ts",
      text: "const p = process.platform;\n",
    });
    expect(bad.violations).toHaveLength(1);
    expect(bad.violations[0]!.path).toBe("packages/session/src/invented.ts");
    expect(report(bad)).toContain("packages/session/src/invented.ts");
  });

  test("a declared file that grows past its count is caught", () => {
    const target = EXCEPTIONS[0]!;
    const source = files.find((f) => normalise(f.path) === target.path)!;
    const bad = audit([
      ...files.filter((f) => normalise(f.path) !== target.path),
      {
        path: target.path,
        text: `${source.text}\nconst extra = os.platform();\n`,
      },
    ]);
    expect(bad.violations.length).toBeGreaterThan(0);
  });

  test("a declared file that loses a branch is caught as a stale count", () => {
    const target = EXCEPTIONS[0]!;
    const bad = audit([
      ...files.filter((f) => normalise(f.path) !== target.path),
      { path: target.path, text: "const nothing = 1;\n" },
    ]);
    expect(bad.stale.map((s) => s.path)).toContain(target.path);
    expect(report(bad)).toContain(target.path);
  });

  test("a declared file that has gone is caught", () => {
    const target = EXCEPTIONS[0]!;
    const bad = audit(files.filter((f) => normalise(f.path) !== target.path));
    expect(bad.missing).toContain(target.path);
  });

  test("the report names every violation it was given", () => {
    const bad = withExtra({
      path: "packages/session/src/invented.ts",
      text: "const p = process.platform;\n",
    });
    const text = report(bad);
    for (const violation of bad.violations)
      expect(text).toContain(`${violation.path}:${violation.line}`);
  });
});
