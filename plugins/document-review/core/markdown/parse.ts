// The only place that knows the parser stack. CommonMark + GFM (tables, task lists, strikethrough,
// footnotes, autolink literals) + YAML/TOML frontmatter; no MDX, no math, no directives.
//
// micromark's cost grows faster than linearly with document size (event splicing), so large documents are parsed
// in independent top-level chunks. A chunk boundary is only placed before a
// line that provably starts a new top-level block in the whole document; link and footnote definitions, which are
// document-global, are made visible to every chunk by stub definitions that are dropped from the result.
// The merged tree has the same nodes and offsets as a whole-document parse (checked on the corpus by tests).
//
// Incremental (EP-012-T04): boundaries are content-defined — a safe boundary line is taken when its own text hashes
// to an anchor (or the chunk grew too long) — so an edit moves only the boundaries around it, and the parse of every
// unchanged chunk (same text, same definition stubs) is reused from a bounded in-memory cache.

import type { Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfm } from "micromark-extension-gfm";
import { FRONTMATTER } from "./profile.ts";

const BOM = "﻿";

/** Minimum chunk length in UTF-16 units before a boundary is taken. */
export const CHUNK_MIN = 8192;

/** Parsed chunk trees by (chunk text, stubs, position kind), positions relative to the chunk; bounded by text size. */
const chunkCache = new Map<string, { children: unknown[]; size: number }>();
let chunkCacheSize = 0;
/** Text budget; parsed trees are ~20× the text, so this keeps the cache near 50 MB. */
const CHUNK_CACHE_LIMIT = 2560 * 1024;
/** Hits and misses of the chunk cache (diagnostics and the incremental check). */
export const chunkStats = { hits: 0, misses: 0 };

function cached(key: string, size: number, parse: () => unknown[]): unknown[] {
  const found = chunkCache.get(key);
  if (found) {
    chunkCache.delete(key);
    chunkCache.set(key, found);
    chunkStats.hits++;
    return structuredClone(found.children);
  }
  chunkStats.misses++;
  const children = parse();
  chunkCache.set(key, { children: structuredClone(children), size });
  chunkCacheSize += size;
  while (chunkCacheSize > CHUNK_CACHE_LIMIT && chunkCache.size > 1) {
    const [oldest, value] = chunkCache.entries().next().value!;
    chunkCache.delete(oldest);
    chunkCacheSize -= value.size;
  }
  return children;
}

/** Forget every cached chunk (measurements of the parser itself; tests). */
export function clearChunkCache(): void {
  chunkCache.clear();
  chunkCacheSize = 0;
}

/** A boundary anchor: a cheap hash of the line's own text, independent of where the line is. */
function anchor(line: string): boolean {
  let hash = 0;
  for (let i = 0; i < line.length; i++) hash = (hash * 31 + line.charCodeAt(i)) | 0;
  return (hash & 3) === 0;
}

function parseWhole(text: string): Root {
  return fromMarkdown(text, {
    extensions: [gfm(), frontmatter([...FRONTMATTER])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown([...FRONTMATTER])],
  });
}

interface Line {
  start: number;
  /** Start of the next line (after the line ending). */
  next: number;
  text: string;
}

function lines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  const re = /\r\n|\r|\n/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ start, next: m.index + m[0].length, text: text.slice(start, m.index) });
    start = m.index + m[0].length;
  }
  if (start < text.length) out.push({ start, next: text.length, text: text.slice(start) });
  return out;
}

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_MARKER = /^([-+*]|\d{1,9}[.)])([ \t]|$)/;
const DEFINITION = /^ {0,3}\[((?:[^\\[\]]|\\.){1,999})\]:/;
const HTML_RAW: [RegExp, RegExp][] = [
  [/^ {0,3}<(script|pre|style|textarea)([\s>]|$)/i, /<\/(script|pre|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<![A-Za-z]/, />/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
];
// CommonMark HTML block type 6 (block-level tag names) and type 7 (a lone complete tag); both end at a blank line.
const HTML_BLOCK =
  /^ {0,3}<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[\s/>]|$)/i;
const HTML_TAG_LINE = /^ {0,3}(<[A-Za-z][A-Za-z0-9-]*(\s+[A-Za-z_:][\w.:-]*(\s*=\s*([^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$/;

function normalizeLabel(label: string): string {
  return label.replace(/[\t\n\r ]+/g, " ").trim().toLowerCase().toUpperCase();
}

interface Plan {
  /** UTF-16 offsets where chunks start (first is 0). */
  starts: number[];
  /** Line number (1-based) of each chunk start. */
  lineNumbers: number[];
  /** Raw labels of top-level definitions: [label, isFootnote]. */
  labels: { raw: string; normalized: string; footnote: boolean }[];
}

/** Safe chunk boundaries, or null when the document must be parsed whole. */
function plan(text: string): Plan | null {
  const all = lines(text);
  const starts = [0];
  const lineNumbers = [1];
  const labels: Plan["labels"] = [];
  const seen = new Set<string>();
  let fence: { char: string; length: number } | null = null;
  let html: RegExp | null = null;
  let k = 0;
  // Frontmatter: only at the very start; never split inside it.
  if (all.length && /^(---|\+\+\+)[ \t]*$/.test(all[0].text)) {
    const marker = all[0].text.trim();
    k = 1;
    while (k < all.length && all[k].text.trim() !== marker) k += 1;
    k += 1;
  }
  let previousDefinition = false;
  const first = k;
  const split = (at: number) => {
    starts.push(all[at].start);
    lineNumbers.push(at + 1);
  };
  for (; k < all.length; k += 1) {
    const line = all[k].text;
    // Inside code or raw HTML a "]:" may or may not matter to the whole parse: do not guess.
    if (fence) {
      if (line.includes("]:")) return null;
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }
    if (html) {
      if (line.includes("]:")) return null;
      if (html.test(line)) html = null;
      continue;
    }
    const previousBlank = k > first && BLANK.test(all[k - 1].text);
    const length = all[k].start - starts[starts.length - 1];
    const candidate = previousBlank && !BLANK.test(line) && !/^[ \t]/.test(line) && !LIST_MARKER.test(line) && length >= CHUNK_MIN && (length >= 3 * CHUNK_MIN || anchor(line));
    const open = FENCE_OPEN.exec(line);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      if (candidate) split(k);
      fence = { char: open[1][0], length: open[1].length };
      previousDefinition = false;
      continue;
    }
    const raw = HTML_RAW.find(([startRe]) => startRe.test(line));
    if (raw) {
      if (candidate) split(k);
      if (!raw[1].test(line.replace(raw[0], ""))) html = raw[1];
      previousDefinition = false;
      continue;
    }
    if (HTML_BLOCK.test(line) || ((previousBlank || k === first) && HTML_TAG_LINE.test(line))) {
      if (candidate) split(k);
      html = BLANK;
      previousDefinition = false;
      continue;
    }
    const def = DEFINITION.exec(line);
    if (def && (previousBlank || previousDefinition || k === first)) {
      const footnote = def[1].startsWith("^");
      const normalized = normalizeLabel(footnote ? def[1].slice(1) : def[1]);
      const key = `${footnote ? "^" : ""}${normalized}`;
      if (!seen.has(key)) {
        seen.add(key);
        labels.push({ raw: def[1], normalized, footnote });
      }
      previousDefinition = true;
    } else if (line.includes("]:")) {
      // A definition we cannot classify from the line structure (nested, multi-line, after a paragraph line).
      return null;
    } else previousDefinition = false;
    if (candidate) split(k);
  }
  return { starts, lineNumbers, labels };
}

interface Positioned {
  position?: { start: { offset?: number; line: number }; end: { offset?: number; line: number } };
  children?: Positioned[];
}

function shift(node: Positioned, offset: number, lines: number): void {
  if (node.position) {
    if (typeof node.position.start.offset === "number") node.position.start.offset += offset;
    if (typeof node.position.end.offset === "number") node.position.end.offset += offset;
    node.position.start.line += lines;
    node.position.end.line += lines;
  }
  for (const child of node.children ?? []) shift(child, offset, lines);
}

function stubs(chunk: string, labels: Plan["labels"]): string {
  if (!labels.length) return "";
  const haystack = normalizeLabel(chunk);
  const out: string[] = [];
  for (const label of labels) {
    if (!haystack.includes(`[${label.footnote ? "^" : ""}${label.normalized}`)) continue;
    out.push(label.footnote ? `[${label.raw}]: x` : `[${label.raw}]: #`);
  }
  return out.join("\n\n");
}

/** One chunk to parse: the text given to micromark and which of its top-level nodes belong to the chunk. */
export interface ChunkJob {
  key: string;
  /** Text handed to micromark: the chunk with its definition stubs after it, or (last chunk) before it. */
  input: string;
  /** Non-final chunk: keep nodes starting before `cut`; final chunk: keep nodes starting at or after `cut`. */
  cut: number;
  last: boolean;
  size: number;
}

interface ChunkPlan {
  jobs: (ChunkJob & { start: number; lineNumber: number; prefixLines: number })[];
}

function chunkPlan(text: string): ChunkPlan | null {
  const p = plan(text);
  if (!p || p.starts.length < 2) return null;
  const last = p.starts.length - 1;
  return {
    jobs: p.starts.map((start, i) => {
      const end = i < last ? p.starts[i + 1] : text.length;
      const chunk = text.slice(start, end);
      const extra = stubs(chunk, p.labels);
      if (i < last) {
        // A non-final chunk ends at a clean block boundary: stubs go after it.
        return { key: `m\0${extra}\0${chunk}`, input: extra ? `${chunk}\n\n${extra}\n` : chunk, cut: chunk.length, last: false, size: chunk.length, start, lineNumber: p.lineNumbers[i], prefixLines: 0 };
      }
      // The final chunk may end inside an open construct: stubs go before it.
      const prefix = extra ? `${extra}\n\n` : "";
      return { key: `l\0${extra}\0${chunk}`, input: prefix + chunk, cut: prefix.length, last: true, size: chunk.length, start: start - prefix.length, lineNumber: p.lineNumbers[i], prefixLines: prefix ? lines(prefix).length : 0 };
    }),
  };
}

/** Parse one chunk (pure; also what a parse worker of the host runs). */
export function runChunkJob(job: ChunkJob): unknown[] {
  const tree = parseWhole(job.input);
  return (tree.children as Positioned[]).filter((c) => (job.last ? (c.position?.start.offset ?? 0) >= job.cut : (c.position?.start.offset ?? 0) < job.cut));
}

/** Chunks of a source that are not in the cache yet (the host may parse them in parallel, then `storeChunk`). */
export function missingChunks(source: string): ChunkJob[] {
  const body = source.startsWith(BOM) ? source.slice(1) : source;
  if (body.length < 2 * CHUNK_MIN) return [];
  const planned = chunkPlan(body);
  if (!planned) return [];
  return planned.jobs.filter((job) => !chunkCache.has(job.key)).map(({ key, input, cut, last, size }) => ({ key, input, cut, last, size }));
}

/** Put a chunk parsed elsewhere into the cache; the synchronous projection then reuses it. */
export function storeChunk(job: ChunkJob, children: unknown[]): void {
  if (chunkCache.has(job.key)) return;
  chunkCache.set(job.key, { children, size: job.size });
  chunkCacheSize += job.size;
  while (chunkCacheSize > CHUNK_CACHE_LIMIT && chunkCache.size > 1) {
    const [oldest, value] = chunkCache.entries().next().value!;
    chunkCache.delete(oldest);
    chunkCacheSize -= value.size;
  }
}

/** Parse a document as independent chunks; returns null when no safe chunking exists. */
export function parseChunked(text: string): Root | null {
  const planned = chunkPlan(text);
  if (!planned) return null;
  const root: Root = { type: "root", children: [], position: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: text.length } } };
  for (const job of planned.jobs) {
    const children = cached(job.key, job.size, () => runChunkJob(job)) as Positioned[];
    shift({ children }, job.start, job.lineNumber - 1 - job.prefixLines);
    root.children.push(...(children as Root["children"]));
  }
  const endLine = lines(text).length;
  root.position = { start: { line: 1, column: 1, offset: 0 }, end: { line: Math.max(1, endLine), column: 1, offset: text.length } };
  return root;
}

/**
 * Parse a raw snapshot. micromark drops a leading BOM and reports offsets relative to the string
 * without it, so the BOM is removed here and `offset` tells callers how many code points to add.
 */
export function parseMarkdown(source: string, options: { whole?: boolean } = {}): { tree: Root; body: string; offset: number } {
  const offset = source.startsWith(BOM) ? 1 : 0;
  const body = offset ? source.slice(1) : source;
  const tree = (!options.whole && body.length >= 2 * CHUNK_MIN ? parseChunked(body) : null) ?? parseWhole(body);
  return { tree, body, offset };
}
