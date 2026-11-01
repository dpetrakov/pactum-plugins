// Semantic block diff between two persistent revisions and the raw line diff (projection.md «Diff»).
// Pure functions of revisions + snapshots: recomputed identically after every cache is dropped.

import { createTwoFilesPatch, diffArrays } from "diff";
import type { Placement, Revision } from "../types.ts";
import { assertConsistent, lisPairs, matchProjected } from "./lineage.ts";
import type { Projection } from "./projection.ts";
import { isSpace, isWord, tokenize } from "./tokens.ts";

export type ChangeKind = "added" | "edited" | "moved" | "removed";

export interface WordOp {
  op: "equal" | "insert" | "delete";
  text: string;
}

export interface BlockChange {
  /** Ordered as added, edited, moved, removed; a moved and edited block has both. */
  kinds: ChangeKind[];
  /** Current lineage, or the removed lineage of the base. */
  lineageId: string;
  /** Block index in the current revision; null for removed. */
  current: number | null;
  /** Base blocks this change compares with (one; several for a merge; empty for added). */
  base: number[];
  before: { text: string; section: string | null } | null;
  after: { text: string } | null;
  words: WordOp[] | null;
  /** Too much text changed for an inline diff; use Before/After. */
  rewritten: boolean;
  /** Removed only: last place by surviving neighbours of the current revision. */
  place: Placement | null;
  /** How the base was found: same lineage, split/merge origin, or content match of otherwise unlinked blocks. */
  link: "lineage" | "split" | "merge" | "content" | null;
  /** Projected text differs (false for URL/list state/attribute-only edits). */
  textChanged: boolean;
}

/** Fraction of changed words above which the block uses a Before/After comparison. */
export const REWRITE_THRESHOLD = 0.5;

const ORDER: ChangeKind[] = ["added", "edited", "moved", "removed"];

/** Word-level ops between two block texts (tokens of tokens.ts, Myers diff), and the rewrite decision. */
export function blockDiff(before: string, after: string): { words: WordOp[]; rewritten: boolean } {
  const a = tokenize(before);
  const b = tokenize(after);
  const raw = diffArrays(a, b);
  type Op = { op: WordOp["op"]; tokens: string[] };
  const ops: Op[] = raw.map((c) => ({ op: c.added ? "insert" : c.removed ? "delete" : "equal", tokens: [...c.value] }));
  // Whitespace kept between two changes belongs to the change: "a b" -> "x y" reads as one replacement.
  for (let i = 1; i + 1 < ops.length; i += 1) {
    if (ops[i].op === "equal" && ops[i].tokens.every(isSpace) && ops[i - 1].op !== "equal" && ops[i + 1].op !== "equal") {
      const tokens = ops[i].tokens;
      ops.splice(i, 1, { op: "delete", tokens }, { op: "insert", tokens: [...tokens] });
    }
  }
  // Coalesce each run of changes into one delete followed by one insert.
  const words: WordOp[] = [];
  let del = "";
  let ins = "";
  let carry = "";
  const pushEqual = (text: string) => {
    const last = words[words.length - 1];
    if (last && last.op === "equal") last.text += text;
    else words.push({ op: "equal", text });
  };
  const flush = () => {
    if (del && ins) {
      // Whitespace shared by both sides of a replacement belongs to the unchanged text around it.
      const lead = /^\s*/u.exec(del)?.[0] ?? "";
      const head = lead && ins.startsWith(lead) ? lead : "";
      if (head) {
        pushEqual(head);
        del = del.slice(head.length);
        ins = ins.slice(head.length);
      }
      const tailDel = /\s*$/u.exec(del)?.[0] ?? "";
      const tail = tailDel && ins.endsWith(tailDel) && del.length > tailDel.length && ins.length > tailDel.length ? tailDel : "";
      if (tail) {
        del = del.slice(0, -tail.length);
        ins = ins.slice(0, -tail.length);
        carry = tail;
      }
    }
    if (del) words.push({ op: "delete", text: del });
    if (ins) words.push({ op: "insert", text: ins });
    if (carry) pushEqual(carry);
    del = "";
    ins = "";
    carry = "";
  };
  for (const op of ops) {
    const text = op.tokens.join("");
    if (!text) continue;
    if (op.op === "equal") {
      flush();
      pushEqual(text);
    } else if (op.op === "delete") del += text;
    else ins += text;
  }
  flush();
  let changed = 0;
  let total = 0;
  for (const op of ops) {
    const count = op.tokens.filter(isWord).length;
    if (op.op === "equal") total += 2 * count;
    else {
      total += count;
      changed += count;
    }
  }
  return { words, rewritten: total > 0 && changed / total > REWRITE_THRESHOLD };
}

/** Unified diff of the raw Markdown sources, independent of the semantic diff. */
export function rawDiff(beforeSource: string, afterSource: string, names: { before?: string; after?: string } = {}): string {
  return createTwoFilesPatch(names.before ?? "before", names.after ?? "after", beforeSource, afterSource, "", "", { context: 3 });
}

/** For a split: the part of the source text that went into each piece (word alignment over the joined pieces). */
export function splitPortions(source: string, pieces: string[]): string[] {
  const SEP = "\u0000";
  const a = tokenize(source);
  const b: string[] = [];
  pieces.forEach((piece, k) => {
    if (k) b.push(SEP);
    b.push(...tokenize(piece));
  });
  const out = pieces.map(() => "");
  let piece = 0;
  for (const op of diffArrays(a, b)) {
    for (const token of op.value) {
      if (op.added) {
        if (token === SEP) piece += 1;
        continue;
      }
      out[Math.min(piece, pieces.length - 1)] += token;
    }
  }
  return out.map((text) => text.trim());
}

function sectionText(p: Projection, block: number): string | null {
  const headings = p.blocks[block].headings;
  return headings.length ? p.blocks[headings[headings.length - 1]].text : null;
}

interface Side {
  revision: Revision;
  projection: Projection;
}

/**
 * Changes from a base revision to the current one, per lineage, in reading order (removed blocks after their
 * surviving predecessor). Unchanged blocks are omitted. A→B→C without reading is semanticDiff(A, C); a block whose
 * semanticHash equals the base is unchanged even if its versionId differs (C = A).
 */
export function semanticDiff(base: Side, current: Side): BlockChange[] {
  assertConsistent(base.revision, base.projection);
  assertConsistent(current.revision, current.projection);
  const B = base.revision.blocks;
  const C = current.revision.blocks;
  const baseByLineage = new Map(B.map((b, i) => [b.lineageId, i]));
  type Link = { kind: "lineage" | "split" | "merge" | "content"; base: number[] };
  const links: (Link | null)[] = C.map((block) => {
    const same = baseByLineage.get(block.lineageId);
    if (same !== undefined) return { kind: "lineage", base: [same] };
    if (block.origin) {
      const sources = block.origin.sources.map((s) => baseByLineage.get(s.lineageId)).filter((i): i is number => i !== undefined);
      if (sources.length) return { kind: block.origin.kind, base: sources.sort((x, y) => x - y) };
    }
    return null;
  });
  const used = new Set(links.flatMap((l) => l?.base ?? []));
  // Content match for what lineage cannot explain (e.g. a block deleted and restored in a later revision).
  if (links.some((l) => !l) && B.some((_, i) => !used.has(i))) {
    const match = matchProjected(base.projection.blocks, current.projection.blocks);
    match.next.forEach((m, j) => {
      if (links[j] || !m.old.length || m.old.some((o) => used.has(o))) return;
      if (m.kind === "split") {
        links[j] = { kind: "split", base: [...m.old] };
      } else if (m.kind === "merge") {
        links[j] = { kind: "merge", base: [...m.old] };
      } else if (m.kind !== "new") {
        links[j] = { kind: "content", base: [...m.old] };
      } else return;
    });
    for (const l of links) for (const i of l?.base ?? []) used.add(i);
  }
  // Moved: one-to-one links off the longest in-order chain.
  const pairs: [number, number][] = [];
  links.forEach((l, j) => {
    if (l && (l.kind === "lineage" || l.kind === "content")) pairs.push([l.base[0], j]);
  });
  const inOrder = lisPairs(pairs);
  // Pieces of one split, in order, to share the source text between them.
  const piecesOf = new Map<number, number[]>();
  links.forEach((l, j) => {
    if (l?.kind === "split") piecesOf.set(l.base[0], [...(piecesOf.get(l.base[0]) ?? []), j]);
  });

  const changes: BlockChange[] = [];
  const currentChanges = new Map<number, BlockChange>();
  C.forEach((block, j) => {
    const l = links[j];
    const text = current.projection.blocks[j].text;
    if (!l) {
      currentChanges.set(j, { kinds: ["added"], lineageId: block.lineageId, current: j, base: [], before: null, after: { text }, words: null, rewritten: false, place: null, link: null, textChanged: true });
      return;
    }
    if (l.kind === "lineage" || l.kind === "content") {
      const b = l.base[0];
      const edited = B[b].semanticHash !== block.semanticHash;
      const moved = !inOrder.has(j);
      if (!edited && !moved) return;
      const kinds = ORDER.filter((k) => (k === "edited" && edited) || (k === "moved" && moved));
      const beforeText = base.projection.blocks[b].text;
      const diff = edited ? blockDiff(beforeText, text) : null;
      currentChanges.set(j, {
        kinds,
        lineageId: block.lineageId,
        current: j,
        base: [b],
        before: { text: beforeText, section: sectionText(base.projection, b) },
        after: { text },
        words: diff ? diff.words : null,
        rewritten: diff ? diff.rewritten : false,
        place: null,
        link: l.kind,
        textChanged: beforeText !== text,
      });
      return;
    }
    let beforeText: string;
    if (l.kind === "split") {
      const pieces = piecesOf.get(l.base[0]) ?? [j];
      const portions = splitPortions(base.projection.blocks[l.base[0]].text, pieces.map((k) => current.projection.blocks[k].text));
      beforeText = portions[pieces.indexOf(j)] ?? base.projection.blocks[l.base[0]].text;
    } else beforeText = l.base.map((b) => base.projection.blocks[b].text).join(" ");
    const diff = blockDiff(beforeText, text);
    currentChanges.set(j, {
      kinds: ["edited"],
      lineageId: block.lineageId,
      current: j,
      base: [...l.base],
      before: { text: beforeText, section: sectionText(base.projection, l.base[0]) },
      after: { text },
      words: diff.words,
      rewritten: diff.rewritten,
      place: null,
      link: l.kind,
      textChanged: beforeText !== text,
    });
  });

  // Removed base blocks, placed after their nearest surviving predecessor.
  const survivorOf = new Map<number, number>();
  links.forEach((l, j) => {
    if (l && (l.kind === "lineage" || l.kind === "content")) survivorOf.set(l.base[0], j);
    else if (l) for (const b of l.base) if (!survivorOf.has(b)) survivorOf.set(b, j);
  });
  const removedAfter = new Map<number, BlockChange[]>();
  B.forEach((block, b) => {
    if (used.has(b)) return;
    let after: number | null = null;
    for (let k = b - 1; k >= 0; k -= 1) if (survivorOf.has(k)) {
      after = survivorOf.get(k) as number;
      break;
    }
    let before: number | null = null;
    for (let k = b + 1; k < B.length; k += 1) if (survivorOf.has(k)) {
      before = survivorOf.get(k) as number;
      break;
    }
    let section: number | null = null;
    const headings = base.projection.blocks[b].headings;
    for (let k = headings.length - 1; k >= 0; k -= 1) if (survivorOf.has(headings[k])) {
      section = survivorOf.get(headings[k]) as number;
      break;
    }
    const change: BlockChange = {
      kinds: ["removed"],
      lineageId: block.lineageId,
      current: null,
      base: [b],
      before: { text: base.projection.blocks[b].text, section: sectionText(base.projection, b) },
      after: null,
      words: null,
      rewritten: false,
      place: {
        afterLineageId: after === null ? null : C[after].lineageId,
        beforeLineageId: before === null ? null : C[before].lineageId,
        sectionLineageId: section === null ? null : C[section].lineageId,
      },
      link: null,
      textChanged: true,
    };
    const key = after ?? -1;
    removedAfter.set(key, [...(removedAfter.get(key) ?? []), change]);
  });
  changes.push(...(removedAfter.get(-1) ?? []));
  C.forEach((_, j) => {
    const change = currentChanges.get(j);
    if (change) changes.push(change);
    changes.push(...(removedAfter.get(j) ?? []));
  });
  return changes;
}
