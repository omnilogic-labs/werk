/**
 * Turning the `editor` setting into an argv.
 *
 * The property worth holding is that a value can never become syntax. A path
 * is a filename somebody else chose, and everything below is a way of asking
 * whether a space, a quote, a semicolon or a `$&` in one can add a word, close
 * a quote or start a second command. None of them can, because the words are
 * split before anything is substituted and the argv never meets a shell.
 */
import { expect, test } from "bun:test";
import { editorArgv, editorHost, splitCommand } from "../src/editor.js";
import { builtInDefaults, FIELDS } from "../src/config/schema.js";

test("a command splits into words, and quotes group one", () => {
  expect(splitCommand("code {path}")).toEqual(["code", "{path}"]);
  expect(splitCommand("  code   --wait  {path} ")).toEqual([
    "code",
    "--wait",
    "{path}",
  ]);
  // Either quote groups, and neither survives into the word.
  expect(splitCommand(`"/opt/My Editor/code" --wait '{path}'`)).toEqual([
    "/opt/My Editor/code",
    "--wait",
    "{path}",
  ]);
  // An empty pair of quotes is still a word.
  expect(splitCommand(`code "" {path}`)).toEqual(["code", "", "{path}"]);
  // No backslash escape, so a Windows path is spelled the way it is spelled.
  expect(splitCommand(String.raw`C:\Users\me\code.exe {path}`)).toEqual([
    String.raw`C:\Users\me\code.exe`,
    "{path}",
  ]);
  // An unclosed quote is a typo rather than a command.
  expect(splitCommand(`code "{path}`)).toBeUndefined();
  expect(splitCommand("   ")).toEqual([]);
});

test("a value fills in a word and can never add one", () => {
  const awkward = "/home/me/a file; rm -rf ~ 'quoted' \"double\" $& \\x";
  expect(
    editorArgv("code --wait {path}", { host: "beast", path: awkward }),
  ).toEqual(["code", "--wait", awkward]);
  // Substituted inside a larger word, it is still one word.
  expect(
    editorArgv("code --file={path}", { host: "beast", path: awkward }),
  ).toEqual(["code", `--file=${awkward}`]);
  // A value carrying a placeholder is not substituted a second time.
  expect(
    editorArgv("code {path}", { host: "beast", path: "/tmp/{host}" }),
  ).toEqual(["code", "/tmp/{host}"]);
  // A quoted placeholder is one word whether or not the value has spaces in it.
  expect(
    editorArgv(`sh -c 'exec code "$1"' _ "{path}"`, {
      host: "beast",
      path: "/tmp/a b",
    }),
  ).toEqual(["sh", "-c", 'exec code "$1"', "_", "/tmp/a b"]);
});

test("the default command names the host and the file, and nothing else", () => {
  // Read off the setting rather than restated here, so the two cannot drift.
  const argv = editorArgv(builtInDefaults().editor, {
    host: "beast",
    path: "/srv/work/a file.txt",
  });
  expect(argv).toEqual([
    "code",
    "--remote",
    "ssh-remote+beast",
    "/srv/work/a file.txt",
  ]);
});

test("{host} is the ssh destination, or this machine's own name", () => {
  expect(editorHost({ kind: "ssh", sshHost: "mike@10.0.0.7" })).toBe(
    "mike@10.0.0.7",
  );
  // A session on this machine has no destination, so the machine's own name
  // stands in and the command still forms a real remote authority.
  expect(editorHost({ kind: "local" }, "thisbox")).toBe("thisbox");
});

test("a command that could never open anything is refused when it is set", () => {
  const parse = FIELDS.editor.parse;
  expect(parse("code {path}")).toBe("code {path}");
  expect(parse(`"C:\\Program Files\\code.exe" {path}`)).toBeString();
  for (const bad of [
    // Nothing to run.
    "",
    "   ",
    // Nowhere for the file to go.
    "code --wait",
    // A typo, which would otherwise swallow the rest of the line.
    `code "{path}`,
    7,
    null,
  ])
    expect(() => parse(bad)).toThrow();
});
