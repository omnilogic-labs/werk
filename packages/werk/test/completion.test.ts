import { expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Argument, Command, Option } from "@commander-js/extra-typings";
import { buildProgram } from "../src/app.js";
import { buildComplete, buildCompletion } from "../src/commands/completion.js";
import { setChildArgv } from "../src/commands/shared.js";
import { hoistGlobalFlags, splitChildArgv } from "../src/runtime/argv.js";
import {
  BUDGET_MS,
  completionFor,
  labelCandidates,
  sessionCandidates,
} from "../src/completion/candidates.js";
import { Directive, renderReply } from "../src/completion/protocol.js";
import { completes } from "../src/completion/hooks.js";

const SCRIPTS = path.join(import.meta.dir, "../src/completion/scripts");

/**
 * The tree as werk really builds it. `attach` and the other three session
 * commands carry `sessionArgument()`, which already has the daemon-backed
 * provider hung on it, so what is under test is the real wiring rather than a
 * rehearsal of it.
 */
const tree = () => buildProgram([]);
const values = (reply: { candidates: readonly { value: string }[] }) =>
  reply.candidates.map((candidate) => candidate.value);

/** A directory that does not exist yet, so anything creating it is visible. */
async function scratch() {
  const base = await mkdtemp(path.join(tmpdir(), "werk-completion-"));
  return {
    base,
    runtimeDir: path.join(base, "runtime"),
    stateDir: path.join(base, "state"),
  };
}

/* ----------------------------------------------------------- wire format */

test("candidates are emitted one per line, then the directive", () => {
  expect(
    renderReply({
      candidates: [
        { value: "flappy-flippers", description: "running" },
        { value: "quiet-otter" },
      ],
      directive: Directive.NoFileComp,
    }),
  ).toBe("flappy-flippers\trunning\nquiet-otter\n:4\n");
});
test("an empty answer is still a directive", () => {
  expect(renderReply({ candidates: [], directive: Directive.NoFileComp })).toBe(
    ":4\n",
  );
});
test("a description is flattened to one line", () => {
  // A newline in a description would be read back as another candidate, and
  // commander descriptions wrap.
  expect(
    renderReply({
      candidates: [{ value: "x", description: "first line\nsecond\tthird" }],
      directive: 0,
    }),
  ).toBe("x\tfirst line second third\n:0\n");
});

/* --------------------------------------------------------------- hosts */

test("--host offers the hosts in force, and reaches nothing to do it", async () => {
  const ctx = {
    ...(await scratch()),
    hosts: {
      local: { kind: "local" as const },
      beast: { kind: "ssh" as const, sshHost: "beast" },
    },
  };
  const reply = await completionFor(tree(), ["list", "--host", ""], ctx);
  expect(values(reply).sort()).toEqual(["beast", "local"]);
  // How it is reached, so a list of names is readable without opening the file.
  expect(reply.candidates.find((c) => c.value === "beast")?.description).toBe(
    "ssh beast",
  );
  // The attached form is one word to the shell, so the flag comes back on the
  // front of every candidate.
  expect(
    values(await completionFor(tree(), ["list", "--host=be"], ctx)),
  ).toEqual(["--host=beast"]);
});

test("a completion that never read the layers offers no hosts rather than stale ones", async () => {
  // No `hosts` at all, which is what a `complete` that abandoned the config
  // layers under its 50 ms budget hands over.
  expect(
    values(
      await completionFor(tree(), ["list", "--host", ""], await scratch()),
    ),
  ).toEqual([]);
});

/* -------------------------------------------------------------- the tree */

test("the first word offers the commands werk has", async () => {
  const reply = await completionFor(tree(), [""], await scratch());
  expect(values(reply)).toContain("list");
  expect(values(reply)).toContain("daemon");
  expect(reply.directive).toBe(Directive.NoFileComp);
});
test("a partly typed command offers its aliases too", async () => {
  const reply = await completionFor(tree(), ["l"], await scratch());
  // `ls` is `list`'s alias and is offered beside it, not instead of it.
  expect(values(reply).sort()).toEqual(["land", "list", "logs", "ls"]);
});
test("a hidden command is parsed but not offered", async () => {
  // `complete` answers the shell rather than a person. Its prefix is shared
  // with three commands that are offered, so naming them is what makes this a
  // statement about `complete` being absent rather than about `c` matching
  // nothing.
  expect(
    values(await completionFor(tree(), ["c"], await scratch())).sort(),
  ).toEqual(["completion", "config", "create"]);
});
test("a positional that names a file lets the shell complete one", async () => {
  // `NoFileComp` is werk's usual answer and would be the wrong one here: a
  // path has no candidate list, and telling the shell not to fall back would
  // leave `werk edit <TAB>` offering nothing at all.
  const reply = await completionFor(tree(), ["edit", ""], await scratch());
  expect(values(reply)).toEqual([]);
  expect(reply.directive & Directive.NoFileComp).toBe(0);
  // A session positional is the other way round: it has its own candidates and
  // a filename is never one of them.
  expect(
    (await completionFor(tree(), ["attach", ""], await scratch())).directive &
      Directive.NoFileComp,
  ).toBe(Directive.NoFileComp);
});
test("a subcommand's own commands are offered under it", async () => {
  expect(
    values(await completionFor(tree(), ["daemon", ""], await scratch())),
  ).toContain("serve");
});
test("a dash offers flags, the command's own and werk's global ones", async () => {
  const reply = await completionFor(tree(), ["list", "--"], await scratch());
  expect(values(reply)).toContain("--state");
  expect(values(reply)).toContain("--json");
  expect(values(reply)).toContain("--runtime-dir");
});
test("a flag with choices completes its value", async () => {
  expect(
    values(
      await completionFor(tree(), ["list", "--state", "r"], await scratch()),
    ),
  ).toEqual(["running"]);
});
test("an attached flag value keeps the flag on the front", async () => {
  expect(
    values(await completionFor(tree(), ["list", "--state=r"], await scratch())),
  ).toEqual(["--state=running"]);
});
test("a path flag is left to the shell, which knows directories better", async () => {
  const reply = await completionFor(
    tree(),
    ["list", "--runtime-dir", ""],
    await scratch(),
  );
  expect(reply.candidates).toEqual([]);
  expect(reply.directive).toBe(Directive.FilterDirs);
});
test("half a word asks the shell not to add a space", async () => {
  const program = tree();
  program.addCommand(
    new Command("labelled").addOption(
      completes(new Option("--label <KEY=VALUE>", "label"), () => [
        { value: "role=" },
      ]),
    ),
  );
  const reply = await completionFor(
    program,
    ["labelled", "--label", ""],
    await scratch(),
  );
  expect(reply.directive & Directive.NoSpace).toBe(Directive.NoSpace);
});

/* --------------------------------------------------- the child's command */

test("nothing after a bare -- is completed", async () => {
  // Those words are the child program's argv. werk does not parse them, so it
  // has nothing to say about them either.
  for (const words of [
    ["create", "--", "clau"],
    ["create", "--", "claude", ""],
    ["create", "--", "claude", "--json"],
  ])
    expect(await completionFor(tree(), words, await scratch())).toEqual({
      candidates: [],
      directive: Directive.NoFileComp,
    });
});
test("a -- being typed is still werk's own flag prefix", async () => {
  // The shell sends a literal `--` as the word under the cursor for
  // `werk list --<TAB>`, which is a flag, not a separator.
  expect(
    values(await completionFor(tree(), ["list", "--"], await scratch())),
  ).toContain("--json");
});

/* ------------------------------------------------- the trailing empty word */

test("the trailing empty word says whether the command name is finished", async () => {
  const scratchDir = await scratch();
  // `werk attach<TAB>` — still typing the command name.
  expect(values(await completionFor(tree(), ["attach"], scratchDir))).toEqual([
    "attach",
  ]);
  // `werk attach <TAB>` — on to the session, which no daemon can name.
  expect(
    values(await completionFor(tree(), ["attach", ""], scratchDir)),
  ).toEqual([]);
});

/* ------------------------------------------------------------ no daemon */

test("with no daemon there are no candidates, quickly, and nothing is started", async () => {
  const scratchDir = await scratch();
  const started = Date.now();
  const reply = await completionFor(tree(), ["attach", "flap"], scratchDir);
  const elapsed = Date.now() - started;

  expect(reply).toEqual({ candidates: [], directive: Directive.NoFileComp });
  expect(elapsed).toBeLessThan(BUDGET_MS * 4);
  // A daemon that started would have made the runtime directory to put its
  // socket and endpoint record in, and the state directory for its lock.
  expect(existsSync(scratchDir.runtimeDir)).toBe(false);
  expect(existsSync(scratchDir.stateDir)).toBe(false);
  expect(await readdir(scratchDir.base)).toEqual([]);
});
test("the label provider is as quiet as the session one", async () => {
  const scratchDir = await scratch();
  expect(await labelCandidates("", scratchDir)).toEqual([]);
  expect(await sessionCandidates("", scratchDir)).toEqual([]);
  expect(existsSync(scratchDir.runtimeDir)).toBe(false);
});
test("completion cannot reach the daemon starter", async () => {
  // The invariant is a property of which function is imported, so it is asserted
  // where it can be broken rather than only where it shows.
  const source = await readFile(
    new URL("../src/completion/candidates.ts", import.meta.url),
    "utf8",
  );
  expect(source).toContain("connectExistingDaemon");
  expect(/\bconnectDaemon\b/.test(source)).toBe(false);
  expect(source).not.toContain("ensureSessionDaemon");
});

/* ------------------------------------------------------- the command itself */

/** `main.ts`'s pipeline, so the `--` and the global flags behave as they really do. */
async function runComplete(argv: string[]): Promise<string> {
  // `buildProgram` already registers the hidden `complete` command.
  const program = tree();
  const { own, child } = splitChildArgv(argv);
  setChildArgv(child);
  const { globals, rest } = hoistGlobalFlags(own);
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await program.parseAsync([...globals, ...rest], { from: "user" });
  } finally {
    process.stdout.write = write;
  }
  return chunks.join("");
}

test("werk complete answers on stdout in the protocol", async () => {
  const scratchDir = await scratch();
  const out = await runComplete([
    "complete",
    "--runtime-dir",
    scratchDir.runtimeDir,
    "--state-dir",
    scratchDir.stateDir,
    "--",
    "list",
    "--state",
    "ru",
  ]);
  expect(out).toBe("running\n:4\n");
});
test("werk complete says nothing about a child's command line", async () => {
  expect(
    await runComplete(["complete", "--", "create", "--", "claude", ""]),
  ).toBe(":4\n");
});
test("werk completion prints a script per shell", async () => {
  const program = new Command("werk").addCommand(buildCompletion());
  for (const shell of ["bash", "zsh", "fish"]) {
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await program.parseAsync(["completion", shell], { from: "user" });
    } finally {
      process.stdout.write = write;
    }
    expect(chunks.join("")).toContain("werk complete");
  }
});

/* ------------------------------------------------------------- the scripts */

test("the emitted scripts parse", async () => {
  const checks = [
    ["bash", ["bash", "-n", path.join(SCRIPTS, "bash.sh")]],
    ["zsh", ["zsh", "-n", path.join(SCRIPTS, "zsh.sh")]],
    ["fish", ["fish", "--no-execute", path.join(SCRIPTS, "fish.sh")]],
  ] as const;
  let checked = 0;
  for (const [shell, command] of checks) {
    if (!Bun.which(shell)) continue;
    checked++;
    const run = Bun.spawnSync(command as unknown as string[], {
      stderr: "pipe",
    });
    expect(`${shell}: ${run.stderr.toString()}`).toBe(`${shell}: `);
    expect(run.exitCode).toBe(0);
  }
  // bash is the one shell a CI runner can be relied on to have.
  expect(checked > 0 || Bun.which("bash") === null).toBe(true);
});

test("the bash script passes the typed words rather than evaluating them", async () => {
  if (!Bun.which("bash")) return;
  const dir = await mkdtemp(path.join(tmpdir(), "werk-bash-"));
  const record = path.join(dir, "argv");
  const pwned = path.join(dir, "pwned");
  // A stub `werk` that records what it was handed and answers one candidate.
  const stub = path.join(dir, "werk");
  await writeFile(
    stub,
    `#!/usr/bin/env bash\nprintf '[%s]\\n' "$@" > ${JSON.stringify(record)}\nprintf 'safe\\tok\\n:4\\n'\n`,
  );
  await chmod(stub, 0o755);

  const run = Bun.spawnSync(
    [
      "bash",
      "-c",
      `source ${JSON.stringify(path.join(SCRIPTS, "bash.sh"))}
       COMP_WORDS=(werk attach '$(touch ${pwned})')
       COMP_CWORD=2
       __werk_complete 2>/dev/null
       printf '%s\\n' "\${COMPREPLY[@]}"`,
    ],
    { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } },
  );

  expect(run.stdout.toString().trim()).toBe("safe");
  // The word reached werk intact and was never run.
  expect(await readFile(record, "utf8")).toBe(
    `[complete]\n[--]\n[attach]\n[$(touch ${pwned})]\n`,
  );
  expect(existsSync(pwned)).toBe(false);
});

test("the bash script sends the empty word the cursor sits on", async () => {
  if (!Bun.which("bash")) return;
  const dir = await mkdtemp(path.join(tmpdir(), "werk-bash-"));
  const record = path.join(dir, "argv");
  const stub = path.join(dir, "werk");
  await writeFile(
    stub,
    `#!/usr/bin/env bash\nprintf '[%s]\\n' "$@" > ${JSON.stringify(record)}\nprintf ':4\\n'\n`,
  );
  await chmod(stub, 0o755);
  Bun.spawnSync(
    [
      "bash",
      "-c",
      `source ${JSON.stringify(path.join(SCRIPTS, "bash.sh"))}
       COMP_WORDS=(werk attach)
       COMP_CWORD=2
       __werk_complete 2>/dev/null`,
    ],
    { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } },
  );
  // `werk attach <TAB>`: the empty last word is what says the name is finished.
  expect(await readFile(record, "utf8")).toBe(
    "[complete]\n[--]\n[attach]\n[]\n",
  );
});
