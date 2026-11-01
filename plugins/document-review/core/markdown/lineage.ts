// Match blocks between two projections.
// Deterministic from the two projections only; conservative: when evidence does not single out one
// counterpart, the new block stays new and the old one is reported removed.

import type { Revision } from "../types.ts";
import type { ProjectedBlock, Projection } from "./projection.ts";
import { containment, similarity, words } from "./tokens.ts";

export type MatchKind = "same" | "edited" | "moved" | "moved-edited" | "split" | "merge" | "new";

export interface BlockLink {
  kind: MatchKind;
  /** Old block indices this new block continues: one for same/edited/moved, one for split, several for merge. */
  old: number[];
  /** Machine-readable reasons, e.g. "lcs", "unique-hash", "context", "similarity:83", "gap". */
  evidence: string[];
}

export interface BlockMatch {
  /** Per new block, in new order. */
  next: BlockLink[];
  /** Old blocks with no continuation (not matched and not a split/merge source). */
  removed: number[];
  /** Places where several counterparts were equally plausible; all of them were left unmatched. */
  ambiguous: { old: number[]; next: number[]; reason: "duplicate" | "similar" }[];
}

/** Thresholds of the v1 matcher (documented in projection.md). Internal ranks, not probabilities. */
export const MATCH = {
  /** Edited in place: similarity inside the gap between the surrounding anchors. */
  edited: 0.5,
  /** Edited and moved: similarity outside the gap. */
  movedEdited: 0.75,
  /** The only same-type pair in a gap. Headings of a renamed section need no textual similarity. */
  gapSubstitution: 0.3,
  /** Best candidate must beat the second one by this much (both directions). */
  margin: 0.1,
  /** Competitors below this similarity are noise and do not block a match. */
  noise: 0.3,
  /** Split/merge: every piece mostly made of the other side's words, and the pieces together cover it. */
  pieceContainment: 0.8,
  coverage: 0.8,
  /** Split/merge must explain the text better than the best single piece by this much. */
  splitGain: 0.1,
  /** Minimum words of the whole block for split/merge detection. */
  splitMinWords: 4,
  maxPieces: 8,
} as const;

const SPLITTABLE = new Set(["paragraph", "listItem", "footnoteDefinition"]);

interface State {
  O: ProjectedBlock[];
  N: ProjectedBlock[];
  pairOld: Int32Array;
  pairNew: Int32Array;
  evidence: string[][];
  splitOf: Map<number, number>; // new -> old
  mergeOf: Map<number, number[]>; // new -> olds
  sourceUsed: Set<number>; // old blocks consumed by split/merge
  ambiguous: BlockMatch["ambiguous"];
  /** Indices of the cells of each table row, new side: "table:row" -> indices. */
  rowsNew: Map<string, number[]>;
}

function link(state: State, o: number, n: number, evidence: string): void {
  state.pairOld[o] = n;
  state.pairNew[n] = o;
  state.evidence[n].push(evidence);
}

function oldFree(state: State, o: number): boolean {
  return state.pairOld[o] < 0 && !state.sourceUsed.has(o);
}

function newFree(state: State, n: number): boolean {
  return state.pairNew[n] < 0 && !state.splitOf.has(n) && !state.mergeOf.has(n);
}

// ---- step 1: identical blocks ----

/** Largest segment (old × new blocks) for the exact certainty LCS; bigger segments rely on context only. */
export const LCS_CELLS = 1_000_000;

/**
 * Pairs that belong to every longest common subsequence of semantic hashes, computed independently between
 * consecutive in-order anchors (blocks with a hash unique on both sides). Linear in the number of anchors;
 * quadratic only inside a segment.
 */
function certainLcs(state: State): void {
  const a = anchors(state);
  let previousOld = -1;
  let previousNew = -1;
  const bounds: [number, number][] = [];
  a.oldToNew.forEach((n, o) => {
    if (n >= 0) bounds.push([o, n]);
  });
  bounds.push([state.O.length, state.N.length]);
  for (const [o, n] of bounds) {
    certainLcsSegment(state, previousOld + 1, o, previousNew + 1, n);
    previousOld = o;
    previousNew = n;
  }
}

function certainLcsSegment(state: State, o0: number, o1: number, n0: number, n1: number): void {
  const { O, N } = state;
  if (o1 <= o0 || n1 <= n0) return;
  const newHashes = new Set<string>();
  for (let j = n0; j < n1; j += 1) if (state.pairNew[j] < 0) newHashes.add(N[j].semanticHash);
  const oi: number[] = [];
  const oldHashes = new Set<string>();
  for (let i = o0; i < o1; i += 1) {
    if (state.pairOld[i] < 0 && newHashes.has(O[i].semanticHash)) {
      oi.push(i);
      oldHashes.add(O[i].semanticHash);
    }
  }
  const ni: number[] = [];
  for (let j = n0; j < n1; j += 1) if (state.pairNew[j] < 0 && oldHashes.has(N[j].semanticHash)) ni.push(j);
  const n = oi.length;
  const m = ni.length;
  if (!n || !m || n * m > LCS_CELLS) return;
  const W = m + 1;
  const SW = m + 2;
  const pre = new Int32Array((n + 1) * W);
  const suf = new Int32Array((n + 2) * SW);
  const eq = (x: number, y: number) => O[oi[x]].semanticHash === N[ni[y]].semanticHash;
  for (let x = 1; x <= n; x += 1) {
    for (let y = 1; y <= m; y += 1) {
      pre[x * W + y] = eq(x - 1, y - 1) ? pre[(x - 1) * W + y - 1] + 1 : Math.max(pre[(x - 1) * W + y], pre[x * W + y - 1]);
    }
  }
  for (let x = n - 1; x >= 0; x -= 1) {
    for (let y = m - 1; y >= 0; y -= 1) {
      suf[x * SW + y] = eq(x, y) ? suf[(x + 1) * SW + y + 1] + 1 : Math.max(suf[(x + 1) * SW + y], suf[x * SW + y + 1]);
    }
  }
  const L = pre[n * W + m];
  const candOld: number[][] = Array.from({ length: n }, () => []);
  const candNew: number[][] = Array.from({ length: m }, () => []);
  for (let x = 0; x < n; x += 1) {
    for (let y = 0; y < m; y += 1) {
      if (eq(x, y) && pre[x * W + y] + 1 + suf[(x + 1) * SW + y + 1] === L) {
        candOld[x].push(y);
        candNew[y].push(x);
      }
    }
  }
  const newSkippable = (y: number) => {
    for (let k = 0; k <= n; k += 1) if (pre[k * W + y] + suf[k * SW + y + 1] === L) return true;
    return false;
  };
  const oldSkippable = (x: number) => {
    for (let k = 0; k <= m; k += 1) if (pre[x * W + k] + suf[(x + 1) * SW + k] === L) return true;
    return false;
  };
  for (let y = 0; y < m; y += 1) {
    if (candNew[y].length !== 1) continue;
    const x = candNew[y][0];
    if (candOld[x].length !== 1 || newSkippable(y) || oldSkippable(x)) continue;
    link(state, oi[x], ni[y], "lcs");
  }
}

function uniqueHashes(state: State): void {
  const count = (blocks: ProjectedBlock[]) => {
    const out = new Map<string, number[]>();
    blocks.forEach((b, i) => out.set(b.semanticHash, [...(out.get(b.semanticHash) ?? []), i]));
    return out;
  };
  const co = count(state.O);
  const cn = count(state.N);
  for (const [hash, olds] of co) {
    const news = cn.get(hash);
    if (!news) continue;
    if (olds.length === 1 && news.length === 1 && state.pairOld[olds[0]] < 0 && state.pairNew[news[0]] < 0) link(state, olds[0], news[0], "unique-hash");
  }
}

/** Context score of pairing old o with new n: section 2, each matching neighbour 1, a matched row-mate 2. */
function contextScore(state: State, o: number, n: number): number {
  const { O, N, pairNew } = state;
  const so = O[o].headings.length ? O[o].headings[O[o].headings.length - 1] : -1;
  const hn = N[n].headings.length ? N[n].headings[N[n].headings.length - 1] : -1;
  const sn = hn < 0 ? -1 : pairNew[hn] >= 0 ? pairNew[hn] : -2;
  let score = so === sn ? 2 : 0;
  if (n === 0 ? o === 0 : o > 0 && pairNew[n - 1] === o - 1) score += 1;
  if (n === N.length - 1 ? o === O.length - 1 : o < O.length - 1 && pairNew[n + 1] === o + 1) score += 1;
  const cn = N[n].cell;
  const co = O[o].cell;
  if (cn && co) {
    for (const k of state.rowsNew.get(`${cn.table}:${cn.row}`) ?? []) {
      if (k === n || pairNew[k] < 0) continue;
      const mate = O[pairNew[k]].cell;
      if (mate && mate.table === co.table && mate.row === co.row) {
        score += 2;
        break;
      }
    }
  }
  return score;
}

function duplicates(state: State): void {
  const { O, N } = state;
  for (let round = 0; round < 50; round += 1) {
    let changed = false;
    const groups = new Map<string, { olds: number[]; news: number[] }>();
    O.forEach((b, o) => {
      if (state.pairOld[o] >= 0) return;
      const g = groups.get(b.semanticHash) ?? { olds: [], news: [] };
      g.olds.push(o);
      groups.set(b.semanticHash, g);
    });
    N.forEach((b, n) => {
      if (state.pairNew[n] >= 0) return;
      const g = groups.get(b.semanticHash);
      if (g) g.news.push(n);
    });
    for (const g of groups.values()) {
      if (!g.olds.length || !g.news.length) continue;
      if (g.olds.length === 1 && g.news.length === 1) {
        link(state, g.olds[0], g.news[0], "remaining-copy");
        changed = true;
        continue;
      }
      const score = new Map<string, number>();
      for (const o of g.olds) for (const n of g.news) score.set(`${o}:${n}`, contextScore(state, o, n));
      const accepted: [number, number][] = [];
      for (const o of g.olds) {
        for (const n of g.news) {
          const s = score.get(`${o}:${n}`) as number;
          if (s < 2) continue;
          const bestForN = g.olds.every((x) => x === o || (score.get(`${x}:${n}`) as number) < s);
          const bestForO = g.news.every((y) => y === n || (score.get(`${o}:${y}`) as number) < s);
          if (bestForN && bestForO) accepted.push([o, n]);
        }
      }
      for (const [o, n] of accepted) {
        if (state.pairOld[o] >= 0 || state.pairNew[n] >= 0) continue;
        link(state, o, n, "context");
        changed = true;
      }
    }
    if (!changed) break;
  }
  // What is left on both sides of a hash group could not be told apart.
  const left = new Map<string, { olds: number[]; news: number[] }>();
  O.forEach((b, o) => {
    if (state.pairOld[o] < 0) left.set(b.semanticHash, { olds: [...(left.get(b.semanticHash)?.olds ?? []), o], news: [] });
  });
  N.forEach((b, n) => {
    const g = left.get(b.semanticHash);
    if (g && state.pairNew[n] < 0) g.news.push(n);
  });
  for (const g of left.values()) if (g.olds.length && g.news.length) state.ambiguous.push({ old: g.olds, next: g.news, reason: "duplicate" });
}

// ---- anchors and gaps ----

/** Longest increasing subsequence of old indices over pairs in new order; deterministic. */
export function lisPairs(pairs: [number, number][]): Set<number> {
  // pairs: [old, new] sorted by new; returns the set of new indices on the LIS.
  const tails: number[] = [];
  const prev: number[] = new Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k += 1) {
    const value = pairs[k][0];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (pairs[tails[mid]][0] < value) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1];
    tails[lo] = k;
  }
  const out = new Set<number>();
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k >= 0) {
    out.add(pairs[k][1]);
    k = prev[k];
  }
  return out;
}

interface Anchors {
  /** For each old index, new index if it is an in-order anchor, else -1. */
  oldToNew: Int32Array;
  newToOld: Int32Array;
}

function anchors(state: State): Anchors {
  const pairs: [number, number][] = [];
  state.pairNew.forEach((o, n) => {
    if (o >= 0) pairs.push([o, n]);
  });
  const onLis = lisPairs(pairs);
  const oldToNew = new Int32Array(state.O.length).fill(-1);
  const newToOld = new Int32Array(state.N.length).fill(-1);
  for (const [o, n] of pairs) {
    if (!onLis.has(n)) continue;
    oldToNew[o] = n;
    newToOld[n] = o;
  }
  return { oldToNew, newToOld };
}

/** Open interval of new indices between the anchors around old block o. */
function gapOfOld(a: Anchors, o: number, newLength: number): [number, number] {
  let lo = -1;
  for (let k = o - 1; k >= 0; k -= 1) if (a.oldToNew[k] >= 0) {
    lo = a.oldToNew[k];
    break;
  }
  let hi = newLength;
  for (let k = o + 1; k < a.oldToNew.length; k += 1) if (a.oldToNew[k] >= 0) {
    hi = a.oldToNew[k];
    break;
  }
  return [lo, hi];
}

function gapOfNew(a: Anchors, n: number, oldLength: number): [number, number] {
  let lo = -1;
  for (let k = n - 1; k >= 0; k -= 1) if (a.newToOld[k] >= 0) {
    lo = a.newToOld[k];
    break;
  }
  let hi = oldLength;
  for (let k = n + 1; k < a.newToOld.length; k += 1) if (a.newToOld[k] >= 0) {
    hi = a.newToOld[k];
    break;
  }
  return [lo, hi];
}

// ---- step 2: split and merge ----

function splitsAndMerges(state: State): void {
  const { O, N } = state;
  const a = anchors(state);
  const textOf = (blocks: ProjectedBlock[], idx: number[]) => idx.map((i) => blocks[i].text).join(" ");
  // Split: one old block -> consecutive new blocks.
  for (let o = 0; o < O.length; o += 1) {
    if (!oldFree(state, o) || !SPLITTABLE.has(O[o].type) || words(O[o].text).length < MATCH.splitMinWords) continue;
    const [lo, hi] = gapOfOld(a, o, N.length);
    let best: { run: number[]; coverage: number } | null = null;
    let tie = false;
    for (let x = lo + 1; x < hi; x += 1) {
      const run: number[] = [];
      for (let y = x; y < hi && run.length < MATCH.maxPieces; y += 1) {
        if (!newFree(state, y) || !SPLITTABLE.has(N[y].type) || containment(N[y].text, O[o].text) < MATCH.pieceContainment) break;
        run.push(y);
        if (run.length < 2) continue;
        const coverage = similarity(O[o].text, textOf(N, run));
        const single = Math.max(...run.map((y2) => similarity(O[o].text, N[y2].text)));
        if (coverage < MATCH.coverage || coverage < single + MATCH.splitGain) continue;
        if (!best || coverage > best.coverage) {
          best = { run: [...run], coverage };
          tie = false;
        } else if (coverage === best.coverage) tie = true;
      }
    }
    if (best && !tie) {
      for (const y of best.run) {
        state.splitOf.set(y, o);
        state.evidence[y].push("split", `similarity:${Math.round(best.coverage * 100)}`);
      }
      state.sourceUsed.add(o);
    }
  }
  // Merge: consecutive old blocks -> one new block.
  for (let n = 0; n < N.length; n += 1) {
    if (!newFree(state, n) || !SPLITTABLE.has(N[n].type) || words(N[n].text).length < MATCH.splitMinWords) continue;
    const [lo, hi] = gapOfNew(a, n, O.length);
    let best: { run: number[]; coverage: number } | null = null;
    let tie = false;
    for (let x = lo + 1; x < hi; x += 1) {
      const run: number[] = [];
      for (let y = x; y < hi && run.length < MATCH.maxPieces; y += 1) {
        if (!oldFree(state, y) || !SPLITTABLE.has(O[y].type) || containment(O[y].text, N[n].text) < MATCH.pieceContainment) break;
        run.push(y);
        if (run.length < 2) continue;
        const coverage = similarity(textOf(O, run), N[n].text);
        const single = Math.max(...run.map((y2) => similarity(O[y2].text, N[n].text)));
        if (coverage < MATCH.coverage || coverage < single + MATCH.splitGain) continue;
        if (!best || coverage > best.coverage) {
          best = { run: [...run], coverage };
          tie = false;
        } else if (coverage === best.coverage) tie = true;
      }
    }
    if (best && !tie) {
      state.mergeOf.set(n, best.run);
      for (const y of best.run) state.sourceUsed.add(y);
      state.evidence[n].push("merge", `similarity:${Math.round(best.coverage * 100)}`);
    }
  }
}

// ---- step 3: edited blocks ----

function attrsSimilarity(a: ProjectedBlock, b: ProjectedBlock): number {
  if (a.type === "image") {
    const img = (block: ProjectedBlock) => {
      const token = block.fingerprint.inline.find((t) => typeof t === "object" && t !== null && "image" in t) as { image: { alt: string; url: string } } | undefined;
      return token?.image ?? { alt: "", url: "" };
    };
    const x = img(a);
    const y = img(b);
    return (x.url && x.url === y.url) || (x.alt && x.alt === y.alt) ? 0.75 : 0;
  }
  if (!a.text && !b.text) return 0;
  return similarity(a.text, b.text);
}

function edits(state: State): void {
  const { O, N } = state;
  for (let round = 0; round < 50; round += 1) {
    const a = anchors(state);
    const olds = O.map((_, o) => o).filter((o) => oldFree(state, o));
    const news = N.map((_, n) => n).filter((n) => newFree(state, n));
    if (!olds.length || !news.length) return;
    const sim = new Map<string, number>();
    const valid = new Map<string, string>();
    for (const o of olds) {
      const [lo, hi] = gapOfOld(a, o, N.length);
      const inGapSameType = news.filter((n) => n > lo && n < hi && N[n].type === O[o].type);
      for (const n of news) {
        if (N[n].type !== O[o].type) continue;
        const s = attrsSimilarity(O[o], N[n]);
        sim.set(`${o}:${n}`, s);
        const inGap = n > lo && n < hi;
        let threshold: number = inGap ? MATCH.edited : MATCH.movedEdited;
        let reason = inGap ? "gap" : "moved";
        if (inGap && inGapSameType.length === 1) {
          const [olo, ohi] = gapOfNew(a, n, O.length);
          const back = olds.filter((x) => x > olo && x < ohi && O[x].type === N[n].type);
          if (back.length === 1 && back[0] === o) {
            threshold = O[o].type === "heading" ? 0 : MATCH.gapSubstitution;
            reason = "gap-substitution";
          }
        }
        if (s >= threshold && (s > 0 || reason === "gap-substitution")) valid.set(`${o}:${n}`, reason);
      }
    }
    const accepted: [number, number, string][] = [];
    for (const [key, reason] of valid) {
      const [o, n] = key.split(":").map(Number);
      const s = sim.get(key) as number;
      const competitorsOfO = news.filter((y) => y !== n && sim.has(`${o}:${y}`)).map((y) => sim.get(`${o}:${y}`) as number);
      const competitorsOfN = olds.filter((x) => x !== o && sim.has(`${x}:${n}`)).map((x) => sim.get(`${x}:${n}`) as number);
      // Clear winner: every competitor (either direction) is noise or at least `margin` behind.
      const clear = [...competitorsOfO, ...competitorsOfN].every((v) => v < MATCH.noise || s - v >= MATCH.margin);
      if (clear) accepted.push([o, n, reason]);
      else if (s >= MATCH.edited && !clear) {
        const tied = [n, ...news.filter((y) => y !== n && (sim.get(`${o}:${y}`) ?? 0) > s - MATCH.margin && (sim.get(`${o}:${y}`) ?? 0) >= MATCH.noise)];
        if (!state.ambiguous.some((x) => x.reason === "similar" && x.old.includes(o))) state.ambiguous.push({ old: [o], next: tied.sort((p, q) => p - q), reason: "similar" });
      }
    }
    accepted.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    let changed = false;
    for (const [o, n, reason] of accepted) {
      if (state.pairOld[o] >= 0 || state.pairNew[n] >= 0) continue;
      link(state, o, n, reason);
      state.evidence[n].push(`similarity:${Math.round((sim.get(`${o}:${n}`) as number) * 100)}`);
      changed = true;
    }
    if (!changed) return;
  }
}

/** Match the blocks of two projections. Only uses blocks (text, hashes, types, headings, table cells). */
/** A masked secret value (W-06c, §8): the fixed mask, possibly once per line of a multi-line value. */
export function isMaskedValue(block: ProjectedBlock): boolean {
  if (block.type !== "node" && block.type !== "line") return false;
  const value = block.fingerprint.inline.length === 1 && typeof block.fingerprint.inline[0] === "string" ? block.fingerprint.inline[0] : null;
  return value !== null && /^(?:•{8}|\s)+$/.test(value) && value.includes("••••••••");
}

/** Identity of a value block apart from its value: the key path (structured) or the variable (.env). */
function valueIdentity(block: ProjectedBlock): string | null {
  const attrs = block.fingerprint.attrs;
  if (block.type === "node" && typeof attrs.path === "string") return `node:${attrs.path}`;
  if (block.type === "line" && attrs.kind === "pair" && typeof attrs.key === "string") return `pair:${attrs.key}`;
  return null;
}

/** True when two blocks differ only by masking (a value became masked or unmasked under other rules): not an edit. */
export function maskOnlyChange(a: ProjectedBlock, b: ProjectedBlock): boolean {
  const id = valueIdentity(a);
  return id !== null && id === valueIdentity(b) && (isMaskedValue(a) || isMaskedValue(b));
}

/**
 * Step between exact matches and edits (W-06c): a masked value and its unmasked counterpart at the same key path or
 * .env variable are the same block, uniquely on both sides. Markdown blocks never have such an identity.
 */
function maskedCounterparts(state: State): void {
  const olds = new Map<string, number[]>();
  state.O.forEach((block, o) => {
    if (state.pairOld[o] >= 0) return;
    const id = valueIdentity(block);
    if (id) olds.set(id, [...(olds.get(id) ?? []), o]);
  });
  const news = new Map<string, number[]>();
  state.N.forEach((block, n) => {
    if (!newFree(state, n)) return;
    const id = valueIdentity(block);
    if (id) news.set(id, [...(news.get(id) ?? []), n]);
  });
  for (const [id, list] of news) {
    const candidates = olds.get(id) ?? [];
    if (list.length !== 1 || candidates.length !== 1) continue;
    const [n] = list;
    const [o] = candidates;
    if (oldFree(state, o) && maskOnlyChange(state.O[o], state.N[n])) link(state, o, n, "masked");
  }
}

export function matchProjected(O: ProjectedBlock[], N: ProjectedBlock[]): BlockMatch {
  const state: State = {
    O,
    N,
    pairOld: new Int32Array(O.length).fill(-1),
    pairNew: new Int32Array(N.length).fill(-1),
    evidence: N.map(() => []),
    splitOf: new Map(),
    mergeOf: new Map(),
    sourceUsed: new Set(),
    ambiguous: [],
    rowsNew: new Map(),
  };
  N.forEach((block, n) => {
    if (block.cell) {
      const key = `${block.cell.table}:${block.cell.row}`;
      state.rowsNew.set(key, [...(state.rowsNew.get(key) ?? []), n]);
    }
  });
  uniqueHashes(state);
  certainLcs(state);
  duplicates(state);
  maskedCounterparts(state);
  splitsAndMerges(state);
  edits(state);

  const a = anchors(state);
  const next: BlockLink[] = N.map((block, n) => {
    const o = state.pairNew[n];
    if (o >= 0) {
      const same = O[o].semanticHash === block.semanticHash;
      const inOrder = a.newToOld[n] === o;
      const kind: MatchKind = same ? (inOrder ? "same" : "moved") : inOrder ? "edited" : "moved-edited";
      return { kind, old: [o], evidence: state.evidence[n] };
    }
    const split = state.splitOf.get(n);
    if (split !== undefined) return { kind: "split", old: [split], evidence: state.evidence[n] };
    const merge = state.mergeOf.get(n);
    if (merge) return { kind: "merge", old: merge, evidence: state.evidence[n] };
    return { kind: "new", old: [], evidence: [] };
  });
  const removed = O.map((_, o) => o).filter((o) => state.pairOld[o] < 0 && !state.sourceUsed.has(o));
  const ambiguous = state.ambiguous.filter((x) => x.old.some((o) => state.pairOld[o] < 0) || x.next.some((n) => state.pairNew[n] < 0));
  return { next, removed, ambiguous };
}

/** Match a stored revision (with the projection of its snapshot) against a new projection. */
export function matchBlocks(old: { revision: Revision; projection: Projection }, next: Projection): BlockMatch {
  assertConsistent(old.revision, old.projection);
  return matchProjected(old.projection.blocks, next.blocks);
}

/** A stored revision must describe exactly the blocks of its snapshot's projection. */
export function assertConsistent(revision: Revision, projection: Projection): void {
  if (revision.blocks.length !== projection.blocks.length) {
    throw new Error(`revision ${revision.revisionId}: ${revision.blocks.length} blocks stored, snapshot projects ${projection.blocks.length}`);
  }
  revision.blocks.forEach((block, i) => {
    if (block.semanticHash !== projection.blocks[i].semanticHash) throw new Error(`revision ${revision.revisionId}: block ${i} does not match its snapshot`);
  });
}
