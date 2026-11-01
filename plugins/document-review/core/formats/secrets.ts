// Secrets (W-06c, file-types.md §8, DR-09): which values of a file are secret and its redacted form. Pure: the same
// path, bytes and rules give the same spans and redacted text on every machine.
//
// What is secret: every value of a .env file; in YAML/JSON/JSONC/TOML the values of keys whose name matches the secret
// pattern (built-in set ∪ extensions), an object under such a key entirely, and the value an alias under such a key
// refers to; in any format an explicit secret shape — a PEM private key body, the password of a URL `user:pass@`.
//
// The redacted form replaces each secret value by a fixed mask, keeping keys, structure, quotes and line numbers, so it
// still parses and every position maps line to line. Everything that leaves the parse (snapshots, revisions, quotes,
// caches, answers, packages, logs, CLI) is built from it; the raw bytes live only in memory. No derivative of a value
// (hash, length, prefix) is part of the redacted form; the length is reported separately, to this checkout's UI only.

import { canonicalJson } from "../canonical-json.ts";
import { tr } from "../i18n.ts";
import { sha256 } from "../hash.ts";
import type { BlockMeta, PathSegment } from "./assemble.ts";
import { envEntries } from "./lines.ts";
import { formatOf, FORMATS, type FormatId } from "./registry.ts";
import { parseStructured } from "./structured.ts";

/** Fixed mask of a secret value: 8 × U+2022. */
export const MASK = "••••••••";
/** Built-in secret-key pattern (accepted 2026-10-08, §8); matched case-insensitively against each key name. */
export const BUILTIN_SECRET_KEYS = "token|secret|password|passwd|pwd|api[_-]?key|apikey|private[_-]?key|client[_-]?secret|credential|cookie|session[_-]?key|access[_-]?key|dsn|connection[_-]?string";
export const RULESET_VERSION = "bbdr-secrets-1";

export interface SecretRules {
  /** Extensions of the repository (config.json `secretKeys`): part of the shared redaction. */
  repo?: readonly string[];
  /** Global extensions of this user on this machine: display, packages, logs, CLI and the local store only. */
  global?: readonly string[];
  /** Repository exemptions of this file («not a secret for everyone»): key paths with element fingerprints (§8, F17). */
  exemptions?: readonly string[];
  /** .env exemptions are allowed only for files in Git or new (the host decides by the file class). */
  envExemptions?: boolean;
}

/** shared — what .bb-docs stores (built-in ∪ repo − repo exemptions); personal — also the user's global extensions. */
export type RuleScope = "shared" | "personal";

export type SecretReason = "dotenv" | "key" | "alias" | "pem" | "url-password" | "heuristic";

export interface SecretSpan {
  /** UTF-16 range of the secret value in the raw source. */
  start: number;
  end: number;
  /** Same range in the redacted text (the mask). */
  redactedStart: number;
  redactedEnd: number;
  /** 1-based line of the value start. */
  line: number;
  /** Key path of a structured value, or [KEY] of a .env value. */
  path: PathSegment[] | null;
  key: string | null;
  /** Length of the value in characters (code points): shown in this checkout's UI only (F19). */
  length: number;
  reason: SecretReason;
  /** Explicit secret (PEM, URL password): never exempted (§8). */
  explicit: boolean;
}

export interface ExemptionStatus {
  keyPath: string;
  applied: boolean;
  /** Why an exemption does not apply: the path is gone, the element is not identified, or the value looks explicit. */
  reason: "applied" | "structure-changed" | "explicit" | "not-a-leaf";
}

export interface Classification {
  format: FormatId | null;
  spans: SecretSpan[];
  /** Redacted text; equal to the source when nothing is secret. */
  redacted: string;
  /** sha256 of the canonical rules the redaction used (Revision.redacted.rules). */
  rules: string;
  /** The structured source did not parse: masked line by line by the key heuristic (only stronger). */
  heuristic: boolean;
  exemptions: ExemptionStatus[];
}

/** A user pattern must compile and must not match the empty string (it would mask every key). */
export function patternProblem(pattern: string): string | null {
  if (!pattern.trim()) return tr("empty pattern", "пустой шаблон");
  if (pattern.length > 512) return tr("pattern longer than 512 characters", "шаблон длиннее 512 символов");
  // Nested repetition («(a+)+», «(a*)*») can hang the host on a crafted key name: refused.
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/.test(pattern)) return tr("nested repetition is not allowed in a pattern", "вложенные повторения в шаблоне не допускаются");
  try {
    const re = new RegExp(pattern, "i");
    if (re.test("")) return tr("pattern matches an empty name: it would mask everything", "шаблон совпадает с пустым именем — замаскировал бы всё");
  } catch (error) {
    return `${tr("not a regular expression", "не регулярное выражение")}: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

function keyMatcher(rules: SecretRules, scope: RuleScope): RegExp {
  const parts = [BUILTIN_SECRET_KEYS, ...(rules.repo ?? []).filter((p) => !patternProblem(p))];
  if (scope === "personal") parts.push(...(rules.global ?? []).filter((p) => !patternProblem(p)));
  return new RegExp(parts.map((p) => `(?:${p})`).join("|"), "i");
}

/** Hash of the canonical rule set of a scope (sorted, deduplicated). */
export function rulesHash(rules: SecretRules, scope: RuleScope = "shared"): string {
  const sort = (list: readonly string[] | undefined) => [...new Set(list ?? [])].sort();
  return sha256(canonicalJson({ version: RULESET_VERSION, builtin: BUILTIN_SECRET_KEYS, repo: sort(rules.repo), exemptions: sort(rules.exemptions),
    ...(scope === "personal" ? { global: sort(rules.global) } : {}) }));
}

// ── explicit shapes ──

const PEM_BEGIN = /-----BEGIN ([A-Z0-9 ]*?)PRIVATE KEY(?: BLOCK)?-----/g;
const URL_AUTHORITY = /\b[a-z][a-z0-9+.-]*:\/\/([^\s/'"`?#<>\\]+)/gi;

/**
 * Explicit secret shapes in any text: the body of a PEM / PGP private key (to its END line, or to the end of the text
 * when the END is missing), and the password of a URL `scheme://user:password@host` (the user may be empty, the
 * password may hold «@»: the userinfo ends at the last «@» of the authority).
 */
function explicitSpans(source: string): { start: number; end: number; reason: SecretReason }[] {
  const out: { start: number; end: number; reason: SecretReason }[] = [];
  for (const m of source.matchAll(PEM_BEGIN)) {
    const headerEnd = (m.index ?? 0) + m[0].length;
    const endMatch = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/.exec(source.slice(headerEnd));
    const bodyEnd = endMatch ? headerEnd + endMatch.index : source.length;
    const [s, e] = trim(source, headerEnd, bodyEnd);
    if (e > s) out.push({ start: s, end: e, reason: "pem" });
  }
  for (const m of source.matchAll(URL_AUTHORITY)) {
    const authority = m[1];
    const at = authority.lastIndexOf("@");
    if (at < 0) continue;
    const colon = authority.indexOf(":");
    if (colon < 0 || colon > at) continue;
    const authorityStart = (m.index ?? 0) + m[0].length - authority.length;
    const start = authorityStart + colon + 1;
    const end = authorityStart + at;
    if (end > start) out.push({ start, end, reason: "url-password" });
  }
  return out;
}

/** True when a value (as text) has an explicit secret shape: an exemption never unmasks it. */
export function looksExplicit(value: string): boolean {
  return explicitSpans(value).length > 0;
}

function trim(source: string, start: number, end: number): [number, number] {
  while (start < end && /\s/.test(source[start])) start++;
  while (end > start && /\s/.test(source[end - 1])) end--;
  return [start, end];
}

// ── structured: key spans ──

function segmentMatches(re: RegExp, segment: PathSegment): boolean {
  return typeof segment === "string" && re.test(segment);
}

/** Key of an array element: its array's path and its index. */
const elementId = (arrayPath: PathSegment[], index: number) => `${JSON.stringify(arrayPath)}#${index}`;

/**
 * Fingerprints of every array element from its non-secret leaves only (no derivative of a secret value), in one pass:
 * each leaf goes to all its element ancestors at once. Element by element over all leaves was quadratic — a 1 MB JSON
 * array took 57 s of one blocked event loop, a 7.5 MB one never finished, and the host worker was killed (2026-10-16).
 * The pairs of an element keep the leaves' document order before the (stable) sort, so the fingerprints are unchanged.
 */
export function elementFingerprints(metas: BlockMeta[], isSecretPath: (path: PathSegment[]) => boolean): Map<string, string> {
  const pairs = new Map<string, [string, string][]>();
  for (const meta of metas) {
    const path = meta.path;
    if (!path || meta.kind === undefined || meta.value === undefined) continue;
    let leaf: boolean | null = null;
    for (let k = 0; k < path.length; k++) {
      const segment = path[k];
      if (typeof segment !== "number") continue;
      leaf ??= !(isSecretPath(path) || looksExplicit(meta.value));
      if (!leaf) break;
      const id = elementId(path.slice(0, k), segment);
      const list = pairs.get(id) ?? [];
      list.push([JSON.stringify(path.slice(k + 1)), meta.value]);
      pairs.set(id, list);
    }
  }
  const out = new Map<string, string>();
  for (const [id, list] of pairs) {
    list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    out.set(id, sha256(canonicalJson(list)).slice(0, 12));
  }
  return out;
}

/** An element without non-secret leaves: the fingerprint of no pairs, as before. */
const EMPTY_FINGERPRINT = sha256(canonicalJson([])).slice(0, 12);
const fingerprintOf = (prints: Map<string, string>, arrayPath: PathSegment[], index: number) => prints.get(elementId(arrayPath, index)) ?? EMPTY_FINGERPRINT;

/** Exemption key path of a leaf: array indices carry the element fingerprint ({i, fp}). */
export function exemptionKeyPath(metas: BlockMeta[], path: PathSegment[], isSecretPath: (path: PathSegment[]) => boolean, prints = elementFingerprints(metas, isSecretPath)): string {
  const out: unknown[] = [];
  path.forEach((segment, k) => {
    if (typeof segment === "number") out.push({ i: segment, fp: fingerprintOf(prints, path.slice(0, k), segment) });
    else out.push(segment);
  });
  return JSON.stringify(out);
}

type ExemptSegment = string | { doc: number } | { i: number; fp: string };

function parseExemption(value: string): ExemptSegment[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.length) return null;
    return parsed as ExemptSegment[];
  } catch {
    return null;
  }
}

/** Does an exemption name this concrete leaf path? Elements are matched by fingerprint, uniquely. */
function exemptionMatches(exemption: ExemptSegment[], path: PathSegment[], prints: Map<string, string>, fpCount: Map<string, number>): boolean {
  if (exemption.length !== path.length) return false;
  for (let k = 0; k < path.length; k++) {
    const want = exemption[k];
    const got = path[k];
    if (typeof want === "string") { if (want !== got) return false; continue; }
    if (want && typeof want === "object" && "doc" in want) { if (typeof got !== "object" || (got as { doc: number }).doc !== want.doc) return false; continue; }
    if (typeof got !== "number" || !want || typeof want !== "object" || !("fp" in want)) return false;
    const fp = fingerprintOf(prints, path.slice(0, k), got);
    if (fp !== want.fp) return false;
    // The same fingerprint twice in that array: the element is not identified uniquely — the exemption does not apply.
    if ((fpCount.get(`${JSON.stringify(path.slice(0, k))}|${fp}`) ?? 0) !== 1) return false;
  }
  return true;
}

interface RawSpan { start: number; end: number; reason: SecretReason; path: PathSegment[] | null; key: string | null; explicit: boolean }

function structuredSpans(format: "yaml" | "json" | "jsonc" | "toml", source: string, re: RegExp, rules: SecretRules, exemptionsOut: ExemptionStatus[]): RawSpan[] | null {
  const parsed = parseStructured(format, source);
  if (!parsed.ok) return null;
  const metas = parsed.atoms.map((atom) => atom.meta ?? {});
  const isSecretPath = (path: PathSegment[]) => path.some((segment) => segmentMatches(re, segment));
  // Aliases under secret keys reveal the anchored value: the anchor's subtree is secret too.
  const secretAnchors = new Set<string>();
  for (const meta of metas) if (meta.kind === "alias" && meta.path && isSecretPath(meta.path) && meta.value) secretAnchors.add(meta.value.slice(1));
  const anchorPaths = metas.filter((meta) => meta.anchor && secretAnchors.has(meta.anchor) && meta.path).map((meta) => JSON.stringify(meta.path).slice(0, -1));
  const underSecretAnchor = (path: PathSegment[]) => {
    const key = JSON.stringify(path);
    return anchorPaths.some((prefix) => key === `${prefix}]` || key.startsWith(`${prefix},`));
  };
  // Element fingerprints of every array, to require uniqueness.
  const prints = elementFingerprints(metas, isSecretPath);
  const fpCount = new Map<string, number>();
  const seenElements = new Set<string>();
  for (const meta of metas) {
    if (!meta.path) continue;
    meta.path.forEach((segment, k) => {
      if (typeof segment !== "number") return;
      const arrayPath = meta.path!.slice(0, k);
      const id = `${JSON.stringify(arrayPath)}#${segment}`;
      if (seenElements.has(id)) return;
      seenElements.add(id);
      const fp = fingerprintOf(prints, arrayPath, segment);
      const key = `${JSON.stringify(arrayPath)}|${fp}`;
      fpCount.set(key, (fpCount.get(key) ?? 0) + 1);
    });
  }
  const exemptions = (rules.exemptions ?? []).map((value) => ({ value, parsed: parseExemption(value), used: false, explicit: false }));
  const spans: RawSpan[] = [];
  for (const atom of parsed.atoms) {
    const meta = atom.meta;
    if (atom.type !== "node" || !meta?.path || meta.valueStart === undefined || meta.valueEnd === undefined || meta.valueEnd <= meta.valueStart) continue;
    // An alias is a reference, not a value: the anchored value it names is masked instead (below).
    if (meta.kind === "alias") continue;
    const byKey = isSecretPath(meta.path);
    const byAlias = !byKey && underSecretAnchor(meta.path);
    if (!byKey && !byAlias) continue;
    if (byKey && !byAlias) {
      const exempt = exemptions.find((entry) => entry.parsed && exemptionMatches(entry.parsed, meta.path!, prints, fpCount));
      if (exempt) {
        if (looksExplicit(source.slice(meta.valueStart, meta.valueEnd))) exempt.explicit = true;
        else { exempt.used = true; continue; }
      }
    }
    spans.push({ start: meta.valueStart, end: meta.valueEnd, reason: byKey ? "key" : "alias", path: meta.path, key: typeof meta.path[meta.path.length - 1] === "string" ? String(meta.path[meta.path.length - 1]) : null, explicit: false });
  }
  for (const entry of exemptions) exemptionsOut.push({ keyPath: entry.value, applied: entry.used, reason: entry.used ? "applied" : entry.explicit ? "explicit" : "structure-changed" });
  return spans;
}

function envSpans(source: string, rules: SecretRules, exemptionsOut: ExemptionStatus[]): RawSpan[] {
  const exemptKeys = new Map<string, boolean>();
  for (const value of rules.exemptions ?? []) {
    const parsed = parseExemption(value);
    if (rules.envExemptions && parsed && parsed.length === 1 && typeof parsed[0] === "string") exemptKeys.set(parsed[0], false);
  }
  const spans: RawSpan[] = [];
  for (const entry of envEntries(source)) {
    if (entry.kind === "other") {
      // A line that is not KEY=value (a continuation, «KEY value») is masked whole.
      spans.push({ start: entry.start, end: entry.end, reason: "dotenv", path: null, key: null, explicit: false });
      continue;
    }
    if (entry.kind === "comment") {
      // A commented-out assignment («# OLD_TOKEN=…») keeps its key and loses its value.
      const m = /^#\s*(export\s+)?([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*[=:]\s*(.+)$/.exec(source.slice(entry.start, entry.end));
      if (m) spans.push({ start: entry.end - m[3].length, end: entry.end, reason: "dotenv", path: null, key: m[2], explicit: false });
      continue;
    }
    if (entry.tailStart !== undefined) spans.push({ start: entry.tailStart, end: entry.tailEnd!, reason: "dotenv", path: null, key: entry.key!, explicit: false });
    if (entry.innerEnd! <= entry.innerStart!) continue;
    if (exemptKeys.has(entry.key!) && !looksExplicit(source.slice(entry.innerStart!, entry.innerEnd!))) {
      exemptKeys.set(entry.key!, true);
      continue;
    }
    spans.push({ start: entry.innerStart!, end: entry.innerEnd!, reason: "dotenv", path: [entry.key!], key: entry.key!, explicit: false });
  }
  for (const value of rules.exemptions ?? []) {
    const parsed = parseExemption(value);
    const key = parsed && parsed.length === 1 && typeof parsed[0] === "string" ? parsed[0] : null;
    exemptionsOut.push({ keyPath: value, applied: Boolean(key && exemptKeys.get(key)), reason: key && exemptKeys.get(key) ? "applied" : rules.envExemptions ? "structure-changed" : "explicit" });
  }
  return spans;
}

/** For an invalid structured file or an invalid redaction, mask every value and comment. Preserve only keys, indentation, list markers and structural delimiters; no matching pattern is required. */
function heuristicSpans(source: string): RawSpan[] {
  const spans: RawSpan[] = [];
  let offset = 0;
  for (const raw of source.split("\n")) {
    const lineStart = offset;
    offset += raw.length + 1;
    const line = raw.replace(/\r$/, "").replace(/^\uFEFF/, "");
    const shift = raw.startsWith("\uFEFF") ? 1 : 0;
    if (!line.trim()) continue;
    if (/^\s*([{}[\],]+|---|\.\.\.|-)\s*$/.test(line)) continue;
    const keyed = /^(\s*(?:-\s+)?(?:export\s+)?)("[^"]*"|'[^']*'|[^\s"':=#{}[\],]+)(\s*[:=]\s*)(.*)$/.exec(line);
    let valueStart: number;
    let value: string;
    let key: string | null = null;
    if (keyed) {
      key = keyed[2].replace(/^["']|["']$/g, "");
      value = keyed[4];
      valueStart = lineStart + shift + keyed[1].length + keyed[2].length + keyed[3].length;
      if (/^[[{]\s*$/.test(value) || /^[|>][-+0-9]*\s*$/.test(value)) continue;
    } else {
      const lead = /^(\s*(?:-\s+)?)/.exec(line)![1];
      value = line.slice(lead.length);
      valueStart = lineStart + shift + lead.length;
    }
    // A trailing comma of JSON/TOML is structure, not value: it stays, so the redacted file breaks where the file does.
    const comma = /,\s*$/.exec(value);
    const [s, e] = trim(source, valueStart, valueStart + value.length - (comma ? comma[0].length : 0));
    if (e > s) spans.push({ start: s, end: e, reason: "heuristic", path: null, key, explicit: false });
  }
  return spans;
}

// ── redaction ──

/**
 * Mask of a value slice: each line keeps its indentation and the opening/closing quotes, its content becomes MASK; a
 * YAML block-scalar header (`|`, `>-` …) stays. Line breaks are kept, so line numbers do not move.
 */
function maskSlice(slice: string, format: FormatId | null, whole: boolean): string {
  const lines = slice.split("\n");
  // An explicit secret inside a string (URL password, PEM body) is masked in place: no quotes are added or kept.
  if (!whole) return lines.map((line) => line.replace(/^([ \t]*)(.*?)([ \t\r]*)$/, (_all, lead: string, body: string, tail: string) => `${lead}${body ? MASK : ""}${tail}`)).join("\n");
  const quote = /^("""|'''|["'`])/.exec(lines[0].trimStart())?.[1] ?? "";
  const last = lines.length - 1;
  const out = lines.map((line, index) => {
    const m = /^([ \t]*)(.*?)([ \t\r]*)$/.exec(line)!;
    let body = m[2];
    if (index === 0 && /^[|>][-+0-9]*$/.test(body)) return line;
    let prefix = "";
    let suffix = "";
    if (index === 0 && quote && body.startsWith(quote)) { prefix = quote; body = body.slice(quote.length); }
    if (index === last && quote && body.endsWith(quote)) { suffix = quote; body = body.slice(0, body.length - quote.length); }
    return `${m[1]}${prefix}${body.length ? MASK : ""}${suffix}${m[3]}`;
  });
  let masked = out.join("\n");
  // Non-string scalars of TOML and JSON become strings: the redacted form must still parse.
  if (!quote && (format === "toml" || format === "json" || format === "jsonc")) masked = `"${masked.trim() ? MASK : ""}"`;
  return masked;
}

function merge(spans: RawSpan[]): RawSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: RawSpan[] = [];
  for (const span of sorted) {
    const previous = out[out.length - 1];
    if (previous && span.start < previous.end) {
      // Keep the outer span; an explicit span inside a key value makes it explicit.
      previous.end = Math.max(previous.end, span.end);
      previous.explicit = previous.explicit || span.explicit;
      continue;
    }
    out.push({ ...span });
  }
  return out;
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = source.indexOf("\n"); i >= 0 && i < offset; i = source.indexOf("\n", i + 1)) line++;
  return line;
}

/** Classify the secrets of a file and build its redacted form. */
export function classify(path: string, source: string, rules: SecretRules = {}, scope: RuleScope = "shared"): Classification {
  const format = formatOf(path);
  const re = keyMatcher(rules, scope);
  const exemptions: ExemptionStatus[] = [];
  let heuristic = false;
  let spans: RawSpan[] = explicitSpans(source).map((span) => ({ ...span, path: null, key: null, explicit: true }));
  if (format === "dotenv") spans.push(...envSpans(source, rules, exemptions));
  else if (format && FORMATS[format].secrets === "keys") {
    // A .json with comments or trailing commas (VS Code settings) is classified as JSONC: values are still found by key.
    const structured = structuredSpans(format as "yaml" | "json" | "jsonc" | "toml", source, re, rules, exemptions)
      ?? (format === "json" ? structuredSpans("jsonc", source, re, rules, exemptions) : null);
    if (structured) spans.push(...structured);
    else {
      heuristic = true;
      spans.push(...heuristicSpans(source));
    }
  }
  spans = merge(spans.filter((span) => span.end > span.start));
  let redacted = "";
  let cursor = 0;
  const out: SecretSpan[] = [];
  for (const span of spans) {
    redacted += source.slice(cursor, span.start);
    const value = source.slice(span.start, span.end);
    const mask = maskSlice(value, format, span.reason === "key" || span.reason === "alias");
    const redactedStart = redacted.length;
    redacted += mask;
    cursor = span.end;
    // Length of the value content (inside its quotes), in code points.
    const inner = value.replace(/^("""|'''|["'`])/, "").replace(/("""|'''|["'`])$/, "");
    out.push({ start: span.start, end: span.end, redactedStart, redactedEnd: redacted.length, line: lineOf(source, span.start), path: span.path, key: span.key,
      length: [...inner].length, reason: span.reason, explicit: span.explicit });
  }
  redacted += source.slice(cursor);
  // The redaction must not break a structured file that parsed: otherwise every value is masked (stronger).
  if (!heuristic && format && FORMATS[format].secrets === "keys" && out.length) {
    const parsedBefore = parseStructured(format as "yaml" | "json" | "jsonc" | "toml", source).ok;
    const check = parseStructured(format as "yaml" | "json" | "jsonc" | "toml", redacted);
    if (parsedBefore && !check.ok) {
      const strong = classifyHeuristicOnly(path, source);
      return { ...strong, rules: rulesHash(rules, scope), exemptions };
    }
  }
  return { format, spans: out, redacted, rules: rulesHash(rules, scope), heuristic, exemptions };
}

function classifyHeuristicOnly(path: string, source: string): Omit<Classification, "rules" | "exemptions"> {
  const format = formatOf(path);
  const spans = merge([...explicitSpans(source).map((span) => ({ ...span, path: null, key: null, explicit: true })), ...heuristicSpans(source)]);
  let redacted = "";
  let cursor = 0;
  const out: SecretSpan[] = [];
  for (const span of spans) {
    redacted += source.slice(cursor, span.start);
    const start = redacted.length;
    const value = source.slice(span.start, span.end);
    redacted += value.split("\n").map((line) => line.replace(/^([ \t]*).*$/, `$1${MASK}`)).join("\n");
    cursor = span.end;
    out.push({ start: span.start, end: span.end, redactedStart: start, redactedEnd: redacted.length, line: lineOf(source, span.start), path: span.path, key: span.key, length: [...value].length, reason: span.reason, explicit: span.explicit });
  }
  redacted += source.slice(cursor);
  return { format, spans: out, redacted, heuristic: true };
}

/** A redacted text holds no secret any more: classifying it again only finds masks (tests and validate). */
export function isRedactedFixedPoint(path: string, redacted: string, rules: SecretRules = {}, scope: RuleScope = "shared"): boolean {
  const again = classify(path, redacted, rules, scope);
  return again.spans.every((span) => {
    const slice = redacted.slice(span.start, span.end).replace(/^[|>][-+0-9]*/, "").replace(/["'`\s]/g, "");
    return slice === "" || /^(•{8})+$/.test(slice);
  });
}

/**
 * The exemption key path of one secret leaf (F17): validated against the file — the leaf exists, is masked by the
 * key pattern (not an explicit secret, not an object), and array elements get fingerprints of non-secret siblings.
 */
export function exemptionFor(path: string, source: string, keyPath: PathSegment[], rules: SecretRules = {}): { keyPath: string } | { error: "not-a-secret" | "explicit" | "not-a-leaf" | "not-structured" } {
  const format = formatOf(path);
  if (format === "dotenv") {
    const key = keyPath.length === 1 && typeof keyPath[0] === "string" ? keyPath[0] : null;
    const entry = key ? envEntries(source).find((candidate) => candidate.kind === "pair" && candidate.key === key) : null;
    if (!entry) return { error: "not-a-secret" };
    if (looksExplicit(source.slice(entry.innerStart!, entry.innerEnd!))) return { error: "explicit" };
    return { keyPath: JSON.stringify([key]) };
  }
  if (!format || FORMATS[format].secrets !== "keys") return { error: "not-structured" };
  const parsed = parseStructured(format as "yaml" | "json" | "jsonc" | "toml", source);
  if (!parsed.ok) return { error: "not-structured" };
  const re = keyMatcher(rules, "shared");
  const isSecretPath = (candidate: PathSegment[]) => candidate.some((segment) => segmentMatches(re, segment));
  const metas = parsed.atoms.map((atom) => atom.meta ?? {});
  const want = JSON.stringify(keyPath);
  const atom = parsed.atoms.find((candidate) => candidate.meta?.path && JSON.stringify(candidate.meta.path) === want);
  if (!atom) return { error: "not-a-secret" };
  if (atom.type !== "node" || atom.meta?.kind === "object" || atom.meta?.kind === "array") return { error: "not-a-leaf" };
  if (!isSecretPath(keyPath)) return { error: "not-a-secret" };
  const value = source.slice(atom.meta!.valueStart ?? atom.start, atom.meta!.valueEnd ?? atom.end);
  if (looksExplicit(value)) return { error: "explicit" };
  return { keyPath: exemptionKeyPath(metas, keyPath, isSecretPath) };
}
