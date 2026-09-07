import fs from "node:fs";
import path from "node:path";
export type LogLevel = "error" | "warn" | "info" | "debug";
export type LogEvent =
  | "daemon.start"
  | "daemon.stop"
  | "lock.acquired"
  | "lock.refused"
  | "endpoint.written"
  | "endpoint.lost"
  | "endpoint.recreated"
  | "runtime-dir.recreated"
  | "connection.accept"
  | "connection.drop"
  | "session.create"
  | "session.exit"
  | "session.spawn-failed"
  | "session.failed"
  | "session.evicted"
  | "notify.internal"
  | "session.restored"
  | "session.released"
  | "checkpoint.failed"
  | "preview.failed"
  | "checkpoint.unreadable"
  | "checkpoint.oversize"
  | "attachment.attach"
  | "attachment.detach"
  | "attachment.revoked"
  | "request.error"
  | "request.internal"
  | "uncaught"
  | "unhandled-rejection";
export interface Logger {
  write(
    level: LogLevel,
    event: LogEvent,
    fields?: Record<string, unknown>,
  ): void;
  close(): void;
}
const levels: LogLevel[] = ["error", "warn", "info", "debug"];
export function parseLogLevel(value = "info"): LogLevel {
  if (!levels.includes(value as LogLevel))
    throw new Error(`Invalid log level: ${value}`);
  return value as LogLevel;
}
export const silentLogger: Logger = { write() {}, close() {} };
export function errorFields(error: unknown) {
  return {
    error: String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}
export function createLogger(options: {
  file: string;
  level?: LogLevel;
  maxBytes?: number;
  keep?: number;
}): Logger {
  const threshold = levels.indexOf(parseLogLevel(options.level));
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const keep = options.keep ?? 3;
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isInteger(keep) ||
    keep < 0
  )
    throw new Error("Invalid log rotation bounds");
  let fd: number | undefined;
  let closed = false;
  function closeFile() {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
      fd = undefined;
    }
  }
  function open() {
    fs.mkdirSync(path.dirname(options.file), { recursive: true, mode: 0o700 });
    fd = fs.openSync(options.file, "a", 0o600);
  }
  return {
    write(level, event, fields = {}) {
      if (closed || levels.indexOf(level) > threshold) return;
      try {
        if (fd === undefined) open();
        const values = Object.entries(fields)
          .filter(([, v]) => v !== undefined)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join(" ");
        const encoded = Buffer.from(
          `${new Date().toISOString()} ${level.toUpperCase()} ${event}${values ? " " + values : ""}`,
        );
        const line = Buffer.concat([
          encoded.subarray(0, 8191),
          Buffer.from("\n"),
        ]);
        fs.writeSync(fd!, line);
        if (fs.fstatSync(fd!).size >= maxBytes) {
          closeFile();
          try {
            if (keep) {
              fs.rmSync(`${options.file}.${keep}`, { force: true });
              for (let i = keep - 1; i > 0; i--) {
                try {
                  fs.renameSync(
                    `${options.file}.${i}`,
                    `${options.file}.${i + 1}`,
                  );
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                    throw error;
                }
              }
              fs.renameSync(options.file, `${options.file}.1`);
            } else fs.truncateSync(options.file);
          } catch {
            fs.truncateSync(options.file);
          }
          open();
        }
      } catch {
        closeFile();
      }
    },
    close() {
      closed = true;
      closeFile();
    },
  };
}
/** CLI-owned process policy; embedders choose whether to install it. */
export function installDaemonErrorHandlers(options: {
  log: Logger;
  checkpoint(): Promise<unknown>;
  close(): Promise<unknown>;
  exit?: (code: number) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let times: number[] = [];
  let stopping = false;
  let work = Promise.resolve();
  const rejection = (error: unknown) =>
    options.log.write("error", "unhandled-rejection", errorFields(error));
  const uncaught = (error: Error) => {
    options.log.write("error", "uncaught", errorFields(error));
    const time = now();
    times = times.filter((previous) => time - previous < 60_000);
    times.push(time);
    if (stopping) return;
    const stop = times.length >= 10;
    if (stop) stopping = true;
    work = work
      .then(async () => {
        try {
          await options.checkpoint();
        } catch (error) {
          options.log.write("warn", "checkpoint.failed", errorFields(error));
        }
        if (stop) {
          options.log.write("error", "daemon.stop", {
            reason: "repeated-uncaught",
          });
          try {
            await options.close();
          } finally {
            (options.exit ?? process.exit)(1);
          }
        }
      })
      .catch(rejection);
  };
  process.on("unhandledRejection", rejection);
  process.on("uncaughtException", uncaught);
  return () => {
    process.off("unhandledRejection", rejection);
    process.off("uncaughtException", uncaught);
  };
}
