// Fetch libghostty-vt's freestanding WASM build and its C headers for one
// upstream commit into vendor/ghostty-vt/<sha>/.
//
//   bun run vendor/ghostty-vt/fetch.ts              # the pinned commit (PIN)
//   bun run vendor/ghostty-vt/fetch.ts <sha>        # any other tip commit
//   bun run vendor/ghostty-vt/fetch.ts --full       # also ghostty-vt.wasm
//   bun run vendor/ghostty-vt/fetch.ts --no-headers # skip include/
//
// The pinned artifacts are verified against the size and sha256 in PIN. For
// any other commit the script prints what it saw so it can be recorded.
//
// Upstream publishes every tip build at tip.files.ghostty.org/<sha>/ and the
// headers live in the repository at include/ghostty/. The header directory
// listing comes from the GitHub contents API (unauthenticated: 60 requests an
// hour, three are used), the files themselves from raw.githubusercontent.com.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const HERE = import.meta.dir;
const REPO = "ghostty-org/ghostty";

interface Artifact {
  url: string;
  size: number;
  sha256: string;
}
interface Pin {
  commit: string;
  artifacts: Record<string, Artifact>;
}

const pin: Pin = JSON.parse(await Bun.file(join(HERE, "PIN")).text());
const args = process.argv.slice(2);
const full = args.includes("--full");
const headers = !args.includes("--no-headers");
const sha = args.find((a) => !a.startsWith("--")) ?? pin.commit;
if (!/^[0-9a-f]{40}$/.test(sha)) {
  console.error(`fetch.ts: "${sha}" is not a full 40-hex commit sha`);
  process.exit(2);
}
const pinned = sha === pin.commit;
const dir = join(HERE, sha);
await mkdir(dir, { recursive: true });

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function artifact(name: string): Promise<void> {
  const url = `https://tip.files.ghostty.org/${sha}/${name}`;
  const target = join(dir, name);
  const file = Bun.file(target);
  const bytes = (await file.exists())
    ? new Uint8Array(await file.arrayBuffer())
    : await download(url);
  const digest = sha256(bytes);
  const expect = pinned ? pin.artifacts[name] : undefined;
  if (expect) {
    if (bytes.byteLength !== expect.size || digest !== expect.sha256) {
      throw new Error(
        `${name}@${sha}: got ${bytes.byteLength} bytes sha256 ${digest}, PIN says ${expect.size} bytes sha256 ${expect.sha256}`,
      );
    }
  }
  if (!(await file.exists())) await Bun.write(target, bytes);
  console.log(
    `${name}  ${bytes.byteLength} bytes  sha256 ${digest}${expect ? "  (matches PIN)" : ""}`,
  );
}

async function listing(
  path: string,
): Promise<{ name: string; path: string; type: string }[]> {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${path}?ref=${sha}`,
    {
      headers: { accept: "application/vnd.github+json" },
    },
  );
  if (!res.ok)
    throw new Error(`GitHub contents API for ${path}: HTTP ${res.status}`);
  return (await res.json()) as { name: string; path: string; type: string }[];
}

async function fetchHeaders(): Promise<void> {
  // include/ghostty/vt.h plus include/ghostty/vt/**/*.h
  const files: string[] = ["include/ghostty/vt.h"];
  const queue = ["include/ghostty/vt"];
  while (queue.length) {
    const path = queue.shift()!;
    for (const entry of await listing(path)) {
      if (entry.type === "dir") queue.push(entry.path);
      else if (entry.name.endsWith(".h")) files.push(entry.path);
    }
  }
  let n = 0;
  for (const path of files) {
    const target = join(dir, path);
    if (await Bun.file(target).exists()) continue;
    const bytes = await download(
      `https://raw.githubusercontent.com/${REPO}/${sha}/${path}`,
    );
    await mkdir(join(target, ".."), { recursive: true });
    await Bun.write(target, bytes);
    n++;
  }
  console.log(
    `headers: ${files.length} files under ${sha}/include/ (${n} downloaded)`,
  );
}

console.log(`ghostty ${sha}${pinned ? " (pinned)" : ""} -> ${dir}`);
await artifact("ghostty-vt-small.wasm");
if (full) await artifact("ghostty-vt.wasm");
if (headers) await fetchHeaders();
