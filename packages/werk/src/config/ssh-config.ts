/**
 * The machines a person has already written down, so a picker has rows.
 *
 * This does not try to understand ssh_config. `ssh -G <destination>` does that
 * correctly, including every `Match` rule, every `Include`, the defaults and
 * the command line, and it costs about two milliseconds and connects to
 * nothing; {@link resolveSshDestination} wraps it and is what settles what an
 * alias actually means. What `ssh -G` cannot do is enumerate: it answers about
 * one destination, and a wizard needs a list.
 *
 * So this is a line scanner with one job — collect the literal `Host` patterns
 * somebody typed — and it is deliberately shallow. A pattern with `*` or `?` in
 * it is not a machine anybody can connect to, and one starting with `!` is an
 * exclusion, so both are skipped and counted. The count is reported rather than
 * dropped: a config that is all wildcards should say "7 patterns skipped as
 * wildcards" instead of showing an empty list for no visible reason.
 *
 * `Match` blocks are skipped whole. A `Match` block has no alias in it to
 * offer, and its keywords describe a condition rather than a destination.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** One `Host` pattern somebody wrote, and what the same block said about it. */
export interface SshAlias {
  /** The pattern, exactly as written, minus any surrounding quotes. */
  readonly name: string;
  /** The literal `HostName` from the same block, when it gave one. */
  readonly hostName?: string;
  /** The literal `User` from the same block, when it gave one. */
  readonly user?: string;
  /** The literal `Port` from the same block, when it gave one. */
  readonly port?: string;
  /** The file it was written in. */
  readonly file: string;
  /** True when it came from the system file rather than the person's own. */
  readonly system: boolean;
}

export interface SshAliasReading {
  /** In the order ssh reads them, which is the order they were written. */
  readonly aliases: readonly SshAlias[];
  /** Patterns left out because they are wildcards or negations. */
  readonly skipped: number;
  /** Every file that was actually read, deepest include last. */
  readonly files: readonly string[];
}

export interface ReadSshOptions {
  /** The person's own file; `~/.ssh/config` by default. */
  userFile?: string;
  /** The system file; `/etc/ssh/ssh_config` by default, skipped if unreadable. */
  systemFile?: string;
  home?: string;
}

/** ssh caps `Include` nesting at sixteen; eight is more than anyone writes. */
const INCLUDE_DEPTH_LIMIT = 8;

export async function readSshAliases(
  options: ReadSshOptions = {},
): Promise<SshAliasReading> {
  const home = options.home ?? os.homedir();
  const userFile = options.userFile ?? path.join(home, ".ssh", "config");
  const systemFile = options.systemFile ?? "/etc/ssh/ssh_config";
  const collector = new Collector(home);
  await collector.file(userFile, false, 0);
  await collector.file(systemFile, true, 0);
  return {
    aliases: collector.aliases,
    skipped: collector.skipped,
    files: collector.files,
  };
}

/** `Host a b c` yields three; a pattern is a machine only if it names one. */
const isWildcard = (pattern: string): boolean =>
  pattern.includes("*") || pattern.includes("?");

/** An alias while it is still being filled in from the block it was found in. */
interface Draft {
  name: string;
  hostName?: string;
  user?: string;
  port?: string;
  file: string;
  system: boolean;
}

class Collector {
  readonly aliases: Draft[] = [];
  readonly files: string[] = [];
  skipped = 0;
  /** Resolved absolute paths already read, so an `Include` cycle terminates. */
  private readonly seen = new Set<string>();
  private readonly taken = new Set<string>();
  constructor(private readonly home: string) {}

  async file(file: string, system: boolean, depth: number): Promise<void> {
    if (depth > INCLUDE_DEPTH_LIMIT) return;
    const resolved = path.resolve(file);
    if (this.seen.has(resolved)) return;
    this.seen.add(resolved);
    let text: string;
    try {
      text = await fs.readFile(resolved, "utf8");
    } catch {
      // ssh skips an include it cannot read without saying anything, and the
      // system file is absent on plenty of machines. Neither is werk's problem.
      return;
    }
    this.files.push(resolved);
    // The aliases the `Host` line currently in force created. Only these take
    // the block's HostName, so a second block naming a pattern already seen
    // does not rewrite the first one's hint.
    let current: Draft[] = [];
    let inMatch = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = withoutComment(raw);
      const keyword = /^\s*([A-Za-z][A-Za-z0-9_-]*)(?:\s*=\s*|\s+)(.*)$/.exec(
        line,
      );
      if (keyword === null) continue;
      const name = keyword[1]!.toLowerCase();
      const value = keyword[2]!.trim();
      if (name === "host") {
        inMatch = false;
        current = this.host(value, resolved, system);
        continue;
      }
      if (name === "match") {
        inMatch = true;
        current = [];
        continue;
      }
      if (inMatch) continue;
      if (name === "include") {
        for (const included of await this.expand(value, resolved))
          await this.file(included, system, depth + 1);
        continue;
      }
      if (current.length === 0) continue;
      const field =
        name === "hostname"
          ? "hostName"
          : name === "user"
            ? "user"
            : name === "port"
              ? "port"
              : undefined;
      if (field === undefined || value === "") continue;
      // First occurrence wins inside a block too, which is ssh's own rule for a
      // keyword written twice.
      for (const alias of current)
        if (alias[field] === undefined) alias[field] = unquote(value);
    }
  }

  /** The patterns on one `Host` line that name a machine, recorded in order. */
  private host(value: string, file: string, system: boolean): Draft[] {
    const made: Draft[] = [];
    for (const raw of value.split(/\s+/)) {
      if (raw === "") continue;
      const pattern = unquote(raw);
      if (pattern === "") continue;
      if (pattern.startsWith("!") || isWildcard(pattern)) {
        this.skipped += 1;
        continue;
      }
      // First occurrence wins, which is also the rule ssh applies to the
      // keywords inside the block.
      if (this.taken.has(pattern)) continue;
      this.taken.add(pattern);
      const alias: Draft = { name: pattern, file, system };
      this.aliases.push(alias);
      made.push(alias);
    }
    return made;
  }

  /**
   * What an `Include` line refers to: `~` is the home directory, a relative
   * path is relative to the including file's directory, and a glob is expanded
   * and sorted, which is the order `glob(3)` gives ssh.
   */
  private async expand(value: string, from: string): Promise<string[]> {
    const found: string[] = [];
    for (const token of value.split(/\s+/)) {
      if (token === "") continue;
      const pattern = this.absolute(unquote(token), path.dirname(from));
      if (!/[*?[]/.test(pattern)) {
        found.push(pattern);
        continue;
      }
      const matches: string[] = [];
      try {
        // The pattern is already absolute, and `Bun.Glob` takes one whole
        // rather than as a directory plus a relative pattern. Its results
        // arrive in whatever order the directory was walked in, so they are
        // sorted, which is the order `glob(3)` gives ssh.
        const glob = new Bun.Glob(pattern);
        for await (const match of glob.scan({
          absolute: true,
          onlyFiles: true,
        }))
          matches.push(match);
      } catch {
        // A pattern the globber will not take is one ssh would expand to
        // nothing useful either.
        continue;
      }
      found.push(...matches.sort());
    }
    return found;
  }

  private absolute(given: string, directory: string): string {
    if (given === "~") return this.home;
    if (given.startsWith("~/")) return path.join(this.home, given.slice(2));
    return path.isAbsolute(given) ? given : path.join(directory, given);
  }
}

/** Everything before an unquoted `#`. A `#` inside a value is part of it. */
function withoutComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') quoted = !quoted;
    else if (char === "#" && !quoted) return line.slice(0, i);
  }
  return line;
}

const unquote = (value: string): string =>
  value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;

/* ------------------------------------------------------- one destination */

/** What `ssh -G` says a destination resolves to. */
export interface SshResolution {
  readonly destination: string;
  readonly hostname: string;
  readonly user: string;
  readonly port: string;
  /** Every keyword it printed, lower-cased, for anything else that wants one. */
  readonly keywords: Readonly<Record<string, string>>;
}

/** How a test drives {@link resolveSshDestination} without ssh on the machine. */
export interface SshRunner {
  (args: readonly string[]): Promise<{ ok: boolean; stdout: string }>;
}

const spawnSsh: SshRunner = async (args) => {
  const child = Bun.spawn(["ssh", ...args], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const stdout = await new Response(child.stdout).text();
  return { ok: (await child.exited) === 0, stdout };
};

/**
 * What one alias actually means, asked of ssh itself.
 *
 * `ssh -G` prints the whole resolved configuration and connects to nothing, so
 * it is safe to run against a machine that is asleep. It is only ever run for
 * the destination somebody picked: resolving two hundred aliases to fill in the
 * hints on a list would cost half a second for a hint on the one row the cursor
 * happens to be on.
 */
export async function resolveSshDestination(
  destination: string,
  run: SshRunner = spawnSsh,
): Promise<SshResolution | undefined> {
  const { ok, stdout } = await run(["-G", destination]).catch(() => ({
    ok: false,
    stdout: "",
  }));
  if (!ok) return undefined;
  const keywords: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+(.*)$/.exec(line);
    // ssh prints the first value it settled on for each keyword first, and
    // repeats some of them; the first one is the one in force.
    if (match !== null && keywords[match[1]!.toLowerCase()] === undefined)
      keywords[match[1]!.toLowerCase()] = match[2]!.trim();
  }
  return {
    destination,
    hostname: keywords.hostname ?? destination,
    user: keywords.user ?? "",
    port: keywords.port ?? "22",
    keywords,
  };
}
