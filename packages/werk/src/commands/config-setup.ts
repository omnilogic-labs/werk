/**
 * The wizard: a conversation that ends in a `[hosts.<name>]` block.
 *
 * A host is the one part of werk's configuration a person cannot reasonably
 * guess their way to. The settings all have defaults underneath them and a
 * wrong one costs a preference; a host has nothing underneath it, and the file
 * it goes in is one most people have never opened. So this asks.
 *
 * It also runs from flags alone, with no terminal, which is what makes it
 * usable from a dotfiles script. The two paths are the same code: a flag
 * answers a question that would otherwise be asked. Where neither a flag nor a
 * terminal can answer, the command refuses and writes nothing, because a wizard
 * that guesses at which machine somebody meant is worse than one that stops.
 *
 * Every question goes through the wrappers in `runtime/interactive.ts`, which
 * carry the deadline and turn clack's cancel sentinel into an error. Nothing
 * here imports clack, and `test/config-setup.test.ts` asserts that no command
 * does.
 *
 * What it writes is deliberately small. A host block holds what the machine is
 * called and where werk may put things. Everything else werk asks the machine
 * at the moment it needs to know, which is why the probe's findings are shown
 * and then thrown away: `claude` being on a login shell's PATH today is a fact
 * about today.
 */
import { existsSync } from "node:fs";
import type { Command } from "@commander-js/extra-typings";
import { defineCommand } from "./define.js";
import { withContext } from "./shared.js";
import { result, type Result } from "../runtime/output.js";
import { CancelledError, UsageError } from "../runtime/exit.js";
import {
  autocomplete,
  canPrompt,
  confirm,
  intro,
  note,
  outro,
  select,
  spinner,
  text,
  type Choice,
  type PromptOptions,
} from "../runtime/interactive.js";
import type { WerkContext } from "../runtime/context.js";
import {
  configPaths,
  loadWerkConfig,
  type MergedConfig,
} from "../config/load.js";
import { isHostName, type Host } from "../config/hosts.js";
import type { ConfigKey, ConfigValue } from "../config/schema.js";
import { applyEdit, type ConfigEdit } from "../config/toml-edit.js";
import {
  editProjectConfig,
  editUserConfig,
  type WriteReport,
} from "../config/write.js";
import { readSshAliases, type SshAliasReading } from "../config/ssh-config.js";
import {
  noProbe,
  probeFor,
  probeHost,
  PROBE_BUDGET_MS,
  type HostProbe,
  type ProbeReport,
} from "../hosts/probe.js";

/* --------------------------------------------------------------- the report */

/** One host the run changed, and what it did to it. */
export interface HostChange {
  readonly name: string;
  readonly action: "added" | "changed" | "removed";
  /** The block as written, or null when it was removed. */
  readonly host: Host | null;
}
/** One setting the run changed, so a reader can see it happened. */
export interface SettingChange {
  readonly key: ConfigKey;
  readonly from: ConfigValue | null;
  readonly to: ConfigValue | null;
}
export interface SetupReport {
  /** The file that was written, or would have been. */
  readonly file: string;
  readonly created: boolean;
  readonly hosts: readonly HostChange[];
  readonly settings: readonly SettingChange[];
  /** What the machine said about itself, or null when nothing asked it. */
  readonly probe: ProbeReport | null;
  /** True when the run ended without writing anything. */
  readonly unchanged: boolean;
}

/* ------------------------------------------------------------- the command */

/** What a test replaces so the wizard runs without ssh, a machine or a file. */
export interface SetupDeps {
  /** The machines the person already has written down. */
  aliases?(): Promise<SshAliasReading>;
  /** How to reach a host of a given kind. */
  probe?(kind: "local" | "ssh"): HostProbe;
  /** Where the answers end up. */
  write?(edit: ConfigEdit, project: boolean): Promise<WriteReport>;
  /** Everything werk currently thinks it has been told. */
  load?(): Promise<MergedConfig>;
  /** The streams the questions are asked on; the real ones by default. */
  prompt?: PromptOptions;
}

interface SetupFlags {
  host?: string;
  ssh?: string;
  workspaceRoot?: string;
  default?: boolean;
  project?: boolean;
}

export function buildConfigSetup(): Command {
  const setup = defineCommand({
    name: "setup",
    summary: "Add a machine werk can put work on, by asking about it",
    description:
      "Walks through adding a host: which machine, what to call it, and " +
      "where workspaces go on it. It looks at your ssh config for the " +
      "machines you already reach, asks the one you pick about itself, shows " +
      "you the exact TOML it would add, and only then writes it. Re-running " +
      "it offers to change, remove or re-point what is already there. Pass " +
      "--host and --ssh to answer everything up front, which is how a " +
      "dotfiles script uses it; without a terminal to ask in, that is the " +
      "only form it accepts.",
    examples: [
      { run: "werk config setup", note: "answer the questions" },
      {
        run: "werk config setup --host beast --ssh beast --default --yes",
        note: "no questions; for a script",
      },
      {
        run: "werk config setup --project",
        note: "write the repository's file instead of your own",
      },
    ],
  });
  setup.option("--host <name>", "what to call the machine");
  setup.option(
    "--ssh <destination>",
    "the ssh destination, as typed after ssh",
  );
  setup.option("--workspace-root <path>", "where workspaces go on it");
  setup.option("--default", "make it the host werk uses when nobody names one");
  setup.option("--project", "write the repository's file rather than your own");
  setup.action(
    withContext(async (ctx, opts: SetupFlags) => runSetup(ctx, opts, {})),
  );
  return setup;
}

/* ---------------------------------------------------------------- the flow */

/**
 * One conversation: who is being asked, on which streams, and whether there is
 * anybody there at all. Carried as one object because every screen needs all
 * three, and threading three parameters through nine functions is how one of
 * them ends up talking to the wrong stream.
 */
interface Talk {
  readonly ctx: WerkContext;
  readonly on: PromptOptions;
  readonly talking: boolean;
}

/** The last row of the machine list, for a destination that is not in the file. */
const OTHER = " other";

export async function runSetup(
  ctx: WerkContext,
  flags: SetupFlags,
  deps: SetupDeps,
): Promise<Result<SetupReport>> {
  const project = flags.project === true;
  const paths = configPaths({});
  if (project && paths.project === undefined)
    throw new UsageError(
      "there is no repository here, so there is no project config file; run " +
        "this without --project to write your own",
    );
  const file = project ? paths.project! : paths.user;

  // The flags fully describe a host when they say both which machine and what
  // to call it. Anything less needs somebody to ask.
  const described = flags.host !== undefined && flags.ssh !== undefined;
  if (!canPrompt(ctx) && !described)
    throw new UsageError(
      "config setup asks questions; pass --host and --ssh, or run it in a " +
        "terminal",
    );

  const talk: Talk = {
    ctx,
    on: deps.prompt ?? {},
    talking: canPrompt(ctx),
  };
  const merged = await (deps.load ?? (() => loadWerkConfig({})))();
  const configured = Object.entries(merged.hosts)
    .filter(([, host]) => host.kind !== "local")
    .map(([name]) => name)
    .sort();

  if (talk.talking) {
    intro("werk config setup", talk.on);
    note(
      `${file}\n${existsSync(file) ? "exists; werk will edit it" : "does not exist yet; werk will create it"}`,
      "the file",
      talk.on,
    );
  }

  const action = await chooseAction(talk, configured, described);
  if (action === "quit") {
    if (talk.talking) outro("Nothing was changed.", talk.on);
    return setupResult({
      file,
      created: false,
      hosts: [],
      settings: [],
      probe: null,
      unchanged: true,
    });
  }
  if (action === "default")
    return await repoint(talk, merged, configured, file, project, deps);
  if (action === "remove")
    return await forget(talk, merged, configured, file, project, deps);
  // Naming a host that is already there is not a mistake when the flags say
  // which one they mean: re-running the same `werk config setup --host beast`
  // out of a dotfiles script must replace the block rather than refuse it.
  const changing =
    action === "change" ||
    (described && merged.hosts[flags.host!] !== undefined);
  return await describe(
    talk,
    flags,
    deps,
    merged,
    configured,
    file,
    project,
    changing,
  );
}

type Action = "add" | "change" | "default" | "remove" | "quit";

/**
 * Re-running is a menu rather than a refusal or a silent overwrite. A first run
 * has nothing to change, so it skips straight to adding; so does a run whose
 * flags already say which host they mean.
 */
async function chooseAction(
  talk: Talk,
  configured: readonly string[],
  described: boolean,
): Promise<Action> {
  if (described || configured.length === 0 || !talk.talking) return "add";
  return await select<Action>(
    talk.ctx,
    {
      message: `You already have ${configured.join(", ")}. What now?`,
      options: [
        { value: "add", label: "Add another machine" },
        { value: "change", label: "Change one of them" },
        { value: "default", label: "Choose which one werk uses by default" },
        { value: "remove", label: "Remove one" },
        { value: "quit", label: "Nothing; leave it as it is" },
      ],
    },
    talk.on,
  );
}

/** Adding a machine, or changing one that is already there. */
async function describe(
  talk: Talk,
  flags: SetupFlags,
  deps: SetupDeps,
  merged: MergedConfig,
  configured: readonly string[],
  file: string,
  project: boolean,
  changing: boolean,
): Promise<Result<SetupReport>> {
  // There is no "which kind of host" screen. There is one kind werk knows how
  // to add, and a list with one real answer on it costs a keystroke and
  // teaches nothing.
  if (talk.talking && !changing)
    note(
      "werk can add a machine you reach with ssh. That is the only kind it " +
        "knows how to add today, so there is nothing to choose between.",
      "what gets added",
      talk.on,
    );

  const existing = changing
    ? (flags.host ??
      (await select<string>(
        talk.ctx,
        {
          message: "Which one?",
          options: configured.map((name) => ({
            value: name,
            hint: summarise(merged.hosts[name]),
          })),
        },
        talk.on,
      )))
    : undefined;

  const destination = await chooseDestination(
    talk,
    flags,
    deps,
    existing,
    merged,
  );
  const name = await chooseName(talk, flags, destination, merged, existing);

  const report = await runProbe(
    talk,
    (deps.probe ?? probeFor)("ssh"),
    destination,
  );
  // A machine that is asleep is a legitimate host, so this is a question and
  // not a refusal.
  if (
    report.reachable === "no" &&
    !(await confirm(
      talk.ctx,
      `werk could not reach ${destination}. Save it anyway?`,
      talk.on,
    ))
  )
    throw new CancelledError("nothing was written");

  const workspaceRoot = await chooseRoot(talk, flags, report);
  const host: Host = {
    kind: "ssh",
    sshHost: destination,
    ...(workspaceRoot === "" ? {} : { workspaceRoot }),
  };

  // Only offered for the first machine that is not this one. After that there
  // is a real answer already written down, and quietly re-pointing it is the
  // kind of change somebody finds out about a week later.
  const makeDefault =
    flags.default === true ||
    (configured.length === 0 &&
      talk.talking &&
      (await confirm(
        talk.ctx,
        `Make ${name} the host werk puts work on when nobody names one?`,
        talk.on,
      )));

  const settings: SettingChange[] = makeDefault
    ? [{ key: "defaultHost", from: merged.config.defaultHost, to: name }]
    : [];
  const edit: ConfigEdit = {
    hosts: { [name]: host },
    ...(makeDefault ? { set: { defaultHost: name } } : {}),
  };

  if (talk.talking) note(preview(edit), `this goes into ${file}`, talk.on);
  if (!(await confirm(talk.ctx, "Write it?", talk.on)))
    throw new CancelledError("nothing was written");

  const written = await commit(deps, edit, project);
  if (talk.talking) outro(`${name} is written down.`, talk.on);
  return setupResult({
    ...written,
    hosts: [{ name, action: changing ? "changed" : "added", host }],
    settings,
    probe: report,
    unchanged: false,
  });
}

/** Which machine: an alias out of the ssh config, or something typed. */
async function chooseDestination(
  talk: Talk,
  flags: SetupFlags,
  deps: SetupDeps,
  existing: string | undefined,
  merged: MergedConfig,
): Promise<string> {
  if (flags.ssh !== undefined) return flags.ssh;
  const current = existing === undefined ? undefined : merged.hosts[existing];
  const initial =
    current !== undefined && current.kind === "ssh"
      ? current.sshHost
      : undefined;
  const reading = await (deps.aliases ?? readSshAliases)();
  const ask = async () =>
    (
      await text(
        talk.ctx,
        {
          message: "Which machine? Type an ssh destination.",
          ...(initial === undefined ? {} : { initialValue: initial }),
          placeholder: "beast, or mike@10.0.0.7",
          validate: (value) =>
            value.trim() === ""
              ? "an ssh destination, as you would type it after `ssh`"
              : undefined,
        },
        talk.on,
      )
    ).trim();

  if (reading.aliases.length === 0) {
    // A count rather than an empty list: a config that is all wildcards should
    // say why there is nothing to pick from.
    if (reading.skipped > 0 && talk.talking)
      note(
        `${reading.skipped} ${reading.skipped === 1 ? "pattern" : "patterns"} ` +
          `in your ssh config are wildcards or exclusions, so there is no ` +
          `machine in there to offer.`,
        "your ssh config",
        talk.on,
      );
    return await ask();
  }

  const rows: Choice<string>[] = reading.aliases.map((alias) => ({
    value: alias.name,
    label: alias.name,
    // The hint is what the file literally says, not what ssh would resolve.
    // Resolving every alias to fill in the hints would cost far more than the
    // one row the cursor is on is worth; the chosen one can be resolved after.
    hint: [
      alias.user === undefined ? "" : `${alias.user}@`,
      alias.hostName ?? "",
      alias.system ? " (system)" : "",
    ]
      .join("")
      .trim(),
  }));
  const picked = await autocomplete<string>(
    talk.ctx,
    {
      message: "Which machine?",
      options: [...rows, { value: OTHER, label: "Something else, typed in" }],
      placeholder: "type to filter",
      ...(initial !== undefined && rows.some((row) => row.value === initial)
        ? { initialValue: initial }
        : {}),
    },
    talk.on,
  );
  return picked === OTHER ? await ask() : picked;
}

/** What werk calls it. The alias is the obvious suggestion, so it is offered. */
async function chooseName(
  talk: Talk,
  flags: SetupFlags,
  destination: string,
  merged: MergedConfig,
  existing: string | undefined,
): Promise<string> {
  const check = (value: string): string | undefined => {
    const name = value.trim();
    if (!isHostName(name))
      return "letters, digits, dots, dashes and underscores, starting with a letter or a digit";
    if (existing !== name && merged.hosts[name] !== undefined)
      return `${name} is already a host; pick another name, or change that one instead`;
    return undefined;
  };
  const given = flags.host ?? existing;
  if (given !== undefined) {
    const wrong = check(given);
    if (wrong !== undefined) throw new UsageError(`${given}: ${wrong}`);
    return given;
  }
  return (
    await text(
      talk.ctx,
      {
        message: "What should werk call it?",
        initialValue: suggestName(destination),
        validate: check,
      },
      talk.on,
    )
  ).trim();
}

/** The destination with anything a host name cannot hold taken out of it. */
export function suggestName(destination: string): string {
  const bare = destination.slice(destination.indexOf("@") + 1);
  const cleaned = bare
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "");
  return isHostName(cleaned) ? cleaned : "";
}

/**
 * Where workspaces go, asked even when the answer is werk's own default and
 * written even when it changes nothing. It answers a question the person was
 * asked, and reading the file back later should not need knowing what werk
 * would have done. When nothing could ask the machine there is no answer to
 * suggest, and an empty reply writes no key: werk asks the machine later
 * instead of storing a path it invented.
 */
async function chooseRoot(
  talk: Talk,
  flags: SetupFlags,
  report: ProbeReport,
): Promise<string> {
  if (flags.workspaceRoot !== undefined) return flags.workspaceRoot;
  const suggested = report.workspaceRoot ?? "";
  if (!talk.talking) return suggested;
  return (
    await text(
      talk.ctx,
      {
        message: "Where should workspaces go on it?",
        ...(suggested === ""
          ? {
              placeholder:
                "leave this empty and werk will ask the machine when it needs to know",
            }
          : { initialValue: suggested }),
        defaultValue: "",
      },
      talk.on,
    )
  ).trim();
}

/**
 * The probe, under a spinner when there is a terminal to draw one on.
 *
 * Nothing reaches an ssh host yet, so today this says so rather than reporting
 * an unreachable machine. The two read very differently and only the caller
 * knows which probe it handed over.
 */
async function runProbe(
  talk: Talk,
  probe: HostProbe,
  destination: string,
): Promise<ProbeReport> {
  if (probe === noProbe) {
    if (talk.talking)
      note(
        `werk cannot reach a machine over ssh yet, so it did not ask ` +
          `${destination} anything. Nothing about the machine would be stored ` +
          `either way.`,
        "the probe",
        talk.on,
      );
    return await probeHost(probe);
  }
  if (!talk.talking) return await probeHost(probe);
  const spin = spinner(talk.on);
  spin.start(`Asking ${destination} about itself`);
  try {
    const report = await probeHost(probe, {
      signal: AbortSignal.timeout(PROBE_BUDGET_MS),
    });
    spin.stop(
      report.reachable === "yes"
        ? `${destination} answered`
        : `${destination} did not answer`,
    );
    if (report.notes.length > 0)
      note(report.notes.join("\n"), "what it said", talk.on);
    return report;
  } catch (error) {
    spin.stop(`${destination} did not answer`);
    throw error;
  }
}

/* -------------------------------------------------------- the other actions */

/** Choosing which host werk uses when nobody names one. */
async function repoint(
  talk: Talk,
  merged: MergedConfig,
  configured: readonly string[],
  file: string,
  project: boolean,
  deps: SetupDeps,
): Promise<Result<SetupReport>> {
  const chosen = await select<string>(
    talk.ctx,
    {
      message: "Which host should werk use when nobody names one?",
      options: ["local", ...configured].map((name) => ({
        value: name,
        hint: summarise(merged.hosts[name]),
      })),
      initialValue: merged.config.defaultHost,
    },
    talk.on,
  );
  const edit: ConfigEdit = { set: { defaultHost: chosen } };
  note(preview(edit), `this goes into ${file}`, talk.on);
  if (!(await confirm(talk.ctx, "Write it?", talk.on)))
    throw new CancelledError("nothing was written");
  const written = await commit(deps, edit, project);
  outro(`werk will use ${chosen}.`, talk.on);
  return setupResult({
    ...written,
    hosts: [],
    settings: [
      { key: "defaultHost", from: merged.config.defaultHost, to: chosen },
    ],
    probe: null,
    unchanged: false,
  });
}

/** Taking a host back out. */
async function forget(
  talk: Talk,
  merged: MergedConfig,
  configured: readonly string[],
  file: string,
  project: boolean,
  deps: SetupDeps,
): Promise<Result<SetupReport>> {
  const chosen = await select<string>(
    talk.ctx,
    {
      message: "Which one should go?",
      options: configured.map((name) => ({
        value: name,
        hint: summarise(merged.hosts[name]),
      })),
    },
    talk.on,
  );
  // A `defaultHost` left pointing at a block that is gone names a machine
  // nothing defines, so it goes back to `local` in the same write, and the
  // report says so rather than letting somebody find out later.
  const orphaned = merged.config.defaultHost === chosen;
  const settings: SettingChange[] = orphaned
    ? [{ key: "defaultHost", from: chosen, to: "local" }]
    : [];
  const edit: ConfigEdit = {
    hosts: { [chosen]: null },
    ...(orphaned ? { set: { defaultHost: "local" } } : {}),
  };
  if (orphaned)
    note(
      `${chosen} is also what werk uses when nobody names a host, so that ` +
        `goes back to local.`,
      "one other thing",
      talk.on,
    );
  if (!(await confirm(talk.ctx, `Remove ${chosen} from ${file}?`, talk.on)))
    throw new CancelledError("nothing was written");
  const written = await commit(deps, edit, project);
  outro(`${chosen} is gone.`, talk.on);
  return setupResult({
    ...written,
    hosts: [{ name: chosen, action: "removed", host: null }],
    settings,
    probe: null,
    unchanged: false,
  });
}

const commit = (
  deps: SetupDeps,
  edit: ConfigEdit,
  project: boolean,
): Promise<WriteReport> =>
  deps.write
    ? deps.write(edit, project)
    : project
      ? editProjectConfig(edit)
      : editUserConfig(edit);

/**
 * Exactly what will be added, produced by the writer itself so the preview and
 * the file cannot drift apart.
 */
export const preview = (edit: ConfigEdit): string => applyEdit("", edit).trim();

const summarise = (host: Host | undefined): string =>
  host === undefined
    ? "not configured"
    : host.kind === "ssh"
      ? `ssh ${host.sshHost}`
      : "this machine";

/* ------------------------------------------------------------- the two views */

/**
 * Both registers of the same run. The machine shape carries the file, whether
 * it was created, every host and setting that changed and what the machine
 * said; the human one is a diff of the same thing, then the findings, then the
 * command to type next.
 */
export function setupResult(report: SetupReport): Result<SetupReport> {
  return result(report, (ctx) => setupHuman(report, ctx));
}

export function setupHuman(report: SetupReport, ctx: WerkContext): string {
  if (report.unchanged) return ctx.style.muted("Nothing was changed.");
  const lines: string[] = [ctx.style.muted(report.file)];
  for (const change of report.hosts) {
    if (change.action === "removed") {
      lines.push(ctx.style.error(`- [hosts.${change.name}]`));
      continue;
    }
    const mark = change.action === "added" ? "+" : "~";
    for (const line of preview({ hosts: { [change.name]: change.host } }).split(
      "\n",
    ))
      lines.push(`${mark} ${line}`);
  }
  for (const change of report.settings)
    lines.push(
      `~ ${change.key} = ${JSON.stringify(change.to)}` +
        ctx.style.muted(`  (was ${JSON.stringify(change.from)})`),
    );
  const probe = report.probe;
  if (probe !== null) {
    lines.push("");
    for (const check of probe.checks)
      lines.push(
        `  ${check.name.padEnd(24)}${check.state}` +
          (check.detail ? `  ${ctx.style.muted(check.detail)}` : ""),
      );
    for (const one of probe.notes) lines.push(`  ${ctx.style.muted(one)}`);
  }
  const added = report.hosts.find((one) => one.action !== "removed");
  if (added !== undefined) {
    lines.push("");
    lines.push(`  werk config check ${added.name}`);
  }
  return lines.join("\n");
}
