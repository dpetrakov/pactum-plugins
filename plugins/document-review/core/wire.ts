// Compact wire format of the viewer (W-06a, EP-027-T08). A host answer is limited to 8 MiB and every byte crosses bb's
// server and the browser: the fast path sends blocks as short records without default values, a document in parts; the
// full view in «compact» mode sends only the review overlay — one state character per block, short lineage ids and the
// rare diffs — and the viewer applies it to the text it already has for the same snapshot hash. Pure: used by the host
// and by the viewer; `decodeBlocks(encodeBlocks(x))` equals `x` (tests/text-w06a.test.mjs).
import type { CpRange } from "./types.ts";

/** A block as the viewer renders it without review state (the shape of ViewBlock in node/view.ts). */
export interface PlainBlock {
  index: number;
  type: string;
  range: CpRange;
  text: string;
  inline: unknown[];
  attrs: Record<string, unknown>;
  depth: number | null;
  cell: { table: number; row: number } | null;
  headings: number[];
}

/** One block on the wire: type, range, text; inline only when not the plain text; attrs without defaults. */
export interface WireBlock {
  t: string;
  r: [number, number];
  x: string;
  i?: unknown[];
  a?: Record<string, unknown>;
  d?: number;
  c?: [number, number];
  /** Enclosing headings, only when they differ from the ones derived from the heading order (nested headings). */
  h?: number[];
}

const DEFAULT_ATTRS: Record<string, unknown> = { quote: 0, list: 0 };

/** Enclosing section headings derived from the headings before: the projection's rule for headings at the root. */
export function derivedHeadings(blocks: readonly { type: string; depth: number | null; attrs: Record<string, unknown> }[], from = 0, stack: { index: number; depth: number }[] = []): number[][] {
  const out: number[][] = [];
  blocks.forEach((block, offset) => {
    const index = from + offset;
    const root = !block.attrs.quote && !block.attrs.list;
    if (block.type === "heading" && root) {
      const depth = block.depth ?? 1;
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
      out.push(stack.map((entry) => entry.index));
      stack.push({ index, depth });
    } else out.push(stack.map((entry) => entry.index));
  });
  return out;
}

/** The heading stack in force after `blocks[0..upTo)` (a part that starts in the middle continues from it). */
export function headingStack(headings: readonly { index: number; depth: number }[], upTo: number): { index: number; depth: number }[] {
  const stack: { index: number; depth: number }[] = [];
  for (const heading of headings) {
    if (heading.index >= upTo) break;
    while (stack.length && stack[stack.length - 1].depth >= heading.depth) stack.pop();
    stack.push(heading);
  }
  return stack;
}

export function encodeBlocks(blocks: readonly PlainBlock[], stack: { index: number; depth: number }[] = []): WireBlock[] {
  const derived = derivedHeadings(blocks, blocks[0]?.index ?? 0, stack.map((entry) => ({ ...entry })));
  return blocks.map((block, offset) => {
    const wire: WireBlock = { t: block.type, r: [block.range.start, block.range.end], x: block.text };
    const plain = block.inline.length === 1 && block.inline[0] === block.text || block.inline.length === 0 && block.text === "";
    if (!plain) wire.i = block.inline;
    const attrs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(block.attrs)) if (value !== null && value !== undefined && DEFAULT_ATTRS[key] !== value) attrs[key] = value;
    if (Object.keys(attrs).length) wire.a = attrs;
    if (block.depth !== null) wire.d = block.depth;
    if (block.cell) wire.c = [block.cell.table, block.cell.row];
    const expected = derived[offset];
    if (expected.length !== block.headings.length || expected.some((value, position) => value !== block.headings[position])) wire.h = block.headings;
    return wire;
  });
}

export function decodeBlocks(wire: readonly WireBlock[], from: number, stack: { index: number; depth: number }[] = []): PlainBlock[] {
  const blocks: PlainBlock[] = wire.map((entry, offset) => ({
    index: from + offset, type: entry.t, range: { start: entry.r[0], end: entry.r[1] }, text: entry.x,
    inline: entry.i ?? (entry.x === "" ? [] : [entry.x]), attrs: { quote: 0, list: 0, footnote: null, ...(entry.a ?? {}) },
    depth: entry.d ?? null, cell: entry.c ? { table: entry.c[0], row: entry.c[1] } : null, headings: [],
  }));
  const derived = derivedHeadings(blocks, from, stack.map((entry) => ({ ...entry })));
  blocks.forEach((block, offset) => { block.headings = wire[offset].h ?? derived[offset]; });
  return blocks;
}

// ── the review overlay of the full view ──────────────────────────────────────────────────────────────────────
export type ReadState = "read" | "unread" | "ambiguous" | null;
export type Change = "added" | "edited" | null;
const STATES: [string, ReadState, Change][] = [["-", null, null], ["r", "read", null], ["a", "unread", "added"], ["e", "unread", "edited"], ["u", "unread", null], ["?", "ambiguous", "edited"], ["!", "ambiguous", null]];
/**
 * Lineage ids travel as a 14-character hash (two FNV-1a 32-bit hashes in base 36): ids are «<document id>.<n>», so
 * any prefix is the same for every block of a document. The hash is deterministic — saved reading positions keep
 * matching across sessions — and is used only to find a block again, never to write review data.
 */
export const LINEAGE_CHARS = 14;
export function lineageKey(lineageId: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let index = 0; index < lineageId.length; index++) {
    const code = lineageId.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x01000193 + 2 * index + 1) >>> 0;
  }
  return a.toString(36).padStart(7, "0") + b.toString(36).padStart(7, "0");
}

export interface OverlayBlock { lineageId: string; read: ReadState; change: Change; diff: unknown; movedFrom: string | null; moved: boolean }
export interface WireOverlay {
  sha: string;
  count: number;
  /** Lineage ids cut to LINEAGE_CHARS, concatenated. */
  ids: string;
  /** One character per block: read state and change. */
  states: string;
  /** Blocks with a diff, a move or a state the characters do not cover: [index, fields]. */
  extras: [number, { diff?: unknown; movedFrom?: string | null; moved?: boolean; read?: ReadState; change?: Change }][];
}

export function encodeOverlay(sha: string, blocks: readonly OverlayBlock[]): WireOverlay {
  let ids = "";
  let states = "";
  const extras: WireOverlay["extras"] = [];
  blocks.forEach((block, index) => {
    ids += block.lineageId ? lineageKey(block.lineageId) : "_".repeat(LINEAGE_CHARS);
    const known = STATES.find(([, read, change]) => read === block.read && change === block.change);
    states += known ? known[0] : "-";
    const extra: WireOverlay["extras"][number][1] = {};
    if (!known) { extra.read = block.read; extra.change = block.change; }
    if (block.diff) extra.diff = block.diff;
    if (block.movedFrom) extra.movedFrom = block.movedFrom;
    if (block.moved) extra.moved = true;
    if (Object.keys(extra).length) extras.push([index, extra]);
  });
  return { sha, count: blocks.length, ids, states, extras };
}

/** Apply the overlay to plain blocks of the same snapshot: the full view's blocks. */
export function applyOverlay<T extends PlainBlock>(blocks: readonly T[], overlay: WireOverlay): (T & OverlayBlock & { versionId: string })[] {
  if (blocks.length !== overlay.count) throw new Error(`overlay of ${overlay.count} blocks for ${blocks.length}`);
  const extras = new Map(overlay.extras);
  return blocks.map((block, index) => {
    const state = STATES.find(([char]) => char === overlay.states[index]) ?? STATES[0];
    const extra = extras.get(index) ?? {};
    return {
      ...block, lineageId: overlay.ids.slice(index * LINEAGE_CHARS, (index + 1) * LINEAGE_CHARS).replace(/_+$/, ""), versionId: "",
      read: extra.read !== undefined ? extra.read : state[1], change: extra.change !== undefined ? extra.change : state[2],
      diff: extra.diff ?? null, movedFrom: extra.movedFrom ?? null, moved: extra.moved ?? false,
    };
  });
}
