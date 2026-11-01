// Resolve anchors between persistent revisions.
// The stored target (revision + range + quote) is never modified; this returns a separate resolution.
// exact/mapped are only returned with positive evidence; everything else is approximate, ambiguous or orphaned.
// Scores are internal heuristic ranks (integers), never probabilities.

import { diffArrays } from "diff";
import type { CpRange, Revision } from "../types.ts";
import { assertConsistent } from "./lineage.ts";
import { blockAt, blockSegments, type Projection, sliceText, verifyQuote } from "./projection.ts";
import { containment, occurrences, tokenize, isWord, words } from "./tokens.ts";

export type AnchorStatus = "exact" | "mapped" | "approximate" | "ambiguous" | "orphaned";

export interface AnchorTarget {
  revision: Revision;
  projection: Projection;
  range: CpRange;
  quote: { exact: string; prefix: string; suffix: string };
}

export interface AnchorCandidate {
  range: CpRange;
  score: number;
  evidence: string[];
}

export interface AnchorResolution {
  status: AnchorStatus;
  revisionId: string;
  /** Ranges in the current projection; empty for orphaned. */
  ranges: CpRange[];
  /** Fallback card placement when the target is neither exact nor mapped. */
  place: { block: number } | null;
  evidence: string[];
  candidates: AnchorCandidate[];
}

/** Thresholds of the v1 resolver (projection.md). */
export const ANCHOR = {
  /** Quotes shorter than this (code points) or of one word are not proof by themselves. */
  shortQuote: 8,
  /** Prefix/suffix agreement (code points) that counts as context evidence. */
  contextAgree: 8,
  /** Rank margin between best and second candidate for a document-wide match. */
  margin: 8,
  /** Fuzzy search only for quotes at least this long (code points). */
  fuzzyMinLength: 16,
  /** Share of quote words a block must contain to be a fuzzy candidate. */
  fuzzyContainment: 0.6,
  /** Rank margin for fuzzy candidates. */
  fuzzyMargin: 10,
  maxCandidates: 5,
} as const;

interface CharMap {
  /** New position of each old boundary. */
  pos: Int32Array;
  /** Old code point survived unchanged. */
  kept: Uint8Array;
  /** For removed code points: the span of new text inserted in their place (start, end), or -1. */
  repStart: Int32Array;
  repEnd: Int32Array;
  oldLength: number;
  newLength: number;
}

/** Code point alignment of two texts (Myers diff over code points). */
export function charMap(before: string, after: string): CharMap {
  const A = Array.from(before);
  const B = Array.from(after);
  const pos = new Int32Array(A.length + 1);
  const kept = new Uint8Array(A.length);
  const repStart = new Int32Array(A.length).fill(-1);
  const repEnd = new Int32Array(A.length).fill(-1);
  const ops = diffArrays(A, B);
  let i = 0;
  let j = 0;
  for (let k = 0; k < ops.length; k += 1) {
    const op = ops[k];
    const count = op.count ?? op.value.length;
    if (op.added) {
      j += count;
      continue;
    }
    if (op.removed) {
      const before = k > 0 && ops[k - 1].added ? ops[k - 1] : null;
      const after = k + 1 < ops.length && ops[k + 1].added ? ops[k + 1] : null;
      const rs = before ? j - (before.count ?? before.value.length) : j;
      const re = after ? j + (after.count ?? after.value.length) : j;
      for (let q = 0; q < count; q += 1) {
        pos[i] = j;
        kept[i] = 0;
        repStart[i] = rs;
        repEnd[i] = re;
        i += 1;
      }
      continue;
    }
    for (let q = 0; q < count; q += 1) {
      pos[i] = j;
      kept[i] = 1;
      i += 1;
      j += 1;
    }
  }
  pos[A.length] = B.length;
  return { pos, kept, repStart, repEnd, oldLength: A.length, newLength: B.length };
}

/** Image of an old range in the new text and whether every code point of it survived. */
function mapRange(map: CharMap, start: number, end: number): { range: CpRange; preserved: boolean } {
  if (start === end) return { range: { start: map.pos[start], end: map.pos[start] }, preserved: true };
  let preserved = true;
  let first = -1;
  let last = -1;
  for (let i = start; i < end; i += 1) {
    if (map.kept[i]) {
      if (first < 0) first = map.pos[i];
      last = map.pos[i] + 1;
    } else {
      preserved = false;
      if (map.repEnd[i] > map.repStart[i]) {
        if (first < 0 || map.repStart[i] < first) first = map.repStart[i];
        if (map.repEnd[i] > last) last = map.repEnd[i];
      }
    }
  }
  if (first < 0) return { range: { start: map.pos[start], end: map.pos[start] }, preserved: false };
  return { range: { start: first, end: Math.max(first, last) }, preserved };
}

function cpLength(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

function commonSuffix(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  let n = 0;
  while (n < x.length && n < y.length && x[x.length - 1 - n] === y[y.length - 1 - n]) n += 1;
  return n;
}

function commonPrefix(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n += 1;
  return n;
}

function headingPath(p: Projection, block: number): string {
  return p.blocks[block].headings.map((h) => p.blocks[h].text).join("\u0000");
}

interface SegmentResult {
  status: "mapped" | "approximate" | "orphaned" | "missing";
  ranges: CpRange[];
  block: number | null;
  evidence: string[];
}

interface Context {
  target: AnchorTarget;
  current: { revision: Revision; projection: Projection };
  currentByLineage: Map<string, number>;
  targetLineages: Set<string>;
  originOf: Map<string, number[]>;
}

/** Resolve one target segment through lineage: the same block continued in the current revision. */
function viaLineage(ctx: Context, block: number, local: CpRange): SegmentResult {
  const { target, current } = ctx;
  const lineageId = target.revision.blocks[block].lineageId;
  const cb = ctx.currentByLineage.get(lineageId);
  if (cb === undefined) return { status: "missing", ranges: [], block: null, evidence: [] };
  const oldBlock = target.projection.blocks[block];
  const newBlock = current.projection.blocks[cb];
  const offset = newBlock.range.start;
  const evidence = [`lineage:${lineageId}`];
  if (oldBlock.text === newBlock.text) {
    return { status: "mapped", ranges: [{ start: offset + local.start, end: offset + local.end }], block: cb, evidence: [...evidence, "same-text"] };
  }
  if (local.start === local.end) {
    // Whole-block target of an empty block (image, rule): the block itself is the target.
    if (oldBlock.range.start === oldBlock.range.end) return { status: "mapped", ranges: [{ ...newBlock.range }], block: cb, evidence: [...evidence, "block"] };
  }
  const quote = Array.from(oldBlock.text).slice(local.start, local.end).join("");
  const map = charMap(oldBlock.text, newBlock.text);
  const image = mapRange(map, local.start, local.end);
  const range = { start: offset + image.range.start, end: offset + image.range.end };
  if (image.preserved && quote) {
    const inOld = occurrences(oldBlock.text, quote);
    const inNew = occurrences(newBlock.text, quote);
    if (inOld.length === 1 && inNew.length === 1) return { status: "mapped", ranges: [range], block: cb, evidence: [...evidence, "quote-preserved", "quote-unique-in-block"] };
    if (inOld.length === inNew.length && inOld.indexOf(local.start) === inNew.indexOf(image.range.start) && inOld.indexOf(local.start) >= 0) {
      return { status: "mapped", ranges: [range], block: cb, evidence: [...evidence, "quote-preserved", "occurrence-order"] };
    }
    return { status: "approximate", ranges: [range], block: cb, evidence: [...evidence, "quote-repeated"] };
  }
  if (image.range.start < image.range.end) return { status: "approximate", ranges: [range], block: cb, evidence: [...evidence, "quote-changed"] };
  return { status: "orphaned", ranges: [], block: cb, evidence: [...evidence, "fragment-deleted"] };
}

/** Resolve a segment whose block was split or merged: search the quote in the blocks that came from it. */
function viaOrigin(ctx: Context, block: number, local: CpRange): SegmentResult {
  const { target, current } = ctx;
  const lineageId = target.revision.blocks[block].lineageId;
  const blocks = ctx.originOf.get(lineageId);
  if (!blocks?.length) return { status: "missing", ranges: [], block: null, evidence: [] };
  const oldText = target.projection.blocks[block].text;
  const quote = Array.from(oldText).slice(local.start, local.end).join("");
  const kind = current.revision.blocks[blocks[0]].origin?.kind ?? "split";
  const evidence = [kind, `origin:${lineageId}`];
  const hits: { block: number; range: CpRange }[] = [];
  for (const b of blocks) {
    const nb = current.projection.blocks[b];
    for (const at of occurrences(nb.text, quote)) hits.push({ block: b, range: { start: nb.range.start + at, end: nb.range.start + at + cpLength(quote) } });
  }
  if (quote && hits.length === 1 && occurrences(oldText, quote).length === 1 && cpLength(quote) >= ANCHOR.shortQuote) {
    return { status: "mapped", ranges: [hits[0].range], block: hits[0].block, evidence: [...evidence, "quote-unique-in-block"] };
  }
  if (hits.length) return { status: "approximate", ranges: [hits[0].range], block: hits[0].block, evidence: [...evidence, hits.length > 1 ? "quote-repeated" : "short-quote"] };
  // The whole old block: every piece (split) or the merged block is the approximate place.
  if (local.start === 0 && local.end === cpLength(oldText)) {
    return { status: "approximate", ranges: blocks.map((b) => ({ ...current.projection.blocks[b].range })), block: blocks[0], evidence: [...evidence, "whole-block"] };
  }
  // Rewritten while split/merged: the piece that keeps most of the quote's words.
  let best = -1;
  let bestScore = 0;
  for (const b of blocks) {
    const score = containment(quote, current.projection.blocks[b].text);
    if (score > bestScore) {
      best = b;
      bestScore = score;
    }
  }
  if (best >= 0 && bestScore >= 0.5) return { status: "approximate", ranges: [{ ...current.projection.blocks[best].range }], block: best, evidence: [...evidence, "quote-changed"] };
  return { status: "orphaned", ranges: [], block: blocks[0], evidence: [...evidence, "fragment-deleted"] };
}

/**
 * Nearest block of the current revision that continues the target's context: the block itself or its split/merge
 * result; otherwise the first block between the surviving neighbours (where a rewritten block now stands), else the
 * surviving predecessor, else the successor.
 */
function nearestPlace(ctx: Context, block: number): { block: number } | null {
  const { target } = ctx;
  const own = ctx.currentByLineage.get(target.revision.blocks[block].lineageId);
  if (own !== undefined) return { block: own };
  const origin = ctx.originOf.get(target.revision.blocks[block].lineageId);
  if (origin?.length) return { block: origin[0] };
  let previous: number | undefined;
  for (let k = block - 1; k >= 0 && previous === undefined; k -= 1) previous = ctx.currentByLineage.get(target.revision.blocks[k].lineageId);
  let next: number | undefined;
  for (let k = block + 1; k < target.revision.blocks.length && next === undefined; k += 1) next = ctx.currentByLineage.get(target.revision.blocks[k].lineageId);
  if (previous !== undefined && next !== undefined && next - previous > 1) return { block: previous + 1 };
  if (previous === undefined && next !== undefined && next > 0) return { block: next - 1 };
  if (previous !== undefined) return { block: previous };
  if (next !== undefined) return { block: next };
  return ctx.current.projection.blocks.length ? { block: 0 } : null;
}

/** Document-wide search for the quote when no lineage or origin leads to it. Never returns exact/mapped. */
function search(ctx: Context, firstBlock: number, targetBlocks: number[]): AnchorResolution {
  const { target, current } = ctx;
  const exact = target.quote.exact;
  const p = current.projection;
  const place = nearestPlace(ctx, firstBlock);
  const base = { revisionId: current.revision.revisionId, place };
  const targetLineages = new Set(targetBlocks.map((b) => target.revision.blocks[b].lineageId));
  const targetPath = headingPath(target.projection, firstBlock);
  const evidence: string[] = ["search"];
  const length = cpLength(exact);
  const candidates: (AnchorCandidate & { foreign: boolean })[] = [];
  if (exact) {
    for (const at of occurrences(p.text, exact, 200)) {
      const range = { start: at, end: at + length };
      const segments = blockSegments(p, range);
      if (!segments.length) continue;
      const blocks = segments.map((s) => s.block);
      // A block that already existed elsewhere in the target revision and already held this text is another copy.
      const foreign = blocks.every((b) => {
        const lineageId = current.revision.blocks[b].lineageId;
        if (!ctx.targetLineages.has(lineageId) || targetLineages.has(lineageId)) return false;
        const old = target.revision.blocks.findIndex((x) => x.lineageId === lineageId);
        if (blocks.length > 1) return true;
        return occurrences(target.projection.blocks[old].text, exact).length >= occurrences(p.blocks[b].text, exact).length;
      });
      const before = sliceText(p, { start: Math.max(0, at - 32), end: at });
      const after = sliceText(p, { start: range.end, end: Math.min(p.textCoords.length, range.end + 32) });
      const prefix = commonSuffix(target.quote.prefix, before);
      const suffix = commonPrefix(target.quote.suffix, after);
      const section = headingPath(p, blocks[0]) === targetPath;
      const score = prefix + suffix + (section ? 16 : 0);
      const ev = [...(prefix ? [`prefix:${prefix}`] : []), ...(suffix ? [`suffix:${suffix}`] : []), ...(section ? ["section"] : []), ...(foreign ? ["other-copy"] : [])];
      candidates.push({ range, score: foreign ? 0 : score, evidence: ev, foreign });
    }
  }
  const rank = (list: AnchorCandidate[]) => [...list].sort((a, b) => b.score - a.score || a.range.start - b.range.start).slice(0, ANCHOR.maxCandidates);
  const valid = candidates.filter((c) => !c.foreign);
  const strip = (list: (AnchorCandidate & { foreign?: boolean })[]): AnchorCandidate[] => list.map(({ range, score, evidence: ev }) => ({ range, score, evidence: ev }));
  if (valid.length) {
    const ranked = rank(strip(valid));
    const best = ranked[0];
    const second = ranked[1];
    const inTarget = occurrences(target.projection.text, exact).length;
    const context = best.evidence.some((e) => {
      const m = /^(prefix|suffix):(\d+)$/.exec(e);
      return m !== null && Number(m[2]) >= ANCHOR.contextAgree;
    });
    const short = length < ANCHOR.shortQuote || words(exact).length < 2;
    const others = strip(candidates.filter((c) => c.foreign));
    if (inTarget > 1) return { status: "ambiguous", ...base, ranges: [], evidence: [...evidence, "quote-repeated-in-target"], candidates: rank([...ranked, ...others]) };
    if (second && best.score - second.score < ANCHOR.margin) return { status: "ambiguous", ...base, ranges: [], evidence: [...evidence, "several-matches"], candidates: rank([...ranked, ...others]) };
    if (short && !context) return { status: "ambiguous", ...base, ranges: [], evidence: [...evidence, "short-quote"], candidates: rank([...ranked, ...others]) };
    const block = blockAt(p, best.range.start);
    return { status: "approximate", revisionId: base.revisionId, place: { block }, ranges: [best.range], evidence: [...evidence, "quote-found", ...best.evidence], candidates: rank([...ranked, ...others]) };
  }
  if (candidates.length) {
    return { status: "orphaned", ...base, ranges: [], evidence: [...evidence, "only-other-copies"], candidates: rank(strip(candidates)) };
  }
  // Bounded fuzzy search: blocks that are new or changed since the target revision.
  if (length >= ANCHOR.fuzzyMinLength && words(exact).length >= 3) {
    const fuzzy: AnchorCandidate[] = [];
    p.blocks.forEach((block, b) => {
      const lineageId = current.revision.blocks[b].lineageId;
      if (ctx.targetLineages.has(lineageId)) {
        const old = target.revision.blocks.find((x) => x.lineageId === lineageId);
        if (old && old.semanticHash === block.semanticHash) return;
      }
      const share = containment(exact, block.text);
      if (share < ANCHOR.fuzzyContainment) return;
      const range = locate(exact, block.text, block.range.start);
      const section = headingPath(p, b) === targetPath;
      fuzzy.push({ range, score: Math.round(share * 100) + (section ? 16 : 0), evidence: ["fuzzy", `words:${Math.round(share * 100)}`, ...(section ? ["section"] : [])] });
    });
    const ranked = rank(fuzzy);
    if (ranked.length === 1 || (ranked.length > 1 && ranked[0].score - ranked[1].score >= ANCHOR.fuzzyMargin)) {
      return { status: "approximate", revisionId: base.revisionId, place: { block: blockAt(p, ranked[0].range.start) }, ranges: [ranked[0].range], evidence: [...evidence, ...ranked[0].evidence], candidates: ranked };
    }
    if (ranked.length > 1) return { status: "ambiguous", ...base, ranges: [], evidence: [...evidence, "fuzzy", "several-matches"], candidates: ranked };
  }
  return { status: "orphaned", ...base, ranges: [], evidence: [...evidence, "not-found"], candidates: [] };
}

/** Span of a block text from the first to the last word shared with the quote (word-level diff). */
function locate(quote: string, text: string, offset: number): CpRange {
  const a = tokenize(quote);
  const b = tokenize(text);
  const ops = diffArrays(a, b);
  let at = 0;
  let first = -1;
  let last = -1;
  for (const op of ops) {
    if (op.removed) continue;
    const length = op.value.reduce((n, t) => n + cpLength(t), 0);
    if (!op.added && op.value.some(isWord)) {
      if (first < 0) first = at;
      last = at + length;
    }
    at += length;
  }
  if (first < 0) return { start: offset, end: offset + cpLength(text) };
  return { start: offset + first, end: offset + last };
}

const RANK: Record<string, number> = { mapped: 0, approximate: 1, orphaned: 2, missing: 3 };

/** Resolve a stored target against the current revision (pipeline §6). Pure; the target is not modified. */
export function resolveAnchor(target: AnchorTarget, current: { revision: Revision; projection: Projection }): AnchorResolution {
  assertConsistent(target.revision, target.projection);
  assertConsistent(current.revision, current.projection);
  const revisionId = current.revision.revisionId;
  const valid = verifyQuote(target.projection, target.range, target.quote.exact);

  // 1. Same revision: offsets and quote verified.
  if (valid && target.revision.revisionId === revisionId && verifyQuote(current.projection, target.range, target.quote.exact)) {
    return { status: "exact", revisionId, ranges: [{ ...target.range }], place: null, evidence: ["same-revision", "quote-verified"], candidates: [] };
  }

  const ctx: Context = {
    target,
    current,
    currentByLineage: new Map(current.revision.blocks.map((b, i) => [b.lineageId, i])),
    targetLineages: new Set(target.revision.blocks.map((b) => b.lineageId)),
    originOf: new Map(),
  };
  current.revision.blocks.forEach((b, i) => {
    for (const s of b.origin?.sources ?? []) ctx.originOf.set(s.lineageId, [...(ctx.originOf.get(s.lineageId) ?? []), i]);
  });

  if (!valid) {
    // A target whose quote does not match its own revision is never trusted for offsets.
    const first = Math.max(0, Math.min(target.revision.blocks.length - 1, blockAt(target.projection, Math.min(target.range?.start ?? 0, target.projection.textCoords.length))));
    const result = search(ctx, first, []);
    const status = result.status === "approximate" ? "approximate" : result.status;
    return { ...result, status, evidence: ["target-quote-mismatch", ...result.evidence] };
  }

  // 2-3. Lineage of every target block, then split/merge origins.
  const segments = blockSegments(target.projection, target.range);
  if (!segments.length) return search(ctx, Math.max(0, blockAt(target.projection, target.range.start)), []);
  const results = segments.map((segment) => {
    const block = target.projection.blocks[segment.block];
    const local = { start: segment.range.start - block.range.start, end: segment.range.end - block.range.start };
    const viaL = viaLineage(ctx, segment.block, local);
    return viaL.status === "missing" ? viaOrigin(ctx, segment.block, local) : viaL;
  });
  const targetBlocks = segments.map((s) => s.block);
  if (results.every((r) => r.status === "missing")) return search(ctx, targetBlocks[0], targetBlocks);

  const evidence = [...new Set(results.flatMap((r) => r.evidence))];
  const worst = results.reduce((w, r) => (RANK[r.status] > RANK[w] ? r.status : w), "mapped" as SegmentResult["status"]);
  const ranges = results.flatMap((r) => r.ranges);
  const firstPlace = results.find((r) => r.block !== null);
  const place = firstPlace ? { block: firstPlace.block as number } : nearestPlace(ctx, targetBlocks[0]);

  if (worst === "mapped") {
    // The whole quote, separators included, must read the same at the mapped place.
    const lead = segments[0].range.start - target.range.start;
    const trail = target.range.end - segments[segments.length - 1].range.end;
    const merged = { start: ranges[0].start - lead, end: ranges[ranges.length - 1].end + trail };
    if (merged.start >= 0 && merged.end <= current.projection.textCoords.length && merged.start <= merged.end && verifyQuote(current.projection, merged, target.quote.exact)) {
      return { status: "mapped", revisionId, ranges: [merged], place: null, evidence, candidates: [{ range: merged, score: 100, evidence }] };
    }
    return { status: "approximate", revisionId, ranges, place, evidence: [...evidence, "segments-apart"], candidates: ranges.map((range) => ({ range, score: 50, evidence })) };
  }
  if (!ranges.length) {
    return { status: "orphaned", revisionId, ranges: [], place, evidence, candidates: [] };
  }
  return { status: "approximate", revisionId, ranges, place, evidence: worst === "missing" ? [...evidence, "partial"] : evidence, candidates: ranges.map((range) => ({ range, score: 50, evidence })) };
}
