// Syntax highlighting of the “Raw” view (W-06c, file-types.md §6 «Syntax highlighting», F22): tokens with roles,
// no colours (the roles are the --dr-syn-* layer of the design system). Line by line with a small state for what spans
// lines (YAML block scalars, TOML multi-line strings, JSONC block comments, CSV quoted fields, fenced Markdown code).
// Pure and cheap: runs in the browser on the redacted text; a tokenizer never fails — unknown text has no role.

/** k key · h TOML table header · s string · n number/date · l literal/anchor/alias/tag · c comment · p punctuation · d document marker/heading · c0–c3 CSV columns */
export type Role = "k" | "h" | "s" | "n" | "l" | "c" | "p" | "d" | "c0" | "c1" | "c2" | "c3";

export interface Token {
  /** UTF-16 offsets inside the line. */
  s: number;
  e: number;
  role: Role;
}

export type Language = "markdown" | "yaml" | "json" | "toml" | "dotenv" | "text" | "csv" | "tsv";

const NUMBER = /^[-+]?(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][-+]?\d+)?|inf|nan)$/;
const DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$|^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

function push(out: Token[], s: number, e: number, role: Role) {
  if (e > s) out.push({ s, e, role });
}

/** End of a quoted string starting at `i` (index of the quote), honouring backslash escapes in double quotes. */
function quoteEnd(line: string, i: number): number {
  const q = line[i];
  let j = i + 1;
  while (j < line.length) {
    if (line[j] === "\\" && q === '"') { j += 2; continue; }
    if (line[j] === q) {
      if (q === "'" && line[j + 1] === "'") { j += 2; continue; }
      return j + 1;
    }
    j++;
  }
  return line.length;
}

function scalarRole(text: string): Role {
  const value = text.trim();
  if (/^(true|false|null|~|yes|no|on|off|True|False|Null|NULL|TRUE|FALSE)$/.test(value)) return "l";
  if (NUMBER.test(value) || DATE.test(value)) return "n";
  return "s";
}

// ── YAML ──

interface YamlState { block: number | null }

function yamlValue(line: string, from: number, out: Token[]) {
  let i = from;
  while (i < line.length) {
    const ch = line[i];
    if (ch === " " || ch === "\t") { i++; continue; }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) { push(out, i, line.length, "c"); return; }
    if (ch === '"' || ch === "'") { const e = quoteEnd(line, i); push(out, i, e, "s"); i = e; continue; }
    if (ch === "&" || ch === "*" || ch === "!") {
      let e = i + 1;
      while (e < line.length && !/[\s,\]}]/.test(line[e])) e++;
      push(out, i, e, "l");
      i = e;
      continue;
    }
    if ("{}[],".includes(ch)) {
      push(out, i, i + 1, "p");
      i++;
      // A key inside a flow mapping: «key: value».
      const key = /^\s*([^\s:,{}[\]"'#]+|"[^"]*"|'[^']*')(\s*):(?=\s|$)/.exec(line.slice(i));
      if (key && (ch === "{" || ch === ",")) {
        const ks = i + key[0].indexOf(key[1]);
        push(out, ks, ks + key[1].length, "k");
        push(out, i + key[0].length - 1, i + key[0].length, "p");
        i += key[0].length;
      }
      continue;
    }
    // A plain scalar up to a flow indicator or a comment.
    let e = i;
    while (e < line.length && !(line[e] === "#" && /\s/.test(line[e - 1] ?? " ")) && !",]}".includes(line[e])) e++;
    let end = e;
    while (end > i && /\s/.test(line[end - 1])) end--;
    push(out, i, end, scalarRole(line.slice(i, end)));
    i = e;
  }
}

function yamlLine(line: string, state: YamlState): Token[] {
  const out: Token[] = [];
  const indent = /^[ \t]*/.exec(line)![0].length;
  if (state.block !== null) {
    if (!line.trim() || indent > state.block) { push(out, indent, line.length, "s"); return out; }
    state.block = null;
  }
  if (/^(---|\.\.\.)(\s|$)/.test(line)) { push(out, 0, 3, "d"); yamlValue(line, 3, out); return out; }
  if (/^\s*#/.test(line)) { push(out, indent, line.length, "c"); return out; }
  let i = indent;
  while (line.startsWith("- ", i) || line === "-" || (line[i] === "-" && i === line.length - 1)) { push(out, i, i + 1, "p"); i += 2; }
  const key = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#:{}[\],&*!|>'"%@`][^#:]*?)(\s*):(?=\s|$)/.exec(line.slice(i));
  if (key) {
    push(out, i, i + key[1].length, "k");
    const colon = i + key[1].length + key[2].length;
    push(out, colon, colon + 1, "p");
    i = colon + 1;
  }
  const rest = line.slice(i);
  const header = /^\s*([|>][-+0-9]*)\s*(#.*)?$/.exec(rest);
  if (header) {
    const at = i + rest.indexOf(header[1]);
    push(out, at, at + header[1].length, "p");
    if (header[2]) push(out, i + rest.indexOf(header[2]), line.length, "c");
    state.block = indent;
    return out;
  }
  yamlValue(line, i, out);
  return out;
}

// ── JSON / JSONC ──

interface JsonState { comment: boolean }

function jsonLine(line: string, state: JsonState): Token[] {
  const out: Token[] = [];
  let i = 0;
  if (state.comment) {
    const close = line.indexOf("*/");
    if (close < 0) { push(out, 0, line.length, "c"); return out; }
    push(out, 0, close + 2, "c");
    state.comment = false;
    i = close + 2;
  }
  while (i < line.length) {
    const ch = line[i];
    if (ch === " " || ch === "\t" || ch === "\r") { i++; continue; }
    if (ch === "/" && line[i + 1] === "/") { push(out, i, line.length, "c"); return out; }
    if (ch === "/" && line[i + 1] === "*") {
      const close = line.indexOf("*/", i + 2);
      if (close < 0) { push(out, i, line.length, "c"); state.comment = true; return out; }
      push(out, i, close + 2, "c");
      i = close + 2;
      continue;
    }
    if (ch === '"') {
      const e = quoteEnd(line, i);
      const after = /^\s*:/.test(line.slice(e));
      push(out, i, e, after ? "k" : "s");
      i = e;
      continue;
    }
    if ("{}[],:".includes(ch)) { push(out, i, i + 1, "p"); i++; continue; }
    const word = /^[-+0-9.eE]+|^[A-Za-z_]+/.exec(line.slice(i));
    if (word) { push(out, i, i + word[0].length, /^(true|false|null)$/.test(word[0]) ? "l" : NUMBER.test(word[0]) ? "n" : "s"); i += word[0].length; continue; }
    i++;
  }
  return out;
}

// ── TOML ──

interface TomlState { multi: '"""' | "'''" | null }

function tomlValue(line: string, from: number, out: Token[], state: TomlState) {
  let i = from;
  while (i < line.length) {
    const ch = line[i];
    if (ch === " " || ch === "\t" || ch === "\r") { i++; continue; }
    if (ch === "#") { push(out, i, line.length, "c"); return; }
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      const q = line.slice(i, i + 3) as '"""' | "'''";
      const close = line.indexOf(q, i + 3);
      if (close < 0) { push(out, i, line.length, "s"); state.multi = q; return; }
      push(out, i, close + 3, "s");
      i = close + 3;
      continue;
    }
    if (ch === '"' || ch === "'") { const e = quoteEnd(line, i); push(out, i, e, "s"); i = e; continue; }
    if ("{}[],=".includes(ch)) {
      push(out, i, i + 1, "p");
      i++;
      if (ch === "{" || ch === ",") {
        const key = /^\s*([A-Za-z0-9_.-]+|"[^"]*"|'[^']*')\s*=/.exec(line.slice(i));
        if (key) { const ks = i + key[0].indexOf(key[1]); push(out, ks, ks + key[1].length, "k"); push(out, i + key[0].length - 1, i + key[0].length, "p"); i += key[0].length; }
      }
      continue;
    }
    const word = /^[^\s,\]}#]+/.exec(line.slice(i));
    if (word) { push(out, i, i + word[0].length, /^(true|false)$/.test(word[0]) ? "l" : NUMBER.test(word[0]) || DATE.test(word[0].replace("T", "T")) || /^\d{4}-/.test(word[0]) || /^\d{2}:/.test(word[0]) ? "n" : "s"); i += word[0].length; continue; }
    i++;
  }
}

function tomlLine(line: string, state: TomlState): Token[] {
  const out: Token[] = [];
  if (state.multi) {
    const close = line.indexOf(state.multi);
    if (close < 0) { push(out, 0, line.length, "s"); return out; }
    push(out, 0, close + 3, "s");
    state.multi = null;
    tomlValue(line, close + 3, out, state);
    return out;
  }
  const indent = /^[ \t]*/.exec(line)![0].length;
  if (line[indent] === "#") { push(out, indent, line.length, "c"); return out; }
  const header = /^(\s*)(\[\[?)([^\]]*)(\]\]?)(.*)$/.exec(line);
  if (header) {
    const open = header[1].length;
    push(out, open, open + header[2].length, "p");
    push(out, open + header[2].length, open + header[2].length + header[3].length, "h");
    const close = open + header[2].length + header[3].length;
    push(out, close, close + header[4].length, "p");
    tomlValue(line, close + header[4].length, out, state);
    return out;
  }
  const key = /^(\s*)((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)(\s*)=/.exec(line);
  if (key) {
    push(out, key[1].length, key[1].length + key[2].length, "k");
    const eq = key[0].length - 1;
    push(out, eq, eq + 1, "p");
    tomlValue(line, eq + 1, out, state);
    return out;
  }
  tomlValue(line, 0, out, state);
  return out;
}

// ── .env ──

interface EnvState { quote: string | null }

function envLine(line: string, state: EnvState): Token[] {
  const out: Token[] = [];
  if (state.quote) {
    const close = line.indexOf(state.quote);
    if (close < 0) { push(out, 0, line.length, "s"); return out; }
    push(out, 0, close + 1, "s");
    state.quote = null;
    const hash = line.indexOf("#", close + 1);
    if (hash >= 0) push(out, hash, line.length, "c");
    return out;
  }
  const indent = /^\s*/.exec(line)![0].length;
  if (line[indent] === "#") { push(out, indent, line.length, "c"); return out; }
  const m = /^(\s*)(export\s+)?([A-Za-z0-9_][A-Za-z0-9_.-]*)(\s*[=:]\s*)(.*)$/.exec(line);
  if (!m) return out;
  let i = m[1].length;
  if (m[2]) { push(out, i, i + m[2].trimEnd().length, "l"); i += m[2].length; }
  push(out, i, i + m[3].length, "k");
  i += m[3].length;
  const eq = i + m[4].indexOf(m[4].trim()[0] ?? "=");
  push(out, eq, eq + 1, "p");
  i += m[4].length;
  const value = m[5];
  if (value.startsWith('"') || value.startsWith("'") || value.startsWith("`")) {
    const close = value.indexOf(value[0], 1);
    if (close < 0) { push(out, i, line.length, "s"); state.quote = value[0]; return out; }
    push(out, i, i + close + 1, "s");
    const hash = line.indexOf("#", i + close + 1);
    if (hash >= 0) push(out, hash, line.length, "c");
    return out;
  }
  const hash = value.search(/\s#/);
  push(out, i, hash >= 0 ? i + hash : line.length, "s");
  if (hash >= 0) push(out, i + hash + 1, line.length, "c");
  return out;
}

// ── CSV / TSV ──

interface CsvState { column: number; quoted: boolean }

function csvLine(line: string, state: CsvState, separator: string): Token[] {
  const out: Token[] = [];
  let start = 0;
  let i = 0;
  if (!state.quoted) state.column = 0;
  const role = () => `c${state.column % 4}` as Role;
  while (i <= line.length) {
    const ch = line[i];
    if (state.quoted) {
      if (ch === '"' && line[i + 1] === '"') { i += 2; continue; }
      if (ch === '"') { state.quoted = false; i++; continue; }
      if (i >= line.length) { push(out, start, line.length, role()); return out; }
      i++;
      continue;
    }
    if (ch === '"') { state.quoted = true; i++; continue; }
    if (ch === separator || i >= line.length) {
      push(out, start, i, role());
      if (ch === separator) push(out, i, i + 1, "p");
      state.column++;
      start = i + 1;
      i++;
      continue;
    }
    i++;
  }
  return out;
}

// ── Markdown ──

interface MdState { fence: string | null }

function markdownLine(line: string, state: MdState): Token[] {
  const out: Token[] = [];
  const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
  if (state.fence) {
    if (fence && fence[1][0] === state.fence[0] && fence[1].length >= state.fence.length) state.fence = null;
    push(out, 0, line.length, "s");
    return out;
  }
  if (fence) { state.fence = fence[1]; push(out, 0, line.length, "s"); return out; }
  if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) push(out, 0, line.length, "d");
  return out;
}

/** Tokens of every line of a text (lines without their line break). */
export function highlightLines(language: Language, lines: readonly string[]): Token[][] {
  const out: Token[][] = [];
  const yaml: YamlState = { block: null };
  const json: JsonState = { comment: false };
  const toml: TomlState = { multi: null };
  const env: EnvState = { quote: null };
  const csv: CsvState = { column: 0, quoted: false };
  const md: MdState = { fence: null };
  for (const line of lines) {
    switch (language) {
      case "yaml": out.push(yamlLine(line, yaml)); break;
      case "json": out.push(jsonLine(line, json)); break;
      case "toml": out.push(tomlLine(line, toml)); break;
      case "dotenv": out.push(envLine(line, env)); break;
      case "csv": out.push(csvLine(line, csv, ",")); break;
      case "tsv": out.push(csvLine(line, csv, "\t")); break;
      case "markdown": out.push(markdownLine(line, md)); break;
      default: out.push([]);
    }
  }
  return out;
}
