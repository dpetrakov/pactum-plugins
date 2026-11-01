// Syntax highlighting of fenced code blocks in the rendered document (EP-081-T04). The structural formats reuse the
// tokenizers of “Raw” (core/formats/highlight.ts); programming languages, shells and diffs get a small line
// tokenizer here: comments, strings, numbers, keywords and literals only — the roles of the design system (--dr-syn-*),
// no colours, no external grammar, never throws. The pieces concatenate to the block's text exactly (selection and
// quotes are unchanged), so the caller only wraps slices of the text in spans.
import { highlightLines, type Language, type Role } from "../core/formats/highlight.ts";

/** «del» — a removed line of a diff (--dr-removed: in a diff the red means exactly removal). */
export type FenceRole = Role | "del";
export interface FenceToken { s: number; e: number; role: FenceRole }

/** Larger blocks stay plain: highlighting is for reading, not for megabytes of logs. */
const MAX_CHARS = 200_000;
const MAX_LINES = 5_000;

const STRUCTURED: Record<string, Language> = {
  json: "json", jsonc: "json", json5: "json", geojson: "json",
  yaml: "yaml", yml: "yaml",
  toml: "toml",
  env: "dotenv", dotenv: "dotenv",
  md: "markdown", markdown: "markdown",
  csv: "csv", tsv: "tsv",
};

interface Grammar {
  keywords: Set<string>;
  literals: Set<string>;
  /** Line comment starters. */
  line: string[];
  /** Block comment delimiters. */
  block: [string, string] | null;
  quotes: string;
  /** `$VAR`, `${…}` of shells are literals. */
  vars: boolean;
}

const words = (text: string) => new Set(text.split(/\s+/).filter(Boolean));
const JS = words("as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in instanceof interface keyof let new of package private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield");
const JS_LIT = words("true false null undefined NaN Infinity");
const SHELL = words("if then else elif fi for in do done while until case esac function return local export readonly declare set unset shift exit source alias break continue select time eval exec trap");
const PY = words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case");
const PY_LIT = words("True False None self");
const GO = words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var");
const RUST = words("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while");
const C = words("auto break case char class const continue default delete do double else enum extern float for friend goto if inline int long namespace new operator private protected public register return short signed sizeof static struct switch template this throw try typedef typename union unsigned using virtual void volatile while final override abstract boolean byte extends implements import instanceof interface native package super synchronized throws transient var");
const SQL = words("select from where and or not insert into values update set delete create table index view drop alter add join left right inner outer on as group by order having limit offset distinct union all case when then else end is null primary key foreign references default begin commit rollback returning with");
const CSS = words("important media supports layer keyframes import from to and not only");

const GRAMMARS: Record<string, Grammar> = {
  js: { keywords: JS, literals: JS_LIT, line: ["//"], block: ["/*", "*/"], quotes: "'\"`", vars: false },
  shell: { keywords: SHELL, literals: words("true false"), line: ["#"], block: null, quotes: "'\"", vars: true },
  python: { keywords: PY, literals: PY_LIT, line: ["#"], block: null, quotes: "'\"", vars: false },
  go: { keywords: GO, literals: words("true false nil iota"), line: ["//"], block: ["/*", "*/"], quotes: "'\"`", vars: false },
  rust: { keywords: RUST, literals: words("true false None Some Ok Err"), line: ["//"], block: ["/*", "*/"], quotes: "\"", vars: false },
  c: { keywords: C, literals: words("true false null nullptr NULL"), line: ["//"], block: ["/*", "*/"], quotes: "'\"", vars: false },
  sql: { keywords: SQL, literals: words("true false null"), line: ["--"], block: ["/*", "*/"], quotes: "'\"", vars: false },
  css: { keywords: CSS, literals: words("inherit initial unset none auto"), line: [], block: ["/*", "*/"], quotes: "'\"", vars: false },
};

const ALIASES: Record<string, string> = {
  js: "js", jsx: "js", mjs: "js", cjs: "js", javascript: "js", ts: "js", tsx: "js", mts: "js", cts: "js", typescript: "js",
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", console: "shell", shellsession: "shell", fish: "shell", ksh: "shell",
  py: "python", python: "python", python3: "python",
  go: "go", golang: "go",
  rs: "rust", rust: "rust",
  c: "c", h: "c", cpp: "c", "c++": "c", cc: "c", hpp: "c", cs: "c", csharp: "c", java: "c", kotlin: "c", kt: "c", swift: "c", scala: "c", dart: "c", php: "c",
  sql: "sql", postgres: "sql", postgresql: "sql", mysql: "sql", sqlite: "sql",
  css: "css", scss: "css", less: "css",
};

/** Whether a fence language is highlighted (the rest is shown as plain code). */
export function fenceLanguage(lang: string | null): string | null {
  const key = (lang ?? "").trim().toLowerCase();
  if (!key) return null;
  if (key in STRUCTURED) return key;
  if (key === "diff" || key === "patch") return "diff";
  return ALIASES[key] ? key : null;
}

function diffLine(line: string): FenceToken[] {
  if (!line) return [];
  const all = (role: FenceRole): FenceToken[] => [{ s: 0, e: line.length, role }];
  if (/^(\+\+\+|---)(\s|$)/.test(line)) return all("d");
  if (line.startsWith("@@")) return all("l");
  if (/^(diff |index |similarity |rename |new file|deleted file|old mode|new mode|Binary )/.test(line)) return all("c");
  if (line[0] === "+") return all("s");
  if (line[0] === "-") return all("del");
  if (line[0] === "\\") return all("c");
  return [];
}

const NUMBER = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][-+]?\d+)?)[a-zA-Z]*/;
const IDENT = /^[A-Za-z_$][\w$]*/;

/** One line of a programming language; `state.comment` — inside a block comment from the previous line. */
function codeLine(line: string, grammar: Grammar, state: { comment: boolean }): FenceToken[] {
  const out: FenceToken[] = [];
  let i = 0;
  if (state.comment && grammar.block) {
    const end = line.indexOf(grammar.block[1]);
    if (end < 0) return line ? [{ s: 0, e: line.length, role: "c" }] : [];
    out.push({ s: 0, e: end + grammar.block[1].length, role: "c" });
    i = end + grammar.block[1].length;
    state.comment = false;
  }
  while (i < line.length) {
    const ch = line[i];
    const prev = i > 0 ? line[i - 1] : " ";
    if (grammar.block && line.startsWith(grammar.block[0], i)) {
      const end = line.indexOf(grammar.block[1], i + grammar.block[0].length);
      if (end < 0) { out.push({ s: i, e: line.length, role: "c" }); state.comment = true; return out; }
      out.push({ s: i, e: end + grammar.block[1].length, role: "c" });
      i = end + grammar.block[1].length;
      continue;
    }
    // A line comment; `#` of a shell only at the start of a word (not in `$#`, `a#b`).
    if (grammar.line.some((start) => line.startsWith(start, i)) && (ch !== "#" || /\s/.test(prev) || i === 0)) {
      out.push({ s: i, e: line.length, role: "c" });
      return out;
    }
    if (grammar.quotes.includes(ch)) {
      // Backslash escapes, except in single quotes of a shell.
      const escapes = !(ch === "'" && grammar.vars);
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += escapes && line[j] === "\\" ? 2 : 1;
      out.push({ s: i, e: Math.min(j + 1, line.length), role: "s" });
      i = Math.min(j + 1, line.length);
      continue;
    }
    if (grammar.vars && ch === "$") {
      const m = /^\$(?:\{[^}]*\}|[A-Za-z_]\w*|[0-9#?@*!$-])/.exec(line.slice(i));
      if (m) { out.push({ s: i, e: i + m[0].length, role: "l" }); i += m[0].length; continue; }
    }
    if (/[0-9]/.test(ch) && !/[\w$]/.test(prev)) {
      const m = NUMBER.exec(line.slice(i));
      if (m) { out.push({ s: i, e: i + m[0].length, role: "n" }); i += m[0].length; continue; }
    }
    if (/[A-Za-z_$]/.test(ch) && !/[\w$]/.test(prev)) {
      const m = IDENT.exec(line.slice(i))!;
      const word = m[0];
      const key = grammar === GRAMMARS.sql ? word.toLowerCase() : word;
      // A property after a dot is not a keyword (`x.default`, `this.type`).
      const member = prev === "." && line[i - 2] !== ".";
      if (!member && grammar.literals.has(key)) out.push({ s: i, e: i + word.length, role: "l" });
      else if (!member && grammar.keywords.has(key)) out.push({ s: i, e: i + word.length, role: "k" });
      i += word.length;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Tokens per line of a fenced block (`text.split("\n")`), or null when the language is not highlighted or the block
 * is too large. Offsets are UTF-16 inside each line; tokens are sorted and do not overlap.
 */
export function fenceTokens(lang: string | null, text: string): FenceToken[][] | null {
  const key = fenceLanguage(lang);
  if (!key || text.length > MAX_CHARS) return null;
  const lines = text.split("\n");
  if (lines.length > MAX_LINES) return null;
  try {
    if (key in STRUCTURED) return highlightLines(STRUCTURED[key], lines);
    if (key === "diff") return lines.map(diffLine);
    const grammar = GRAMMARS[ALIASES[key]];
    const state = { comment: false };
    return lines.map((line) => codeLine(line, grammar, state));
  } catch {
    return null;
  }
}
