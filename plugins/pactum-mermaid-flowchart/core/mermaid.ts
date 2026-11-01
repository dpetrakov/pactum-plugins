import { tr } from "./i18n.ts";
// Mermaid adapter (W-06f, EP-058-T02/EP-059-T02): the documented flowchart/graph syntax → a normalized graph model with
// source ranges. Pure and dependency-free: the model is built from the source text only, never from Mermaid's private
// AST or a rendered SVG, and nothing in the source is executed (directives, styles, click callbacks are reported as
// warnings and ignored). Other diagram types are detected and reported as unsupported for the interactive view.

/** Model format version: part of cache keys and of stored layouts (a new version re-validates personal pins). */
export const MERMAID_MODEL_VERSION = "1";

export type Direction = "TB" | "BT" | "LR" | "RL";
export type NodeShape =
  | "rect" | "round" | "stadium" | "subroutine" | "cylinder" | "circle" | "double-circle" | "asymmetric"
  | "diamond" | "hexagon" | "parallelogram" | "parallelogram-alt" | "trapezoid" | "trapezoid-alt";
export type EdgeLine = "solid" | "dotted" | "thick" | "invisible";
export type EdgeEnd = "none" | "arrow" | "circle" | "cross";

/** 1-based line within the fenced block's source and 0-based UTF-16 columns [start, end). */
export type SourceRange = { line: number; start: number; end: number };

export type GraphNode = { id: string; label: string; shape: NodeShape; group: string | null; ranges: SourceRange[] };
export type GraphEdge = {
  /** Explicit id (`A e1@--> B`) or `<from>-><to>#<n>`: n — index among edges with the same ends, in source order. */
  id: string; explicitId: boolean; from: string; to: string; label: string;
  line: EdgeLine; head: EdgeEnd; tail: EdgeEnd; length: number; range: SourceRange;
};
export type GraphGroup = { id: string; title: string; parent: string | null; direction: Direction | null; range: SourceRange };
export type Warning = { line: number; code: "directive" | "style" | "click" | "class" | "unsupported-syntax" | "html-label"; message: string };
export type FlowModel = {
  kind: "flowchart"; version: typeof MERMAID_MODEL_VERSION; direction: Direction;
  nodes: GraphNode[]; edges: GraphEdge[]; groups: GraphGroup[]; warnings: Warning[];
};
export type ParseResult =
  | { ok: true; model: FlowModel }
  | { ok: false; reason: "syntax"; line: number; message: string }
  | { ok: false; reason: "unsupported"; diagram: string; message: string }
  | { ok: false; reason: "too-large"; message: string }
  | { ok: false; reason: "empty"; message: string };

export const LIMITS = { bytes: 64 * 1024, nodes: 200, edges: 400, groups: 64, labelChars: 400 };

const DIAGRAM = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|mindmap|timeline|sankey(?:-beta)?|xychart(?:-beta)?|block(?:-beta)?|packet(?:-beta)?|kanban|architecture(?:-beta)?|C4\w*|zenuml|radar(?:-beta)?|treemap(?:-beta)?)\b/;
const DIRECTIONS = new Set(["TB", "TD", "BT", "LR", "RL"]);
const normDir = (value: string): Direction => (value === "TD" ? "TB" : value) as Direction;

/** Node shapes by opening bracket sequence, longest first; `close` is the matching closing sequence. */
const SHAPES: { open: string; close: string; shape: NodeShape }[] = [
  { open: "(((", close: ")))", shape: "double-circle" },
  { open: "([", close: "])", shape: "stadium" },
  { open: "[[", close: "]]", shape: "subroutine" },
  { open: "[(", close: ")]", shape: "cylinder" },
  { open: "((", close: "))", shape: "circle" },
  { open: "{{", close: "}}", shape: "hexagon" },
  { open: "[/", close: "/]", shape: "parallelogram" },
  { open: "[\\", close: "\\]", shape: "parallelogram-alt" },
  { open: "[/", close: "\\]", shape: "trapezoid" },
  { open: "[\\", close: "/]", shape: "trapezoid-alt" },
  { open: "[", close: "]", shape: "rect" },
  { open: "(", close: ")", shape: "round" },
  { open: "{", close: "}", shape: "diamond" },
  { open: ">", close: "]", shape: "asymmetric" },
];

/** Link token: optional text in the middle (`-- text -->`, `-. text .->`, `== text ==>`), arrow heads on both sides. */
const LINK = /^(?:([ox<])?(--+|==+|-\.+-?|~~~+)([->ox]|-)?)/;

class ParseError extends Error {
  readonly line: number;
  constructor(line: number, message: string) { super(message); this.line = line; }
}

type Cursor = { text: string; pos: number; line: number; offset: number };

const isIdChar = (ch: string) => /[\p{L}\p{N}_]/u.test(ch) || ch === "-" || ch === ".";

function skipSpace(c: Cursor) { while (c.pos < c.text.length && (c.text[c.pos] === " " || c.text[c.pos] === "\t")) c.pos++; }

/** Strip quotes and markdown-string backticks; keep plain text (no HTML is ever produced from a label). */
function cleanLabel(raw: string, line: number, warnings: Warning[]): string {
  let text = raw.trim();
  if (text.startsWith("\"") && text.endsWith("\"") && text.length >= 2) text = text.slice(1, -1);
  if (text.startsWith("`") && text.endsWith("`") && text.length >= 2) text = text.slice(1, -1);
  if (/<[a-z/][^>]*>/i.test(text)) {
    warnings.push({ line, code: "html-label", message: tr("HTML labels are shown as text", "HTML в подписи показывается как текст") });
    text = text.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "");
  }
  text = text.replace(/#quot;/g, "\"").replace(/#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
  return text.length > LIMITS.labelChars ? `${text.slice(0, LIMITS.labelChars)}…` : text;
}

/** Read a bracketed label starting at c.pos; quoted text may contain the closing bracket. */
function readShape(c: Cursor, warnings: Warning[]): { shape: NodeShape; label: string } | null {
  const rest = c.text.slice(c.pos);
  for (const candidate of SHAPES) {
    if (!rest.startsWith(candidate.open)) continue;
    let i = candidate.open.length;
    let quoted = false;
    while (i < rest.length) {
      if (rest[i] === "\"") quoted = !quoted;
      if (!quoted && rest.startsWith(candidate.close, i)) {
        // `[/a/]` vs `[/a\]`: only accept the close that matches this candidate.
        const label = rest.slice(candidate.open.length, i);
        c.pos += i + candidate.close.length;
        return { shape: candidate.shape, label: cleanLabel(label, c.line, warnings) };
      }
      i++;
    }
  }
  return null;
}

function readId(c: Cursor): string {
  const start = c.pos;
  while (c.pos < c.text.length && isIdChar(c.text[c.pos])) {
    // `A-->B`: an id ends before a link token.
    if (c.text[c.pos] === "-" && (c.text[c.pos + 1] === "-" || c.text[c.pos + 1] === ".")) break;
    if (c.text[c.pos] === "." && c.text[c.pos + 1] === "-") break;
    c.pos++;
  }
  return c.text.slice(start, c.pos);
}

type NodeRef = { id: string; range: SourceRange };

/**
 * A link: `-->`, `---`, `-.->`, `-.-`, `==>`, `===`, `~~~`, `--o`, `--x`, `<-->`, `o--o`, longer variants; text as
 * `-- text -->`, `-. text .->`, `== text ==>` or `-->|text|`; an optional explicit id `e1@-->`. Undefined when no link
 * starts at the cursor (the cursor is not moved then).
 */
function readLink(c: Cursor, warnings: Warning[]): { line: EdgeLine; head: EdgeEnd; tail: EdgeEnd; length: number; label: string; id: string | null } | undefined {
  skipSpace(c);
  const begin = c.pos;
  let explicit: string | null = null;
  const idMatch = /^([A-Za-z_][\w-]*)@(?=[-=~ox<])/.exec(c.text.slice(c.pos));
  if (idMatch) { explicit = idMatch[1]; c.pos += idMatch[0].length; }
  const rest = c.text.slice(c.pos);
  const endMark = (mark: string | undefined): EdgeEnd => mark === ">" || mark === "<" ? "arrow" : mark === "o" ? "circle" : mark === "x" ? "cross" : "none";
  // o/x heads only when followed by a space, `|` or the end: `A--oB` is not a circle head in Mermaid either.
  const head = "(?:(>)|([ox])(?=[\\s|]|$))?";
  const plain = new RegExp(`^([ox<])?(?:(-{2,})${head}|(-\\.+-)${head}|(={2,})${head}|(~{3,}))`).exec(rest);
  let line: EdgeLine, tail: string | undefined, headMark: string | undefined, length: number, label = "", consumed: number;
  const textStart = /^([<ox])?(--|-\.|==)\s+(?![-.=>|])/.exec(rest);
  if (textStart) {
    // `-- text -->`: the closing part decides the head; the text is everything in between.
    tail = textStart[1];
    const kind = textStart[2];
    line = kind === "==" ? "thick" : kind === "-." ? "dotted" : "solid";
    const close = line === "thick" ? /(={2,})([>ox])?(?=[\s|]|$|[^\s=])/ : line === "dotted" ? /(\.-+)([>ox])?/ : /(-{2,})([>ox])?/;
    const body = rest.slice(textStart[0].length);
    const m = close.exec(body);
    if (!m) throw new ParseError(c.line, tr("Unclosed edge label", "Не закрыта подпись связи"));
    label = cleanLabel(body.slice(0, m.index), c.line, warnings);
    headMark = m[2];
    length = Math.max(1, m[1].replace(/\./g, "").length - 1);
    consumed = textStart[0].length + m.index + m[0].length;
  } else if (plain) {
    tail = plain[1];
    if (plain[2]) { line = "solid"; headMark = plain[3] ?? plain[4]; length = plain[2].length - 1; }
    else if (plain[5]) { line = "dotted"; headMark = plain[6] ?? plain[7]; length = plain[5].length - 2; }
    else if (plain[8]) { line = "thick"; headMark = plain[9] ?? plain[10]; length = plain[8].length - 1; }
    else { line = "invisible"; length = plain[11].length - 2; }
    consumed = plain[0].length;
  } else {
    c.pos = begin;
    return undefined;
  }
  c.pos += consumed;
  skipSpace(c);
  if (c.text[c.pos] === "|") {
    const end = c.text.indexOf("|", c.pos + 1);
    if (end < 0) throw new ParseError(c.line, tr("Unclosed edge label between pipes", "Не закрыта подпись связи «|…|»"));
    label = cleanLabel(c.text.slice(c.pos + 1, end), c.line, warnings);
    c.pos = end + 1;
  }
  return { line, head: endMark(headMark), tail: endMark(tail), length: Math.max(1, length), label, id: explicit };
}

/** Split a line into statements on `;` outside quotes and brackets. */
function statements(line: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  let depth = 0, quoted = false, start = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\"") quoted = !quoted;
    else if (!quoted && "[({".includes(ch)) depth++;
    else if (!quoted && "])}".includes(ch)) depth = Math.max(0, depth - 1);
    else if (!quoted && depth === 0 && ch === ";") { out.push({ text: line.slice(start, i), offset: start }); start = i + 1; }
  }
  out.push({ text: line.slice(start), offset: start });
  return out.filter((part) => part.text.trim());
}

/** Detect the diagram type: the first meaningful line, after front matter, comments and init directives. */
export function diagramType(source: string): string | null {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  if (lines[0]?.trim() === "---") { i = 1; while (i < lines.length && lines[i].trim() !== "---") i++; i++; }
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("%%")) continue;
    return DIAGRAM.exec(line)?.[1] ?? line.split(/\s/)[0];
  }
  return null;
}

/** Parse a fenced Mermaid block. Never throws: returns a syntax error with its line, or the reason it is not drawn. */
export function parseMermaid(source: string): ParseResult {
  if (new TextEncoder().encode(source).length > LIMITS.bytes) return { ok: false, reason: "too-large", message: tr(`Diagram exceeds ${LIMITS.bytes / 1024} KiB`, `Схема больше ${LIMITS.bytes / 1024} КиБ`) };
  const type = diagramType(source);
  if (!type) return { ok: false, reason: "empty", message: tr("Empty diagram", "Пустая схема") };
  if (type !== "flowchart" && type !== "graph") return { ok: false, reason: "unsupported", diagram: type, message: tr(`The ${type} diagram is shown as code; interactive rendering supports flowchart/graph`, `Тип «${type}» показывается кодом: интерактивная схема строится для flowchart/graph`) };
  try {
    return { ok: true, model: parseFlowchart(source) };
  } catch (error) {
    if (error instanceof ParseError) return { ok: false, reason: "syntax", line: error.line, message: error.message };
    if (error instanceof RangeError) return { ok: false, reason: "too-large", message: error.message };
    throw error;
  }
}

function parseFlowchart(source: string): FlowModel {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const warnings: Warning[] = [];
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const groups = new Map<string, GraphGroup>();
  const stack: string[] = [];
  let direction: Direction = "TB";
  let header = false;
  let index = 0;
  if (lines[0]?.trim() === "---") { index = 1; while (index < lines.length && lines[index].trim() !== "---") index++; index++; warnings.push({ line: 1, code: "directive", message: tr("Diagram frontmatter settings are not applied", "Настройки в начале схемы не применяются") }); }

  const touch = (ref: NodeRef, shape?: { shape: NodeShape; label: string }) => {
    let node = nodes.get(ref.id);
    if (!node) {
      if (nodes.size >= LIMITS.nodes) throw new RangeError(tr(`More than ${LIMITS.nodes} nodes`, `Больше ${LIMITS.nodes} узлов`));
      node = { id: ref.id, label: ref.id, shape: "rect", group: stack.at(-1) ?? null, ranges: [] };
      nodes.set(ref.id, node);
    }
    if (shape) { node.shape = shape.shape; node.label = shape.label; }
    node.ranges.push(ref.range);
    return node;
  };

  const readNode = (c: Cursor): NodeRef | null => {
    skipSpace(c);
    const start = c.pos;
    const id = readId(c);
    if (!id) return null;
    const shape = readShape(c, warnings);
    if (c.text.startsWith(":::", c.pos)) {
      c.pos += 3; readId(c);
      warnings.push({ line: c.line, code: "class", message: tr("Source styling classes are not applied", "Классы оформления из исходника не применяются") });
    }
    const ref = { id, range: { line: c.line, start: c.offset + start, end: c.offset + c.pos } };
    touch(ref, shape ?? undefined);
    return ref;
  };
  const readGroup = (c: Cursor): NodeRef[] => {
    const refs: NodeRef[] = [];
    const first = readNode(c);
    if (!first) return refs;
    refs.push(first);
    for (;;) {
      skipSpace(c);
      if (c.text[c.pos] !== "&") break;
      c.pos++;
      const next = readNode(c);
      if (!next) throw new ParseError(c.line, tr("Expected a node after &", "Ожидался узел после «&»"));
      refs.push(next);
    }
    return refs;
  };

  for (; index < lines.length; index++) {
    const lineNo = index + 1;
    const raw = lines[index];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("%%{")) { warnings.push({ line: lineNo, code: "directive", message: tr("The %%{…}%% directive is not applied", "Директива %%{…}%% не применяется") }); continue; }
    if (trimmed.startsWith("%%")) continue;
    if (!header) {
      const m = /^(flowchart|graph)(?:\s+(\w+))?\s*;?\s*$/.exec(trimmed);
      if (!m) throw new ParseError(lineNo, tr("Expected flowchart or graph with a direction", "Ожидалось «flowchart» или «graph» с направлением"));
      if (m[2]) { if (!DIRECTIONS.has(m[2])) throw new ParseError(lineNo, tr(`Unknown direction: ${m[2]}`, `Неизвестное направление «${m[2]}»`)); direction = normDir(m[2]); }
      header = true;
      continue;
    }
    for (const part of statements(raw)) {
      const text = part.text;
      const t = text.trim();
      const lead = text.length - text.trimStart().length;
      if (/^subgraph\b/.test(t)) {
        const rest = t.slice("subgraph".length).trim();
        const m = /^([^\s[]+)\s*(?:\[(.*)\])?\s*$/.exec(rest);
        let id: string, title: string;
        if (m && m[2] !== undefined) { id = m[1]; title = cleanLabel(m[2], lineNo, warnings); }
        else if (m && !/\s/.test(rest)) { id = m[1]; title = m[1]; }
        else { title = cleanLabel(rest, lineNo, warnings); id = title || `group${groups.size + 1}`; }
        if (groups.size >= LIMITS.groups) throw new RangeError(tr(`More than ${LIMITS.groups} groups`, `Больше ${LIMITS.groups} групп`));
        if (groups.has(id)) throw new ParseError(lineNo, tr(`Group ${id} is declared twice`, `Группа «${id}» объявлена дважды`));
        groups.set(id, { id, title, parent: stack.at(-1) ?? null, direction: null, range: { line: lineNo, start: part.offset + lead, end: part.offset + text.length } });
        stack.push(id);
        continue;
      }
      if (t === "end") {
        if (!stack.length) throw new ParseError(lineNo, tr("end without subgraph", "«end» без «subgraph»"));
        stack.pop();
        continue;
      }
      const dir = /^direction\s+(\w+)$/.exec(t);
      if (dir) {
        if (!DIRECTIONS.has(dir[1])) throw new ParseError(lineNo, tr(`Unknown direction: ${dir[1]}`, `Неизвестное направление «${dir[1]}»`));
        if (stack.length) groups.get(stack.at(-1)!)!.direction = normDir(dir[1]); else direction = normDir(dir[1]);
        continue;
      }
      if (/^(classDef|class|style|linkStyle)\b/.test(t)) { warnings.push({ line: lineNo, code: "style", message: tr("Source styling is not applied; colors follow the bb theme", "Оформление из исходника не применяется: цвета задаёт тема bb") }); continue; }
      if (/^click\b/.test(t)) { warnings.push({ line: lineNo, code: "click", message: tr("Click actions are not executed", "Действия click не выполняются") }); continue; }
      if (/^\w+@\{/.test(t)) { warnings.push({ line: lineNo, code: "unsupported-syntax", message: tr("Node @{…} syntax is unsupported; the identifier is shown", "Синтаксис узла @{…} пока не поддержан — показан идентификатор") }); }
      const c: Cursor = { text, pos: 0, line: lineNo, offset: part.offset };
      let left = readGroup(c);
      if (!left.length) throw new ParseError(lineNo, tr(`Could not parse: ${t.slice(0, 40)}`, `Не удалось разобрать «${t.slice(0, 40)}»`));
      for (;;) {
        const before = c.pos;
        const link = readLink(c, warnings);
        if (!link) break;
        const right = readGroup(c);
        if (!right.length) throw new ParseError(lineNo, tr("Expected a node after an edge", "Ожидался узел после связи"));
        for (const a of left) for (const b of right) {
          if (edges.length >= LIMITS.edges) throw new RangeError(tr(`More than ${LIMITS.edges} edges`, `Больше ${LIMITS.edges} связей`));
          edges.push({ id: link.id ?? "", explicitId: link.id !== null, from: a.id, to: b.id, label: link.label, line: link.line,
            head: link.head, tail: link.tail, length: link.length, range: { line: lineNo, start: part.offset + before, end: part.offset + c.pos } });
        }
        left = right;
      }
      skipSpace(c);
      if (c.pos < text.length) throw new ParseError(lineNo, tr(`Unexpected text: ${text.slice(c.pos).trim().slice(0, 40)}`, `Лишний текст: «${text.slice(c.pos).trim().slice(0, 40)}»`));
    }
  }
  if (!header) throw new ParseError(1, tr("Expected flowchart or graph", "Ожидалось «flowchart» или «graph»"));
  if (stack.length) throw new ParseError(lines.length, tr(`Unclosed group: ${stack.at(-1)}`, `Не закрыта группа «${stack.at(-1)}»`));
  // Edge identity: explicit id, else ends + index among parallel edges in source order.
  const seen = new Map<string, number>();
  const ids = new Set<string>();
  for (const edge of edges) {
    if (!edge.explicitId) {
      const key = `${edge.from}->${edge.to}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      edge.id = `${key}#${n}`;
    }
    if (ids.has(edge.id)) throw new ParseError(edge.range.line, tr(`Edge ${edge.id} is declared twice`, `Связь «${edge.id}» объявлена дважды`));
    ids.add(edge.id);
  }
  // An id that names a subgraph is the group itself (`A --> outer`): not a node; edges keep it as an endpoint.
  for (const id of groups.keys()) nodes.delete(id);
  // A node mentioned only inside a group stays in the group where it was first declared (Mermaid's rule).
  return { kind: "flowchart", version: MERMAID_MODEL_VERSION, direction, nodes: [...nodes.values()], edges, groups: [...groups.values()], warnings };
}
