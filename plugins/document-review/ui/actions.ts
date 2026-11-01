// Client actions: every request carries the explicit checkout target; responses of an older context or document
// are dropped by a generation token (EP-008-T01); a newer revision waits while the user selects or types (F9).
import { rememberMeta, type SourceInfo } from "./source.ts";
import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import { applyOverlay, decodeBlocks, headingStack, type PlainBlock } from "../core/wire.ts";
import { createLatest, createOptimistic } from "../feedback.ts";
import type { CompactView, DocumentView, TextView, ViewBlock } from "../node/view.ts";
import type { rpcContract } from "../server.ts";
import { contextKey, type Route, targetOf } from "./route.ts";
import { forms, lang, tr } from "../core/i18n.ts";
import { VERB, W, counted, plural } from "./words.ts";
import { acceptOverlay, conflictPatch, decisionPatch, patchAnnotation, type ReadTarget, readAllOverlay, readOverlay, ruleOverlay, unreadAllOverlay, unreadOverlay } from "./optimistic.ts";
import { type BatchInfo, type ErrorInfo, getUi, notify, type Overlay, rawUi, readingRoots, setChosen, setOverlay, setUi, type TreeInfo } from "./store.ts";

export type Rpc = PluginRpcClient<typeof rpcContract>;
type Reply<T> = { ok: true; result?: T; machine?: { hostId: string; name: string }; [key: string]: unknown } | { ok: false; error: ErrorInfo };

let rpcRef: Rpc | null = null;
let generation = 0;
let enableHandler: ((reason: string) => void) | null = null;

export function bindRpc(rpc: Rpc): void {
  rpcRef = rpc;
  // The server writes to agents and threads in the window's language (EP-126).
  void invoke("review.lang", { lang: lang() });
}

export function onEnableNeeded(handler: ((reason: string) => void) | null): void {
  enableHandler = handler;
}

/** Ask the screen to show the enable dialog (A10); without the screen, open it first. */
export function requestEnable(reason: string): void {
  if (enableHandler) enableHandler(reason);
  else notify(tr("Open “Documents” to enable review in this checkout.", "Откройте «Документы», чтобы включить обзор в этой рабочей копии."));
}

async function invoke<T = unknown>(method: string, input: Record<string, unknown>): Promise<Reply<T>> {
  if (!rpcRef) return { ok: false, error: { code: "no-rpc", message: "plugin is not ready" } };
  try {
    return await (rpcRef.call as unknown as (method: string, input: unknown) => Promise<Reply<T>>)(method, input);
  } catch (error) {
    return { ok: false, error: { code: "transport", message: error instanceof Error ? error.message : String(error) } };
  }
}

const MESSAGES: Record<string, string> = {
  "host-unavailable": tr("The machine of this checkout is unreachable: no connection. Another machine is not used instead.", "Машина рабочей копии недоступна — нет связи; другая машина не подставляется."),
  "context-changed": tr("The checkout or branch changed after it was shown: the action was not saved in this branch. Refresh the document.", "Рабочая копия или ветка сменились после показа: действие не сохранено в этой ветке. Обновите документ."),
  "stale": tr("The comment changed after it was shown (a new message or result). Look at it again.", "Замечание изменилось после показа (новое сообщение или результат). Посмотрите его снова."),
  "no-identity": tr("Git of this checkout has no user.email: you can read but not write.", "В Git этой рабочей копии не задан user.email: читать можно, писать нельзя."),
  "read-only": tr("Review data is open read-only.", "Данные обзора открыты только для чтения."),
  "not-enabled": tr("Review is not enabled in this checkout.", "Обзор в этой рабочей копии не включён."),
  "outside-roots": tr("The document is outside the review roots: comments and read marks on it are not saved.", "Документ вне корней обзора: замечания и отметки к нему не сохраняются."),
  "busy": tr("The previous batch of this checkout is not finished yet. New instructions will wait for it (DR-01).", "Предыдущий пакет этой рабочей копии ещё не завершён — новые инструкции подождут его (DR-01)."),
  "nothing-to-send": tr("No comments with new instructions here.", "Нет замечаний с новыми инструкциями в этой области."),
  "foreign-checkout": tr("This thread works in another checkout: “To the current thread” is unavailable.", "Этот тред работает в другой рабочей копии — «В текущий» недоступно."),
  "unverifiable": tr("The shown revision can't be verified on the machine: open the document again.", "Показанную редакцию нельзя проверить на машине: откройте документ заново."),
  "not-markdown": tr("The viewer doesn't support this format (only .md and .markdown; MDX is not executed): the file is visible, comments on it are unavailable.", "Формат не поддерживается просмотрщиком (только .md и .markdown; MDX не исполняется): файл виден, замечания к нему недоступны."),
  "too-large": tr("The document is larger than 8 MiB: viewing and comments are unavailable.", "Документ больше 8 МиБ: просмотр и замечания недоступны."),
  "not-found": tr("The document is not in this checkout (deleted or renamed).", "Документа нет в этой рабочей копии (удалён или переименован)."),
  "already-delivered": tr("The agent already received the batch, so it can't be undone. Close the comments or turn them into notes.", "Агент уже получил пакет — отменить нельзя; закройте замечания или переведите в заметки."),
};

export function explain(error: ErrorInfo): string {
  if (/host not found/i.test(error.message)) return tr("The machine of this checkout is not found in bb. Another machine is not used instead. Choose the checkout again.", "Машина этой рабочей копии не найдена в bb — другая машина не подставляется. Выберите рабочую копию заново.");
  return MESSAGES[error.code] ? `${MESSAGES[error.code]}${error.code === "stale" || error.code === "busy" ? "" : ""}` : error.message;
}

/** The reason of a failure after «Failed …:» (lower case, without the final full stop). */
export function reason(error: ErrorInfo): string {
  const text = explain(error).replace(/\.$/, "");
  return text ? text[0].toLowerCase() + text.slice(1) : error.code;
}

/** «Failed <verb>: <reason>» / “Couldn't <verb>: <reason>” (the verb may come capitalized from a button). */
export function couldNot(verb: string, why: string): string {
  return tr(`Couldn't ${verb ? verb[0].toLowerCase() + verb.slice(1) : verb}: ${why}`, `Не удалось ${verb}: ${why}`);
}

const ENABLE_TO_SAVE = tr("To save comments and read marks, enable review in this checkout.", "Чтобы сохранять замечания и отметки, включите обзор в этой рабочей копии.");
const ENABLE_TO_LAYOUT = tr("To save diagram layouts, enable review in this checkout.", "Чтобы сохранять раскладку схем, включите обзор в этой рабочей копии.");
const RETRY = tr("Retry", "Повторить");
const NO_CHECKOUT = tr("no checkout selected", "рабочая копия не выбрана");
const UNDO_MARK = tr("undo the mark", "отменить отметку");
const NODE = forms(["node", "nodes"], ["узел", "узла", "узлов"]);

function fail(error: ErrorInfo, retry?: () => void, verb?: string): void {
  if (error.code === "not-enabled" && enableHandler) {
    enableHandler(ENABLE_TO_SAVE);
    return;
  }
  // W-06b: a command that failed offers «Retry» in its toast (the button is available again at once).
  const text = verb ? couldNot(verb, reason(error)) : explain(error);
  notify(text, retry ? { tone: "error", actionLabel: RETRY, undo: async () => retry() } : { tone: "error", ms: 8000 });
}

export async function openContext(route: Route): Promise<void> {
  const target = targetOf(route);
  const key = contextKey(route);
  const changed = getUi().ctxKey !== key;
  if (changed) forgetDocuments();
  setUi({ route, target, ctxKey: key, ...(changed ? { view: null, viewError: null, pendingView: null, viewPhase: "full", textInfo: null, batch: null, batchError: null, docs: null, tree: null, treeError: null, passKey: null, focusAnnotation: null } : {}) });
  if (!target) return;
  if (changed) {
    void invoke("review.watch", { target });
    void invoke<{ baseUrl: string }>("review.preview", { target }).then((reply) => {
      if (reply.ok && getUi().ctxKey === key) setUi({ previewBase: (reply as unknown as { baseUrl: string }).baseUrl });
    });
  }
  // The tree first and quick (rows at once, unread counts that miss the budget follow), then the batch.
  await Promise.all([loadTree({ quick: true }), loadBatch()]);
}

/** Choosing a document in the same checkout updates selection and header immediately, ahead of bb navigation. Only small subscribers render the pending selection; the main store stays unchanged. */
export function chooseDocument(next: Route): void {
  if (next.kind !== "none" && next.doc && contextKey(next) === getUi().ctxKey) setChosen({ ctxKey: contextKey(next), doc: next.doc });
}

/** Tree of the roots (EP-011): unambiguous renames are applied by the host and announced here. */
/** W-06b: a tree answer is applied only if no later tree request started (a refresh begun before a write never wins). */
const treeRequests = createLatest();

export async function loadTree(options: { quick?: boolean } = {}): Promise<void> {
  const { target, ctxKey } = getUi();
  if (!target) return;
  const roots = readingRoots(ctxKey);
  const token = treeRequests.begin();
  performance.mark("dr:tree:start");
  // quick (W-06a): a small budget for unread counts — the rows show at once, documents not counted yet say «changed»
  // and a second request with the full budget fills their numbers.
  const reply = await invoke<TreeInfo>("review.tree", { target, ...(roots ? { roots } : {}), ...(options.quick ? { budgetMs: 100 } : {}) });
  performance.measure(options.quick ? "dr:tree" : "dr:tree:full", "dr:tree:start");
  if (getUi().ctxKey !== ctxKey || !treeRequests.isCurrent(token)) return;
  if (!reply.ok) {
    setUi({ treeError: reply.error });
    return;
  }
  const result = (reply as unknown as { result: TreeInfo; machine: TreeInfo["machine"]; root: string });
  if (!result.result?.entries) return;
  const tree = { ...result.result, machine: result.machine, root: result.root };
  for (const move of tree.moves.applied) notify(tr(`Rename detected: ${move.from} → ${move.to}. Comments and read marks moved along`, `Распознано переименование ${move.from} → ${move.to}: замечания и прочитанное перенесены`), { ms: 8000 });
  setUi({ tree, treeError: null });
  if (options.quick && tree.pending > 0) void loadTree();
}

/** «Hide / Show», «Untracked / Track» (A5–A7): the tree changes at once (W-06b, optimistic). */
export function setRule(input: { list: "hidden" | "untracked"; path: string; isDir: boolean; action: "add" | "remove" }): Promise<unknown> {
  const tree = getUi().tree;
  const what = input.list === "hidden" ? (input.action === "add" ? tr("Hidden", "Скрыто") : tr("Shown", "Показано")) : input.action === "add" ? tr("Tracking off", "Отслеживание выключено") : tr("Tracking on", "Отслеживание включено");
  return startMark<{ status: string; merged: boolean; resumed: number }>({
    key: `rule:${input.list}:${input.path}`, verb: input.list === "hidden" ? (input.action === "add" ? tr("hide", "скрыть") : tr("show", "показать")) : input.action === "add" ? tr("turn tracking off", "выключить отслеживание") : tr("turn tracking on", "включить отслеживание"),
    overlay: ruleOverlay(input), method: "review.rule", input: { ...input, configSha: tree?.configSha ?? null }, withContext: false,
    notice: { text: `${what}: ${input.path}`, undo: () => { void setRule({ ...input, action: input.action === "add" ? "remove" : "add" }); } },
    done: (result) => {
      const resumed = input.list === "untracked" && input.action === "remove" && result.resumed
        ? tr(`The current revision ${result.resumed === 1 ? "became the new base" : `of ${counted(result.resumed, W.document)} became the new base`}, the paused period is marked “not tracked”`, `Текущая редакция ${result.resumed === 1 ? "стала новой базой" : `${result.resumed} документов стала новой базой`}, период паузы помечен «не отслеживался»`) : "";
      if (resumed || result.merged) notify([resumed, result.merged ? tr("config.json changed meanwhile: reread, the rule is applied to the new version", "config.json изменился параллельно — перечитан, правило применено к новой версии") : ""].filter(Boolean).join(". "));
    },
  });
}

/** “Track locally” / «Stop tracking locally» (EP-048, §9): a file or folder outside Git; data stay on switching off. */
export async function trackLocal(path: string, isDir: boolean, action: "add" | "remove"): Promise<boolean> {
  const done = await mutate<{ registered: number }>("review.local.track", { path, isDir, action }, { verb: action === "add" ? tr("track locally", "Отслеживать локально") : tr("stop tracking", "Не отслеживать") });
  if (!done) return false;
  notify(action === "add"
    ? tr(`Tracked locally: ${path}${isDir ? ", new files outside Git in the folder too" : ""}. Review data stays on this machine only`, `Отслеживается локально: ${path}${isDir ? " — новые файлы вне Git в папке тоже" : ""}. Данные обзора — только на этой машине`)
    : tr(`No longer tracked locally: ${path}. Saved data stays`, `Не отслеживается локально: ${path}. Сохранённые данные остаются`));
  void loadTree({ quick: true });
  return true;
}

/** Forget file displays an undo toast after confirmation. Remove the data only after the toast expires without Undo. */
export function forgetLocal(path: string): void {
  let cancelled = false;
  const ms = 9000;
  notify(tr(`Forgotten: ${path}`, `Забыто: ${path}`), { undo: async () => { cancelled = true; notify(tr(`Data of ${path} kept`, `Данные ${path} сохранены`)); }, ms });
  setTimeout(() => {
    if (cancelled) return;
    void mutate("review.local.forget", { path }, { verb: tr("forget", "Забыть") }).then(() => loadTree({ quick: true }));
  }, ms + 300);
}

/** Answer a rename proposal or acknowledge a deletion (AC08). */
export async function resolveMove(docId: string, to: string | null): Promise<boolean> {
  const result = await mutate<{ status: string; receiptId?: string | null }>("review.move", { docId, to }, { withContext: false });
  if (!result) return false;
  if (to) notify(tr(`Document moved to ${to} with its history`, `Документ перенесён в ${to} вместе с историей`));
  // The deletion is acknowledged by this reader (EP-014-T05); «Undo» revokes exactly that receipt.
  else notify(tr("Deletion marked read", "Удаление отмечено прочитанным"), result.receiptId ? { undo: async () => { await mutate("review.revoke", { receiptId: result.receiptId }, { withContext: false }); } } : {});
  return true;
}

/**
 * Several rename proposals at once («Review», W-19): one call, each answer on its own. The notice says how many
 * moved and were marked removed; «Undo» revokes the removal receipts (moves stay — a move is undone by moving back).
 */
export async function resolveMoves(items: { docId: string; to: string | null }[]): Promise<{ moved: number; removed: number; failed: { docId: string; error: string }[] } | null> {
  if (!items.length) return { moved: 0, removed: 0, failed: [] };
  const result = await mutate<{ results: { docId: string; to: string | null; status: string; receiptId?: string | null; error?: string }[] }>("review.moves", { items }, { withContext: false, verb: tr("sort out missing files", "разобрать пропавшие файлы") });
  if (!result) return null;
  const moved = result.results.filter((item) => item.status === "moved").length;
  const removed = result.results.filter((item) => item.to === null && item.status !== "failed").length;
  const failed = result.results.filter((item) => item.status === "failed").map((item) => ({ docId: item.docId, error: item.error ?? tr("error", "ошибка") }));
  const receipts = result.results.map((item) => item.receiptId).filter((id): id is string => !!id);
  const parts = [moved ? tr(`${moved} moved`, `перенесено ${moved}`) : "", removed ? tr(`${removed} marked deleted`, `отмечено удалёнными ${removed}`) : "", failed.length ? tr(`${failed.length} failed`, `не удалось ${failed.length}`) : ""].filter(Boolean);
  notify(tr(`Missing files: ${parts.join(", ") || "no changes"}`, `Пропавшие файлы: ${parts.join(", ") || "без изменений"}`), {
    tone: failed.length ? "error" : "info",
    ...(receipts.length ? { undo: async () => { await mutate("review.revokeMany", { receiptIds: receipts }, { withContext: false }); } } : {}),
  });
  return { moved, removed, failed };
}

/**
 * «Accept current state» (a new reader, F1/AC17) and «All read» of the checkout (F7): one receipt per document
 * with unread changes; the notice offers to undo it as a whole (revokes exactly these receipts).
 */
export async function acknowledgeAll(newReader: boolean): Promise<void> {
  // W-06b: the rows are read at once; the operation may take minutes, so its button stays a command until the result.
  const viewBefore = getUi().view;
  const treeBefore = getUi().tree;
  const result = await startMark<{ documents: number; receipts: string[] }>({
    key: "read-all", verb: newReader ? tr("accept the current state", "принять текущее состояние") : tr("mark everything read", "отметить всё прочитанным"), overlay: readAllOverlay(),
    method: "review.acknowledgeAll", input: {}, withContext: false,
  });
  if (!result) return;
  if (!result.documents) {
    notify(tr("Nothing unread", "Непрочитанного нет"));
    return;
  }
  notify(`${newReader ? tr("Current state accepted", "Текущее состояние принято") : VERB.readAll.toast}: ${counted(result.documents, W.document)}`, {
    undo: async () => { await startMark({ key: "unread-all", verb: UNDO_MARK, overlay: unreadAllOverlay(viewBefore, treeBefore), method: "review.revokeMany", input: { receiptIds: result.receipts }, withContext: false }); },
  });
}

// ── optimistic marks (W-06b, EP-033; D14) ────────────────────────────────────────────────────────────────────

/** One optimistic write: what it shows at once, how it is written, what the toast says. */
export interface Mark<R = Record<string, unknown>> {
  /** One write per key: a second press while it is written sends nothing. */
  key: string;
  /** Format a failure message from the attempted action and its reason. */
  verb: string;
  overlay: Overlay;
  method: string;
  input: Record<string, unknown>;
  withContext?: boolean;
  /** The toast at once; its «Undo» waits for the write and gets its result. */
  notice?: { text: string; undo?: (result: R) => void | Promise<void>; actionLabel?: string };
  /** After the write landed. */
  done?: (result: R) => void;
  /** A failure the caller explains itself (true: handled, no generic toast). */
  failed?: (error: ErrorInfo, retry: () => void) => boolean;
}

class WriteError extends Error {
  readonly info: ErrorInfo;
  constructor(info: ErrorInfo) { super(info.message); this.info = info; }
}

type Wish = { mark: Mark<any>; context: Record<string, unknown>; settle: (result: unknown) => void }; // eslint-disable-line @typescript-eslint/no-explicit-any

// Writes go one after another (the order of the clicks); after the last one the view and the tree are read once and
// the overlays of every landed write are removed — earlier, the host's previous state would flash back.
let writeQueue: Promise<unknown> = Promise.resolve();
let queued = 0;
const landed = new Set<string>();

async function settleWrites(): Promise<void> {
  if (!landed.size) return;
  const keys = [...landed];
  landed.clear();
  const doc = shownDoc();
  if (doc) await loadView(doc, { quiet: true });
  void loadBatch();
  await loadTree();
  for (const key of keys) setOverlay(key, null);
  settleRefresh();
}

const marks = createOptimistic<string, Wish | null>(async (key, wish) => {
  if (!wish) return;
  queued++;
  const turn = writeQueue.then(() => {
    const { target } = getUi();
    return target ? invoke(wish.mark.method, { target, ...wish.mark.input, ...wish.context }) : { ok: false as const, error: { code: "no-target", message: NO_CHECKOUT } };
  });
  writeQueue = turn.catch(() => undefined);
  let reply: Reply<unknown>;
  try { reply = await turn; } finally { queued--; }
  if (!reply.ok) {
    wish.settle(null);
    if (!queued) await settleWrites();
    throw new WriteError(reply.error);
  }
  const result = (reply as unknown as { result?: unknown }).result ?? reply;
  landed.add(key);
  wish.settle(result);
  wish.mark.done?.(result);
  if (!queued) await settleWrites();
}, {
  show: (key, wish) => setOverlay(key, wish && wish !== marks.confirmed(key) ? wish.mark.overlay : null),
  onError: (key, error) => {
    const info = error instanceof WriteError ? error.info : { code: "transport", message: error instanceof Error ? error.message : String(error) };
    const mark = wishes.get(key)?.mark;
    if (!mark) return;
    const retry = () => { void startMark(mark); };
    if (info.code === "not-enabled" && enableHandler) { enableHandler(ENABLE_TO_SAVE); return; }
    if (mark.failed?.(info, retry)) return;
    // D14: the mark is back as it was; the toast says why and offers to try again (it replaces the «Undo» one).
    notify(couldNot(mark.verb, reason(info)), { tone: "error", actionLabel: RETRY, undo: async () => retry(), id: key });
  },
});
const wishes = new Map<string, Wish>();

/** Is a write of this key on its way (its control may show that it is being saved)? */
export function markPending(key: string): boolean {
  return marks.pending(key);
}

/**
 * Show a mark at once and write it in the background (D14). Resolves with the host's result, or null when it failed
 * (rolled back and told) or when the same write is already on its way (nothing is sent twice).
 */
export function startMark<R>(mark: Mark<R>): Promise<R | null> {
  if (marks.pending(mark.key)) return Promise.resolve(null);
  let settle: (result: unknown) => void = () => {};
  const result = new Promise<R | null>((resolve) => { settle = resolve as (result: unknown) => void; });
  const wish: Wish = { mark, context: mark.withContext === false ? {} : expect(), settle };
  wishes.set(mark.key, wish);
  if (mark.notice) {
    const { text, undo, actionLabel } = mark.notice;
    notify(text, { id: mark.key, actionLabel, undo: undo ? async () => { const done = await result; if (done) await undo(done); } : undefined });
  }
  void marks.apply(mark.key, wish, null);
  return result;
}

/** «Mark read» of blocks, a section, removed blocks or the whole document; «Undo» revokes exactly that receipt. */
export function readMark(view: import("../node/view.ts").DocumentView, target: ReadTarget): Promise<{ receiptId: string; staleBlocks: number } | null> {
  const { overlay, set } = readOverlay(view, target);
  const treeBefore = getUi().tree;
  const path = view.document.path;
  const what = target.scope === "document" ? VERB.readDoc.toast : target.scope === "section" ? VERB.readSection.toast : VERB.read.toast;
  const key = `read:${path}:${target.scope === "document" ? "doc" : target.scope === "section" ? `s${target.heading}` : `${(target.blocks ?? []).join(",")}|${(target.tombstones ?? []).join(",")}`}`;
  return startMark<{ receiptId: string; staleBlocks: number }>({
    key, verb: tr("mark read", "отметить прочитанным"), overlay, method: "review.acknowledge", input: { path, observation: { sha: view.document.sha }, ...target },
    notice: { text: what, undo: (result) => { void startMark({ key: `revoke:${result.receiptId}`, verb: UNDO_MARK, overlay: unreadOverlay(view, set, treeBefore), method: "review.revoke", input: { receiptId: result.receiptId } }); } },
    done: (result) => { if (result.staleBlocks) notify(tr(`${counted(result.staleBlocks, W.block)} changed after they were shown and stay unread.`, `${counted(result.staleBlocks, W.block)} обновились после показа и остаются непрочитанными.`)); },
  });
}

// ── personal diagram layouts (W-06f, EP-060-T05) ──────────────────────────────────────────────────────────────
// A finished gesture is shown at once (an overlay over view.layouts) and written in the background; gestures made
// while a write is on its way are merged and sent next — none is dropped. A failed write is rolled back (D14, the
// spike contract) and the block reports that saving failed. Retry displays and writes it again; a new gesture
// instead means the reader moved on — the failed one is dropped.

type Pin = { x: number; y: number };
type LayoutChange = { pins: Record<string, Pin>; unpin: string[]; engine?: string };
type LayoutSlot = { path: string; lineage: string; inflight: LayoutChange | null; queued: LayoutChange | null; failed: LayoutChange | null; error: string | null };
const layoutSlots = new Map<string, LayoutSlot>();
const layoutKeyOf = (path: string, lineage: string) => `layout:${path}\n${lineage}`;

function mergeLayout(base: LayoutChange | null, next: LayoutChange | null): LayoutChange | null {
  if (!base) return next;
  if (!next) return base;
  const pins = { ...base.pins, ...next.pins };
  for (const id of next.unpin) delete pins[id];
  const unpin = [...new Set([...base.unpin.filter((id) => !(id in next.pins)), ...next.unpin])];
  return { pins, unpin, engine: next.engine ?? base.engine };
}

function showLayout(key: string): void {
  const slot = layoutSlots.get(key);
  const change = slot ? mergeLayout(slot.inflight, slot.queued) : null;
  if (!slot || (!change && !slot.error)) { setOverlay(key, null); return; }
  setOverlay(key, { view: (view) => {
    if (view.document.path !== slot.path) return view;
    const index = view.blocks.findIndex((block) => block.lineageId === slot.lineage);
    if (index < 0) return view;
    const entry = view.layouts.find((layout) => layout.block === index) ?? { block: index, pins: {}, conflicts: [], readOnly: null, previous: { kind: "none" as const, reason: "no-history" as const } };
    const pins = { ...entry.pins, ...change?.pins };
    for (const id of change?.unpin ?? []) delete pins[id];
    const touched = new Set([...Object.keys(change?.pins ?? {}), ...(change?.unpin ?? [])]);
    const patched = { ...entry, pins, conflicts: entry.conflicts.filter((conflict) => !touched.has(conflict.node)) };
    return { ...view, layouts: [...view.layouts.filter((layout) => layout.block !== index), patched] };
  } });
}

/** Saving state of a diagram layout: saving or failed with Retry. */
export function layoutStatus(path: string, lineage: string): { saving: boolean; error: string | null } {
  const slot = layoutSlots.get(layoutKeyOf(path, lineage));
  return { saving: Boolean(slot?.inflight || slot?.queued), error: slot?.error ?? null };
}

async function flushLayout(key: string): Promise<void> {
  const slot = layoutSlots.get(key);
  if (!slot || slot.inflight || !slot.queued) return;
  slot.inflight = slot.queued;
  slot.queued = null;
  showLayout(key);
  const change = slot.inflight;
  const turn = writeQueue.then(() => {
    const { target, view } = getUi();
    const index = view && view.document.path === slot.path ? view.blocks.findIndex((block) => block.lineageId === slot.lineage) : -1;
    if (!target) return { ok: false as const, error: { code: "no-target", message: NO_CHECKOUT } };
    if (index < 0) return { ok: false as const, error: { code: "context-changed", message: tr("the diagram block is no longer shown", "блок схемы больше не показан") } };
    return invoke("review.layout", { target, path: slot.path, observation: { sha: view!.document.sha }, block: index,
      pins: Object.entries(change.pins).map(([id, pin]) => ({ id, x: pin.x, y: pin.y })), unpin: change.unpin, engine: change.engine, ...expect() });
  });
  writeQueue = turn.catch(() => undefined);
  let reply: Reply<unknown>;
  try { reply = await turn; } catch (error) { reply = { ok: false, error: { code: "transport", message: error instanceof Error ? error.message : String(error) } }; }
  slot.inflight = null;
  if (!reply.ok) {
    if (reply.error.code === "not-enabled" && enableHandler) enableHandler(ENABLE_TO_LAYOUT);
    // Everything not yet written is rolled back together; «Retry» sends it as one write.
    slot.failed = mergeLayout(mergeLayout(slot.failed, change), slot.queued);
    slot.queued = null;
    slot.error = reason(reply.error);
    showLayout(key);
    return;
  }
  if (slot.queued) { void flushLayout(key); return; }
  // The view read after the write carries the stored pins; only then the overlay goes (no jump back).
  const doc = shownDoc();
  if (doc) await loadView(doc, { quiet: true });
  if (!slot.inflight && !slot.queued && !slot.failed) { layoutSlots.delete(key); setOverlay(key, null); }
}

/** A finished gesture in «Layout»: pins (moved nodes) and/or unpins (reset to the automatic layout). */
export function commitLayout(view: DocumentView, lineage: string, pins: Record<string, Pin>, unpin: string[] = [], engine?: string): void {
  if (!view.context.enabled) { requestEnable(ENABLE_TO_LAYOUT); return; }
  const key = layoutKeyOf(view.document.path, lineage);
  const slot = layoutSlots.get(key) ?? { path: view.document.path, lineage, inflight: null, queued: null, failed: null, error: null };
  layoutSlots.set(key, slot);
  const rounded = Object.fromEntries(Object.entries(pins).map(([id, pin]) => [id, { x: Math.round(pin.x), y: Math.round(pin.y) }]));
  slot.queued = mergeLayout(slot.queued, { pins: rounded, unpin, engine });
  slot.failed = null;
  slot.error = null;
  // «Reset»: the toast's «Undo» pins the nodes back where they stood (a new causal write, not a rewrite).
  const index = view.blocks.findIndex((block) => block.lineageId === lineage);
  const shown = view.layouts.find((layout) => layout.block === index)?.pins ?? {};
  const restore = Object.fromEntries(unpin.filter((id) => shown[id]).map((id) => [id, shown[id]]));
  if (Object.keys(restore).length) {
    notify(tr(`Diagram layout reset: ${counted(Object.keys(restore).length, NODE)} back in the automatic place`, `Раскладка схемы сброшена: ${Object.keys(restore).length} ${plural(Object.keys(restore).length, NODE)} на автоматическом месте`),
      { id: key, undo: async () => commitLayout(getUi().view ?? view, lineage, restore, [], engine) });
  }
  showLayout(key);
  void flushLayout(key);
}

export function retryLayout(path: string, lineage: string): void {
  const key = layoutKeyOf(path, lineage);
  const slot = layoutSlots.get(key);
  if (!slot?.failed) return;
  slot.queued = mergeLayout(slot.failed, slot.queued);
  slot.failed = null;
  slot.error = null;
  showLayout(key);
  void flushLayout(key);
}

type Annotation = import("../node/view.ts").ViewAnnotation;

/** «Accept» (A): the annotation closes and its linked edits are read at once; a stale one is never closed (DR-04). */
export function acceptMark(view: import("../node/view.ts").DocumentView, annotation: Annotation, options: { confirmed?: boolean } = {}): Promise<{ eventId: string; receiptId: string | null; confirmed: number } | null> {
  if (!annotation.latest) return Promise.resolve(null);
  // W-06c (§10, EP-044-T02): the agent's edit left a structured file that does not parse — «Accept» asks first.
  if (view.parseError && view.format && view.format !== "markdown" && view.format !== "text" && !options.confirmed) {
    notify(tr(`The file doesn't parse after the agent's edit: line ${view.parseError.line}. Accept anyway?`, `Файл не разбирается после правки агента: строка ${view.parseError.line}. Принять всё равно?`), { id: `accept:${annotation.annotationId}`, actionLabel: VERB.accept.button, ms: 12000,
      undo: async () => { await acceptMark(view, annotation, { confirmed: true }); } });
    return Promise.resolve(null);
  }
  const linked = annotation.latest.linked.map((entry) => entry.block);
  const treeBefore = getUi().tree;
  return startMark<{ eventId: string; receiptId: string | null; confirmed: number }>({
    key: `accept:${annotation.annotationId}`, verb: tr("accept", "принять"), overlay: acceptOverlay(view, annotation), method: "review.accept",
    input: { annotationId: annotation.annotationId, expectedHeads: annotation.heads, resultEventId: annotation.latest.eventId, path: view.document.path, observation: { sha: view.document.sha }, blocks: linked },
    notice: {
      text: tr(`Accepted: comment closed${linked.length ? `, ${counted(linked.length, W.edit)} marked read` : ""}`, `Принято: замечание закрыто${linked.length ? `, ${counted(linked.length, W.edit)} ${plural(linked.length, ["отмечена", "отмечены", "отмечено"])} прочитанными` : ""}`),
      undo: (result) => {
        const restore = unreadOverlay(view, { blocks: new Set(linked), tombstones: new Set() }, treeBefore);
        void startMark<{ reopened: boolean }>({
          key: `undo-accept:${annotation.annotationId}`, verb: tr("undo “Accept”", "отменить «Принять»"),
          overlay: { view: (current) => patchAnnotation(restore.view!(current), annotation.annotationId, { status: annotation.status, waiting: annotation.waiting }), tree: restore.tree },
          method: "review.undoAccept", input: { annotationId: annotation.annotationId, acceptEventId: result.eventId, receiptId: result.receiptId },
          done: (undone) => { if (!undone.reopened) notify(tr("Read mark undone. The comment was changed later, so its decision is not overwritten.", "Отметка чтения отменена; замечание уже изменено позже — его решение не перезаписано.")); },
        });
      },
    },
    failed: (error) => {
      if (error.code !== "stale" || !linked.length) return false;
      // DR-04: a stale «Accept» never closes a newer question; offer to confirm only the shown edits.
      notify(tr("The comment changed after it was shown, so the old button doesn't close it. You can confirm the shown edits separately.", "Замечание изменилось после показа — старой кнопкой оно не закрывается. Можно отдельно подтвердить показанные правки."), { id: `accept:${annotation.annotationId}`, actionLabel: tr("Confirm edits", "Подтвердить правки"), ms: 12000, undo: async () => { void readMark(view, { scope: "block", blocks: linked }); } });
      return true;
    },
  });
}

const DECIDED: Record<string, string> = {
  withdraw: tr("Comment withdrawn", "Замечание отозвано"),
  close: tr("Comment closed and archived", "Замечание закрыто и перенесено в архив"),
  note: VERB.toNote.toast,
  action: tr("Marked “For agent”: goes in the next batch", "Переведено «Для агента» — уйдёт в следующий пакет"),
  reopen: tr("Comment reopened", "Замечание возобновлено"),
  restore: tr("Comment restored", "Замечание возвращено"),
};
const DECIDE_VERB: Record<string, string> = {
  withdraw: tr("withdraw the comment", "отозвать замечание"),
  close: tr("close the comment", "закрыть замечание"),
  note: tr("make a note", "перевести в заметки"),
  action: tr("mark “For agent”", "перевести «Для агента»"),
  reopen: tr("reopen the comment", "возобновить замечание"),
  restore: tr("restore the comment", "вернуть замечание"),
};

/** «Close», «Reopen», «Withdraw», «Restore», «Make a note», «For agent» — shown at once; close and withdraw undo. */
export function decideMark(annotation: Annotation, action: "close" | "reopen" | "withdraw" | "restore" | "note" | "action", options: { quiet?: boolean; heads?: string[] } = {}): Promise<{ eventId: string } | null> {
  const id = annotation.annotationId;
  const back = action === "withdraw" ? "restore" : action === "close" ? "reopen" : null;
  return startMark<{ eventId: string }>({
    key: `decide:${id}`, verb: DECIDE_VERB[action], overlay: { view: (view) => patchAnnotation(view, id, decisionPatch(action)) },
    method: "review.decide", input: { annotationId: id, action, expectedHeads: options.heads ?? annotation.heads },
    notice: options.quiet ? undefined : {
      text: DECIDED[action],
      undo: back ? (result) => {
        const fresh = getUi().view?.annotations.find((entry) => entry.annotationId === id);
        void decideMark(annotation, back, { quiet: true, heads: fresh?.heads ?? [result.eventId] });
      } : undefined,
    },
  });
}

/** A conflict register after a merge (status, kind, message revision) resolved by the chosen value. */
export function resolveConflictMark(annotation: Annotation, register: string, value: string): Promise<unknown> {
  return startMark({
    key: `conflict:${annotation.annotationId}:${register}`, verb: tr("resolve the conflict", "разрешить конфликт"), overlay: { view: (view) => patchAnnotation(view, annotation.annotationId, conflictPatch(register, value)) },
    method: "review.resolveConflict", input: { annotationId: annotation.annotationId, register, value },
    notice: { text: tr("Conflict resolved", "Конфликт разрешён") },
  });
}

/** Explicit answer to a branch conflict about a document (EP-014-T02): a candidate path, «keep» or «removed». */
export async function resolveDocumentConflict(docId: string, choice: string): Promise<boolean> {
  const result = await mutate<{ status: string }>("review.resolveDocumentConflict", { docId, choice }, { withContext: false });
  if (result) notify(choice === "removed" ? tr("Conflict resolved: document deleted", "Конфликт разрешён: документ удалён") : choice === "keep" ? tr("Conflict resolved: document kept", "Конфликт разрешён: документ оставлен") : tr(`Conflict resolved: document is ${choice}`, `Конфликт разрешён: документ — ${choice}`));
  return Boolean(result);
}

/** Write the three-way merge of config.json after a Git merge and mark it resolved in Git (EP-014-T02). */
export async function resolveConfigConflict(configSha: string | null): Promise<boolean> {
  const result = await mutate<{ status: string }>("review.resolveConfigConflict", { configSha }, { withContext: false });
  if (result) notify(tr("config.json merged and marked resolved in Git. Commit the merge", "config.json объединён и отмечен разрешённым в Git; закоммитьте слияние"));
  return Boolean(result);
}

export async function loadBatch(): Promise<void> {
  const { target, ctxKey, panelThreadId } = getUi();
  if (!target) return;
  const reply = await invoke<BatchInfo>("review.batch.status", { target, panelThreadId });
  if (getUi().ctxKey !== ctxKey) return;
  // W-06b: a failure is kept for the «Agent» panel (an error with «Retry» instead of an endless skeleton).
  if (reply.ok) setUi({ batch: reply as unknown as BatchInfo, batchError: null });
  else setUi({ batchError: reply.error });
}

/**
 * Load the view of a document. `force` applies it even while the user selects or types (the «Show» button);
 * otherwise a newer revision of the same document waits in pendingView (F9) and the text does not move.
 */
// ── progressive document (EP-027-T08): text first, the review state after ─────────────────────────────────
/** Blocks in the first fast-path answer: a normal document arrives whole; a large one — its first screens or the target. */
export const FIRST_BLOCKS = 400;
/** Blocks per later part of a large document (each answer stays far below the host's 8 MiB limit). */
const PART_BLOCKS = 4000;
/** Parts asked at the same time (the host answers them from one cached projection). */
const PARTS_AT_ONCE = 3;
/** Full views of this session per checkout and document (revisits show at once, then re-check); small LRU. */
const viewCache = new Map<string, DocumentView>();
/** First fast-path answers prefetched on hover/focus in the tree. */
const textCache = new Map<string, TextView>();
const textInflight = new Map<string, Promise<TextView | null>>();
/** The text of a document revision being assembled from parts (or whole): the base the full view's overlay applies to. */
type Assembly = { sha: string; size: number; total: number; headings: TextView["headings"]; lengths: number[] | null; blocks: (PlainBlock | undefined)[]; whole: Promise<PlainBlock[] | null> | null;
  /** W-06c: format, Git class, parse error and masks of the revision (from the fast path). */
  file: Pick<TextView, "format" | "fileClass" | "parseError" | "secrets"> | null };
const assemblies = new Map<string, Assembly>();
const cacheKey = (ctxKey: string, doc: string) => `${ctxKey}|${doc}`;
function remember<T>(map: Map<string, T>, key: string, value: T, size: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > size) map.delete(map.keys().next().value!);
}
export function forgetDocuments(): void {
  viewCache.clear();
  textCache.clear();
  textInflight.clear();
  assemblies.clear();
}

/** Every block of the revision is here (a loop: `every` skips the holes of a sparse array). */
function complete(assembly: Assembly): PlainBlock[] | null {
  for (let index = 0; index < assembly.total; index++) if (!assembly.blocks[index]) return null;
  return assembly.blocks as PlainBlock[];
}

const viewBlock = (block: PlainBlock): ViewBlock => ({ ...block, lineageId: "", versionId: "", read: null, change: null, diff: null, movedFrom: null, moved: false });

/** The fast path as a read-only view: plain blocks, no review state; the context of the shown checkout if known. */
function provisional(path: string, sha: string, size: number, blocks: ViewBlock[], previous: DocumentView | null, file: Assembly["file"] = null): DocumentView {
  const tree = getUi().tree;
  const context: DocumentView["context"] = previous ? { ...previous.context, writable: false } : {
    root: tree?.root ?? "", isRepo: true, head: tree?.head ?? null, branch: tree?.branch ?? null, enabled: tree?.enabled ?? false, repoId: null,
    identity: { name: null, email: null }, readerId: tree?.reader?.id ?? null, writable: false, readOnlyReason: null, roots: tree?.roots ?? [], configConflict: null,
  };
  return {
    context,
    document: { path, docId: null, sha, size, revisionId: null, ephemeral: true, tracked: false, insideRoots: true, projectionLength: 0,
      headRevisions: [], missing: false, deletionUnread: false, hidden: false, trackingResumed: null, readOnly: null, conflict: null },
    blocks, layouts: [], removed: [], annotations: [], unread: 0, lastReceipt: null, scope: previous?.document.path === path ? previous.scope : "shared", format: file?.format ?? null, fileClass: file?.fileClass ?? "git", parseError: file?.parseError ?? null, secrets: file?.secrets ?? [], computeMs: 0,
  };
}

async function fetchText(doc: string, options: { from?: number; limit?: number; around?: string | null; outline?: boolean } = {}): Promise<TextView | null> {
  const { target } = getUi();
  if (!target) return null;
  const reply = await invoke<TextView>("review.text", { target, path: doc, ...options });
  return reply.ok ? (reply as unknown as { result: TextView }).result : null;
}

/** “Raw” (W-06c): the redacted source of the shown revision with the lines of each block and the foldable ranges. */
export async function fetchSource(doc: string): Promise<SourceInfo | { error: string } | null> {
  const { target } = getUi();
  if (!target) return null;
  const reply = await invoke<TextView>("review.text", { target, path: doc, from: 0, limit: 1, outline: false, source: true });
  if (!reply.ok) return { error: explain(reply.error) };
  const text = (reply as unknown as { result: TextView }).result;
  if (typeof text.source !== "string") return { error: tr("Source text unavailable", "Исходный текст недоступен") };
  return { sha: text.sha, source: text.source, blockLines: text.blockLines ?? [], folds: text.folds ?? [] };
}

/** Prefetch the first screens of a document (hover or focus in the tree): the click then shows it at once. */
export function prefetchText(doc: string): void {
  const { ctxKey } = getUi();
  const key = cacheKey(ctxKey, doc);
  if (textCache.has(key) || viewCache.has(key) || textInflight.has(key)) return;
  const request = fetchText(doc, { limit: FIRST_BLOCKS }).then((text) => {
    textInflight.delete(key);
    if (text && getUi().ctxKey === ctxKey) remember(textCache, key, text, 24);
    return text;
  });
  textInflight.set(key, request);
}

let hoverTimer: ReturnType<typeof setTimeout> | null = null;
/** Hover or focus on a tree row: prefetch after a short pause (sweeping the pointer over the list asks nothing). */
export function hoverPrefetch(doc: string | null): void {
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = doc ? setTimeout(() => prefetchText(doc), 80) : null;
}

/** Put a fast-path answer into the assembly of its revision (a new revision starts a new assembly). */
function absorb(key: string, text: TextView): Assembly {
  let assembly = assemblies.get(key);
  if (!assembly || assembly.sha !== text.sha) {
    assembly = { sha: text.sha, size: text.size, total: text.total, headings: text.headings, lengths: text.lengths, blocks: new Array(text.total), whole: null,
      file: { format: text.format ?? null, fileClass: text.fileClass ?? "git", parseError: text.parseError ?? null, secrets: text.secrets ?? [] } };
    remember(assemblies, key, assembly, 8);
  }
  rememberMeta(getUi().ctxKey, text.path, text.sha, text.from, text.meta);
  const decoded = decodeBlocks(text.blocks, text.from, headingStack(assembly.headings, text.from));
  decoded.forEach((block) => { assembly!.blocks[block.index] = block; });
  if (text.lengths) assembly.lengths = text.lengths;
  return assembly;
}

/** The contiguous run of assembled blocks around `index` (what the viewer can render now). */
function runAround(assembly: Assembly, index: number): ViewBlock[] {
  let start = index;
  let end = index;
  while (start > 0 && assembly.blocks[start - 1]) start--;
  while (end < assembly.total && assembly.blocks[end]) end++;
  return assembly.blocks.slice(start, end).map((block) => viewBlock(block!));
}

/** The rest of a large document in parts — below the first window first, then above — each part shown as it arrives. */
function assembleWhole(doc: string, key: string, assembly: Assembly, onPart: () => void): Promise<PlainBlock[] | null> {
  if (assembly.whole) return assembly.whole;
  assembly.whole = (async () => {
    const missing: [number, number][] = [];
    const first = assembly.blocks.findIndex((block) => block !== undefined);
    let cursor = first < 0 ? 0 : first;
    while (cursor < assembly.total && assembly.blocks[cursor]) cursor++;
    for (let from = cursor; from < assembly.total; from += PART_BLOCKS) missing.push([from, Math.min(PART_BLOCKS, assembly.total - from)]);
    for (let to = first < 0 ? 0 : first; to > 0; to -= PART_BLOCKS) missing.push([Math.max(0, to - PART_BLOCKS), Math.min(PART_BLOCKS, to)]);
    // A few parts at a time, in order of need; each extends the shown run as it arrives.
    let failed = false;
    const queue = [...missing];
    const worker = async () => {
      while (queue.length && !failed) {
        const [from, limit] = queue.shift()!;
        performance.mark(`dr:part:${doc}:${from}`);
        const part = await fetchText(doc, { from, limit, outline: false });
        performance.measure(`dr:part:${doc}:${from}`, `dr:part:${doc}:${from}`);
        if (!part || part.sha !== assembly.sha) { failed = true; return; }
        absorb(key, part);
        onPart();
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARTS_AT_ONCE, missing.length) }, worker));
    if (failed) return null;
    return complete(assembly);
  })();
  return assembly.whole;
}

export async function loadView(doc: string, options: { force?: boolean; quiet?: boolean } = {}): Promise<void> {
  const { target, ctxKey } = getUi();
  if (!target) return;
  const mine = ++generation;
  const key = cacheKey(ctxKey, doc);
  const stale = () => mine !== generation || getUi().ctxKey !== ctxKey;
  const switching = getUi().view?.document.path !== doc;
  performance.mark(`dr:open:${doc}`);
  let assembly: Assembly | null = assemblies.get(key) ?? null;
  // Show the assembled text of this revision (read-only) while nothing better is on the screen.
  const show = (around: number) => {
    if (stale() || !assembly || getUi().viewPhase === "full" && getUi().view?.document.path === doc) return;
    const previous = getUi().view;
    const blocks = runAround(assembly, around);
    const partial = blocks.length < assembly.total;
    setUi({
      loading: false, viewError: null, pendingView: null, viewPhase: "text",
      view: provisional(doc, assembly.sha, assembly.size, blocks, previous && previous.context.root === (getUi().tree?.root ?? previous.context.root) ? previous : null, assembly.file),
      textInfo: partial ? { path: doc, total: assembly.total, headings: assembly.headings, lengths: assembly.lengths } : null,
    });
  };
  if (switching) {
    // At once: the last full view of this session, or prefetched first screens; nothing blank while the host works.
    const cached = viewCache.get(key);
    const prefetched = textCache.get(key);
    if (cached) setUi({ view: cached, viewPhase: "cached", textInfo: null, viewError: null, pendingView: null, loading: false });
    else if (prefetched) { assembly = absorb(key, prefetched); show(prefetched.from); }
    else if (!options.quiet) setUi({ loading: true });
    if (!cached) {
      // The fast path first; the full view is asked after it, so the host answers the text before the heavy part.
      const inflight = textInflight.get(key);
      const first = prefetched ?? (inflight ? await inflight : null) ?? await fetchText(doc, { limit: FIRST_BLOCKS, around: getUi().pendingHash });
      if (stale()) return;
      if (first) {
        assembly = absorb(key, first);
        show(first.from);
        performance.measure(`dr:text:${doc}`, `dr:open:${doc}`);
        // A large document: the rest of its text in parts first — every part extends the shown run — and only then
        // the full view: its heavy computation on the host would otherwise starve the parts (measured on the workstation).
        if (first.from > 0 || first.blocks.length < first.total) {
          await assembleWhole(doc, key, assembly, () => show(first.from));
          if (stale()) return;
        }
      }
    }
  } else if (!options.quiet) setUi({ loading: true });
  // The full view, compact: the review overlay for the text of the same snapshot (8 MiB limit, EP-027-T08).
  performance.mark(`dr:view:${doc}`);
  const reply = await invoke<CompactView>("review.view", { target, path: doc, compact: true, opened: true });
  performance.measure(`dr:view:${doc}`, `dr:view:${doc}`);
  if (stale()) return;
  if (!reply.ok) {
    const keepText = getUi().view?.document.path === doc;
    setUi({ loading: false, viewError: reply.error, ...(keepText ? {} : { view: null, viewPhase: "full", textInfo: null }) });
    return;
  }
  const compact = (reply as unknown as { result: CompactView }).result;
  performance.mark(`dr:merge:${doc}`);
  const view = await withText(doc, key, compact, (around) => show(around));
  performance.measure(`dr:merge:${doc}`, `dr:merge:${doc}`);
  if (stale()) return;
  if (!view) {
    setUi({ loading: false, viewError: { code: "context-changed", message: tr("The document changed while loading. Refresh it.", "Документ изменился во время загрузки — обновите его.") } });
    return;
  }
  remember(viewCache, key, view, 12);
  textCache.delete(key);
  const current = getUi().view;
  const sameDoc = current?.document.path === view.document.path && getUi().viewPhase === "full";
  if (sameDoc && current && current.document.sha !== view.document.sha && getUi().holding && !options.force) {
    setUi({ loading: false, pendingView: view, viewError: null });
    return;
  }
  setUi({ loading: false, view, viewPhase: "full", textInfo: null, pendingView: null, viewError: null });
  performance.measure(`dr:full:${doc}`, `dr:open:${doc}`);
}

/** The full view: the overlay applied to the text of its snapshot — assembled already, or fetched now (a changed file). */
async function withText(doc: string, key: string, compact: CompactView, show: (around: number) => void): Promise<DocumentView | null> {
  let assembly = assemblies.get(key);
  // The host's view (without optimistic overlays): its blocks are the base the new overlay applies to.
  const current = rawUi().view;
  // The shown full view of the same revision carries the text too (a refresh of an unchanged document).
  if ((!assembly || assembly.sha !== compact.overlay.sha) && current?.document.path === doc && current.document.sha === compact.overlay.sha && current.blocks.length === compact.overlay.count) {
    return { ...compact, blocks: applyOverlay(current.blocks, compact.overlay) as ViewBlock[] };
  }
  if (!assembly || assembly.sha !== compact.overlay.sha) {
    // The file changed after the fast path (or there was none): its text, whole or in parts, for that hash.
    const first = await fetchText(doc, { limit: FIRST_BLOCKS });
    if (!first || first.sha !== compact.overlay.sha) return missingText(doc, compact);
    assembly = absorb(key, first);
  }
  const blocks = complete(assembly) ?? await assembleWhole(doc, key, assembly, () => show(0));
  if (!blocks) return null;
  return { ...compact, blocks: applyOverlay(blocks, compact.overlay) as ViewBlock[] };
}

/** A document gone from disk is shown from its last revision (AC08): no fast path exists — the uncompacted view. */
async function missingText(doc: string, compact: CompactView): Promise<DocumentView | null> {
  if (!compact.document.missing) return null;
  const { target } = getUi();
  const reply = await invoke<DocumentView>("review.view", { target, path: doc });
  return reply.ok ? (reply as unknown as { result: DocumentView }).result : null;
}

/** The routed document wins over the shown one: a refresh during navigation must not bring the previous document back. */
function shownDoc(): string | null {
  const route = getUi().route;
  return (route.kind !== "none" ? route.doc : null) ?? getUi().view?.document.path ?? null;
}

// W-06b (EP-031-T01): one refresh at a time. Refreshes asked while one runs (the 15 s poll, window focus, the file
// watch, the control refresh after a write) join it and leave one trailing refresh that reads after everything before.
let refreshing: Promise<void> | null = null;
let refreshAgain = false;
let refreshForce = false;

async function refreshOnce(force: boolean): Promise<void> {
  const doc = shownDoc();
  await Promise.all([doc ? loadView(doc, { quiet: true, force }) : Promise.resolve(), loadBatch(), loadTree()]);
}

export function refresh(options: { force?: boolean } = {}): Promise<void> {
  if (options.force) refreshForce = true;
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  const force = refreshForce;
  refreshForce = false;
  refreshing = refreshOnce(force).finally(() => {
    refreshing = null;
    if (refreshAgain) {
      refreshAgain = false;
      void refresh();
    }
  });
  return refreshing;
}

function expect() {
  const view = getUi().view;
  return view ? { head: view.context.head, branch: view.context.branch } : {};
}

/** A mutation: explicit target and the shown context; on success refresh, on failure explain. */
export async function mutate<T = Record<string, unknown>>(method: string, input: Record<string, unknown>, options: { withContext?: boolean; retry?: () => void; verb?: string } = {}): Promise<T | null> {
  const { target } = getUi();
  if (!target) return null;
  const reply = await invoke<T>(method, { target, ...input, ...(options.withContext === false ? {} : expect()) });
  if (!reply.ok) {
    fail(reply.error, options.retry, options.verb);
    return null;
  }
  // W-06b (EP-031-T01): the caller waits only for the document view (its stops, marks and annotations are the result
  // of the write); the tree and the batch follow in the shared refresh. The view is read here, not in a joined
  // refresh, so it is read after the write.
  const doc = shownDoc();
  if (doc) await loadView(doc, { quiet: true });
  void refresh();
  settleRefresh();
  return ((reply as unknown as { result?: T }).result ?? (reply as unknown as T));
}

let settleTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * A control refresh shortly after a write: a refresh started by the file watch before the write landed may finish
 * last and show the previous state (seen with «Undo» right after «Close»); this one reads after it.
 */
function settleRefresh(): void {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => { settleTimer = null; void refresh(); }, 1200);
}

/** The plan of «Enable review» (A10); a failure is returned to be shown in the dialog with «Retry» (W-06b). */
export async function enablePlan(): Promise<{ plan: Record<string, unknown> } | { error: string }> {
  const { target } = getUi();
  if (!target || !rpcRef) return { error: NO_CHECKOUT };
  try {
    const roots = readingRoots(getUi().ctxKey);
    const reply = await (rpcRef.call as unknown as (method: string, input: unknown) => Promise<Record<string, unknown>>)("review.enable.plan", { target, ...(roots ? { roots } : {}) });
    if (reply && reply.ok === false) return { error: explain(reply.error as ErrorInfo) };
    return { plan: (reply as { result?: Record<string, unknown> })?.result ?? {} };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function enable(head: string | null, markGenerated: boolean, retry?: () => void): Promise<boolean> {
  const { target } = getUi();
  if (!target || !rpcRef) return false;
  try {
    const roots = readingRoots(getUi().ctxKey);
    const reply = await (rpcRef.call as unknown as (method: string, input: unknown) => Promise<Record<string, unknown>>)("review.enable", { target, head, markGenerated, ...(roots ? { roots } : {}) });
    if (reply && reply.ok === false) throw new Error(explain(reply.error as ErrorInfo));
    notify(tr("Review enabled: the initial base of the documents is saved in .bb-docs/. Commit the folder along with the documents.", "Обзор включён: исходная база документов сохранена в .bb-docs/. Закоммитьте каталог вместе с документами."));
    await refresh({ force: true });
    return true;
  } catch (error) {
    notify(couldNot(tr("enable review", "включить обзор"), error instanceof Error ? error.message : String(error)), retry ? { tone: "error", actionLabel: RETRY, undo: async () => retry() } : { tone: "error" });
    return false;
  }
}

export async function call<T = Record<string, unknown>>(method: string, input: Record<string, unknown>): Promise<Reply<T>> {
  return invoke<T>(method, input);
}
