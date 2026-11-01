// Anchoring and diff of non-Markdown formats (W-06c, file-types.md §7). The core resolution (lineage → origin →
// quote search, never a false exact) stays the authority; the key path and the line range only add evidence:
//  - a structured target whose key path still holds the same value is mapped there (reordering, insertions around);
//  - a target whose lineage continues one-to-one at the same key path or with the same value (the key renamed) is
//    mapped, not approximate: a comment on a key follows the key;
//  - a line-range target that nothing else can place is shown approximately on those lines.
// Structural diff: reordering keys of an object is not a change; the order of array elements is.

import { type AnchorResolution, type AnchorTarget, resolveAnchor } from "../markdown/anchoring.ts";
import { type BlockChange, semanticDiff } from "../markdown/diff.ts";
import { maskOnlyChange } from "../markdown/lineage.ts";
import type { Projection } from "../markdown/projection.ts";
import type { Revision } from "../types.ts";
import { identityPath, keyPathString, type PathSegment } from "./assemble.ts";
import type { FileProjection } from "./project.ts";

export interface FormatTarget extends AnchorTarget {
  /** bbdr:KeyPathSelector — JSON array of path segments. */
  keyPath?: string | null;
  /** bbdr:LineRangeSelector — 1-based inclusive lines of the raw source. */
  lineRange?: { start: number; end: number } | null;
}

type Side = { revision: Revision; projection: Projection };

function metaOf(projection: Projection): FileProjection["meta"] {
  return (projection as Partial<FileProjection>).meta ?? [];
}

function pathKeyOf(projection: Projection, index: number): string | null {
  const path = metaOf(projection)[index]?.path;
  return path ? keyPathString(path) : null;
}

/** Blocks of `projection` whose raw source overlaps 1-based lines [start, end]. */
export function blocksOnLines(projection: Projection, lines: { start: number; end: number }): number[] {
  const coords = projection.sourceCoords;
  const out: number[] = [];
  projection.blocks.forEach((block, index) => {
    if (block.source.end <= block.source.start && block.range.start === block.range.end) return;
    const first = coords.cpToLineCol(Math.min(block.source.start, coords.length)).line;
    const last = coords.cpToLineCol(Math.max(block.source.start, Math.min(block.source.end, coords.length) - (block.source.end > block.source.start ? 1 : 0))).line;
    if (last >= lines.start && first <= lines.end) out.push(index);
  });
  return out;
}

/** 1-based line range of a projected range's raw source. */
export function linesOf(projection: Projection, sourceStart: number, sourceEnd: number): { start: number; end: number } {
  const coords = projection.sourceCoords;
  const start = coords.cpToLineCol(Math.min(sourceStart, coords.length)).line;
  const end = coords.cpToLineCol(Math.max(sourceStart, Math.min(sourceEnd, coords.length) - (sourceEnd > sourceStart ? 1 : 0))).line;
  return { start, end };
}

export function resolveFormatAnchor(target: FormatTarget, current: Side): AnchorResolution {
  const core = resolveAnchor(target, current);
  if (core.status === "exact" || core.status === "mapped") return core;
  const revisionId = current.revision.revisionId;
  const targetBlockIndex = target.projection.blocks.findIndex((block) => block.range.start <= target.range.start && target.range.end <= block.range.end && block.range.end > block.range.start);
  const targetBlock = targetBlockIndex >= 0 ? target.revision.blocks[targetBlockIndex] : null;
  const wholeBlock = targetBlockIndex >= 0 && target.projection.blocks[targetBlockIndex].range.start === target.range.start && target.projection.blocks[targetBlockIndex].range.end === target.range.end;

  if (target.keyPath && targetBlock) {
    // 1. The same key path with the same value (identity hash) in the current revision.
    // Only for paths without array indices: after an insertion an index names another element (no false mapped).
    const indexed = /[[,]\d/.test(target.keyPath);
    const byPath = indexed ? -1 : current.projection.blocks.findIndex((_, index) => pathKeyOf(current.projection, index) === target.keyPath);
    if (byPath >= 0 && current.projection.blocks[byPath].semanticHash === target.projection.blocks[targetBlockIndex].semanticHash && wholeBlock) {
      const range = { ...current.projection.blocks[byPath].range };
      return { status: "mapped", revisionId, ranges: [range], place: null, evidence: ["key-path", "same-value"], candidates: [{ range, score: 100, evidence: ["key-path"] }] };
    }
    // 2. The lineage continues one-to-one at the same key path (value changed) or with the same value (key renamed).
    const continued = current.revision.blocks.findIndex((block) => block.lineageId === targetBlock.lineageId);
    if (continued >= 0 && wholeBlock) {
      const samePath = pathKeyOf(current.projection, continued) === target.keyPath;
      const sameValue = JSON.stringify(current.projection.blocks[continued].fingerprint.inline) === JSON.stringify(target.projection.blocks[targetBlockIndex].fingerprint.inline);
      if (samePath || sameValue) {
        const range = { ...current.projection.blocks[continued].range };
        return { status: "mapped", revisionId, ranges: [range], place: null, evidence: ["lineage", samePath ? "key-path" : "renamed-key"], candidates: [{ range, score: 90, evidence: ["lineage"] }] };
      }
    }
  }
  if (core.status === "orphaned" && !core.ranges.length && target.lineRange && !target.keyPath) {
    const blocks = blocksOnLines(current.projection, target.lineRange);
    if (blocks.length) {
      const ranges = blocks.map((index) => ({ ...current.projection.blocks[index].range }));
      return { status: "approximate", revisionId, ranges, place: { block: blocks[0] }, evidence: [...core.evidence, "line-range"], candidates: ranges.map((range) => ({ range, score: 30, evidence: ["line-range"] })) };
    }
  }
  return core;
}

/** Diff of two revisions of one file; for structured files reordering object keys is not a change (§7). */
export function formatDiff(base: Side, current: Side): BlockChange[] {
  // A value masked or unmasked by other rules (§8) is not an edit in any format.
  const changes = semanticDiff(base, current).flatMap((change) => {
    if (change.current === null || change.base.length !== 1 || !change.kinds.includes("edited")) return [change];
    if (!maskOnlyChange(base.projection.blocks[change.base[0]], current.projection.blocks[change.current])) return [change];
    const kinds = change.kinds.filter((kind) => kind !== "edited");
    return kinds.length ? [{ ...change, kinds }] : [];
  });
  if (current.projection.profile !== "bbdr-structured") return changes;
  const meta = metaOf(current.projection);
  return changes.flatMap((change) => {
    if (change.current === null || !change.kinds.includes("moved")) return [change];
    const path = meta[change.current]?.path as PathSegment[] | undefined;
    const last = path?.[path.length - 1];
    // An object member that only moved among its siblings: not a change. An array element keeps its «moved».
    if (typeof last === "number") return [change];
    const kinds = change.kinds.filter((kind) => kind !== "moved");
    return kinds.length ? [{ ...change, kinds }] : [];
  });
}

/** Identity of a structured block for tests and views: path with indices erased. */
export function identityOf(projection: Projection, index: number): string | null {
  const path = metaOf(projection)[index]?.path;
  return path ? identityPath(path) : null;
}
