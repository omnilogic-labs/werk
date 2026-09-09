/**
 * Which mapper answers for which process, and what happens when none does.
 *
 * The list is the whole registry. There is no discovery and no plugin
 * mechanism: supporting another agent is another entry here and another file
 * beside `claude.ts`, which is the cost the on-demand shape was chosen to keep
 * small.
 *
 * Nothing here reads anything. `statusOf` is the only function that does, and it
 * is one call so that a caller cannot accidentally ask a mapper that did not
 * claim the process.
 */
import { claudeMapper } from "./claude.js";
import type {
  Mapper,
  MapperSubject,
  ProcessStatus,
  ReadAccess,
} from "./types.js";

export const MAPPERS: readonly Mapper[] = [claudeMapper];

/** The first mapper that claims this process, or nothing. */
export function mapperFor(
  subject: MapperSubject,
  mappers: readonly Mapper[] = MAPPERS,
): Mapper | null {
  return mappers.find((one) => one.claims(subject)) ?? null;
}

/**
 * Ask, if there is anything to ask.
 *
 * `null` covers all three ways there is no reading — no mapper knows this
 * program, the mapper found nothing to read, or it threw — because a caller
 * showing a list of sessions does the same thing with all three, and a mapper
 * that threw must not be able to take the rest of the list with it.
 */
export async function statusOf(
  subject: MapperSubject,
  access: ReadAccess,
  mappers: readonly Mapper[] = MAPPERS,
): Promise<ProcessStatus | null> {
  const mapper = mapperFor(subject, mappers);
  if (mapper === null) return null;
  try {
    return await mapper.read(subject, access);
  } catch {
    return null;
  }
}
