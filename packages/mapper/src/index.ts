/**
 * Mappers: what a running process is doing, from more than what it printed.
 *
 * `types.ts` is the interface and the reasoning behind its shape. `claude.ts` is
 * the one implementation. `local.ts` is the only way of reading a machine there
 * is so far, and it reads the machine it is running on.
 */
export type {
  Activity,
  FileFacts,
  Mapper,
  MapperSubject,
  ProcessStatus,
  ReadAccess,
} from "./types.js";
export { UNKNOWN } from "./types.js";
export {
  claudeMapper,
  projectDirectoryName,
  readSessionRecord,
  readTranscriptTail,
  TRANSCRIPT_TAIL_BYTES,
  type TranscriptReading,
} from "./claude.js";
export {
  localReadAccess,
  CEILING_BYTES,
  EACH_BYTE_LIMIT,
  EACH_FILE_LIMIT,
  type LocalReadOptions,
} from "./local.js";
export { MAPPERS, mapperFor, statusOf } from "./registry.js";
