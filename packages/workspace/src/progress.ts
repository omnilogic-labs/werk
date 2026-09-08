/**
 * Telling a caller how far a creation has got, without letting the caller break
 * it.
 *
 * A progress callback comes from wherever the workspace was asked for — a
 * terminal painting a line, a test collecting events — and a maker has no idea
 * what it does. If it throws, the creation must not fail: the machine work
 * succeeded and only the rendering of it did not, and turning that into a
 * `create` rejection would be the wrong answer to the wrong problem. So every
 * maker reports through here and nothing reports directly.
 *
 * The returned function is a no-op when no callback was given, so a maker can
 * call it unconditionally.
 */
import type { WorkspaceProgress, WorkspaceStep } from "./types.js";

export type ReportProgress = (
  step: WorkspaceStep,
  state: WorkspaceProgress["state"],
  detail?: string,
) => void;

export function reportProgress(
  onProgress: ((event: WorkspaceProgress) => void) | undefined,
): ReportProgress {
  if (onProgress === undefined) return () => {};
  return (step, state, detail) => {
    try {
      onProgress(
        detail === undefined || detail === ""
          ? { step, state }
          : { step, state, detail },
      );
    } catch {
      // Deliberately swallowed: see above.
    }
  };
}
