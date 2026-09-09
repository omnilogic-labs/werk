/**
 * What a mapper is, and the only things one is allowed to do.
 *
 * A mapper answers one question about one program: what is this process doing
 * right now. It answers it with more than the bytes the process has printed,
 * which for an agent means the files the agent keeps about itself.
 *
 * Three properties are the reason the interface is shaped this way, and every
 * implementation is expected to keep them.
 *
 * **A mapper is asked, and then forgotten.** It holds nothing between calls, so
 * one that is never asked costs nothing and one that is replaced between two
 * status checks loses nothing. Nothing here gives an implementation a place to
 * put state, on purpose.
 *
 * **A mapper reads through `ReadAccess` and nothing else.** No `node:fs`, no
 * spawning, no network. That is what makes the placement question — does a
 * mapper run in the daemon next to the files, or in the client that asked —
 * something that can still be answered later rather than something the first
 * implementation settles. It is also where the line gets drawn on what a mapper
 * may reach at all; see
 * [question 10](../../../docs/open-questions.md#10-what-may-a-mapper-read-and-what-of-that-leaves-the-host).
 *
 * **A mapper reports, it does not decide.** Everything it returns is a reading
 * with a time on it. Where a source says something this file has no word for,
 * the answer is `unknown` carrying what the source said, rather than a guess
 * mapped onto a word that reads as certain.
 */

/** When a reading cannot be given a word this file has. */
export const UNKNOWN = "unknown";

/**
 * A directory entry, as much of one as a mapper is given.
 *
 * `modifiedAt` is milliseconds since the epoch on the machine the file is on,
 * which is the same clock everything else in a reading uses.
 */
export interface FileFacts {
  readonly directory: boolean;
  readonly size: number;
  readonly modifiedAt: number;
}

/**
 * Reading a machine, in the four operations a mapper is expected to need.
 *
 * The set is deliberately short: every one of these is a single request on a
 * remote implementation, and a mapper that needs something outside it is asking
 * for a capability werk has not agreed to give mappers.
 *
 * Absence is an answer, not a failure. Everything here says `null` for a path
 * that is not there, so a mapper looking for a file that a program only writes
 * sometimes does not have to distinguish "no file" from "no permission" — it
 * cannot, and neither should it act differently.
 */
export interface ReadAccess {
  /** Which separator this machine's paths use. */
  readonly separator: string;
  /** Build a path on that machine, whichever machine it is. */
  join(...segments: string[]): string;
  /** The home directory of whoever the terminal process runs as. */
  home(): Promise<string | null>;
  /** Whether a path is there, and what it is. */
  facts(path: string): Promise<FileFacts | null>;
  /**
   * A file, as text. `tailBytes` asks for at most that many bytes from the end,
   * which is how a mapper reads a log it has no reason to read all of.
   */
  read(
    path: string,
    options?: { readonly tailBytes?: number },
  ): Promise<string | null>;
  /** The names in a directory, sorted. */
  list(path: string): Promise<readonly string[] | null>;
  /**
   * Every file in a directory, by name.
   *
   * This is one operation rather than a `list` and a `read` each because a
   * directory of small records — one file per process, one file per job — is
   * the shape agents keep their state in, and reading it a file at a time costs
   * a round trip each on a machine that is not this one.
   */
  readEach(
    path: string,
    options?: {
      readonly suffix?: string;
      readonly maxBytes?: number;
      readonly maxFiles?: number;
    },
  ): Promise<ReadonlyMap<string, string> | null>;
}

/**
 * What werk knows about a terminal process before any mapper has run.
 *
 * This is werk's side of the conversation and it is small on purpose: a mapper
 * that needed a field werk does not have would be a mapper that only works on
 * sessions werk started a particular way.
 */
export interface MapperSubject {
  /** The daemon's id for the terminal process. */
  readonly id: string;
  /** What werk started, as werk started it. */
  readonly argv: readonly string[];
  /** Where werk started it. */
  readonly cwd: string;
  /** Where the process has said it is now, when it has said. */
  readonly reportedCwd?: string;
  /**
   * The command in the foreground of the terminal, when the daemon could work
   * one out. A session started as a shell has the agent here rather than in
   * `argv`.
   */
  readonly foreground?: string;
  /** Whether werk believes the process is still running. */
  readonly running: boolean;
  /** When werk started it. */
  readonly startedAt: number;
  /** When werk last saw output from it. */
  readonly lastOutputAt?: number;
}

/**
 * What a process is doing, in the words the core loop asks in.
 *
 * `working` and `idle` are both "it does not want you". The difference is
 * whether it is doing something: an agent between turns with nothing to do is
 * idle, and an agent halfway through a tool call is working.
 *
 * `waiting` is the one the loop turns on. It means nothing will happen until a
 * person does something.
 *
 * `ended` is the process being gone. `unknown` is a mapper that found the
 * program but could not tell, which is different from no mapper at all.
 */
export type Activity = "working" | "waiting" | "idle" | "ended" | "unknown";

/**
 * One reading, by one mapper, at one moment.
 *
 * Everything optional is optional because some program will not have it.
 * Nothing here is a summary of several readings: a mapper is asked and answers,
 * and whoever asked owns whatever they do with the answers over time.
 */
export interface ProcessStatus {
  /** Which mapper answered. */
  readonly mapper: string;
  readonly activity: Activity;
  /** One line for a person: what it is doing, or what it is waiting for. */
  readonly summary: string;
  /** Whether nothing will happen until a person does something. */
  readonly needsAttention: boolean;
  /** What it is working on across the whole run, when the program says. */
  readonly working?: string;
  /** When the source last wrote the thing this reading is based on. */
  readonly observedAt?: number;
  /** When the mapper was asked. */
  readonly readAt: number;
  /**
   * Anything else the mapper wanted to report. Flat, so that a caller which
   * knows nothing about this mapper can still print all of it.
   */
  readonly facts?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * One program's mapper.
 *
 * `claims` is cheap and reads nothing: it decides from what werk already knows
 * whether this mapper is worth asking. `read` is the expensive half and is only
 * called on a subject the mapper claimed.
 *
 * `read` answers `null` when the mapper claimed the process and then found
 * nothing to read. That is not the same as `unknown`, which is a mapper that
 * found the program's files and could not tell from them what is going on.
 */
export interface Mapper {
  /** Names the implementation. It goes in the reading and in `--json`. */
  readonly id: string;
  /** The program this maps, as a person would say it. */
  readonly program: string;
  claims(subject: MapperSubject): boolean;
  read(
    subject: MapperSubject,
    access: ReadAccess,
  ): Promise<ProcessStatus | null>;
}
