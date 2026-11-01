// Controlled renderer of the viewer (EP-008-T02/T03; design W-06 EP-020-T03/T04). It renders the host's projection
// tokens as React elements: no raw HTML, scripts, iframes or handlers can execute (html is shown as code), URLs are
// filtered, remote images load only on an explicit action, local ones through the confined preview. The text of
// `[data-text]` equals the block's projected text, so selections map to W3C offsets exactly (see dom.ts); everything
// else in a block (gutter, labels, list marks, deleted words) is `[data-skip]`.
// Layout: a block is a grid «gutter 76 px | text»; marks of unread changes are the shape of the line on the left edge of
// the text plus a word in the gutter (colour is never the only sign); on a narrow column the word moves above the block.
import { changeKind } from "./change-runs.ts";
import { Icon } from "./icons.tsx";
import { CopyButton } from "./copy.tsx";
import { fenceTokens } from "./fence-highlight.ts";
import { revealBlock } from "./reveal.ts";
import { ObjectBlock, type ObjectElement, type ObjectStore } from "./object.tsx";
import { claimedBy } from "./visualizers.ts";
import { Fragment, type ReactNode, memo, useMemo, useRef, useState } from "react";
import { ColumnHandle, ColumnsReset, sizedClass, TableBox, useColumnMenu, useColumnWidths, widthsOf } from "./table.tsx";
import type { ViewAnnotation, ViewBlock, ViewRemoved } from "../node/view.ts";
import { breakSegments } from "./breaks.ts";
import { mergeDiff } from "./diff-inline.ts";
import { listNumbers } from "./lists.ts";
import { resolveLink, slug } from "./route.ts";
import { tr } from "../core/i18n.ts";
import { W, counted } from "./words.ts";

export interface RenderHandlers {
  doc: string;
  previewBase: string | null;
  showDiff: boolean;
  onlyChanges: boolean;
  /** Annotations per block index (place) for the margin markers. */
  markers: Map<number, ViewAnnotation[]>;
  focusBlocks: Set<number>;
  writable: boolean;
  openDoc(doc: string, hash: string | null): void;
  openUrl(url: string): void;
  onRead(block: number): void;
  onReadSection(block: number): void;
  onComment(block: number, kind: "block" | "section" | "change"): void;
  /** W-06f (EP-073-T08): a comment on an element of an embedded object (node, edge, group) inside the block. */
  /** «Comment on cell» of a CSV table (EP-081): an annotation to a text range, as to a selection. */
  onCommentText?(range: { start: number; end: number }, quote: string, rect: DOMRect | null): void;
  onCommentElement?(block: number, element: { id: string; kind: "node" | "edge" | "group" | "text" | "other"; label: string; range?: { line: number; start: number; end: number } }): void;
  onReadRemoved(tombstoneId: string): void;
  onCommentRemoved(tombstoneId: string, quote: string): void;
  onMarker(annotationId: string): void;
  /** W-06f: the reader's stored layout of an embedded diagram and its write (EP-060); absent — local, unsaved. */
  diagramStore?(block: ViewBlock): ObjectStore | undefined;
  /** W-06f (EP-073): changes when a visualizer registers, leaves or the device preference changes — code blocks re-render. */
  visualizers?: string;
}

const SAFE_URL = /^(https?:|mailto:)/i;

type Node0 = { type: string; attrs: Record<string, unknown>; children: (Node0 | string)[] };

/** Inline tokens → tree: strings and open/close marks; unclosed marks close at the end. */
function tokenTree(tokens: unknown[]): Node0 {
  const root: Node0 = { type: "root", attrs: {}, children: [] };
  const stack: Node0[] = [root];
  for (const token of tokens) {
    const top = stack[stack.length - 1];
    if (typeof token === "string") {
      top.children.push(token);
      continue;
    }
    const mark = token as Record<string, unknown>;
    if (typeof mark.open === "string") {
      const node: Node0 = { type: mark.open, attrs: mark, children: [] };
      top.children.push(node);
      stack.push(node);
    } else if (typeof mark.close === "string") {
      if (stack.length > 1) stack.pop();
    } else if (mark.image && typeof mark.image === "object") top.children.push({ type: "image", attrs: mark.image as Record<string, unknown>, children: [] });
    else if (typeof mark.footnote === "string") top.children.push({ type: "footnote", attrs: { id: mark.footnote }, children: [] });
    else if (typeof mark.html === "string") top.children.push({ type: "html", attrs: { value: mark.html }, children: [] });
    else if (typeof mark.deleted === "string") top.children.push({ type: "deleted", attrs: { value: mark.deleted }, children: [] });
  }
  return root;
}

function ImageView({ attrs, handlers }: { attrs: Record<string, unknown>; handlers: RenderHandlers }) {
  const [remote, setRemote] = useState(false);
  const [failed, setFailed] = useState(false);
  const url = typeof attrs.url === "string" ? attrs.url : "";
  const alt = typeof attrs.alt === "string" ? attrs.alt : "";
  const external = /^https?:/i.test(url);
  if (external && !remote) {
    return <span data-skip className="dr-imgstub" title={url}>
      <Icon name="Image" />{alt || tr("Image", "Картинка")}{tr(" · external", " · внешняя")}
      <button type="button" className="dr-btn dr-btn--ghost dr-btn--sm" onClick={() => setRemote(true)}>{tr("Load", "Загрузить")}</button>
    </span>;
  }
  if (external && failed) return <span data-skip className="dr-imgstub" title={url}><Icon name="ImageOff" />{alt || tr("Image", "Картинка")}{tr(" · failed to load", " · не загрузилась")}</span>;
  if (external) return <img data-skip src={url} alt={alt} referrerPolicy="no-referrer" className="dr-img" onError={() => setFailed(true)} />;
  const local = resolveLink(handlers.doc, url);
  if (!local?.doc || !handlers.previewBase) return <span data-skip className="dr-fn">[{alt || url}]</span>;
  // EP-081-T04: a picture that does not load (no such file, not an image) — a stub with its alt and path, not the
  // browser's broken-image glyph.
  if (failed) return <span data-skip className="dr-imgstub" title={local.doc}><Icon name="ImageOff" />{alt || tr("Image", "Картинка")}{tr(" · not found", " · не найдена")}</span>;
  const src = `${handlers.previewBase.replace(/\/$/, "")}/${local.doc.split("/").map(encodeURIComponent).join("/")}`;
  return <img data-skip src={src} alt={alt} className="dr-img" onError={() => setFailed(true)} />;
}

/**
 * Text with break opportunities (<wbr>) inside its long tokens (EP-047, table cells): <wbr> has no text, so the text
 * nodes of `[data-text]` still spell the block's text exactly (selection, quotes, highlights unchanged).
 */
export function withBreaks(text: string, key: string): ReactNode {
  const segments = breakSegments(text);
  if (segments.length < 2) return text;
  return segments.map((segment, index) => <Fragment key={`${key}~${index}`}>{index > 0 && <wbr />}{segment}</Fragment>);
}

function renderNodes(nodes: (Node0 | string)[], handlers: RenderHandlers, key = "n", breaks = false): ReactNode[] {
  return nodes.map((node, index) => {
    const k = `${key}.${index}`;
    if (typeof node === "string") return <Fragment key={k}>{breaks ? withBreaks(node, k) : node}</Fragment>;
    const children = renderNodes(node.children, handlers, k, breaks);
    switch (node.type) {
      case "emphasis": return <em key={k}>{children}</em>;
      case "strong": return <strong key={k}>{children}</strong>;
      case "delete": return <s key={k}>{children}</s>;
      case "code": return <code key={k}>{children}</code>;
      case "link": {
        const url = typeof node.attrs.url === "string" ? node.attrs.url : "";
        const local = resolveLink(handlers.doc, url);
        const title = typeof node.attrs.title === "string" ? node.attrs.title : undefined;
        if (local && (local.doc === null || /\.(md|markdown)$/i.test(local.doc))) {
          return <a key={k} href="#" title={title} onClick={(event) => { event.preventDefault(); handlers.openDoc(local.doc ?? handlers.doc, local.hash); }}>{children}</a>;
        }
        if (SAFE_URL.test(url)) {
          return <a key={k} href={url} title={title ?? url} rel="noopener noreferrer" onClick={(event) => { event.preventDefault(); handlers.openUrl(url); }}>{children}</a>;
        }
        return <span key={k} className="underline decoration-dotted" title={url ? tr(`Link can't be opened: ${url}`, `Ссылка не открывается: ${url}`) : undefined}>{children}</span>;
      }
      case "image": return <ImageView key={k} attrs={node.attrs} handlers={handlers} />;
      case "footnote": {
        // EP-081-T04: the reference leads to its definition (when it is mounted; a large document mounts in slices).
        const id = String(node.attrs.id);
        return <sup key={k} data-skip className="dr-fn"><a href="#" title={tr("Go to footnote", "К сноске")} onClick={(event) => {
          event.preventDefault();
          const target = [...document.querySelectorAll<HTMLElement>("[data-footnote]")].find((element) => element.dataset.footnote === id);
          revealBlock(target?.closest("[data-block]"), "center", { arrive: true });
        }}>[{id}]</a></sup>;
      }
      case "ins": return <ins key={k} className="dr-ins" title={tr("Added", "Добавлено")}>{children}</ins>;
      case "deleted": return <del key={k} data-skip className="dr-del" title={tr("Removed", "Удалено")}>{String(node.attrs.value)}</del>;
      case "html": return <code key={k} data-skip title={tr("HTML is not executed", "HTML не исполняется")} className="dr-html">{String(node.attrs.value).slice(0, 80)}</code>;
      default: return <Fragment key={k}>{children}</Fragment>;
    }
  });
}

/** Word-level diff inside the text: deleted words are skipped by the selection mapping, so the text stays exact. */
export function DiffText({ words, breaks = false }: { words: { op: string; text: string }[]; breaks?: boolean }) {
  const text = (value: string, key: string) => (breaks ? withBreaks(value, key) : value);
  return <>{words.map((word, index) => word.op === "equal" ? <Fragment key={index}>{text(word.text, `w${index}`)}</Fragment>
    : word.op === "insert" ? <ins key={index} className="dr-ins" title={tr("Added", "Добавлено")}>{text(word.text, `w${index}`)}</ins>
    : <del key={index} data-skip className="dr-del" title={tr("Removed", "Удалено")}>{word.text}</del>)}</>;
}

/** The word diff merged into the formatted inline tokens; the plain diff when they cannot be merged. */
function InlineDiff({ block, words, handlers, breaks = false }: { block: ViewBlock; words: { op: string; text: string }[]; handlers: RenderHandlers; breaks?: boolean }) {
  const merged = mergeDiff(block.inline, words);
  if (!merged) return <DiffText words={words} breaks={breaks} />;
  return <>{renderNodes(tokenTree(merged).children, handlers, `d${block.index}`, breaks)}</>;
}

const MOVED_TITLE = () => tr("Block moved without edits: it is already read, the mark is only for orientation", "Блок перенесён без правки: он уже прочитан, пометка только для ориентации");

/** A block mark combines line shape and a word; color is never the only signal. */
export function markOf(block: ViewBlock): { kind: "changed" | "added" | "moved" | "unclear"; word: string; title: string } | null {
  const kind = changeKind(block);
  if (kind === "unclear") return { kind: "unclear", word: tr("unclear", "неясно"), title: tr("Unclear base: read state is ambiguous, so the block is shown as unread", "Неясная база: прочитанность не определена однозначно — блок показан непрочитанным") };
  if (kind === "added") return { kind: "added", word: tr("added", "добавлено"), title: tr("Added since you last read it", "Добавлено после вашего прочтения") };
  if (kind === "changed") return { kind: "changed", word: tr("changed", "изменено"), title: block.movedFrom ? tr(`Changed and moved from section “${block.movedFrom}”`, `Изменено и перемещено из раздела «${block.movedFrom}»`) : tr("Changed since you last read it", "Изменено после вашего прочтения") };
  if (block.moved && block.movedFrom) return { kind: "moved", word: tr("moved", "перемещено"), title: MOVED_TITLE() };
  return null;
}

function Gutter({ block, handlers, mark, quiet = false }: { block: ViewBlock; handlers: RenderHandlers; mark: ReturnType<typeof markOf>; quiet?: boolean }) {
  const markers = handlers.markers.get(block.index) ?? [];
  const unread = block.read === "unread" || block.read === "ambiguous";
  const waiting = markers.some((marker) => marker.waiting);
  const kind = block.type === "heading" ? "section" : unread ? "change" : "block";
  const commentLabel = kind === "section" ? tr("Comment on section", "Замечание к разделу") : kind === "change" ? tr("Comment on change", "Замечание к изменению") : tr("Comment on block", "Замечание к блоку");
  return <div data-skip contentEditable={false} className="dr-gut">
    {mark && <span className={quiet ? "dr-sr" : "dr-mlabel"} title={mark.title}>{mark.word}</span>}
    {markers.length > 0 && <button type="button" className={`dr-cmark${waiting ? " dr-cmark--waiting" : ""}`} onClick={() => handlers.onMarker(markers[0].annotationId)}
      aria-label={`${counted(markers.length, W.annotation)}${waiting ? tr(", reply awaits your decision", ", ответ ждёт решения") : ""}`} title={waiting ? tr("Agent reply awaits your decision", "Ответ агента ждёт решения") : tr("Open comments", "Открыть замечания")}>
      <Icon name="MessageSquare" />{markers.length}
    </button>}
    <span className="dr-bacts">
      {unread && handlers.writable && <button type="button" className="dr-btn dr-btn--icon" title={tr("Mark read (R)", "Прочитано (R)")} aria-label={tr("Mark read (R)", "Прочитано (R)")} onClick={() => handlers.onRead(block.index)}><Icon name="Check" /></button>}
      {block.type === "heading" && handlers.writable && <button type="button" className="dr-btn dr-btn--icon" title={tr("Section read", "Раздел прочитан")} aria-label={tr("Section read", "Раздел прочитан")} onClick={() => handlers.onReadSection(block.index)}><Icon name="CheckCheck" /></button>}
      <button type="button" className="dr-btn dr-btn--icon" title={`${commentLabel} (C)`}
        aria-label={commentLabel} onClick={() => handlers.onComment(block.index, kind)}><Icon name="MessageSquarePlus" /></button>
    </span>
  </div>;
}

/** A highlighted fenced block: the text sliced by the tokens of its lines, the line breaks kept as text. */
function Highlighted({ text, lines }: { text: string; lines: { s: number; e: number; role: string }[][] }) {
  const out: ReactNode[] = [];
  text.split("\n").forEach((line, no) => {
    if (no > 0) out.push("\n");
    let at = 0;
    for (const token of lines[no] ?? []) {
      if (token.s < at || token.e > line.length) continue;
      if (token.s > at) out.push(line.slice(at, token.s));
      out.push(<span key={`${no}:${token.s}`} className={`dr-sy-${token.role}`}>{line.slice(token.s, token.e)}</span>);
      at = token.e;
    }
    if (at < line.length) out.push(line.slice(at));
  });
  return <>{out}</>;
}

function BlockContent({ block, handlers, number }: { block: ViewBlock; handlers: RenderHandlers; number?: number }) {
  const tokens = renderNodes(tokenTree(block.inline).children, handlers, `b${block.index}`);
  const diff = handlers.showDiff && block.diff && (block.read === "unread" || block.read === "ambiguous") ? block.diff : null;
  const inline = diff && !diff.rewritten ? <InlineDiff block={block} words={diff.words} handlers={handlers} /> : tokens;
  const before = diff?.rewritten ? <div data-skip className="dr-before"><b>{tr("Before: ", "Было: ")}</b><s>{diff.before}</s></div> : null;
  const after = diff?.rewritten ? <span data-skip className="dr-after">{tr("After:", "Стало:")}</span> : null;
  switch (block.type) {
    case "heading": {
      const depth = Math.min(Math.max(block.depth ?? 1, 1), 6);
      return <>{before}<div role="heading" aria-level={depth} id={slug(block.text)} className={`dr-h${depth}`}>{after}<span data-text>{inline}</span></div></>;
    }
    case "code":
    case "html":
    case "frontmatter": {
      const lang = typeof block.attrs.lang === "string" ? block.attrs.lang : null;
      const unknown = block.type === "html" || (lang !== null && /^(math|mdx|mdxjsEsm|mdxJsxFlowElement|mdxFlowExpression)$/.test(lang));
      const label = block.type === "html" ? tr("HTML is not executed, shown as code", "HTML не исполняется — показан кодом") : block.type === "frontmatter" ? tr(`Metadata · ${String(block.attrs.format ?? "yaml")}`, `Метаданные · ${String(block.attrs.format ?? "yaml")}`) : unknown ? tr(`${lang}: not supported, shown as code`, `${lang}: не поддерживается — показан кодом`) : lang;
      // EP-081-T04: highlighted by the fence language while no word diff is shown (the pieces spell the text exactly).
      const lines = !diff && block.type === "code" ? fenceTokens(lang, block.text) : null;
      const pre = <pre className="dr-pre"><code data-text>{lines ? <Highlighted text={block.text} lines={lines} /> : inline}</code></pre>;
      if (block.type === "frontmatter") return <details className="dr-front"><summary data-skip><Icon name="ChevronRight" />{label}</summary>{pre}</details>;
      // W-06f: a fenced block some registered visualizer claims (EP-073) is an embedded object — «Code / Diagram», the
      // reader's layout; the code stays the text. The frame chooses the visualizer (or shows the code with the reason:
      // switched off, blocked by the audit, nobody matched); the element stays mounted across that choice.
      const taken = block.type === "code" && lang ? claimedBy({ kind: "fence", language: lang.toLowerCase(), path: handlers.doc }) : false;
      if (taken) {
        const store = handlers.diagramStore?.(block);
        // Compare is enabled for every object by default. The reader's base is the
        // block's own diff while it is unread; the previous version comes with the layout data.
        const unread = block.diff && (block.read === "unread" || block.read === "ambiguous") ? block.diff : null;
        const compare = { reading: unread ? unread.before : null, unclear: block.read === "ambiguous", previous: store?.previous ?? null };
        return <ObjectBlock source={block.text} doc={handlers.doc} lineage={block.lineageId} language={lang} code={<>{before}{pre}</>} store={store} compare={compare}
          annotations={handlers.markers.get(block.index)} writable={handlers.writable} onComment={handlers.onCommentElement ? (element: ObjectElement) => handlers.onCommentElement!(block.index, element) : undefined} onMarker={handlers.onMarker}
          renderDiff={(base) => base.diff!.rewritten
            ? <><div data-skip className="dr-before"><b>{tr("Before: ", "Было: ")}</b><s>{base.text}</s></div><pre data-skip className="dr-pre"><code>{block.text}</code></pre></>
            : <pre data-skip className="dr-pre"><code><DiffText words={base.diff!.words} /></code></pre>} />;
      }
      // «Copy» (EP-081-T04): the source text of the block, not the rendered marks; the frame of an embedded object
      // above has its own (object.tsx).
      return <>{before}{label && <div data-skip className="dr-codelabel">{label}</div>}<div className="dr-codeblock">{pre}<CopyButton text={block.text} className="dr-codeblock__copy" /></div></>;
    }
    case "thematicBreak": return <div><span data-text /><hr className="dr-hr" /></div>;
    case "listItem": {
      const ordered = block.attrs.ordered === true;
      const checked = block.attrs.checked;
      // Task boxes follow the design system: an outlined box or a filled graphite box
      // with a check when done; the done task's text is quieter and struck through. Read-only: the source is the truth.
      const mark = typeof checked === "boolean" ? <span role="img" aria-label={checked ? tr("Done", "Выполнено") : tr("Not done", "Не выполнено")} className={`dr-check${checked ? " dr-check--done" : ""}`}>{checked && <Icon name="Check" />}</span>
        : ordered ? `${number ?? Number(block.attrs.start ?? 1)}.` : "•";
      return <div className={`dr-li${checked === true ? " dr-li--done" : ""}`}>
        <span data-skip className={`dr-li__mark${checked === true ? " dr-li__mark--done" : ""}`}>{mark}</span>
        <div className="dr-li__body">{before}{after}<span data-text>{inline}</span></div>
      </div>;
    }
    case "footnoteDefinition": return <div className="dr-footnote" data-footnote={String(block.attrs.footnote ?? "")}><span data-skip>[{String(block.attrs.footnote ?? "")}] </span>{before}<span data-text>{inline}</span></div>;
    default: return <>{before}<p>{after}<span data-text>{inline}</span></p></>;
  }
}

/** Show a mark label once per consecutive run, or use the whole-document notice when all shown blocks are new. Keep the line on each block and the hidden label for screen readers. */
const Block = memo(function Block({ block, handlers, stop, number, quiet = false }: { block: ViewBlock; handlers: RenderHandlers; stop: boolean; number?: number; quiet?: boolean }) {
  const quote = Number(block.attrs.quote ?? 0);
  const list = Number(block.attrs.list ?? 0);
  const mark = markOf(block);
  // A list item of level n is indented by n − 1 steps; any other block inside a list item (a paragraph, code, a
  // quote) lines up with the item's text — past its mark (EP-081-T04).
  const steps = block.type === "listItem" ? list - 1 : list;
  const indent = steps > 0 ? { marginLeft: `calc(${Math.max(list - 1, 0) * 1.5}rem${block.type === "listItem" ? "" : " + var(--dr-li-text)"})` } : undefined;
  // tabIndex -1: a tap focuses the block, which shows its actions (Mark read, Comment) on touch screens (H6).
  return <div data-block={block.index} data-lineage={block.lineageId} tabIndex={-1} className={`dr-blk${mark ? ` dr-blk--${mark.kind}` : ""}${stop ? " dr-blk--stop" : ""}`}>
    <Gutter block={block} handlers={handlers} mark={mark} quiet={quiet} />
    <div className="dr-txt">
      <div className={quote ? "dr-quoteblock" : undefined} style={quote ? { ...indent, ["--dr-quote" as string]: Math.min(quote, 6) } : indent}>
        {block.movedFrom && mark && <div data-skip className="dr-moved-from" title={block.moved ? MOVED_TITLE() : undefined}>
          <Icon name="MoveRight" />{tr(`moved from section “${block.movedFrom}”`, `перемещено из раздела «${block.movedFrom}»`)}</div>}
        <BlockContent block={block} handlers={handlers} number={number} />
      </div>
    </div>
  </div>;
}, sameBlock);

/**
 * A mounted block renders again only when what it shows changed (W-06a): a large document mounts in slices, and
 * re-rendering every mounted block per slice made scrolling a 1 MiB document stall. The handler functions are stable
 * (the page passes functions that call the latest ones), so only the data fields are compared.
 */
function sameBlock(a: { block: ViewBlock; handlers: RenderHandlers; stop: boolean; number?: number; quiet?: boolean }, b: { block: ViewBlock; handlers: RenderHandlers; stop: boolean; number?: number; quiet?: boolean }): boolean {
  const x = a.handlers;
  const y = b.handlers;
  return a.block === b.block && a.stop === b.stop && a.number === b.number && a.quiet === b.quiet && x.showDiff === y.showDiff && x.writable === y.writable
    && x.previewBase === y.previewBase && x.doc === y.doc && x.markers.get(a.block.index) === y.markers.get(b.block.index)
    && x.openDoc === y.openDoc && x.onRead === y.onRead && x.onComment === y.onComment && x.onMarker === y.onMarker
    && (a.block.type !== "code" || (x.diagramStore === y.diagramStore && x.visualizers === y.visualizers));
}

function RemovedBlock({ removed, handlers }: { removed: ViewRemoved; handlers: RenderHandlers }) {
  const [open, setOpen] = useState(false);
  return <div data-skip className="dr-blk" data-tombstone={removed.tombstoneId}>
    <div className="dr-gut" />
    <div className="dr-txt" style={{ paddingTop: 0, paddingBottom: 0 }}>
      <div className="dr-tomb">
        <Icon name="Trash2" />
        <span className="dr-tomb__label">{tr("Removed", "Удалено")}</span>
        <button type="button" className="dr-tomb__text" style={{ textAlign: "left" }} aria-expanded={open} onClick={() => setOpen(!open)} title={open ? tr("Collapse", "Свернуть") : tr("Show removed text", "Показать удалённый текст")}>{removed.text.slice(0, 160)}</button>
        {handlers.writable && <button type="button" className="dr-btn dr-btn--ghost dr-btn--sm" onClick={() => handlers.onReadRemoved(removed.tombstoneId)}>{tr("Mark read", "Прочитано")}</button>}
        <button type="button" className="dr-btn dr-btn--ghost dr-btn--sm" onClick={() => handlers.onCommentRemoved(removed.tombstoneId, removed.text)}>{tr("Comment", "Замечание")}</button>
      </div>
      {open && <div className="dr-tomb__full">{removed.text}</div>}
    </div>
  </div>;
}

/** A run of unchanged blocks folded in «Only changes» (F6), with the heading path kept. */
function Folded({ count, path, onOpen }: { count: number; path: string; onOpen: () => void }) {
  return <div className="dr-blk" data-skip><div className="dr-gut" /><div className="dr-txt" style={{ paddingTop: 0, paddingBottom: 0 }}>
    <button type="button" onClick={onOpen} className="dr-folded" title={tr("Show folded blocks", "Показать свёрнутые блоки")}>
      <Icon name="Ellipsis" /><span>{counted(count, W.block)}{tr(" unchanged", " без изменений")}</span>{path && <span className="dr-trunc">· {path}</span>}
    </button>
  </div></div>;
}

/** A Markdown table (EP-047 cells as blocks) with resizable columns kept on this device (W-06c, EP-043-T05). */
function MdTable({ table, cells, handlers }: { table: number; cells: ViewBlock[]; handlers: RenderHandlers }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const [widths, setWidths] = useColumnWidths(`${handlers.doc}#md${table}`);
  const menu = useColumnMenu(widths, setWidths);
  const rows = new Map<number, ViewBlock[]>();
  for (const cell of cells) rows.set(cell.cell!.row, [...(rows.get(cell.cell!.row) ?? []), cell]);
  const first = [...rows.values()][0] ?? [];
  return <div className="dr-blk"><div className="dr-gut" data-skip /><div className="dr-txt"><TableBox className={`dr-table dr-table--md${sizedClass(widths)}`} reset={<ColumnsReset widths={widths} onWidths={setWidths} />}><table ref={tableRef}>
    {widths && <colgroup>{first.map((_, index) => <col key={index} style={{ width: widthsOf(widths)![index] }} />)}</colgroup>}
    <tbody>
    {[...rows].map(([row, rowCells], rowIndex) => <tr key={row}>
      {rowCells.map((cell, column) => {
        const Cell = cell.attrs.header ? "th" : "td";
        const unread = cell.read === "unread" || cell.read === "ambiguous";
        const markers = handlers.markers.get(cell.index) ?? [];
        const align = cell.attrs.align === "center" || cell.attrs.align === "right" ? cell.attrs.align : undefined;
        return <Cell key={cell.index} data-block={cell.index} className={unread ? "dr-cell--unread" : undefined} title={unread ? tr("Changed since you last read it · “Mark read”: R", "Изменено с вашего прочтения · «Прочитано» — R") : undefined}
          style={rowIndex === 0 || align ? { ...(rowIndex === 0 ? { position: "relative" as const } : {}), ...(align ? { textAlign: align } : {}) } : undefined}
          onContextMenu={rowIndex === 0 ? menu.onContextMenu(column, cell.text.slice(0, 40) || String(column + 1)) : undefined}>
          {handlers.showDiff && cell.diff && unread && !cell.diff.rewritten ? <span data-text><InlineDiff block={cell} words={cell.diff.words} handlers={handlers} breaks /></span> : <span data-text>{renderNodes(tokenTree(cell.inline).children, handlers, `c${cell.index}`, true)}</span>}
          {markers.length > 0 && <button data-skip type="button" className={`dr-cmark${markers.some((marker) => marker.waiting) ? " dr-cmark--waiting" : ""}`} style={{ marginLeft: 6 }} onClick={() => handlers.onMarker(markers[0].annotationId)} aria-label={counted(markers.length, W.annotation)}><Icon name="MessageSquare" />{markers.length}</button>}
          {rowIndex === 0 && <ColumnHandle column={column} label={cell.text.slice(0, 40) || String(column + 1)} table={() => tableRef.current} widths={widths} onWidths={setWidths} onMenu={menu.open} />}
        </Cell>;
      })}
    </tr>)}
  </tbody></table>{menu.element}</TableBox></div></div>;
}

/** Memoized (W-06b): the page renders several times while the next document is on its way; the shown body does not. */
export const DocumentBody = memo(function DocumentBody({ blocks, removed, handlers }: { blocks: ViewBlock[]; removed: ViewRemoved[]; handlers: RenderHandlers }) {
  const [unfolded, setUnfolded] = useState<Set<number>>(new Set());
  const numbers = useMemo(() => listNumbers(blocks), [blocks]);
  // `blocks` may be a window of the document (progressive mounting, EP-027-T08): look blocks up by their index.
  const base = blocks[0]?.index ?? 0;
  const removedAfter = new Map<number, ViewRemoved[]>();
  for (const entry of removed) removedAfter.set(entry.after, [...(removedAfter.get(entry.after) ?? []), entry]);
  const keep = (block: ViewBlock) => !handlers.onlyChanges || block.read === "unread" || block.read === "ambiguous" || handlers.markers.has(block.index) || removedAfter.has(block.index) || unfolded.has(block.index);
  const out: ReactNode[] = [];
  // The whole (shown part of the) document is new for the reader: one notice instead of a word on every block.
  const allAdded = useMemo(() => blocks.length > 1 && blocks.every((block) => markOf(block)?.kind === "added"), [blocks]);
  if (allAdded) out.push(<div key="newdoc" data-skip className="dr-blk"><div className="dr-gut" /><div className="dr-txt" style={{ paddingTop: 0, paddingBottom: 0 }}>
    <p className="dr-newdoc" style={{ ["--dr-mc" as string]: "var(--dr-added)" }}><Icon name="Info" /><span><b>{tr("New document for you:", "Новый для вас документ:")}</b>{tr(" all of its text was added since you last read it, marked by the line on the left of each block. To mark it all read, use “Document read” in the header.", " весь текст добавлен после вашего прочтения — полоса слева у каждого блока. Отметить целиком — «Прочитан» в шапке.")}</span></p>
  </div></div>);
  /** Kind of the mark of the block rendered just before (a run continues only across adjacent blocks). */
  let previous: string | null = null;
  for (const entry of removedAfter.get(-1) ?? []) out.push(<RemovedBlock key={`r${entry.tombstoneId}`} removed={entry} handlers={handlers} />);
  for (let index = 0; index < blocks.length; ) {
    const block = blocks[index];
    if (!keep(block)) {
      let end = index;
      while (end < blocks.length && !keep(blocks[end])) end++;
      const heading = blocks[end - 1]?.headings ?? [];
      const path = heading.map((h) => blocks[h - base]?.text).filter(Boolean).join(" › ");
      const run = blocks.slice(index, end).map((entry) => entry.index);
      out.push(<Folded key={`f${index}`} count={end - index} path={path} onOpen={() => setUnfolded((current) => new Set([...current, ...run]))} />);
      previous = null;
      index = end;
      continue;
    }
    if (block.type === "tableCell" && block.cell) {
      const table = block.cell.table;
      let end = index;
      while (end < blocks.length && blocks[end].type === "tableCell" && blocks[end].cell?.table === table) end++;
      const cells = blocks.slice(index, end);
      out.push(<MdTable key={`t${table}`} table={table} cells={cells} handlers={handlers} />);
      previous = null;
      for (const cell of cells) for (const entry of removedAfter.get(cell.index) ?? []) out.push(<RemovedBlock key={`r${entry.tombstoneId}`} removed={entry} handlers={handlers} />);
      index = end;
      continue;
    }
    // Keyed by index: the fast path's text and the full view of the same revision reuse the same DOM (no remount).
    const kind = markOf(block)?.kind ?? null;
    out.push(<Block key={`b${block.index}`} block={block} handlers={handlers} stop={handlers.focusBlocks.has(block.index)} number={numbers.get(block.index)}
      quiet={kind !== null && (allAdded || kind === previous)} />);
    previous = kind;
    for (const entry of removedAfter.get(block.index) ?? []) { out.push(<RemovedBlock key={`r${entry.tombstoneId}`} removed={entry} handlers={handlers} />); previous = null; }
    index++;
  }
  return <>{out}</>;
});
