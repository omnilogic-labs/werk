/**
 * Which binary a machine can run.
 *
 * The mapping is small and the refusals are the interesting part. Two of them
 * are worth reading before changing anything here.
 *
 * ## Darwin is refused rather than attempted
 *
 * bun will happily produce a `bun-darwin-arm64` binary from Linux, and the
 * result is unusable: a cross-compiled Mach-O is unsigned, macOS kills an
 * unsigned binary on arm64 with SIGKILL as it starts, and there is no flag on
 * the far side that turns that off. Signing needs a certificate and Apple's
 * tooling, neither of which werk has. So a Mac is refused with the reason
 * attached, rather than being handed a binary that dies with no message at all.
 * Whether werk should instead reach a Mac some other way — Homebrew, a
 * downloaded release, `bun install` on the far side — is open.
 *
 * ## musl is attempted, with a caveat recorded
 *
 * bun publishes musl targets, so werk builds one. The caveat is that a musl
 * binary still links `libstdc++.so.6` and `libgcc_s.so.1`, and a minimal Alpine
 * image has neither, so it fails at load with a message about a missing shared
 * object. `apk add libstdc++` fixes it. werk carries the caveat rather than
 * pre-emptively refusing, because plenty of musl machines do have those
 * libraries and refusing them all would be wrong more often than it was right.
 *
 * ## The manual override
 *
 * Platform detection is the recurring failure in every tool that installs
 * itself on a remote machine, which is why VS Code ships
 * `remote.SSH.remotePlatform`. werk therefore takes an override from the start
 * rather than after the first bug report. There is nowhere in the host block to
 * write one today — `config/hosts.ts` refuses a key it does not know, and a
 * `target` key has not been added — so the override arrives as an option on
 * `openHostSession`. A `target = "bun-linux-x64"` key in `[hosts.<name>]` is
 * what it probably wants to be.
 */
import { HostError, type RemoteFacts } from "./types.js";

/** A bun `--compile --target`, and anything werk knows about using it. */
export interface HostTarget {
  /** As `bun build --compile --target=` takes it. */
  readonly target: string;
  /** True where the machine may still need libraries it does not ship with. */
  readonly caveat?: string;
}

const MUSL_CAVEAT =
  "a musl build still needs libstdc++.so.6 and libgcc_s.so.1, which a " +
  "minimal Alpine image does not have; `apk add libstdc++` supplies both";

/** Every target werk will build, and what each needs said about it. */
export const TARGETS: Readonly<Record<string, HostTarget>> = {
  "bun-linux-x64": { target: "bun-linux-x64" },
  "bun-linux-arm64": { target: "bun-linux-arm64" },
  "bun-linux-x64-musl": { target: "bun-linux-x64-musl", caveat: MUSL_CAVEAT },
  "bun-linux-arm64-musl": {
    target: "bun-linux-arm64-musl",
    caveat: MUSL_CAVEAT,
  },
};

/** How the machines spell their own architectures. */
const ARCHITECTURES: Readonly<Record<string, "x64" | "arm64">> = {
  x86_64: "x64",
  amd64: "x64",
  aarch64: "arm64",
  arm64: "arm64",
};

/**
 * Read an override as somebody would type it. `linux-x64` and `bun-linux-x64`
 * both work, because the `bun-` prefix is bun's spelling rather than a name
 * anybody would think to write.
 */
export function parseTargetOverride(
  sshHost: string,
  given: string,
): HostTarget {
  const spelled = given.startsWith("bun-") ? given : `bun-${given}`;
  const known = TARGETS[spelled];
  if (known === undefined)
    throw new HostError(
      "HOST_UNSUPPORTED",
      sshHost,
      `werk has no target called ${JSON.stringify(given)}. It builds ` +
        `${Object.keys(TARGETS).join(", ")}.`,
    );
  return known;
}

/** What to build for a machine werk has looked at. */
export function targetFor(
  sshHost: string,
  facts: RemoteFacts,
  override?: string,
): HostTarget {
  if (override !== undefined) return parseTargetOverride(sshHost, override);
  // `uname -s` capitalises, so this is `Darwin` rather than the lower-case
  // platform name the rest of the codebase branches on.
  if (facts.uname === "Darwin")
    throw new HostError(
      "HOST_UNSUPPORTED",
      sshHost,
      `${sshHost} is a Mac, and werk cannot put a binary on one yet. A ` +
        `binary cross-compiled here is unsigned, and macOS kills an unsigned ` +
        `binary as it starts, so werk would be shipping something that dies ` +
        `with no message. Reaching a Mac some other way is not worked out.`,
    );
  if (facts.uname !== "Linux")
    throw new HostError(
      "HOST_UNSUPPORTED",
      sshHost,
      `${sshHost} reports itself as ${JSON.stringify(facts.uname)}, and werk ` +
        `only builds for Linux. If that is wrong, say which target to build.`,
    );
  const architecture = ARCHITECTURES[facts.arch];
  if (architecture === undefined)
    throw new HostError(
      "HOST_UNSUPPORTED",
      sshHost,
      `${sshHost} reports the architecture ${JSON.stringify(facts.arch)}, ` +
        `and werk builds for ${Object.keys(ARCHITECTURES).join(", ")}. If ` +
        `that is wrong, say which target to build.`,
    );
  const name = `bun-linux-${architecture}${facts.libc === "musl" ? "-musl" : ""}`;
  const target = TARGETS[name];
  // Unreachable while `ARCHITECTURES` and `TARGETS` agree, and cheaper to
  // assert here than to have the mismatch surface as an undefined argv entry.
  if (target === undefined)
    throw new HostError(
      "HOST_UNSUPPORTED",
      sshHost,
      `werk has no build for ${name}.`,
    );
  return target;
}
