// The Pretty view for .env and CSV/TSV uses a key/value/comment table
// for .env (values are masks with an eye), the header row, line numbers and horizontal scrolling for CSV/TSV. Each record
// is a block: `<tbody data-block>` with one `<tr data-text>` whose text nodes spell the record as written (separators and
// quotes stay in the DOM, visually hidden), so selections, quotes and highlights map exactly as in Markdown. Column widths
// change with the handle on the header border (mouse, touch, keyboard) and are kept on this device per file.
import { Fragment, memo, useCallback, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { ViewAnnotation, ViewBlock, ViewRemoved, ViewSecret } from "../node/view.ts";
import { Icon } from "./icons.tsx";
import { Kbd, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Tip } from "./kit.tsx";
import { Mask } from "./mask.tsx";
import { markOf } from "./render.tsx";
import type { BlockMeta } from "./source.ts";
import { notify } from "./store.ts";
import { tr } from "../core/i18n.ts";
import { W, counted } from "./words.ts";

export interface TableHandlers {
  doc: string;
  writable: boolean;
  markers: Map<number, ViewAnnotation[]>;
  focusBlocks: Set<number>;
  onRead(block: number): void;
  onComment(block: number): void;
  onReadRemoved(tombstoneId: string): void;
  onMarker(annotationId: string): void;
  /** «Comment on cell» (EP-081): an annotation to the text of one cell — a text range of the document. */
  onCommentText?(range: { start: number; end: number }, quote: string, rect: DOMRect | null): void;
}

// ── column widths kept on this device (localStorage; not review data) ───────────────────────────────────────────────

const WIDTHS_KEY = "bbdr:column-widths:v1";
/**
 * Column widths of one table (EP-081): `base` — the widths the columns had when the reader first moved one (the automatic
 * layout of that moment, so the other columns keep their look), `user` — the reader's own width per column (null — the
 * base). The table lays out with fixed widths; resetting the last own width makes the table automatic again.
 */
export type Columns = { base: number[]; user: (number | null)[] };
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
function readColumns(id: string): Columns | null {
  try {
    const stored = (JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? "{}") as Record<string, unknown>)[id];
    // Before EP-081 a plain array: every column the reader's.
    if (Array.isArray(stored)) { const user = stored.map(num); return user.some((w) => w !== null) ? { base: user.map((w) => w ?? MIN_WIDTH), user } : null; }
    if (stored && typeof stored === "object" && Array.isArray((stored as Columns).base) && Array.isArray((stored as Columns).user)) {
      const base = (stored as Columns).base.map((w) => num(w) ?? MIN_WIDTH), user = (stored as Columns).user.map(num);
      return user.some((w) => w !== null) ? { base, user } : null;
    }
    return null;
  } catch {
    return null;
  }
}
function writeColumns(id: string, columns: Columns | null) {
  try {
    const all = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? "{}") as Record<string, unknown>;
    if (columns) all[id] = columns; else delete all[id];
    const keys = Object.keys(all);
    if (keys.length > 200) delete all[keys[0]];
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(all));
  } catch {
    // A blocked storage keeps the widths for this session only.
  }
}

const MIN_WIDTH = 48;

/** Widths of the columns of one table: null — automatic; the first drag freezes every column as it stands. */
export function useColumnWidths(id: string) {
  const [columns, setColumns] = useState<Columns | null>(() => readColumns(id));
  const [shownFor, setShownFor] = useState(id);
  if (shownFor !== id) { setShownFor(id); setColumns(readColumns(id)); }
  const update = useCallback((next: Columns | null) => {
    // No own width left — the whole table is automatic again.
    const value = next && next.user.some((width) => width !== null) ? next : null;
    setColumns(value); writeColumns(id, value);
  }, [id]);
  return [columns, update] as const;
}

/** The width of every column as laid out, or null — automatic. */
export const widthsOf = (columns: Columns | null): number[] | null => (columns ? columns.base.map((width, index) => columns.user[index] ?? width) : null);
/** The table lays out with fixed widths while the reader has any. */
export const sizedClass = (columns: Columns | null) => (columns ? " dr-table--sized" : "");
/** Columns the reader has widened or narrowed by hand. */
export const changedColumns = (columns: Columns | null) => (columns?.user ?? []).filter((width) => width !== null).length;

/** Reset with «Undo» (EP-081, as the layout of a diagram): one column back to its width before, or all to automatic. */
function resetWidths(columns: Columns | null, onColumns: (next: Columns | null) => void, column: number | null, label?: string) {
  if (!columns) return;
  const before = columns;
  onColumns(column === null ? null : { base: columns.base, user: columns.user.map((width, index) => (index === column ? null : width)) });
  notify(column === null ? tr("Column widths set to automatic", "Ширина колонок — автоматическая") : tr(`Column “${label}” width restored`, `Ширина колонки «${label}» — как была`), { undo: async () => onColumns(before) });
}

/**
 * «Reset» of a table (EP-081, D39): shown only while some column has the reader's width — a pill with the number of
 * such columns on the top edge of the table's frame (it does not scroll with the columns); the menu of a header (right click, Shift+F10 on the handle) resets one.
 */
export function ColumnsReset({ widths, onWidths }: { widths: Columns | null; onWidths: (next: Columns | null) => void }) {
  const count = changedColumns(widths);
  if (!count) return null;
  const label = tr(`Reset column widths to automatic: ${counted(count, W.column)} with your width (can be undone)`, `Вернуть автоматическую ширину колонок: ${counted(count, W.column)} с вашей шириной (можно отменить)`);
  return <Tip label={label}><button type="button" data-skip className="dr-btn dr-btn--ghost dr-btn--sm dr-colreset" aria-label={label} onClick={() => resetWidths(widths, onWidths, null)}>
    <Icon name="RotateCcw" /><span className="dr-colreset__n">{count}</span></button></Tip>;
}

/** The menu of a column header: at the pointer (right click, long press) or at the handle (Shift+F10, the menu key). */
export function useColumnMenu(widths: Columns | null, onWidths: (next: Columns | null) => void) {
  const [menu, setMenu] = useState<{ x: number; y: number; column: number; label: string } | null>(null);
  const open = (x: number, y: number, column: number, label: string) => setMenu({ x: Math.min(x, window.innerWidth - 8), y, column, label });
  const onContextMenu = (column: number, label: string) => (event: ReactMouseEvent) => {
    if (event.shiftKey || (event.target as HTMLElement).closest("a, button:not(.dr-colh)")) return;
    event.preventDefault();
    open(event.clientX, event.clientY, column, label);
  };
  const own = menu ? widths?.user[menu.column] ?? null : null;
  const element = menu && <Menu open onOpenChange={(next) => { if (!next) setMenu(null); }}>
    <MenuTrigger asChild><span aria-hidden style={{ position: "fixed", left: menu.x, top: menu.y, width: 1, height: 1 }} /></MenuTrigger>
    <MenuContent align="start" mobileTitle={tr(`Column “${menu.label}”`, `Колонка «${menu.label}»`)}>
      <MenuLabel className="dr-trunc">{tr(`Column “${menu.label}”`, `Колонка «${menu.label}»`)}</MenuLabel>
      <MenuItem disabled={own === null} onSelect={() => resetWidths(widths, onWidths, menu.column, menu.label)}><Icon name="RotateCcw" />{tr("Restore column width", "Вернуть ширину колонки")}<Kbd>Enter</Kbd></MenuItem>
      <MenuItem disabled={!changedColumns(widths)} onSelect={() => resetWidths(widths, onWidths, null)}><Icon name="RotateCcw" />{tr("Restore all columns", "Вернуть все колонки")}{changedColumns(widths) ? ` · ${changedColumns(widths)}` : ""}</MenuItem>
    </MenuContent>
  </Menu>;
  return { open, onContextMenu, element };
}

/**
 * The handle on the right border of a header cell (§11, F20): role=separator with the width in px; drag with the mouse or
 * a finger (pointer events), arrows ±8 px, Shift ±32 px, Enter or a double click — the column's width before.
 */
export function ColumnHandle({ column, label, table, widths, onWidths, onMenu }: { column: number; label: string; table: () => HTMLTableElement | null; widths: Columns | null; onWidths: (next: Columns | null) => void; onMenu?(x: number, y: number, column: number, label: string): void }) {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; widths: number[] } | null>(null);
  // The first row of the table (a Markdown table has no <thead>): the columns as they stand on the screen.
  const measure = (): number[] => widthsOf(widths) ?? [...(table()?.rows[0]?.cells ?? [])].map((cell) => Math.round(cell.getBoundingClientRect().width));
  // The first move freezes every column as it stands (the others keep their look); only the moved one becomes the reader's.
  const set = (base: number[], width: number) => {
    const frozen = widths?.base ?? base;
    const user = Array.from({ length: frozen.length }, (_, index) => widths?.user[index] ?? null);
    user[column] = Math.max(MIN_WIDTH, Math.round(width));
    onWidths({ base: frozen, user });
  };
  const current = widths ? widthsOf(widths)![column] : undefined;
  return <span role="separator" aria-orientation="vertical" aria-label={tr(`Column “${label}” width`, `Ширина колонки «${label}»`)} aria-valuenow={current ?? undefined} aria-valuemin={MIN_WIDTH} tabIndex={0}
    className="dr-colh" data-skip data-dragging={dragging || undefined} title={tr("Column width: drag; arrows ±8, Shift ±32; Enter or double-click: automatic; right click: menu", "Ширина колонки: перетащите; стрелки ±8, Shift ±32; Enter или двойной щелчок — автоматическая; правая кнопка — меню")}
    onPointerDown={(event: ReactPointerEvent<HTMLSpanElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      start.current = { x: event.clientX, widths: measure() };
      setDragging(true);
      table()?.closest(".dr-table")?.setAttribute("data-resizing", "");
    }}
    onPointerMove={(event) => { if (start.current) set(start.current.widths, start.current.widths[column] + event.clientX - start.current.x); }}
    onPointerUp={() => { start.current = null; setDragging(false); table()?.closest(".dr-table")?.removeAttribute("data-resizing"); }}
    onPointerCancel={() => { start.current = null; setDragging(false); table()?.closest(".dr-table")?.removeAttribute("data-resizing"); }}
    onDoubleClick={() => resetWidths(widths, onWidths, column, label)}
    onKeyDown={(event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        const base = measure();
        set(base, base[column] + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 32 : 8));
      } else if (event.key === "Enter") { event.preventDefault(); resetWidths(widths, onWidths, column, label); }
      else if (onMenu && (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        onMenu(rect.left, rect.bottom, column, label);
      }
    }} />;
}

/** Show a faded zigzag edge and a hidden-column count on each side with offscreen columns. Clicking the count scrolls most of a viewport. Recompute on scrolling and resizing; hide indicators when everything fits. */
export function TableBox({ className, table, reset, children }: { className: string; table?: string; reset?: ReactNode; children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState({ left: 0, right: 0 });
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const update = () => {
      const box = element.getBoundingClientRect();
      const cells = [...(element.querySelector("table")?.rows[0]?.cells ?? [])].map((cell) => cell.getBoundingClientRect());
      const overflow = element.scrollWidth > element.clientWidth + 1;
      const left = overflow ? cells.filter((cell) => cell.width > 0 && cell.left < box.left - 1).length : 0;
      const right = overflow ? cells.filter((cell) => cell.width > 0 && cell.right > box.right + 1).length : 0;
      setHidden((current) => (current.left === left && current.right === right ? current : { left, right }));
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(element);
    const inner = element.querySelector("table");
    if (inner) observer?.observe(inner);
    return () => { element.removeEventListener("scroll", update); observer?.disconnect(); };
  }, []);
  const scroll = (direction: -1 | 1) => {
    const element = scroller.current;
    if (!element) return;
    const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollBy({ left: direction * Math.max(80, element.clientWidth * 0.8), behavior: still ? "auto" : "smooth" });
  };
  const edge = (side: "left" | "right", count: number) => {
    const label = tr(`${counted(count, W.column)} hidden to the ${side}: scroll`, `Не видно ${counted(count, W.column)} ${side === "left" ? "слева" : "справа"} — прокрутить`);
    return <div data-skip className={`dr-tedge dr-tedge--${side}`}>
      <Tip label={label}><button type="button" className="dr-tedge__pill" aria-label={label} onClick={() => scroll(side === "left" ? -1 : 1)}>
        {side === "left" && <Icon name="ChevronLeft" />}<span>{count}</span>{side === "right" && <Icon name="ChevronRight" />}
      </button></Tip>
    </div>;
  };
  return <div className="dr-tablebox" data-hidden-left={hidden.left > 0 || undefined} data-hidden-right={hidden.right > 0 || undefined}>
    <div ref={scroller} className={className} data-dr-table={table}>{children}</div>
    {hidden.left > 0 && edge("left", hidden.left)}
    {hidden.right > 0 && edge("right", hidden.right)}
    {reset}
  </div>;
}

/** Slices of a CSV/TSV record as written: cells with their quotes; the separators between them. */
function splitRecord(text: string, delimiter: string): string[] {
  const cells: string[] = [];
  let at = 0;
  let quoted = false;
  let start = 0;
  for (; at < text.length; at++) {
    const char = text[at];
    if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) { cells.push(text.slice(start, at)); start = at + 1; }
  }
  cells.push(text.slice(start));
  return cells;
}

/** Text that stays in the DOM for the selection but is not shown (separators, quotes, «export »). */
const Hidden = ({ children }: { children: ReactNode }) => <span className="dr-sep">{children}</span>;

/** A cell's text with the masks of a secret value (the bullets) — the first one with the eye. */
function Masked({ text, secret, doc }: { text: string; secret: ViewSecret | null; doc: string }) {
  const at = text.indexOf("••••••••");
  if (at < 0) return <>{text}</>;
  const end = at + text.slice(at).match(/^•+/)![0].length;
  return <>{text.slice(0, at)}{secret ? <Mask doc={doc} secret={secret} bullets={text.slice(at, end)} /> : <span className="dr-mask__dots">{text.slice(at, end)}</span>}{text.slice(end)}</>;
}

function RowGutter({ block, number, handlers }: { block: ViewBlock; number: number; handlers: TableHandlers }) {
  const mark = markOf(block);
  const markers = handlers.markers.get(block.index) ?? [];
  const unread = block.read === "unread" || block.read === "ambiguous";
  // The row's gutter places markers, mark labels and actions on the left; the line
  // number always on the right — an action never covers the number.
  return <td className="dr-tno" data-skip>
    <span className="dr-tno__in">
      <span className="dr-tno__gut">
      {markers.length > 0 && <button type="button" className={`dr-cmark${markers.some((marker) => marker.waiting) ? " dr-cmark--waiting" : ""}`} onClick={() => handlers.onMarker(markers[0].annotationId)}
        aria-label={counted(markers.length, W.annotation)}><Icon name="MessageSquare" />{markers.length}</button>}
      {mark && <span className="dr-mlabel" title={mark.title}>{mark.word}</span>}
      <span className="dr-tno__acts">
        {handlers.writable && unread && <button type="button" className="dr-btn" aria-label={tr("Mark read (R)", "Прочитано (R)")} title={tr("Mark read · R", "Прочитано · R")} onClick={() => handlers.onRead(block.index)}><Icon name="Check" /></button>}
        {handlers.writable && <button type="button" className="dr-btn" aria-label={tr("Comment on row (C)", "Замечание к строке (C)")} title={tr("Comment · C", "Замечание · C")} onClick={() => handlers.onComment(block.index)}><Icon name="MessageSquarePlus" /></button>}
      </span>
      </span>
      <span className="dr-tno__n">{number}</span>
    </span>
  </td>;
}

function rowClass(block: ViewBlock, handlers: TableHandlers) {
  const mark = markOf(block);
  return [mark && mark.kind !== "moved" ? `dr-trow--${mark.kind === "unclear" ? "changed" : mark.kind}` : "", handlers.markers.has(block.index) ? "dr-trow--note" : "", handlers.focusBlocks.has(block.index) ? "dr-trow--focus" : ""].filter(Boolean).join(" ") || undefined;
}

function RemovedRows({ entries, columns, handlers }: { entries: ViewRemoved[] | undefined; columns: number; handlers: TableHandlers }) {
  if (!entries?.length) return null;
  return <>{entries.map((entry) => <tbody key={entry.tombstoneId} data-tombstone={entry.tombstoneId} data-skip><tr className="dr-trow--removed">
    <td className="dr-tno">{handlers.writable && <button type="button" className="dr-btn dr-btn--icon" aria-label={tr("Mark removed read", "Удалённое прочитано")} title={tr("Mark read", "Прочитано")} onClick={() => handlers.onReadRemoved(entry.tombstoneId)}><Icon name="Check" /></button>}</td>
    <td colSpan={columns}><span className="dr-cl__gone"><Icon name="Trash2" /><b>{tr("Removed", "Удалено")}</b></span> <s className="dr-meta">{entry.text.slice(0, 200)}</s></td>
  </tr></tbody>)}</>;
}

/** .env table: key, value and comment columns; standalone comment lines span the row. */
export const EnvTable = memo(function EnvTable({ blocks, meta, removed, secrets, handlers }: { blocks: ViewBlock[]; meta: BlockMeta[]; removed: ViewRemoved[]; secrets: ViewSecret[]; handlers: TableHandlers }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const [widths, setWidths] = useColumnWidths(`${handlers.doc}#env`);
  const after = new Map<number, ViewRemoved[]>();
  for (const entry of removed) after.set(entry.after, [...(after.get(entry.after) ?? []), entry]);
  const heads = [tr("Key", "Ключ"), tr("Value", "Значение"), tr("Comment", "Комментарий")];
  const menu = useColumnMenu(widths, setWidths);
  return <TableBox className={`dr-table dr-table--grid dr-table--env${sizedClass(widths)}`} table="env" reset={<ColumnsReset widths={widths} onWidths={setWidths} />}>
    <table ref={tableRef}>
      {widths && <colgroup><col className="dr-tno-col" />{heads.map((_, index) => <col key={index} style={{ width: widthsOf(widths)![index + 1] }} />)}</colgroup>}
      <thead data-skip><tr><th className="dr-tno" aria-label={tr("Line", "Строка")} />{heads.map((head, index) => <th key={head} scope="col" style={{ position: "relative", zIndex: heads.length - index + 1 }} onContextMenu={menu.onContextMenu(index + 1, head)}>{head}
        <ColumnHandle column={index + 1} label={head} table={() => tableRef.current} widths={widths} onWidths={setWidths} onMenu={menu.open} /></th>)}</tr></thead>
      <RemovedRows entries={after.get(-1)} columns={3} handlers={handlers} />
      {blocks.map((block, order) => {
        const entry = meta[block.index] ?? null;
        const text = block.text;
        let cells: ReactNode;
        if (entry?.kind === "pair" && entry.key && text.indexOf(entry.key) >= 0) {
          const keyAt = text.indexOf(entry.key);
          const eq = text.indexOf("=", keyAt + entry.key.length);
          const commentAt = entry.comment ? text.lastIndexOf(entry.comment) : -1;
          const valueEnd = commentAt > eq ? commentAt : text.length;
          const secret = secrets.find((candidate) => candidate.key === entry.key && candidate.path && candidate.path.length === 1) ?? null;
          cells = <>
            <td><Hidden>{text.slice(0, keyAt)}</Hidden>{text.slice(keyAt, eq < 0 ? text.length : eq)}</td>
            <td>{eq >= 0 && <Hidden>{text.slice(eq, eq + 1)}</Hidden>}<Masked text={eq >= 0 ? text.slice(eq + 1, valueEnd) : ""} secret={secret} doc={handlers.doc} /></td>
            <td className="dr-sy-c">{commentAt > eq ? text.slice(valueEnd) : ""}</td>
          </>;
        } else cells = <td colSpan={3} className={/^\s*#/.test(text) ? "dr-sy-c" : undefined}><Masked text={text} secret={null} doc={handlers.doc} /></td>;
        return <Fragment key={block.index}>
          <tbody data-block={block.index} data-lineage={block.lineageId} className={rowClass(block, handlers)} tabIndex={-1}>
            <tr data-text><RowGutter block={block} number={order + 1} handlers={handlers} />{cells}</tr>
          </tbody>
          <RemovedRows entries={after.get(block.index)} columns={3} handlers={handlers} />
        </Fragment>;
      })}
    </table>
    {menu.element}
  </TableBox>;
});

/** CSV/TSV: the header row (the first record), line numbers, horizontal scrolling; quotes kept in the DOM, not shown. */
export const CsvTable = memo(function CsvTable({ blocks, meta, removed, delimiter, handlers }: { blocks: ViewBlock[]; meta: BlockMeta[]; removed: ViewRemoved[]; delimiter: string; handlers: TableHandlers }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const [widths, setWidths] = useColumnWidths(`${handlers.doc}#csv`);
  const menu = useColumnMenu(widths, setWidths);
  const after = new Map<number, ViewRemoved[]>();
  for (const entry of removed) after.set(entry.after, [...(after.get(entry.after) ?? []), entry]);
  const columns = Math.max(1, ...blocks.map((block) => meta[block.index]?.cells?.length ?? splitRecord(block.text, delimiter).length));
  const header = blocks[0] && meta[blocks[0].index]?.header ? blocks[0] : null;
  const names = header ? splitRecord(header.text, delimiter).map((name) => name.replace(/^"|"$/g, "")) : [];
  const nameOf = (index: number) => names[index] || `${index + 1}`;
  // The text range of a cell in the document (code points; without its quotes) — what «Comment on cell» anchors to.
  const cellRange = (block: ViewBlock, slices: string[], index: number) => {
    let at = block.range.start;
    for (let i = 0; i < index; i++) at += [...slices[i]].length + [...delimiter].length;
    const slice = slices[index];
    const quoted = slice.length >= 2 && slice.startsWith('"') && slice.endsWith('"');
    const inner = quoted ? slice.slice(1, -1) : slice;
    const start = at + (quoted ? 1 : 0);
    return { range: { start, end: start + [...inner].length }, quote: inner };
  };
  const canComment = Boolean(handlers.writable && handlers.onCommentText);
  const commentCell = (block: ViewBlock, slices: string[], index: number, element: Element | null) => {
    const { range, quote } = cellRange(block, slices, index);
    if (quote.trim()) handlers.onCommentText?.(range, quote, element?.getBoundingClientRect() ?? null);
  };
  const [cellMenu, setCellMenu] = useState<{ x: number; y: number; block: ViewBlock; slices: string[]; index: number; element: Element } | null>(null);
  const cellsOf = (block: ViewBlock, Cell: "td" | "th") => {
    const slices = splitRecord(block.text, delimiter);
    return <>{Array.from({ length: columns }, (_, index) => {
      const slice = slices[index];
      const quoted = slice !== undefined && slice.length >= 2 && slice.startsWith('"') && slice.endsWith('"');
      const commentable = canComment && Cell === "td" && slice !== undefined && (quoted ? slice.slice(1, -1) : slice).trim() !== "";
      // Sticky header cells are stacking contexts: the earlier one on top, or the next cell covers half of its width handle.
      return <Cell key={index} scope={Cell === "th" ? "col" : undefined} style={Cell === "th" ? { position: "relative", zIndex: columns - index + 1 } : undefined}
        onContextMenu={Cell === "th" ? menu.onContextMenu(index + 1, slice ?? `${index + 1}`) : commentable ? (event: ReactMouseEvent) => {
          if (event.shiftKey || window.getSelection()?.isCollapsed === false) return;
          event.preventDefault();
          setCellMenu({ x: Math.min(event.clientX, window.innerWidth - 8), y: event.clientY, block, slices, index, element: event.currentTarget });
        } : undefined}>
        {index > 0 && slice !== undefined && <Hidden>{delimiter}</Hidden>}
        {slice === undefined ? null : quoted ? <><Hidden>"</Hidden><Masked text={slice.slice(1, -1)} secret={null} doc={handlers.doc} /><Hidden>"</Hidden></> : <Masked text={slice} secret={null} doc={handlers.doc} />}
        {index === columns - 1 && slices.length > columns && <Hidden>{delimiter}{slices.slice(columns).join(delimiter)}</Hidden>}
        {Cell === "th" && <ColumnHandle column={index + 1} label={slice ?? `${index + 1}`} table={() => tableRef.current} widths={widths} onWidths={setWidths} onMenu={menu.open} />}
        {commentable && <button type="button" data-skip className="dr-cellnote" aria-label={tr(`Comment on cell “${nameOf(index)}”, row ${blocks.indexOf(block) + 1}`, `Замечание к ячейке «${nameOf(index)}», строка ${blocks.indexOf(block) + 1}`)} title={tr("Comment on cell", "Замечание к ячейке")}
          onClick={(event) => commentCell(block, slices, index, event.currentTarget.parentElement)}><Icon name="MessageSquarePlus" /></button>}
      </Cell>;
    })}</>;
  };
  return <TableBox className={`dr-table dr-table--grid${sizedClass(widths)}`} table="csv" reset={<ColumnsReset widths={widths} onWidths={setWidths} />}>
    <table ref={tableRef}>
      {widths && <colgroup><col className="dr-tno-col" />{Array.from({ length: columns }, (_, index) => <col key={index} style={{ width: widthsOf(widths)![index + 1] }} />)}</colgroup>}
      {header
        ? <thead data-block={header.index} data-lineage={header.lineageId} className={rowClass(header, handlers)}><tr data-text><RowGutter block={header} number={1} handlers={handlers} />{cellsOf(header, "th")}</tr></thead>
        : <thead data-skip><tr><th className="dr-tno" />{Array.from({ length: columns }, (_, index) => <th key={index} scope="col" style={{ position: "relative", zIndex: columns - index + 1 }} onContextMenu={menu.onContextMenu(index + 1, `${index + 1}`)}>{index + 1}
          <ColumnHandle column={index + 1} label={`${index + 1}`} table={() => tableRef.current} widths={widths} onWidths={setWidths} onMenu={menu.open} /></th>)}</tr></thead>}
      <RemovedRows entries={after.get(-1)} columns={columns} handlers={handlers} />
      {header && <RemovedRows entries={after.get(header.index)} columns={columns} handlers={handlers} />}
      {blocks.map((block, order) => block === header ? null : <Fragment key={block.index}>
        <tbody data-block={block.index} data-lineage={block.lineageId} className={rowClass(block, handlers)} tabIndex={-1}>
          <tr data-text><RowGutter block={block} number={order + 1} handlers={handlers} />{cellsOf(block, "td")}</tr>
        </tbody>
        <RemovedRows entries={after.get(block.index)} columns={columns} handlers={handlers} />
      </Fragment>)}
    </table>
    {menu.element}
    {cellMenu && <Menu open onOpenChange={(next) => { if (!next) setCellMenu(null); }}>
      <MenuTrigger asChild><span aria-hidden style={{ position: "fixed", left: cellMenu.x, top: cellMenu.y, width: 1, height: 1 }} /></MenuTrigger>
      <MenuContent align="start" mobileTitle={tr(`Cell “${nameOf(cellMenu.index)}”`, `Ячейка «${nameOf(cellMenu.index)}»`)}>
        <MenuLabel className="dr-trunc">{nameOf(cellMenu.index)} · {tr("row", "строка")} {blocks.indexOf(cellMenu.block) + 1}</MenuLabel>
        <MenuItem onSelect={() => commentCell(cellMenu.block, cellMenu.slices, cellMenu.index, cellMenu.element)}><Icon name="MessageSquarePlus" />{tr("Comment on cell", "Замечание к ячейке")}</MenuItem>
        <MenuItem onSelect={() => handlers.onComment(cellMenu.block.index)}><Icon name="MessageSquarePlus" />{tr("Comment on row", "Замечание к строке")}<Kbd>C</Kbd></MenuItem>
      </MenuContent>
    </Menu>}
  </TableBox>;
});
