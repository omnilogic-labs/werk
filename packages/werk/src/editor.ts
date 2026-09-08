/**
 * The command an attached client runs when a session asks for a file to be
 * opened, and how the configured string becomes an argv.
 *
 * ## The words are split before anything is substituted
 *
 * A path is untrusted text: it can hold a space, a quote, a newline or a
 * semicolon, all of which are legal in a filename. So the configured command
 * is split into words first, and the placeholders are filled in afterwards,
 * inside the words the split produced. A value can therefore never add a word,
 * end a quote or start a second command, whatever is in it, and the argv is
 * handed to the operating system rather than to a shell — there is no shell
 * anywhere on this path to be injected into.
 *
 * The consequence is that the setting is a command line and not a shell
 * fragment. `code {path} && echo done` runs `code` with three more arguments
 * rather than running two programs, and someone who wants a shell asks for one
 * by name: `sh -c '...' _ {path}`, where the path still arrives as one word.
 *
 * ## The splitting rules
 *
 * Whitespace separates words. Single and double quotes group one, and inside
 * either every other character is literal. There is no backslash escape, which
 * is what lets a Windows path be written as it is spelled: `C:\Users\me\code`
 * is one word, and `"C:\Program Files\Microsoft VS Code\code.exe"` is one word
 * with the space in it.
 */
import os from "node:os";
import type { Host } from "./config/hosts.js";

const PLACEHOLDERS = ["host", "path"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];
const PLACEHOLDER = /\{(host|path)\}/g;

/**
 * Split a configured command into words, or `undefined` when a quote is left
 * open, which is a typo rather than a command.
 */
export function splitCommand(command: string): string[] | undefined {
  const words: string[] = [];
  let word: string | undefined;
  let quote: '"' | "'" | undefined;
  for (const character of command) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else word = (word ?? "") + character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      // An empty pair of quotes is still a word: `-c ""` passes an empty one.
      word ??= "";
      continue;
    }
    if (/\s/.test(character)) {
      if (word !== undefined) words.push(word);
      word = undefined;
      continue;
    }
    word = (word ?? "") + character;
  }
  if (quote !== undefined) return undefined;
  if (word !== undefined) words.push(word);
  return words;
}

/**
 * The argv to run, from the configured command and what the placeholders stand
 * for.
 *
 * The replacement is a function rather than a string, so nothing in a value —
 * `$&` and `$1` included — is read back as syntax by the replacer itself.
 */
export function editorArgv(
  command: string,
  values: Record<Placeholder, string>,
): string[] {
  const words = splitCommand(command);
  if (!words?.length)
    throw new Error(`${command} is not a command werk can run`);
  return words.map((word) =>
    word.replace(PLACEHOLDER, (_, name: Placeholder) => values[name]),
  );
}

/**
 * What `{host}` stands for.
 *
 * For a machine reached over ssh it is the ssh destination, spelled as it
 * would be typed after `ssh`. That is what an editor's remote authority wants,
 * and werk has it written down already.
 *
 * A session on the machine the person is sitting at has no destination, so
 * this answers that machine's own hostname. It names the same machine, and it
 * is what somebody would type after `ssh` to reach it from anywhere else, so
 * the default command still forms a real remote authority rather than an empty
 * one. It does mean the editor is asked to reach this machine the long way
 * round, which works where sshd is listening and is a strange thing to want:
 * somebody whose sessions are mostly on this machine should set `editor` to
 * something with no `{host}` in it, such as `code {path}`.
 */
export function editorHost(host: Host, hostname = os.hostname()): string {
  return host.kind === "ssh" ? host.sshHost : hostname;
}
