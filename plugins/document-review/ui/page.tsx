import { openFixedTab } from "./bb-compat.ts";
// «Documents» screen (navPanel; design W-06): the header in one row (D3) with priorities by the column width, «Waiting for you»,
// banners, the update bar (F9), the composer at the selection, highlights, the pass footer and keys. All jumps go through
// revealBlock (EP-018): the sticky header and footer never hide the target or the keyboard focus.
import { experimental_useAppPanel, useBbContext, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ViewAnnotation, ViewBlock } from "../node/view.ts";
import type { rpcContract } from "../server.ts";
import { changeRun } from "./change-runs.ts";
import { FileInfoButton } from "./file-info.tsx";
import { acceptMark, bindRpc, call, chooseDocument, commitLayout, fetchSource, layoutStatus, loadView, onEnableNeeded, openContext, readMark, refresh, retryLayout } from "./actions.ts";
import { applyEnableProgress, isEnableRunning } from "./enable-job.ts";
import type { ObjectStore } from "./object.tsx";
import { useVisualizersVersion } from "./visualizers.ts";
import { CodeView, type CodeHandlers } from "./code.tsx";
import { FORMATS, type FormatId } from "../core/formats/registry.ts";
import { hideAllSecrets, type MaskSecret, setExemptHandler } from "./mask.tsx";
import { ExemptDialog } from "./exempt.tsx";
import { LegendDialog } from "./legend.tsx";
import { openSettings, SettingsHost } from "./settings.tsx";
import { KeyTree, type TreeHandlers } from "./keytree.tsx";
import { CsvTable, EnvTable, type TableHandlers } from "./table.tsx";
import { forgetSource, useMeta, useSource } from "./source.ts";
import { setNumbers, setViewMode, setWrap, useViewPrefs } from "./viewmode.ts";
import { type ComposerState, Composer, typing } from "./composer.tsx";
import { composerTop } from "./composer-position.ts";
import { cpAtPoint, domRange, pointOf } from "./dom.ts";
import { useDelayedFlag, useSlowFlag } from "../feedback.ts";
import { Icon } from "./icons.tsx";
import { Banner, Button, Dialog, DialogContent, DialogHeader, DialogTitle, IconButton, Kbd, Menu, MenuCheck, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger, Tip, ToggleButton, WaitNote } from "./kit.tsx";
import { DocBanners, DocSkeleton, Drafts, EnableDialog, WaitingBlock } from "./notices.tsx";
import { nextIndex, type PassMode, passStops } from "./pass.ts";
import { PassBar } from "./passbar.tsx";
import { DocumentBody, type RenderHandlers } from "./render.tsx";
import { LARGE_DOCUMENT, useProgressiveBlocks } from "./progressive.ts";
import { chromeOf, keepFocusVisible, onJump, onMountRequest, requestMount, revealBlock, revealHeading, revealIndex } from "./reveal.ts";
import { contextKey, parseRoute, type Route, subPathOf } from "./route.ts";
import { SendButton } from "./send.tsx";
import { useSidebarHosted } from "./sidebar.tsx";
import { type DraftTarget, draftsOf, getUi, notify, type Place, placeOf, rawUi, setChosen, useChosen, rememberLast, rememberPlace, rememberRecent, setFullWidth, setUi, useUi } from "./store.ts";
import { commentsTab } from "./tabs.ts";
import { projectionText, selectionRange, sliceCp, trimRange } from "./text.ts";
import { ContextList, DocsTree } from "./tree.tsx";
import { passDocuments } from "./tree-model.ts";
import { CommentsTab } from "./comments.tsx";
import { tr } from "../core/i18n.ts";
import { VERB, num } from "./words.ts";

export const PANEL_PATH = "docs";
const EMPTY_LINES = new Set<number>();
const MIB = 1024 * 1024;
export { AGENT_LABEL, batchLabel } from "./labels.ts";

// ── highlights (CSS Custom Highlight API; text stays untouched; colours — ui/theme.css through --dr-*) ──────────

type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void };
function highlights(): { registry: HighlightRegistry; Highlight: new (...ranges: Range[]) => unknown } | null {
  const css = (globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Highlight = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return css?.highlights && Highlight ? { registry: css.highlights, Highlight } : null;
}

/** Screen keyboard shortcuts are listed in the Keyboard shortcuts item of the More menu. */
const KEYS: [string, string][] = [
  ["J / K", tr("Next / previous stop of the pass", "Следующая / предыдущая остановка прохода")], ["R", tr("Mark read and next", "Прочитано и дальше")], ["A", tr("Accept the comment and next", "Принять замечание и дальше")],
  ["C", tr("Comment on the selection; without a selection, on the block of the stop or the first visible one", "Замечание к выделению; без выделения — к блоку остановки или первому видимому")], ["E", tr("Reply in the comment of the stop", "Ответить в замечании остановки")],
  ["D", tr("Show or hide changes in the text", "Показать или скрыть правки в тексте")], ["W", tr("Document at full column width or at reading width", "Документ во всю ширину колонки или по мере чтения")], ["S", tr("Send menu: scope, recipient, summary", "Меню отправки: область, получатель, сводка")], ["/", tr("Search the tree of documents and sections", "Поиск по дереву документов и разделов")],
  ["V", tr("File view: “Pretty” or “Raw” (remembered per type)", "Вид файла: «Красиво» или «Как есть» (запоминается по типу)")], ["Z", tr("“Raw”: wrap long lines", "«Как есть»: перенос длинных строк")], ["⇧[ / ⇧]", tr("Collapse / expand all (nodes, sections)", "Свернуть / развернуть всё (узлы, разделы)")],
  ["F", tr("Key tree: filter keys and values", "Дерево ключей: фильтр ключей и значений")],
  ["⌘↵ / Esc", tr("Save / collapse the input", "Сохранить / свернуть ввод")], ["↑ ↓ → ← Home End", tr("Tree: rows, expand and collapse", "Дерево: строки, раскрыть и свернуть")], ["Shift+F10", tr("Tree: row menu", "Дерево: меню строки")],
];

/** The «⋯» menu button of the header: its name is also how a closed composer finds it to return the focus. */
const MORE = tr("More", "Ещё");

function KeysDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent className="max-w-md" aria-describedby={undefined}>
      <DialogHeader><DialogTitle className="text-[15px] font-semibold">{tr("Keyboard shortcuts", "Клавиши")}</DialogTitle></DialogHeader>
      <p className="text-[12px] text-muted-foreground">{tr("They work when the focus is not in an input field, and only without ⌘, Ctrl and Alt.", "Работают, когда фокус не в поле ввода, и только без ⌘, Ctrl и Alt.")}</p>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-4 gap-y-2 text-[13px]">
        {KEYS.map(([keys, what]) => <div key={keys} className="contents"><dt className="flex flex-wrap gap-1">{keys.split(" / ").map((key) => <Kbd key={key}>{key}</Kbd>)}</dt><dd>{what}</dd></div>)}
      </dl>
    </DialogContent>
  </Dialog>;
}

/** The checkout switcher in the header crumb (A9): a popover with the same list as the tree. */
function ContextSwitch({ current, label, hint, onPick }: { current: string; label: React.ReactNode; hint: string; onPick: (route: Route) => void }) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <Tip label={hint}><PopoverTrigger asChild>
      <button type="button" className="dr-crumb__ctx" aria-label={tr(`Switch checkout: ${hint}`, `Сменить рабочую копию — ${hint}`)}><Icon name="FolderGit2" />{label}<Icon name="ChevronsUpDown" /></button>
    </PopoverTrigger></Tip>
    <PopoverContent align="start" className="w-[28rem] max-w-[90vw]" mobileTitle={tr("Checkout", "Рабочая копия")}>
      <ContextList compact current={current} onPick={(route) => { setOpen(false); onPick(route); }} />
    </PopoverContent>
  </Popover>;
}

/** «Comments» as a bottom sheet in the embedded modes on a narrow column (EP-021-T04): handle, title, 40 px close, Esc. */
function CommentsSheet({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const back = document.activeElement;
    close.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true }); };
  }, [onClose]);
  return <div className="dr-sheet" data-comments-sheet>
    <div className="dr-sheet__scrim" onClick={onClose} aria-hidden />
    <div className="dr-sheet__body" role="dialog" aria-modal="true" aria-label={tr("Comments", "Замечания")}>
      <div className="dr-sheet__handle" aria-hidden><span /></div>
      <div className="dr-sheet__head"><b className="dr-grow">{tr("Comments", "Замечания")}</b>
        <button ref={close} type="button" className="dr-btn dr-btn--ghost dr-btn--icon dr-sheet__close" aria-label={tr("Close comments", "Закрыть замечания")} onClick={onClose}><Icon name="X" /></button></div>
      <div className="min-h-0 flex-1"><CommentsTab /></div>
    </div>
  </div>;
}

// ── W-06b: feedback of a document that is opening, outside the page's render ──────────────────────────────────

/** The document chosen in this checkout (ahead of bb's navigation, chooseDocument), else the routed one. */
const useChosenDoc = (ctxKey: string, doc: string | null): string | null => useChosen(ctxKey, doc);

/** Show the selected document path/name in the header immediately without re-rendering the page. */
function DocName({ ctxKey, doc, wide }: { ctxKey: string; doc: string | null; wide: boolean }) {
  const chosen = useChosenDoc(ctxKey, doc);
  const dir = chosen && chosen.includes("/") ? chosen.slice(0, chosen.lastIndexOf("/") + 1) : "";
  return <>
    {dir && wide && <span className="dr-crumb__path" title={dir}><bdi>{dir}</bdi></span>}
    <span className="dr-crumb__doc" title={chosen ?? undefined}>{chosen ? chosen.split("/").pop() : tr("Choose a document", "Выберите документ")}</span>
  </>;
}

/** When opening a new document, dim and disable the previous text after 150 ms, run the loading rail and explain waits beyond one second. Update DOM attributes directly to avoid re-rendering thousands of blocks. Clear dimming when new text arrives. */
function OpeningFeedback({ ctxKey, doc, headerRef, dimRef, keyHint }: { ctxKey: string; doc: string | null; headerRef: React.RefObject<HTMLElement | null>; dimRef: React.RefObject<HTMLDivElement | null>; keyHint: boolean }) {
  const chosen = useChosenDoc(ctxKey, doc);
  const shownPath = useUi((ui) => ui.view?.document.path ?? null);
  const hasView = useUi((ui) => ui.view !== null);
  const failed = useUi((ui) => ui.viewError !== null);
  const settled = useUi((ui) => ui.viewPhase === "full");
  const machine = useUi((ui) => ui.tree?.machine.name ?? ui.batch?.machine.name ?? null);
  const opening = Boolean(chosen) && shownPath !== chosen && !failed;
  const loadingMarks = hasView && !settled && !failed;
  const busy = useDelayedFlag(opening || loadingMarks);
  const slow = useSlowFlag(opening || loadingMarks);
  const dim = busy && opening && hasView;
  useLayoutEffect(() => { headerRef.current?.toggleAttribute("data-fb-seam-busy", busy); }, [busy, headerRef]);
  useLayoutEffect(() => {
    const element = dimRef.current;
    if (!element) return;
    element.toggleAttribute("data-fb-dim", dim);
    if (dim) element.setAttribute("aria-busy", "true"); else element.removeAttribute("aria-busy");
  }, [dim, dimRef]);
  return <>
    {/* Announced only when the wait is noticeable (> 1 s): a sub-second switch needs no announcement, and every text change
        here restyled the whole bb panel (bb's :has() rules) while the next document was on its way (W-06b, measured). */}
    <span className="dr-sr" role="status" aria-live="polite">{slow ? (opening ? tr("Opening the document…", "Открываю документ…") : loadingMarks ? tr("Text shown, marks and comments are loading", "Текст показан, пометки и замечания загружаются") : "") : ""}</span>
    {keyHint && !settled ? <WaitNote className="dr-hdr__note" data-key-hint>{tr("Loading marks, the pass keys will work in a moment…", "Догружаю пометки — клавиши прохода заработают через миг…")}</WaitNote>
      : slow && <WaitNote className="dr-hdr__note" data-slow-wait>{tr(`${opening ? "Opening the document" : "Loading marks and comments"} · waiting for machine${machine ? ` ${machine}` : ""}…`, `${opening ? "Открываю документ" : "Загружаю пометки и замечания"} · жду ответа машины${machine ? ` ${machine}` : ""}…`)}</WaitNote>}
  </>;
}

// ── the page ─────────────────────────────────────────────────────────────

/** The viewer inside a thread's side panel or a file tab (EP-013-T02): navigation stays inside that tab. */
export interface Embedded {
  navigate(subPath: string): void;
  /** The thread whose panel hosts the viewer: the default recipient there (E12). */
  threadId: string | null;
  kind: "thread-panel" | "file";
}

/** Document-column width class controls header and footer priorities. */
type Width = "wide" | "medium" | "compact" | "narrow";

export function DocsPage({ subPath = "", embedded = null }: { subPath?: string; embedded?: Embedded | null }) {
  const rpc = useRpc<typeof rpcContract>();
  bindRpc(rpc);
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  const bbContext = useBbContext();
  const hosted = useSidebarHosted();
  const route = useMemo(() => parseRoute(subPath), [subPath]);
  const key = contextKey(route);
  const doc = route.kind === "none" ? null : route.doc;
  const view = useUi((ui) => ui.view);
  const viewError = useUi((ui) => ui.viewError);
  const pendingView = useUi((ui) => ui.pendingView);
  /** EP-027-T08: «text» (fast path) and «cached» views are read-only until the host's full view arrives. */
  const viewPhase = useUi((ui) => ui.viewPhase);
  const textInfo = useUi((ui) => ui.textInfo);
  const settled = viewPhase === "full";
  /** «Full width» (EP-027-T03): kept on this device; the embedded modes are always as wide as their panel. */
  const fullWidth = useUi((ui) => ui.fullWidth);
  const tree = useUi((ui) => ui.tree);
  const batchInfo = useUi((ui) => ui.batch);
  const passScope = useUi((ui) => ui.passScope);
  const pendingHash = useUi((ui) => ui.pendingHash);
  const pendingAnnotation = useUi((ui) => ui.pendingAnnotation);
  const passEntry = useUi((ui) => ui.passEntry);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [embeddedTree, setEmbeddedTree] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [width, setWidth] = useState<Width>("wide");
  /** Width of the whole page: decides whether «Comments» fit as a 320 px column beside a ≥ 560 px document (no feedback loop). */
  const [pageWidth, setPageWidth] = useState(1200);
  /** Width of the document column (px): the height estimate of blocks not mounted yet. */
  const [columnWidth, setColumnWidth] = useState(900);
  const pageRef = useRef<HTMLDivElement>(null);
  const go = useCallback((next: Route) => {
    chooseDocument(next);
    if (embedded) embedded.navigate(subPathOf(next));
    else navigate.toPluginPanel(PANEL_PATH, { subPath: subPathOf(next) });
  }, [embedded, navigate]);
  const openComments = useCallback(() => {
    if (embedded) setCommentsOpen(true);
    else openFixedTab(panel, { surface: { kind: "current" }, tab: commentsTab });
  }, [embedded, panel]);
  const loading = useUi((ui) => ui.loading);
  const showDiff = useUi((ui) => ui.showDiff);
  const onlyChanges = useUi((ui) => ui.onlyChanges);
  const passMode = useUi((ui) => ui.passMode);
  const passKey = useUi((ui) => ui.passKey);
  const focusAnnotation = useUi((ui) => ui.focusAnnotation);
  const previewBase = useUi((ui) => ui.previewBase);
  const [enableReason, setEnableReason] = useState<string | null>(null);
  /** J/K/R/A… pressed before the full view arrived (W-06b): a short note instead of silence. */
  const [keyHint, setKeyHint] = useState(false);
  const keyHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showKeyHint = () => {
    setKeyHint(true);
    if (keyHintTimer.current) clearTimeout(keyHintTimer.current);
    keyHintTimer.current = setTimeout(() => setKeyHint(false), 2500);
  };
  useEffect(() => () => { if (keyHintTimer.current) clearTimeout(keyHintTimer.current); }, []);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [selection, setSelection] = useState<{ range: { start: number; end: number }; quote: string; anchor: { top: number; left: number } } | null>(null);
  /** The fallback tree column: automatic by the page width (≥ 840 px), or explicitly opened/closed by the header button. */
  const [columnPref, setColumnPref] = useState<"auto" | "open" | "closed">("auto");
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  /** The checkout and document the arrival (heading, annotation, pass entry, remembered position) was applied to. */
  const arrived = useRef<string | null>(null);
  const narrow = width === "narrow";

  useEffect(() => { setUi({ panelThreadId: embedded ? embedded.threadId : bbContext.threadId }); }, [bbContext.threadId, embedded?.threadId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onEnableNeeded(setEnableReason); return () => onEnableNeeded(null); }, []);
  useEffect(() => { void openContext(route); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  // The routed document in the shared state on every navigation (W-06a): refresh() — every 15 s, on focus, after a
  // write — reloads the routed document; with only the checkout's first route kept it brought the first document back.
  // The navigation has arrived: the chosen document is the routed one now.
  useEffect(() => { setChosen(null); if (getUi().ctxKey === key) setUi({ route }); }, [subPath]); // eslint-disable-line react-hooks/exhaustive-deps
  // A deep link may name an annotation (…/~a/<id>/doc): it is focused once shown; the route then drops it.
  useEffect(() => {
    if (route.kind === "none") return;
    if (route.annotationId) {
      setUi({ pendingAnnotation: route.annotationId });
      const plain = subPathOf({ ...route, annotationId: null });
      if (embedded) embedded.navigate(plain);
      else navigate.toPluginPanel(PANEL_PATH, { subPath: plain, replace: true });
      return;
    }
    // Machine + path of a checkout that bb knows as an environment: the same checkout under its environment, so drafts,
    // the last document and the new-thread recipient are shared with the rest of bb (the machine stays the same).
    if (route.kind === "host") {
      void call<{ environments: { id: string; hostId: string; path: string }[] }>("review.contexts", {}).then((reply) => {
        if (!reply.ok) return;
        const found = (reply as unknown as { environments: { id: string; hostId: string; path: string }[] }).environments.find((entry) => entry.hostId === route.hostId && entry.path === route.root);
        if (!found) return;
        const next = subPathOf({ kind: "env", environmentId: found.id, doc: route.doc ?? placeOf(`env:${found.id}`).doc });
        if (embedded) embedded.navigate(next);
        else navigate.toPluginPanel(PANEL_PATH, { subPath: next, replace: true });
      });
      return;
    }
    // A checkout without a document opens its last document (A9).
    if (!route.doc) {
      const last = placeOf(key).doc;
      if (last) {
        const next = subPathOf({ ...route, doc: last });
        if (embedded) embedded.navigate(next);
        else navigate.toPluginPanel(PANEL_PATH, { subPath: next, replace: true });
      }
    }
  }, [subPath]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (doc) {
      arrived.current = null;
      setComposer(null);
      setSelection(null);
      setUi({ currentHeading: null });
      void loadView(doc, { force: true });
      rememberLast(subPath, doc);
      rememberPlace(key, doc);
      if (route.kind !== "none") rememberRecent(subPathOf({ ...route, doc: null }), `${route.kind === "host" ? route.root.split("/").pop() : route.environmentId}`);
    } else setUi({ view: null, viewError: null });
  }, [key, doc]); // eslint-disable-line react-hooks/exhaustive-deps

  // F9: while the user selects or types, a newer revision waits in the update bar.
  useEffect(() => { setUi({ holding: Boolean(composer || selection) }); }, [composer, selection]);

  // Sticky layers (EP-018): their measured heights feed scroll-padding (--dr-header-h / --dr-footer-h), so the browser's
  // own focus scrolling and revealBlock agree; the column width picks the header layout (container widths of the design).
  useLayoutEffect(() => {
    const container = scrollRef.current;
    const main = mainRef.current;
    if (!container || !main || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const chrome = chromeOf(container);
      container.style.setProperty("--dr-header-h", `${Math.round(chrome.outer)}px`);
      container.style.setProperty("--dr-inner-h", `${Math.round(chrome.header - chrome.outer)}px`);
      container.style.setProperty("--dr-footer-h", `${Math.round(chrome.footer)}px`);
      const columnWidth = main.getBoundingClientRect().width;
      setWidth(columnWidth < 560 ? "narrow" : columnWidth < 720 ? "compact" : columnWidth < 1040 ? "medium" : "wide");
      setColumnWidth(Math.round(columnWidth));
      if (pageRef.current) setPageWidth(pageRef.current.getBoundingClientRect().width);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    if (pageRef.current) observer.observe(pageRef.current);
    for (const element of container.querySelectorAll("[data-dr-sticky]")) observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [view !== null, pendingView !== null, route.kind]);

  // Realtime invalidation from the host watch; a periodic re-check as the fallback (research: watch is experimental).
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void refresh(), 300);
  }, []);
  useRealtime("review.enable.progress", applyEnableProgress);
  useRealtime("review.changed", (payload) => {
    const { hostId, root } = (payload ?? {}) as { hostId?: string; root?: string };
    if (isEnableRunning(hostId, root)) return;
    const batch = getUi().batch;
    if (!batch || (hostId === batch.machine.hostId && (!root || root === batch.root || getUi().view?.context.root === root))) scheduleRefresh();
  });
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 15_000);
    // Returning to the window refreshes, but not again within 5 s (focus bursts while switching windows; W-06b).
    let focusedAt = 0;
    const onFocus = () => { if (Date.now() - focusedAt < 5000) return; focusedAt = Date.now(); void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, []);

  // The reading position: the first block below the sticky header and its offset from the header's bottom edge
  // (EP-018-T02) — a header that changes height with the width never shifts the restored position.
  const anchorRef = useRef<Place | null>(null);
  const zoneTop = (container: HTMLElement) => container.getBoundingClientRect().top + chromeOf(container).header;
  // Blocks and headings are in document order: the first visible one is found by binary search (W-06a — a 1 MiB
  // document has ~18 000 blocks; a linear pass with getBoundingClientRect per scroll frame made long tasks).
  const firstBelow = (elements: ArrayLike<HTMLElement>, edge: number): number => {
    let low = 0;
    let high = elements.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (elements[middle].getBoundingClientRect().bottom > edge) high = middle;
      else low = middle + 1;
    }
    return low;
  };
  /** Keep a restored position anchored until the full document can reach it or the reader scrolls. Fast-path text lacks review marks and removals; mounting, banners and clamping must not replace the anchor. */
  const pinned = useRef<Place | null>(null);
  const captureAnchor = useCallback(() => {
    const container = scrollRef.current;
    if (!container || pinned.current) return;
    const top = zoneTop(container);
    const blocks = container.querySelectorAll<HTMLElement>("[data-lineage]");
    const element = blocks[firstBelow(blocks, top + 8)];
    if (element) anchorRef.current = { lineage: element.dataset.lineage ?? "", index: Number(element.dataset.block), offset: element.getBoundingClientRect().top - top };
  }, []);
  /** Restore a reading position: by lineage (survives edits), else by block index (the fast path has no lineages yet). */
  const restoreAnchor = useCallback((anchor: Place) => {
    const container = scrollRef.current;
    const element = (anchor.lineage ? container?.querySelector<HTMLElement>(`[data-lineage="${CSS.escape(anchor.lineage)}"]`) : null)
      ?? (anchor.index !== undefined ? container?.querySelector<HTMLElement>(`[data-block="${anchor.index}"]`) : null);
    if (container && element) {
      container.scrollTop += element.getBoundingClientRect().top - zoneTop(container) - anchor.offset;
      // The restored position is the anchor at once: a phase change (text → full view) before the next scroll event
      // keeps this line, not an older one (W-06a). Not reached (clamped at the end) — it stays pinned.
      const intended: Place = { lineage: anchor.lineage || (element.dataset.lineage ?? ""), index: Number(element.dataset.block), offset: anchor.offset };
      anchorRef.current = intended;
      const reached = Math.abs(element.getBoundingClientRect().top - zoneTop(container) - anchor.offset) <= 2;
      pinned.current = reached ? null : intended;
    } else if (container && anchor.index !== undefined && !(anchor as { retried?: number }).retried) {
      // A very large document mounts a window only: bring the position's block in, then restore (EP-027-T08).
      requestMount(anchor.index);
      requestAnimationFrame(() => requestAnimationFrame(() => restoreRef.current({ ...anchor, retried: 1 } as Place)));
    }
  }, []);
  const restoreRef = useRef(restoreAnchor);
  restoreRef.current = restoreAnchor;
  // The reader's own scrolling ends a pinned position.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const release = () => { pinned.current = null; };
    const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    for (const name of events) container.addEventListener(name, release, { passive: true });
    onJump(release);
    return () => { for (const name of events) container.removeEventListener(name, release); onJump(null); };
  }, [view !== null]);
  /** The current section (EP-019-T02): the last heading whose top is at or above the top of the safe zone. */
  const trackSection = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const top = zoneTop(container) + 16;
    const headings = container.querySelectorAll<HTMLElement>("[data-block] > .dr-txt [role=heading]");
    // The last heading whose top is at or above the line: binary search on tops (document order).
    let low = 0;
    let high = headings.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (headings[middle].getBoundingClientRect().top > top) high = middle;
      else low = middle + 1;
    }
    const current = low > 0 ? Number(headings[low - 1].closest<HTMLElement>("[data-block]")!.dataset.block) : null;
    if (getUi().currentHeading !== current) setUi({ currentHeading: current });
  }, []);
  // The full view replaces fast-path text; marks, removals and Before lines change block heights
  // above the reading line — before the paint, the same first visible line is put back where it was (no jump).
  const lastPhase = useRef<string | null>(null);
  useLayoutEffect(() => {
    const phaseKey = view ? `${view.document.path}|${viewPhase}` : null;
    const previous = lastPhase.current;
    lastPhase.current = phaseKey;
    if (!view || !previous || previous === phaseKey || !previous.startsWith(`${view.document.path}|`) || !anchorRef.current) return;
    const anchor = anchorRef.current;
    restoreAnchor(anchor);
  }, [view, viewPhase, restoreAnchor]);
  // Banners and «Waiting for you» above the text arrive on their own (W-06a: the text now shows before them): when their
  // height changes, the first visible line goes back where it was.
  const leadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const lead = leadRef.current;
    if (!lead || typeof ResizeObserver === "undefined") return;
    let height = lead.getBoundingClientRect().height;
    const observer = new ResizeObserver(() => {
      const next = lead.getBoundingClientRect().height;
      if (Math.abs(next - height) > 1 && anchorRef.current && (scrollRef.current?.scrollTop ?? 0) > 0) restoreAnchor(anchorRef.current);
      height = next;
    });
    observer.observe(lead);
    return () => observer.disconnect();
  }, [restoreAnchor, view !== null]);
  const lastSha = useRef<string | null>(null);
  useEffect(() => {
    if (!view || !scrollRef.current) return;
    if (lastSha.current && lastSha.current !== view.document.sha && anchorRef.current) restoreAnchor(anchorRef.current);
    lastSha.current = view.document.sha;
  }, [view, restoreAnchor]);
  // Re-anchor when the header height or the width changes (1500 ↔ 390 px): the same first visible line stays on top.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    let last = container.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const next = container.getBoundingClientRect().width;
      if (Math.abs(next - last) > 1 && anchorRef.current) requestAnimationFrame(() => restoreAnchor(anchorRef.current!));
      last = next;
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [restoreAnchor, view !== null]);
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let frame = 0;
    const onScroll = () => {
      captureAnchor();
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; trackSection(); });
      // The reading position per checkout and document survives switching projects and reloads (A9, H3).
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { if (anchorRef.current && doc) rememberPlace(key, doc, anchorRef.current); }, 400);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => { container.removeEventListener("scroll", onScroll); if (timer) clearTimeout(timer); if (frame) cancelAnimationFrame(frame); };
  }, [captureAnchor, trackSection, view?.document.path, key, doc]);

  // Arriving at a document: a heading (search, link), an annotation (deep link), the entry stop of a cross-document
  // pass, or else the remembered reading position of this document in this checkout.
  useEffect(() => {
    const container = scrollRef.current;
    if (!view || !container || view.document.path !== doc) return;
    const arrival = `${key}|${doc}`;
    if (pendingHash) {
      // The heading may render a frame later than the view (images, fonts): wait for it up to ~1 s.
      const hash = pendingHash;
      requestAnimationFrame(() => { revealHeading(hash, bodyRef.current ?? document); requestAnimationFrame(trackSection); });
      setUi({ pendingHash: null });
      arrived.current = arrival;
      return;
    }
    // An annotation and a pass entry need the review state: they wait for the full view (the text is already shown).
    if ((pendingAnnotation || passEntry) && !settled) return;
    if (pendingAnnotation) {
      setUi({ pendingAnnotation: null, focusAnnotation: pendingAnnotation, focusNonce: getUi().focusNonce + 1, filter: "open" });
      const place = view.annotations.find((annotation) => annotation.annotationId === pendingAnnotation)?.anchor.place;
      if (place !== null && place !== undefined) requestAnimationFrame(() => revealIndex(place, "center"));
      openComments();
      arrived.current = arrival;
      return;
    }
    if (passEntry) {
      const list = passStops(view, getUi().passMode);
      setUi({ passEntry: null, passKey: (passEntry === "last" ? list[list.length - 1] : list[0])?.key ?? null, passNonce: getUi().passNonce + 1 });
      arrived.current = arrival;
      return;
    }
    if (arrived.current === arrival) return;
    const saved = placeOf(key).positions[doc];
    // A position saved before 1.2 has only a lineage: it is restored once the full view brings the lineages.
    if (saved && saved.index === undefined && !settled) return;
    arrived.current = arrival;
    requestAnimationFrame(() => { if (saved) restoreAnchor(saved); trackSection(); });
  }, [view, viewPhase, pendingHash, pendingAnnotation, passEntry]); // eslint-disable-line react-hooks/exhaustive-deps

  const blocks = view?.blocks ?? [];
  const text = useMemo(() => projectionText(blocks), [blocks]);
  // A large document mounts progressively (EP-027-T08): the first screens or the jump target first, the rest in idle time.
  const scroller = useCallback(() => scrollRef.current, []);
  const progressive = useProgressiveBlocks({
    blocks, total: textInfo && textInfo.path === view?.document.path ? textInfo.total : blocks.length,
    lengths: textInfo && textInfo.path === view?.document.path ? textInfo.lengths : null, identity: view ? `${view.document.path}|${view.document.sha}` : "none",
    scroller, body: useCallback(() => bodyRef.current, []), charsPerLine: Math.max(30, Math.floor(Math.min(columnWidth - 140, fullWidth ? columnWidth : 700) / 8.3)),
  });
  useEffect(() => { onMountRequest(progressive.ensure); return () => onMountRequest(null); }, [progressive.ensure]);
  const liveHandlers = useRef<RenderHandlers | null>(null);
  const stableHandlers = useMemo(() => {
    const call = <K extends keyof RenderHandlers>(name: K) => ((...args: unknown[]) => (liveHandlers.current![name] as unknown as (...rest: unknown[]) => void)(...args)) as unknown as RenderHandlers[K];
    return { openDoc: call("openDoc"), openUrl: call("openUrl"), onRead: call("onRead"), onReadSection: call("onReadSection"), onComment: call("onComment"),
      onCommentElement: call("onCommentElement"), onCommentText: call("onCommentText"), onReadRemoved: call("onReadRemoved"), onCommentRemoved: call("onCommentRemoved"), onMarker: call("onMarker") };
  }, []);
  const stops = useMemo(() => (view ? passStops(view, passMode) : []), [view, passMode]);
  const passIndex = useMemo(() => {
    const previous = passKey ? stops.find((stop) => stop.key === passKey) ?? { key: passKey, order: Number(passKey.slice(1)) || 0, blocks: [], tombstones: [], annotations: [] } : null;
    return nextIndex(stops, previous);
  }, [stops, passKey]);
  const currentStop = stops[passIndex] ?? null;
  const passDocs = useMemo(() => (passScope === "all" ? passDocuments(tree, passMode, doc, getUi().showHidden) : doc ? [doc] : []), [passScope, tree, passMode, doc]);
  const docIndex = doc ? passDocs.indexOf(doc) : -1;
  const goDoc = (delta: 1 | -1) => {
    const target = passDocs[docIndex + delta];
    if (!target || route.kind === "none") return false;
    setUi({ passEntry: delta > 0 ? "first" : "last", passKey: null });
    go({ ...route, doc: target });
    return true;
  };

  const markers = useMemo(() => {
    const map = new Map<number, ViewAnnotation[]>();
    for (const annotation of view?.annotations ?? []) {
      if (annotation.status !== "open") continue;
      const place = annotation.anchor.place ?? annotation.anchor.blocks[0];
      if (place === undefined || place === null || place < 0) continue;
      map.set(place, [...(map.get(place) ?? []), annotation]);
    }
    return map;
  }, [view]);
  const focusBlocks = useMemo(() => new Set(currentStop?.blocks ?? []), [currentStop]);

  // «Raw / Pretty» (W-06c, EP-042): the view per file type, kept on this device; the source of “Raw” on demand.
  const prefs = useViewPrefs();
  const format = (view?.format ?? null) as FormatId | null;
  // A structured file that does not parse, or larger than ≈ 2 MB, has no «Pretty»; from 1 MB it opens “Raw” and
  // «Pretty» is a choice for this document in this session (file-types.md §6, §14).
  const structured = Boolean(format && format !== "markdown");
  const size = view?.document.size ?? 0;
  const prettyBlocked = !structured || !view ? null : view.parseError && format !== "text" ? "parse" : size > 2 * MIB ? "large" : null;
  const [largePretty, setLargePretty] = useState<string | null>(null);
  const raw = Boolean(view && format && (prettyBlocked || (structured && size >= MIB ? largePretty !== view.document.path : prefs.modes[format] === "raw")));
  const setRaw = (next: boolean) => {
    if (!format || !view) return;
    if (!next && prettyBlocked) {
      notify(prettyBlocked === "parse" ? tr("“Pretty” is unavailable while the file does not parse: fix the parse error", "«Красиво» недоступен, пока файл не разбирается — исправьте ошибку разбора") : tr("“Pretty” is unavailable for files over 2 MB", "«Красиво» недоступен для файлов больше 2 МБ"), { tone: "info" });
      return;
    }
    hideAllSecrets();
    // The same place in the other view (EP-043-T04): the first block visible under the header — a node ↔ its first line.
    const top = scrollRef.current ? zoneTop(scrollRef.current) : 120;
    const visible = [...(bodyRef.current?.querySelectorAll<HTMLElement>("[data-block]") ?? [])].find((element) => element.getBoundingClientRect().bottom > top + 4);
    keepBlock.current = visible && (scrollRef.current?.scrollTop ?? 0) > 0 ? Number(visible.dataset.block) : null;
    if (structured && size >= MIB) setLargePretty(next ? null : view.document.path);
    else setViewMode(format, next ? "raw" : "pretty");
  };
  const keepBlock = useRef<number | null>(null);
  useEffect(() => {
    if (keepBlock.current === null) return;
    const element = bodyRef.current?.querySelector(`[data-block="${keepBlock.current}"]`);
    if (!element) return;
    keepBlock.current = null;
    revealBlock(element, "start");
  });
  const sourceReply = useSource(key, raw && view ? view.document.path : null, raw && view ? view.document.sha : null, fetchSource);
  const source = sourceReply && "source" in sourceReply ? sourceReply : null;
  const sourceError = sourceReply && "error" in sourceReply ? sourceReply.error : null;
  // The host answered with another revision (the file changed in between): ask again for the shown one.
  useEffect(() => {
    if (view && source && source.sha !== view.document.sha) forgetSource(key, view.document.path, source.sha);
  }, [view, source, key]);
  const [closedFolds, setClosedFolds] = useState<{ doc: string; lines: Set<number> }>({ doc: "", lines: new Set() });
  const closed = closedFolds.doc === (view?.document.path ?? "") ? closedFolds.lines : EMPTY_LINES;
  const setFold = useCallback((line: number, open: boolean) => setClosedFolds((current) => {
    const lines = new Set(current.doc === (getUi().view?.document.path ?? "") ? current.lines : []);
    if (open) lines.delete(line); else lines.add(line);
    return { doc: getUi().view?.document.path ?? "", lines };
  }), []);
  const foldAll = (fold: boolean) => setClosedFolds({ doc: view?.document.path ?? "", lines: fold && source ? new Set(source.folds.map((entry) => entry.line)) : new Set() });
  // «Pretty» of structured files: collapsed groups per document (chevrons, ⇧[ / ⇧], «Collapse all inside»).
  const [collapsedGroups, setCollapsedGroups] = useState<{ doc: string; groups: Set<number> }>({ doc: "", groups: new Set() });
  const collapsed = collapsedGroups.doc === (view?.document.path ?? "") ? collapsedGroups.groups : EMPTY_LINES;
  const setCollapsed = useCallback((update: (groups: Set<number>) => void) => setCollapsedGroups((current) => {
    const path = getUi().view?.document.path ?? "";
    const groups = new Set(current.doc === path ? current.groups : []);
    update(groups);
    return { doc: path, groups };
  }), []);
  const meta = useMeta(key, view?.document.path ?? null, view?.document.sha ?? null);
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const pretty = format ? FORMATS[format].pretty : "markdown";
  const groupIndices = () => (view?.blocks ?? []).filter((block) => block.type === "group").map((block) => block.index);
  const foldEverything = (fold: boolean) => {
    if (raw) foldAll(fold);
    else if (pretty === "keytree") setCollapsed((groups) => { groups.clear(); if (fold) for (const index of groupIndices()) groups.add(index); });
  };
  const [exempting, setExempting] = useState<MaskSecret | null>(null);
  useEffect(() => { setExemptHandler(view?.context.writable || view?.fileClass === "outside" ? setExempting : null); return () => setExemptHandler(null); }, [view?.context.writable, view?.fileClass]);
  // Leaving the file hides every shown value (F19).
  useEffect(() => () => hideAllSecrets(), [view?.document.path]);

  // Highlights of open annotations; the focused one stronger; the pending selection while composing.
  useEffect(() => {
    const api = highlights();
    const container = bodyRef.current;
    if (!api || !container || !view) return;
    const note: Range[] = [];
    const wait: Range[] = [];
    const focus: Range[] = [];
    const pending: Range[] = [];
    const add = (list: Range[], range: { start: number; end: number }) => {
      view.blocks.forEach((block) => {
        const start = Math.max(range.start, block.range.start);
        const end = Math.min(range.end, block.range.end);
        if (end <= start) return;
        const dom = domRange(container, block.index, block.text, { start: start - block.range.start, end: end - block.range.start });
        if (dom) list.push(dom);
      });
    };
    for (const annotation of view.annotations) {
      if (annotation.status !== "open" || annotation.targetKind === "document") continue;
      for (const range of annotation.anchor.ranges) add(annotation.annotationId === focusAnnotation ? focus : annotation.waiting ? wait : note, range);
    }
    const pendingRange = composer?.target.kind === "text" ? composer.target.range : selection?.range;
    if (pendingRange) add(pending, pendingRange);
    api.registry.set("bbdr-note", new api.Highlight(...note));
    api.registry.set("bbdr-wait", new api.Highlight(...wait));
    api.registry.set("bbdr-focus", new api.Highlight(...focus));
    api.registry.set("bbdr-pending", new api.Highlight(...pending));
    return () => { for (const name of ["bbdr-note", "bbdr-wait", "bbdr-focus", "bbdr-pending"]) api.registry.delete(name); };
  }, [view, focusAnnotation, composer, selection, showDiff, onlyChanges, progressive.shown]);

  // Reveal the current stop only on explicit pass navigation, read/accept-and-next, mode changes or Review, never
  // because the list was recomputed after an update — the reading position stays put (F9).
  const passNonce = useUi((ui) => ui.passNonce);
  const revealedPassNonce = useRef(0);
  useEffect(() => {
    if (!passNonce || !currentStop || !bodyRef.current) return;
    if (revealedPassNonce.current === passNonce) return;
    revealedPassNonce.current = passNonce;
    const block = currentStop.blocks[0] ?? (currentStop.annotations.length ? view?.annotations.find((annotation) => annotation.annotationId === currentStop.annotations[0])?.anchor.place : null);
    if (block !== null && block !== undefined) { requestAnimationFrame(() => revealIndex(block, "center")); return; }
    const target = currentStop.tombstones[0] ? bodyRef.current.querySelector(`[data-tombstone="${CSS.escape(currentStop.tombstones[0])}"]`) : null;
    if (target) requestAnimationFrame(() => revealBlock(target, "center"));
  }, [passNonce, currentStop?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const openDoc = useCallback((target: string, hash: string | null) => {
    if (route.kind === "none") return;
    if (target === doc && hash) {
      revealHeading(hash, bodyRef.current ?? document);
      return;
    }
    // A `.md#heading` link: the heading is shown once the document opens (B4).
    setUi({ pendingHash: hash });
    go({ ...route, doc: target });
  }, [route, doc, go]);

  const anchorFor = (rect: DOMRect | null) => {
    const container = bodyRef.current?.parentElement;
    const scroll = scrollRef.current;
    if (!container || !scroll) return { top: 80, left: 24 };
    const box = container.getBoundingClientRect();
    const viewport = scroll.getBoundingClientRect();
    const chrome = chromeOf(scroll);
    return { top: composerTop(box.top, { top: viewport.top + chrome.header, bottom: viewport.bottom - chrome.footer }, rect ? rect.bottom + 6 : null, 0), left: Math.max(8, Math.min(rect ? rect.left - box.left : 24, box.width - 408)) };
  };
  const blockRect = (index: number) => {
    const element = bodyRef.current?.querySelector(`[data-block="${index}"]`);
    return (element?.querySelector(".dr-txt, .dr-cl__src") ?? element)?.getBoundingClientRect() ?? null;
  };

  function openComposer(target: DraftTarget, rect: DOMRect | null, initial?: string) {
    if (!view) return;
    if (!view.context.enabled) { setEnableReason(tr("The first comment will enable review: the data will be stored in .bb-docs/ of this checkout.", "Первое замечание включит обзор: данные будут храниться в .bb-docs/ этой рабочей копии.")); return; }
    if (!view.context.writable) { notify(view.context.readOnlyReason ?? tr("Read-only", "Только чтение"), { tone: "error" }); return; }
    const active = document.activeElement;
    const returnFocus = active && (active === document.body || scrollRef.current?.contains(active)) ? active : scrollRef.current?.querySelector(`[data-dr-header] button[aria-label="${MORE}"]`);
    const selectedNode = target.kind === "text" ? window.getSelection()?.anchorNode : null;
    const selectedBlock = (selectedNode instanceof Element ? selectedNode : selectedNode?.parentElement)?.closest<HTMLElement>("[data-block]");
    const fallbackFocus = selectedBlock ?? bodyRef.current?.querySelector<HTMLElement>(`[data-block="${"block" in target ? target.block : anchorRef.current?.index ?? 0}"]`);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    setComposer({ target, anchor: anchorFor(rect), sha: view.document.sha, initial, returnFocus, fallbackFocus });
  }

  // Selection by touch (long press and handles) fires no mouseup: follow selectionchange on touch devices (H6).
  useEffect(() => {
    if (!window.matchMedia?.("(hover: none)").matches) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChange = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const selected = window.getSelection();
        if (selected && !selected.isCollapsed && selected.rangeCount && bodyRef.current?.contains(selected.getRangeAt(0).commonAncestorContainer)) captureSelection();
      }, 400);
    };
    document.addEventListener("selectionchange", onChange);
    return () => { document.removeEventListener("selectionchange", onChange); if (timer) clearTimeout(timer); };
  });

  function captureSelection() {
    const selected = window.getSelection();
    if (!view || !selected || selected.isCollapsed || !selected.rangeCount || !bodyRef.current) { setSelection(null); return; }
    const range = selected.getRangeAt(0);
    if (!bodyRef.current.contains(range.commonAncestorContainer)) { setSelection(null); return; }
    const start = pointOf(range.startContainer, range.startOffset, "start");
    const end = pointOf(range.endContainer, range.endOffset, "end");
    if (!start || !end) { setSelection(null); return; }
    const raw = selectionRange(view.blocks, start, end);
    const trimmed = raw ? trimRange(text, raw) : null;
    if (!trimmed) { setSelection(null); return; }
    setSelection({ range: trimmed, quote: sliceCp(text, trimmed), anchor: anchorFor(range.getBoundingClientRect()) });
  }

  /** Mark read updates the view and Undo toast immediately, saves in the background and advances in the same frame. A failed write restores unread marks and offers Retry. */
  function acknowledge(input: { scope: "block" | "section" | "document"; blocks?: number[]; heading?: number; tombstones?: string[] }, next = false) {
    if (!view) return;
    if (!view.context.enabled) { setEnableReason(tr("The first “Mark read” will enable review in this checkout.", "Первое «Прочитано» включит обзор в этой рабочей копии.")); return; }
    void readMark(view, input);
    if (next) advance();
  }

  /** «… and next»: the next stop; at the end of a document in the «All documents» scope — the next document. */
  function advance() {
    const following = stops[passIndex + 1];
    if (!following && passScope === "all" && goDoc(1)) return;
    setUi({ passKey: following?.key ?? null, passNonce: getUi().passNonce + 1 });
  }

  /** Accept closes the annotation and marks its linked shown edits read immediately, then advances in the same frame. */
  function acceptAnnotation(annotation: ViewAnnotation, next = false) {
    if (!view || !annotation.latest) return;
    void acceptMark(view, annotation);
    if (next) advance();
  }

  const moveStop = (delta: number) => {
    if (passScope === "all" && ((delta > 0 && (passIndex >= stops.length - 1 || !stops.length)) || (delta < 0 && passIndex <= 0)) && goDoc(delta > 0 ? 1 : -1)) return;
    if (!stops.length) return;
    const index = Math.max(0, Math.min(stops.length - 1, (passIndex < 0 ? 0 : passIndex) + delta));
    const stop = stops[index];
    setUi({ passKey: stop.key, passNonce: getUi().passNonce + 1, focusAnnotation: stop.annotations[0] ?? getUi().focusAnnotation });
  };
  const readStop = () => {
    if (!currentStop) return;
    void acknowledge({ scope: "block", blocks: currentStop.blocks, tombstones: currentStop.tombstones }, true);
  };
  const acceptStop = () => {
    const annotation = currentStop?.annotations.map((id) => view?.annotations.find((entry) => entry.annotationId === id)).find((entry) => entry?.waiting && entry.latest);
    if (annotation) void acceptAnnotation(annotation, true);
  };
  const replyStop = () => {
    const id = currentStop?.annotations[0] ?? focusAnnotation;
    if (!id) return;
    setUi({ focusAnnotation: id, focusNonce: getUi().focusNonce + 1, replyNonce: getUi().replyNonce + 1, replyFor: id, filter: "open" });
    openComments();
  };
  const startPass = (mode: PassMode, scope: "document" | "all", filter?: "waiting" | "place") => {
    setUi({ passMode: mode, passScope: scope, passKey: null, passNonce: getUi().passNonce + 1, ...(filter ? { filter } : {}) });
    if (filter) openComments();
  };

  // Handle keyboard shortcuts only when focus is outside text inputs.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (typing.active && event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        typing.buffer += event.key;
        return;
      }
      if ((target instanceof Element && target.closest("input, textarea, select, [contenteditable=true], [role=menu], [role=dialog]")) || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!view) return;
      // Until the full view arrives the document is read-only: actions and pass navigation wait, view keys work.
      // J/K too: the pass stops come with the review state — without them a pass over «All documents» skipped documents.
      if (!settled && "rRaAeEcCsSjJkK".includes(event.key)) {
        // W-06b: not silently — a short note says why the key waits.
        showKeyHint();
        return;
      }
      // Select and type: a printable key with a selection opens the composer with that character.
      if (selection && settled && event.key.length === 1 && event.key !== " ") {
        event.preventDefault();
        typing.active = true;
        typing.buffer = "";
        openComposer({ kind: "text", range: selection.range, quote: selection.quote }, null, event.key);
        return;
      }
      // ⇧[ / ⇧]: fold / unfold everything in “Raw” (by the key's place: any keyboard layout).
      if (event.shiftKey && (event.code === "BracketLeft" || event.code === "BracketRight")) {
        if ((raw && source) || (!raw && pretty === "keytree")) { event.preventDefault(); foldEverything(event.code === "BracketLeft"); }
        return;
      }
      switch (event.key) {
        case "j": case "J": event.preventDefault(); moveStop(1); break;
        case "k": case "K": event.preventDefault(); moveStop(-1); break;
        case "r": case "R": event.preventDefault(); readStop(); break;
        case "a": case "A": event.preventDefault(); acceptStop(); break;
        case "e": case "E": event.preventDefault(); replyStop(); break;
        case "d": case "D": event.preventDefault(); setUi({ showDiff: !getUi().showDiff }); break;
        case "w": case "W": if (!embedded) { event.preventDefault(); setFullWidth(!getUi().fullWidth); } break;
        case "v": case "V": if (format) { event.preventDefault(); setRaw(!raw); } break;
        case "z": case "Z": if (raw) { event.preventDefault(); setWrap(!prefs.wrap); } break;
        case "c": case "C": {
          event.preventDefault();
          if (view.fileClass === "outside" && view.scope !== "local") { notify(tr("File outside Git, view only: comments on it are not saved", "Файл вне Git — только просмотр: замечания к нему не сохраняются")); break; }
          if (selection) openComposer({ kind: "text", range: selection.range, quote: selection.quote }, null);
          else if (currentStop?.blocks[0] !== undefined) openComposer({ kind: "change", block: currentStop.blocks[0], quote: view.blocks[currentStop.blocks[0]].text.slice(0, 200) }, blockRect(currentStop.blocks[0]));
          else {
            // No selection and no pass stop: the first block visible below the header (keyboard-only comment, AC25).
            const top = scrollRef.current ? zoneTop(scrollRef.current) : 120;
            const visible = [...(bodyRef.current?.querySelectorAll<HTMLElement>("[data-block]") ?? [])].find((element) => element.getBoundingClientRect().bottom > top + 8);
            const index = visible ? Number(visible.dataset.block) : -1;
            if (index >= 0 && view.blocks[index]) openComposer({ kind: "block", block: index, quote: view.blocks[index].text.slice(0, 200) }, blockRect(index));
          }
          break;
        }
        case "s": case "S": {
          // The send menu: scope, recipient and summary before sending (E15); its first choice takes the focus.
          const toggle = document.querySelector<HTMLButtonElement>("[data-docs-page] [data-send-menu]");
          if (toggle) { event.preventDefault(); toggle.click(); }
          break;
        }
        case "/": {
          // Search of the documents tree (sidebar tab or column).
          const search = document.querySelector<HTMLInputElement>(`input[aria-label="${VERB.search.hint}"]`);
          if (search) { event.preventDefault(); search.focus(); }
          break;
        }
        case "Escape": setSelection(null); break;
        default: break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const loadingMarks = Boolean(view) && !settled && !viewError;
  // W-06b (D12, D13): another document was chosen and its text has not come yet — after 150 ms the previous text is
  // dimmed and unavailable and the rail runs on the header's seam (its name in the header is already the new one).
  // dimmed and unavailable and the rail runs on the header's seam; the explanation after 1 s. All of it lives in
  // <OpeningFeedback> (W-06b regression fix): its flags flip attributes on the header and the text wrapper, so the
  // page itself — with the previous document's blocks — is not rendered again on every 150 ms / 1 s step.
  const headerRef = useRef<HTMLElement>(null);
  const dimRef = useRef<HTMLDivElement>(null);

  // W-06b regression fix: the blocks get one handlers object per change of the values they render, not one per render
  // of the page — the page renders several times while the next document is on its way (route, loading, opening state),
  // and a new object each time re-rendered every block of the previous document (memo(Block) compares by identity).
  // A file outside Git (ignored) is shown only (DR-14, until local review): no marks, no annotations.
  const outsideGit = view?.fileClass === "outside" && view.scope !== "local";
  const blocksWritable = settled && !outsideGit && Boolean(view?.context.writable || (view && !view.context.enabled && !view.document.missing));
  // The blocks belong to the shown view: their links resolve against its path, not the routed one (which moves first).
  const shownDoc = view?.document.path ?? doc ?? "";
  // W-06f (EP-060-T05): the reader's layout of each Mermaid block; it changes (with its saving state) only with view.layouts.
  const layouts = view?.layouts;
  const layoutReadOnly = !view ? "" : blocksWritable ? null : !settled ? tr("The document is still loading: “Layout” will be available once it loads", "Документ ещё загружается — «Расположение» станет доступно после загрузки")
    : outsideGit ? tr("File outside Git: the diagram layout is not saved", "Файл вне Git — раскладка схемы не сохраняется") : view.context.readOnlyReason ?? tr("Review data is read-only: the layout is not saved", "Данные обзора только для чтения — раскладка не сохраняется");
  const diagramStore = useMemo(() => {
    if (!view || layoutReadOnly === "") return undefined;
    const shown = view;
    // One store object per block while the view and the saving state are the same: the object frame updates its canvas
    // only on a real change (a new object per render would update, report and render in a loop).
    const cache = new Map<string, { status: string; store: ObjectStore }>();
    return (block: ViewBlock): ObjectStore => {
      const entry = layouts?.find((layout) => layout.block === block.index);
      const status = layoutStatus(shown.document.path, block.lineageId);
      const key = `${block.index}|${block.lineageId}`;
      const cached = cache.get(key);
      const stamp = `${status.saving}|${status.error}`;
      if (cached && cached.status === stamp) return cached.store;
      const store: ObjectStore = { pins: entry?.pins ?? {}, conflicts: entry?.conflicts ?? [], previous: entry?.previous, readOnly: layoutReadOnly ?? entry?.readOnly ?? null, ...status,
        commit: (nodes, reset, engine) => commitLayout(shown, block.lineageId, nodes, reset, engine), retry: () => retryLayout(shown.document.path, block.lineageId) };
      cache.set(key, { status: stamp, store });
      return store;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layouts, layoutReadOnly, view?.document.path, view?.document.sha]);
  // Visualizers of the window (EP-073): plugins register through the contract; blocks re-render when the set or the order changes.
  const visualizers = useVisualizersVersion();
  const renderHandlers: RenderHandlers = useMemo(() => ({ doc: shownDoc, previewBase, showDiff, onlyChanges, markers, focusBlocks, writable: blocksWritable, diagramStore, visualizers, ...stableHandlers }),
    [shownDoc, previewBase, showDiff, onlyChanges, markers, focusBlocks, blocksWritable, diagramStore, visualizers, stableHandlers]);
  const language = format ? FORMATS[format].highlight : "markdown";
  const codeHandlers: CodeHandlers = useMemo(() => ({ doc: shownDoc, language, wrap: prefs.wrap, numbers: prefs.numbers, writable: blocksWritable, markers, focusBlocks, closed, onFold: setFold,
    onRead: stableHandlers.onRead, onComment: (block: number) => stableHandlers.onComment(block, "block"), onReadRemoved: stableHandlers.onReadRemoved, onMarker: stableHandlers.onMarker }),
    [shownDoc, language, prefs.wrap, prefs.numbers, blocksWritable, markers, focusBlocks, closed, setFold, stableHandlers]);
  const treeHandlers: TreeHandlers = useMemo(() => ({ doc: shownDoc, language, showDiff, writable: blocksWritable, markers, focusBlocks, collapsed,
    onToggle: (block: number, open: boolean) => setCollapsed((groups) => { if (open) groups.delete(block); else groups.add(block); }),
    onCollapseInside: (block: number) => setCollapsed((groups) => {
      const blocksNow = getUi().view?.blocks ?? [];
      const prefix = JSON.stringify(metaRef.current[block]?.path ?? []).slice(0, -1);
      for (const entry of blocksNow) if (entry.type === "group" && entry.index > block && JSON.stringify(metaRef.current[entry.index]?.path ?? []).startsWith(prefix)) groups.add(entry.index);
    }),
    onRead: stableHandlers.onRead, onReadSection: stableHandlers.onReadSection, onComment: (block: number) => stableHandlers.onComment(block, "block"),
    onReadRemoved: stableHandlers.onReadRemoved, onMarker: stableHandlers.onMarker, onExempt: (secret: MaskSecret) => setExempting(secret) }),
    [shownDoc, language, showDiff, blocksWritable, markers, focusBlocks, collapsed, setCollapsed, stableHandlers]);
  const tableHandlers: TableHandlers = useMemo(() => ({ doc: shownDoc, writable: blocksWritable, markers, focusBlocks,
    onRead: stableHandlers.onRead, onComment: (block: number) => stableHandlers.onComment(block, "block"), onReadRemoved: stableHandlers.onReadRemoved, onMarker: stableHandlers.onMarker,
    onCommentText: stableHandlers.onCommentText }),
    [shownDoc, blocksWritable, markers, focusBlocks, stableHandlers]);
  // Pretty views of other formats need the metadata of the shown blocks (from the fast path); without it — the blocks as text.
  const hasMeta = Boolean(view && view.blocks.length && meta[view.blocks[0].index] !== undefined);

  if (route.kind === "none") {
    return <div className="h-full overflow-y-auto" data-dr data-docs-page><ContextList onPick={(next) => go(next)} /></div>;
  }

  const handlers: RenderHandlers = {
    doc: doc ?? "", previewBase, showDiff, onlyChanges, markers, focusBlocks, writable: blocksWritable,
    openDoc, openUrl: (url) => { if (!navigate.openUrl(url)) window.open(url, "_blank", "noopener,noreferrer"); },
    onRead: (block) => void acknowledge({ scope: "block", blocks: view ? changeRun(view, block) : [block] }),
    onReadSection: (block) => void acknowledge({ scope: "section", heading: block }),
    onComment: (block, kind) => openComposer(kind === "section" ? { kind: "section", block, quote: blocks[block].text } : { kind, block, quote: blocks[block].text.slice(0, 200) }, blockRect(block)),
    onCommentText: (range, quote, rect) => openComposer({ kind: "text", range, quote: quote.slice(0, 200) }, rect),
    onCommentElement: (block, element) => openComposer({ kind: "block", block, quote: tr(`${element.kind === "edge" ? "link" : element.kind === "group" ? "group" : "node"} “${element.label}”`, `${element.kind === "edge" ? "связь" : element.kind === "group" ? "группа" : "узел"} «${element.label}»`).slice(0, 200), element }, blockRect(block)),
    onReadRemoved: (tombstoneId) => void acknowledge({ scope: "block", blocks: [], tombstones: [tombstoneId] }),
    onCommentRemoved: (tombstoneId, quote) => openComposer({ kind: "change", tombstoneId, quote }, null),
    onMarker: (annotationId) => { setUi({ focusAnnotation: annotationId, focusNonce: getUi().focusNonce + 1 }); openComments(); },
  };

  // Stable handler functions that call the latest ones: memoized blocks never keep a stale closure (W-06a).
  liveHandlers.current = handlers;


  const drafts = view && doc ? draftsOf(key, doc) : [];
  const machineName = tree?.machine.name ?? batchInfo?.machine.name ?? view?.context.root ?? "…";
  const rootName = (view?.context.root ?? tree?.root ?? "").split("/").pop() ?? "";
  const branch = view?.context.branch ?? tree?.branch ?? "—";
  const commentsCount = view?.annotations.filter((annotation) => annotation.status === "open" || annotation.conflicts.length > 0).length ?? 0;
  const showColumn = !embedded && !hosted;
  const columnOpen = columnPref === "open" || (columnPref === "auto" && pageWidth >= 840);
  const contextShown = !narrow && (embedded ? true : width !== "compact");
  const identity = view?.context.identity.name ? `${view.context.identity.name} · ${view.context.identity.email ?? tr("no email", "без email")}` : tr("author not set", "автор не задан");
  const writable = settled && !outsideGit && Boolean(view?.context.writable);
  const openInDocs = () => {
    // H3: the same document and position in the full screen.
    if (doc && anchorRef.current) rememberPlace(key, doc, anchorRef.current);
    navigate.toPluginPanel(PANEL_PATH, { subPath: subPathOf(route) });
  };
  const startChanges = () => setUi({ passMode: "changes", passKey: null, passNonce: getUi().passNonce + 1 });

  // While the full view is on its way: the rail on the header's seam moves (static under reduced motion) and a polite
  // status says so; counters show «…» instead of a zero that is not known yet (EP-027-T08).
  const header = <header ref={headerRef} className="dr-hdr" data-dr-sticky="top" data-dr-header data-loading={loadingMarks ? "" : undefined}>
    <OpeningFeedback ctxKey={key} doc={doc} headerRef={headerRef} dimRef={dimRef} keyHint={keyHint} />
    <div className="dr-hdr__row">
      {showColumn && <IconButton icon={columnOpen ? "PanelLeftClose" : "PanelLeftOpen"} label={columnOpen ? tr("Hide tree", "Скрыть дерево") : tr("Show tree", "Показать дерево")} onClick={() => setColumnPref(columnOpen ? "closed" : "open")} />}
      {embedded && <IconButton icon="PanelLeftOpen" label={tr("Documents tree", "Дерево документов")} aria-expanded={embeddedTree} onClick={() => setEmbeddedTree(!embeddedTree)} />}
      <nav aria-label={tr("Path", "Путь")} className="dr-crumb">
        {contextShown && !embedded && <ContextSwitch current={key} onPick={go} hint={`${machineName} · ${view?.context.root ?? tree?.root ?? ""} · ${identity}`}
          label={<span data-context-label className="dr-trunc">{rootName}<span className="dr-crumb__sep"> › </span>{branch}</span>} />}
        {contextShown && embedded && <span className="dr-meta dr-trunc" data-context-label>{rootName}<span className="dr-crumb__sep"> › </span>{branch}</span>}
        {/* The separator after project/branch is present at every width where checkout context is visible, even when the path is hidden. */}
        {contextShown && <span className="dr-crumb__sep" aria-hidden data-crumb-sep> › </span>}
        <DocName ctxKey={key} doc={doc} wide={width === "wide"} />
      </nav>
      {view && <>
        {/* A compact column keeps only the view of the file in the header; the other view toggles go to «⋯». */}
        {!embedded && !narrow && width !== "compact" && <>
          <ToggleButton pressed={showDiff} onChange={(next) => setUi({ showDiff: next })} icon="Diff" label={VERB.diff.button} hint={VERB.diff.hint} keys="D" labelClass={width === "wide" ? "dr-label-xl" : "dr-sr"} />
          <ToggleButton pressed={onlyChanges} onChange={(next) => setUi({ onlyChanges: next })} icon="ListFilter" label={VERB.onlyChanges.button} labelClass={width === "wide" ? "dr-label-xl" : "dr-sr"} />
          <ToggleButton pressed={fullWidth} onChange={setFullWidth} icon="UnfoldHorizontal" label={tr("Full width", "Во всю ширину")} hint={tr("Document at full column width", "Документ во всю ширину колонки")} keys="W" labelClass="dr-sr" attrs={{ "data-full-width": "" }} />
        </>}
        {!narrow && format && <ToggleButton pressed={raw} onChange={setRaw} icon="CodeXml" label={tr("Raw", "Как есть")} hint={raw ? tr("Raw: the source text (V: “Pretty”)", "Как есть — исходный текст (V — «Красиво»)") : tr("Raw: the source text of the file", "Как есть — исходный текст файла")} keys="V" labelClass={width === "wide" ? "dr-label-xl" : "dr-sr"} attrs={{ "data-view-raw": "" }} />}
        {!narrow && width !== "compact" && raw && <ToggleButton pressed={prefs.wrap} onChange={setWrap} icon="WrapText" label={tr("Wrap lines", "Перенос строк")} keys="Z" labelClass="dr-sr" attrs={{ "data-wrap": "" }} />}
        {!narrow && (format || (!embedded && width !== "compact")) && <span className="dr-vsep" aria-hidden />}
        {!narrow && <Tip label={tr("Walk through changes", "Пройти по изменениям")}><button type="button" className="dr-cbtn" onClick={startChanges} disabled={!settled} aria-label={settled ? tr(`Changes: ${view.unread}`, `Изменения: ${view.unread}`) : tr("Changes: loading", "Изменения: загружаются")}><Icon name="Diff" />{width === "wide" && <span>{tr("Changes", "Изменения")}</span>}<b>{settled ? num(view.unread) : "…"}</b></button></Tip>}
        <Tip label={tr("Open “Comments”", "Открыть «Замечания»")}><button type="button" className="dr-cbtn" onClick={openComments} aria-label={settled ? tr(`Comments: ${commentsCount}`, `Замечания: ${commentsCount}`) : tr("Comments: loading", "Замечания: загружаются")}><Icon name="MessageSquare" />{width === "wide" && <span>{tr("Comments", "Замечания")}</span>}<b>{settled ? num(commentsCount) : "…"}</b></button></Tip>
        {!narrow && <span className="dr-vsep" aria-hidden />}
        {!narrow && writable && <IconButton icon="MessageSquarePlus" label={tr("Comment on the document", "Замечание к документу")} onClick={() => openComposer({ kind: "document", quote: doc ?? "" }, null)} />}
        {!narrow && writable && view.unread > 0 && <Tip label={tr("Mark the document read (can be undone)", "Документ прочитан — можно отменить")}><Button variant="ghost" aria-label={VERB.readDoc.hint} onClick={() => void acknowledge({ scope: "document" })}><Icon name="CheckCheck" />{width === "wide" && <span className="dr-label-xl">{VERB.readDoc.button}</span>}</Button></Tip>}
        <FileInfoButton key={`${key}:${doc}`} view={view} />
        {doc && !view.document.missing && <SendButton doc={doc} compact={narrow} />}
      </>}
      <Menu>
        <Tip label={MORE}><MenuTrigger asChild><Button variant="ghost" size="icon" aria-label={MORE}><Icon name="Ellipsis" /></Button></MenuTrigger></Tip>
        <MenuContent align="end" mobileTitle={tr("Document", "Документ")}>
          {view && width === "compact" && <>
            {!embedded && <MenuCheck checked={showDiff} onCheckedChange={(next) => setUi({ showDiff: Boolean(next) })}><Icon name="Diff" />{VERB.diff.hint}<Kbd>D</Kbd></MenuCheck>}
            {!embedded && <MenuCheck checked={onlyChanges} onCheckedChange={(next) => setUi({ onlyChanges: Boolean(next) })}><Icon name="ListFilter" />{VERB.onlyChanges.button}</MenuCheck>}
            {!embedded && <MenuCheck checked={fullWidth} onCheckedChange={(next) => setFullWidth(Boolean(next))}><Icon name="UnfoldHorizontal" />{tr("Full width", "Во всю ширину")}<Kbd>W</Kbd></MenuCheck>}
            {raw && <MenuCheck checked={prefs.wrap} onCheckedChange={(next) => setWrap(Boolean(next))}><Icon name="WrapText" />{tr("Wrap lines", "Перенос строк")}<Kbd>Z</Kbd></MenuCheck>}
            <MenuSeparator />
          </>}
          {view && narrow && <>
            {!embedded && <MenuCheck checked={showDiff} onCheckedChange={(next) => setUi({ showDiff: Boolean(next) })}><Icon name="Diff" />{VERB.diff.hint}</MenuCheck>}
            {!embedded && <MenuCheck checked={onlyChanges} onCheckedChange={(next) => setUi({ onlyChanges: Boolean(next) })}><Icon name="ListFilter" />{VERB.onlyChanges.button}</MenuCheck>}
            {format && <MenuCheck checked={raw} onCheckedChange={(next) => setRaw(Boolean(next))}><Icon name="CodeXml" />{tr("Raw", "Как есть")}</MenuCheck>}
            {raw && <MenuCheck checked={prefs.wrap} onCheckedChange={(next) => setWrap(Boolean(next))}><Icon name="WrapText" />{tr("Wrap lines", "Перенос строк")}</MenuCheck>}
            <MenuSeparator />
            <MenuItem onSelect={startChanges}><Icon name="Diff" />{tr("Changes", "Изменения")} · {num(view.unread)}</MenuItem>
            {writable && <MenuItem onSelect={() => openComposer({ kind: "document", quote: doc ?? "" }, null)}><Icon name="MessageSquarePlus" />{tr("Comment on the document", "Замечание к документу")}</MenuItem>}
            {writable && view.unread > 0 && <MenuItem onSelect={() => void acknowledge({ scope: "document" })}><Icon name="CheckCheck" />{VERB.readDoc.hint}</MenuItem>}
            <MenuSeparator />
          </>}
          {embedded && <MenuItem onSelect={openInDocs}><Icon name="Maximize2" />{tr("Open in “Documents”", "Открыть в «Документах»")}</MenuItem>}
          {!embedded && (narrow || width === "compact") && <MenuItem onSelect={() => go({ kind: "none" })}><Icon name="FolderGit2" />{tr("Switch checkout", "Сменить рабочую копию")}</MenuItem>}
          {raw && <MenuCheck checked={prefs.numbers} onCheckedChange={(next) => setNumbers(Boolean(next))}><Icon name="ListOrdered" />{tr("Line numbers", "Номера строк")}</MenuCheck>}
          {((raw && source && source.folds.length > 0) || (!raw && pretty === "keytree")) && <MenuItem onSelect={() => foldEverything(true)}><Icon name="ChevronsDownUp" />{tr("Collapse all", "Свернуть всё")}<Kbd>⇧ [</Kbd></MenuItem>}
          {((raw && source && source.folds.length > 0) || (!raw && pretty === "keytree")) && <MenuItem onSelect={() => foldEverything(false)}><Icon name="ChevronsUpDown" />{tr("Expand all", "Развернуть всё")}<Kbd>⇧ ]</Kbd></MenuItem>}
          {view?.context.enabled && <MenuItem onSelect={openSettings}><Icon name="Settings" />{tr("Review settings", "Настройки обзора")}</MenuItem>}
          <MenuItem onSelect={() => setLegendOpen(true)}><Icon name="Info" />{tr("Legend", "Обозначения")}</MenuItem>
          <MenuItem onSelect={() => setKeysOpen(true)}><Icon name="Keyboard" />{tr("Keyboard shortcuts", "Клавиши")}</MenuItem>
        </MenuContent>
      </Menu>
      {embedded && !narrow && <Tip label={tr("Open this document on the “Documents” screen at the same place", "Открыть этот документ на экране «Документы» на том же месте")}><Button variant="ghost" onClick={openInDocs}><Icon name="Maximize2" />{tr("In Documents", "В Документах")}</Button></Tip>}
    </div>
  </header>;

  const commentsAsSheet = pageWidth < 880;
  return <div ref={pageRef} className="dr-page" data-docs-page data-dr>
    {/* Without the sidebar-tabs host the tree is a collapsible column of the screen (H2 fallback, AC24). */}
    {embedded && (embeddedTree || !doc) && <aside className="dr-column" aria-label={tr("Documents of the checkout", "Документы рабочей копии")} data-embedded-tree>
      <DocsTree compact navigateTo={(next) => { setEmbeddedTree(false); go(next); }} />
    </aside>}
    {showColumn && columnOpen && <aside className="dr-column" aria-label={tr("Documents of the checkout", "Документы рабочей копии")} data-fallback-column>
      <DocsTree />
    </aside>}
    <div ref={mainRef} className="dr-main">
      <div ref={scrollRef} className="dr-scroll" data-dr-scroll onMouseUp={() => setTimeout(captureSelection, 0)}
        onTouchEnd={() => setTimeout(captureSelection, 350)}
        onFocus={(event) => {
          const target = event.target as Element;
          const scroll = scrollRef.current;
          // React also bubbles focus from portalled menus/sheets; those do not belong to the reading scroll area.
          if (scroll?.contains(target) && !target.closest("[data-dr-sticky], .dr-composer")) keepFocusVisible(scroll, target);
        }}
        onKeyUp={(event: ReactKeyboardEvent) => { if (event.shiftKey) captureSelection(); }}>
        {header}
        {pendingView && <div className="dr-doc" style={{ paddingBottom: 0, position: "sticky", top: "var(--dr-header-h)", zIndex: 4 }} data-dr-sticky="top">
          <div className="dr-doc__lead" style={{ paddingTop: 8 }}>
            <Banner icon="RefreshCw" role="status" sticky actions={<Button size="sm" onClick={() => { captureAnchor(); setUi({ view: rawUi().pendingView, pendingView: null }); }}>{tr("Show", "Показать")}</Button>}>
              {tr("The document was updated. The shown version is kept while you select or write.", "Документ обновлён — показанная редакция удерживается, пока вы выделяете или пишете.")}
            </Banner>
          </div>
        </div>}
        <div className={`dr-doc${embedded ? " dr-doc--wide" : fullWidth ? " dr-doc--full" : ""}`} data-dr-width={embedded ? "panel" : fullWidth ? "full" : "measure"}>
          <div ref={leadRef} className="dr-doc__lead" style={{ paddingTop: 8 }}>
            <DocBanners view={view} viewError={viewError} onEnable={setEnableReason} onRetry={() => (doc ? loadView(doc, { force: true }) : Promise.resolve())} />
            {!composer && <Drafts drafts={drafts} sha={view?.document.sha} onOpen={(draft) => draft.target.kind !== "reply" && setComposer({ target: draft.target, anchor: anchorFor(null), sha: draft.sha })} />}
            <WaitingBlock onPass={startPass} narrow={narrow} />
          </div>
          {!doc && <div className="dr-doc__lead"><Banner icon="FileText" tone="quiet">{tr("Choose a document in the tree.", "Выберите документ в дереве.")}</Banner></div>}
          {doc && !view && loading && <DocSkeleton />}
          <div ref={dimRef} className="relative">
            <article ref={bodyRef} aria-label={doc ?? tr("document", "документ")} data-dr-phase={view ? viewPhase : undefined} data-dr-large={(textInfo?.total ?? blocks.length) > LARGE_DOCUMENT || undefined} aria-busy={loadingMarks || (!progressive.complete && !progressive.windowed) || undefined} data-dr-windowed={progressive.windowed || undefined}
              onClick={(event) => {
                if (!view || window.getSelection()?.isCollapsed === false) return;
                // Touch (H6): a tap selects the block and shows its actions; its comments open from the gutter marker,
                // so a tap never covers the document with the comments panel on a phone.
                if (window.matchMedia?.("(hover: none)").matches) return;
                const cp = cpAtPoint(event.clientX, event.clientY, view.blocks);
                if (cp === null) return;
                const hit = view.annotations.find((annotation) => annotation.status === "open" && annotation.anchor.ranges.some((range) => cp >= range.start && cp < range.end));
                if (hit) { setUi({ focusAnnotation: hit.annotationId, focusNonce: getUi().focusNonce + 1 }); openComments(); }
              }}>
              {view && progressive.above > 0 && <div aria-hidden className="dr-spacer" style={{ height: progressive.above }} data-dr-spacer="above" />}
              {view && !raw && pretty === "keytree" && hasMeta && <KeyTree blocks={progressive.shown} meta={meta} removed={view.removed} secrets={view.secrets} handlers={treeHandlers} />}
              {view && !raw && pretty === "table" && hasMeta && format === "dotenv" && <EnvTable blocks={progressive.shown} meta={meta} removed={view.removed} secrets={view.secrets} handlers={tableHandlers} />}
              {view && !raw && pretty === "table" && hasMeta && format !== "dotenv" && <CsvTable blocks={progressive.shown} meta={meta} removed={view.removed} delimiter={format === "tsv" ? "\t" : ","} handlers={tableHandlers} />}
              {view && !raw && (pretty === "markdown" || pretty === "paragraphs" || !hasMeta) && <DocumentBody blocks={progressive.shown} removed={view.removed} handlers={renderHandlers} />}
              {view && raw && source && source.sha === view.document.sha && <CodeView blocks={view.blocks} removed={view.removed} secrets={view.secrets} parseError={view.parseError} source={source} handlers={codeHandlers} />}
              {view && raw && sourceError && <Banner icon="TriangleAlert" tone="error" actions={<Button size="sm" onClick={() => { forgetSource(key, view.document.path, view.document.sha); setRaw(true); }}>{tr("Retry", "Повторить")}</Button>}>{tr("The “Raw” view did not load", "Вид «Как есть» не загрузился")}: {sourceError}</Banner>}
              {view && raw && !sourceError && (!source || source.sha !== view.document.sha) && <DocSkeleton />}
              {view && progressive.below > 0 && <div aria-hidden className="dr-spacer" style={{ height: progressive.below }} data-dr-spacer="below" />}
            </article>
            {selection && !composer && settled && view?.context.writable !== false && !(view?.fileClass === "outside" && view.scope !== "local") && <div className="dr-selbtn" style={{ top: selection.anchor.top, left: selection.anchor.left }}>
              <Tip label={tr("Comment on the selection, or just start typing", "Замечание к выделенному — или просто начните печатать")} keys="C">
                <Button variant="primary" size="sm" onClick={() => openComposer({ kind: "text", range: selection.range, quote: selection.quote }, null)}><Icon name="MessageSquarePlus" />{VERB.comment.button} <Kbd>C</Kbd></Button>
              </Tip>
            </div>}
            {composer && doc && <Composer state={composer} doc={doc} onClose={() => setComposer(null)} />}
          </div>
        </div>
        {view && settled && <PassBar stops={stops} index={passIndex} mode={passMode} scope={passScope} docs={passDocs} docIndex={docIndex} narrow={narrow}
          onMode={(mode) => setUi({ passMode: mode, passKey: null, passNonce: getUi().passNonce + 1 })}
          onScope={(scope) => setUi({ passScope: scope, passKey: null })}
          onMove={moveStop} onRead={readStop} onAccept={acceptStop} onReply={replyStop} />}
      </div>
    </div>
    {embedded && commentsOpen && !commentsAsSheet && <aside className="dr-side" aria-label={tr("Comments", "Замечания")}>
      <div className="dr-side__head"><b className="dr-grow text-[13px] font-semibold">{tr("Comments", "Замечания")}</b>
        <IconButton icon="X" label={tr("Close comments", "Закрыть замечания")} onClick={() => setCommentsOpen(false)} /></div>
      <div className="min-h-0 flex-1"><CommentsTab /></div>
    </aside>}
    {embedded && commentsOpen && commentsAsSheet && <CommentsSheet onClose={() => setCommentsOpen(false)} />}
    <EnableDialog reason={enableReason} onClose={() => setEnableReason(null)} />
    <KeysDialog open={keysOpen} onClose={() => setKeysOpen(false)} />
    <LegendDialog open={legendOpen} onClose={() => setLegendOpen(false)} />
    <SettingsHost />
    {exempting && view && <ExemptDialog doc={view.document.path} secret={view.secrets.find((secret) => secret.place === exempting.place) ?? null} fileClass={view.fileClass} onClose={() => setExempting(null)} />}
  </div>;
}
