// “Raw” (W-06c, file-types.md §6, EP-042): one code view for every format — line numbers (a personal setting),
// syntax roles --dr-syn-* (F22), long-line wrapping, folding by structure (nodes of YAML/JSON/TOML, sections of
// Markdown), marks of unread changes on the lines of their blocks (the line on the left edge, the word in the gutter,
// the wash), comment markers and «Mark read / Comment» per line — a line belongs to the innermost block that covers it,
// so a comment on a line is a comment on that node (anchored by key path, not by the line number). Secret values are
// masks with an eye (ui/mask.tsx); the text is the redacted source the host sent — it never holds a value.
import { Fragment, memo, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ViewAnnotation, ViewBlock, ViewRemoved, ViewSecret } from "../node/view.ts";
import { highlightLines, type Language, type Token } from "../core/formats/highlight.ts";
import { Icon } from "./icons.tsx";
import { Mask } from "./mask.tsx";
import { markOf } from "./render.tsx";
import type { SourceInfo } from "./source.ts";
import { tr } from "../core/i18n.ts";
import { W, counted } from "./words.ts";

export interface CodeHandlers {
  doc: string;
  language: Language;
  wrap: boolean;
  numbers: boolean;
  writable: boolean;
  markers: Map<number, ViewAnnotation[]>;
  focusBlocks: Set<number>;
  /** Lines whose fold is closed (kept by the page per document, so ⇧[ / ⇧] and the chevrons share it). */
  closed: Set<number>;
  onFold(line: number, open: boolean): void;
  onRead(block: number): void;
  onComment(block: number): void;
  onReadRemoved(tombstoneId: string): void;
  onMarker(annotationId: string): void;
}

/** Lines mounted at once; the rest follow in idle time (a 1 MB JSON has tens of thousands of lines). */
const SLICE = 1500;

/** The innermost block of each line (1-based): later blocks are nested deeper than the groups before them. */
function blocksByLine(blockLines: [number, number][], count: number): Int32Array {
  const owner = new Int32Array(count + 2).fill(-1);
  blockLines.forEach(([start, end], index) => {
    for (let line = start; line <= Math.min(end, count); line++) owner[line] = index;
  });
  return owner;
}

type Piece = { s: number; e: number; role?: Token["role"]; secret?: ViewSecret; first?: boolean };

/** Tokens of a line cut by the secret masks that cross it. */
function piecesOf(text: string, tokens: Token[], masks: { s: number; e: number; secret: ViewSecret; first: boolean }[]): Piece[] {
  const cuts: Piece[] = [];
  let at = 0;
  const plain = (s: number, e: number) => {
    // Fill a plain range with the highlighter's tokens inside it.
    let cursor = s;
    for (const token of tokens) {
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
    cuts.push({ s: mask.s, e: mask.e, secret: mask.secret, first: mask.first });
    at = Math.max(at, mask.e);
  }
  if (at < text.length) plain(at, text.length);
  return cuts;
}

const Line = memo(function Line({ no, text, tokens, masks, block, blockFirst, mark, markers, stop, fold, folded, removed, error, handlers }: {
  no: number; text: string; tokens: Token[]; masks: { s: number; e: number; secret: ViewSecret; first: boolean }[]; block: ViewBlock | null; blockFirst: boolean;
  mark: ReturnType<typeof markOf>; markers: ViewAnnotation[]; stop: boolean; fold: { end: number; label: string; inner: number } | null; folded: boolean; removed: ViewRemoved[]; error: string | null; handlers: CodeHandlers;
}) {
  const unread = block?.read === "unread" || block?.read === "ambiguous";
  const waiting = markers.some((marker) => marker.waiting);
  const classes = ["dr-cl", mark && mark.kind !== "moved" ? `dr-cl--${mark.kind === "unclear" ? "changed" : mark.kind}` : "", markers.length ? "dr-cl--note" : "", stop ? "dr-cl--stop" : "", error ? "dr-cl--error" : ""].filter(Boolean).join(" ");
  const src: ReactNode[] = piecesOf(text, tokens, masks).map((piece, index) => {
    const slice = text.slice(piece.s, piece.e);
    if (piece.secret) return piece.first ? <Mask key={index} doc={handlers.doc} secret={piece.secret} bullets={slice} /> : <span key={index} className="dr-mask__dots">{slice}</span>;
    return piece.role ? <span key={index} className={`dr-sy-${piece.role}`}>{slice}</span> : <Fragment key={index}>{slice}</Fragment>;
  });
  return <>
    <div className={classes} data-line={no} data-block={blockFirst && block ? block.index : undefined} data-lineage={blockFirst && block ? block.lineageId : undefined}
      tabIndex={blockFirst ? -1 : undefined} title={error ?? undefined}>
      <span className="dr-cl__gut" data-skip>
        {blockFirst && mark && <span className="dr-mlabel" title={mark.title}>{mark.word}</span>}
        {blockFirst && markers.length > 0 && <button type="button" className={`dr-cmark${waiting ? " dr-cmark--waiting" : ""}`} onClick={() => handlers.onMarker(markers[0].annotationId)}
          aria-label={`${counted(markers.length, W.annotation)}${waiting ? tr(", reply awaits your decision", ", ответ ждёт решения") : ""}`} title={waiting ? tr("Agent reply awaits your decision", "Ответ агента ждёт решения") : tr("Open comments", "Открыть замечания")}><Icon name="MessageSquare" />{markers.length}</button>}
        {block && <span className="dr-cl__acts">
          {blockFirst && unread && handlers.writable && <button type="button" className="dr-btn" aria-label={tr("Mark read (R)", "Прочитано (R)")} title={tr("Mark read · R", "Прочитано · R")} onClick={() => handlers.onRead(block.index)}><Icon name="Check" /></button>}
          {handlers.writable && <button type="button" className="dr-btn" aria-label={tr(`Comment on line ${no} (C)`, `Замечание к строке ${no} (C)`)} title={tr("Comment on line · C", "Замечание к строке · C")} onClick={() => handlers.onComment(block.index)}><Icon name="MessageSquarePlus" /></button>}
        </span>}
      </span>
      <span className="dr-cl__no" data-skip aria-hidden>{no}</span>
      <span className="dr-cl__fold" data-skip>{fold && <button type="button" aria-expanded={!folded} aria-label={tr(`${folded ? "Expand" : "Collapse"} lines ${no}–${fold.end}`, `${folded ? "Развернуть" : "Свернуть"} строки ${no}–${fold.end}`)}
        title={folded ? tr("Expand ] ", "Развернуть ] ") : tr("Collapse [", "Свернуть [")} onClick={() => handlers.onFold(no, folded)}><Icon name={folded ? "ChevronRight" : "ChevronDown"} /></button>}</span>
      <span className="dr-cl__src">{src}{folded && fold && <button type="button" data-skip className="dr-cl__folded" onClick={() => handlers.onFold(no, true)} title={tr("Expand", "Развернуть")}>
        {fold.label}{fold.inner > 0 && <> · <span className="dr-dot dr-dot--changed" aria-hidden />{counted(fold.inner, W.change)}</>}</button>}</span>
    </div>
    {removed.map((entry) => {
      const lines = entry.text.split("\n").length;
      return <div key={entry.tombstoneId} className="dr-cl dr-cl--removed" data-tombstone={entry.tombstoneId} data-skip>
        <span className="dr-cl__gut">{handlers.writable && <span className="dr-cl__acts" style={{ display: "flex" }}>
          <button type="button" className="dr-btn" aria-label={tr("Mark removed read", "Удалённое прочитано")} title={tr("Mark read", "Прочитано")} onClick={() => handlers.onReadRemoved(entry.tombstoneId)}><Icon name="Check" /></button></span>}</span>
        <span className="dr-cl__no" />
        <span className="dr-cl__fold" />
        <span className="dr-cl__src"><span className="dr-cl__gone" title={entry.text.slice(0, 400)}><Icon name="Trash2" /><b>{tr("Removed", "Удалено")}</b> {counted(lines, W.line)}</span></span>
      </div>;
    })}
  </>;
}, (a, b) => a.text === b.text && a.block === b.block && a.mark?.kind === b.mark?.kind && a.markers === b.markers && a.stop === b.stop && a.folded === b.folded
  && a.fold === b.fold && a.removed === b.removed && a.masks === b.masks && a.error === b.error && a.handlers.writable === b.handlers.writable && a.handlers.doc === b.handlers.doc);

/** A line to show once “Raw” of that file is mounted (a parse error of the agent's round, EP-044-T02). */
let pendingLine: { path: string; line: number } | null = null;
export function revealLineLater(path: string, line: number) {
  pendingLine = { path, line };
}

/** “Raw” of the shown revision. `blocks` — the view's blocks (by index), `source` — the redacted text and its lines. */
export const CodeView = memo(function CodeView({ blocks, removed, secrets, parseError, source, handlers }: {
  blocks: ViewBlock[]; removed: ViewRemoved[]; secrets: ViewSecret[]; parseError: { line: number; message: string } | null; source: SourceInfo; handlers: CodeHandlers;
}) {
  const lines = useMemo(() => source.source.replace(/\r\n?/g, "\n").split("\n"), [source.source]);
  // A trailing newline is not a line of its own.
  const count = lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  const tokens = useMemo(() => highlightLines(handlers.language, lines.slice(0, count)), [handlers.language, lines, count]);
  const owner = useMemo(() => blocksByLine(source.blockLines, count), [source.blockLines, count]);
  const firstLine = useMemo(() => new Map(source.blockLines.map(([start], index) => [start, index] as const).reverse()), [source.blockLines]);
  // Line starts (UTF-16) to cut the masks per line.
  const starts = useMemo(() => {
    const out = [0];
    for (let index = 0; index < source.source.length; index++) if (source.source.charCodeAt(index) === 10) out.push(index + 1);
    return out;
  }, [source.source]);
  const masks = useMemo(() => {
    const byLine = new Map<number, { s: number; e: number; secret: ViewSecret; first: boolean }[]>();
    for (const secret of secrets) {
      let line = secret.line;
      while (line >= 1 && starts[line - 1] > secret.start) line--;
      while (starts[line] !== undefined && starts[line] <= secret.start) line++;
      let first = true;
      for (let at = secret.start; at < secret.end && line <= count; line++) {
        const lineStart = starts[line - 1];
        const lineEnd = (starts[line] ?? source.source.length + 1) - 1;
        const s = Math.max(at, lineStart) - lineStart;
        const e = Math.min(secret.end, lineEnd) - lineStart;
        if (e > s) byLine.set(line, [...(byLine.get(line) ?? []), { s, e, secret, first }]);
        if (e > s) first = false;
        at = lineEnd + 1;
      }
    }
    for (const list of byLine.values()) list.sort((a, b) => a.s - b.s);
    return byLine;
  }, [secrets, starts, count, source.source.length]);
  const folds = useMemo(() => new Map(source.folds.map((fold) => [fold.line, fold] as const)), [source.folds]);
  const removedAfter = useMemo(() => {
    const map = new Map<number, ViewRemoved[]>();
    for (const entry of removed) {
      const line = entry.after < 0 ? 0 : source.blockLines[entry.after]?.[1] ?? 0;
      map.set(line, [...(map.get(line) ?? []), entry]);
    }
    return map;
  }, [removed, source.blockLines]);
  const blockOf = useMemo(() => new Map(blocks.map((block) => [block.index, block] as const)), [blocks]);
  const unreadLines = useMemo(() => {
    const out: number[] = [];
    source.blockLines.forEach(([start], index) => {
      const block = blockOf.get(index);
      if (block && (block.read === "unread" || block.read === "ambiguous")) out.push(start);
    });
    return out.sort((a, b) => a - b);
  }, [source.blockLines, blockOf]);
  const [limit, setLimit] = useState(() => (pendingLine?.path === handlers.doc ? Math.max(SLICE, pendingLine.line + 50) : SLICE));
  useEffect(() => {
    if (!pendingLine || pendingLine.path !== handlers.doc) return;
    const { line } = pendingLine;
    pendingLine = null;
    requestAnimationFrame(() => {
      const element = document.querySelector<HTMLElement>(`[data-dr-code] [data-line="${line}"]`);
      element?.scrollIntoView({ block: "center" });
      element?.setAttribute("data-arrived", "");
    });
  }, [handlers.doc]);
  useEffect(() => {
    if (limit >= count) return;
    const idle = (globalThis as { requestIdleCallback?: (fn: () => void) => number }).requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 16));
    idle(() => setLimit((value) => value + SLICE));
  }, [limit, count]);
  const empty: ViewAnnotation[] = useMemo(() => [], []);
  const none: ViewRemoved[] = useMemo(() => [], []);
  const noMasks: { s: number; e: number; secret: ViewSecret; first: boolean }[] = useMemo(() => [], []);
  const out: ReactNode[] = [];
  for (const entry of removedAfter.get(0) ?? []) out.push(<Line key={`r0${entry.tombstoneId}`} no={0} text="" tokens={[]} masks={noMasks} block={null} blockFirst={false} mark={null} markers={empty} stop={false} fold={null} folded={false} removed={[entry]} error={null} handlers={handlers} />);
  for (let no = 1; no <= Math.min(count, limit); no++) {
    const index = owner[no];
    const block = index >= 0 ? blockOf.get(index) ?? null : null;
    const blockFirst = block !== null && firstLine.get(no) === index;
    const fold = folds.get(no) ?? null;
    const folded = Boolean(fold && handlers.closed.has(no));
    let inner = 0;
    if (folded && fold) for (const line of unreadLines) if (line > no && line <= fold.end) inner++;
    out.push(<Line key={no} no={no} text={lines[no - 1]} tokens={tokens[no - 1] ?? []} masks={masks.get(no) ?? noMasks} block={block} blockFirst={blockFirst}
      mark={block && (blockFirst || block.type !== "group") ? markOf(block) : null} markers={blockFirst && block ? handlers.markers.get(block.index) ?? empty : empty}
      stop={Boolean(block && handlers.focusBlocks.has(block.index))} fold={fold ? { end: fold.end, label: fold.label, inner } : null} folded={folded}
      removed={removedAfter.get(no) ?? none} error={parseError?.line === no ? tr(`Parse error: ${parseError.message}`, `Ошибка разбора: ${parseError.message}`) : null} handlers={handlers} />);
    if (folded && fold) no = fold.end;
  }
  const width = `${String(count).length}ch`;
  return <div className={`dr-code${handlers.wrap ? " dr-code--wrap" : ""}${handlers.numbers ? "" : " dr-code--nonum"}`} style={{ ["--dr-lnw" as string]: handlers.numbers ? width : "0px" }}
    role="region" aria-label={tr("Raw", "Как есть")} data-dr-code>
    <div className="dr-code__lines">{out}</div>
    {limit < count && <div className="dr-cl" data-skip aria-hidden><span className="dr-cl__gut" /><span className="dr-cl__no" /><span className="dr-cl__fold" /><span className="dr-cl__src dr-meta">…</span></div>}
  </div>;
});

/** Lines of the folds that are open, for ⇧[ (fold everything) — the outermost first. */
export function allFoldLines(source: SourceInfo | null): number[] {
  return source ? source.folds.map((fold) => fold.line) : [];
}
