// The Pretty view of YAML/JSON/TOML: one key-tree row per structured node,
// projection — indentation with guides by the key path, chevrons and counters of groups, collapsing with the mouse and
// the keyboard (WAI-ARIA tree), a filter (F), the breadcrumbs of the focused node, the menu of a node (copy the path in
// three forms, copy value and Not a secret actions, unread marks and Before/After comparisons. Row text is the
// node as written (`[data-text]` spells the block's projected text exactly: selections, quotes and highlights map as in
// Markdown); colours are the syntax roles of “Raw”. Secret values are masks with an eye (ui/mask.tsx).
import { copyText } from "./copy.tsx";
import { Fragment, memo, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ViewAnnotation, ViewBlock, ViewRemoved, ViewSecret } from "../node/view.ts";
import { highlightLines, type Language } from "../core/formats/highlight.ts";
import { dottedPath, jqPath, jsonPointer, type PathSegment } from "../core/formats/paths.ts";
import { Icon } from "./icons.tsx";
import { Kbd, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "./kit.tsx";
import { Mask } from "./mask.tsx";
import { DiffText, markOf } from "./render.tsx";
import type { BlockMeta } from "./source.ts";
import { notify } from "./store.ts";
import { tr } from "../core/i18n.ts";
import { W, counted } from "./words.ts";

export interface TreeHandlers {
  doc: string;
  language: Language;
  showDiff: boolean;
  writable: boolean;
  markers: Map<number, ViewAnnotation[]>;
  focusBlocks: Set<number>;
  /** Group blocks that are collapsed (kept by the page per document: ⇧[ / ⇧] and the chevrons share it). */
  collapsed: Set<number>;
  onToggle(block: number, open: boolean): void;
  onCollapseInside(block: number): void;
  onRead(block: number): void;
  onReadSection(block: number): void;
  onComment(block: number): void;
  onReadRemoved(tombstoneId: string): void;
  onMarker(annotationId: string): void;
  onExempt(secret: ViewSecret): void;
}

const MASK_RUN = /•{8}/g;
const samePath = (a: readonly PathSegment[] | null | undefined, b: readonly PathSegment[] | null | undefined) => Boolean(a && b) && JSON.stringify(a) === JSON.stringify(b);
const isPrefix = (prefix: string, path: string) => path.length > prefix.length && path.startsWith(prefix.slice(0, -1)) && path[prefix.length - 1] === ",";

/** Highlighted text of a row with the masks of its secret values in place of the bullets. */
function RowText({ text, language, secret, doc }: { text: string; language: Language; secret: ViewSecret | null; doc: string }) {
  const lines = text.split("\n");
  const tokens = highlightLines(language, lines);
  const out: ReactNode[] = [];
  let maskShown = false;
  lines.forEach((line, row) => {
    if (row > 0) out.push("\n");
    const cuts: { s: number; e: number; role?: string; mask?: boolean }[] = [];
    let at = 0;
    const masks = [...line.matchAll(MASK_RUN)].map((match) => ({ s: match.index!, e: match.index! + match[0].length }));
    const plain = (s: number, e: number) => {
      let cursor = s;
      for (const token of tokens[row] ?? []) {
        if (token.e <= s || token.s >= e) continue;
        const ts = Math.max(token.s, s);
        const te = Math.min(token.e, e);
        if (ts > cursor) cuts.push({ s: cursor, e: ts });
        cuts.push({ s: ts, e: te, role: token.role });
        cursor = te;
      }
      if (cursor < e) cuts.push({ s: cursor, e });
    };
    for (const mask of masks) {
      if (mask.s > at) plain(at, mask.s);
      cuts.push({ s: mask.s, e: mask.e, mask: true });
      at = mask.e;
    }
    if (at < line.length) plain(at, line.length);
    cuts.forEach((cut, index) => {
      const slice = line.slice(cut.s, cut.e);
      const key = `${row}.${index}`;
      if (cut.mask && secret && !maskShown) { maskShown = true; out.push(<Mask key={key} doc={doc} secret={secret} bullets={slice} />); }
      else if (cut.mask) out.push(<span key={key} className="dr-mask__dots" title={tr("Value hidden: reveal it in “Raw”", "Значение скрыто: показать — в «Как есть»")}>{slice}</span>);
      else out.push(cut.role ? <span key={key} className={`dr-sy-${cut.role}`}>{slice}</span> : <Fragment key={key}>{slice}</Fragment>);
    });
  });
  return <>{out}</>;
}

interface Row {
  block: ViewBlock;
  meta: NonNullable<BlockMeta> | null;
  level: number;
  group: boolean;
  pathKey: string;
  docLabel: string | null;
}

const Node = memo(function Node({ row, open, focused, onPath, matched, secret, handlers, onMenu, onFocusRow }: {
  row: Row; open: boolean; focused: boolean; onPath: boolean; matched: boolean; secret: ViewSecret | null; handlers: TreeHandlers;
  onMenu: (row: Row, element: HTMLElement) => void; onFocusRow: (index: number) => void;
}) {
  const { block, meta, level, group } = row;
  const mark = markOf(block);
  const markers = handlers.markers.get(block.index) ?? [];
  const waiting = markers.some((marker) => marker.waiting);
  const unread = block.read === "unread" || block.read === "ambiguous";
  const diff = handlers.showDiff && block.diff && unread ? block.diff : null;
  const last = meta?.path?.[meta.path.length - 1];
  const index = meta && meta.key === undefined && typeof last === "number" ? last : null;
  const count = group && meta?.count !== undefined ? counted(meta.count, meta.kind === "array" ? W.element : W.key) : null;
  const classes = ["dr-kn", mark && mark.kind !== "moved" ? `dr-kn--${mark.kind === "unclear" ? "changed" : mark.kind}` : "", markers.length ? "dr-kn--note" : "",
    handlers.focusBlocks.has(block.index) ? "dr-kn--focus" : "", onPath ? "dr-kn--path" : "", matched ? "dr-kn--match" : ""].filter(Boolean).join(" ");
  return <>
    {meta?.comment && !/^\s*$/.test(meta.comment) && block.text.indexOf(meta.comment) < 0 && <div className="dr-kn" role="none" data-skip>
      <span className="dr-kn__gut" /><span className="dr-kn__body" style={{ ["--dr-lvl" as string]: level }}><span className="dr-kn__comment">{meta.comment}</span></span></div>}
    <div className={classes} role="treeitem" aria-level={level + 1} aria-expanded={group ? open : undefined} aria-selected={focused} tabIndex={focused ? 0 : -1}
      data-block={block.index} data-lineage={block.lineageId} onFocus={(event) => { if (event.target === event.currentTarget) onFocusRow(block.index); }}
      onContextMenu={(event) => { event.preventDefault(); onMenu(row, event.currentTarget); }}>
      <span className="dr-kn__gut" data-skip>
        {mark && <span className="dr-mlabel" title={mark.title}>{mark.word}</span>}
        {markers.length > 0 && <button type="button" className={`dr-cmark${waiting ? " dr-cmark--waiting" : ""}`} onClick={() => handlers.onMarker(markers[0].annotationId)}
          aria-label={`${counted(markers.length, W.annotation)}${waiting ? tr(", reply awaits your decision", ", ответ ждёт решения") : ""}`} title={waiting ? tr("Agent reply awaits your decision", "Ответ агента ждёт решения") : tr("Open comments", "Открыть замечания")}><Icon name="MessageSquare" />{markers.length}</button>}
      </span>
      <span className="dr-kn__body" style={{ ["--dr-lvl" as string]: level }}>
        {group && <button type="button" className="dr-kn__chev" data-skip tabIndex={-1} aria-hidden onClick={() => handlers.onToggle(block.index, !open)}><Icon name={open ? "ChevronDown" : "ChevronRight"} /></button>}
        {index !== null && <span className="dr-kn__idx" data-skip>{index}</span>}
        {diff && !diff.rewritten
          ? <span data-text className="dr-kn__val"><DiffText words={diff.words} /></span>
          : <>{diff?.rewritten && <><span className="dr-kn__was" data-skip>{diff.before}</span><Icon name="MoveRight" className="dr-kn__arrow" aria-hidden /></>}
            <span data-text className="dr-kn__val"><RowText text={block.text} language={handlers.language} secret={secret} doc={handlers.doc} /></span></>}
        {count && <span className="dr-kn__count" data-skip>{open ? count : `{…} ${count}`}</span>}
        {group && meta?.anchor && <span className="dr-kn__anchor" data-skip title={tr("Anchor", "Якорь")}>&amp;{meta.anchor}</span>}
        <span className="dr-kn__acts" data-skip>
          <button type="button" className="dr-btn" aria-label={tr("Node actions (⇧ F10)", "Действия узла (⇧ F10)")} title={tr("Copy path, value…", "Копировать путь, значение…")} onClick={(event) => onMenu(row, event.currentTarget)}><Icon name="Copy" /></button>
          {handlers.writable && <button type="button" className="dr-btn" aria-label={tr("Comment (C)", "Замечание (C)")} title={tr("Comment · C", "Замечание · C")} onClick={() => handlers.onComment(block.index)}><Icon name="MessageSquarePlus" /></button>}
          {handlers.writable && unread && <button type="button" className="dr-btn" aria-label={tr("Mark read (R)", "Прочитано (R)")} title={tr("Mark read · R", "Прочитано · R")} onClick={() => (group ? handlers.onReadSection(block.index) : handlers.onRead(block.index))}><Icon name="Check" /></button>}
        </span>
      </span>
    </div>
  </>;
});

/** Removed nodes: the folded line «Deleted» at the place of the node, as for a removed block. */
function RemovedNode({ removed, level, handlers }: { removed: ViewRemoved; level: number; handlers: TreeHandlers }) {
  return <div className="dr-kn dr-kn--removed" data-tombstone={removed.tombstoneId} data-skip role="none">
    <span className="dr-kn__gut"><span className="dr-mlabel" style={{ color: "var(--dr-removed)" }}>{tr("removed", "удалено")}</span></span>
    <span className="dr-kn__body" style={{ ["--dr-lvl" as string]: level }}>
      <span className="dr-cl__gone"><Icon name="Trash2" /><b>{tr("Removed", "Удалено")}</b></span>
      <span className="dr-kn__gonetext">{removed.text.split("\n")[0].slice(0, 160)}</span>
      {handlers.writable && <span className="dr-kn__acts"><button type="button" className="dr-btn" aria-label={tr("Mark removed read", "Удалённое прочитано")} title={tr("Mark read", "Прочитано")} onClick={() => handlers.onReadRemoved(removed.tombstoneId)}><Icon name="Check" /></button></span>}
    </span>
  </div>;
}

export const KeyTree = memo(function KeyTree({ blocks, meta, removed, secrets, handlers }: {
  blocks: ViewBlock[]; meta: BlockMeta[]; removed: ViewRemoved[]; secrets: ViewSecret[]; handlers: TreeHandlers;
}) {
  const [filter, setFilter] = useState("");
  const [focus, setFocus] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ row: Row; x: number; y: number } | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const multiDoc = useMemo(() => meta.some((entry) => entry?.kind === "document"), [meta]);
  const rows: Row[] = useMemo(() => blocks.map((block) => {
    const entry = meta[block.index] ?? null;
    const path = entry?.path ?? [];
    const keys = path.filter((segment) => typeof segment !== "object");
    const group = block.type === "group";
    const docSegment = path[0] !== undefined && typeof path[0] === "object" ? (path[0] as { doc: number }).doc : null;
    const docLabel = entry?.kind === "document" && multiDoc ? tr(`Document ${(docSegment ?? 0) + 1}`, `Документ ${(docSegment ?? 0) + 1}`) : null;
    return { block, meta: entry, level: Math.max(0, keys.length - 1), group: group && entry?.kind !== "document", pathKey: JSON.stringify(path), docLabel };
  }), [blocks, meta, multiDoc]);
  const secretOf = useMemo(() => {
    const map = new Map<number, ViewSecret>();
    for (const row of rows) {
      if (!row.meta?.path || !row.block.text.includes("••••••••")) continue;
      const found = secrets.find((secret) => samePath(secret.path, row.meta!.path));
      if (found) map.set(row.block.index, found);
    }
    return map;
  }, [rows, secrets]);
  const query = filter.trim().toLowerCase();
  // Visible rows: under a collapsed group nothing; with a filter — the matches and their ancestors, collapsing ignored.
  const visible = useMemo(() => {
    if (query) {
      const keep = new Set<string>();
      const matches = new Set<number>();
      for (const row of rows) {
        if (!row.block.text.toLowerCase().includes(query)) continue;
        matches.add(row.block.index);
        const path = row.meta?.path ?? [];
        for (let length = 1; length <= path.length; length++) keep.add(JSON.stringify(path.slice(0, length)));
      }
      return { rows: rows.filter((row) => matches.has(row.block.index) || keep.has(row.pathKey)), matches };
    }
    const out: Row[] = [];
    let hiddenUnder: string | null = null;
    for (const row of rows) {
      if (hiddenUnder && isPrefix(hiddenUnder, row.pathKey)) continue;
      hiddenUnder = null;
      out.push(row);
      if (row.group && handlers.collapsed.has(row.block.index)) hiddenUnder = row.pathKey;
    }
    return { rows: out, matches: new Set<number>() };
  }, [rows, query, handlers.collapsed]);
  const removedAfter = useMemo(() => {
    const map = new Map<number, ViewRemoved[]>();
    for (const entry of removed) map.set(entry.after, [...(map.get(entry.after) ?? []), entry]);
    return map;
  }, [removed]);
  const focusedRow = rows.find((row) => row.block.index === focus) ?? null;
  const focusPath = focusedRow?.meta?.path ?? [];
  const tabStop = visible.rows.some((row) => row.block.index === focus) ? focus : visible.rows[0]?.block.index ?? null;
  const ancestorKeys = useMemo(() => {
    const set = new Set<string>();
    for (let length = 1; length < focusPath.length; length++) set.add(JSON.stringify(focusPath.slice(0, length)));
    return set;
  }, [focusPath]);

  const moveFocus = (index: number | undefined) => {
    if (index === undefined) return;
    setFocus(index);
    requestAnimationFrame(() => treeRef.current?.querySelector<HTMLElement>(`[role=treeitem][data-block="${index}"]`)?.focus({ preventScroll: false }));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, button:not([role=treeitem])") && target.getAttribute("role") !== "treeitem") return;
    const at = visible.rows.findIndex((row) => row.block.index === tabStop);
    const row = visible.rows[at];
    if (!row) return;
    const open = row.group && !handlers.collapsed.has(row.block.index);
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); moveFocus(visible.rows[at + 1]?.block.index); break;
      case "ArrowUp": event.preventDefault(); moveFocus(visible.rows[at - 1]?.block.index); break;
      case "Home": event.preventDefault(); moveFocus(visible.rows[0]?.block.index); break;
      case "End": event.preventDefault(); moveFocus(visible.rows[visible.rows.length - 1]?.block.index); break;
      case "ArrowRight":
        event.preventDefault();
        if (row.group && !open) handlers.onToggle(row.block.index, true);
        else if (row.group) moveFocus(visible.rows[at + 1]?.block.index);
        break;
      case "ArrowLeft": {
        event.preventDefault();
        if (open && !query) { handlers.onToggle(row.block.index, false); break; }
        const parentKey = JSON.stringify((row.meta?.path ?? []).slice(0, -1));
        moveFocus(visible.rows.slice(0, at).reverse().find((candidate) => candidate.pathKey === parentKey)?.block.index);
        break;
      }
      case "F10": if (event.shiftKey) { event.preventDefault(); const element = treeRef.current?.querySelector<HTMLElement>(`[role=treeitem][data-block="${row.block.index}"]`); if (element) openMenu(row, element); } break;
      case "ContextMenu": { event.preventDefault(); const element = treeRef.current?.querySelector<HTMLElement>(`[role=treeitem][data-block="${row.block.index}"]`); if (element) openMenu(row, element); break; }
      case "f": case "F": if (!event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); filterRef.current?.focus(); } break;
      default: break;
    }
  };
  const openMenu = (row: Row, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setFocus(row.block.index);
    setMenu({ row, x: Math.min(rect.right - 8, window.innerWidth - 8), y: rect.bottom });
  };
  const copy = (text: string, what: "path" | "value") => {
    const shown = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    const done = what === "path" ? tr(`Path copied: ${shown}`, `Путь скопирован: ${shown}`) : tr(`Value copied: ${shown}`, `Значение скопировано: ${shown}`);
    void copyText(text).then(() => notify(done), () => notify(tr("Couldn't copy: clipboard unavailable", "Не удалось скопировать: буфер обмена недоступен"), { tone: "error" }));
  };
  const menuRow = menu?.row ?? null;
  const menuSecret = menuRow ? secretOf.get(menuRow.block.index) ?? null : null;
  const menuPath = menuRow?.meta?.path ?? null;

  const crumbs = focusPath.flatMap((segment, at) => (typeof segment === "object" ? [] : [{ segment, prefix: focusPath.slice(0, at + 1) }]));
  return <div className="dr-kt" role="tree" aria-label={handlers.doc} ref={treeRef} onKeyDown={onKeyDown} data-dr-keytree>
    <div className="dr-ktbar" data-skip data-dr-sticky="inner">
      <nav className="dr-ktpath" aria-label={tr("Node path", "Путь узла")}>
        {crumbs.map(({ segment, prefix }, index) => {
          const target = rows.find((row) => row.pathKey === JSON.stringify(prefix));
          return <Fragment key={index}>{index > 0 && <span aria-hidden>›</span>}<button type="button" onClick={() => moveFocus(target?.block.index)} title={dottedPath(prefix)}>
            {typeof segment === "number" ? `[${segment}]` : segment}</button></Fragment>;
        })}
      </nav>
      <label className="dr-field" title={tr("Filter keys and values · F", "Фильтр ключей и значений · F")}>
        <Icon name="ListFilter" />
        <input ref={filterRef} value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={tr("Filter keys and values", "Фильтр ключей и значений")} aria-label={tr("Filter keys and values (F)", "Фильтр ключей и значений (F)")}
          onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setFilter(""); moveFocus(tabStop ?? undefined); } else if (event.key === "ArrowDown") { event.preventDefault(); moveFocus(visible.rows[0]?.block.index); } }} />
        {filter ? <button type="button" className="dr-btn dr-btn--ghost dr-btn--icon dr-btn--sm" aria-label={tr("Clear filter", "Очистить фильтр")} onClick={() => setFilter("")}><Icon name="X" /></button> : <Kbd>F</Kbd>}
      </label>
    </div>
    {query && visible.matches.size === 0 && <div className="dr-kn" role="none" data-skip><span className="dr-kn__gut" /><span className="dr-kn__body dr-meta">{tr(`Nothing found for “${filter}”`, `Ничего не найдено по «${filter}»`)}</span></div>}
    {(removedAfter.get(-1) ?? []).map((entry) => <RemovedNode key={entry.tombstoneId} removed={entry} level={0} handlers={handlers} />)}
    {visible.rows.map((row) => <Fragment key={row.block.index}>
      {row.docLabel && <div className="dr-kn__doc" data-skip>{row.docLabel}</div>}
      {row.meta?.kind === "document"
        ? <div data-block={row.block.index} data-lineage={row.block.lineageId} hidden={!row.block.text}><span data-text className="dr-meta">{row.block.text}</span></div>
        : <Node row={row} open={!handlers.collapsed.has(row.block.index) || Boolean(query)} focused={tabStop === row.block.index} onPath={ancestorKeys.has(row.pathKey)}
          matched={visible.matches.has(row.block.index)} secret={secretOf.get(row.block.index) ?? null} handlers={handlers} onMenu={openMenu} onFocusRow={setFocus} />}
      {(removedAfter.get(row.block.index) ?? []).map((entry) => <RemovedNode key={entry.tombstoneId} removed={entry} level={row.level} handlers={handlers} />)}
    </Fragment>)}
    {menu && <Menu open onOpenChange={(open) => { if (!open) setMenu(null); }}>
      <MenuTrigger asChild><span aria-hidden style={{ position: "fixed", left: menu.x, top: menu.y, width: 1, height: 1 }} /></MenuTrigger>
      <MenuContent align="end" mobileTitle={tr("Node", "Узел")}>
        {menuPath && <MenuLabel className="dr-trunc" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{dottedPath(menuPath)}</MenuLabel>}
        {menuPath && <MenuItem onSelect={() => copy(dottedPath(menuPath), "path")}><Icon name="Copy" />{tr("Copy path", "Копировать путь")}</MenuItem>}
        {menuPath && <MenuItem onSelect={() => copy(jsonPointer(menuPath), "path")}><span style={{ width: 16 }} />JSON Pointer · {jsonPointer(menuPath) || "/"}</MenuItem>}
        {menuPath && <MenuItem onSelect={() => copy(jqPath(menuPath), "path")}><span style={{ width: 16 }} />jq · {jqPath(menuPath)}</MenuItem>}
        {menuRow && !menuRow.group && <MenuItem disabled={Boolean(menuSecret) || menuRow.block.text.includes("••••••••")} onSelect={() => copy(menuRow.meta?.value ?? menuRow.block.text, "value")}>
          <Icon name="ClipboardCopy" />{tr("Copy value", "Копировать значение")}{(menuSecret || menuRow.block.text.includes("••••••••")) && <span className="dr-meta">{tr(" · for a secret, only after reveal", " · у секрета — только после показа")}</span>}</MenuItem>}
        {menuRow?.group && <MenuItem onSelect={() => handlers.onCollapseInside(menuRow.block.index)}><Icon name="ChevronsDownUp" />{tr("Collapse all inside", "Свернуть всё внутри")}</MenuItem>}
        {handlers.writable && menuRow && <><MenuSeparator />
          <MenuItem onSelect={() => handlers.onComment(menuRow.block.index)}><Icon name="MessageSquarePlus" />{tr("Comment", "Замечание")}<Kbd>C</Kbd></MenuItem>
          {(menuRow.block.read === "unread" || menuRow.block.read === "ambiguous") && <MenuItem onSelect={() => (menuRow.group ? handlers.onReadSection(menuRow.block.index) : handlers.onRead(menuRow.block.index))}><Icon name="Check" />{tr("Mark read", "Прочитано")}<Kbd>R</Kbd></MenuItem>}</>}
        {menuSecret && !menuSecret.explicit && <MenuItem onSelect={() => handlers.onExempt(menuSecret)}><Icon name="ShieldOff" />{tr("Not a secret…", "Не секрет…")}</MenuItem>}
      </MenuContent>
    </Menu>}
  </div>;
});
