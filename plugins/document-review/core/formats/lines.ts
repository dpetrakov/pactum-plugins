// Profile bbdr-lines v1 (W-06c, file-types.md §5): text, CSV/TSV and .env as revisions of lines. A block is a
// non-blank line (trimmed), a CSV/TSV record (RFC 4180: quoted fields may hold separators, quotes and line breaks) or
// a .env entry (a KEY=value pair, possibly spanning lines inside quotes, or a comment line). It is also the fallback
// of a structured file that does not parse: its lines stay reviewable and the error line is reported.

import type { AtomicBlock } from "./assemble.ts";
import { trimRange } from "./assemble.ts";

/** Non-blank lines, each trimmed; the BOM is not part of the first line. */
export function textLines(source: string): AtomicBlock[] {
  const out: AtomicBlock[] = [];
  let start = 0;
  while (start <= source.length) {
    let end = source.indexOf("\n", start);
    if (end < 0) end = source.length;
    const [s, e] = trimRange(source, start, end);
    if (e > s) out.push({ type: "line", start: s, end: e, attrs: {}, inline: [source.slice(s, e)], parents: [] });
    start = end + 1;
  }
  return out;
}

export interface CsvRecord {
  /** UTF-16 range of the record without its line break. */
  start: number;
  end: number;
  cells: string[];
  /** 1-based line where the record starts. */
  line: number;
}

/** RFC 4180 records; a lone quote inside an unquoted field is kept as text (lenient, never throws). */
export function csvRecords(source: string, separator: "," | "\t"): CsvRecord[] {
  const out: CsvRecord[] = [];
  let i = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  while (i < source.length) {
    const start = i;
    const startLine = line;
    const cells: string[] = [];
    let cell = "";
    let quoted = false;
    let atFieldStart = true;
    let ended = false;
    while (i < source.length) {
      const ch = source[i];
      if (quoted) {
        if (ch === '"') {
          if (source[i + 1] === '"') { cell += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        if (ch === "\n") line++;
        cell += ch; i++; continue;
      }
      if (ch === '"' && atFieldStart) { quoted = true; atFieldStart = false; i++; continue; }
      if (ch === separator) { cells.push(cell); cell = ""; atFieldStart = true; i++; continue; }
      if (ch === "\n" || (ch === "\r" && source[i + 1] === "\n")) {
        const end = i;
        i += ch === "\r" ? 2 : 1;
        line++;
        cells.push(cell);
        out.push({ start, end, cells, line: startLine });
        ended = true;
        break;
      }
      cell += ch; atFieldStart = false; i++;
    }
    if (!ended) {
      cells.push(cell);
      out.push({ start, end: source.length, cells, line: startLine });
    }
  }
  // Blank records (empty lines) are not data.
  return out.filter((record) => record.end > record.start && !(record.cells.length === 1 && record.cells[0].trim() === ""));
}

export function csvBlocks(source: string, separator: "," | "\t"): AtomicBlock[] {
  return csvRecords(source, separator).map((record, index) => ({
    type: "line" as const, start: record.start, end: record.end, attrs: {}, inline: record.cells, parents: [],
    meta: { cells: record.cells, header: index === 0 },
  }));
}

export interface EnvEntry {
  kind: "pair" | "comment" | "other";
  /** UTF-16 range of the whole entry (trimmed). */
  start: number;
  end: number;
  key?: string;
  exported?: boolean;
  /** UTF-16 range of the value as written (quotes included), empty for `KEY=`. */
  valueStart?: number;
  valueEnd?: number;
  /** Range of the value content inside its quotes (what is secret). */
  innerStart?: number;
  innerEnd?: number;
  quote?: '"' | "'" | "`" | null;
  /** Trailing comment of an unquoted or quoted value. */
  comment?: string;
  /** Text after a closing quote that is not a comment (masked with the value). */
  tailStart?: number;
  tailEnd?: number;
}

/**
 * .env entries (dotenv syntax as most loaders read it): `KEY=value`, `export KEY=value`, single/double/backtick quotes,
 * double-quoted values may span lines, `# comment` lines and trailing ` # comment` after a value.
 */
export function envEntries(source: string): EnvEntry[] {
  const out: EnvEntry[] = [];
  let i = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < source.length) {
    let lineEnd = source.indexOf("\n", i);
    if (lineEnd < 0) lineEnd = source.length;
    const [s, e] = trimRange(source, i, lineEnd);
    if (e <= s) { i = lineEnd + 1; continue; }
    const line = source.slice(s, e);
    if (line.startsWith("#")) {
      out.push({ kind: "comment", start: s, end: e, comment: line });
      i = lineEnd + 1;
      continue;
    }
    const match = /^(export\s+)?([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*[=:]\s?/.exec(line);
    if (!match) {
      out.push({ kind: "other", start: s, end: e });
      i = lineEnd + 1;
      continue;
    }
    const valueStart = s + match[0].length;
    let valueEnd = e;
    let innerStart = valueStart;
    let innerEnd = e;
    let quote: EnvEntry["quote"] = null;
    let comment: string | undefined;
    let entryEnd = e;
    let tail: [number, number] | undefined;
    const first = source[valueStart];
    if (first === '"' || first === "'" || first === "`") {
      quote = first;
      // The closing quote may be on a later line for every quote kind; double quotes honour backslash escapes.
      let j = valueStart + 1;
      while (j < source.length) {
        if (source[j] === "\\" && quote === '"') { j += 2; continue; }
        if (source[j] === quote) break;
        j++;
      }
      if (j < source.length && source[j] === quote) {
        innerStart = valueStart + 1;
        innerEnd = j;
        valueEnd = j + 1;
        let restEnd = source.indexOf("\n", valueEnd);
        if (restEnd < 0) restEnd = source.length;
        const rest = source.slice(valueEnd, restEnd);
        const hash = rest.search(/(^|\s)#/);
        if (hash >= 0) comment = rest.slice(hash).trim();
        // Text after the closing quote that is not a comment belongs to the value (masked with it).
        const junkEnd = valueEnd + (hash >= 0 ? hash : rest.length);
        const [ts, te] = trimRange(source, valueEnd, junkEnd);
        if (te > ts) tail = [ts, te];
        entryEnd = Math.max(trimRange(source, valueEnd, restEnd)[1], valueEnd);
        lineEnd = restEnd;
      } else {
        // Unterminated quote: everything to the end of the file is the value (only stronger).
        innerStart = valueStart + 1;
        innerEnd = trimRange(source, valueStart + 1, source.length)[1];
        valueEnd = innerEnd;
        entryEnd = innerEnd;
        lineEnd = source.length;
      }
    } else {
      const hash = line.slice(match[0].length).search(/\s#/);
      if (hash >= 0) {
        valueEnd = trimRange(source, valueStart, valueStart + hash)[1];
        comment = source.slice(valueStart + hash, e).trim();
      }
      innerStart = valueStart;
      innerEnd = valueEnd;
    }
    out.push({ kind: "pair", start: s, end: entryEnd, key: match[2], exported: Boolean(match[1]), valueStart, valueEnd, innerStart, innerEnd, quote, ...(comment ? { comment } : {}), ...(tail ? { tailStart: tail[0], tailEnd: tail[1] } : {}) });
    i = lineEnd + 1;
  }
  return out;
}

export function envBlocks(source: string): AtomicBlock[] {
  return envEntries(source).map((entry): AtomicBlock => {
    const text = source.slice(entry.start, entry.end);
    if (entry.kind === "pair") {
      const value = source.slice(entry.innerStart!, entry.innerEnd!);
      return { type: "line", start: entry.start, end: entry.end, attrs: { kind: "pair", key: entry.key! }, inline: [value],
        parents: [], meta: { key: entry.key, value, kind: "pair", ...(entry.comment ? { comment: entry.comment } : {}) } };
    }
    return { type: "line", start: entry.start, end: entry.end, attrs: { kind: entry.kind }, inline: [text], parents: [], meta: { kind: entry.kind } };
  });
}
