// «Code / Diagram» of an embedded object (W-06f, EP-059-T04): a device preference, not review data. One versioned key;
// per block only a short hash of (document, lineage) — never the source or a path. A value of an unknown shape is
// ignored (the default applies), so a future format never breaks the viewer.
import { useSyncExternalStore } from "react";

export type EmbeddedView = "code" | "diagram";
const KEY = "bbdr:embedded-view:v1";
type Stored = { default?: EmbeddedView; blocks?: Record<string, EmbeddedView> };

let cache: Stored | null = null;
const listeners = new Set<() => void>();

function read(): Stored {
  if (cache) return cache;
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "{}") as unknown;
    const ok = (v: unknown) => v === "code" || v === "diagram";
    const stored: Stored = {};
    if (value && typeof value === "object") {
      const raw = value as Record<string, unknown>;
      if (ok(raw.default)) stored.default = raw.default as EmbeddedView;
      if (raw.blocks && typeof raw.blocks === "object") {
        stored.blocks = {};
        for (const [k, v] of Object.entries(raw.blocks as Record<string, unknown>)) if (/^[0-9a-f]{16}$/.test(k) && ok(v)) stored.blocks[k] = v as EmbeddedView;
      }
    }
    cache = stored;
  } catch { cache = {}; }
  return cache;
}

/** FNV-1a 64-bit of the document path and the block lineage: 16 hex chars. */
export function blockKey(doc: string, lineage: string): string {
  let h = 0xcbf29ce484222325n;
  for (const ch of new TextEncoder().encode(`${doc}\n${lineage}`)) { h ^= BigInt(ch); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h.toString(16).padStart(16, "0");
}

export function viewOf(key: string): EmbeddedView {
  const stored = read();
  return stored.blocks?.[key] ?? stored.default ?? "diagram";
}

export function setView(key: string, view: EmbeddedView) {
  const stored = read();
  const blocks = { ...stored.blocks, [key]: view };
  // Keep the preference small: the last 500 blocks.
  const entries = Object.entries(blocks);
  cache = { ...stored, blocks: Object.fromEntries(entries.slice(Math.max(0, entries.length - 500))) };
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(cache)); } catch { /* storage unavailable: the choice lives until reload */ }
  for (const listener of listeners) listener();
}

export function useEmbeddedView(key: string): EmbeddedView {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => viewOf(key), () => "diagram");
}
