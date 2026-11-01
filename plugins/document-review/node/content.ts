// The single host pipeline for reading document bytes and producing the redacted representation.
// Raw bytes are classified at once and live only in this function's memory: what it returns — the document bytes of
// the plugin — is the redacted form under the shared rules (built-in ∪ repository − repository exemptions), so
// observations, snapshots, revisions, quotes, caches, views, batches and CLI are all built from it. A file without
// secrets keeps its exact bytes (its sha is the sha of the file, as before). The personal form additionally masks the
// user's global extensions (packages, document get, CLI, logs). Secret spans carry positions and the value length for
// this checkout's UI; HMACs for «value changed» are computed here on request and go only to the device store.
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { sha256 } from "../core/hash.ts";
import type { PathSegment } from "../core/formats/assemble.ts";
import { FORMATS, type FormatId, formatOf } from "../core/formats/registry.ts";
import { projectFile } from "../core/formats/project.ts";
import { classify, MASK, type SecretRules } from "../core/formats/secrets.ts";
import type { Config } from "../core/schema.ts";
import { normalizeReaderId } from "../core/reading.ts";
import { readUserSettings } from "./user-settings.ts";
import type { ReviewService } from "./service.ts";

export type FileClass = "git" | "new" | "outside";

export interface SecretInfo {
  /** UTF-16 range of the mask in the shared redacted text (personal extras: of the value in it). */
  start: number;
  end: number;
  line: number;
  path: PathSegment[] | null;
  key: string | null;
  /** Value length in characters — only for this checkout's UI (F19). */
  length: number;
  explicit: boolean;
  /** shared — masked in the document bytes; personal — masked only in this user's outputs (global extension). */
  scope: "shared" | "personal";
  /** Stable id of the secret's place in the file (key path, or line and order for explicit and heuristic ones). */
  place: string;
  /** «Not a secret — for me» (F17): the UI shows it through the reveal method without a click. */
  exempt: "me" | null;
}

export interface Content {
  path: string;
  format: FormatId | null;
  fileClass: FileClass;
  /** Document bytes of the plugin: redacted under the shared rules, or the exact file bytes when nothing is secret. */
  bytes: Uint8Array;
  text: string;
  sha: string;
  size: number;
  /** sha256 of the shared rules when the bytes are redacted (Revision.redacted.rules), else null. */
  rules: string | null;
  secrets: SecretInfo[];
  /** The text with the user's global extensions masked too: what packages, document get and CLI show. */
  personalText: string;
  /**
   * A structured file that does not parse: the line of the error in the file itself (the redacted form of such a file is
   * masked by the heuristic and would break elsewhere) and the first line of the message without quoted fragments.
   */
  parseError: { line: number; message: string } | null;
}

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const encoder = new TextEncoder();
const MAX_READ = 8 * 1024 * 1024;

/**
 * Read a regular file without races: O_NOFOLLOW (a symlink swapped in after the check is refused), O_NONBLOCK (a FIFO
 * does not hang), the type and size checked on the open handle, at most MAX_READ bytes.
 */
export async function readRegular(absolute: string): Promise<Uint8Array> {
  const handle = await fs.open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw Object.assign(new Error("not a regular file"), { code: "bad-path" });
    if (stat.size > MAX_READ) throw Object.assign(new Error(`file larger than ${MAX_READ} bytes`), { code: "too-large" });
    const bytes = new Uint8Array(stat.size);
    let read = 0;
    while (read < bytes.length) {
      const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    return bytes.subarray(0, read);
  } finally {
    await handle.close();
  }
}

/** Repository rules of one file from config.json (1.2): extensions and this file's exemptions. */
export function sharedRules(config: Config | null, docPath: string, fileClass: FileClass): SecretRules {
  // Repository exemptions apply only to a file in the Git index: a committed config.json must not unmask a colleague's
  // local file that is merely not ignored («new») or ignored («outside Git») — security review EP-039-T06.
  const inGit = fileClass === "git";
  return {
    repo: config?.secretKeys ?? [],
    exemptions: inGit ? (config?.secretExemptions ?? []).filter((entry) => entry.path === docPath).map((entry) => entry.keyPath) : [],
    envExemptions: inGit,
  };
}

function placeOf(span: { path: PathSegment[] | null; line: number; reason: string }, index: number): string {
  return span.path ? `path:${JSON.stringify(span.path)}` : `line:${span.line}:${span.reason}:${index}`;
}

interface Cached {
  content: Omit<Content, "path" | "fileClass">;
}
const cache = new Map<string, Cached>();

/**
 * Read a document through the redaction. `macs` asks for the HMAC of every secret value under the device key (for
 * «value changed»); they are returned apart and must go only to the device store.
 */
export async function readContent(service: ReviewService, docPath: string, options: { readerId?: string | null; config?: Config | null; macs?: boolean } = {}): Promise<Content & { macs?: Record<string, string> }> {
  const absolute = await service.documentFile(docPath);
  const raw = await readRegular(absolute);
  const fileClass = await service.fileClass(docPath);
  let config = options.config !== undefined ? options.config : (await service.config().catch(() => ({ value: null }))).value;
  // The local review (EP-048) masks by the repository's rules (its own config holds only tracking rules) and, in the
  // stored form too, by this reader's personal extensions: the local store is «the user's outputs» (§8, F14).
  let storedExtras: string[] = [];
  if (service.scope === "local") {
    config = await sharedConfigOf(service.root);
    storedExtras = (await readUserSettings(service.dataDir, options.readerId ?? (await readerOf(service)))).secretKeys;
  }
  const settings = await readUserSettings(service.dataDir, options.readerId ?? null);
  const rules = sharedRules(config, docPath, fileClass);
  if (storedExtras.length) rules.repo = [...(rules.repo ?? []), ...storedExtras];
  const repoId = config?.repoId ?? null;
  const mine = repoId ? settings.exemptions[repoId]?.[docPath] ?? [] : [];
  const key = `${sha256(raw)}|${docPath}|${fileClass}|${JSON.stringify(rules)}|${JSON.stringify(settings.secretKeys)}|${JSON.stringify(mine)}`;
  let hit = cache.get(key);
  let text: string | null = null;
  let shared: ReturnType<typeof classify> | null = null;
  if (!hit || options.macs) {
    text = decoder.decode(raw);
    shared = classify(docPath, text, rules, "shared");
  }
  if (!hit) {
    const redacted = shared!.spans.length ? shared!.redacted : text!;
    const bytes = shared!.spans.length ? encoder.encode(redacted) : raw;
    const secrets: SecretInfo[] = shared!.spans.map((span, index) => ({
      start: span.redactedStart, end: span.redactedEnd, line: span.line, path: span.path, key: span.key, length: span.length, explicit: span.explicit,
      scope: "shared" as const, place: placeOf(span, index), exempt: null as "me" | null,
    }));
    let personalText = redacted;
    if (settings.secretKeys.length) {
      // Global extensions classify the shared form again: only values not masked yet are extra.
      const personal = classify(docPath, redacted, { ...rules, global: settings.secretKeys }, "personal");
      const extras = personal.spans.filter((span) => !/^[\s"'`|>-]*(•{8}[\s"'`]*)+$/.test(redacted.slice(span.start, span.end)));
      for (const [index, span] of extras.entries()) {
        secrets.push({ start: span.start, end: span.end, line: span.line, path: span.path, key: span.key, length: span.length, explicit: span.explicit,
          scope: "personal", place: placeOf(span, 1000 + index), exempt: null });
      }
      if (extras.length) personalText = personal.redacted;
    }
    for (const secret of secrets) if (secret.path && mine.includes(JSON.stringify(secret.path)) && !secret.explicit) secret.exempt = "me";
    const format = formatOf(docPath);
    const rawError = format && FORMATS[format].profile === "bbdr-structured" ? projectFile(docPath, text!).parseError : null;
    const parseError = rawError ? { line: rawError.line, message: rawError.message.split("\n")[0].replace(/(["'`]).*?\1/g, "…").slice(0, 200) } : null;
    hit = { content: { format, bytes, text: redacted, sha: sha256(bytes), size: bytes.length, rules: shared!.spans.length ? shared!.rules : null, secrets, personalText, parseError } };
    cache.set(key, hit);
    if (cache.size > 256) cache.delete(cache.keys().next().value!);
  }
  const content: Content & { macs?: Record<string, string> } = { ...hit.content, path: docPath, fileClass };
  if (options.macs && shared) {
    const macs: Record<string, string> = {};
    for (const [index, span] of shared.spans.entries()) macs[placeOf(span, index)] = await service.secrets.mac(placeOf(span, index), text!.slice(span.start, span.end));
    for (const secret of hit.content.secrets) if (secret.scope === "personal") macs[secret.place] = await service.secrets.mac(secret.place, hit.content.text.slice(secret.start, secret.end));
    content.macs = macs;
  }
  return content;
}

/** The repository's config.json (secret rules) read directly — for the local review, whose own config has none. */
export async function sharedConfigOf(root: string): Promise<Config | null> {
  try {
    const { parseConfig } = await import("../core/schema.ts");
    const parsed = parseConfig(JSON.parse(await fs.readFile(`${root}/.bb-docs/config.json`, "utf8")));
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

/** The reader of this checkout (its Git user.email), or null: whose personal settings apply to the outputs. */
export async function readerOf(service: ReviewService): Promise<string | null> {
  try {
    return normalizeReaderId((await service.checkoutForRead()).identity.email);
  } catch {
    return null;
  }
}

/** The raw value of one secret, for «Reveal value» only (never cached, never stored, one value per call). */
export async function revealValue(service: ReviewService, docPath: string, where: { keyPath?: string | null; line?: number | null; place?: string | null }): Promise<{ value: string; length: number; place: string } | null> {
  const absolute = await service.documentFile(docPath);
  const raw = decoder.decode(await readRegular(absolute));
  const fileClass = await service.fileClass(docPath);
  const config = (await service.config().catch(() => ({ value: null }))).value;
  const result = classify(docPath, raw, sharedRules(config, docPath, fileClass), "shared");
  const spans = result.spans.map((span, index) => ({ span, place: placeOf(span, index) }));
  const found = (where.place ? spans.find((entry) => entry.place === where.place) : undefined)
    ?? (where.keyPath ? spans.find((entry) => entry.span.path && JSON.stringify(entry.span.path) === where.keyPath) : undefined)
    ?? (where.line ? spans.find((entry) => entry.span.line === where.line) : undefined);
  if (!found) return null;
  const value = raw.slice(found.span.start, found.span.end).replace(/^("""|'''|["'`])/, "").replace(/("""|'''|["'`])$/, "");
  return { value, length: [...value].length, place: found.place };
}

/** Mask, in an outgoing string, the values of this user's personal extras (packages and quotes of a document). */
export function maskPersonal(content: Pick<Content, "secrets" | "text">, value: string): string {
  let out = value;
  for (const secret of content.secrets) {
    if (secret.scope !== "personal") continue;
    const secretValue = content.text.slice(secret.start, secret.end).replace(/^["'`]|["'`]$/g, "");
    if (secretValue.length >= 4) out = out.split(secretValue).join(MASK);
  }
  return out;
}

/** Mask this user's personal extras in any JSON-able value (CLI view --json and other outputs built from shared text). */
export function maskPersonalDeep<T>(content: Pick<Content, "secrets" | "text">, value: T): T {
  if (!content.secrets.some((secret) => secret.scope === "personal")) return value;
  let text = JSON.stringify(value);
  for (const secret of content.secrets) {
    if (secret.scope !== "personal") continue;
    const secretValue = content.text.slice(secret.start, secret.end).replace(/^["'`]|["'`]$/g, "");
    if (!secretValue) continue;
    text = text.split(JSON.stringify(secretValue).slice(1, -1)).join(MASK);
  }
  return JSON.parse(text) as T;
}

/**
 * This user's personal extras in the outputs to this checkout's UI (view, text, read): each value is replaced by bullets
 * of the same length in code points, so ranges, offsets and selections stay valid (F14: a global extension masks the
 * show too). Only string values are rewritten, never property names; values shorter than 3 characters are left (a
 * blanket replacement of one or two characters would corrupt unrelated text).
 */
export function blankPersonalDeep<T>(content: Pick<Content, "secrets" | "text">, value: T): T {
  const values = [...new Set(content.secrets.filter((secret) => secret.scope === "personal")
    .map((secret) => content.text.slice(secret.start, secret.end).replace(/^("""|'\'\'|["'`])/, "").replace(/("""|'\'\'|["'`])$/, ""))
    .filter((secretValue) => [...secretValue].length >= 3))].sort((a, b) => b.length - a.length);
  if (!values.length) return value;
  const blank = (text: string) => {
    let out = text;
    for (const secretValue of values) if (out.includes(secretValue)) out = out.split(secretValue).join("•".repeat([...secretValue].length));
    return out;
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return blank(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, entry]) => [key, walk(entry)]));
    return node;
  };
  return walk(value) as T;
}

export function clearContentCache(): void {
  cache.clear();
}
