// Progressive mounting of a document (EP-027-T08), chosen by measurement (architecture.md §16):
// - a normal document mounts its first screens (FIRST_MOUNT blocks) at once and the rest in idle slices — within a
//   moment the whole text is in the DOM (⌘F finds everything);
// - a very large one (≥ WINDOW_FROM blocks; a 1 MiB document has ~18 000) keeps only a window of blocks around the
//   reading position mounted: fully mounted, it took 100 s to mount and 0.7 s per scroll frame (200 000 nodes). The rest
//   are spacers with measured (once seen) or estimated heights, so the scrollbar and the sections stay put; the window
//   follows scrolling and jumps, and the first visible line keeps its place on the screen when the window moves.
// Compromise: in a very large document ⌘F finds text inside the window only (about ±40 screens); the tree's search
// and the jumps to sections, annotations and pass stops reach every place.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ViewBlock } from "../node/view.ts";

/** Blocks mounted at once: the first screens; the rest of the document follows in idle slices. */
export const FIRST_MOUNT = 80;
/** From this many blocks a document is «large»: its blocks skip layout off screen (content-visibility, ui/theme.css). */
export const LARGE_DOCUMENT = 1000;
/** From this many blocks only a window around the reading position is mounted. */
export const WINDOW_FROM = 3000;
const WINDOW_BEFORE = 150;
const WINDOW_AFTER = 350;
/** Blocks per idle slice to start with; the slice then adapts so one commit takes about SLICE_MS. */
const SLICE = 400;
const SLICE_MS = 30;
/** Reading line of the document text (15/1.7) and block padding: the estimate of a block not mounted yet. */
const LINE = 25.5;
const BLOCK_PAD = 8;

const idle = (run: () => void): (() => void) => {
  const w = window as unknown as { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
  if (w.requestIdleCallback) {
    const id = w.requestIdleCallback(run, { timeout: 120 });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = setTimeout(run, 16);
  return () => clearTimeout(id);
};

const estimateOne = (length: number, charsPerLine: number) => Math.max(1, Math.ceil(length / Math.max(20, charsPerLine))) * LINE + BLOCK_PAD;

/** Estimated height (px) of blocks with these text lengths at a column of `charsPerLine`. */
export function estimateHeight(lengths: readonly number[], charsPerLine: number): number {
  let height = 0;
  for (const length of lengths) height += estimateOne(length, charsPerLine);
  return Math.round(height);
}

/** The window of a very large document around block `index`, inside [first, last). */
export function windowAround(index: number, first: number, last: number): { start: number; end: number } {
  const start = Math.max(first, Math.min(index - WINDOW_BEFORE, last - WINDOW_BEFORE - WINDOW_AFTER));
  return { start, end: Math.min(last, start + WINDOW_BEFORE + WINDOW_AFTER) };
}

/** Index of the block at offset `y` from the top of the document, by the prefix sums of block heights. */
export function blockAt(prefix: Float64Array, y: number): number {
  let low = 0;
  let high = prefix.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (prefix[middle] <= y) low = middle;
    else high = middle - 1;
  }
  return Math.min(low, prefix.length - 2);
}

export interface Progressive {
  /** Blocks to render now (a contiguous run of indices). */
  shown: ViewBlock[];
  /** Heights of the parts not mounted, above and below. */
  above: number;
  below: number;
  /** Whether every block of the document is mounted. */
  complete: boolean;
  /** Only a window of a very large document is mounted (⌘F compromise). */
  windowed: boolean;
  /** Mount block `index` (null: all — or, windowed, nothing more) now — before a jump to it. */
  ensure(index: number | null): void;
}

export function useProgressiveBlocks(input: {
  blocks: ViewBlock[];
  /** Blocks in the whole document (the fast path may have sent only a part). */
  total: number;
  /** Text lengths of every block of the document, when only a part was sent. */
  lengths: number[] | null;
  /** Identity of the shown document revision: a new one starts over. */
  identity: string;
  /** The scroll container: moving the window keeps the first visible line in place. */
  scroller: () => HTMLElement | null;
  /** The document element (spacers and blocks): heights of mounted blocks are measured in it. */
  body: () => HTMLElement | null;
  charsPerLine: number;
}): Progressive {
  const { blocks, total, lengths, identity, scroller, body, charsPerLine } = input;
  const first = blocks[0]?.index ?? 0;
  const last = first + blocks.length;
  const windowed = total >= WINDOW_FROM;
  const initial = () => (windowed ? windowAround(first + WINDOW_BEFORE, first, last) : { start: first, end: Math.min(last, first + FIRST_MOUNT) });
  const [range, setRange] = useState<{ identity: string; start: number; end: number }>(() => ({ identity, ...initial() }));
  // A new document (or revision) starts with its first screens, or the window the fast path sent (a jump target).
  const current = range.identity === identity ? range : { identity, ...initial() };
  if (current !== range) setRange(current);
  const start = Math.max(first, Math.min(current.start, last));
  const end = Math.max(start, Math.min(current.end, last));

  // Measured heights of blocks seen once (per revision); the estimate for the rest.
  const measured = useRef<{ identity: string; heights: Map<number, number> }>({ identity, heights: new Map() });
  if (measured.current.identity !== identity) measured.current = { identity, heights: new Map() };
  const [measureTick, setMeasureTick] = useState(0);
  const lengthOf = useCallback((index: number) => lengths?.[index] ?? (blocks[index - first] ? [...blocks[index - first].text].length : 80), [lengths, blocks, first]);
  const prefix = useMemo(() => {
    const sums = new Float64Array(total + 1);
    const heights = measured.current.heights;
    for (let index = 0; index < total; index++) sums[index + 1] = sums[index] + (heights.get(index) ?? estimateOne(lengthOf(index), charsPerLine));
    return sums;
  }, [total, lengthOf, charsPerLine, measureTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Moving the window: remember the first visible mounted block's place on the screen, put it back after the commit.
  const keep = useRef<{ index: number; top: number } | null>(null);
  const slice = useRef(SLICE);
  const sliceStarted = useRef<number | null>(null);
  const grow = useCallback((next: { start: number; end: number }) => {
    if (next.start === start && next.end === end) return;
    const container = scroller();
    if (container) {
      const top = container.getBoundingClientRect().top;
      const mounted = body()?.querySelectorAll<HTMLElement>(":scope > [data-block], :scope > .dr-blk [data-block]") ?? [];
      let low = 0;
      let high = mounted.length;
      while (low < high) { const middle = (low + high) >> 1; if (mounted[middle].getBoundingClientRect().bottom > top) high = middle; else low = middle + 1; }
      const anchor = mounted[low];
      if (anchor) keep.current = { index: Number(anchor.dataset.block), top: anchor.getBoundingClientRect().top };
    }
    sliceStarted.current = performance.now();
    setRange({ identity, ...next });
  }, [identity, start, end, scroller, body]);
  useLayoutEffect(() => {
    // Heights of what is mounted now (one layout), then the anchor back in place, then the adaptive slice.
    const element = body();
    if (element && windowed) {
      const heights = measured.current.heights;
      let changed = false;
      for (const child of element.children as HTMLCollectionOf<HTMLElement>) {
        const own = child.dataset.block ?? child.querySelector<HTMLElement>("[data-block]")?.dataset.block;
        if (own === undefined) continue;
        const index = Number(own);
        const height = child.offsetHeight;
        if (Math.abs((heights.get(index) ?? -1) - height) > 0.5) { heights.set(index, height); changed = true; }
        // A table is one element for many cells: its other cells take no extra height.
        for (const cell of child.querySelectorAll<HTMLElement>("[data-block]")) { const other = Number(cell.dataset.block); if (other !== index && heights.get(other) !== 0) { heights.set(other, 0); changed = true; } }
      }
      if (changed) setMeasureTick((tick) => tick + 1);
    }
    const kept = keep.current;
    const container = scroller();
    if (kept && container) {
      keep.current = null;
      const anchor = container.querySelector<HTMLElement>(`[data-block="${kept.index}"]`);
      if (anchor) container.scrollTop += anchor.getBoundingClientRect().top - kept.top;
    }
    if (sliceStarted.current !== null) {
      const spent = Math.max(1, performance.now() - sliceStarted.current);
      sliceStarted.current = null;
      slice.current = Math.round(Math.max(100, Math.min(800, slice.current * (SLICE_MS / spent))));
    }
  }, [start, end, identity]); // eslint-disable-line react-hooks/exhaustive-deps

  // A normal document grows to the whole text in idle slices (downwards, then upwards).
  useEffect(() => {
    if (windowed) return undefined;
    if (end < last) return idle(() => grow({ start, end: Math.min(last, end + slice.current) }));
    if (start > first) return idle(() => grow({ start: Math.max(first, start - slice.current), end }));
    return undefined;
  }, [windowed, start, end, first, last, grow]);

  // A very large document: the window follows the reading position.
  useEffect(() => {
    if (!windowed) return undefined;
    const container = scroller();
    const element = body();
    if (!container || !element) return undefined;
    let frame = 0;
    const follow = () => {
      frame = 0;
      const offset = container.scrollTop + container.clientHeight / 2 - (element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop);
      const index = blockAt(prefix, Math.max(0, offset));
      const margin = 60;
      if (index < start + margin && start > first || index > end - margin && end < last || index < start || index >= end) grow(windowAround(index, first, last));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(follow); };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => { container.removeEventListener("scroll", onScroll); if (frame) cancelAnimationFrame(frame); };
  }, [windowed, scroller, body, prefix, start, end, first, last, grow]);

  const ensure = useCallback((index: number | null) => {
    if (windowed) { if (index !== null && (index < start || index >= end)) grow(windowAround(index, first, last)); return; }
    if (index === null) grow({ start: first, end: last });
    else if (index < start || index >= end) grow({ start: Math.min(start, Math.max(first, index - 20)), end: Math.max(end, Math.min(last, index + 40)) });
  }, [windowed, first, last, start, end, grow]);

  const shown = useMemo(() => blocks.slice(start - first, end - first), [blocks, start, end, first]);
  const above = Math.round(prefix[Math.min(start, total)] ?? 0);
  const below = Math.round((prefix[total] ?? 0) - (prefix[Math.min(end, total)] ?? 0));
  return { shown, above, below, complete: start === 0 && end >= total, windowed, ensure };
}
