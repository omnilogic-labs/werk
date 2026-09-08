/**
 * Everything werk needs to know about a machine, in one round trip.
 *
 * One round trip rather than one question per fact, because at 50 ms of latency
 * ten questions is half a second of nothing happening and the shape scales the
 * wrong way: every fact anybody adds later costs another round trip forever.
 * So the script below runs once, under a login shell, and prints its answers.
 *
 * ## Why lines and not JSON
 *
 * The obvious thing is to `printf` a JSON object out of `sh`. Do not. Quoting a
 * `$HOME` that contains a quote, a backslash or a newline is a bug nobody finds
 * until the one person whose home directory has an apostrophe in it tries werk,
 * and `sh` has no JSON escaper. One value per line in a fixed order has no
 * escaping problem for anything werk actually asks about, and a field that grew
 * a newline would fail the field count rather than silently mean something
 * else.
 *
 * ## Why the markers
 *
 * A login shell runs the person's profile, and profiles print things — a MOTD,
 * a version manager's greeting, a fortune. Everything before the opening marker
 * is discarded, so a banner costs nothing. The closing marker earns its place
 * separately: the last two fields can legitimately be empty, so without an end
 * to measure against there is no way to tell an empty last field from a missing
 * one.
 *
 * ## Why musl is detected by looking for a file
 *
 * Running `ldd --version` to ask means running the dynamic loader and parsing
 * prose that differs between glibc, musl and every distribution's patched
 * build; musl's `ldd` writes its answer to stderr and exits 1. The loader
 * itself is a file with a fixed name, and a machine that has `ld-musl-*.so.1`
 * is a musl machine.
 */
import {
  requireConnection,
  sshExecArgv,
  type RemoteRunner,
  EXEC_TIMEOUT_MS,
} from "./ssh.js";
import { HostError, type RemoteFacts } from "./types.js";
import type { HostProbe, ProbeOptions, ProbeResult } from "../hosts/probe.js";

export const PROBE_START = "WERK-PROBE-1";
export const PROBE_END = "WERK-PROBE-END";

/** The fields the script prints, in the order it prints them. */
export const PROBE_FIELDS = [
  "uname",
  "arch",
  "libc",
  "home",
  "uid",
  "git",
  "rsync",
  "loginPath",
  "claudeConfig",
  "installed",
] as const;

/**
 * The script itself. Deliberately POSIX `sh`: it has to run under whatever the
 * account's shell is, and werk has no way to know that a machine has bash until
 * after it has asked.
 */
export const PROBE_SCRIPT = [
  `echo ${PROBE_START}`,
  `uname -s`,
  `uname -m`,
  // An unmatched glob stays literal in `sh`, and `[ -e ]` on a literal is
  // false, so this needs no `nullglob` and no subshell.
  `libc=glibc`,
  `for f in /lib/ld-musl-*.so.1 /usr/lib/ld-musl-*.so.1; do [ -e "$f" ] && libc=musl; done`,
  `echo "$libc"`,
  `printf "%s\\n" "$HOME"`,
  `id -u`,
  `command -v git || echo`,
  `command -v rsync || echo`,
  `printf "%s\\n" "$PATH"`,
  `c=""`,
  `[ -e "$HOME/.claude.json" ] && c="$HOME/.claude.json"`,
  `[ -d "$HOME/.claude" ] && c="$HOME/.claude"`,
  `printf "%s\\n" "$c"`,
  `v=""`,
  `command -v werk >/dev/null 2>&1 && v=$(werk --version 2>/dev/null | head -1)`,
  `printf "%s\\n" "$v"`,
  `echo ${PROBE_END}`,
].join("\n");

/** The lines between the two markers, or null when they are not both there. */
export function probeBody(stdout: string): string[] | null {
  const lines = stdout.replaceAll("\r", "").split("\n");
  const start = lines.indexOf(PROBE_START);
  if (start < 0) return null;
  const end = lines.indexOf(PROBE_END, start + 1);
  if (end < 0) return null;
  return lines.slice(start + 1, end);
}

/**
 * The same rule `defaultStateDir` applies locally, spelled for the machine's own
 * shell so the answer is that machine's `$HOME` and its `$XDG_STATE_HOME`.
 */
export const WORKSPACE_ROOT_COMMAND =
  'printf %s "${XDG_STATE_HOME:-$HOME/.local/state}/werk/workspaces"';

/**
 * Where workspaces go on a machine, asked of the machine.
 *
 * A host block with no `workspaceRoot` has not said, and werk must not guess:
 * the answer depends on that machine's `$HOME` and its `$XDG_STATE_HOME`, and a
 * path invented here would be wrong the first time either is not what this
 * machine has. The rule is the same one `defaultStateDir` applies locally, and
 * it is the same string `probeHost` reports as the `workspace root` check, so
 * `werk config check` and a `werk create` that had to ask cannot disagree.
 *
 * Returns undefined when the machine answered and said nothing usable. It does
 * not throw: the caller knows which host it was asking and what it wanted the
 * answer for, and a transport that could not connect raises on its own.
 */
export async function askWorkspaceRoot(
  probe: HostProbe,
  timeoutMs = QUICK_MS,
): Promise<string | undefined> {
  const answer = await probe.run(["sh", "-c", WORKSPACE_ROOT_COMMAND], {
    timeoutMs,
  });
  const value = answer.stdout.trim();
  return answer.ok && answer.code === 0 && value !== "" ? value : undefined;
}

/**
 * Ask a machine the handful of things werk wants to know before putting work on
 * it.
 * Read what the script printed. *
 * `sshHost` is only ever used to name the machine in a failure; nothing here
 * connects to anything.
 */
export function parseProbe(sshHost: string, stdout: string): RemoteFacts {
  const body = probeBody(stdout);
  if (body === null)
    throw new HostError(
      "HOST_UNSUPPORTED",
      sshHost,
      `${sshHost} did not answer werk's probe. Its shell printed something ` +
        `werk cannot read instead.`,
      stdout.replaceAll("\r", "").trim().slice(0, 400),
    );
  if (body.length !== PROBE_FIELDS.length)
    throw new HostError(
      "HOST_UNSUPPORTED",
      sshHost,
      `${sshHost} answered werk's probe with ${body.length} fields where it ` +
        `expects ${PROBE_FIELDS.length}.`,
      body.join("\n").slice(0, 400),
    );
  const [
    uname = "",
    arch = "",
    libc = "",
    home = "",
    uid = "",
    git = "",
    rsync = "",
    loginPath = "",
    claudeConfig = "",
    installed = "",
  ] = body;
  const refuse = (why: string) =>
    new HostError(
      "HOST_UNSUPPORTED",
      sshHost,
      `${sshHost}: ${why}`,
      body.join("\n"),
    );
  if (!uname) throw refuse("its `uname -s` said nothing.");
  if (!arch) throw refuse("its `uname -m` said nothing.");
  if (libc !== "glibc" && libc !== "musl")
    throw refuse(`werk read its C library as ${JSON.stringify(libc)}.`);
  if (!home.startsWith("/"))
    throw refuse(
      `its HOME is ${JSON.stringify(home)}, which is not an absolute path.`,
    );
  const uidNumber = Number(uid);
  if (!Number.isInteger(uidNumber))
    throw refuse(`its \`id -u\` said ${JSON.stringify(uid)}.`);
  return {
    uname,
    arch,
    libc,
    home,
    uid: uidNumber,
    ...(git ? { git } : {}),
    rsync: rsync !== "",
    loginPath,
    ...(claudeConfig ? { claudeConfig } : {}),
    ...(installed ? { installed } : {}),
    werk: `${home}/.local/share/werk/bin`,
  };
}

/** Ask a machine everything, once. */
export async function probeHost(
  sshHost: string,
  runner: RemoteRunner,
  timeoutMs = EXEC_TIMEOUT_MS,
): Promise<RemoteFacts> {
  const outcome = await runner.run(
    sshExecArgv(sshHost, PROBE_SCRIPT, { login: true }),
    { timeoutMs },
  );
  requireConnection(sshHost, outcome, `looking at ${sshHost}`);
  return parseProbe(sshHost, outcome.stdout);
}

/**
 * The ssh implementation of `HostProbe`.
 *
 * Nothing here interprets a non-zero status: a command that ran and failed is
 * an answer, and only a connection that could not be made raises.
 */
export function sshProbe(sshHost: string, runner: RemoteRunner): HostProbe {
  return {
    async run(
      command: string,
      options: ProbeOptions = {},
    ): Promise<ProbeResult> {
      const outcome = await runner.run(
        sshExecArgv(sshHost, command, { login: options.login === true }),
        { timeoutMs: options.timeoutMs ?? EXEC_TIMEOUT_MS },
      );
      requireConnection(sshHost, outcome, `running a command on ${sshHost}`);
      return {
        ok: outcome.code === 0,
        code: outcome.code,
        stdout: outcome.stdout.replaceAll("\r", ""),
        stderr: outcome.stderr.replaceAll("\r", ""),
      };
    },
  };
}
