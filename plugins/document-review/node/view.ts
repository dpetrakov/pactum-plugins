// Document view computed on the host (EP-008-T01): blocks with inline tokens, read state with a diff per block,
// removed blocks at their place, annotations with their anchor on the shown revision, agent state per
// annotation and the batch of the checkout. The client renders this; it never parses Markdown or hashes bytes.
import fs from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import { canonicalBytes } from "../core/canonical-json.ts";
import { agentState, latestResultOf, linkedEdits, runsOf, waitsForUser } from "../core/batch.ts";
import { discussion, type DiscussionView } from "../core/discussion.ts";
import { newId, sha256 } from "../core/hash.ts";
import { entity, revisionHistory, revisionObject, type State } from "../core/journal.ts";
import { blockDiff, buildRevision, type Projection } from "../core/markdown/index.ts";
import { type FileProjection, projectFile, projectionFormat } from "../core/formats/project.ts";
import { resolveFormatAnchor } from "../core/formats/anchor.ts";
import { readContent, readerOf, type SecretInfo } from "./content.ts";
import { bornIn, normalizeReaderId, readState, receiptsOf, removalState } from "../core/reading.ts";
import type { Annotation, ObjectValue } from "../core/schema.ts";
import { layout } from "../core/store.ts";
import { layoutOf, type LayoutConflict, type LayoutPin } from "../core/layouts.ts";
import type { CpRange, Revision } from "../core/types.ts";
import { encodeBlocks, encodeOverlay, headingStack, type WireBlock, type WireOverlay } from "../core/wire.ts";
import { warmParse } from "./parse-pool.ts";
import { formatOf } from "../core/formats/registry.ts";
import { forms, lang, plural, tr } from "../core/i18n.ts";
import type { ReviewService } from "./service.ts";

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

export interface ViewBlock {
  index: number;
  type: string;
  range: CpRange;
  text: string;
  inline: unknown[];
  attrs: Record<string, unknown>;
  depth: number | null;
  cell: { table: number; row: number } | null;
  headings: number[];
  lineageId: string;
  versionId: string;
  /** null: tracking off, review disabled or no reader. */
  read: "read" | "unread" | "ambiguous" | null;
  change: "added" | "edited" | null;
  diff: { words: { op: string; text: string }[]; rewritten: boolean; before: string } | null;
  movedFrom: string | null;
  /** The block only moved to another section since the reader's last base (F4): informative, never unread (DR-02). */
  moved: boolean;
}

/** A version of a diagram block to compare with: the source there (null — no such block there) and the word diff to now. */
export type DiagramBase = { revisionId: string; at: string | null; text: string | null; diff: { words: { op: string; text: string }[]; rewritten: boolean } | null };
/**
 * The previous version of a diagram block: the nearest ancestor revision where this lineage differs. One parent —
 * «version»; a merge whose parents differ — «merge», the reader chooses (no newest/time fallback); none — why.
 */
export type DiagramPrevious =
  | { kind: "version"; base: DiagramBase }
  | { kind: "merge"; candidates: DiagramBase[] }
  | { kind: "none"; reason: "added" | "no-history" | "unavailable" | "far" };

export interface ViewRemoved {
  tombstoneId: string;
  lineageId: string;
  text: string;
  type: string;
  /** Show after this block index (-1: before the first block). */
  after: number;
  section: string | null;
  read: boolean;
}

export interface ViewMessage {
  messageId: string;
  role: "human" | "agent";
  author: string;
  email: string | null;
  model: string | null;
  threadId: string | null;
  requestedBy: string | null;
  text: string | null;
  revisions: number;
  timestamp: string;
  eventId: string;
  runId: string | null;
  itemId: string | null;
  /** For agent replies: the result status of the item this message answers. */
  resultStatus: string | null;
  conflict: boolean;
}

export interface ViewAnnotation {
  annotationId: string;
  path: string;
  targetKind: string;
  quote: { exact: string; prefix: string; suffix: string };
  /** W-06f (EP-073-T08): the element of an embedded object the annotation is about (visualizer id and words). */
  element: { id: string; kind: "node" | "edge" | "group" | "text" | "other"; label: string } | null;
  tombstoneId: string | null;
  created: string;
  creator: { name: string; email: string };
  kind: "action" | "note" | null;
  status: "open" | "closed" | "withdrawn" | null;
  heads: string[];
  messages: ViewMessage[];
  /** exact/mapped are not shown to the user (D6); the rest needs attention. */
  anchor: { status: string; ranges: CpRange[]; place: number | null; blocks: number[] };
  agent: string | null;
  waiting: boolean;
  candidate: boolean;
  dispatched: boolean;
  newInstructions: number;
  inFlight: string | null;
  conflicts: { register: string; candidates: { eventId: string; value: string }[] }[];
  incomplete: string[];
  latest: {
    runId: string;
    eventId: string;
    status: string;
    timestamp: string;
    /** Confirmed linked edits (E4) by current block index; versions no longer current are counted apart. */
    linked: { block: number; lineageId: string; versionId: string }[];
    linkedChanged: number;
    linkedElsewhere: { path: string | null; count: number }[];
  } | null;
}

export interface DocumentView {
  context: {
    root: string; isRepo: boolean; head: string | null; branch: string | null; enabled: boolean; repoId: string | null;
    identity: { name: string | null; email: string | null }; readerId: string | null;
    writable: boolean; readOnlyReason: string | null; roots: string[];
    /** config.json is unmerged after a Git merge: both sides and the proposed three-way merge (EP-014-T02). */
    configConflict: { configSha: string | null; ours: ConfigLists; theirs: ConfigLists; merged: ConfigLists; problem: string | null } | null;
  };
  document: {
    path: string; docId: string | null; sha: string; size: number; revisionId: string | null; ephemeral: boolean;
    tracked: boolean; insideRoots: boolean; projectionLength: number; headRevisions: string[];
    /** The file is gone from the checkout: the last persistent revision is shown read-only (AC08, D5). */
    missing: boolean;
    /** This reader has not acknowledged the deletion of the missing document yet (removal receipt, 1.1; EP-014-T05). */
    deletionUnread: boolean;
    /** Hidden by the visibility rules (A6): only the tree and search are affected. */
    hidden: boolean;
    /** Tracking resumed after a pause and the reader has not confirmed anything since (A7): when. */
    trackingResumed: string | null;
    /** The document's own entity cannot be written (newer schema minor, incomplete data, conflict), explained (G3). */
    readOnly: string | null;
    /** Branches disagree about this document's path or presence; resolved explicitly (EP-014-T02). */
    conflict: { register: "path" | "presence"; candidates: { eventId: string; value: string }[] } | null;
  };
  blocks: ViewBlock[];
  /**
   * W-06f (1.3): this reader's layout of each Mermaid block of the shown revision; readOnly — why it cannot be written;
   * previous — the block's previous version in the journal (EP-061-T01), the default base of its comparison.
   */
  layouts: { block: number; pins: Record<string, LayoutPin>; conflicts: LayoutConflict[]; readOnly: string | null; previous: DiagramPrevious }[];
  removed: ViewRemoved[];
  annotations: ViewAnnotation[];
  unread: number;
  /** Last receipt of this reader for this document, for «Undo». */
  lastReceipt: { receiptId: string; scope: string; blocks: number; eventId: string } | null;
  /** W-06c: format, Git class, parse error of a structured file and the masked secrets (this checkout's UI only). */
  format: string | null;
  fileClass: string;
  parseError: { line: number; message: string } | null;
  secrets: ViewSecret[];
  /** EP-048: which review serves the document — the shared one (.bb-docs) or this reader's local one (file outside Git). */
  scope: "shared" | "local";
  computeMs: number;
}

/**
 * Why review data opens read-only, in the user's words (G3, EP-014-T04): the stored reasons are stable English codes for
 * the CLI and validate; the viewer names the cause and what to do.
 */
export function explainReadOnly(reason: string): string {
  const version = /schema (?:version )?([0-9]+\.[0-9]+)/.exec(reason)?.[1];
  if (/unsupported major/.test(reason)) return tr("review data was written by an incompatible (newer major) version of the plugin. Update the Documents plugin; until then everything opens read-only and nothing is lost.", "данные обзора записаны несовместимой (новой основной) версией плагина. Обновите плагин «Документы»; до этого всё открывается только для чтения, ничего не теряется.");
  if (/config\.json is from a newer schema version/.test(reason)) return tr("config.json was written by a newer version of the plugin. Update the plugin; until then the rules are read but not changed.", "config.json записан более новой версией плагина. Обновите плагин; до этого правила читаются, но не меняются.");
  if (/config\.json is damaged|not valid JSON/.test(reason)) return tr("config.json is damaged (it does not parse as JSON). Fix the file or restore it from Git; documents and comments can still be read.", "config.json повреждён (не разбирается как JSON). Исправьте файл или верните его из Git; документы и замечания читаются.");
  if (/unresolved Git merge conflict/.test(reason)) return tr("config.json has an unresolved Git conflict after a branch merge.", "в config.json неразрешённый конфликт Git после слияния веток.");
  if (/cannot be read/.test(reason)) return tr("part of .bb-docs cannot be read (a symbolic link or not a regular file): such data does not open for writing.", "часть .bb-docs не читается (символическая ссылка или не обычный файл) — такие данные не открываются для записи.");
  if (/newer schema version|newer than this plugin/.test(reason)) return tr(`there are changes from a newer schema version${version ? ` (${version})` : ""}: the affected documents and comments are read-only until the plugin is updated.`, `есть изменения более новой версии схемы${version ? ` (${version})` : ""}: затронутые документы и замечания только для чтения до обновления плагина.`);
  if (/conflict in/.test(reason)) return tr("branches diverged in this data: choose a value explicitly.", "ветки разошлись в этих данных: выберите значение явно.");
  if (/missing parent event|missing object|snapshot .* is missing|unknown revision|names unknown/.test(reason)) return tr("the data is incomplete (some .bb-docs files did not arrive, for example after an unfinished commit or merge): the affected records are read-only.", "данные неполны (часть файлов .bb-docs не пришла, например незавершённый коммит или слияние): затронутые записи только для чтения.");
  if (/more than \d+ events/.test(reason)) return tr("the entity has too many events to write safely.", "у сущности слишком много событий для безопасной записи.");
  return reason;
}

type ConfigLists = { roots: string[]; hidden: string[]; untracked: string[] };
const listsOf = (config: ConfigLists): ConfigLists => ({ roots: config.roots, hidden: config.hidden, untracked: config.untracked });

interface Built {
  revision: Revision;
  projection: Projection;
}

/** Per-service caches; keys are content hashes, so stale entries are only memory, never wrong answers. */
const projections = new Map<string, FileProjection>();

/** Forget in-memory projections and computed views (a cold host in tests and measurements). */
export function clearViewCaches(): void {
  projections.clear();
  views = new WeakMap();
}
function projectionOf(docPath: string, text: string, sha: string): FileProjection {
  const key = `${projectionFormat(docPath)}|${sha}`;
  let value = projections.get(key);
  if (!value) {
    value = projectFile(docPath, text);
    projections.set(key, value);
    if (projections.size > 64) projections.delete(projections.keys().next().value!);
  }
  return value;
}

let views = new WeakMap<State, Map<string, DocumentView>>();

export async function snapshotText(service: ReviewService, sha: string): Promise<string | null> {
  const bytes = await service.store.read(layout.snapshot(sha));
  return bytes && sha256(bytes) === sha ? decoder.decode(bytes) : null;
}

/** A persistent revision with the projection of its snapshot. */
export async function persistentBuilt(service: ReviewService, state: State, revisionId: string): Promise<Built | null> {
  const revision = revisionObject(state, revisionId) as Revision | null;
  if (!revision) return null;
  const text = await snapshotText(service, revision.snapshot);
  if (text === null) return null;
  const markdown = projectionFormat(revision.path) === "markdown";
  if (markdown && !projections.has(`markdown|${revision.snapshot}`)) await warmParse(text, path.join(service.dataDir, "chunks"));
  return { revision, projection: projectionOf(revision.path, text, revision.snapshot) };
}

/** The current bytes as a revision: the persistent one with these bytes, or an in-memory one on its heads (G8). */
export async function currentBuilt(service: ReviewService, state: State | null, input: { path: string; docId: string | null; text: string; sha: string; revisionId: string | null; headRevisions: string[]; rules?: string | null }): Promise<Built & { ephemeral: boolean }> {
  if (state && input.revisionId) {
    const built = await persistentBuilt(service, state, input.revisionId);
    if (built) return { ...built, ephemeral: false };
  }
  const parents = [];
  if (state) {
    for (const id of input.headRevisions) {
      const parent = await persistentBuilt(service, state, id);
      if (!parent) throw Object.assign(new Error(`revision ${id} or its snapshot is missing`), { code: "incomplete" });
      parents.push({ revision: parent.revision, source: parent.projection.source, projection: parent.projection });
    }
  }
  // A stable id for the same bytes on the same heads: the view of one observation keeps its block ids.
  const revisionId = toUuid(sha256(`ephemeral\n${input.sha}\n${[...input.headRevisions].sort().join(",")}`));
  // Large documents: the missing chunks are parsed in parallel first; buildRevision then finds them cached.
  if (projectionFormat(input.path) === "markdown") await warmParse(input.text, path.join(service.dataDir, "chunks"));
  const built = buildRevision({ revisionId, docId: input.docId ?? toUuid(sha256(`doc\n${input.path}`)), path: input.path, source: input.text, snapshot: input.sha, parents, ...(input.rules ? { redacted: { rules: input.rules } } : {}) });
  return { ...built, ephemeral: true };
}

function toUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** State extended with an in-memory revision so the read reducer can see it (nothing is written). */
export function withEphemeral(state: State, revision: Revision): State {
  if (state.revisions.has(revision.revisionId)) return state;
  const sha = sha256(canonicalBytes(revision));
  const objects = new Map(state.objects);
  objects.set(sha, revision as ObjectValue);
  const revisions = new Map(state.revisions);
  revisions.set(revision.revisionId, { revisionId: revision.revisionId, docId: revision.docId, eventId: "ephemeral", objectSha: sha, reason: "observed" });
  return { ...state, objects, revisions } as State;
}

function annotationsOfDoc(state: State, docId: string): { annotationId: string; object: Annotation }[] {
  const found: { annotationId: string; object: Annotation }[] = [];
  for (const eventId of state.order) {
    for (const change of state.events.get(eventId)!.changes) {
      if (change.type !== "annotation.created" || change.docId !== docId) continue;
      const object = state.objects.get(change.annotation);
      if (object?.type === "Annotation" && !found.some((entry) => entry.annotationId === change.annotationId)) found.push({ annotationId: change.annotationId, object });
    }
  }
  return found;
}

function messagesOf(state: State, view: DiscussionView): ViewMessage[] {
  const results = new Map<string, string>();
  for (const run of runsOf(state)) for (const result of run.results) if (result.annotationId === view.annotationId) results.set(result.messageId, result.status);
  return view.messages.map((message) => {
    const first = message.revisions[0];
    const shown = message.current ?? message.revisions[message.revisions.length - 1];
    const actor = first.actor;
    return {
      messageId: message.messageId,
      role: message.role,
      author: actor.kind === "human" ? actor.name : tr("Agent", "Агент"),
      email: actor.kind === "human" ? actor.email : null,
      model: actor.kind === "agent" ? actor.model : null,
      threadId: actor.kind === "agent" ? actor.threadId : null,
      requestedBy: actor.kind === "agent" ? actor.requestedBy.name : null,
      text: shown?.text ?? null,
      revisions: message.revisions.length,
      timestamp: first.timestamp,
      eventId: shown?.eventId ?? first.eventId,
      runId: first.runId ?? null,
      itemId: first.itemId ?? null,
      resultStatus: results.get(message.messageId) ?? null,
      conflict: message.current === null,
    };
  }).sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
}

/** Anchor of a stored target on the current revision; document targets have no place, removed blocks stay at their place. */
export async function anchorOf(service: ReviewService, state: State, object: Annotation, current: Built, tombstonePlace: Map<string, number>): Promise<ViewAnnotation["anchor"]> {
  const target = object.target;
  if (target["bbdr:targetKind"] === "document") return { status: "exact", ranges: [], place: null, blocks: [] };
  const tombstoneId = target["bbdr:tombstoneId"];
  const selectors = target.selector ?? [];
  const quote = selectors.find((selector) => selector.type === "TextQuoteSelector") as { exact: string; prefix: string; suffix: string } | undefined;
  const position = selectors.find((selector) => selector.type === "TextPositionSelector") as { start: number; end: number } | undefined;
  const targetBuilt = await persistentBuilt(service, state, target["bbdr:revisionId"]);
  if (!targetBuilt || !quote || !position) return { status: "orphaned", ranges: [], place: null, blocks: [] };
  const lineages = new Set(target["bbdr:segments"].map((segment) => segment.lineageId));
  if (tombstoneId) {
    // A change of a removed block: if the lineage is back, show it there; otherwise at the deletion.
    const back = current.revision.blocks.findIndex((block) => lineages.has(block.lineageId));
    if (back >= 0) return { status: "mapped", ranges: [current.revision.blocks[back].range], place: back, blocks: [back] };
    return { status: "orphaned", ranges: [], place: tombstonePlace.get(tombstoneId) ?? null, blocks: [] };
  }
  let resolution;
  try {
    const keyPath = (selectors.find((selector) => selector.type === "bbdr:KeyPathSelector") as { value: string } | undefined)?.value ?? null;
    const lineRange = selectors.find((selector) => selector.type === "bbdr:LineRangeSelector") as { start: number; end: number } | undefined;
    resolution = resolveFormatAnchor({ revision: targetBuilt.revision, projection: targetBuilt.projection, range: position, quote, keyPath, lineRange: lineRange ? { start: lineRange.start, end: lineRange.end } : null }, current);
  } catch {
    return { status: "orphaned", ranges: [], place: null, blocks: [] };
  }
  const blocks = new Set<number>();
  for (const range of resolution.ranges) {
    current.revision.blocks.forEach((block, index) => {
      const hit = range.start === range.end ? range.start >= block.range.start && range.start <= block.range.end : range.start < block.range.end && range.end > block.range.start;
      if (hit) blocks.add(index);
    });
  }
  // Block-like targets of an empty block (image, rule) follow the lineage.
  if (!blocks.size && position.start === position.end) {
    current.revision.blocks.forEach((block, index) => { if (lineages.has(block.lineageId)) blocks.add(index); });
  }
  const place = resolution.place?.block ?? (blocks.size ? Math.min(...blocks) : null);
  return { status: resolution.status, ranges: resolution.ranges, place, blocks: [...blocks].sort((a, b) => a - b) };
}

/** Concurrent requests of the same document of a checkout share one computation (watch prefetch + the client). */
const inflight = new Map<string, Promise<DocumentView>>();
/** Documents viewed recently per checkout: the watch prefetches their new revision (EP-012-T04). */
const recent = new Map<string, Map<string, number>>();

/** The text of a document without review state (W-06a fast path): what the viewer shows before the full view arrives. */
export interface TextView {
  path: string;
  sha: string;
  size: number;
  /** Blocks in the document; `blocks` holds [from, from + blocks.length). */
  total: number;
  from: number;
  /** Plain projected blocks in the compact wire format (core/wire.ts): no lineage, read state, diff or annotations. */
  blocks: WireBlock[];
  /** Every heading of the document (index, text, depth): sections in the tree and jumps before the rest arrives. */
  headings: { index: number; text: string; depth: number }[];
  /** Text length of every block when not all blocks are sent: the viewer estimates the height of the rest. */
  lengths: number[] | null;
  /** W-06c: format of the file, its Git class, the parse error of a structured file, masks of secrets (UI only). */
  format: string | null;
  fileClass: string;
  parseError: { line: number; message: string } | null;
  secrets: ViewSecret[];
  /** W-06c: metadata of the sent blocks of a non-Markdown file (key path, key, value as shown, kind, comment, cells…). */
  meta: (Record<string, unknown> | null)[] | null;
  /** “Raw” (on request): the redacted source, lines of each block, foldable ranges. */
  source?: string;
  blockLines?: [number, number][];
  folds?: { line: number; end: number; label: string }[];
  computeMs: number;
}

/** A masked secret as the UI of this checkout sees it (F19): where, its length, «value changed» on this device. */
export interface ViewSecret {
  start: number;
  end: number;
  line: number;
  path: (string | number | { doc: number })[] | null;
  key: string | null;
  length: number;
  explicit: boolean;
  scope: "shared" | "personal";
  place: string;
  exempt: "me" | null;
  changed: boolean;
}

function uiSecrets(secrets: SecretInfo[], changed: Set<string> = new Set()): ViewSecret[] {
  return secrets.map((secret) => ({ ...secret, changed: changed.has(secret.place) }));
}

/**
 * Fast path of a document (EP-027-T08): the confined file, its hash and its projection — parsed chunks come from the
 * memory and disk caches; no journal, no read state, no diff, no anchors, nothing recorded. `from`/`limit` cut the
 * blocks; `around` (a heading slug) starts the cut a few blocks before that heading, so a jump into the middle of a
 * large document has its target in the first answer.
 */
export async function documentText(service: ReviewService, docPath: string, options: { from?: number; limit?: number; around?: string | null; slug?: (text: string) => string; outline?: boolean; source?: boolean } = {}): Promise<TextView> {
  const started = performance.now();
  // Through the redaction (W-06c, §8): the text of a file with secrets is its redacted form.
  const content = await readContent(service, docPath, { readerId: await readerOf(service) });
  const bytes = content.bytes;
  const sha = content.sha;
  const text = content.text;
  if (content.format === "markdown" && !projections.has(`markdown|${sha}`) && bytes.length > 64 * 1024) await warmParse(text, path.join(service.dataDir, "chunks"));
  const projection = projectionOf(docPath, text, sha);
  const total = projection.blocks.length;
  // Sections of the tree: Markdown headings; for structured files the groups of the first two levels (W-06c).
  const headings = projection.blocks.flatMap((block, index) => (block.type === "heading" || (block.type === "group" && (block.depth ?? 1) <= 2)
    ? [{ index, text: block.type === "group" ? groupTitle(projection, index) : block.text, depth: block.depth ?? 1 }] : []));
  let from = Math.max(0, Math.min(options.from ?? 0, total));
  if (options.around && options.slug) {
    const target = headings.find((heading) => options.slug!(heading.text) === options.around);
    if (target) from = Math.max(0, target.index - 8);
  }
  const limit = Math.max(1, Math.min(options.limit ?? total, total));
  const slice = projection.blocks.slice(from, from + limit);
  const blocks = encodeBlocks(slice.map((block, offset) => ({
    index: from + offset, type: block.type, range: block.range, text: block.text, inline: block.fingerprint.inline, attrs: block.fingerprint.attrs,
    depth: block.depth ?? null, cell: block.cell ?? null, headings: block.headings,
  })), headingStack(headings, from));
  const partial = from > 0 || from + blocks.length < total;
  // Later parts of a large document skip the outline and the lengths: the viewer has them from the first answer.
  const outline = options.outline !== false;
  // Metadata of structured nodes and table rows for «Pretty» (W-06c): without the internal value offsets.
  const meta = projection.format === "markdown" ? null : slice.map((_, offset) => {
    const value = projection.meta[from + offset];
    if (!value) return null;
    const { valueStart: _s, valueEnd: _e, ...shown } = value;
    return shown;
  });
  return { path: docPath, sha, size: bytes.length, total, from, blocks, headings: outline ? headings : [], lengths: partial && outline ? projection.blocks.map((block) => [...block.text].length) : null,
    format: content.format, fileClass: content.fileClass, parseError: content.parseError ?? projection.parseError, secrets: uiSecrets(content.secrets), meta,
    ...(options.source ? sourceView(projection) : {}), computeMs: Math.round(performance.now() - started) };
}

/** Title of a group block in the outline: its key (or «Document N» of a multi-document YAML). */
function groupTitle(projection: FileProjection, index: number): string {
  const meta = projection.meta[index];
  const last = meta?.path?.[meta.path.length - 1];
  if (last !== undefined && typeof last === "object") return `${tr("Document", "Документ")} ${(last as { doc: number }).doc + 1}`;
  return meta?.key ?? String(last ?? projection.blocks[index].text);
}

/**
 * “Raw” (W-06c, §6): the redacted source text, the 1-based lines of every block, and the foldable ranges — groups
 * of structured files (with their size), sections of Markdown.
 */
function sourceView(projection: FileProjection): { source: string; blockLines: [number, number][]; folds: { line: number; end: number; label: string }[] } {
  const coords = projection.sourceCoords;
  const lineOf = (cp: number) => coords.cpToLineCol(Math.min(Math.max(cp, 0), coords.length)).line;
  const blockLines = projection.blocks.map((block): [number, number] => [lineOf(block.source.start), lineOf(Math.max(block.source.start, block.source.end - (block.source.end > block.source.start ? 1 : 0)))]);
  const folds: { line: number; end: number; label: string }[] = [];
  projection.blocks.forEach((block, index) => {
    if (block.type !== "group" && block.type !== "heading") return;
    let end = blockLines[index][1];
    for (let next = index + 1; next < projection.blocks.length; next++) {
      const inside = projection.blocks[next].headings.includes(index);
      if (!inside) break;
      end = Math.max(end, blockLines[next][1]);
    }
    // A JSON/TOML group closes on the line of its bracket: include it when it follows the last child.
    if (block.type === "group" && projection.format !== "yaml") {
      const text = projection.source.split("\n");
      if (text[end] !== undefined && /^\s*[}\]],?\s*$/.test(text[end])) end += 1;
    }
    if (end <= blockLines[index][0]) return;
    const meta = projection.meta[index];
    const count = meta?.count ?? 0;
    const label = block.type === "heading" ? `${end - blockLines[index][0]} ${plural(end - blockLines[index][0], forms(["line", "lines"], ["строка", "строки", "строк"]))}`
      : meta?.kind === "array" ? `[…] ${count}` : `{…} ${count}`;
    folds.push({ line: blockLines[index][0], end, label });
  });
  return { source: projection.source, blockLines, folds };
}

/** The full view without its text (EP-027-T08): the viewer applies the overlay to the fast path's blocks of the same hash. */
export type CompactView = Omit<DocumentView, "blocks"> & { blocks: []; overlay: WireOverlay };
export function compactView(view: DocumentView): CompactView {
  return { ...view, blocks: [], overlay: encodeOverlay(view.document.sha, view.blocks) };
}

export function documentView(service: ReviewService, docPath: string): Promise<DocumentView> {
  const key = `${service.root}\0${docPath}\0${service.generation}\0${lang()}`;
  const seen = recent.get(service.root) ?? new Map<string, number>();
  seen.set(docPath, Date.now());
  if (seen.size > 8) seen.delete(seen.keys().next().value!);
  recent.set(service.root, seen);
  const running = inflight.get(key);
  if (running) return running;
  const promise = computeView(service, docPath).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/**
 * After a change on disk, compute the new view of the recently viewed documents that changed, so the viewer's own
 * request (prompted by the realtime hint) finds it ready or joins the computation instead of starting another.
 */
export async function prefetchViews(service: ReviewService, changed: readonly string[]): Promise<void> {
  const seen = recent.get(service.root);
  if (!seen) return;
  const fresh = [...seen].filter(([, at]) => Date.now() - at < 30 * 60_000).map(([path]) => path);
  const targets = changed.length ? fresh.filter((path) => changed.some((entry) => entry === path || entry.endsWith(`/${path}`) || path.endsWith(`/${entry}`))) : fresh;
  for (const path of targets.slice(0, 3)) await documentView(service, path).catch(() => undefined);
}

async function computeView(service: ReviewService, docPath: string): Promise<DocumentView> {
  const started = performance.now();
  const info = await service.checkoutForRead();
  const configRead = info.isRepo ? await service.config() : { value: null, sha: null, readOnly: false, problem: undefined };
  const config = configRead.value;
  let readerId: string | null = null;
  let identityProblem: string | null = null;
  try {
    readerId = normalizeReaderId(info.identity.email);
  } catch (error) {
    identityProblem = error instanceof Error ? error.message : String(error);
  }
  const state = config ? await service.state(info) : null;
  let current: Awaited<ReturnType<ReviewService["readDocument"]>>;
  let missing = false;
  let deletionUnread = false;
  try {
    current = await service.readDocument(docPath);
  } catch (error) {
    // A document gone from disk stays a virtual entry while the journal knows it (AC08): its last revision is shown.
    const record = state && (error as { code?: string }).code === "not-found"
      ? [...state.documents.values()].filter((doc) => doc.path === docPath).sort((a, b) => Number(a.removed) - Number(b.removed))[0] ?? null : null;
    const head = record ? record.headRevisions[record.headRevisions.length - 1] : undefined;
    const built = state && head ? await persistentBuilt(service, state, head) : null;
    if (!record || !built) throw error;
    missing = true;
    // Per reader (EP-014-T05): unread until this reader acknowledged the deletion; without an email, per checkout.
    deletionUnread = readerId && state ? removalState(state, readerId, record.docId) === "unread" : !record.removed;
    current = { path: docPath, docId: record.docId, sha: built.revision.snapshot, size: built.projection.source.length, text: built.projection.source,
      head: info.head, branch: info.branch, revisionId: head!, headRevisions: record.headRevisions,
      format: formatOf(docPath), fileClass: "git", rules: built.revision.redacted?.rules ?? null, secrets: [], personalText: built.projection.source, parseError: null };
  }
  const cacheKey = `${lang()}|${current.sha}|${readerId ?? "-"}|${config ? "on" : "off"}|${current.path}|${missing ? "gone" : "here"}|${JSON.stringify(config?.hidden ?? [])}|${JSON.stringify(config?.untracked ?? [])}`;
  if (state) {
    const cached = views.get(state)?.get(cacheKey);
    // The same redacted bytes may hide a changed secret value: «value changed» is computed afresh (device HMAC).
    if (cached) return { ...cached, secrets: await secretFlags(service, docPath, current, readerId, config), computeMs: Math.round(performance.now() - started) };
  }

  const readOnlyReason = !info.isRepo ? tr("Folder without Git: read-only (A11)", "Папка без Git: только чтение (A11)")
    : configRead.readOnly ? `${tr("Review data is read-only", "Данные обзора только для чтения")}: ${explainReadOnly(configRead.problem ?? "config.json is from a newer schema version")}`
    : identityProblem ? tr("Git has no user.email set: you can read but not write (C3)", "В Git не задан user.email: читать можно, писать нельзя (C3)")
    : !config ? null
    : state?.repoReadOnly.length ? `${tr("Read-only", "Только чтение")}: ${explainReadOnly(state.repoReadOnly[0])}` : null;
  const insideRoots = config ? service.insideRoots(config, docPath) : false;
  const untracked = config ? ignore().add(config.untracked).ignores(docPath) : false;
  const built = await currentBuilt(service, state, current);
  const { revision, projection } = built;
  const docId = current.docId;

  // Read state (DR-02) for the shown revision.
  let read: ReturnType<typeof readState> | null = null;
  const tracked = Boolean(state && docId && readerId && !untracked);
  if (state && docId && readerId && !untracked && !missing && !state.incomplete.has(entity.doc(docId))) {
    read = readState(withEphemeral(state, revision), readerId, revision.revisionId);
  }

  const baseCache = new Map<string, Built | null>();
  const baseOf = async (revisionId: string) => {
    if (!baseCache.has(revisionId)) baseCache.set(revisionId, state ? await persistentBuilt(service, state, revisionId) : null);
    return baseCache.get(revisionId)!;
  };
  const headingText = (b: Built, index: number) => {
    const heading = b.projection.blocks[index];
    return heading ? heading.text : null;
  };
  const sectionOf = (b: Built, index: number) => {
    const headings = b.projection.blocks[index]?.headings ?? [];
    return headings.length ? headingText(b, headings[headings.length - 1]) : null;
  };

  // A newly discovered file stays read until its first explicit opening starts tracking.
  const brandNew = Boolean(state && !docId && readerId && insideRoots && !untracked);
  // F4 without an edit: a block whose version the reader already has but that sits in another section than in the
  // revision of the reader's last base. Show moved from section as an informational mark, never unread.
  let movedBase: Built | null = null;
  if (state && docId && readerId && read && !missing) {
    const bases = receiptsOf(state, readerId, docId).map((receipt) => ({ revisionId: receipt.revisionId, order: state.order.indexOf(receipt.eventId) }));
    for (const id of revisionHistory(withEphemeral(state, revision), revision.revisionId)) {
      const record = state.revisions.get(id);
      if (record && (record.reason === "baseline" || record.reason === "tracking-resumed")) bases.push({ revisionId: id, order: state.order.indexOf(record.eventId) });
    }
    // The latest base; when it is the shown revision itself, nothing has moved since the reader confirmed it.
    const last = bases.sort((a, b) => a.order - b.order).pop();
    if (last && last.revisionId !== revision.revisionId) movedBase = await baseOf(last.revisionId);
  }
  const movedBaseIndex = new Map((movedBase?.revision.blocks ?? []).map((block, index) => [block.lineageId, index]));
  const blocks: ViewBlock[] = [];
  for (const [index, block] of projection.blocks.entries()) {
    const rev = revision.blocks[index];
    const state0 = read?.blocks[index] ?? (brandNew ? { state: "read" as const, lineageId: rev.lineageId, versionId: rev.versionId, base: { lineageId: rev.lineageId, versionId: rev.versionId } } : null);
    let diff: ViewBlock["diff"] = null;
    let movedFrom: string | null = null;
    if (state0 && state0.state === "unread" && state0.change === "edited" && state0.base) {
      const base = await baseOf(bornIn(state0.base.versionId));
      const baseIndex = base?.revision.blocks.findIndex((candidate) => candidate.versionId === state0.base!.versionId) ?? -1;
      if (base && baseIndex >= 0) {
        const before = base.projection.blocks[baseIndex].text;
        const words = blockDiff(before, block.text);
        diff = { ...words, before };
        const from = sectionOf(base, baseIndex);
        const now = sectionOf(built, index);
        if (from !== now && from !== null) movedFrom = from;
      }
    }
    let moved = false;
    if (state0?.state === "read" && movedBase && block.type !== "heading") {
      const baseIndex = movedBaseIndex.get(rev.lineageId);
      if (baseIndex !== undefined) {
        const from = sectionOf(movedBase, baseIndex);
        const now = sectionOf(built, index);
        if (from !== null && from !== now) {
          movedFrom = from;
          moved = true;
        }
      }
    }
    blocks.push({
      index, type: block.type, range: block.range, text: block.text, inline: block.fingerprint.inline, attrs: block.fingerprint.attrs,
      depth: block.depth ?? null, cell: block.cell ?? null, headings: block.headings, lineageId: rev.lineageId, versionId: rev.versionId,
      read: state0 ? (state0.state === "read" ? "read" : state0.state === "ambiguous" ? "ambiguous" : "unread") : null,
      change: state0?.state === "unread" ? state0.change : state0?.state === "ambiguous" ? "edited" : null,
      diff, movedFrom, moved,
    });
  }

  // Removed blocks: the deletion is shown at the nearest surviving place with the old text.
  const tombstones = new Map<string, Revision["removed"][number]>();
  if (state) {
    for (const id of [revision.revisionId, ...revisionHistory(withEphemeral(state, revision), revision.revisionId)]) {
      const holder = id === revision.revisionId ? revision : (revisionObject(state, id) as Revision | null);
      for (const tombstone of holder?.removed ?? []) tombstones.set(tombstone.tombstoneId, tombstone);
    }
  }
  const byLineage = new Map(revision.blocks.map((block, index) => [block.lineageId, index]));
  const placeOf = (tombstone: Revision["removed"][number]) => {
    const after = tombstone.placement.afterLineageId ? byLineage.get(tombstone.placement.afterLineageId) : undefined;
    if (after !== undefined) return after;
    const before = tombstone.placement.beforeLineageId ? byLineage.get(tombstone.placement.beforeLineageId) : undefined;
    return before !== undefined ? before - 1 : -1;
  };
  const tombstonePlace = new Map<string, number>();
  for (const [id, tombstone] of tombstones) tombstonePlace.set(id, placeOf(tombstone));
  const removed: ViewRemoved[] = (read?.removed ?? []).filter((entry) => entry.state === "unread").flatMap((entry) => {
    const tombstone = tombstones.get(entry.tombstoneId);
    if (!tombstone) return [];
    const section = tombstone.placement.sectionLineageId ? byLineage.get(tombstone.placement.sectionLineageId) : undefined;
    return [{ tombstoneId: entry.tombstoneId, lineageId: entry.lineageId, text: tombstone.text, type: tombstone.type, after: placeOf(tombstone),
      section: section !== undefined ? blocks[section]?.text ?? null : null, read: false }];
  });

  // Annotations of this document.
  const annotations: ViewAnnotation[] = [];
  if (state && docId) {
    for (const { annotationId, object } of annotationsOfDoc(state, docId)) {
      const view = discussion(state, annotationId);
      const anchor = await anchorOf(service, state, object, built, tombstonePlace);
      const latestFound = latestResultOf(state, annotationId);
      let latest: ViewAnnotation["latest"] = null;
      if (latestFound) {
        const linked = linkedEdits(state, latestFound.run, latestFound.result);
        const shown: { block: number; lineageId: string; versionId: string }[] = [];
        let changed = 0;
        const elsewhere: { path: string | null; count: number }[] = [];
        for (const entry of linked) {
          if (entry.docId !== docId) {
            elsewhere.push({ path: state.documents.get(entry.docId)?.path ?? null, count: entry.versions.length });
            continue;
          }
          for (const version of entry.versions) {
            const index = revision.blocks.findIndex((block) => block.versionId === version.versionId);
            if (index >= 0) shown.push({ block: index, ...version });
            else changed++;
          }
        }
        latest = { runId: latestFound.run.runId, eventId: latestFound.result.eventId, status: latestFound.result.status, timestamp: latestFound.result.timestamp,
          linked: shown, linkedChanged: changed, linkedElsewhere: elsewhere };
      }
      const quote = (object.target.selector ?? []).find((selector) => selector.type === "TextQuoteSelector") as { exact: string; prefix: string; suffix: string } | undefined;
      const element = (object.target.selector ?? []).find((selector) => selector.type === "bbdr:ObjectSelector") as { id: string; kind: "node" | "edge" | "group" | "text" | "other"; label: string } | undefined;
      annotations.push({
        annotationId, path: object.target["bbdr:path"], targetKind: object.target["bbdr:targetKind"], quote: quote ?? { exact: "", prefix: "", suffix: "" },
        element: element ? { id: element.id, kind: element.kind, label: element.label } : null,
        tombstoneId: object.target["bbdr:tombstoneId"] ?? null, created: object.created,
        creator: { name: object.creator.name, email: object.creator.email.replace(/^mailto:/, "") },
        kind: view.kind, status: view.status, heads: state.heads.get(entity.annotation(annotationId)) ?? [],
        messages: messagesOf(state, view), anchor, agent: agentState(view, state), waiting: waitsForUser(view), candidate: view.candidate,
        dispatched: view.dispatched, newInstructions: view.newInstructions.length,
        inFlight: view.instructions.find((instruction) => instruction.inFlight)?.inFlight ?? null,
        conflicts: view.conflicts.map((conflict) => ({ register: conflict.register, candidates: conflict.candidates })), incomplete: view.incomplete,
        latest,
      });
    }
  }

  // A7: the latest tracking-resumed base of the shown history, unless the reader confirmed something after it.
  let trackingResumed: string | null = null;
  if (state && docId && !missing) {
    let latest: { order: number; timestamp: string } | null = null;
    for (const id of revisionHistory(withEphemeral(state, revision), revision.revisionId)) {
      const record = state.revisions.get(id);
      if (record?.reason !== "tracking-resumed") continue;
      const order = state.order.indexOf(record.eventId);
      if (!latest || order > latest.order) latest = { order, timestamp: state.events.get(record.eventId)!.timestamp };
    }
    const lastOwn = readerId ? Math.max(-1, ...receiptsOf(state, readerId, docId).map((receipt) => state.order.indexOf(receipt.eventId))) : -1;
    if (latest && lastOwn < latest.order) trackingResumed = latest.timestamp;
  }

  let lastReceipt: DocumentView["lastReceipt"] = null;
  if (state && docId && readerId) {
    const receipts = receiptsOf(state, readerId, docId);
    const last = receipts.sort((a, b) => state.order.indexOf(a.eventId) - state.order.indexOf(b.eventId)).pop();
    if (last) {
      const change = state.events.get(last.eventId)!.changes.find((entry) => entry.type === "read.acknowledged" && entry.receiptId === last.receiptId);
      lastReceipt = { receiptId: last.receiptId, scope: change && change.type === "read.acknowledged" ? change.scope : "block", blocks: last.versions.length + last.tombstones.length, eventId: last.eventId };
    }
  }

  let configConflict: DocumentView["context"]["configConflict"] = null;
  if (configRead.readOnly && (configRead as { configConflict?: boolean }).configConflict) {
    const conflict = await service.configConflict().catch(() => null);
    if (conflict) configConflict = { configSha: configRead.sha ?? null, ours: listsOf(conflict.ours), theirs: listsOf(conflict.theirs), merged: listsOf(conflict.merged), problem: conflict.problem };
  }
  const docConflict = state && docId ? state.documents.get(docId)?.conflict ?? null : null;
  const docBlockers = state && docId ? [...(state.incomplete.get(entity.doc(docId)) ?? []), ...(state.readOnly.get(entity.doc(docId)) ?? [])].filter((reason) => !/conflict in/.test(reason)) : [];
  const docReadOnly = docBlockers.length ? explainReadOnly(docBlockers[0]) : null;
  const result: DocumentView = {
    context: {
      root: service.root, isRepo: info.isRepo, head: info.head, branch: info.branch, enabled: Boolean(config), repoId: config?.repoId ?? null,
      identity: info.identity, readerId, writable: Boolean(config) && readOnlyReason === null && !missing, readOnlyReason, roots: config?.roots ?? [], configConflict,
    },
    document: {
      path: current.path, docId, sha: current.sha, size: current.size, revisionId: built.ephemeral ? null : revision.revisionId, ephemeral: built.ephemeral,
      tracked: tracked || brandNew, insideRoots, projectionLength: projection.textCoords.length, headRevisions: current.headRevisions,
      missing, deletionUnread, hidden: config ? ignore().add(config.hidden).ignores(docPath) : false, trackingResumed, conflict: docConflict, readOnly: docReadOnly,
    },
    blocks, removed, annotations, layouts: await diagramLayouts(state, docId, readerId, revision, blocks, baseOf),
    scope: service.scope, format: current.format ?? null, fileClass: current.fileClass ?? "git", parseError: (current as { parseError?: { line: number; message: string } | null }).parseError ?? (projection as Partial<FileProjection>).parseError ?? null, secrets: [],
    unread: blocks.filter((block) => block.read === "unread" || block.read === "ambiguous").length + removed.length,
    lastReceipt,
    computeMs: Math.round(performance.now() - started),
  };
  if (state) {
    let map = views.get(state);
    if (!map) views.set(state, (map = new Map()));
    map.set(cacheKey, result);
  }
  return { ...result, secrets: missing ? [] : await secretFlags(service, docPath, current, readerId, config) };
}

/**
 * Masks of the shown document with «value changed» on this device (§8, F13): the HMAC of each current value under
 * the device key is compared with the one this device last saw; the first sight only records it. Nothing but booleans
 * leaves this function.
 */
async function secretFlags(service: ReviewService, docPath: string, current: { secrets?: SecretInfo[]; fileClass?: string }, readerId: string | null, config: import("../core/schema.ts").Config | null): Promise<ViewSecret[]> {
  if (!current.secrets?.length) return [];
  // A file outside Git is shown only: nothing is stored for it on this device either (until local review, EP-048).
  if (!service.reviews((current.fileClass ?? "git") as import("./content.ts").FileClass)) return uiSecrets(current.secrets);
  const content = await readContent(service, docPath, { readerId, config, macs: true }).catch(() => null);
  if (!content?.macs) return uiSecrets(current.secrets);
  const seen = await service.secrets.seen(service.root, docPath);
  const changed = new Set<string>();
  const baseline: Record<string, string> = {};
  for (const [place, mac] of Object.entries(content.macs)) {
    if (seen[place] === undefined) baseline[place] = mac;
    else if (seen[place] !== mac) changed.add(place);
  }
  if (Object.keys(baseline).length) await service.secrets.write(service.root, docPath, baseline, { merge: true }).catch(() => undefined);
  return uiSecrets(content.secrets, changed);
}

/** «Value changed» is cleared by looking at the value (reveal) or by «Mark read»: this device saw the current one. */
export async function markSecretsSeen(service: ReviewService, docPath: string, places?: string[] | null): Promise<{ seen: number }> {
  // Nothing is stored for a file this review does not keep (outside Git and not tracked locally).
  if (!service.reviews(await service.fileClass(docPath))) return { seen: 0 };
  const content = await readContent(service, docPath, { macs: true });
  const entries = Object.fromEntries(Object.entries(content.macs ?? {}).filter(([place]) => !places || places.includes(place)));
  if (Object.keys(entries).length) await service.secrets.write(service.root, docPath, entries, { merge: true });
  return { seen: Object.keys(entries).length };
}

export { newId };

const PREVIOUS_DEPTH = 64;

/** The previous version of one diagram block (EP-061-T01): walk the parents while the block is the same version. */
async function previousOf(state: State, revision: Revision, index: number, text: string, baseOf: (revisionId: string) => Promise<Built | null>): Promise<DiagramPrevious> {
  const { lineageId, versionId } = revision.blocks[index];
  const at = (revisionId: string) => { const record = state.revisions.get(revisionId); return record ? state.events.get(record.eventId)?.timestamp ?? null : null; };
  const baseIn = (built: Built): DiagramBase => {
    const found = built.revision.blocks.findIndex((block) => block.lineageId === lineageId);
    const before = found >= 0 ? built.projection.blocks[found]?.text ?? null : null;
    return { revisionId: built.revision.revisionId, at: at(built.revision.revisionId), text: before, diff: before === null ? null : blockDiff(before, text) };
  };
  let parents = revision.parents;
  for (let depth = 0; depth < PREVIOUS_DEPTH; depth++) {
    if (!parents.length) return { kind: "none", reason: "no-history" };
    const builts = await Promise.all(parents.map((id) => baseOf(id)));
    if (builts.some((built) => !built)) return { kind: "none", reason: "unavailable" };
    const versions = builts.map((built) => built!.revision.blocks.find((block) => block.lineageId === lineageId)?.versionId ?? null);
    if (versions.every((version) => version === versionId)) {
      if (builts.length > 1) return { kind: "none", reason: "no-history" };
      parents = builts[0]!.revision.parents;
      continue;
    }
    if (builts.length > 1) return { kind: "merge", candidates: builts.map((built) => baseIn(built!)) };
    if (versions[0] === null) return { kind: "none", reason: "added" };
    return { kind: "version", base: baseIn(builts[0]!) };
  }
  return { kind: "none", reason: "far" };
}

/** Personal layouts of the embedded objects (1.3): per fenced block with a language of the shown revision, by its lineage, for this reader. */
async function diagramLayouts(state: State | null, docId: string | null, readerId: string | null, revision: Revision, blocks: readonly { type: string; text: string; attrs: Record<string, unknown> }[],
  baseOf: (revisionId: string) => Promise<Built | null>): Promise<DocumentView["layouts"]> {
  if (!state || !docId || !readerId) return [];
  const out: DocumentView["layouts"] = [];
  for (const [index, block] of blocks.entries()) {
    // Every fenced block with a language is a candidate object (EP-073): which visualizer takes it is decided in the window.
    if (block.type !== "code" || !String(block.attrs.lang ?? "").trim() || !revision.blocks[index]) continue;
    const scope = { doc: docId, lineage: revision.blocks[index].lineageId, reader: readerId };
    const view = layoutOf(state, scope);
    const key = entity.layout(scope);
    const blockers = [...state.repoReadOnly, ...(state.incomplete.get(key) ?? []), ...(state.readOnly.get(key) ?? [])].filter((reason) => !/conflict in/.test(reason));
    const previous = await previousOf(state, revision, index, block.text, baseOf);
    out.push({ block: index, pins: view.pins, conflicts: view.conflicts, readOnly: blockers.length ? explainReadOnly(blockers[0]) : null, previous });
  }
  return out;
}
