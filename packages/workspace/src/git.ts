/**
 * Running git, as one injectable function.
 *
 * Everything this package does to a repository goes through a `GitRunner`, so
 * the interesting half — which failure a given exit maps to — can be tested
 * without a repository on disk. The default runs the `git` on `PATH` through
 * `node:child_process`, which is what the CLI's configuration loader already
 * does for `git rev-parse --show-toplevel`; nothing here needs the Bun runtime,
 * so nothing here asks for it.
 */
import { execFile } from "node:child_process";

export interface GitResult {
  /** Non-zero for every way git can refuse. */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
/**
 * Resolves for a git that ran, whatever it decided. It rejects only when git
 * could not be run at all, which the caller reads as `GIT_MISSING`.
 */
export type GitRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<GitResult>;

/** True when a spawn failure means there is no `git` to run, rather than that git ran and refused. */
export function isMissingExecutable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "ENOTDIR";
}

/**
 * `execFile` rejects on a non-zero exit as readily as on a failed spawn, and
 * this package needs to tell those apart: git refusing is information, git
 * being absent is a different failure with a different message. The rejection
 * carries the exit code when there was one, so a refusal is turned back into a
 * resolved result and only a genuine spawn failure is rethrown.
 */
export const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({
          exitCode: error ? (error.code as number) : 0,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        });
      },
    );
  });
