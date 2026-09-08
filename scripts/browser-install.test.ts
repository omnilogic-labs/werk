import { describe, expect, test } from "bun:test";
import {
  candidates,
  hostFromRefusal,
  install,
  isOlder,
} from "./browser-install.ts";

const REFUSAL =
  "Failed to install browsers\nError: ERROR: Playwright does not support chromium on ubuntu26.04-x64\n";

describe("hostFromRefusal", () => {
  test("reads the distribution, release and architecture", () => {
    expect(hostFromRefusal(REFUSAL)).toEqual({
      distro: "ubuntu",
      release: "26.04",
      arch: "x64",
    });
  });

  test("assumes x64 when the refusal names no architecture", () => {
    const host = hostFromRefusal(
      "Playwright does not support chromium on ubuntu24.04",
    );
    expect(host).toEqual({ distro: "ubuntu", release: "24.04", arch: "x64" });
  });

  test("keeps a non-x64 architecture", () => {
    const host = hostFromRefusal(
      "Playwright does not support chromium on ubuntu26.04-arm64",
    );
    expect(host?.arch).toBe("arm64");
  });

  test("is null for a failure that is not a refusal", () => {
    expect(hostFromRefusal("EACCES: permission denied")).toBeNull();
  });
});

describe("isOlder", () => {
  test("compares numerically, not as text", () => {
    // The string comparison this replaces puts "9" after "10".
    expect(isOlder("9", "10")).toBe(true);
    expect(isOlder("22.04", "26.04")).toBe(true);
    expect(isOlder("26.04", "22.04")).toBe(false);
  });

  test("a release is not older than itself", () => {
    expect(isOlder("24.04", "24.04")).toBe(false);
  });
});

describe("candidates", () => {
  test("offers older releases of the same distribution, nearest first", () => {
    expect(
      candidates({ distro: "ubuntu", release: "26.04", arch: "x64" }),
    ).toEqual(["ubuntu24.04-x64", "ubuntu22.04-x64", "ubuntu20.04-x64"]);
  });

  test("never offers a release newer than the one refused", () => {
    expect(
      candidates({ distro: "ubuntu", release: "21.04", arch: "x64" }),
    ).toEqual(["ubuntu20.04-x64"]);
  });

  test("carries the architecture through", () => {
    expect(
      candidates({ distro: "ubuntu", release: "26.04", arch: "arm64" })[0],
    ).toBe("ubuntu24.04-arm64");
  });

  test("is empty for a distribution nothing is known about", () => {
    expect(
      candidates({ distro: "fedora", release: "41", arch: "x64" }),
    ).toEqual([]);
  });
});

describe("install", () => {
  test("does not reach for an override when the plain install works", async () => {
    const seen: Record<string, string>[] = [];
    const outcome = await install(async (env) => {
      seen.push(env);
      return { code: 0, output: "" };
    });
    expect(outcome).toEqual({ kind: "installed", override: null });
    expect(seen).toEqual([{}]);
  });

  test("falls back to the nearest candidate that is accepted", async () => {
    const seen: (string | undefined)[] = [];
    const outcome = await install(async (env) => {
      const override = env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE;
      seen.push(override);
      return override === "ubuntu24.04-x64"
        ? { code: 0, output: "" }
        : { code: 1, output: REFUSAL };
    });
    expect(outcome).toEqual({ kind: "installed", override: "ubuntu24.04-x64" });
    expect(seen).toEqual([undefined, "ubuntu24.04-x64"]);
  });

  test("keeps going past a candidate that is also refused", async () => {
    const seen: (string | undefined)[] = [];
    const outcome = await install(async (env) => {
      const override = env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE;
      seen.push(override);
      return override === "ubuntu22.04-x64"
        ? { code: 0, output: "" }
        : { code: 1, output: REFUSAL };
    });
    expect(outcome).toEqual({ kind: "installed", override: "ubuntu22.04-x64" });
    expect(seen).toEqual([undefined, "ubuntu24.04-x64", "ubuntu22.04-x64"]);
  });

  test("reports what it tried when every candidate is refused", async () => {
    const outcome = await install(async () => ({ code: 1, output: REFUSAL }));
    expect(outcome).toEqual({
      kind: "refused",
      host: { distro: "ubuntu", release: "26.04", arch: "x64" },
      tried: ["ubuntu24.04-x64", "ubuntu22.04-x64", "ubuntu20.04-x64"],
      output: REFUSAL,
    });
  });

  test("does not retry a failure that is not a refusal", async () => {
    let calls = 0;
    const outcome = await install(async () => {
      calls++;
      return { code: 1, output: "ENOSPC: no space left on device" };
    });
    expect(calls).toBe(1);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.host).toBeNull();
  });
});

describe("present", () => {
  const cache = `${import.meta.dir}/../.claude/worktrees`;

  test("finds nothing in a directory that does not exist", async () => {
    const { present } = await import("./browser-install.ts");
    expect(
      await present("/nonexistent-cache-dir", ["chromium-*/chrome"]),
    ).toEqual([]);
  });

  test("matches a real executable through its revision glob", async () => {
    const { present } = await import("./browser-install.ts");
    const dir = `${cache}/../..`;
    // package.json is a real, non-empty file, so it stands in for a browser
    // binary without this test depending on one being installed.
    expect(await present(dir, ["package.json"])).toEqual(["package.json"]);
  });

  test("does not match a directory", async () => {
    const { present } = await import("./browser-install.ts");
    expect(await present(`${cache}/../..`, ["packages"])).toEqual([]);
  });
});
