// Range rules of annotation targets and read scopes (EP-008-T04). Pure: the host computes them from the
// projection of the shown revision, the client only names a kind and a block; a client range is never trusted.
import type { CpRange } from "./types.ts";

interface BlockLike {
  type: string;
  range: CpRange;
  headings: number[];
}

/**
 * Blocks of the section opened by heading `index`: the heading itself and every following block until the next
 * heading of the same or a higher level (nested sections included). Nesting comes from the projection's
 * `headings` (indices of enclosing headings), so a heading inside a list or quote does not open a section.
 */
export function sectionBlocks(blocks: BlockLike[], index: number): number[] {
  if (index < 0 || index >= blocks.length || blocks[index].type !== "heading") return [];
  const result = [index];
  for (let next = index + 1; next < blocks.length; next++) {
    if (!blocks[next].headings.includes(index)) break;
    result.push(next);
  }
  return result;
}

/** Projection range covering a run of blocks (first start to last end). */
export function spanOf(blocks: BlockLike[], indices: number[]): CpRange {
  if (!indices.length) return { start: 0, end: 0 };
  return { start: blocks[indices[0]].range.start, end: blocks[indices[indices.length - 1]].range.end };
}

export type TargetRequest =
  | { kind: "text"; range: CpRange; quote: string }
  | { kind: "block"; block: number }
  | { kind: "section"; block: number }
  | { kind: "document" }
  | { kind: "change"; block: number }
  | { kind: "change"; tombstoneId: string };

/** Range of a non-tombstone target in the shown projection, or an error message. */
export function targetRange(blocks: BlockLike[], textLength: number, target: Exclude<TargetRequest, { tombstoneId: string }>): CpRange | string {
  switch (target.kind) {
    case "text":
      if (target.range.end < target.range.start || target.range.end > textLength) return "range outside the shown revision";
      if (target.range.end === target.range.start) return "empty selection";
      return target.range;
    case "block":
    case "change":
      if (!Number.isInteger(target.block) || target.block < 0 || target.block >= blocks.length) return "block outside the shown revision";
      return blocks[target.block].range;
    case "section": {
      const indices = sectionBlocks(blocks, target.block);
      if (!indices.length) return "not a heading of the shown revision";
      return spanOf(blocks, indices);
    }
    case "document":
      return { start: 0, end: textLength };
  }
}
