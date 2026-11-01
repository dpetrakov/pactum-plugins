// The embedded-object frame is shared by every visualizer: one toolbar with type,
// Diagram/Code icon toggles, Reset for a personal layout, Compare
// (on by default; the base and the list of changes in its menu), «Copy», zoom and «Full screen»; explanations
// live in the hints of the controls, rows below the bar only for states with an action (a failed save, conflicts of
// machines, lost annotations) and errors. Moving is always on where the layout is stored; the element's menu (right
// click, long press, Shift+F10) resets one element. Then the hidden list for screen readers and the canvas slot the
// visualizer renders into. The frame knows no diagram type: everything comes through the visualizers contract.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type TouchEvent } from "react";
import { createPortal } from "react-dom";
import type { DiagramBase, DiagramPrevious } from "../node/view.ts";
import type { A11yItem, Candidate, CanvasActions, CanvasHandle, CanvasProps, CanvasReport, CanvasSlot, ElementInfo, ElementKind, MatchContext, ObjectDiff, ParseFailure, Point } from "../visualizers-contract.ts";
import { blockKey, setView, useEmbeddedView, type EmbeddedView } from "./embedded-view.ts";
import { copyText } from "./copy.tsx";
import { Icon } from "./icons.tsx";
import { Kbd, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Popover, PopoverContent, PopoverTrigger, Spinner, Tip } from "./kit.tsx";
import { notify } from "./store.ts";
import { auditCanvas, sanitizeSvg } from "./svg-sanitize.ts";
import { blockVisualizer, pickVisualizer, publishCanvas, useVisualizersVersion } from "./visualizers.ts";
import { forms, locale, tr } from "../core/i18n.ts";
import { W, counted, plural } from "./words.ts";

/** What the object needs from the page: the stored positions of this reader and the write of a finished gesture (EP-060). */
export type ObjectStore = {
  pins: Record<string, Point>;
  /** null — layout is not stored here (read-only, no identity, outside a review); the reason is shown. */
  readOnly: string | null;
  saving: boolean;
  error: string | null;
  /** Elements moved differently on two machines of the reader: shown at the automatic place until one is chosen. */
  conflicts?: { node: string; candidates: (Point | null)[] }[];
  /** The block's previous version in the journal (EP-061-T01) — the default base of «Changes». */
  previous?: DiagramPrevious;
  commit(nodes: Record<string, Point>, reset?: string[], engine?: string): void;
  retry(): void;
};
/** «Changes» on an object: both bases, as the page gives them; the frame shows one chosen base in «Diagram» and «Code». */
export type ObjectCompare = { reading: string | null; unclear: boolean; previous: DiagramPrevious | null };
/** An element of the object to comment on (EP-073-T08): the visualizer's id and words, stored with the annotation. */
export type ObjectElement = { id: string; kind: ElementKind; label: string; range?: { line: number; start: number; end: number } };
/** The owner's annotations of this block, as the page keeps them (a stable array per view); only those with an element count here. */
export type ElementAnnotation = { annotationId: string; element: { id: string; kind: ElementKind; label: string } | null; waiting: boolean };
const EMPTY_POSITIONS: Record<string, Point> = {};
const NO_ANNOTATIONS: ElementAnnotation[] = [];

const VIEW_ITEMS: { value: EmbeddedView; icon: string; label: string }[] = [{ value: "diagram", icon: "Workflow", label: tr("Diagram", "Схема") }, { value: "code", icon: "CodeXml", label: tr("Code", "Код") }];
const KIND_WORD: Record<string, string> = { node: tr("node", "узел"), edge: tr("edge", "связь"), group: tr("group", "группа"), text: tr("text", "текст"), other: tr("element", "элемент") };
const NODES = forms(["node", "nodes"], ["узел", "узла", "узлов"]);
const EDGES = forms(["edge", "edges"], ["связь", "связи", "связей"]);
const NO_CANVAS_ANNOTATIONS: CanvasProps["annotations"] = {};
const KIND_TO: Record<string, string> = { node: tr("on node", "к узлу"), edge: tr("on edge", "к связи"), group: tr("on group", "к группе"), text: tr("on text", "к тексту"), other: tr("on element", "к элементу") };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : tr("time unknown", "время неизвестно"));
const NO_PREVIOUS: Record<string, string> = {
  added: tr("The diagram first appears in this version of the document, it has no previous version.", "Схема появилась в этой версии документа — прошлой версии у неё нет."),
  "no-history": tr("The review data has no previous version of the diagram.", "Прошлой версии схемы в данных обзора нет."),
  unavailable: tr("The previous version of the diagram is unavailable: the review data has no snapshot of it.", "Прошлая версия схемы недоступна: нет её снимка в данных обзора."),
  far: tr("The previous version of the diagram is more than 64 document revisions old. Compare with your last read instead.", "Прошлая версия схемы старше 64 редакций документа — сравните с вашим прочтением."),
};

const AUDIT_TAIL = () => tr(": turned off until you turn it on again in “Review settings”. Showing the code.", " — выключен до включения в «Настройках обзора». Показан код.");

/** A radiogroup in the design-system segment `.dr-seg` (arrows move the choice). */
export function Segmented<T extends string>({ label, value, items, onChange, iconOnly = false }: { label: string; value: T; items: { value: T; icon?: string; label: string; title?: string }[]; onChange(next: T): void; iconOnly?: boolean }) {
  const keys = (event: KeyboardEvent) => {
    const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : 0;
    if (!step) return;
    event.preventDefault();
    const at = items.findIndex((item) => item.value === value);
    const next = items[at < 0 ? 0 : (at + step + items.length) % items.length].value;
    onChange(next);
    ((event.currentTarget as HTMLElement).querySelector(`[data-value="${next}"]`) as HTMLElement | null)?.focus();
  };
  return <div role="radiogroup" aria-label={label} className="dr-seg" onKeyDown={keys}>
    {items.map((item, i) => {
      const button = <button key={item.value} type="button" role="radio" aria-checked={value === item.value} title={iconOnly ? undefined : item.title} aria-label={iconOnly ? item.label : undefined}
        tabIndex={value === item.value || (i === 0 && !items.some((other) => other.value === value)) ? 0 : -1}
        data-value={item.value} data-view={item.value} className={`dr-seg__item${iconOnly ? " dr-seg__item--icon" : ""}`} onClick={() => onChange(item.value)}>{item.icon && <Icon name={item.icon} />}{!iconOnly && item.label}</button>;
      return iconOnly ? <Tip key={item.value} label={item.title ?? item.label}>{button}</Tip> : button;
    })}
  </div>;
}

/** Is the element within a screen of the viewport? Once true it stays (the canvas is not torn down on scroll). */
function useNear(): [(element: HTMLDivElement | null) => void, boolean] {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  const observer = useRef<IntersectionObserver | null>(null);
  const ref = useCallback((element: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (!element || typeof IntersectionObserver === "undefined") return;
    observer.current = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { setNear(true); observer.current?.disconnect(); } }, { rootMargin: "100% 0px" });
    observer.current.observe(element);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, near];
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const themeOf = (element: Element | null): "light" | "dark" => (element && getComputedStyle(element).colorScheme.includes("dark") ? "dark" : "light");

/** Accessible file-change list from the visualizer diff, including removals the canvas may not display. It lives in the Compare menu. */
function DiffList({ diff }: { diff: ObjectDiff }) {
  const sign = (change: string) => (change === "added" ? "+" : change === "changed" ? "~" : "−");
  return <ul className="dr-obj__list dr-obj__diff">{diff.items.map((item) => <li key={`${item.change}${item.id}`} className={item.change === "removed" ? "dr-obj__removed" : undefined}>
    <span className={`dr-obj__chg dr-obj__chg--${item.change}`}>{sign(item.change)}</span> {KIND_WORD[item.kind] ?? item.kind} {tr(`“${item.label}”`, `«${item.label}»`)}
    {item.fields?.length ? `: ${item.fields.join(", ")}` : ""}{item.before !== undefined ? <>{tr(" (before: “", " (было «")}<s>{item.before}</s>{tr("”)", "»)")}</> : null}
  </li>)}</ul>;
}

/** Visually hidden list of elements for screen readers (the canvas is an image to them). */
function Description({ items, marks }: { items: A11yItem[]; marks: Record<string, string> | null }) {
  const word = (id: string) => (marks?.[id] === "added" ? tr(", added", " — добавлено") : marks?.[id] === "changed" ? tr(", changed", " — изменено") : "");
  const of = (kind: string) => items.filter((item) => item.kind === kind);
  return <div data-skip className="dr-sr">
    {of("group").length > 0 && <><p>{tr("Groups:", "Группы:")}</p><ul>{of("group").map((item) => <li key={item.id}>{item.label}{word(item.id)}</li>)}</ul></>}
    <p>{tr("Nodes:", "Узлы:")}</p><ul>{of("node").map((item) => <li key={item.id}>{item.label}{item.detail ? ` (${item.detail})` : ""}{word(item.id)}</li>)}</ul>
    <p>{tr("Edges:", "Связи:")}</p><ul>{of("edge").map((item) => <li key={item.id}>{item.label}{item.detail ? ` «${item.detail}»` : ""}{word(item.id)}</li>)}</ul>
  </div>;
}

const safe = <T,>(what: string, id: string, run: () => T): T | { failed: string } => {
  try { return run(); } catch (error) { console.warn(`[docs-visualizers] ${id}.${what} failed`, error); return { failed: error instanceof Error ? error.message : String(error) }; }
};
const failed = (value: unknown): value is { failed: string } => typeof value === "object" && value !== null && "failed" in value;

/** The whole embedded object: the frame of the host and the canvas of the chosen visualizer. */
export const ObjectBlock = memo(function ObjectBlock({ source, doc, lineage, language, kind = "fence", code, store, compare = null, renderDiff, annotations = NO_ANNOTATIONS, writable = false, onComment, onMarker }: {
  source: string; doc: string; lineage: string; language: string | null; kind?: "fence" | "file"; code: ReactNode; store?: ObjectStore;
  compare?: ObjectCompare | null;
  annotations?: ElementAnnotation[];
  writable?: boolean;
  /** «Comment on node» (C) on the selected element. */
  onComment?(element: ObjectElement): void;
  /** A marker of an element's annotations was pressed. */
  onMarker?(annotationId: string): void;
  /** The code with a word diff against another base than the reader's (the page's diff renderer, no data-text). */
  renderDiff?(base: DiagramBase): ReactNode;
}) {
  const version = useVisualizersVersion();
  const context = useMemo((): MatchContext => ({ kind, language: language?.toLowerCase() ?? null, path: doc }), [kind, language, doc]);
  const candidate: Candidate | null = useMemo(() => pickVisualizer(source, context), [source, context, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const registration = candidate?.entry.registration ?? null;
  const key = useMemo(() => blockKey(doc, lineage), [doc, lineage]);
  const view = useEmbeddedView(key);
  const [failure, setFailure] = useState<ParseFailure | { reason: "crash" | "audit"; message: string } | null>(null);
  const [report, setReport] = useState<CanvasReport | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [full, setFull] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);
  const [observeNear, near] = useNear();
  const nearRef = useCallback((element: HTMLDivElement | null) => { observeNear(element); if (element) inlineRef.current = element; }, [observeNear]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const fullRef = useRef<HTMLDivElement>(null);
  const fullButtonRef = useRef<HTMLButtonElement>(null);
  const inlineRef = useRef<HTMLDivElement | null>(null);
  const placeholder = useRef(0);
  const host = useRef<HTMLElement | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const lastTitle = useRef("");
  if (registration) lastTitle.current = registration.title;
  useLayoutEffect(() => { setTheme(themeOf(slotRef.current)); });
  useEffect(() => { setFailure((current) => (current?.reason === "audit" ? current : null)); setReport(null); }, [source, registration]);

  // The comparison defaults to Previous version; Since your last read is optional. A merge asks which parent to use.
  const previous = compare?.previous ?? null;
  const [chosenKind, setBaseKind] = useState<"previous" | "reading" | null>(null);
  // Default to Previous version, then fall back to the reader base if it contains changes.
  const baseKind: "previous" | "reading" = chosenKind ?? (!previous || previous.kind === "none" ? (compare?.reading ? "reading" : "previous") : "previous");
  const [compareOn, setCompareOn] = useState(true);
  const [parent, setParent] = useState<string | null>(null);
  const chosenBase: DiagramBase | null = !compare || baseKind !== "previous" || !previous ? null
    : previous.kind === "version" ? previous.base : previous.kind === "merge" ? previous.candidates.find((entry) => entry.revisionId === parent) ?? null : null;
  const before = !compare ? null : baseKind === "reading" ? compare.reading : chosenBase?.text ?? null;
  const unclear = Boolean(compare && baseKind === "reading" && compare.unclear);
  const changes = useMemo(() => (before === null || !registration?.diff ? null : safe("diff", registration.id, () => registration.diff!(before, source, context))), [before, source, context, registration]);
  const diff: ObjectDiff | null = changes && !failed(changes) && "items" in changes ? changes : null;
  const marks = useMemo(() => (diff ? Object.fromEntries(diff.items.filter((item) => item.id !== "#direction").map((item) => [item.id, item.change])) : null), [diff]);
  const a11y = useMemo(() => (registration?.a11y ? safe("a11y", registration.id, () => registration.a11y!(source, context)) : null), [registration, source, context]);
  const items: A11yItem[] = Array.isArray(a11y) ? a11y : [];

  const readOnly = store?.readOnly ?? null;
  const layoutable = Boolean(registration?.capabilities.layout && registration.canvas === "interactive");
  const [localPins, setLocalPins] = useState<Record<string, Point>>(EMPTY_POSITIONS);
  // Identity matters: `props` and `actions` must change only when their values do, or the canvas is updated — and
  // reports — in a loop. The page may hand a new store object per render; its pins are stable per view.
  const storePins = store?.pins;
  const positions = store ? (storePins && Object.keys(storePins).length ? storePins : EMPTY_POSITIONS) : localPins;
  const storeRef = useRef(store);
  storeRef.current = store;
  const engineRef = useRef<string>("");
  engineRef.current = registration ? `${registration.id}@${registration.version}/${registration.engine}` : "";
  const commit = useCallback((nodes: Record<string, Point>, reset?: string[]) => {
    const current = storeRef.current;
    if (current) current.commit(nodes, reset, engineRef.current);
    else setLocalPins((before) => { const next = { ...before, ...nodes }; for (const id of reset ?? []) delete next[id]; return next; });
  }, []);
  const actions = useMemo((): CanvasActions => ({ commit, select: setSelected, report: setReport, fail: (reason) => setFailure(reason) }), [commit]);
  const byElement = useMemo(() => {
    const map: Record<string, { count: number; waiting: boolean; ids: string[] }> = {};
    for (const note of annotations) {
      if (!note.element) continue;
      const entry = (map[note.element.id] ??= { count: 0, waiting: false, ids: [] });
      entry.count += 1; entry.waiting ||= note.waiting; entry.ids.push(note.annotationId);
    }
    return map;
  }, [annotations]);
  const canvasAnnotations = useMemo(() => (Object.keys(byElement).length ? Object.fromEntries(Object.entries(byElement).map(([id, entry]) => [id, { count: entry.count, waiting: entry.waiting }])) : NO_CANVAS_ANNOTATIONS), [byElement]);
  const props = useMemo((): CanvasProps => ({
    source, context: { ...context, dialect: candidate?.match.dialect ?? "" }, theme, zoom, moving: layoutable && !readOnly, readOnly: readOnly !== null, positions, selected,
    compare: compare && compareOn && marks ? { base: before, marks: marks as CanvasProps["compare"] extends infer C ? C extends { marks: infer M } ? M : never : never } : null,
    annotations: canvasAnnotations, reducedMotion: reducedMotion(),
  }), [source, context, candidate, theme, zoom, layoutable, readOnly, positions, selected, compare, compareOn, marks, before, canvasAnnotations]);

  // The canvas: mounted once the block is near the screen and «Diagram» is chosen; updated on every change of props;
  // audited after every render; disposed when the view, the visualizer or the block goes.
  const showCanvas = Boolean(registration) && view === "diagram" && !failure;
  const handleRef = useRef<CanvasHandle | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  useEffect(() => {
    const element = slotRef.current;
    if (!showCanvas || !near || !element || !registration) return;
    const slot = (): CanvasSlot => ({ generation: 0, blockKey: key, element, props: propsRef.current, actions });
    let aborted = false;
    const audit = () => {
      const found = auditCanvas(element);
      if (!found.length) return;
      blockVisualizer(registration.id, found.join(", "));
      setFailure({ reason: "audit", message: found.join(", ") });
    };
    const observer = typeof MutationObserver === "function" ? new MutationObserver(() => audit()) : null;
    observer?.observe(element, { childList: true, subtree: true, attributes: true });
    if (registration.canvas === "interactive") {
      const mounted = safe("mount", registration.id, () => registration.mount!(slot()));
      if (failed(mounted)) { setFailure({ reason: "crash", message: mounted.failed }); return () => observer?.disconnect(); }
      handleRef.current = mounted;
      publishCanvas(key, slot());
      audit();
      return () => { aborted = true; observer?.disconnect(); publishCanvas(key, null); try { mounted.dispose(); } catch { /* a visualizer's bug must not break the document */ } handleRef.current = null; element.replaceChildren(); };
    }
    // Static: the visualizer gives SVG, the host sanitises and places it.
    const controller = new AbortController();
    registration.render!(propsRef.current.source, context, controller.signal).then((result) => {
      if (aborted) return;
      if (!("svg" in result)) { setFailure(result); return; }
      const clean = sanitizeSvg(result.svg);
      if (!clean) { setFailure({ reason: "crash", message: tr("the visualizer returned something other than SVG", "визуализатор вернул не SVG") }); return; }
      element.replaceChildren(clean.svg);
      clean.svg.setAttribute("width", String(Math.round(result.size.w * propsRef.current.zoom)));
      clean.svg.setAttribute("height", String(Math.round(result.size.h * propsRef.current.zoom)));
      setReport({ size: result.size, elements: result.elements, pinned: [] });
    }, (error) => { if (!aborted) setFailure({ reason: "crash", message: error instanceof Error ? error.message : String(error) }); });
    return () => { aborted = true; controller.abort(); observer?.disconnect(); element.replaceChildren(); };
  }, [showCanvas, near, registration, key, actions, context, full]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { handleRef.current?.update({ generation: 0, blockKey: key, element: slotRef.current!, props, actions }); }, [props, key, actions]);
  useEffect(() => {
    // Static SVG follows the zoom without a second render.
    const svg = registration?.canvas === "static" ? slotRef.current?.querySelector("svg") : null;
    if (svg && report) { svg.setAttribute("width", String(Math.round(report.size.w * zoom))); svg.setAttribute("height", String(Math.round(report.size.h * zoom))); }
  }, [zoom, registration, report]);

  // Entering full screen: focus the window and fit the diagram once it is measured; leaving: the zoom and the focus return.
  const zoomBefore = useRef(1);
  const longPressed = useRef(false);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const fitted = useRef(false);
  useEffect(() => {
    if (full) { fitted.current = false; fullRef.current?.focus({ preventScroll: true }); return; }
    if (fitted.current) { setZoom(zoomBefore.current); fitted.current = false; fullButtonRef.current?.focus({ preventScroll: true }); }
  }, [full]);
  // The window covers the page of «Documents», not bb around it: `fixed` may be relative to a host's transformed
  // ancestor, so the frame measures that containing block (inset 0) and places itself over the page's box.
  useLayoutEffect(() => {
    const element = fullRef.current;
    const page = inlineRef.current?.closest<HTMLElement>("[data-docs-page]");
    if (!full || !element || !page) return;
    const place = () => {
      Object.assign(element.style, { top: "0px", left: "0px", right: "0px", bottom: "0px", width: "", height: "" });
      const box = element.getBoundingClientRect(), target = page.getBoundingClientRect();
      Object.assign(element.style, { top: `${target.top - box.top}px`, left: `${target.left - box.left}px`, right: "auto", bottom: "auto", width: `${target.width}px`, height: `${target.height}px` });
    };
    place();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    observer?.observe(page);
    window.addEventListener("resize", place);
    return () => { observer?.disconnect(); window.removeEventListener("resize", place); };
  }, [full]);
  useEffect(() => {
    if (!full || fitted.current || !report || !canvasRef.current) return;
    fitted.current = true;
    const box = canvasRef.current;
    setZoom(Math.max(0.3, +Math.min((box.clientWidth - 2) / report.size.w, (box.clientHeight - 2) / report.size.h, 1.5).toFixed(2)));
  }, [full, report]);
  const lost = useMemo(() => annotations.filter((note) => note.element && report && !report.elements[note.element.id]), [annotations, report]);
  // The audit switched the visualizer off: it is no longer chosen, but this block says why it shows the code (D37).
  if (!registration) return failure?.reason === "audit" ? <div className="dr-obj" data-visualizer="">
    <div data-skip className="dr-banner dr-banner--error" role="alert"><Icon name="ShieldOff" /><span className="dr-banner__text"><b>{tr(`Visualizer “${lastTitle.current}” broke the security contract`, `Визуализатор «${lastTitle.current}» нарушил договор безопасности`)}</b> ({failure.message}){AUDIT_TAIL()}</span></div>
    {code}
  </div> : <>{code}</>;
  const pinned = report?.pinned ?? Object.keys(positions);
  const nameOf = (id: string) => report?.elements[id]?.label ?? items.find((item) => item.id === id)?.label ?? id;
  const fit = () => {
    const box = canvasRef.current;
    if (!report || !box?.clientWidth) return;
    const across = (box.clientWidth - 2) / report.size.w;
    // Full screen fits the whole diagram into the window; in the column — the width (the canvas scrolls down).
    const next = full ? Math.min(across, (box.clientHeight - 2) / report.size.h, 1.5) : Math.min(across, 1);
    setZoom(Math.max(0.3, +next.toFixed(2)));
  };
  const toggleFull = (next = !full) => {
    if (next) {
      const inline = inlineRef.current;
      placeholder.current = inline?.offsetHeight ?? 0;
      // Next to the document body (under the composer's layer), else the nearest root with the plugin's tokens.
      host.current = inline?.closest("article")?.parentElement ?? inline?.closest<HTMLElement>("[data-dr], [data-bb-plugin]") ?? document.body;
      zoomBefore.current = zoom;
    }
    setFull(next);
  };
  const resetAll = () => { if (!pinned.length) return; commit({}, pinned); };
  const choose = (next: EmbeddedView) => { setView(key, next); if (next === "code") { setSelected(null); setFull(false); } };
  const selectedInfo: ElementInfo | null = selected && report?.elements[selected] ? report.elements[selected] : null;
  const commentOn = (id: string, info: ElementInfo) => { if (onComment) onComment({ id, kind: info.kind, label: info.label, range: info.range }); };
  const commentSelected = () => { if (selectedInfo && selected) commentOn(selected, selectedInfo); };
  /** What «back to the automatic place» resets for an element: the node itself, or the moved nodes inside a group. */
  const pinnedOf = (id: string, info: ElementInfo): string[] => {
    if (info.kind !== "group") return pinned.includes(id) ? [id] : [];
    return pinned.filter((other) => { const box = report?.elements[other]; return box && box.kind === "node" && box.x >= info.x && box.y >= info.y && box.x + box.w <= info.x + info.w && box.y + box.h <= info.y + info.h; });
  };
  const openMenuAt = (x: number, y: number, id: string | null) => { if (id) setSelected(id); setMenu({ x: Math.min(x, window.innerWidth - 8), y, id }); };
  const onKey = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const typing = Boolean(target && target.closest("input, textarea, [contenteditable=true]"));
    if ((event.key === "c" || event.key === "C") && selectedInfo && writable && onComment && !event.metaKey && !event.ctrlKey && !event.altKey && !typing) { event.preventDefault(); event.stopPropagation(); commentSelected(); return; }
    // The element's menu from the keyboard (Shift+F10, the menu key) — at the selected element, else at the canvas.
    if (showCanvas && (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) && !typing && target?.closest(".dr-obj__canvas")) {
      event.preventDefault();
      const inner = innerRef.current?.getBoundingClientRect();
      if (selectedInfo && selected && inner) openMenuAt(inner.left + (selectedInfo.x + selectedInfo.w) * zoom, inner.top + (selectedInfo.y + selectedInfo.h) * zoom, selected);
      else { const box = canvasRef.current?.getBoundingClientRect(); if (box) openMenuAt(box.left + 24, box.top + 24, null); }
      return;
    }
    if (event.key === "Escape" && full && !event.defaultPrevented) { event.preventDefault(); setFull(false); }
    // Over the document the page's own keys (J/K, R, W…) would act on what is hidden under the window.
    if (full) event.stopPropagation();
  };
  // The element under a point of the canvas, by the geometry the visualizer reported (no knowledge of its drawing):
  // the smallest node or group around the point; a thin edge's box only when no node is there.
  const elementAt = (clientX: number, clientY: number): string | null => {
    const inner = innerRef.current?.getBoundingClientRect();
    if (!inner || !report) return null;
    const x = (clientX - inner.left) / zoom, y = (clientY - inner.top) / zoom;
    let found: string | null = null, area = Infinity;
    for (const [id, box] of Object.entries(report.elements)) {
      const pad = box.kind === "edge" ? 6 : 0;
      if (box.kind === "edge" && box.w > 12 && box.h > 12) continue;
      if (x < box.x - pad || y < box.y - pad || x > box.x + box.w + pad || y > box.y + box.h + pad) continue;
      const size = box.kind === "edge" ? Number.MAX_SAFE_INTEGER - 1 : box.w * box.h;
      if (size < area) { area = size; found = id; }
    }
    return found;
  };
  const onContextMenu = (event: MouseEvent) => {
    if (event.shiftKey) return; // Shift + right click — the browser's own menu.
    event.preventDefault();
    openMenuAt(event.clientX, event.clientY, elementAt(event.clientX, event.clientY));
  };
  // A long press on touch opens the same menu (iOS fires no contextmenu); moving the finger cancels it.
  const pressStart = (event: PointerEvent) => {
    if (event.pointerType !== "touch") return;
    const { clientX, clientY } = event;
    if (press.current) clearTimeout(press.current.timer);
    press.current = { x: clientX, y: clientY, timer: setTimeout(() => { press.current = null; const id = elementAt(clientX, clientY); if (id) { longPressed.current = true; openMenuAt(clientX, clientY, id); } }, 550) };
  };
  // The finger lifted after the menu opened: its synthetic click would land on the sheet's backdrop and close it.
  const pressRelease = (event: TouchEvent) => { if (longPressed.current) { longPressed.current = false; event.preventDefault(); } };
  const pressMove = (event: PointerEvent) => { const p = press.current; if (p && Math.hypot(event.clientX - p.x, event.clientY - p.y) > 8) { clearTimeout(p.timer); press.current = null; } };
  const pressEnd = () => { if (press.current) { clearTimeout(press.current.timer); press.current = null; } };
  const copySource = () => {
    void copyText(source).then(() => { setCopied(true); if (copiedTimer.current) clearTimeout(copiedTimer.current); copiedTimer.current = setTimeout(() => setCopied(false), 1500); },
      (error) => {
        const reason = error instanceof Error ? error.message : tr("clipboard unavailable", "буфер обмена недоступен");
        notify(tr(`Couldn't copy: ${reason}`, `Не удалось скопировать: ${reason}`), { tone: "error" });
      });
  };
  const title = `${registration.title}${candidate?.match.dialect && !registration.title.toLowerCase().includes(candidate.match.dialect.toLowerCase()) ? ` · ${candidate.match.dialect}` : ""}`;
  const unsupported = changes && !failed(changes) && "unsupported" in changes ? changes.unsupported : null;
  // Compare is enabled by default and pressable only when the chosen base contains changes; its hint explains unavailability.
  const counts = diff ? { added: diff.items.filter((item) => item.change === "added").length, changed: diff.items.filter((item) => item.change === "changed").length, removed: diff.items.filter((item) => item.change === "removed").length } : null;
  const hasChanges = Boolean(diff && diff.total > 0) || Boolean(view === "code" && chosenBase?.diff);
  const baseWord = baseKind === "reading" ? tr("against your last read", "с вашим прочтением") : previous?.kind === "version" ? tr(`against the previous version of ${when(previous.base.at)}`, `с прошлой версией от ${when(previous.base.at)}`) : tr("against the previous version", "с прошлой версией");
  const quietReason = !compare ? null
    : !registration.diff ? tr("This visualizer can't compare: see what changed in the “Code” view", "Визуализатор без сравнения: что поменялось, видно в виде «Код»")
    : baseKind === "previous" && !previous ? (readOnly ?? tr("The previous version of the diagram will appear once review is on and the document is saved in the review data", "Прошлая версия схемы появится, когда обзор включён и документ сохранён в данных обзора"))
    : baseKind === "previous" && previous?.kind === "none" ? NO_PREVIOUS[previous.reason]
    : baseKind === "previous" && previous?.kind === "merge" && !chosenBase ? tr("The diagram changed in two branches merged into this version: choose in the comparison menu which one to compare with", "Схема менялась в двух ветках, слитых в эту версию: выберите в меню сравнения, с какой сравнивать")
    : baseKind === "previous" && chosenBase && chosenBase.text === null ? tr("The diagram did not exist in this branch, it was added by the merge", "В этой ветке схемы не было — она добавлена слиянием")
    : baseKind === "reading" && unclear ? tr("Unclear read base: diagram changes are not matched, see what changed in the “Code” view", "Неясная база прочтения: изменения схемы не сопоставлены — что поменялось, видно в виде «Код»")
    : baseKind === "reading" && !compare.reading ? tr("The diagram has not changed since your last read", "С вашего прочтения схема не менялась")
    : unsupported ? tr(`Diagram comparison unavailable: ${unsupported}. Changes are visible in the “Code” view`, `Сравнение схемы недоступно: ${unsupported} — изменения видны в виде «Код»`)
    : changes && failed(changes) ? tr(`The visualizer couldn't compare the versions: ${changes.failed}`, `Визуализатор не смог сравнить версии: ${changes.failed}`)
    : diff && diff.total === 0 && view === "diagram" ? tr("The graph did not change, the edit is only in how the source is written (see “Code”)", "Граф не изменился — правка только в записи исходника (см. «Код»)")
    : null;
  const compareHint = hasChanges ? tr(`${compareOn ? "Hide" : "Show"} changes ${baseWord}`, `${compareOn ? "Скрыть" : "Показать"} изменения ${baseWord}`) : quietReason ?? tr("No changes", "Изменений нет");
  const moveHint = !layoutable ? null : readOnly ? readOnly : tr("Drag a node or a group title; with the keyboard: Tab to a node, Enter, arrows (Shift for bigger steps), Enter; right click or long press opens the node menu. The layout is yours only, the source does not change", "Перетащите узел или заголовок группы; с клавиатуры — Tab к узлу, Enter, стрелки (Shift — крупнее), Enter; правая кнопка или долгое касание — меню узла. Раскладка — только ваша, исходник не меняется");
  const overlaps = (report?.overlaps ?? []).map((pair) => pair.map(nameOf).join(tr(" and ", " и "))).join(", ");
  const notices = [
    ...(report?.overlaps?.length ? [tr(`Nodes overlap: ${overlaps}`, `Узлы перекрываются: ${overlaps}`)] : []),
    ...(report?.fallbacks?.length ? [tr("No route found for some edges, they are shown dashed", "Для части связей не найден обход — они показаны пунктиром")] : []),
    ...(report?.warnings ?? []).map((w) => tr(`Not applied, line ${w.line}: ${w.message}`, `Не применено, строка ${w.line}: ${w.message}`)),
  ];
  const zoomWord = `${Math.round(zoom * 100)}%`;
  const nodeCount = items.filter((item) => item.kind === "node").length;
  const edgeCount = items.filter((item) => item.kind === "edge").length;
  const menuInfo = menu?.id ? report?.elements[menu.id] ?? null : null;
  const menuReset = menu?.id && menuInfo ? pinnedOf(menu.id, menuInfo) : [];

  const frame = <div ref={full ? fullRef : nearRef} className={`dr-obj${full ? " dr-obj--full" : ""}`} data-visualizer={registration.id} onKeyDown={onKey}
    {...(full ? { role: "dialog", "aria-modal": true, "aria-label": tr(`${title}, full screen`, `${title} — во весь экран`), tabIndex: -1 } : {})}>
    <div data-skip className="dr-obj__bar">
      <Tip label={title}><span className="dr-obj__kind" tabIndex={-1}><Icon name={registration.icon ?? "Workflow"} /><span className="dr-obj__title">{title}</span></span></Tip>
      {!failure && <Segmented label={tr("Diagram view", "Вид схемы")} value={view} items={VIEW_ITEMS} onChange={choose} iconOnly />}
      {showCanvas && store?.saving && <span className="dr-obj__state" role="status" aria-label={tr("Saving layout", "Расположение сохраняется")}><Spinner size={14} /></span>}
      {showCanvas && layoutable && readOnly && <Tip label={readOnly}><span className="dr-obj__state" tabIndex={0} role="img" aria-label={tr(`Layout is not saved: ${readOnly}`, `Расположение не сохраняется: ${readOnly}`)}><Icon name="Lock" /></span></Tip>}
      {showCanvas && layoutable && !readOnly && pinned.length > 0 && <Tip label={tr("Reset all nodes to the automatic layout (can be undone)", "Вернуть автоматическое расположение всех узлов (можно отменить)")}>
        <button type="button" className="dr-btn dr-btn--ghost dr-btn--sm dr-obj__reset" onClick={resetAll} aria-label={tr(`Reset layout: ${pinned.length} ${plural(pinned.length, NODES)} in your positions`, `Сбросить расположение: ${pinned.length} ${plural(pinned.length, NODES)} на ваших местах`)}>
          <Icon name="RotateCcw" /><span className="dr-obj__label">{pinned.length}</span></button></Tip>}
      {showCanvas && selectedInfo && writable && onComment && <Tip label={tr(`Comment ${KIND_TO[selectedInfo.kind]} “${selectedInfo.label}”`, `Замечание ${KIND_TO[selectedInfo.kind]} «${selectedInfo.label}»`)} keys="C">
        <button type="button" className="dr-btn dr-btn--ghost dr-btn--icon dr-btn--sm" onClick={commentSelected} aria-label={tr(`Comment ${KIND_TO[selectedInfo.kind]} “${selectedInfo.label}” (C)`, `Замечание ${KIND_TO[selectedInfo.kind]} «${selectedInfo.label}» (C)`)}><Icon name="MessageSquarePlus" /></button></Tip>}
      <span className="dr-grow" />
      {showCanvas && notices.length > 0 && <Popover>
        <Tip label={tr(`Rendering notes: ${notices.length}`, `Замечания к построению: ${notices.length}`)}><PopoverTrigger asChild>
          <button type="button" className="dr-btn dr-btn--ghost dr-btn--sm dr-obj__notice" aria-label={tr(`Rendering notes: ${notices.length}`, `Замечания к построению: ${notices.length}`)}><Icon name="TriangleAlert" /><span className="dr-obj__label">{notices.length}</span></button>
        </PopoverTrigger></Tip>
        <PopoverContent align="end" className="dr-obj__pop w-[24rem] max-w-[90vw]" mobileTitle={tr("Diagram rendering", "Построение схемы")}><ul className="dr-obj__list">{notices.map((text, i) => <li key={i}>{text}</li>)}</ul></PopoverContent>
      </Popover>}
      {compare && !failure && <span className="dr-obj__cmp">
        <Tip label={compareHint} keys={undefined}>
          <button type="button" className="dr-tgl dr-tgl--sm" aria-pressed={hasChanges && compareOn} aria-disabled={!hasChanges || undefined} aria-label={hasChanges ? tr(`Compare ${baseWord}`, `Сравнить ${baseWord}`) : tr(`Compare: ${compareHint}`, `Сравнить: ${compareHint}`)}
            onClick={() => { if (hasChanges) setCompareOn(!compareOn); }}>
            <Icon name="GitCompare" />
            {hasChanges && compareOn && counts && view === "diagram" && <span className="dr-obj__counts" aria-hidden="true">
              {counts.added > 0 && <span className="dr-obj__chg--added">+{counts.added}</span>}
              {counts.changed > 0 && <span className="dr-obj__chg--changed">~{counts.changed}</span>}
              {counts.removed > 0 && <span className="dr-obj__chg--removed">−{counts.removed}</span>}
            </span>}
          </button>
        </Tip>
        <Popover>
          <Tip label={tr("Comparison base and list of changes", "База сравнения и список изменений")}><PopoverTrigger asChild>
            <button type="button" className="dr-btn dr-btn--ghost dr-btn--sm dr-obj__more" aria-label={tr("Comparison base and list of changes", "База сравнения и список изменений")}><Icon name="ChevronDown" /></button>
          </PopoverTrigger></Tip>
          <PopoverContent align="end" className="dr-obj__pop w-[24rem] max-w-[90vw]" mobileTitle={tr("Diagram comparison", "Сравнение схемы")}>
            <div className="dr-obj__poprow">
              <span className="dr-obj__poplabel">{tr("Compare with", "Сравнить с")}</span>
              <Segmented<"previous" | "reading"> label={tr("Diagram comparison base", "База сравнения схемы")} value={baseKind} onChange={(next) => { setBaseKind(next); setCompareOn(true); }} items={[
                { value: "previous", label: tr("Previous version", "Прошлой версией"), title: previous?.kind === "version" ? tr(`The diagram before its last edit, ${when(previous.base.at)}`, `Версия схемы до её последней правки, ${when(previous.base.at)}`) : tr("The diagram before its last edit in the document history", "Версия схемы до её последней правки в журнале документа") },
                { value: "reading", label: tr("Your last read", "Вашим прочтением"), title: tr("How the diagram looked when you read it", "Как схема выглядела, когда вы её прочитали") }]} />
            </div>
            {baseKind === "previous" && previous?.kind === "merge" && <div className="dr-obj__poprow">
              <span className="dr-obj__poplabel">{tr("Version before merge", "Версия до слияния")}</span>
              <Segmented label={tr("Version before merge", "Версия до слияния")} value={parent ?? ""} onChange={(next) => { setParent(next); setCompareOn(true); }}
                items={previous.candidates.map((entry, i) => ({ value: entry.revisionId, label: tr(`Branch ${i + 1} · ${when(entry.at)}`, `Ветка ${i + 1} · ${when(entry.at)}`), title: entry.text === null ? tr("The diagram did not exist in this branch", "В этой ветке схемы не было") : undefined }))} />
            </div>}
            {quietReason && <p className="dr-obj__popnote">{quietReason}</p>}
            {diff && diff.total > 0 && <DiffList diff={diff} />}
          </PopoverContent>
        </Popover>
      </span>}
      <Tip label={copied ? tr("Copied", "Скопировано") : tr("Copy diagram source", "Копировать исходник схемы")}>
        <button type="button" className="dr-btn dr-btn--ghost dr-btn--icon dr-btn--sm" aria-label={copied ? tr("Copied", "Скопировано") : tr("Copy diagram source", "Копировать исходник схемы")} onClick={copySource} data-done={copied || undefined}>
          <Icon name={copied ? "Check" : "Copy"} /></button></Tip>
      {showCanvas && <span className="dr-obj__zoom">
        <Tip label={full ? tr("Fit to window", "Вписать в окно") : tr("Fit to column width", "Вписать в ширину колонки")}><button type="button" className="dr-btn dr-btn--ghost dr-btn--icon dr-btn--sm" aria-label={full ? tr("Fit to window", "Вписать в окно") : tr("Fit to width", "Вписать в ширину")} onClick={fit}><Icon name="Scan" /></button></Tip>
        <Tip label={full ? tr("Exit full screen", "Выйти из полного экрана") : tr("Full screen", "Во весь экран")} keys={full ? "Esc" : undefined}><button ref={fullButtonRef} type="button" className="dr-btn dr-btn--ghost dr-btn--icon dr-btn--sm" aria-label={full ? tr("Exit full screen (Esc)", "Выйти из полного экрана (Esc)") : tr("Full screen", "Во весь экран")} aria-pressed={full} onClick={() => toggleFull()}><Icon name={full ? "Minimize2" : "Maximize2"} /></button></Tip>
        <Tip label={tr("Zoom out", "Мельче")}><button type="button" className="dr-btn dr-btn--ghost dr-btn--icon dr-btn--sm dr-obj__zstep" aria-label={tr("Zoom out", "Мельче")} onClick={() => setZoom((z) => Math.max(0.3, +(z / 1.25).toFixed(2)))}><Icon name="ZoomOut" /></button></Tip>
        <Tip label={tr("Zoom: reset to 100%", "Масштаб: вернуть 100 %")}><button type="button" className="dr-btn dr-btn--ghost dr-btn--sm dr-obj__pct" aria-label={tr(`Zoom ${zoomWord}, reset to 100%`, `Масштаб ${zoomWord}, вернуть 100 %`)} onClick={() => setZoom(1)}><span className="dr-obj__label">{zoomWord}</span></button></Tip>
        <Tip label={tr("Zoom in", "Крупнее")}><button type="button" className="dr-btn dr-btn--ghost dr-btn--icon dr-btn--sm dr-obj__zstep" aria-label={tr("Zoom in", "Крупнее")} onClick={() => setZoom((z) => Math.min(3, +(z * 1.25).toFixed(2)))}><Icon name="ZoomIn" /></button></Tip>
      </span>}
    </div>
    {failure?.reason === "syntax" && <div data-skip className="dr-banner dr-banner--error" role="status"><Icon name="TriangleAlert" /><span className="dr-banner__text"><b>{tr("Diagram can't be built:", "Схема не строится:")}</b>{tr(` line ${failure.line}: ${failure.message}. Showing the code.`, ` строка ${failure.line} — ${failure.message}. Показан код.`)}</span></div>}
    {failure?.reason === "crash" && <div data-skip className="dr-banner dr-banner--error" role="status"><Icon name="TriangleAlert" /><span className="dr-banner__text"><b>{tr(`Visualizer “${registration.title}” failed:`, `Визуализатор «${registration.title}» не справился:`)}</b> {failure.message}{tr(". Showing the code.", ". Показан код.")}</span></div>}
    {failure?.reason === "audit" && <div data-skip className="dr-banner dr-banner--error" role="alert"><Icon name="ShieldOff" /><span className="dr-banner__text"><b>{tr(`Visualizer “${registration.title}” broke the security contract`, `Визуализатор «${registration.title}» нарушил договор безопасности`)}</b> ({failure.message}){AUDIT_TAIL()}</span></div>}
    {failure && failure.reason !== "syntax" && failure.reason !== "crash" && failure.reason !== "audit" && <div data-skip className="dr-banner dr-banner--quiet"><Icon name="Info" /><span className="dr-banner__text">{failure.message}</span></div>}
    {showCanvas && layoutable && store?.error && <div data-skip className="dr-obj__hint" role="alert">{tr(`Not saved: ${store.error}. Nodes returned to their previous places. `, `Не сохранилось: ${store.error} — узлы возвращены на прежние места. `)}<button type="button" className="dr-btn dr-btn--sm" onClick={store.retry}>{tr("Retry", "Повторить")}</button></div>}
    {showCanvas && store?.conflicts?.length ? <div data-skip className="dr-obj__hint" role="status">
      {store.conflicts.map((conflict) => <span key={conflict.node} className="dr-obj__conflict">
        {tr(`Node “${nameOf(conflict.node)}” was moved differently on your machines, shown in its automatic place.`, `Узел «${nameOf(conflict.node)}» передвинут по-разному на ваших машинах — показан на автоматическом месте.`)}{" "}
        {conflict.candidates.map((entry, i) => <button key={i} type="button" className="dr-btn dr-btn--sm" disabled={readOnly !== null}
          onClick={() => (entry ? commit({ [conflict.node]: entry }) : commit({}, [conflict.node]))}>{entry ? tr(`Option ${i + 1}`, `Вариант ${i + 1}`) : tr("Automatic", "Автоматически")}</button>)}
      </span>)}
    </div> : null}
    {showCanvas && lost.length > 0 && <div data-skip className="dr-obj__hint" role="status">{lost.map((note) => <span key={note.annotationId} className="dr-obj__conflict">
      <Icon name="MessageSquare" />{tr(`Comment ${KIND_TO[note.element!.kind]} “${note.element!.label}”: the element is not in this version of the diagram, its place is unclear.`, `Замечание ${KIND_TO[note.element!.kind]} «${note.element!.label}»: элемента в этой версии схемы нет — место неясно.`)}
      {onMarker && <button type="button" className="dr-btn dr-btn--sm" onClick={() => onMarker(note.annotationId)}>{tr("Open", "Открыть")}</button>}</span>)}</div>}
    {showCanvas ? <>
      <div data-skip ref={canvasRef} className="dr-obj__canvas" data-movable={(layoutable && !readOnly) || undefined} title={moveHint ?? undefined}
        onContextMenu={onContextMenu} onPointerDownCapture={pressStart} onPointerMoveCapture={pressMove} onPointerUpCapture={pressEnd} onPointerCancelCapture={pressEnd} onTouchEndCapture={pressRelease}>
        <div ref={innerRef} className="dr-obj__inner">
          <div ref={slotRef} className="dr-obj__slot" role="group" aria-roledescription={tr("diagram", "схема")} aria-label={tr(`Diagram: ${counted(nodeCount, NODES)}, ${counted(edgeCount, EDGES)}`, `Схема: ${nodeCount} узлов, ${edgeCount} связей`)} />
          {report && Object.keys(byElement).length > 0 && <div className="dr-obj__markers">
            {Object.entries(byElement).map(([id, entry]) => { const box = report.elements[id]; if (!box) return null; return <button key={id} type="button" className={`dr-cmark dr-obj__marker${entry.waiting ? " dr-cmark--waiting" : ""}`}
              style={{ left: Math.round((box.x + box.w) * zoom) - 10, top: Math.round(box.y * zoom) - 10 }} onClick={() => onMarker?.(entry.ids[0])}
              aria-label={`${tr(`${entry.count} ${plural(entry.count, W.annotation)} ${KIND_TO[box.kind]} “${box.label}”`, `${entry.count} ${plural(entry.count, W.annotation)} ${KIND_TO[box.kind]} «${box.label}»`)}${entry.waiting ? tr(", reply awaits your decision", ", ответ ждёт решения") : ""}`} title={entry.waiting ? tr("Agent reply awaits your decision", "Ответ агента ждёт решения") : tr("Open comments", "Открыть замечания")}>
              <Icon name="MessageSquare" />{entry.count}</button>; })}
          </div>}
        </div>
      </div>
      <Description items={items} marks={marks} />
      {!full && <div hidden>{code}</div>}
    </> : view === "code" && !failure && compareOn && chosenBase?.diff && renderDiff ? <>{renderDiff(chosenBase)}<div hidden>{code}</div></> : code}
    {menu && <Menu open onOpenChange={(open) => { if (!open) setMenu(null); }}>
      <MenuTrigger asChild><span aria-hidden style={{ position: "fixed", left: menu.x, top: menu.y, width: 1, height: 1 }} /></MenuTrigger>
      <MenuContent align="start" mobileTitle={menuInfo ? tr(`${KIND_WORD[menuInfo.kind] ?? KIND_WORD.other} “${menuInfo.label}”`, `${KIND_WORD[menuInfo.kind] ?? KIND_WORD.other} «${menuInfo.label}»`) : tr("Diagram", "Схема")}>
        {menuInfo && menu.id ? <>
          <MenuLabel className="dr-trunc">{tr(`${KIND_WORD[menuInfo.kind] ?? KIND_WORD.other} “${menuInfo.label}”`, `${KIND_WORD[menuInfo.kind] ?? KIND_WORD.other} «${menuInfo.label}»`)}</MenuLabel>
          {layoutable && <MenuItem disabled={readOnly !== null || menuReset.length === 0} onSelect={() => commit({}, menuReset)}>
            <Icon name="RotateCcw" />{menuInfo.kind === "group" ? tr("Reset group nodes to automatic places", "Вернуть узлы группы на автоматические места") : tr("Reset to automatic place", "Вернуть на автоматическое место")}</MenuItem>}
          {writable && onComment && <MenuItem onSelect={() => commentOn(menu.id!, menuInfo)}><Icon name="MessageSquarePlus" />{tr(`Comment ${KIND_TO[menuInfo.kind]}`, `Замечание ${KIND_TO[menuInfo.kind]}`)}<Kbd>C</Kbd></MenuItem>}
          {(byElement[menu.id]?.ids.length ?? 0) > 0 && onMarker && <MenuItem onSelect={() => onMarker(byElement[menu.id!].ids[0])}><Icon name="MessageSquare" />{tr("Open comments", "Открыть замечания")} · {byElement[menu.id].count}</MenuItem>}
        </> : <>
          {layoutable && <MenuItem disabled={readOnly !== null || pinned.length === 0} onSelect={resetAll}><Icon name="RotateCcw" />{tr("Reset entire layout", "Сбросить всё расположение")}{pinned.length > 0 ? ` · ${pinned.length}` : ""}</MenuItem>}
          <MenuItem onSelect={fit}><Icon name="Scan" />{full ? tr("Fit to window", "Вписать в окно") : tr("Fit to width", "Вписать в ширину")}</MenuItem>
          <MenuItem onSelect={() => toggleFull()}><Icon name={full ? "Minimize2" : "Maximize2"} />{full ? tr("Exit full screen", "Выйти из полного экрана") : tr("Full screen", "Во весь экран")}</MenuItem>
          <MenuItem onSelect={copySource}><Icon name="Copy" />{tr("Copy source", "Копировать исходник")}</MenuItem>
        </>}
      </MenuContent>
    </Menu>}
  </div>;
  // Full screen (EP-081): the same frame in a window over the document — moving, comments and markers keep working.
  // It is portalled next to the document body (outside `content-visibility` of blocks, under the composer's layer).
  if (!full) return frame;
  return <><div ref={nearRef} className="dr-obj dr-obj--placeholder" style={{ height: placeholder.current }}><div hidden>{code}</div></div>{host.current && createPortal(frame, host.current)}</>;
});
