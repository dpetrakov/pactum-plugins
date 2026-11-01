// Client store shared by the page, the right-panel tabs and the sidebar accessory (architecture §10: tab
// components mount only while active, so pass position, focus and filters live here, not in the tabs).
import { useSyncExternalStore } from "react";
import type { DocumentView } from "../node/view.ts";
import type { PassMode } from "./pass.ts";
import type { Route, Target } from "./route.ts";

export type ErrorInfo = { code: string; message: string; details?: unknown };

export interface BatchInfo {
  enabled: boolean;
  /** EP-048: the active batch is a local one (files outside Git; its journal is in the local store). */
  local?: boolean;
  active: null | {
    runId: string; preparedAt: string; scope: string; documents: string[]; requestedBy: { name: string; email: string } | null;
    items: { itemId: string; annotationId: string; status: string | null }[]; answered: number; total: number;
    attempts: { attemptId: string; mode: string; threadId: string | null; timestamp: string }[]; finished: null | { outcome: string };
    counts: Record<string, number>;
  };
  launch: null | { runId: string; attemptId: string; state: string; recipient: { mode: string; threadId: string | null }; queuedMessageId: string | null; reason: string | null };
  recent: { runId: string; preparedAt: string; documents: string[]; finished: { outcome: string; timestamp: string } | null; counts: Record<string, number>; total: number; attempts: { threadId: string | null }[] }[];
  thread: null | { threadId: string; exists: boolean; title: string | null; status: string; queued: boolean; waitingUser: boolean; interactions: string[] };
  recipient: { mode: "current-thread" | "new-thread"; threadId: string | null; title: string | null; reason: string | null; status?: string };
  newInstructions: { document: Record<string, number>; all: number };
  lastThreadId: string | null;
  machine: { hostId: string; name: string };
  root: string;
}

export interface DocsInfo {
  enabled: boolean;
  roots: string[];
  documents: { path: string; size: number; tracked: boolean; open: number; waiting: number; candidates: number }[];
  waiting: number;
  candidates: number;
  machine: { hostId: string; name: string };
  root: string;
}

export interface TreeEntryInfo {
  path: string; kind: "file" | "symlink"; size: number; supported: boolean; note: string | null;
  hidden: boolean; hiddenFrom: string | null; untracked: boolean; untrackedFrom: string | null;
  docId: string | null; state: "read" | "unread" | "new" | "changed" | "untracked" | null; unread: number | null;
  open: number; waiting: number; candidates: number; conflict?: boolean;
  /** W-06c: format, type group and Git class of the file (icon, type filter, «outside Git»). */
  format?: string; group?: string; fileClass?: "git" | "new" | "outside";
  /** EP-048: tracked locally (state from this reader's local review); the Git status changed and the data may move. */
  local?: boolean; transfer?: "to-git" | "to-local";
}

/** W-06c: what the tree does not show and why (exclusion rules by level, file types, symlinks). */
export interface NotShownInfo {
  rules: { level: "immutable" | "builtin" | "global" | "repo"; pattern: string; files: number; dirs: number }[];
  types: { wave2: number; other: number; disabled: number };
  symlinks: number;
}

export interface TreeInfo {
  enabled: boolean; isRepo: boolean; roots: string[]; missingRoots: string[]; suggestions: string[];
  entries: TreeEntryInfo[];
  virtual: { path: string; docId: string; reason: "missing" | "removed"; open: number; waiting: number; candidates: number; hidden: boolean; conflict?: boolean; deletionUnread?: boolean; local?: boolean }[];
  /** EP-048: this reader's local tracking rules (files and folders outside Git). */
  localRules?: { roots: string[]; untracked: string[] };
  moves: { applied: { docId: string; from: string; to: string }[]; proposals: { docId: string; from: string; open: number; candidates: { path: string; exact: boolean; git: boolean; similarity: number }[] }[] };
  excluded: string[]; skipped?: { other: number; symlinks: number }; notShown?: NotShownInfo; partial?: boolean; truncated: number; pending: number;
  totals: { waiting: number; candidates: number; unreadDocs: number; unread: number; changedDocs: number; open: number };
  computeMs: number; head: string | null; branch: string | null; hiddenRules: string[]; untrackedRules: string[]; writable: boolean;
  configSha: string | null;
  reader?: { id: string | null; known: boolean };
  machine: { hostId: string; name: string };
  root: string;
}

/** A toast of the host (sonner): text, tone, an optional reversible action («Undo» by default). */
export interface Notice {
  text: string;
  tone: "info" | "error";
  undo?: () => Promise<void>;
  /** Label of the action button; «Undo» by default. */
  actionLabel?: string;
  ms: number;
  /** A notice with the same id replaces the shown one (an optimistic mark that failed replaces its «Undo»). */
  id?: string;
}

export interface UiState {
  route: Route;
  target: Target | null;
  ctxKey: string;
  view: DocumentView | null;
  viewError: ErrorInfo | null;
  loading: boolean;
  /** A newer revision that is not applied while the user selects or types (F9). */
  pendingView: DocumentView | null;
  /**
   * How complete `view` is (EP-027-T08): «text» — the host's fast path (projected blocks, no review state, read-only);
   * «cached» — the last full view of this document from this session, being re-checked; «full» — the host's view.
   */
  viewPhase: "text" | "cached" | "full";
  /** The fast path's outline of a partially sent document: every heading, the block count and text lengths (height estimate). */
  textInfo: { path: string; total: number; headings: { index: number; text: string; depth: number }[]; lengths: number[] | null } | null;
  /** «Full width» (EP-027-T03): the document takes the whole column except the gutter; kept on this device. */
  fullWidth: boolean;
  batch: BatchInfo | null;
  /** The last «review.batch.status» failed (W-06b: the «Agent» panel shows it with «Retry»). */
  batchError: ErrorInfo | null;
  docs: DocsInfo | null;
  /** Tree of the roots (EP-011): entries with signals, virtual and moved documents. */
  tree: TreeInfo | null;
  treeError: ErrorInfo | null;
  showHidden: boolean;
  /** W-06c: type filter of the tree for this session (groups shown; null = all) and «Outside Git only». */
  typeFilter: string[] | null;
  outsideOnly: boolean;
  /** Pass scope: this document or all documents of the checkout in tree order (EP-012-T03). */
  passScope: "document" | "all";
  /** A heading slug to scroll to once the document is shown (search result, deep link). */
  pendingHash: string | null;
  /** An annotation to focus once the document is shown (deep link). */
  pendingAnnotation: string | null;
  /** Where a cross-document pass enters the next document: its first or its last stop. */
  passEntry: "first" | "last" | null;
  focusAnnotation: string | null;
  focusNonce: number;
  /** Bumped by «E»: the reply box of the focused annotation takes the keyboard focus. */
  replyNonce: number;
  /** The annotation whose reply box must take the focus once (set by «E», cleared by the box): J/K never steal focus. */
  replyFor: string | null;
  passMode: PassMode;
  passKey: string | null;
  /** Incremented by explicit pass navigation; only then the document scrolls to the stop. */
  passNonce: number;
  showDiff: boolean;
  onlyChanges: boolean;
  filter: "open" | "archive" | "waiting" | "agent" | "new" | "place";
  holding: boolean;
  previewBase: string | null;
  /** The thread whose panel hosts the viewer, if any (E12: the default recipient there). */
  panelThreadId: string | null;
  /** The heading block the reading position is in (EP-019-T02: the current section in the tree). */
  currentHeading: number | null;
}

const initial: UiState = {
  route: { kind: "none" }, target: null, ctxKey: "none", view: null, viewError: null, loading: false, pendingView: null, viewPhase: "full", textInfo: null, fullWidth: readFullWidth(),
  batch: null, batchError: null, docs: null, tree: null, treeError: null, showHidden: false, typeFilter: null, outsideOnly: false, passScope: "document", pendingHash: null, pendingAnnotation: null, passEntry: null, focusAnnotation: null, focusNonce: 0, replyNonce: 0, replyFor: null, passMode: "all", passKey: null, passNonce: 0, showDiff: true, onlyChanges: false,
  filter: "open", holding: false, previewBase: null, panelThreadId: null, currentHeading: null,
};

/** «Full width» is a property of this screen and its reader, not of the repository or a checkout: kept per device. */
function readFullWidth(): boolean {
  try {
    // A literal key: `initial` above reads it before module-level constants below are initialised.
    return localStorage.getItem("document-review:full-width") === "1";
  } catch {
    return false;
  }
}
export function setFullWidth(on: boolean): void {
  try {
    if (on) localStorage.setItem("document-review:full-width", "1");
    else localStorage.removeItem("document-review:full-width");
  } catch {
    // storage unavailable: the mode still applies to this session
  }
  setUi({ fullWidth: on });
}

let state: UiState = initial;
const listeners = new Set<() => void>();

// Chosen document selection is independent of the main store and updates ahead of bb navigation.
// A click in the tree marks the document as chosen at once; the main store's route follows when bb's navigation reaches
// the screen. Kept apart on purpose: updating the main store in the click re-rendered every subscriber (the tree, the
// page) in the same task as bb's navigation and delayed it — document switching got 0.5–1 s slower (measured, A/B).
let chosen: { ctxKey: string; doc: string } | null = null;
const chosenListeners = new Set<() => void>();

export function setChosen(next: { ctxKey: string; doc: string } | null): void {
  if (chosen === next || (chosen && next && chosen.ctxKey === next.ctxKey && chosen.doc === next.doc)) return;
  chosen = next;
  for (const listener of chosenListeners) listener();
}

/** The chosen document of this checkout, else `fallback` (the routed one). */
export function useChosen(ctxKey: string, fallback: string | null): string | null {
  const value = useSyncExternalStore((listener) => { chosenListeners.add(listener); return () => chosenListeners.delete(listener); }, () => chosen, () => null);
  return value && value.ctxKey === ctxKey ? value.doc : fallback;
}

export function getUi(): UiState {
  return state;
}

// ── optimistic overlays (W-06b, EP-033): a mark is shown at once over what the host sent ─────────────────────
// The store keeps the host's view and tree as they came; what the screen shows is them with every pending overlay
// applied (one per write key). A reload during the write never brings the old state back, a failed write removes its
// overlay and the host's state shows again (D14), a successful one is removed once the view read after it arrived.

/** A pending optimistic change of the view and/or the tree. */
export type Overlay = { view?: (view: DocumentView) => DocumentView; tree?: (tree: TreeInfo) => TreeInfo };
const overlays = new Map<string, Overlay>();
type Raw = Pick<UiState, "view" | "pendingView" | "tree">;
const raw: Raw = { view: null, pendingView: null, tree: null };
const presented = new Map<keyof Raw, { from: unknown; version: number; value: unknown }>();
let overlayVersion = 0;

function present<K extends keyof Raw>(key: K, value: Raw[K]): Raw[K] {
  if (!value || !overlays.size) return value;
  const cached = presented.get(key);
  if (cached && cached.from === value && cached.version === overlayVersion) return cached.value as Raw[K];
  let result: unknown = value;
  for (const overlay of overlays.values()) {
    if (key === "tree") { if (overlay.tree) result = overlay.tree(result as TreeInfo); }
    else if (overlay.view) result = overlay.view(result as DocumentView);
  }
  presented.set(key, { from: value, version: overlayVersion, value: result });
  return result as Raw[K];
}

/** The host's state without optimistic overlays (the base a reload compares with). */
export function rawUi(): Readonly<Raw> {
  return raw;
}

/** Put (or with `null` remove) the overlay of a write and show the result at once. */
export function setOverlay(key: string, overlay: Overlay | null): void {
  if (overlay) overlays.set(key, overlay);
  else if (!overlays.delete(key)) return;
  overlayVersion++;
  setUi({ view: raw.view, pendingView: raw.pendingView, tree: raw.tree });
}

export function hasOverlay(key: string): boolean {
  return overlays.has(key);
}

export function setUi(patch: Partial<UiState> | ((current: UiState) => Partial<UiState>)): void {
  const next = { ...(typeof patch === "function" ? patch(state) : patch) };
  for (const key of ["view", "pendingView", "tree"] as const) {
    if (!(key in next)) continue;
    raw[key] = next[key] as never;
    next[key] = present(key, next[key] as never) as never;
  }
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUi<T>(selector: (current: UiState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(initial));
}

let sink: (notice: Notice) => void = () => {};

/** The toast renderer: the app binds the host's sonner (ui/toast.ts); without it (tests) notices are dropped. */
export function setNotifySink(next: (notice: Notice) => void): void {
  sink = next;
}

export function notify(text: string, options: { tone?: "info" | "error"; undo?: () => Promise<void>; actionLabel?: string; ms?: number; id?: string } = {}): void {
  sink({ text, tone: options.tone ?? "info", undo: options.undo, actionLabel: options.actionLabel, ms: options.ms ?? (options.undo ? 9000 : options.tone === "error" ? Infinity : 5000), id: options.id });
}

// ── drafts (B8, DR-03): typed but unsaved text, kept in the client, never in the repository ───────────

export type DraftTarget =
  | { kind: "text"; range: { start: number; end: number }; quote: string }
  | { kind: "block" | "section" | "change"; block: number; quote: string; element?: { id: string; kind: "node" | "edge" | "group" | "text" | "other"; label: string; range?: { line: number; start: number; end: number } } }
  | { kind: "change"; tombstoneId: string; quote: string }
  | { kind: "document"; quote: string }
  | { kind: "reply"; annotationId: string; quote: string };

export interface Draft {
  key: string;
  ctxKey: string;
  doc: string;
  target: DraftTarget;
  text: string;
  noteKind: "action" | "note";
  /** The shown revision the target refers to (sha of the observation the host served). */
  sha: string;
  head: string | null;
  branch: string | null;
  updatedAt: number;
  status: "draft" | "saving" | "error";
  error?: string;
}

const PREFIX = "document-review:draft:";

export function draftKey(ctxKey: string, doc: string, target: DraftTarget): string {
  const part = target.kind === "text" ? `t${target.range.start}-${target.range.end}` : target.kind === "reply" ? `r${target.annotationId}`
    : "tombstoneId" in target ? `x${target.tombstoneId}` : target.kind === "document" ? "d" : `${target.kind[0]}${target.block}`;
  return `${PREFIX}${ctxKey}|${doc}|${part}`;
}

export function saveDraft(draft: Draft): void {
  try {
    localStorage.setItem(draft.key, JSON.stringify({ ...draft, updatedAt: Date.now() }));
  } catch {
    // Storage full or disabled: the draft lives only in memory (allowed loss, DR-03).
  }
}

export function dropDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function draftsOf(ctxKey: string, doc: string): Draft[] {
  const found: Draft[] = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(`${PREFIX}${ctxKey}|${doc}|`)) continue;
      const value = JSON.parse(localStorage.getItem(key) ?? "null") as Draft | null;
      if (value && typeof value.text === "string" && value.text.trim()) found.push(value);
    }
  } catch {
    // ignore
  }
  return found.sort((a, b) => b.updatedAt - a.updatedAt);
}

const LAST = "document-review:last";

/** The last context and document (I5: the counter follows the last selected checkout). */
export function rememberLast(subPath: string, label: string): void {
  try {
    localStorage.setItem(LAST, JSON.stringify({ subPath, label, at: Date.now() }));
  } catch {
    // ignore
  }
}

export function lastContext(): { subPath: string; label: string } | null {
  try {
    return JSON.parse(localStorage.getItem(LAST) ?? "null");
  } catch {
    return null;
  }
}

// ── per-context memory (A9, EP-011-T05): recent checkouts, last document and reading position per checkout ──

const RECENT = "document-review:recent";
const PLACE = "document-review:place:";

export function recentContexts(): { subPath: string; label: string; at: number }[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT) ?? "[]");
    return Array.isArray(value) ? value.filter((entry) => typeof entry?.subPath === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function rememberRecent(subPath: string, label: string): void {
  try {
    const list = recentContexts().filter((entry) => entry.subPath !== subPath);
    localStorage.setItem(RECENT, JSON.stringify([{ subPath, label, at: Date.now() }, ...list].slice(0, 8)));
  } catch {
    // ignore
  }
}

/** Last document and the block at the top of the screen in one checkout. */
/** A reading position: the first visible block (lineage, and its index for the fast path without lineages) and its offset. */
export type Place = { lineage: string; index?: number; offset: number };

export function placeOf(ctxKey: string): { doc: string | null; positions: Record<string, Place> } {
  try {
    const value = JSON.parse(localStorage.getItem(PLACE + ctxKey) ?? "null");
    if (value && typeof value === "object") return { doc: typeof value.doc === "string" ? value.doc : null, positions: value.positions && typeof value.positions === "object" ? value.positions : {} };
  } catch {
    // ignore
  }
  return { doc: null, positions: {} };
}

export function rememberPlace(ctxKey: string, doc: string, position?: Place): void {
  try {
    const current = placeOf(ctxKey);
    const positions = { ...current.positions };
    if (position) positions[doc] = position;
    const keys = Object.keys(positions);
    if (keys.length > 50) delete positions[keys[0]];
    localStorage.setItem(PLACE + ctxKey, JSON.stringify({ doc, positions }));
  } catch {
    // ignore
  }
}

/** Roots chosen for reading in a checkout without review (A1: docs/ is missing, nothing is created). */
export function readingRoots(ctxKey: string): string[] | null {
  try {
    const value = JSON.parse(localStorage.getItem(`document-review:roots:${ctxKey}`) ?? "null");
    return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
  } catch {
    return null;
  }
}

export function chooseReadingRoots(ctxKey: string, roots: string[] | null): void {
  try {
    if (roots) localStorage.setItem(`document-review:roots:${ctxKey}`, JSON.stringify(roots));
    else localStorage.removeItem(`document-review:roots:${ctxKey}`);
  } catch {
    // ignore
  }
}
