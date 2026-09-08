import { describe, expect, test } from "bun:test";
import {
  LANES,
  UsageError,
  dispatchCommand,
  notPushedMessage,
  parseArgs,
  pushedState,
  remoteSha,
  usage,
} from "./ci-run.ts";

describe("parseArgs", () => {
  test("defaults to every lane, watching, and the current branch", () => {
    const options = parseArgs([]);
    expect(options).toEqual({
      lanes: "all",
      dryRun: false,
      watch: true,
      help: false,
    });
    expect(options.ref).toBeUndefined();
  });

  test("accepts each lane the workflow offers", () => {
    for (const lane of LANES) expect(parseArgs([lane]).lanes).toBe(lane);
    expect(usage).toContain("soak");
  });

  test("refuses a lane the workflow does not offer, and says which are valid", () => {
    expect(() => parseArgs(["bogus"])).toThrow(UsageError);
    try {
      parseArgs(["bogus"]);
    } catch (error) {
      for (const lane of LANES)
        expect((error as Error).message).toContain(lane);
    }
  });

  test("reads the flags", () => {
    const options = parseArgs([
      "soak",
      "--ref",
      "issue-14-ci-suite",
      "--soak-seconds",
      "600",
      "--dry-run",
      "--no-watch",
    ]);
    expect(options).toEqual({
      lanes: "soak",
      ref: "issue-14-ci-suite",
      soakSeconds: "600",
      dryRun: true,
      watch: false,
      help: false,
    });
  });

  test("refuses a flag with no value, an unknown flag and a second lane", () => {
    expect(() => parseArgs(["--ref"])).toThrow(UsageError);
    expect(() => parseArgs(["--ref", "--dry-run"])).toThrow(UsageError);
    expect(() => parseArgs(["--nope"])).toThrow(UsageError);
    expect(() => parseArgs(["linux", "macos"])).toThrow(UsageError);
  });
});

describe("dispatchCommand", () => {
  test("names the workflow, the ref and the lane", () => {
    expect(dispatchCommand(parseArgs(["linux"]), "issue-14-ci-suite")).toEqual([
      "gh",
      "workflow",
      "run",
      "session-libraries.yml",
      "--ref",
      "issue-14-ci-suite",
      "-f",
      "lanes=linux",
    ]);
  });

  test("carries soak_seconds only when it was asked for", () => {
    const withSeconds = dispatchCommand(
      parseArgs(["soak", "--soak-seconds", "600"]),
      "main",
    );
    expect(withSeconds).toContain("soak_seconds=600");
    expect(
      dispatchCommand(parseArgs(["soak"]), "main").join(" "),
    ).not.toContain("soak_seconds");
  });
});

describe("pushedState", () => {
  test("a branch origin does not have", () => {
    expect(pushedState("abc123", null)).toBe("absent");
    expect(pushedState("abc123", "")).toBe("absent");
    expect(notPushedMessage("absent", "issue-14-ci-suite")).toContain(
      "git push origin issue-14-ci-suite",
    );
  });

  test("a branch origin has at another commit", () => {
    expect(pushedState("abc123", "def456")).toBe("stale");
    expect(notPushedMessage("stale", "main")).toContain("git push origin main");
  });

  test("a branch origin has at this commit", () => {
    expect(pushedState("abc123", "abc123")).toBe("in-sync");
  });
});

describe("remoteSha", () => {
  test("reads the sha out of ls-remote output", () => {
    expect(remoteSha("abc123\trefs/heads/main\n")).toBe("abc123");
  });

  test("reports nothing for an empty answer", () => {
    expect(remoteSha("")).toBeNull();
    expect(remoteSha("\n  \n")).toBeNull();
  });
});
