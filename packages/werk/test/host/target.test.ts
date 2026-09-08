import { describe, expect, test } from "bun:test";
import {
  TARGETS,
  parseTargetOverride,
  targetFor,
} from "../../src/host/target.js";
import { HostError, type RemoteFacts } from "../../src/host/types.js";

const machine = (over: Partial<RemoteFacts> = {}): RemoteFacts => ({
  uname: "Linux",
  arch: "x86_64",
  libc: "glibc",
  home: "/home/mike",
  uid: 1000,
  rsync: false,
  loginPath: "/usr/bin",
  werk: "/home/mike/.local/share/werk/bin",
  ...over,
});

describe("the mapping", () => {
  const rows: [Partial<RemoteFacts>, string][] = [
    [{}, "bun-linux-x64"],
    [{ arch: "amd64" }, "bun-linux-x64"],
    [{ arch: "aarch64" }, "bun-linux-arm64"],
    [{ arch: "arm64" }, "bun-linux-arm64"],
    [{ libc: "musl" }, "bun-linux-x64-musl"],
    [{ arch: "aarch64", libc: "musl" }, "bun-linux-arm64-musl"],
  ];
  for (const [facts, expected] of rows)
    test(`${JSON.stringify(facts)} builds ${expected}`, () => {
      expect(targetFor("beast", machine(facts)).target).toBe(expected);
    });
});

test("a musl machine carries the caveat rather than being refused", () => {
  // bun builds musl targets, and the binary still wants libstdc++ and libgcc,
  // which a minimal Alpine image does not have. Plenty of musl machines do.
  const target = targetFor("beast", machine({ libc: "musl" }));
  expect(target.caveat).toContain("libstdc++");
  expect(targetFor("beast", machine()).caveat).toBeUndefined();
});

describe("what is refused, and why the message says so", () => {
  const refuses = (facts: Partial<RemoteFacts>, matching: RegExp) => {
    let raised: unknown;
    try {
      targetFor("beast", machine(facts));
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(HostError);
    expect((raised as HostError).code).toBe("HOST_UNSUPPORTED");
    expect((raised as HostError).message).toMatch(matching);
  };

  test("a Mac, with the signing reason attached", () => {
    // A cross-compiled Mach-O is unsigned and macOS kills it as it starts, so
    // shipping one would be shipping something that dies with no message.
    refuses({ uname: "Darwin", arch: "arm64" }, /unsigned/);
  });
  test("anything that is not Linux", () => {
    refuses({ uname: "FreeBSD" }, /only builds for Linux/);
    refuses({ uname: "SunOS" }, /only builds for Linux/);
  });
  test("an architecture nothing maps", () => {
    refuses({ arch: "riscv64" }, /riscv64/);
  });
  test("every refusal points at the override", () => {
    refuses({ arch: "riscv64" }, /which target to build/);
    refuses({ uname: "OpenBSD" }, /which target to build/);
  });
});

describe("the manual override", () => {
  test("wins over everything the machine said, Darwin included", () => {
    expect(
      targetFor("beast", machine({ uname: "Darwin" }), "bun-linux-arm64")
        .target,
    ).toBe("bun-linux-arm64");
  });
  test("takes bun's spelling or the obvious one", () => {
    expect(parseTargetOverride("beast", "linux-x64").target).toBe(
      "bun-linux-x64",
    );
    expect(parseTargetOverride("beast", "bun-linux-x64").target).toBe(
      "bun-linux-x64",
    );
  });
  test("keeps the caveat that goes with the target", () => {
    expect(parseTargetOverride("beast", "linux-x64-musl").caveat).toContain(
      "libstdc++",
    );
  });
  test("a target werk does not build is refused with the list", () => {
    let raised: HostError | undefined;
    try {
      parseTargetOverride("beast", "windows-x64");
    } catch (error) {
      raised = error as HostError;
    }
    expect(raised?.code).toBe("HOST_UNSUPPORTED");
    for (const name of Object.keys(TARGETS))
      expect(raised?.message).toContain(name);
  });
});
