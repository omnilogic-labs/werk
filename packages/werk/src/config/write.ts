/**
 * Putting a config file back on the disk, whole or not at all.
 *
 * The write follows what the daemon already does for its own record in
 * `supervise.ts`: make the directory 0700, write a temporary file beside the
 * real one, then rename over it. A rename within a directory is atomic on every
 * filesystem werk runs on, so a reader arriving mid-write sees the old file or
 * the new one and never half of either.
 *
 * There is no lock. Two writers here are two people running `werk config setup`
 * at the same moment on the same machine, and the rename makes the loser's edit
 * disappear rather than corrupt anything. A lock file would trade that for a
 * stale lock left by a killed process, which is a worse failure and one that
 * needs a human to clear. If concurrent edits ever become ordinary — a daemon
 * writing configuration, say — this is the place that would want revisiting.
 *
 * An existing file keeps its own mode, so a person who chmodded their config
 * still has it after werk touches it. A new one is 0600: it may hold the names
 * of machines somebody can reach.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "./errors.js";
import { configFileIn, projectConfigDir, userConfigDir } from "./load.js";
import { applyEdit, type ConfigEdit } from "./toml-edit.js";

/** What a write did, in the shape a command reports. */
export interface WriteReport {
  /** The file that now holds the edit. */
  readonly file: string;
  /** True when there was nothing there before. */
  readonly created: boolean;
}

export interface WriteOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Where the caller is standing; the repository is resolved from it. */
  cwd?: string;
}

const DIRECTORY_MODE = 0o700;
const NEW_FILE_MODE = 0o600;

/** `~/.werk/config.toml`, or wherever `WERK_CONFIG_DIR` points instead. */
export function editUserConfig(
  edit: ConfigEdit,
  options: WriteOptions = {},
): Promise<WriteReport> {
  return editConfigFile(
    configFileIn(userConfigDir(options.env ?? process.env, options.home)),
    edit,
  );
}

/**
 * `<repository>/.werk/config.toml`. Outside a repository there is no project
 * file to write, which is a mistake in what was asked for rather than a failure
 * of the write, so the caller is told in those terms.
 */
export function editProjectConfig(
  edit: ConfigEdit,
  options: WriteOptions = {},
): Promise<WriteReport> {
  const dir = projectConfigDir(options.cwd);
  if (dir === undefined)
    return Promise.reject(
      new ConfigError(
        "CONFIG_WRITE_FAILED",
        "there is no repository here, so there is no project config file to " +
          "write; run this without --project to write your own",
      ),
    );
  return editConfigFile(configFileIn(dir), edit);
}

/**
 * Read, splice, write, rename. `applyEdit` refuses rather than guessing when it
 * cannot make the change cleanly, and its refusal arrives before anything is
 * opened for writing, so a file werk will not edit is a file werk has not
 * touched.
 */
export async function editConfigFile(
  file: string,
  edit: ConfigEdit,
): Promise<WriteReport> {
  const before = await read(file);
  const created = before === undefined;
  let after: string;
  try {
    after = applyEdit(before ?? "", edit);
  } catch (error) {
    // A field parser knows what is wrong with the text and nothing about which
    // file carried it, the same division `parseHost` uses.
    if (error instanceof ConfigError && error.where === undefined)
      throw error.at({ file });
    throw error;
  }
  // An edit that changes nothing does not touch the file's mtime either: `werk
  // config set logLevel info` when it is already info should leave no trace.
  if (before !== undefined && after === before) return { file, created: false };

  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), {
      recursive: true,
      mode: DIRECTORY_MODE,
    });
    await fs.writeFile(temporary, after, { mode: await modeFor(file) });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw new ConfigError(
      "CONFIG_WRITE_FAILED",
      `werk could not write the config file: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { file },
    );
  }
  return { file, created };
}

async function read(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError(
      "CONFIG_UNREADABLE",
      error instanceof Error ? error.message : String(error),
      { file },
    );
  }
}

/** An existing file's own permissions, or 0600 for one werk is creating. */
async function modeFor(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).mode & 0o777;
  } catch {
    return NEW_FILE_MODE;
  }
}
