/**
 * What werk remembers about a workspace it made.
 *
 * A record is one JSON file per workspace, beside the repository slot the
 * workspace directory sits in: `<root>/<slot>/<name>.json`. It is written by
 * whoever asked for the workspace, on the machine that asked, which is the
 * first of the three places
 * [question 19](../../../docs/open-questions.md#19-where-does-the-record-of-a-workspace-live)
 * lays out. That question is not closed by this file existing: a record kept
 * here is invisible to a second client and lost with the directory, and both
 * of those are the costs that question names.
 *
 * It holds what landing needs and nothing more. The branch a workspace was made
 * from cannot be worked back out afterwards — several branches share a merge
 * base, and the reflog does not name one — so it is written down at the moment
 * it is known. The state words the earlier work fixed are
 * [question 16](../../../docs/open-questions.md#16-which-of-the-old-words-survive)
 * and are deliberately not here: a field for one would read back as an answer.
 *
 * Nothing fails because a record is missing or unreadable. A workspace made
 * before this existed, or one whose file somebody deleted, is a workspace werk
 * knows less about, and the commands that need a record say what they cannot do
 * without it.
 */
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { repositorySlot } from "./local.js";

/**
 * A workspace werk made, as it is written down.
 *
 * `source` is the checkout it was derived from, on this machine, which is what
 * the file's directory is keyed by. `directory` is on whichever machine `host`
 * names, so the two are not the same kind of path and are not interchangeable.
 */
export interface WorkspaceRecord {
  readonly name: string;
  /** Absolute path to the working directory, on whichever machine `host` names. */
  readonly directory: string;
  readonly branch: string;
  /**
   * The branch the workspace was made from. Absent when the checkout was on a
   * detached HEAD, which is a real state and not a failure: there was a commit
   * to branch from and no branch name to record.
   */
  readonly parent?: string;
  /** The commit the branch started at. */
  readonly base: string;
  /** The checkout it was derived from, on the machine werk was run on. */
  readonly source: string;
  /** Which machine it is on. Absent means the machine werk is running on. */
  readonly host?: string;
  /** Epoch milliseconds, as the client that made it saw the clock. */
  readonly createdAt: number;
}

/** True when a parsed file has everything a record has to carry. */
function isRecord(value: unknown): value is WorkspaceRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.name === "string" &&
    typeof r.directory === "string" &&
    typeof r.branch === "string" &&
    typeof r.base === "string" &&
    typeof r.source === "string" &&
    typeof r.createdAt === "number" &&
    (r.parent === undefined || typeof r.parent === "string") &&
    (r.host === undefined || typeof r.host === "string")
  );
}

/** The records of one repository's workspaces. */
export interface WorkspaceRecords {
  /** The directory the files are in, whether or not it exists. */
  readonly directory: string;
  put(record: WorkspaceRecord): Promise<void>;
  get(name: string): Promise<WorkspaceRecord | undefined>;
  /** Every readable record, by name. Unreadable ones are left out. */
  list(): Promise<WorkspaceRecord[]>;
  forget(name: string): Promise<void>;
}

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * The records for the repository at `toplevel`, under `root`.
 *
 * `root` is the same directory the local maker puts worktrees under, and the
 * slot is the same slot, so a repository's records and its workspaces sit
 * together. The file is `<name>.json` and the workspace is `<name>`, which is
 * why a record cannot be mistaken for a workspace directory by
 * `workspaceAt`: that reconstruction is only ever handed a directory a session
 * is running in.
 */
export function workspaceRecords(
  root: string,
  toplevel: string,
): WorkspaceRecords {
  const directory = path.join(path.resolve(root), repositorySlot(toplevel));
  const fileFor = (name: string) => path.join(directory, `${name}.json`);

  const read = async (file: string): Promise<WorkspaceRecord | undefined> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      // Absent, unreadable, or not the JSON it claims to be. None of those is
      // this module's to diagnose, and every caller has something to say when
      // there is no record.
      return undefined;
    }
  };

  return {
    directory,
    async put(record) {
      await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
      // Write beside and rename over, so a reader arriving mid-write sees the
      // old file or the new one and never half of either. The same shape the
      // config writer and the daemon's own record use.
      const file = fileFor(record.name);
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", {
          mode: FILE_MODE,
        });
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    },
    get: (name) => read(fileFor(name)),
    async list() {
      let entries: string[];
      try {
        entries = await readdir(directory);
      } catch {
        return [];
      }
      const found = await Promise.all(
        entries
          .filter((entry) => entry.endsWith(".json"))
          .map((entry) => read(path.join(directory, entry))),
      );
      return found
        .filter((record): record is WorkspaceRecord => record !== undefined)
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    async forget(name) {
      await rm(fileFor(name), { force: true });
    },
  };
}
