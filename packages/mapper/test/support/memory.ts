/**
 * A `ReadAccess` over a map of paths to contents.
 *
 * The point of it is the point of the interface: a mapper reads through four
 * operations and nothing else, so a whole machine's worth of a program's state
 * fits in a literal and no test needs a directory on disk. It also proves the
 * claim the interface is there to make — that an implementation which is not the
 * local filesystem is enough to run a mapper against.
 */
import type { FileFacts, ReadAccess } from "../../src/types.js";

export interface MemoryOptions {
  readonly home?: string;
  /** Absolute path to contents. Directories are implied by the paths in it. */
  readonly files: Readonly<Record<string, string>>;
  /** Milliseconds since the epoch, per file. Defaults to 0. */
  readonly modifiedAt?: Readonly<Record<string, number>>;
}

const parentOf = (file: string) => file.slice(0, file.lastIndexOf("/"));

export function memoryReadAccess(options: MemoryOptions): ReadAccess {
  const files = new Map(Object.entries(options.files));
  const times = options.modifiedAt ?? {};
  const directories = new Set<string>();
  for (const file of files.keys())
    for (let at = parentOf(file); at !== ""; at = parentOf(at))
      directories.add(at);

  const namesIn = (directory: string): string[] => {
    const prefix = `${directory}/`;
    const names = new Set<string>();
    for (const path of [...files.keys(), ...directories]) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest === "") continue;
      names.add(rest.split("/")[0]!);
    }
    return [...names].sort();
  };

  return {
    separator: "/",
    join: (...segments) => segments.join("/").replaceAll(/\/+/g, "/"),
    async home() {
      return options.home ?? "/home/somebody";
    },
    async facts(path): Promise<FileFacts | null> {
      const content = files.get(path);
      if (content !== undefined)
        return {
          directory: false,
          size: content.length,
          modifiedAt: times[path] ?? 0,
        };
      if (directories.has(path))
        return { directory: true, size: 0, modifiedAt: times[path] ?? 0 };
      return null;
    },
    async read(path, readOptions = {}) {
      const content = files.get(path);
      if (content === undefined) return null;
      const tailBytes = readOptions.tailBytes;
      if (tailBytes === undefined || content.length <= tailBytes)
        return content;
      return content.slice(content.length - tailBytes);
    },
    async list(path) {
      if (!directories.has(path)) return null;
      return namesIn(path);
    },
    async readEach(path, eachOptions = {}) {
      if (!directories.has(path)) return null;
      const read = new Map<string, string>();
      for (const name of namesIn(path)) {
        if (
          eachOptions.suffix !== undefined &&
          !name.endsWith(eachOptions.suffix)
        )
          continue;
        const content = files.get(`${path}/${name}`);
        if (content !== undefined) read.set(name, content);
      }
      return read;
    },
  };
}
