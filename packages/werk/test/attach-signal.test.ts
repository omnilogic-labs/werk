/**
 * Ctrl-C while the daemon is being reached.
 *
 * `attach` takes the alternate screen before it has an attachment, because the
 * screen is where the session is about to be painted. Reaching the daemon takes
 * a round trip, and longer when one has to be started, so there is a window in
 * between. A signal arriving in it has to end the attachment and give the
 * terminal back rather than be waited out or take Node's default disposition.
 *
 * The case runs against a daemon that never answers, which is that window held
 * open. `attachSession` takes its context and its client as arguments, so no
 * daemon, no session and no terminal are needed to hold it.
 */
import { expect, test } from "bun:test";
import type { SessionClient } from "@werk/session";
import { attachSession } from "../src/commands/attach.js";
import type { WerkContext } from "../src/runtime/context.js";

/** A context that keeps what was written where a terminal would have been. */
function recorder() {
  const written: string[] = [];
  const ctx = {
    stdoutTTY: true,
    stdinTTY: true,
    write: (text: string) => void written.push(text),
    writeError: () => {},
  } as unknown as WerkContext;
  return { ctx, screen: () => written.join("") };
}

/**
 * A daemon that never answers anything.
 *
 * Only the four members `attachSession` reaches for, so the cast is over what
 * this case holds still rather than over a client that does not work.
 */
function silent(): SessionClient {
  const never = () => new Promise<never>(() => {});
  return {
    get: never,
    attach: never,
    inputChunkBytes: () => 4096,
    closed: never(),
  } as unknown as SessionClient;
}

/** Resolve to what happened, so a hang fails the case instead of hanging it. */
async function within<T>(work: Promise<T>, ms: number): Promise<string> {
  return await Promise.race([
    work.then(() => "returned"),
    Bun.sleep(ms).then(() => "hung"),
  ]);
}

for (const signal of ["SIGINT", "SIGTERM"] as const)
  test(`${signal} before the daemon answers gives the terminal back`, async () => {
    const { ctx, screen } = recorder();
    const before = process.listenerCount(signal);
    const attaching = attachSession(ctx, silent(), "abcdef123456", {
      cols: 80,
      rows: 24,
    });
    // Long enough for the screen to be taken; the daemon never answers, so
    // nothing else is coming.
    await Bun.sleep(50);
    expect(screen()).toContain("\x1b[?1049h");
    expect(process.listenerCount(signal)).toBe(before + 1);

    process.emit(signal);
    expect(await within(attaching, 2000)).toBe("returned");
    expect(screen()).toContain("\x1b[?1049l");
    // The handler is taken off again, so a command that runs after this one
    // does not inherit an attachment's idea of what a signal means.
    expect(process.listenerCount(signal)).toBe(before);
  });
