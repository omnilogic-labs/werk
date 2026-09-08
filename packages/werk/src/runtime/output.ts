/**
 * One command, two renderings.
 *
 * A command computes a value and says how a person would like to see it; the
 * runtime decides which of the two to print. That is what makes `--json` true of
 * every command rather than of the handful that happened to be written that way
 * — a command cannot forget to support it, because the machine shape is the
 * thing it returns.
 *
 * `attach` and `watch` write continuously and opt out by returning nothing.
 */
import type { WerkContext } from "./context.js";
import { renderTable } from "./table.js";

export interface Result<T> {
  /** The machine shape. Printed verbatim under `--json`. */
  json: T;
  /** What a person reads. Not called when `--json` is set. */
  human(ctx: WerkContext): string;
}
export const result = <T>(
  json: T,
  human: (ctx: WerkContext) => string,
): Result<T> => ({ json, human });

/** A result whose human form is a table; the header row is dropped when piped. */
export function tableResult<T>(
  json: T,
  header: readonly string[],
  rows: readonly (readonly string[])[],
  flex?: number,
): Result<T> {
  return {
    json,
    human: (ctx) =>
      renderTable(ctx.stdoutTTY ? [header, ...rows] : rows, {
        aligned: ctx.stdoutTTY,
        width: ctx.columns,
        flex,
      }),
  };
}
/**
 * A titled block of `label  value` lines, with the labels of one block lined up
 * under each other. What a command that answers with a record rather than a
 * list prints in the human register.
 */
export function section(
  ctx: WerkContext,
  title: string,
  rows: readonly (readonly [string, string])[],
): string {
  if (!rows.length) return "";
  const width = Math.max(...rows.map(([label]) => label.length));
  const body = rows.map(
    ([label, value]) => `  ${ctx.style.muted(label.padEnd(width))}  ${value}`,
  );
  return [ctx.style.emphasis(title), ...body].join("\n");
}
export function emit(ctx: WerkContext, value: Result<unknown> | void): void {
  if (!value) return;
  if (ctx.json) {
    ctx.write(JSON.stringify(value.json) + "\n");
    return;
  }
  const text = value.human(ctx);
  if (text) ctx.write(text + "\n");
}
