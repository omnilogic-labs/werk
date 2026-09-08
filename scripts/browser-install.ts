/**
 * Puts a browser on this machine so the browser lane can run locally.
 *
 * Two things go wrong on a host Playwright has no build for, and they need
 * different answers.
 *
 * It refuses outright, before downloading anything, naming the host rather than
 * the browser, so a newer browser never helps.
 * `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE` makes it fetch the build for a different
 * host instead. That build is linked against the borrowed release's libraries,
 * so it is a real risk rather than a free win, and it is reached only once
 * Playwright has actually said no.
 *
 * The install then does its work and does not exit. Observed here on
 * `ubuntu26.04-x64`: `ffmpeg` unpacked completely and the process sat idle at
 * 0% CPU until it was killed, and a chromium install held on past six hours.
 * So the exit code is not the answer to whether a browser arrived. The
 * executable on disk is, and that is what this checks, under a deadline.
 *
 * Nothing here hardcodes what this machine is. The host comes from Playwright's
 * own refusal and the candidates are older releases of that same distribution,
 * so a supported host never reaches any of it and this file stops mattering the
 * day Playwright learns the release.
 */
import { stat } from "node:fs/promises";
import path from "node:path";

/** Releases Playwright has published Linux builds for, newest first. */
export const KNOWN_RELEASES: Record<string, string[]> = {
  ubuntu: ["24.04", "22.04", "20.04"],
  debian: ["12", "11"],
};

export type Host = { distro: string; release: string; arch: string };

/**
 * Reads the host out of a refusal. Playwright writes it as `ubuntu26.04-x64`,
 * and on some paths without the architecture at all.
 */
export function hostFromRefusal(output: string): Host | null {
  const m = /does not support .* on ([a-z]+)([0-9.]+)(?:-(\S+))?/i.exec(output);
  if (!m) return null;
  return { distro: m[1].toLowerCase(), release: m[2], arch: m[3] ?? "x64" };
}

/** Compares release strings numerically, segment by segment. */
export function isOlder(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * The hosts worth borrowing a build from, nearest first. Only releases older
 * than the refused one qualify: a newer release is not one Playwright knows,
 * or the install would not have been refused in the first place.
 */
export function candidates(host: Host): string[] {
  const releases = KNOWN_RELEASES[host.distro] ?? [];
  return releases
    .filter((r) => isOlder(r, host.release))
    .map((r) => `${host.distro}${r}-${host.arch}`);
}

/**
 * `output` is stdout and stderr together. Playwright prints its refusal to
 * stdout, so reading only stderr sees an empty string and mistakes a refusal
 * for a failure of some other kind.
 */
type Run = { code: number; output: string };
type Spawn = (env: Record<string, string>) => Promise<Run>;

export type Outcome =
  | { kind: "installed"; override: null }
  | { kind: "installed"; override: string }
  | { kind: "refused"; host: Host | null; tried: string[]; output: string };

/**
 * Installs, falling back through the candidates. `spawn` is injected so the
 * decision can be tested without downloading a browser.
 */
export async function install(spawn: Spawn): Promise<Outcome> {
  const plain = await spawn({});
  if (plain.code === 0) return { kind: "installed", override: null };

  const host = hostFromRefusal(plain.output);
  if (!host)
    return { kind: "refused", host: null, tried: [], output: plain.output };

  const tried: string[] = [];
  for (const candidate of candidates(host)) {
    tried.push(candidate);
    const run = await spawn({ PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: candidate });
    if (run.code === 0) return { kind: "installed", override: candidate };
  }
  return { kind: "refused", host, tried, output: plain.output };
}

const BROWSERS = ["chromium", "chromium-headless-shell"];
const CWD = "examples/session-web";
const CACHE = path.join(process.env.HOME ?? "", ".cache", "ms-playwright");
const MINUTES = 60_000;

/**
 * The executables the browser lane launches. Playwright names the directory
 * after the browser and its revision, so a glob is what identifies one without
 * pinning the revision this repository happens to be on.
 */
const EXECUTABLES = [
  "chromium-*/chrome-linux64/chrome",
  "chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell",
];

/** Which of the expected executables are on disk and non-empty. */
export async function present(
  cache: string,
  globs: string[],
): Promise<string[]> {
  const found: string[] = [];
  for (const pattern of globs) {
    try {
      // `scan` throws rather than yielding nothing when the cache directory
      // does not exist, which is the ordinary first run.
      for await (const hit of new Bun.Glob(pattern).scan({
        cwd: cache,
        absolute: true,
      })) {
        const info = await stat(hit).catch(() => null);
        if (info?.isFile() && info.size > 0) {
          found.push(pattern);
          break;
        }
      }
    } catch {
      // Nothing to find is an answer, not a failure.
    }
  }
  return found;
}

async function main(): Promise<number> {
  const spawn: Spawn = async (env) => {
    const child = Bun.spawn(["bunx", "playwright", "install", ...BROWSERS], {
      cwd: CWD,
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    // The install can finish its work and never exit, so this waits on the
    // executables appearing as well as on the process, whichever comes first.
    const deadline = new Promise<void>((resolve) =>
      setTimeout(resolve, 20 * MINUTES),
    );
    const arrived = (async () => {
      while (true) {
        await new Promise((r) => setTimeout(r, 5000));
        if ((await present(CACHE, EXECUTABLES)).length === EXECUTABLES.length)
          return;
      }
    })();
    const exited = child.exited;
    await Promise.race([exited, arrived, deadline]);

    const [out, err] = await Promise.all([
      new Response(child.stdout).text().catch(() => ""),
      new Response(child.stderr).text().catch(() => ""),
    ]);
    if (out) process.stdout.write(out);
    if (err) process.stderr.write(err);

    const done =
      (await present(CACHE, EXECUTABLES)).length === EXECUTABLES.length;
    if (done) child.kill();
    return { code: done ? 0 : ((await exited) ?? 1), output: out + err };
  };

  const outcome = await install(spawn);
  if (outcome.kind === "installed") {
    if (outcome.override) {
      console.log(
        `\nPlaywright has no build for this host, so the browser came from ` +
          `${outcome.override}. Run the lane with ` +
          `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=${outcome.override} set if it refuses to launch.`,
      );
    }
    return 0;
  }

  if (!outcome.host) {
    console.error(
      "\nThe install failed for a reason this script does not recognise.",
    );
    return 1;
  }
  console.error(
    `\nPlaywright supports no build for ${outcome.host.distro}${outcome.host.release}` +
      `-${outcome.host.arch}, and none of ${outcome.tried.join(", ") || "its older releases"} ` +
      `worked either. The browser lane still runs on a runner: ` +
      `bun scripts/ci-run.ts browser --ref <your branch>.`,
  );
  return 1;
}

if (import.meta.main) process.exit(await main());
