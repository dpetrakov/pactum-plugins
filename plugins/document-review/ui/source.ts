// Client store of W-06c data of a document revision: block metadata for «Pretty» (key paths, keys, values as shown,
// table cells) assembled from the fast-path parts, and the redacted source of “Raw” with the lines of each block
// and the foldable ranges, fetched on demand. Keyed by checkout, path and sha: a new revision starts afresh. Secret
// values are never here — only masks and positions (the reveal answer is kept by the mask component, not stored).
import { useEffect, useState, useSyncExternalStore } from "react";

export type BlockMeta = {
  path?: (string | number | { doc: number })[];
  kind?: string;
  key?: string;
  value?: string;
  comment?: string;
  anchor?: string;
  tag?: string;
  count?: number;
  cells?: string[];
  header?: boolean;
} | null;

export interface SourceInfo {
  sha: string;
  source: string;
  blockLines: [number, number][];
  folds: { line: number; end: number; label: string }[];
}

const metas = new Map<string, BlockMeta[]>();
const sources = new Map<string, SourceInfo | "loading" | { error: string }>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => { version++; for (const listener of listeners) listener(); };

const keyOf = (ctx: string, doc: string, sha: string) => `${ctx}\0${doc}\0${sha}`;

export function rememberMeta(ctx: string, doc: string, sha: string, from: number, meta: BlockMeta[] | null | undefined) {
  if (!meta) return;
  const key = keyOf(ctx, doc, sha);
  const list = metas.get(key) ?? [];
  meta.forEach((entry, offset) => { list[from + offset] = entry; });
  metas.set(key, list);
  if (metas.size > 16) metas.delete(metas.keys().next().value!);
  notify();
}

export function metaOf(ctx: string, doc: string, sha: string): BlockMeta[] {
  return metas.get(keyOf(ctx, doc, sha)) ?? [];
}

export function useMeta(ctx: string, doc: string | null, sha: string | null): BlockMeta[] {
  useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => version, () => version);
  return doc && sha ? metaOf(ctx, doc, sha) : [];
}

/** The source of “Raw” for the shown revision; fetched once per sha (null while loading, an error string on failure). */
export function useSource(ctx: string, doc: string | null, sha: string | null, fetch: (doc: string) => Promise<(SourceInfo & { ok?: boolean }) | { error: string } | null>): SourceInfo | { error: string } | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!doc || !sha) return;
    const key = keyOf(ctx, doc, sha);
    if (sources.has(key)) return;
    sources.set(key, "loading");
    void fetch(doc).then((reply) => {
      if (!reply) { sources.delete(key); return; }
      sources.set(key, reply);
      if (sources.size > 6) sources.delete(sources.keys().next().value!);
      setTick((value) => value + 1);
      notify();
    });
  }, [ctx, doc, sha, fetch]);
  useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => version, () => version);
  if (!doc || !sha) return null;
  const hit = sources.get(keyOf(ctx, doc, sha));
  return !hit || hit === "loading" ? null : hit;
}

export function forgetSource(ctx: string, doc: string, sha: string) {
  sources.delete(keyOf(ctx, doc, sha));
}
