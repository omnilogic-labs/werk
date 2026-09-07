/**
 * Every command werk has, in the order they appear in `werk --help`.
 *
 * A command is a function returning a configured commander `Command`, so nothing
 * here runs until the tree is built, and the completion walker sees exactly the
 * same tree the parser does.
 */
import type { Command } from "@commander-js/extra-typings";
import { buildList } from "./list.js";
import { buildDaemon, buildLegacyDaemon } from "./daemon.js";

export const COMMANDS: readonly (() => Command)[] = [buildList, buildDaemon];

/** Accepted but not listed: older spellings kept so existing callers keep working. */
export const HIDDEN_COMMANDS: readonly (() => Command)[] = [buildLegacyDaemon];
