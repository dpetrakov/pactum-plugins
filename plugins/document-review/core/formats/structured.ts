// Profile bbdr-structured v1 (W-06c, file-types.md §5): YAML, JSON/JSONC and TOML as revisions of nodes. A leaf
// «key path = value» is a block whose text is the pair as written (`port: 8080`, `"port": 8080`, `port = 8080`); a keyed
// object or array is a group block (its header: `services:`, `"services": {`, `[server]`) and the «section» of its
// children. Identity: the key path with array indices erased (an insertion does not change the others) + the value;
// the order of object keys is not part of anything, so reordering keys is not a change (§7). Parsing never executes
// code and never expands YAML aliases (an alias is a leaf «*name»), so «billion laughs» costs nothing; nesting deeper
// than MAX_DEPTH is kept as one leaf.

import { type Document, isAlias, isMap, isPair, isScalar, isSeq, type Node as YamlNode, type Pair, parseAllDocuments } from "yaml";
import { type JsonNode, parseJsonTree } from "./jsonc.ts";
import { parseTOML } from "toml-eslint-parser";
import type { AtomicBlock, BlockMeta, PathSegment, Scalar } from "./assemble.ts";
import { identityPath, lineAt } from "./assemble.ts";

export const MAX_DEPTH = 64;

export interface StructuredParse {
  ok: true;
  atoms: AtomicBlock[];
}
export interface StructuredError {
  ok: false;
  /** 1-based line of the first error, and its message. */
  line: number;
  message: string;
}

type Kind = "string" | "number" | "boolean" | "null" | "alias" | "date" | "object" | "array";

/** Collects atoms; parents of every block are the group blocks whose path is a proper prefix of its path. */
class Collector {
  readonly atoms: AtomicBlock[] = [];
  private readonly groups = new Map<string, number>();
  private readonly source: string;
  private readonly comments: { start: number; end: number; text: string }[];
  constructor(source: string, comments: { start: number; end: number; text: string }[] = []) {
    this.source = source;
    this.comments = comments;
  }

  private readonly parentCache = new Map<string, number[]>();

  /** Parents of a path = parents of its parent path + the parent's own group block (memoized by the parent path). */
  private parentsOf(path: PathSegment[]): number[] {
    if (path.length <= 1) return [];
    const parent = path.slice(0, -1);
    const key = JSON.stringify(parent);
    let cached = this.parentCache.get(key);
    if (!cached) {
      cached = [...this.parentsOf(parent)];
      const own = this.groups.get(key);
      if (own !== undefined) cached.push(own);
      this.parentCache.set(key, cached);
    }
    return [...cached];
  }

  private readonly usedComments = new Set<number>();

  private commentFor(start: number, end: number): string | undefined {
    if (!this.comments.length) return undefined;
    // Comments between the previous block and this one (before), or on the same line after the block (trailing);
    // a comment belongs to one block only.
    const previousEnd = this.atoms.length ? this.atoms[this.atoms.length - 1].end : 0;
    const lineEnd = this.source.indexOf("\n", end);
    const picked: number[] = [];
    this.comments.forEach((c, index) => {
      if (this.usedComments.has(index)) return;
      const before = c.start >= previousEnd && c.end <= start;
      const after = c.start >= end && (lineEnd < 0 || c.start < lineEnd) && !this.source.slice(end, c.start).includes("\n");
      if (before || after) picked.push(index);
    });
    for (const index of picked) this.usedComments.add(index);
    const all = picked.map((index) => this.comments[index].text.trim()).filter(Boolean);
    return all.length ? all.join("\n") : undefined;
  }

  leaf(path: PathSegment[], start: number, end: number, kind: Kind, value: string, extra: Partial<BlockMeta> = {}): void {
    const key = extra.key;
    const attrs: Record<string, Scalar> = { path: identityPath(path), kind };
    if (extra.anchor) attrs.anchor = extra.anchor;
    if (extra.tag) attrs.tag = extra.tag;
    const comment = extra.comment ?? this.commentFor(start, end);
    this.atoms.push({ type: "node", start, end, attrs, inline: [value], parents: this.parentsOf(path),
      meta: { path, kind, value, ...(extra.valueStart !== undefined ? { valueStart: extra.valueStart, valueEnd: extra.valueEnd } : {}), ...(key !== undefined ? { key } : {}), ...(comment ? { comment } : {}), ...(extra.anchor ? { anchor: extra.anchor } : {}), ...(extra.tag ? { tag: extra.tag } : {}) } });
  }

  group(path: PathSegment[], start: number, end: number, kind: "object" | "array" | "document", count: number, extra: Partial<BlockMeta> = {}): void {
    const parents = this.parentsOf(path);
    const attrs: Record<string, Scalar> = { path: identityPath(path), kind };
    if (extra.anchor) attrs.anchor = extra.anchor;
    if (extra.tag) attrs.tag = extra.tag;
    const comment = extra.comment ?? this.commentFor(start, end);
    // A group always precedes its descendants in every format, so no cached parents list can miss it.
    this.groups.set(JSON.stringify(path), this.atoms.length);
    this.atoms.push({ type: "group", start, end, attrs, inline: [], parents, depth: parents.length + 1,
      meta: { path, kind, count, ...(extra.key !== undefined ? { key: extra.key } : {}), ...(comment ? { comment } : {}), ...(extra.anchor ? { anchor: extra.anchor } : {}), ...(extra.tag ? { tag: extra.tag } : {}) } });
  }
}

// ── YAML ──

function yamlKeyText(source: string, key: unknown): string {
  if (isScalar(key)) return String(key.value);
  const node = key as YamlNode | null;
  return node?.range ? source.slice(node.range[0], node.range[1]) : String(key);
}

function yamlComment(...parts: (string | null | undefined)[]): string | undefined {
  const text = parts.filter((part): part is string => Boolean(part && part.trim())).map((part) => part.split("\n").map((line) => `#${line}`).join("\n")).join("\n");
  return text || undefined;
}

function scalarKind(node: YamlNode): { kind: Kind; value: string } {
  if (isAlias(node)) return { kind: "alias", value: `*${node.source}` };
  if (!isScalar(node)) return { kind: "string", value: "" };
  const value = node.value;
  if (value === null || value === undefined) return { kind: "null", value: "null" };
  if (typeof value === "boolean") return { kind: "boolean", value: String(value) };
  if (typeof value === "number" || typeof value === "bigint") return { kind: "number", value: typeof node.source === "string" ? node.source : String(value) };
  if (value instanceof Date) return { kind: "date", value: typeof node.source === "string" ? node.source : value.toISOString() };
  return { kind: "string", value: String(value) };
}

function parseYaml(source: string): StructuredParse | StructuredError {
  let docs: Document.Parsed[];
  try {
    docs = parseAllDocuments(source, { prettyErrors: false, uniqueKeys: false, keepSourceTokens: false }) as Document.Parsed[];
  } catch (error) {
    return { ok: false, line: 1, message: error instanceof Error ? error.message : String(error) };
  }
  if (!Array.isArray(docs)) docs = [docs as unknown as Document.Parsed];
  for (const doc of docs) {
    if (doc.errors.length) {
      const first = doc.errors[0];
      return { ok: false, line: first.linePos?.[0]?.line ?? lineAt(source, first.pos[0]), message: first.message.split("\n")[0] };
    }
  }
  const out = new Collector(source);
  const multi = docs.filter((doc) => doc.contents !== null).length > 1;
  docs.forEach((doc, docIndex) => {
    if (doc.contents === null) return;
    const base: PathSegment[] = multi ? [{ doc: docIndex }] : [];
    if (multi) {
      const contentStart = (doc.contents as YamlNode).range?.[0] ?? doc.range[0];
      const regionStart = docIndex === 0 ? 0 : docs[docIndex - 1].range[2];
      const region = source.slice(regionStart, contentStart);
      let marker = -1;
      for (const match of region.matchAll(/^---[^\n]*/gm)) marker = regionStart + (match.index ?? 0);
      const end = marker < 0 ? contentStart : (() => { const nl = source.indexOf("\n", marker); return nl < 0 ? source.length : nl; })();
      out.group(base, marker < 0 ? contentStart : marker, end, "document", containerCount(doc.contents as YamlNode) || 1, { comment: yamlComment(doc.commentBefore) });
    }
    walkYaml(source, out, doc.contents as YamlNode, base, 0);
  });
  return { ok: true, atoms: out.atoms };
}

function walkYaml(source: string, out: Collector, node: YamlNode, path: PathSegment[], depth: number): void {
  if (isMap(node)) {
    for (const pair of node.items as Pair<unknown, unknown>[]) yamlEntry(source, out, pair, path, depth);
  } else if (isSeq(node)) {
    node.items.forEach((item, index) => yamlItem(source, out, item as YamlNode | null, [...path, index], depth));
  } else {
    const start = node.range?.[0] ?? 0;
    const end = node.range?.[1] ?? start;
    const { kind, value } = scalarKind(node);
    out.leaf(path, start, end, kind, value, { comment: yamlComment(node.commentBefore, node.comment), valueStart: start, valueEnd: end });
  }
}

function containerCount(node: YamlNode): number {
  return isMap(node) || isSeq(node) ? node.items.length : 0;
}

function yamlEntry(source: string, out: Collector, pair: Pair<unknown, unknown>, path: PathSegment[], depth: number): void {
  if (!isPair(pair)) return;
  const keyNode = pair.key as YamlNode | null;
  const key = yamlKeyText(source, pair.key);
  const childPath = [...path, key];
  const keyStart = keyNode?.range?.[0] ?? 0;
  const keyEnd = keyNode?.range?.[1] ?? keyStart;
  const value = pair.value as YamlNode | null;
  const comment = yamlComment(keyNode?.commentBefore, value && !isMap(value) && !isSeq(value) ? value.comment : undefined);
  const colon = source.indexOf(":", keyEnd);
  if (!value) {
    out.leaf(childPath, keyStart, colon >= 0 ? colon + 1 : keyEnd, "null", "null", { key, comment });
    return;
  }
  const anchor = value.anchor ?? undefined;
  const tag = value.tag && !/^tag:yaml\.org,2002:/.test(value.tag) ? value.tag : undefined;
  if ((isMap(value) || isSeq(value)) && containerCount(value) > 0) {
    if (depth >= MAX_DEPTH) {
      const end = value.range?.[1] ?? keyEnd;
      out.leaf(childPath, keyStart, end, isMap(value) ? "object" : "array", source.slice(value.range?.[0] ?? keyEnd, end), { key, comment, anchor, tag, valueStart: value.range?.[0] ?? keyEnd, valueEnd: end });
      return;
    }
    // Header: the key line up to the value indicator (and props on the same line).
    const header = colon >= 0 ? colon + 1 : keyEnd;
    out.group(childPath, keyStart, header, isMap(value) ? "object" : "array", containerCount(value), { key, comment, anchor, tag });
    walkYaml(source, out, value, childPath, depth + 1);
    return;
  }
  if (isMap(value) || isSeq(value)) {
    const end = value.range?.[1] ?? keyEnd;
    out.leaf(childPath, keyStart, end, isMap(value) ? "object" : "array", isMap(value) ? "{}" : "[]", { key, comment, anchor, tag });
    return;
  }
  const end = value.range?.[1] ?? keyEnd;
  const { kind, value: shown } = scalarKind(value);
  out.leaf(childPath, keyStart, Math.max(end, keyEnd), kind, shown, { key, comment, anchor, tag, valueStart: value.range?.[0] ?? end, valueEnd: end });
}

function yamlItem(source: string, out: Collector, item: YamlNode | null, path: PathSegment[], depth: number): void {
  if (!item) return;
  const anchor = item.anchor ?? undefined;
  const tag = item.tag && !/^tag:yaml\.org,2002:/.test(item.tag) ? item.tag : undefined;
  if (isMap(item) || isSeq(item)) {
    if (!containerCount(item)) {
      out.leaf(path, item.range?.[0] ?? 0, item.range?.[1] ?? 0, isMap(item) ? "object" : "array", isMap(item) ? "{}" : "[]", { anchor, tag });
      return;
    }
    if (depth >= MAX_DEPTH) {
      out.leaf(path, item.range?.[0] ?? 0, item.range?.[1] ?? 0, isMap(item) ? "object" : "array", source.slice(item.range?.[0] ?? 0, item.range?.[1] ?? 0), { anchor, tag, valueStart: item.range?.[0] ?? 0, valueEnd: item.range?.[1] ?? 0 });
      return;
    }
    walkYaml(source, out, item, path, depth + 1);
    return;
  }
  const { kind, value } = scalarKind(item);
  out.leaf(path, item.range?.[0] ?? 0, item.range?.[1] ?? 0, kind, value, { anchor, tag, comment: yamlComment(item.commentBefore, item.comment), valueStart: item.range?.[0] ?? 0, valueEnd: item.range?.[1] ?? 0 });
}

// ── JSON / JSONC ──

function parseJson(source: string, comments: boolean): StructuredParse | StructuredError {
  const parsed = parseJsonTree(source, { comments });
  if (parsed.error || !parsed.root) {
    return { ok: false, line: parsed.error ? lineAt(source, parsed.error.offset) : 1, message: parsed.error?.message ?? "empty document" };
  }
  const out = new Collector(source, parsed.comments.map((c) => ({ start: c.start, end: c.end, text: source.slice(c.start, c.end) })));
  walkJson(source, out, parsed.root, [], 0);
  return { ok: true, atoms: out.atoms };
}

function jsonLeafKind(node: JsonNode): { kind: Kind; value: string } {
  if (node.type === "string") return { kind: "string", value: String(node.value) };
  if (node.type === "number") return { kind: "number", value: "" };
  if (node.type === "boolean") return { kind: "boolean", value: String(node.value) };
  return { kind: "null", value: "null" };
}

function walkJson(source: string, out: Collector, node: JsonNode, path: PathSegment[], depth: number): void {
  if (node.type === "object") {
    for (const property of node.children ?? []) {
      const [keyNode, value] = property.children ?? [];
      if (!keyNode) continue;
      const key = String(keyNode.value);
      const childPath = [...path, key];
      if (!value) continue;
      jsonValue(source, out, value, childPath, depth, property.offset, key);
    }
  } else if (node.type === "array") {
    (node.children ?? []).forEach((child, index) => jsonValue(source, out, child, [...path, index], depth, child.offset, undefined));
  } else {
    const { kind, value } = jsonLeafKind(node);
    out.leaf(path, node.offset, node.offset + node.length, kind, kind === "number" ? source.slice(node.offset, node.offset + node.length) : value, { valueStart: node.offset, valueEnd: node.offset + node.length });
  }
}

function jsonValue(source: string, out: Collector, value: JsonNode, path: PathSegment[], depth: number, start: number, key: string | undefined): void {
  const end = value.offset + value.length;
  if (value.type === "object" || value.type === "array") {
    const count = value.children?.length ?? 0;
    if (!count) {
      out.leaf(path, start, end, value.type, value.type === "object" ? "{}" : "[]", key !== undefined ? { key } : {});
      return;
    }
    if (depth >= MAX_DEPTH) {
      out.leaf(path, start, end, value.type, source.slice(value.offset, end), { ...(key !== undefined ? { key } : {}), valueStart: value.offset, valueEnd: end });
      return;
    }
    if (key !== undefined) out.group(path, start, value.offset + 1, value.type, count, { key });
    walkJson(source, out, value, path, depth + 1);
    return;
  }
  const { kind, value: shown } = jsonLeafKind(value);
  out.leaf(path, start, end, kind, kind === "number" ? source.slice(value.offset, end) : shown, { ...(key !== undefined ? { key } : {}), valueStart: value.offset, valueEnd: end });
}

// ── TOML ──

interface TomlNode {
  type: string;
  range: [number, number];
  kind?: string;
  value?: unknown;
  key?: { keys: { type: string; name?: string; value?: string }[]; range: [number, number] };
  resolvedKey?: (string | number)[];
  body?: TomlNode[];
  elements?: TomlNode[];
}

function tomlKeys(key: TomlNode["key"]): string[] {
  return (key?.keys ?? []).map((part) => (part.type === "TOMLBare" ? String(part.name) : String(part.value)));
}

function parseToml(source: string): StructuredParse | StructuredError {
  let ast: { body: TomlNode[]; comments: { range: [number, number]; value: string }[] };
  try {
    ast = parseTOML(source) as unknown as typeof ast;
  } catch (error) {
    const e = error as { lineNumber?: number; message?: string };
    return { ok: false, line: e.lineNumber ?? 1, message: e.message ?? String(error) };
  }
  const out = new Collector(source, ast.comments.map((c) => ({ start: c.range[0], end: c.range[1], text: source.slice(c.range[0], c.range[1]) })));
  const top = ast.body[0];
  for (const item of top?.body ?? []) {
    if (item.type === "TOMLTable") {
      const path = item.resolvedKey ?? tomlKeys(item.key);
      const keyEnd = item.key?.range[1] ?? item.range[0];
      const close = source.indexOf("]", keyEnd);
      const headerEnd = close < 0 ? keyEnd : item.kind === "array" && source[close + 1] === "]" ? close + 2 : close + 1;
      out.group(path, item.range[0], headerEnd, "object", item.body?.length ?? 0, { key: String(path[path.length - 1]) });
      for (const kv of item.body ?? []) tomlKeyValue(source, out, kv, path, path.length);
    } else tomlKeyValue(source, out, item, [], 0);
  }
  return { ok: true, atoms: out.atoms };
}

function tomlScalar(source: string, node: TomlNode): { kind: Kind; value: string } {
  const text = source.slice(node.range[0], node.range[1]);
  switch (node.kind) {
    case "string": return { kind: "string", value: String(node.value) };
    case "integer":
    case "float": return { kind: "number", value: text };
    case "boolean": return { kind: "boolean", value: text };
    default: return { kind: "date", value: text };
  }
}

function tomlKeyValue(source: string, out: Collector, kv: TomlNode, base: PathSegment[], depth: number): void {
  if (kv.type !== "TOMLKeyValue") return;
  const keys = tomlKeys(kv.key);
  const path = [...base, ...keys];
  tomlValue(source, out, kv.value as TomlNode, path, depth + keys.length, kv.range[0], keys[keys.length - 1]);
}

function tomlValue(source: string, out: Collector, value: TomlNode, path: PathSegment[], depth: number, start: number, key: string | undefined): void {
  const end = value.range[1];
  if (value.type === "TOMLArray" || value.type === "TOMLInlineTable") {
    const children = value.type === "TOMLArray" ? value.elements ?? [] : value.body ?? [];
    const kind = value.type === "TOMLArray" ? "array" : "object";
    if (!children.length || depth >= MAX_DEPTH) {
      out.leaf(path, start, end, kind, children.length ? source.slice(value.range[0], end) : kind === "array" ? "[]" : "{}", { ...(key !== undefined ? { key } : {}), ...(children.length ? { valueStart: value.range[0], valueEnd: end } : {}) });
      return;
    }
    if (key !== undefined) out.group(path, start, value.range[0] + 1, kind, children.length, { key });
    if (value.type === "TOMLArray") children.forEach((child, index) => tomlValue(source, out, child, [...path, index], depth + 1, child.range[0], undefined));
    else for (const kv of children) tomlKeyValue(source, out, kv, path, depth + 1);
    return;
  }
  const { kind, value: shown } = tomlScalar(source, value);
  out.leaf(path, start, end, kind, shown, { ...(key !== undefined ? { key } : {}), valueStart: value.range[0], valueEnd: end });
}

export function parseStructured(format: "yaml" | "json" | "jsonc" | "toml", source: string): StructuredParse | StructuredError {
  // A BOM is not part of any node: parse without it and shift every offset back by one.
  if (source.charCodeAt(0) === 0xfeff) {
    const inner = parseStructured(format, source.slice(1));
    if (!inner.ok) return inner;
    for (const atom of inner.atoms) {
      atom.start += 1;
      atom.end += 1;
      if (atom.meta?.valueStart !== undefined) atom.meta.valueStart += 1;
      if (atom.meta?.valueEnd !== undefined) atom.meta.valueEnd += 1;
    }
    return inner;
  }
  switch (format) {
    case "yaml": return parseYaml(source);
    case "json": return parseJson(source, false);
    case "jsonc": return parseJson(source, true);
    case "toml": return parseToml(source);
  }
}
