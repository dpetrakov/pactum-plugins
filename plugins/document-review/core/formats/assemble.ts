// Projection of non-Markdown formats (W-06c, file-types.md §5): every block is one contiguous slice of the raw source
// (a key-value pair, a group header, a line, a CSV record), so the projected text of a block is exactly that slice and
// the source map is the identity inside it. Blocks are separated by one line feed. The result has the same shape as
// the Markdown projection, so revisions, lineage, anchoring, reading and diff work unchanged (DR-02–DR-04).

import { canonicalJson } from "../canonical-json.ts";
import { sha256 } from "../hash.ts";
import type { Fingerprint, InlineToken, ProjectedBlock, Projection } from "../markdown/projection.ts";
import { TextCoords } from "../markdown/text-coords.ts";
import type { BlockType } from "../types.ts";

export type Scalar = string | number | boolean | null;

/** A segment of a key path: an object key, an array index, or the document of a multi-document YAML file. */
export type { PathSegment } from "./paths.ts";
import type { PathSegment } from "./paths.ts";

export interface AtomicBlock {
  type: BlockType;
  /** UTF-16 offsets of the slice in the source (end exclusive). */
  start: number;
  end: number;
  /** Hashed attributes of the block (fingerprint): identity without position. */
  attrs: Record<string, Scalar>;
  /** Hashed content of the block (fingerprint). */
  inline: InlineToken[];
  /** Indices of enclosing group blocks, outermost first («sections» of the block). */
  parents: number[];
  /** Nesting depth of a group block (1 = top level), shown like a heading depth. */
  depth?: number;
  /** Unhashed metadata for views: the concrete key path, line, cells, value kind. */
  meta?: BlockMeta;
}

export interface BlockMeta {
  /** Concrete key path (array indices included). */
  path?: PathSegment[];
  /** Kind of a structured value: string, number, boolean, null, date, alias, object, array. */
  kind?: string;
  /** Text of the key as written (structured) or the variable name (.env). */
  key?: string;
  /** Value as shown («Pretty»): decoded string, number text as in the source, alias name. */
  value?: string;
  /** UTF-16 range of the value as written (quotes included) — what secret masking replaces (§8). */
  valueStart?: number;
  valueEnd?: number;
  /** Comment lines before the node / after the value (YAML, JSONC, TOML, .env). */
  comment?: string;
  /** YAML anchor and tag of the node. */
  anchor?: string;
  tag?: string;
  /** Children count of a group (keys of an object, elements of an array). */
  count?: number;
  /** CSV/TSV cells of a record, header flag. */
  cells?: string[];
  header?: boolean;
}

export interface AssembledProjection extends Projection {
  meta: (BlockMeta | undefined)[];
}

/** Build a projection from atomic blocks in document order. */
export function assemble(profile: string, version: number, source: string, atoms: AtomicBlock[]): AssembledProjection {
  const coords = new TextCoords(source);
  const text: number[] = [];
  const srcStart: number[] = [];
  const srcEnd: number[] = [];
  const blockOf: number[] = [];
  const blocks: ProjectedBlock[] = [];
  const meta: (BlockMeta | undefined)[] = [];
  let previousEnd = 0;
  atoms.forEach((atom, index) => {
    const cpStart = coords.utf16ToCp(atom.start);
    const cpEnd = coords.utf16ToCp(atom.end);
    if (index > 0) {
      text.push(0x0a);
      srcStart.push(previousEnd);
      srcEnd.push(previousEnd);
      blockOf.push(-1);
    }
    const start = text.length;
    const slice = source.slice(atom.start, atom.end);
    let cp = cpStart;
    for (const ch of slice) {
      text.push(ch.codePointAt(0)!);
      srcStart.push(cp);
      srcEnd.push(cp + 1);
      blockOf.push(index);
      cp += 1;
    }
    previousEnd = cpEnd;
    const fingerprint: Fingerprint = { type: atom.type, attrs: atom.attrs, inline: atom.inline };
    const block: ProjectedBlock = {
      type: atom.type,
      range: { start, end: text.length },
      source: { start: cpStart, end: cpEnd },
      text: slice,
      semanticHash: sha256(canonicalJson(fingerprint)),
      textHash: sha256(slice),
      headings: [...atom.parents],
      fingerprint,
    };
    if (atom.depth !== undefined) block.depth = atom.depth;
    blocks.push(block);
    meta.push(atom.meta);
  });
  const projected = codePointsToString(text);
  return {
    profile,
    version,
    source,
    text: projected,
    blocks,
    srcStart: Uint32Array.from(srcStart),
    srcEnd: Uint32Array.from(srcEnd),
    blockOf: Int32Array.from(blockOf),
    sourceCoords: coords,
    textCoords: new TextCoords(projected),
    misses: 0,
    meta,
  };
}

function codePointsToString(cps: number[]): string {
  let out = "";
  for (let i = 0; i < cps.length; i += 8192) out += String.fromCodePoint(...cps.slice(i, i + 8192));
  return out;
}

/** Trimmed slice [start, end) of the source: leading and trailing spaces, tabs and carriage returns excluded. */
export function trimRange(source: string, start: number, end: number): [number, number] {
  while (start < end && /[ \t\r\n﻿]/.test(source[start])) start++;
  while (end > start && /[ \t\r\n]/.test(source[end - 1])) end--;
  return [start, end];
}

/** 1-based line of a UTF-16 offset. */
export function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

// ── key paths (file-types.md §6 «Node actions», §7) ──

export { dottedPath, identityPath, jqPath, jsonPointer, keyPathString, parseKeyPath } from "./paths.ts";
