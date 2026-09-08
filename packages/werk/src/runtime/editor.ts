/**
 * Showing somebody a commit message before it is used.
 *
 * [Landing](../../../../docs/product/landing.md) has generating the message and
 * then opening the editor on it as a reasonable default: close the editor to
 * accept it, edit it first if it is wrong. That is what this does, and it is
 * the same gesture `git commit` already is, so the editor it opens is the one
 * git would have opened — `GIT_EDITOR`, `core.editor`, `VISUAL`, `EDITOR`, in
 * git's own order of precedence, which `git var GIT_EDITOR` answers in one call
 * rather than being reimplemented here and drifting.
 *
 * The comment lines are git's convention too. A line starting with `#` is
 * stripped, which is what makes the instructions at the bottom of the buffer
 * possible, and an empty result means the caller changed their mind — again the
 * same rule `git commit` follows.
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** What git would open, or undefined when git will not say. */
export function gitEditor(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["var", "GIT_EDITOR"],
      { cwd, encoding: "utf8" },
      (error, stdout) => {
        const said = error ? "" : stdout.toString().trim();
        resolve(said === "" ? undefined : said);
      },
    );
  });
}

/**
 * git's cleanup, in the `default` mode `git commit` uses for an edited message:
 * comment lines go, trailing whitespace goes, and runs of blank lines collapse.
 */
export function cleanMessage(raw: string): string {
  const kept = raw
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .map((line) => line.trimEnd());
  const body: string[] = [];
  for (const line of kept)
    if (line !== "" || body.at(-1) !== "") body.push(line);
  while (body.at(-1) === "") body.pop();
  while (body[0] === "") body.shift();
  return body.join("\n");
}

export interface EditResult {
  /** The message after the editor and git's cleanup. Empty means abandoned. */
  readonly message: string;
  /** Why nothing was opened, when nothing was. The draft comes back unchanged. */
  readonly problem?: string;
}

/**
 * Open the caller's editor on `draft` and hand back what they left.
 *
 * The editor gets werk's own terminal, because that is the only way a
 * full-screen one works at all. Anything that stops it opening — no editor, a
 * shell that will not run it — comes back as a problem alongside the untouched
 * draft, so a landing degrades to "use what was drafted" rather than failing.
 */
export async function editMessage(
  draft: string,
  cwd: string,
): Promise<EditResult> {
  const editor = await gitEditor(cwd);
  if (editor === undefined)
    return { message: cleanMessage(draft), problem: "git names no editor" };
  const directory = await mkdtemp(path.join(os.tmpdir(), "werk-land-"));
  const file = path.join(directory, "LANDMSG");
  try {
    await writeFile(file, draft.endsWith("\n") ? draft : `${draft}\n`, "utf8");
    const opened = await run(editor, file, cwd);
    if (opened !== undefined)
      return { message: cleanMessage(draft), problem: opened };
    return { message: cleanMessage(await readFile(file, "utf8")) };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * `git var GIT_EDITOR` answers a shell command, not a program: `code --wait`
 * and `emacsclient -t` are both ordinary answers, and so is anything with a
 * quoted path in it. So it is handed to a shell, exactly as git hands it to
 * one, with the file appended as an argument.
 *
 * Answers undefined when the editor ran and exited 0, and a sentence otherwise.
 */
function run(
  editor: string,
  file: string,
  cwd: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(
      process.platform === "win32" ? "cmd" : "sh",
      process.platform === "win32"
        ? ["/c", `${editor} "${file}"`]
        : ["-c", `${editor} "$1"`, "sh", file],
      { cwd, stdio: "inherit" },
    );
    child.on("error", (error) =>
      resolve(`the editor did not run: ${error.message}`),
    );
    child.on("close", (code) =>
      resolve(
        code === 0 ? undefined : `the editor exited ${code ?? "on a signal"}`,
      ),
    );
  });
}
