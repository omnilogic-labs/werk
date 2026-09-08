/**
 * Nothing in the suite starts werk except `support/run.ts`.
 *
 * The rule exists because the failure it prevents is invisible where it is
 * made. A test that spawns the CLI without overriding the configuration
 * directory passes exactly as it would have done otherwise, and the damage is
 * to a file in somebody's home directory that no assertion here is ever going
 * to look at. It has happened once already: `WERK_CONFIG_DIR` was set in the
 * parent process, `Bun.spawn` did not inherit it, and three commands wrote to
 * the reader's own `~/.werk/config.toml`.
 *
 * So the check is on the shape of the source rather than on what a run does.
 * Two things are asserted, and between them a new spawn of the CLI has nowhere
 * to hide:
 *
 * 1. The paths of the entry module and the compiled binary appear in
 *    `support/run.ts` and nowhere else, so a test cannot name the CLI on its
 *    own.
 * 2. No call to a process spawner anywhere else in the suite mentions any of
 *    the names a werk would be spawned under.
 *
 * It reads the sources rather than the module graph, which is coarse: a test
 * could still reach the CLI through a variable this cannot see. What it catches
 * is the mistake somebody actually makes, which is writing the spawn out
 * longhand next to the assertion that needs it.
 */
import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const TESTS = import.meta.dir;
/** The one file allowed to know where werk is. */
const HELPER = join(TESTS, "support", "run.ts");

/** Every `.ts` file under the suite, helper and fixtures included. */
async function sources(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await sources(full)));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

/**
 * Comments out, so prose about `main.ts` is not mistaken for a call to it.
 * Strings survive, because a path being spawned is written as one.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * The slice of source a spawn call covers, found by balancing brackets from the
 * opening one. Crude, and it does not know about a bracket inside a string, but
 * a spawn whose argv holds an unbalanced bracket is not a thing anybody writes.
 */
function callsTo(text: string, name: RegExp): string[] {
  const calls: string[] = [];
  for (const match of text.matchAll(name)) {
    const open = text.indexOf("(", match.index + match[0].length - 1);
    if (open === -1) continue;
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      const c = text[i];
      if (c === "(" || c === "[" || c === "{") depth += 1;
      else if (c === ")" || c === "]" || c === "}") {
        depth -= 1;
        if (depth === 0) {
          calls.push(text.slice(open, i + 1));
          break;
        }
      }
    }
  }
  return calls;
}

const SPAWNERS =
  /\b(?:Bun\.spawn(?:Sync)?|execFileSync?|execFile|spawnSync|spawn)\s*\(/g;
/** Anything a werk would be spawned under, however the call spells it. */
const NAMES = /\bMAIN\b|\bbinary\b|main\.ts|dist[/\\"',\s]+werk/;

/**
 * A path that reaches this package's own entry or its own binary. Written
 * relatively rather than as any `src/main.ts`, because a fake `entry` handed to
 * a scripted runner is a string about a machine that does not exist and has
 * nothing to do with starting anything.
 */
const OUR_CLI = /\.\.[/\\]src[/\\]main\.ts|dist[/\\]werk|"dist",\s*"werk"/;

test("only the helper knows where the CLI is", async () => {
  const named: string[] = [];
  for (const file of await sources(TESTS)) {
    if (file === HELPER) continue;
    const text = code(await readFile(file, "utf8"));
    if (OUR_CLI.test(text)) named.push(relative(TESTS, file));
  }
  expect(named).toEqual([]);
});

test("no test file outside the helper hands the CLI to a spawner", async () => {
  const offenders: { file: string; call: string }[] = [];
  for (const file of await sources(TESTS)) {
    if (file === HELPER) continue;
    const text = code(await readFile(file, "utf8"));
    for (const call of callsTo(text, SPAWNERS))
      if (NAMES.test(call))
        offenders.push({
          file: relative(TESTS, file),
          call: call.slice(0, 200),
        });
  }
  expect(offenders).toEqual([]);
});

test("the helper is what the rule is about, so it is checked too", async () => {
  const text = await readFile(HELPER, "utf8");
  // The three variables every child gets, and the mode the runtime directory
  // has to have. A helper that stopped setting one of them would leave every
  // file that trusts it exposed, and no other test would notice.
  for (const marker of [
    "WERK_CONFIG_DIR",
    "WERK_RUNTIME_DIR",
    "WERK_STATE_DIR",
    "0o700",
  ])
    expect(text).toContain(marker);
  // The sandbox root is short on purpose: a Unix socket path is capped at 103
  // bytes and the daemon binds one inside the runtime directory.
  expect(text).toContain("mkdtemp(`/tmp/${tag}-`)");
});
