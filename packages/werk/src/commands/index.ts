/**
 * Every command werk has, in the order they appear in `werk --help`.
 *
 * A command is a function returning a configured commander `Command`, so nothing
 * here runs until the tree is built, and the completion walker sees exactly the
 * same tree the parser does.
 *
 * The order is the order someone meets them: make a session, see what is there,
 * go back to one, then the things done to a session, then the machinery.
 */
import type { Command } from "@commander-js/extra-typings";
import { buildCreate } from "./create.js";
import { buildList } from "./list.js";
import { buildAttach } from "./attach.js";
import { buildLogs } from "./logs.js";
import { buildKill } from "./kill.js";
import { buildRemove } from "./remove.js";
import { buildWatch } from "./watch.js";
import { buildInfo, buildDoctor } from "./inspect.js";
import { buildConfig } from "./config.js";
import { buildDaemon, buildLegacyDaemon } from "./daemon.js";
import { buildCompletion, buildComplete } from "./completion.js";

export const COMMANDS: readonly (() => Command)[] = [
  buildCreate,
  buildList,
  buildAttach,
  buildLogs,
  buildKill,
  buildRemove,
  buildWatch,
  buildInfo,
  buildDoctor,
  buildConfig,
  buildCompletion,
  buildDaemon,
];

/**
 * Accepted but not listed: the machine-facing completion callback, which no
 * person types, and the older spelling of `daemon serve`, kept so a daemon
 * spawned by an earlier binary still starts.
 */
export const HIDDEN_COMMANDS: readonly (() => Command)[] = [
  buildComplete,
  buildLegacyDaemon,
];
