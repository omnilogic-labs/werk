// Adapters register here by id; `wp run --engine=...` and `wp bench` look
// them up. Construction is async because the WASM adapter has to compile
// its module first.

import type { VtEngine } from "./types.ts";

const factories = new Map<string, () => Promise<VtEngine>>();
const instances = new Map<string, Promise<VtEngine>>();
const resolved = new Map<string, VtEngine>();

export function registerEngine(
  id: string,
  factory: () => Promise<VtEngine>,
): void {
  factories.set(id, factory);
}

export function engineIds(): string[] {
  return [...factories.keys()];
}

/** One instance per id, created on first use. */
export function getEngine(id: string): Promise<VtEngine> {
  let p = instances.get(id);
  if (!p) {
    const f = factories.get(id);
    if (!f) return Promise.reject(new Error(`no engine registered as "${id}"`));
    p = f();
    instances.set(id, p);
    void p.then((e) => resolved.set(id, e)).catch(() => {});
  }
  return p;
}

/** The engine if it has already been constructed; never constructs one. For `stats`. */
export function peekEngine(id: string): VtEngine | undefined {
  return resolved.get(id);
}
