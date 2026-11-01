// Canonical text projection of a Markdown snapshot (profile bbdr-markdown v1, see projection.md):
// block list, projected text, semantic fingerprints and a per-code-point source map back to the raw bytes.
// Pure: the same source string always gives the same projection.

import { decodeNamedCharacterReference } from "decode-named-character-reference";
import { canonicalJson } from "../canonical-json.ts";
import { sha256 } from "../hash.ts";
import type { BlockType, CpRange } from "../types.ts";
import { parseMarkdown } from "./parse.ts";
import { PROJECTION_PROFILE, PROJECTION_VERSION } from "./profile.ts";
import { TextCoords } from "./text-coords.ts";

/** One entry of the inline token stream: a run of projected text or a structural mark. */
export type InlineToken = string | { [key: string]: string | number | boolean | null | InlineAttrs };
interface InlineAttrs {
  [key: string]: string | number | boolean | null;
}

/** Canonical semantic fingerprint of a block; semanticHash = sha256(canonicalJson(fingerprint)). */
export interface Fingerprint {
  type: BlockType;
  attrs: { [key: string]: string | number | boolean | null };
  inline: InlineToken[];
}

export interface ProjectedBlock {
  type: BlockType;
  /** Range of the block text in the projection (code points). */
  range: CpRange;
  /** Range of the block in the raw source (code points), markers included. */
  source: CpRange;
  text: string;
  semanticHash: string;
  textHash: string;
  /** Indices of enclosing section headings, outermost first. */
  headings: number[];
  /** Heading depth 1..6, only for headings. */
  depth?: number;
  /** Table cells only: which table of the document (0-based) and which row (0 = header). */
  cell?: { table: number; row: number };
  fingerprint: Fingerprint;
}

export interface Projection {
  profile: string;
  version: number;
  /** Raw snapshot decoded as UTF-8, unchanged (BOM and CR kept). */
  source: string;
  /** Canonical projected text. */
  text: string;
  blocks: ProjectedBlock[];
  /** For projected code point i: raw source code point span [srcStart[i], srcEnd[i]). Separators: empty span. */
  srcStart: Uint32Array;
  srcEnd: Uint32Array;
  /** Block index of projected code point i, -1 for separators. */
  blockOf: Int32Array;
  sourceCoords: TextCoords;
  textCoords: TextCoords;
  /** Raw characters the source map could not explain (0 on every corpus document; kept for diagnostics). */
  misses: number;
}

interface MdPoint {
  offset?: number;
}
interface MdNode {
  type: string;
  children?: MdNode[];
  value?: string;
  position?: { start: MdPoint; end: MdPoint };
  [key: string]: unknown;
}

type Mark = { [key: string]: string | number | boolean | null | InlineAttrs };
const CHAR = 0;
const MARK = 1;
const BREAK = 2;

/** Inline content of one block as parallel arrays (one entry per character, mark or hard break); avoids an object per character. */
class Items {
  readonly kind: number[] = [];
  readonly ch: number[] = [];
  readonly s: number[] = [];
  readonly e: number[] = [];
  readonly ws: number[] = [];
  readonly marks: (Mark | null)[] = [];
  char(ch: number, s: number, e: number, ws: boolean): void {
    this.kind.push(CHAR);
    this.ch.push(ch);
    this.s.push(s);
    this.e.push(e);
    this.ws.push(ws ? 1 : 0);
    this.marks.push(null);
  }
  mark(mark: Mark): void {
    this.kind.push(MARK);
    this.ch.push(0);
    this.s.push(0);
    this.e.push(0);
    this.ws.push(0);
    this.marks.push(mark);
  }
  br(s: number, e: number): void {
    this.kind.push(BREAK);
    this.ch.push(0);
    this.s.push(s);
    this.e.push(e);
    this.ws.push(0);
    this.marks.push(null);
  }
  get length(): number {
    return this.kind.length;
  }
  hasImage(): boolean {
    return this.marks.some((m) => m !== null && "image" in m);
  }
}

interface Context {
  quote: number;
  list: number;
  footnote: string | null;
  root: boolean;
}

interface RawBlock {
  type: BlockType;
  cps: number[];
  s: number[];
  e: number[];
  inline: InlineToken[];
  attrs: { [key: string]: string | number | boolean | null };
  source: CpRange;
  depth?: number;
  root: boolean;
  table?: { id: number; row: number };
}

const SP = 0x20;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const FF = 0x0c;

function isCollapsible(cp: number): boolean {
  return cp === SP || cp === TAB || cp === LF || cp === CR || cp === FF;
}

function isAsciiPunctuation(cp: number): boolean {
  return (cp >= 0x21 && cp <= 0x2f) || (cp >= 0x3a && cp <= 0x40) || (cp >= 0x5b && cp <= 0x60) || (cp >= 0x7b && cp <= 0x7e);
}

function isAsciiAlnum(cp: number): boolean {
  return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
}

/** Same replacement rules as micromark-util-decode-numeric-character-reference. */
function numericReference(code: number): number {
  if (
    code < 9 ||
    code === 11 ||
    (code > 13 && code < 32) ||
    (code > 126 && code < 160) ||
    (code > 55295 && code < 57344) ||
    (code > 64975 && code < 65008) ||
    (code & 65535) === 65535 ||
    (code & 65535) === 65534 ||
    code > 1114111
  ) {
    return 0xfffd;
  }
  return code;
}

export function codePoints(text: string): number[] {
  const out: number[] = [];
  for (const char of text) out.push(char.codePointAt(0) as number);
  return out;
}

function fromCodePoints(cps: number[]): string {
  let out = "";
  for (let i = 0; i < cps.length; i += 4096) out += String.fromCodePoint(...cps.slice(i, i + 4096));
  return out;
}

class Builder {
  readonly src: number[];
  readonly coords: TextCoords;
  readonly offset: number;
  readonly definitions = new Map<string, { url: string; title: string | null }>();
  readonly blocks: RawBlock[] = [];
  misses = 0;
  private tables = 0;

  constructor(source: string, offset: number) {
    this.src = codePoints(source);
    this.coords = new TextCoords(source);
    this.offset = offset;
  }

  cp(point: MdPoint | undefined): number {
    if (!point || typeof point.offset !== "number") throw new Error("mdast node without offset");
    return this.coords.utf16ToCp(point.offset + this.offset);
  }

  range(node: MdNode): CpRange {
    return { start: this.cp(node.position?.start), end: this.cp(node.position?.end) };
  }

  // A character reference starting at i: decoded code points and raw length, or null.
  private reference(i: number, end: number): { cps: number[]; length: number } | null {
    const src = this.src;
    let j = i + 1;
    if (src[j] === 0x23) {
      j += 1;
      const hex = src[j] === 0x78 || src[j] === 0x58;
      if (hex) j += 1;
      const first = j;
      let code = 0;
      while (j < end && j - first < (hex ? 6 : 7)) {
        const c = src[j];
        const digit = c >= 0x30 && c <= 0x39 ? c - 0x30 : hex && c >= 0x61 && c <= 0x66 ? c - 0x57 : hex && c >= 0x41 && c <= 0x46 ? c - 0x37 : -1;
        if (digit < 0) break;
        code = code * (hex ? 16 : 10) + digit;
        j += 1;
      }
      if (j === first || src[j] !== 0x3b) return null;
      return { cps: [numericReference(code)], length: j + 1 - i };
    }
    const first = j;
    while (j < end && j - first < 32 && isAsciiAlnum(src[j])) j += 1;
    if (j === first || src[j] !== 0x3b) return null;
    const decoded = decodeNamedCharacterReference(fromCodePoints(src.slice(first, j)));
    if (decoded === false) return null;
    return { cps: codePoints(decoded), length: j + 1 - i };
  }

  /**
   * Align a decoded mdast value with its raw span [from, to): for each value code point the raw span it came from.
   * Raw characters not represented in the value (container prefixes, indentation) are skipped.
   */
  private alignOnce(value: number[], from: number, to: number, refs: boolean, skip: (cp: number) => boolean): { s: number[]; e: number[]; misses: number } {
    const src = this.src;
    const s: number[] = new Array(value.length);
    const e: number[] = new Array(value.length);
    let misses = 0;
    let i = from;
    let j = 0;
    while (j < value.length) {
      if (i >= to) {
        for (; j < value.length; j += 1) s[j] = e[j] = to;
        misses += 1;
        break;
      }
      const r = src[i];
      const c = value[j];
      if (refs && r === 0x5c && i + 1 < to && isAsciiPunctuation(src[i + 1]) && c === src[i + 1]) {
        s[j] = i;
        e[j] = i + 2;
        i += 2;
        j += 1;
        continue;
      }
      if (refs && r === 0x26) {
        const ref = this.reference(i, to);
        if (ref && ref.cps.every((cp, k) => value[j + k] === cp)) {
          for (let k = 0; k < ref.cps.length; k += 1) {
            s[j + k] = i;
            e[j + k] = i + ref.length;
          }
          i += ref.length;
          j += ref.cps.length;
          continue;
        }
      }
      if (r === c) {
        s[j] = i;
        e[j] = i + 1;
        i += 1;
        j += 1;
        continue;
      }
      if (c === LF && r === CR && src[i + 1] === LF) {
        s[j] = i;
        e[j] = i + 2;
        i += 2;
        j += 1;
        continue;
      }
      if (!skip(r)) misses += 1;
      i += 1;
    }
    return { s, e, misses };
  }

  align(value: number[], from: number, to: number, refs: boolean, skip: (cp: number) => boolean): { s: number[]; e: number[] } {
    let best = this.alignOnce(value, from, to, refs, skip);
    if (best.misses && refs) {
      // Autolinks and some literal contexts keep references undecoded: retry literally.
      const literal = this.alignOnce(value, from, to, false, skip);
      if (literal.misses < best.misses) best = literal;
    }
    this.misses += best.misses;
    return best;
  }

  // ---- inline ----

  private pushText(node: MdNode, items: Items, literal: boolean): void {
    const value = codePoints(node.value ?? "");
    if (!value.length) return;
    const { start, end } = this.range(node);
    const { s, e } = this.align(value, start, end, !literal, skipPrefix);
    for (let j = 0; j < value.length; j += 1) items.char(value[j], s[j], e[j], isCollapsible(value[j]));
  }

  private pushInlineCode(node: MdNode, items: Items): void {
    const value = codePoints(node.value ?? "");
    let { start, end } = this.range(node);
    while (start < end && this.src[start] === 0x60) start += 1;
    while (end > start && this.src[end - 1] === 0x60) end -= 1;
    // GFM removes the backslash of `\|` inside code in table cells; alignment tries escapes first, then literally.
    const { s, e } = this.align(value, start, end, true, skipPrefix);
    items.mark({ open: "code" });
    for (let j = 0; j < value.length; j += 1) {
      const c = value[j];
      if (c === CR && value[j + 1] === LF) {
        items.char(SP, s[j], e[j + 1], false);
        j += 1;
      } else items.char(c === CR || c === LF ? SP : c, s[j], e[j], false);
    }
    items.mark({ close: "code" });
  }

  private definition(identifier: unknown): { url: string | null; title: string | null } {
    const found = typeof identifier === "string" ? this.definitions.get(identifier) : undefined;
    return { url: found?.url ?? null, title: found?.title ?? null };
  }

  phrasing(nodes: MdNode[] | undefined, items: Items, literal = false): void {
    for (const node of nodes ?? []) {
      switch (node.type) {
        case "text":
          this.pushText(node, items, literal);
          break;
        case "inlineCode":
          this.pushInlineCode(node, items);
          break;
        case "emphasis":
        case "strong":
        case "delete":
          items.mark({ open: node.type });
          this.phrasing(node.children, items, literal);
          items.mark({ close: node.type });
          break;
        case "link": {
          const auto = this.src[this.cp(node.position?.start)] === 0x3c;
          items.mark({ open: "link", url: String(node.url ?? ""), title: (node.title as string | null | undefined) ?? null });
          this.phrasing(node.children, items, literal || auto);
          items.mark({ close: "link" });
          break;
        }
        case "linkReference": {
          const def = this.definition(node.identifier);
          items.mark({ open: "link", url: def.url, title: def.title });
          this.phrasing(node.children, items, literal);
          items.mark({ close: "link" });
          break;
        }
        case "image":
          items.mark({ image: { alt: String(node.alt ?? ""), url: String(node.url ?? ""), title: (node.title as string | null | undefined) ?? null } });
          break;
        case "imageReference": {
          const def = this.definition(node.identifier);
          items.mark({ image: { alt: String(node.alt ?? ""), url: def.url, title: def.title } });
          break;
        }
        case "footnoteReference":
          items.mark({ footnote: String(node.identifier ?? "") });
          break;
        case "break": {
          const { start, end } = this.range(node);
          items.br(start, end);
          break;
        }
        case "html":
          items.mark({ html: String(node.value ?? "") });
          break;
        default:
          if (node.children) this.phrasing(node.children, items, literal);
          else if (typeof node.value === "string") this.pushText(node, items, literal);
      }
    }
  }

  // ---- blocks ----

  private contextAttrs(ctx: Context): { [key: string]: string | number | boolean | null } {
    return { quote: ctx.quote, list: ctx.list, footnote: ctx.footnote };
  }

  private prose(type: BlockType, items: Items, ctx: Context, source: CpRange, attrs: RawBlock["attrs"], extra: Partial<RawBlock> = {}): void {
    const { cps, s, e, inline } = collapse(items);
    let finalType = type;
    if (type === "paragraph" && cps.length === 0 && items.hasImage()) finalType = "image";
    this.blocks.push({ type: finalType, cps, s, e, inline, attrs: { ...this.contextAttrs(ctx), ...attrs }, source, root: ctx.root, ...extra });
  }

  private verbatim(type: BlockType, node: MdNode, ctx: Context, firstLineIsFence: boolean, attrs: RawBlock["attrs"]): void {
    const source = this.range(node);
    const value = node.value ?? "";
    const cps: number[] = [];
    const s: number[] = [];
    const e: number[] = [];
    if (value.length) {
      const src = this.src;
      const lines: { s: number; e: number; eol: number }[] = [];
      let lineStart = source.start;
      for (let i = source.start; i < source.end; ) {
        if (src[i] === CR || src[i] === LF) {
          const eol = src[i] === CR && src[i + 1] === LF && i + 1 < source.end ? i + 2 : i + 1;
          lines.push({ s: lineStart, e: i, eol });
          i = eol;
          lineStart = i;
        } else i += 1;
      }
      lines.push({ s: lineStart, e: source.end, eol: source.end });
      const valueLines = value.split(/\r\n|\r|\n/).map(codePoints);
      const first = firstLineIsFence ? 1 : 0;
      if (first + valueLines.length > lines.length) {
        // Unexpected layout: align the whole value greedily.
        const normalized = codePoints(value.replace(/\r\n?/g, "\n"));
        const aligned = this.align(normalized, source.start, source.end, false, () => true);
        cps.push(...normalized);
        s.push(...aligned.s);
        e.push(...aligned.e);
      } else {
        valueLines.forEach((line, k) => {
          const raw = lines[first + k];
          const rawLength = raw.e - raw.s;
          let suffix = rawLength >= line.length;
          for (let q = 0; suffix && q < line.length; q += 1) if (src[raw.e - line.length + q] !== line[q]) suffix = false;
          if (suffix) {
            for (let q = 0; q < line.length; q += 1) {
              cps.push(line[q]);
              s.push(raw.e - line.length + q);
              e.push(raw.e - line.length + q + 1);
            }
          } else {
            const aligned = this.align(line, raw.s, raw.e, false, () => true);
            cps.push(...line);
            s.push(...aligned.s);
            e.push(...aligned.e);
          }
          if (k < valueLines.length - 1) {
            cps.push(LF);
            s.push(raw.e);
            e.push(raw.eol);
          }
        });
      }
    }
    const text = fromCodePoints(cps);
    this.blocks.push({ type, cps, s, e, inline: text ? [text] : [], attrs: { ...this.contextAttrs(ctx), ...attrs }, source, root: ctx.root });
  }

  private ownText(
    type: BlockType,
    container: MdNode,
    ctx: Context,
    attrs: RawBlock["attrs"],
  ): MdNode[] {
    const children = container.children ?? [];
    const first = children[0];
    const own = first && first.type === "paragraph" ? first : null;
    const start = this.cp(container.position?.start);
    const end = own ? this.cp(own.position?.end) : first ? this.cp(first.position?.start) : this.cp(container.position?.end);
    const items = new Items();
    if (own) this.phrasing(own.children, items);
    let trimmedEnd = end;
    while (trimmedEnd > start && isCollapsible(this.src[trimmedEnd - 1])) trimmedEnd -= 1;
    this.prose(type, items, ctx, { start, end: trimmedEnd }, attrs);
    return own ? children.slice(1) : children;
  }

  flow(nodes: MdNode[] | undefined, ctx: Context): void {
    for (const node of nodes ?? []) {
      switch (node.type) {
        case "heading": {
          const items = new Items();
          this.phrasing(node.children, items);
          const depth = Number(node.depth);
          this.prose("heading", items, ctx, this.range(node), { depth }, { depth });
          break;
        }
        case "paragraph": {
          const items = new Items();
          this.phrasing(node.children, items);
          this.prose("paragraph", items, ctx, this.range(node), {});
          break;
        }
        case "blockquote":
          this.flow(node.children, { ...ctx, quote: ctx.quote + 1, root: false });
          break;
        case "list":
          for (const item of node.children ?? []) {
            const inner: Context = { ...ctx, list: ctx.list + 1, root: false };
            const ordered = Boolean(node.ordered);
            const rest = this.ownText("listItem", item, inner, {
              checked: typeof item.checked === "boolean" ? item.checked : null,
              ordered,
              start: ordered ? Number(node.start ?? 1) : null,
            });
            this.flow(rest, inner);
          }
          break;
        case "footnoteDefinition": {
          const inner: Context = { ...ctx, footnote: String(node.identifier ?? ""), root: false };
          const rest = this.ownText("footnoteDefinition", node, inner, {});
          this.flow(rest, inner);
          break;
        }
        case "table": {
          const id = this.tables++;
          const align = (node.align as (string | null)[] | undefined) ?? [];
          (node.children ?? []).forEach((row, r) => {
            (row.children ?? []).forEach((cell, c) => {
              const items = new Items();
              this.phrasing(cell.children, items);
              this.prose("tableCell", items, ctx, this.range(cell), { header: r === 0, column: c, align: align[c] ?? null, columns: align.length }, { table: { id, row: r } });
            });
          });
          break;
        }
        case "code": {
          const start = this.cp(node.position?.start);
          const fence = this.src[start] === 0x60 || this.src[start] === 0x7e;
          this.verbatim("code", node, ctx, fence, { lang: (node.lang as string | null | undefined) ?? null, meta: (node.meta as string | null | undefined) ?? null });
          break;
        }
        case "html":
          this.verbatim("html", node, ctx, false, {});
          break;
        case "yaml":
        case "toml":
          this.verbatim("frontmatter", node, ctx, true, { format: node.type });
          break;
        case "thematicBreak":
          this.blocks.push({ type: "thematicBreak", cps: [], s: [], e: [], inline: [], attrs: this.contextAttrs(ctx), source: this.range(node), root: ctx.root });
          break;
        case "definition":
          break;
        default:
          if (node.children) this.flow(node.children, { ...ctx, root: false });
          else if (typeof node.value === "string") this.verbatim("code", node, ctx, false, { lang: node.type, meta: null });
      }
    }
  }

  collectDefinitions(node: MdNode): void {
    if (node.type === "definition" && typeof node.identifier === "string" && !this.definitions.has(node.identifier)) {
      this.definitions.set(node.identifier, { url: String(node.url ?? ""), title: (node.title as string | null | undefined) ?? null });
    }
    for (const child of node.children ?? []) this.collectDefinitions(child);
  }
}

function skipPrefix(cp: number): boolean {
  return isCollapsible(cp) || cp === 0x3e;
}

/** Collapse prose whitespace while preserving the position of marks relative to visible text. */
function collapse(items: Items): { cps: number[]; s: number[]; e: number[]; inline: InlineToken[] } {
  const cps: number[] = [];
  const s: number[] = [];
  const e: number[] = [];
  const inline: InlineToken[] = [];
  let run: number[] = [];
  const emitChar = (ch: number, start: number, end: number) => {
    cps.push(ch);
    s.push(start);
    e.push(end);
    run.push(ch);
  };
  const emitMark = (mark: Mark) => {
    if (run.length) inline.push(fromCodePoints(run));
    run = [];
    inline.push(mark);
  };
  let pendS = -1;
  let pendE = -1;
  let pendingMarks: Mark[] = [];
  let started = false;
  let afterBreak = false;
  for (let i = 0; i < items.length; i += 1) {
    const kind = items.kind[i];
    if (kind === CHAR) {
      if (items.ws[i]) {
        if (!started || afterBreak) continue;
        if (pendS < 0) pendS = items.s[i];
        pendE = items.e[i];
        continue;
      }
      if (pendS >= 0) emitChar(SP, pendS, pendE);
      pendS = -1;
      if (pendingMarks.length) {
        for (const mark of pendingMarks) emitMark(mark);
        pendingMarks = [];
      }
      emitChar(items.ch[i], items.s[i], items.e[i]);
      started = true;
      afterBreak = false;
    } else if (kind === MARK) {
      const mark = items.marks[i] as Mark;
      if (pendS >= 0) pendingMarks.push(mark);
      else emitMark(mark);
    } else {
      if (!started) continue;
      pendS = -1;
      for (const mark of pendingMarks) emitMark(mark);
      pendingMarks = [];
      emitChar(LF, items.s[i], items.e[i]);
      afterBreak = true;
    }
  }
  for (const mark of pendingMarks) emitMark(mark);
  if (run.length) inline.push(fromCodePoints(run));
  return { cps, s, e, inline };
}

function separator(previous: RawBlock | undefined, next: RawBlock): number[] {
  if (!previous) return [];
  if (previous.table && next.table && previous.table.id === next.table.id) return previous.table.row === next.table.row ? [TAB] : [LF];
  return [LF, LF];
}

/**
 * Build the canonical projection of a raw snapshot (decoded as UTF-8). `wholeDocument` disables chunked parsing;
 * it exists for tests that prove both give the same projection.
 */
export function project(source: string, options: { wholeDocument?: boolean } = {}): Projection {
  const { tree, offset } = parseMarkdown(source, { whole: options.wholeDocument });
  const builder = new Builder(source, offset);
  const root = tree as unknown as MdNode;
  builder.collectDefinitions(root);
  builder.flow(root.children, { quote: 0, list: 0, footnote: null, root: true });

  const text: number[] = [];
  const srcStart: number[] = [];
  const srcEnd: number[] = [];
  const blockOf: number[] = [];
  const blocks: ProjectedBlock[] = [];
  const sections: { index: number; depth: number }[] = [];
  builder.blocks.forEach((raw, index) => {
    const boundary = index ? builder.blocks[index - 1].source.end : 0;
    for (const cp of separator(builder.blocks[index - 1], raw)) {
      text.push(cp);
      srcStart.push(boundary);
      srcEnd.push(boundary);
      blockOf.push(-1);
    }
    const start = text.length;
    for (let q = 0; q < raw.cps.length; q += 1) {
      text.push(raw.cps[q]);
      srcStart.push(raw.s[q]);
      srcEnd.push(raw.e[q]);
      blockOf.push(index);
    }
    let headings: number[];
    if (raw.type === "heading" && raw.root) {
      const depth = raw.depth ?? 1;
      while (sections.length && sections[sections.length - 1].depth >= depth) sections.pop();
      headings = sections.map((section) => section.index);
      sections.push({ index, depth });
    } else headings = sections.map((section) => section.index);
    const blockText = fromCodePoints(raw.cps);
    const fingerprint: Fingerprint = { type: raw.type, attrs: raw.attrs, inline: raw.inline };
    const block: ProjectedBlock = {
      type: raw.type,
      range: { start, end: text.length },
      source: raw.source,
      text: blockText,
      semanticHash: sha256(canonicalJson(fingerprint)),
      textHash: sha256(blockText),
      headings,
      fingerprint,
    };
    if (raw.type === "heading") block.depth = raw.depth;
    if (raw.table) block.cell = { table: raw.table.id, row: raw.table.row };
    blocks.push(block);
  });
  const projected = fromCodePoints(text);
  return {
    profile: PROJECTION_PROFILE,
    version: PROJECTION_VERSION,
    source,
    text: projected,
    blocks,
    srcStart: Uint32Array.from(srcStart),
    srcEnd: Uint32Array.from(srcEnd),
    blockOf: Int32Array.from(blockOf),
    sourceCoords: builder.coords,
    textCoords: new TextCoords(projected),
    misses: builder.misses,
  };
}

// ---- source map and quotes ----

function checkRange(p: Projection, range: CpRange): void {
  p.textCoords.checkRange(range);
}

/** Text of a projected range. */
export function sliceText(p: Projection, range: CpRange): string {
  return p.textCoords.slice(range);
}

/**
 * Per-block segments of a projected range. A non-empty range yields the intersection with every block it overlaps
 * plus every empty block (image, thematic break) whose position lies within it; an empty range yields the block
 * containing that boundary.
 */
export function blockSegments(p: Projection, range: CpRange): { block: number; range: CpRange }[] {
  checkRange(p, range);
  const out: { block: number; range: CpRange }[] = [];
  if (range.start === range.end) {
    const index = p.blocks.findIndex((block) => block.range.start <= range.start && range.start <= block.range.end);
    return index < 0 ? [] : [{ block: index, range: { start: range.start, end: range.start } }];
  }
  p.blocks.forEach((block, index) => {
    const { start, end } = block.range;
    if (start === end) {
      if (range.start <= start && start <= range.end) out.push({ block: index, range: { start, end } });
      return;
    }
    const s = Math.max(start, range.start);
    const e = Math.min(end, range.end);
    if (s < e) out.push({ block: index, range: { start: s, end: e } });
  });
  return out;
}

/** Raw-source code point ranges (one per touched block, in document order) covering a projected range. */
export function projectionToSource(p: Projection, range: CpRange): CpRange[] {
  const out: CpRange[] = [];
  for (const segment of blockSegments(p, range)) {
    const block = p.blocks[segment.block];
    if (segment.range.start === segment.range.end) {
      if (block.range.start === block.range.end) out.push({ ...block.source });
      else {
        const at = segment.range.start < block.range.end ? p.srcStart[segment.range.start] : p.srcEnd[block.range.end - 1];
        out.push({ start: at, end: at });
      }
      continue;
    }
    let start = Infinity;
    let end = -Infinity;
    for (let i = segment.range.start; i < segment.range.end; i += 1) {
      start = Math.min(start, p.srcStart[i]);
      end = Math.max(end, p.srcEnd[i]);
    }
    out.push({ start, end });
  }
  return out;
}

/** Smallest projected range whose characters come from the raw range; null when no projected text does. */
export function sourceToProjection(p: Projection, range: CpRange): CpRange | null {
  p.sourceCoords.checkRange(range);
  let first = -1;
  let last = -1;
  for (let i = 0; i < p.blockOf.length; i += 1) {
    if (p.blockOf[i] < 0) continue;
    const s = p.srcStart[i];
    const e = p.srcEnd[i];
    const hit = range.start === range.end ? s <= range.start && range.start < e : s < range.end && range.start < e;
    if (hit) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null;
  return range.start === range.end ? { start: first, end: first } : { start: first, end: last + 1 };
}

/** W3C TextQuoteSelector parts for a projected range; context counted in code points. */
export function quoteAt(p: Projection, range: CpRange, context = 32): { exact: string; prefix: string; suffix: string } {
  checkRange(p, range);
  const length = p.textCoords.length;
  return {
    exact: sliceText(p, range),
    prefix: sliceText(p, { start: Math.max(0, range.start - context), end: range.start }),
    suffix: sliceText(p, { start: range.end, end: Math.min(length, range.end + context) }),
  };
}

/** True only when the range is valid for this projection and its text is exactly `exact`. */
export function verifyQuote(p: Projection, range: CpRange, exact: string): boolean {
  if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end)) return false;
  if (range.start < 0 || range.end < range.start || range.end > p.textCoords.length) return false;
  return sliceText(p, range) === exact;
}

/** Index of the block containing projected code point cp (or the block just before a separator). */
export function blockAt(p: Projection, cp: number): number {
  if (!p.blocks.length) return -1;
  let lo = 0;
  let hi = p.blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (p.blocks[mid].range.start <= cp) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
