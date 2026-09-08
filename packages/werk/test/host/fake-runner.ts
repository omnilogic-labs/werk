/**
 * A runner that answers for machines that are not there.
 *
 * Everything under `src/host/` goes through `RemoteRunner`, which exists so
 * that this file can exist: nothing in `bun test` opens an ssh connection, and
 * every argv werk would have built is available to assert on afterwards.
 */
import type {
  RemoteProcess,
  RemoteRunner,
  RunOptions,
  RunOutcome,
} from "../../src/host/ssh.js";

export interface Call {
  readonly argv: string[];
  readonly options?: RunOptions;
}

export type Reply = (
  argv: string[],
) => Partial<RunOutcome> | Promise<Partial<RunOutcome>>;

export interface FakeRunner extends RemoteRunner {
  readonly calls: Call[];
  readonly started: string[][];
  /** Every argv that reached `run`, joined, for a quick `some`/`find`. */
  lines(): string[];
}

const empty = () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

export function fakeRunner(reply: Reply = () => ({})): FakeRunner {
  const calls: Call[] = [];
  const started: string[][] = [];
  return {
    calls,
    started,
    lines: () => calls.map((call) => call.argv.join(" ")),
    async run(argv, options) {
      calls.push(options === undefined ? { argv } : { argv, options });
      const answer = await reply(argv);
      return {
        code: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        ...answer,
      };
    },
    start(argv): RemoteProcess {
      started.push(argv);
      return {
        stdout: empty(),
        stderr: empty(),
        exited: Promise.resolve(0),
        exitCode: () => null,
        kill: () => {},
      };
    },
  };
}
