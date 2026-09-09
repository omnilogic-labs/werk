/**
 * `ReadAccess` over the filesystem of the machine this is running on.
 *
 * It is the only implementation there is today, which means a mapper only reads
 * a process on the same machine as whoever asked. A second implementation over
 * a connection to another machine is the thing that would make `--host` work,
 * and the interface is shaped so that it is the only piece missing.
 *
 * Everything here answers `null` for anything it cannot read, including a
 * permission error. A mapper cannot do anything useful with the difference
 * between "no such file" and "not allowed", and a mapper that threw would take
 * out the status of every other session in the same listing.
 */
import { readFile, readdir, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { FileFacts, ReadAccess } from "./types.js";

/**
 * The most any single `read` returns.
 *
 * A mapper asks for a tail when it knows it wants one. This is for the case it
 * did not: an agent's transcript grows without limit, and a mapper reading one
 * whole is a mapper that gets slower every hour the agent runs. Over the
 * ceiling the last bytes come back rather than the first, because the recent
 * end of a file werk cares about is the end.
 */
export const CEILING_BYTES = 4 * 1024 * 1024;

/** The most `readEach` opens in one directory. */
export const EACH_FILE_LIMIT = 256;

/** The most `readEach` takes from any one file. */
export const EACH_BYTE_LIMIT = 64 * 1024;

export interface LocalReadOptions {
  /** Whose home directory `home()` answers with. Defaults to this account's. */
  readonly home?: string;
  /** Overridden by tests that want to prove the ceiling without a huge file. */
  readonly ceilingBytes?: number;
}

/** The last `bytes` of a file, as text, or the whole file when it is smaller. */
async function tail(file: string, bytes: number): Promise<string | null> {
  const handle = await open(file, "r").catch(() => null);
  if (handle === null) return null;
  try {
    const size = (await handle.stat()).size;
    if (size <= bytes) return await handle.readFile("utf8");
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, size - bytes);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

export function localReadAccess(options: LocalReadOptions = {}): ReadAccess {
  const ceiling = options.ceilingBytes ?? CEILING_BYTES;
  const where = options.home ?? homedir();
  return {
    separator: path.sep,
    join: (...segments) => path.join(...segments),
    async home() {
      return where || null;
    },
    async facts(file): Promise<FileFacts | null> {
      const found = await stat(file).catch(() => null);
      if (found === null) return null;
      return {
        directory: found.isDirectory(),
        size: found.size,
        modifiedAt: found.mtimeMs,
      };
    },
    async read(file, readOptions = {}) {
      const wanted = Math.min(readOptions.tailBytes ?? ceiling, ceiling);
      if (readOptions.tailBytes === undefined) {
        // Read it whole when it fits, so the common case is one call and the
        // text is not cut mid-character by a byte offset.
        const found = await stat(file).catch(() => null);
        if (found === null) return null;
        if (found.isDirectory()) return null;
        if (found.size <= wanted)
          return await readFile(file, "utf8").catch(() => null);
      }
      return await tail(file, wanted);
    },
    async list(directory) {
      const names = await readdir(directory).catch(() => null);
      return names === null ? null : names.sort();
    },
    async readEach(directory, eachOptions = {}) {
      const names = await readdir(directory).catch(() => null);
      if (names === null) return null;
      const suffix = eachOptions.suffix;
      const wanted = names
        .filter((name) => suffix === undefined || name.endsWith(suffix))
        .sort()
        .slice(0, eachOptions.maxFiles ?? EACH_FILE_LIMIT);
      const bytes = Math.min(eachOptions.maxBytes ?? EACH_BYTE_LIMIT, ceiling);
      const read = await Promise.all(
        wanted.map(async (name) => {
          const file = path.join(directory, name);
          const found = await stat(file).catch(() => null);
          if (found === null || found.isDirectory()) return null;
          const text = await tail(file, bytes);
          return text === null ? null : ([name, text] as const);
        }),
      );
      return new Map(read.filter((entry) => entry !== null));
    },
  };
}
