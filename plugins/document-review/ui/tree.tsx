// The tree of the roots (EP-011, EP-013-T01; design W-06 EP-019): one component for the sidebar tab of the sidebar-tabs
// host, the fallback column of the «Documents» screen and the embedded modes. Files and folders of all roots once with
// level guides, per-document signals with a dot and count, and the selected document with its
// sections grouped by a rail; path and heading search; Hide and
// Untracked with inherited rules; deleted virtual documents, rename proposals and checkout selection.
// Keyboard by APG Tree: ↑↓, →/← expand/collapse/parent, Home/End, Enter, Shift+F10 — the row menu, type-ahead.
import { useBbContext, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Icon } from "./icons.tsx";
import { useWorkbenchFocus } from "../focus-contract.ts";
import { Fragment, type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createLatest, useCommand } from "../feedback.ts";
import { acknowledgeAll, call, chooseDocument, explain, forgetLocal, hoverPrefetch, loadTree, requestEnable, resolveMove, resolveMoves, setRule, trackLocal } from "./actions.ts";
import { moveGroups, sureCandidate, splitPath } from "./moves-model.ts";
import type { MoveProposal } from "../node/tree.ts";
import { useDelayedFlag, useSlowFlag } from "../feedback.ts";
import { openExcludeFolder, openSettings, SettingsHost } from "./settings.tsx";
import { useAutoTransfer } from "./transfer.tsx";
import { useEnableJob } from "./enable-job.ts";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./kit.tsx";
import { Banner, BusyGlyph, busyProps, Button, CommandButton, Empty, IconButton, InlineError, Kbd, Menu, MenuCheck, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, SkeletonRows, Spinner, Tip, ToggleButton, WaitNote } from "./kit.tsx";
import { FORMATS, GROUP_LABEL, type FormatId, TYPE_GROUPS } from "../core/formats/registry.ts";
import { revealHeading, revealIndex } from "./reveal.ts";
import { contextKey, parseRoute, type Route, slug, subPathOf } from "./route.ts";
import { chooseReadingRoots, getUi, placeOf, recentContexts, setUi, type TreeEntryInfo, type TreeInfo, useChosen, useUi } from "./store.ts";
import { buildTree, type DirNode } from "./tree-model.ts";
import { VERB, W, counted, num, plural } from "./words.ts";
import { forms, tr } from "../core/i18n.ts";
export { treeOrder } from "./tree-model.ts";

export const PANEL_PATH = "docs";

type Contexts = { projects: { id: string; name: string }[]; hosts: { id: string; name: string; status: string }[]; environments: { id: string; projectId: string; hostId: string; path: string; name: string | null; branch: string | null; isGitRepo: boolean; isWorktree: boolean }[] };

let contextsCache: Contexts | null = null;
/** Checkouts of bb (cached); W-06b: a failure is returned with a retry instead of an endless skeleton. */
export function useContexts(): { contexts: Contexts | null; error: string | null; retry: () => void } {
  const [contexts, setContexts] = useState<Contexts | null>(contextsCache);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setError(null);
    void call<Contexts>("review.contexts", {}).then((reply) => {
      if (!current) return;
      if (reply.ok) {
        contextsCache = reply as unknown as Contexts;
        setContexts(contextsCache);
      } else setError(explain(reply.error));
    });
    return () => { current = false; };
  }, [attempt]);
  return { contexts, error, retry: () => setAttempt((value) => value + 1) };
}

/** Route of a checkout opened at its last document (A9: the last document per checkout is remembered). */
export function routeWithLastDoc(route: Route): Route {
  if (route.kind === "none") return route;
  return { ...route, doc: placeOf(contextKey(route)).doc };
}

/**
 * The checkout picker (EP-019-T03): search, «Recent», projects with machine and branch; an unavailable machine is
 * shown with «offline» and cannot be chosen — another machine is never substituted. Fully by keyboard.
 */
export function ContextList({ onPick, current, autoFocus = true, compact = false }: { onPick: (route: Route) => void; current?: string; autoFocus?: boolean; compact?: boolean }) {
  const { contexts, error: contextsError, retry: retryContexts } = useContexts();
  const slowContexts = useSlowFlag(!contexts && !contextsError);
  const bb = useBbContext();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => { listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);
  const hostOf = (id: string) => contexts?.hosts.find((host) => host.id === id);
  const label = (environmentId: string) => {
    const environment = contexts?.environments.find((entry) => entry.id === environmentId);
    const project = environment ? contexts?.projects.find((entry) => entry.id === environment.projectId) : null;
    return environment ? `${project?.name ?? tr("project", "проект")} · ${hostOf(environment.hostId)?.name ?? environment.hostId} · ${environment.branch ?? "—"}` : environmentId;
  };
  // An optional shared project focus filters checkouts; All checkouts removes the filter here.
  const workbenchFocus = useWorkbenchFocus();
  const [everything, setEverything] = useState(false);
  const focused = workbenchFocus.projectIds && !everything ? workbenchFocus.projectIds : null;
  const envInFocus = (environmentId: string) => !focused || focused.has(contexts?.environments.find((environment) => environment.id === environmentId)?.projectId ?? "");
  const recent = recentContexts().map((entry) => ({ ...entry, route: parseRoute(entry.subPath) })).filter((entry) => entry.route.kind !== "none")
    .filter((entry) => entry.route.kind !== "env" || envInFocus(entry.route.environmentId));
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = (contexts?.environments ?? []).filter((environment) => {
    if (focused && !focused.has(environment.projectId)) return false;
    const project = contexts?.projects.find((entry) => entry.id === environment.projectId);
    return project && terms.every((term) => `${project.name} ${environment.path} ${environment.branch ?? ""} ${hostOf(environment.hostId)?.name ?? ""}`.toLowerCase().includes(term));
  }).sort((a, b) => (a.projectId === bb.projectId ? -1 : 0) - (b.projectId === bb.projectId ? -1 : 0));
  const recentRows = terms.length ? [] : recent;
  type Row = { key: string; route: Route; title: ReactNode; detail: string; disabled: boolean; icon: string; group: "recent" | "all" };
  const all: Row[] = [
    ...recentRows.map((entry): Row => {
      const hostId = entry.route.kind === "host" ? entry.route.hostId : contexts?.environments.find((environment) => entry.route.kind === "env" && environment.id === entry.route.environmentId)?.hostId;
      const machine = hostId ? hostOf(hostId) : undefined;
      const offline = Boolean(machine && machine.status !== "connected");
      return { key: `r:${entry.subPath}`, route: { ...entry.route, doc: null } as Route, icon: offline ? "WifiOff" : "History", group: "recent",
        title: <span className="dr-trunc">{entry.route.kind === "env" ? label(entry.route.environmentId) : entry.label}</span>, detail: offline ? tr("offline", "нет связи") : "", disabled: offline };
    }),
    ...rows.map((environment): Row => {
      const project = contexts!.projects.find((entry) => entry.id === environment.projectId)!;
      const machine = hostOf(environment.hostId);
      const offline = machine?.status !== "connected";
      return { key: environment.id, route: { kind: "env", environmentId: environment.id, doc: null }, icon: offline ? "WifiOff" : "FolderGit2", group: "all",
        title: <span className="dr-trunc"><b style={{ fontWeight: 600 }}>{project.name}</b><span className="dr-meta"> · {machine?.name ?? environment.hostId} · {environment.branch ?? "—"}{environment.isWorktree ? " · worktree" : ""}</span></span>,
        detail: offline ? tr("offline", "нет связи") : environment.path.replace(/^\/Users\/[^/]+/, "~"), disabled: offline };
    }),
  ];
  const pick = (index: number) => {
    const row = all[index];
    if (row && !row.disabled) onPick(routeWithLastDoc(row.route));
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => Math.min(all.length - 1, value + 1)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); }
    if (event.key === "Home") { event.preventDefault(); setActive(0); }
    if (event.key === "End") { event.preventDefault(); setActive(Math.max(0, all.length - 1)); }
    if (event.key === "Enter") { event.preventDefault(); pick(active); }
  };
  const listId = "dr-contexts";
  return <div className={compact ? "flex min-h-0 flex-col gap-2" : "mx-auto flex w-full max-w-2xl flex-col gap-3 p-6"} data-dr>
    {!compact && <div>
      <h1 className="text-[22px] font-[650] tracking-[-0.015em]">{tr("Documents", "Документы")}</h1>
      <p className="mt-1 text-[13px] text-muted-foreground">{tr("Choose a checkout: project → machine, folder, branch. An unavailable machine is never replaced by another.", "Выберите рабочую копию: проект → машина, каталог, ветка. Недоступная машина не подменяется другой.")}</p>
    </div>}
    <label className="dr-field">
      <Icon name="Search" />
      <input autoFocus={autoFocus} value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={onKey}
        placeholder={tr("Project, path, branch or machine…", "Проект, путь, ветка или машина…")} aria-label={tr("Search checkouts", "Поиск рабочей копии")} role="combobox" aria-expanded aria-controls={listId} aria-activedescendant={all[active] ? `${listId}-${active}` : undefined} />
    </label>
    {workbenchFocus.projectIds && <div className="dr-focus-row" role="status">
      <Icon name="Focus" /><span>{focused ? <>{tr("Focus: ", "Фокус: ")}<b>{workbenchFocus.label ?? "…"}</b></> : <>{tr("All checkouts; focus: ", "Все копии; фокус: ")}<b>{workbenchFocus.label ?? "…"}</b></>}</span>
      <button type="button" className="dr-focus-scope" aria-pressed={everything} onClick={() => { setEverything((value) => !value); setActive(0); }}>
        {everything ? tr("Focus only", "Только фокус") : tr("All checkouts", "Все копии")}</button>
    </div>}
    {contextsError && !contexts ? <InlineError onRetry={retryContexts}>{tr("Checkouts did not load: ", "Список рабочих копий не загружен: ")}{contextsError}</InlineError>
      : !contexts ? <>{slowContexts && <WaitNote>{tr("Waiting for bb: collecting checkouts…", "Жду ответа bb: собираю рабочие копии…")}</WaitNote>}<SkeletonRows count={5} /></> : <ul ref={listRef} id={listId} role="listbox" aria-label={tr("Checkouts", "Рабочие копии")} className="m-0 max-h-[60vh] list-none overflow-y-auto p-0">
      {all.map((row, index) => <li key={row.key} role="none" data-index={index}>
        {(index === 0 || all[index - 1].group !== row.group) && <div className="dr-label" role="presentation">{row.group === "recent" ? tr("Recent", "Недавние") : tr("Checkouts", "Рабочие копии")}</div>}
        <button type="button" role="option" id={`${listId}-${index}`} aria-selected={index === active} aria-disabled={row.disabled || undefined} tabIndex={-1}
          onClick={() => pick(index)} onMouseEnter={() => setActive(index)} className="dr-option" data-active={index === active}
          title={row.disabled ? tr("Machine offline. Another machine is not substituted", "Машина без связи — другая машина не подставляется") : undefined} style={current === contextKey(row.route) ? { fontWeight: 600 } : undefined}>
          <Icon name={row.icon} />{row.title}
          {row.detail && <span className="dr-option__detail dr-trunc" style={{ maxWidth: "40%" }}>{row.detail}</span>}
        </button>
      </li>)}
      {!all.length && <li><Empty icon="Search">{tr("Nothing found. Change the query.", "Ничего не найдено. Измените запрос.")}</Empty></li>}
    </ul>}
  </div>;
}

const COLLAPSED = "document-review:collapsed:";
const SECTIONS_OFF = "document-review:sections-off:";

function useStoredSet(prefix: string, ctxKey: string) {
  const read = () => { try { return new Set<string>(JSON.parse(localStorage.getItem(prefix + ctxKey) ?? "[]")); } catch { return new Set<string>(); } };
  const [value, setValue] = useState<Set<string>>(read);
  useEffect(() => setValue(read()), [ctxKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (key: string, on?: boolean) => setValue((current) => {
    const next = new Set(current);
    if (on ?? !next.has(key)) next.add(key); else next.delete(key);
    try { localStorage.setItem(prefix + ctxKey, JSON.stringify([...next].slice(-500))); } catch { /* storage unavailable */ }
    return next;
  });
  return { value, toggle };
}

/** Signals at the right of a document row: always a number or a word; colour only in the dot. */
function Signals({ entry }: { entry: TreeEntryInfo }) {
  if (!entry.supported) return <span className="dr-word" title={entry.note ?? tr("Format not supported: the file is visible, comments are unavailable (MDX and the like are not executed)", "Формат не поддерживается: файл виден, замечания недоступны (MDX и прочее не исполняется)")}>{entry.kind === "symlink" ? tr("link", "ссылка") : tr("not Markdown", "не Markdown")}</span>;
  return <>
    {entry.conflict && <span className="dr-word dr-word--conflict" title={tr("Branches differ in the path or presence of the document. Open it and choose", "Ветки разошлись в пути или наличии документа — откройте и выберите")}>{tr("conflict", "конфликт")}</span>}
    {entry.waiting > 0 && <span className="dr-count dr-count--waiting" title={tr(`${counted(entry.waiting, W.answer)} from the agent ${plural(entry.waiting, WAIT)} for a decision`, `${counted(entry.waiting, W.answer)} агента ${plural(entry.waiting, WAIT)} решения`)}>{entry.waiting}</span>}
    {entry.candidates > 0 && <span className="dr-sig" title={tr(`${counted(entry.candidates, W.annotation)} with new instructions (not sent)`, `${counted(entry.candidates, W.annotation)} с новыми инструкциями (не отправлены)`)}>+{entry.candidates}</span>}
    {entry.state === "unread" && <span className="dr-sig" title={tr(`${counted(entry.unread ?? 0, W.change)} unread`, `${counted(entry.unread ?? 0, W.change)} не прочитано`)}><span className="dr-dot dr-dot--changed" />{num(entry.unread ?? 0)}</span>}
    {entry.state === "new" && <span className="dr-word dr-word--new" title={tr("New document since review was enabled", "Новый документ после включения обзора")}>{tr("new", "новый")}</span>}
    {entry.state === "changed" && <span className="dr-sig" title={tr("Changed on disk; the number of changes is not counted yet", "Изменён на диске; число изменений ещё не посчитано")}><span className="dr-dot dr-dot--changed" /><span className="dr-sr">{tr("changed", "изменён")}</span></span>}
    {entry.untracked && <span className="dr-word" title={entry.untrackedFrom ? tr(`Untracked, inherited from ${entry.untrackedFrom}`, `Без отслеживания — унаследовано от ${entry.untrackedFrom}`) : tr("Untracked: unread changes do not pile up", "Без отслеживания: непрочитанное не копится")}>{tr("untracked", "без отслеживания")}</span>}
    {entry.hidden && <span className="dr-word" title={entry.hiddenFrom ? tr(`Hidden, inherited from ${entry.hiddenFrom}`, `Скрыт — унаследовано от ${entry.hiddenFrom}`) : tr("Hidden: not shown in the tree and search", "Скрыт: не виден в дереве и поиске")}>{tr("hidden", "скрыт")}</span>}
  </>;
}

type RuleEntry = { hidden: boolean; hiddenFrom: string | null; untracked: boolean; untrackedFrom: string | null; supported: boolean;
  /** EP-048: the row can be tracked locally (a file outside Git, a folder with such files) and whether it is. */
  localTrack?: { possible: boolean; tracked: boolean } };

/** Items of a row's menu (registry dropdown-menu: arrows, Esc, focus return). */
function RowMenuItems({ path, isDir, entry, onOpenBeside }: { path: string; isDir: boolean; entry: RuleEntry; onOpenBeside: (() => void) | null }) {
  const writable = Boolean(useUi((ui) => ui.tree?.writable));
  return <>
    {onOpenBeside && <><MenuItem onSelect={onOpenBeside}><Icon name="PanelLeftOpen" />{tr("Open beside the chat", "Открыть рядом с чатом")}</MenuItem><MenuSeparator /></>}
    {entry.hidden
      ? <MenuItem disabled={!writable} onSelect={() => void setRule({ list: "hidden", path, isDir, action: "remove" })}><Icon name="Eye" />{entry.hiddenFrom ? tr(`Show (exception to ${entry.hiddenFrom})`, `Показать (исключение из ${entry.hiddenFrom})`) : tr("Show", "Показать")}</MenuItem>
      : <MenuItem disabled={!writable} onSelect={() => void setRule({ list: "hidden", path, isDir, action: "add" })} title={tr("Remove from the tree and search; tracking does not change", "Убрать из дерева и поиска; отслеживание не меняется")}><Icon name="EyeOff" />{tr("Hide", "Скрыть")}</MenuItem>}
    {(isDir || entry.supported) && (entry.untracked
      ? <MenuItem disabled={!writable} onSelect={() => void setRule({ list: "untracked", path, isDir, action: "remove" })} title={tr("The current version becomes the new base; the paused period is marked “not tracked”", "Текущая редакция станет новой базой; период паузы помечается «не отслеживался»")}><Icon name="Eye" />{entry.untrackedFrom ? tr(`Track (exception to ${entry.untrackedFrom})`, `Отслеживать (исключение из ${entry.untrackedFrom})`) : tr("Track", "Отслеживать")}</MenuItem>
      : <MenuItem disabled={!writable} onSelect={() => void setRule({ list: "untracked", path, isDir, action: "add" })} title={tr("The document can be read and commented on, but unread changes do not pile up", "Документ читается и комментируется, но непрочитанное не копится")}><Icon name="Circle" />{tr("Untracked", "Без отслеживания")}</MenuItem>)}
    {entry.localTrack?.possible && <>
      <MenuSeparator />
      {entry.localTrack.tracked
        ? <MenuItem onSelect={() => void trackLocal(path, isDir, "remove")} title={tr("Saved review data stays; you can turn it back on at any time", "Сохранённые данные обзора остаются; включить снова можно в любой момент")}><Icon name="CircleSlash" />{isDir ? tr("Stop tracking folder locally", "Не отслеживать папку локально") : tr("Stop tracking locally", "Не отслеживать локально")}</MenuItem>
        : <MenuItem onSelect={() => void trackLocal(path, isDir, "add")} title={tr("Marks, read state and comments for files outside Git stay on this machine only, nothing goes to .bb-docs", "Пометки, «Прочитано» и замечания для файлов вне Git — только на этой машине, в .bb-docs ничего")}><Icon name="HardDrive" />{isDir ? tr("Track folder locally", "Отслеживать папку локально") : tr("Track locally", "Отслеживать локально")}</MenuItem>}
      <MenuSeparator />
    </>}
    {isDir && <MenuItem disabled={!writable} onSelect={() => openExcludeFolder(path)} title={tr("Do not show or track, in this repository or in all your checkouts", "Не показывать и не отслеживать — в этом репозитории или во всех ваших рабочих копиях")}><Icon name="FolderX" />{tr("Exclude folder…", "Исключить папку…")}</MenuItem>}
    {!writable && <p className="dr-note" style={{ maxWidth: 260 }}>{tr("Rules are written to .bb-docs/config.json: review must be enabled and user.email set.", "Правила пишутся в .bb-docs/config.json — нужен включённый обзор и user.email.")}</p>}
  </>;
}

/** Headings of the open document (EP-019-T02): H1–H3 without the single H1 that repeats the document name. */
export function sectionsOf(view: NonNullable<ReturnType<typeof getUi>["view"]>, outline: ReturnType<typeof getUi>["textInfo"] = null): { index: number; text: string; level: number; unread: number }[] {
  // A large document whose text is still arriving (EP-027-T08): every heading from the fast path's outline at once,
  // so the sections in the tree do not grow while the blocks come.
  const all = outline && outline.path === view.document.path ? outline.headings.map((heading) => ({ index: heading.index, text: heading.text, depth: heading.depth, type: "heading" }))
    : view.blocks.filter((block) => block.type === "heading").map((block) => ({ index: block.index, text: block.text, depth: block.depth, type: "heading" }));
  const headings = all.filter((block) => (block.depth ?? 1) <= 3);
  const h1 = headings.filter((block) => (block.depth ?? 1) === 1).length;
  const base = h1 === 1 ? 2 : 1;
  const unread = new Map<number, number>();
  for (const block of view.blocks) {
    if (block.read !== "unread" && block.read !== "ambiguous") continue;
    const path = block.type === "heading" ? [...block.headings, block.index] : block.headings;
    for (const heading of new Set(path)) unread.set(heading, (unread.get(heading) ?? 0) + 1);
  }
  return headings.filter((block) => !(h1 === 1 && (block.depth ?? 1) === 1)).map((block) => ({ index: block.index, text: block.text, level: Math.max(0, (block.depth ?? 1) - base), unread: unread.get(block.index) ?? 0 }));
}

const LIMIT = 40;

function Sections({ path, depth, onOpen }: { path: string; depth: number; onOpen: (block: number, text: string) => void }) {
  const view = useUi((ui) => ui.view);
  const outline = useUi((ui) => ui.textInfo);
  const current = useUi((ui) => ui.currentHeading);
  const [all, setAll] = useState(false);
  if (!view || view.document.path !== path) return null;
  const sections = sectionsOf(view, outline);
  if (!sections.length) return null;
  const shown = all ? sections : sections.slice(0, LIMIT);
  const base = 4 + depth * 12 + 42;
  return <div role="group" aria-label={tr("Document sections", "Разделы документа")}>
    {shown.map((section) => <div key={section.index} role="treeitem" aria-level={depth + 2} aria-selected={false} aria-current={current === section.index ? "location" : undefined}
      tabIndex={-1} data-tree-row data-tree-sec={section.index} data-tree-doc={path} className="dr-sec" style={{ paddingLeft: base + section.level * 12 }} title={section.text}
      onClick={() => onOpen(section.index, section.text)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(section.index, section.text); } }}>
      <span className="dr-sec__name">{section.text}</span>
      {section.unread > 0 && <span className="dr-sig" title={tr(`${counted(section.unread, W.block)} unread in the section`, `${counted(section.unread, W.block)} не прочитано в разделе`)}><span className="dr-dot dr-dot--changed" />{num(section.unread)}</span>}
    </div>)}
    {sections.length > LIMIT && !all && <button type="button" className="dr-sec-more dr-link" style={{ paddingLeft: base }} onClick={() => setAll(true)}>{tr(`${counted(sections.length - LIMIT, W.section)} more`, `ещё ${counted(sections.length - LIMIT, W.section)}`)}</button>}
  </div>;
}

function Search({ onOpen }: { onOpen: (doc: string, hash: string | null) => void }) {
  const target = useUi((ui) => ui.target);
  const showHidden = useUi((ui) => ui.showHidden);
  const ctxKey = useUi((ui) => ui.ctxKey);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ path: string; heading: string | null; depth: number | null; hidden: boolean }[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  // W-06b: the answer of an older query never replaces the newer one; the field shows that the search runs.
  const requests = useMemo(() => createLatest(), []);
  useEffect(() => {
    if (!query.trim() || !target) { requests.begin(); setResults(null); setSearchError(null); setSearching(false); return; }
    const token = requests.begin();
    setSearching(true);
    const timer = setTimeout(async () => {
      const reply = await call<{ results: { path: string; heading: string | null; depth: number | null; hidden: boolean }[] }>("review.search", { target, query, showHidden, ...(getUi().tree && !getUi().tree!.enabled ? { roots: getUi().tree!.roots } : {}) });
      if (getUi().ctxKey !== ctxKey || !requests.isCurrent(token)) return;
      setSearching(false);
      if (reply.ok) { setResults((reply as unknown as { result: { results: typeof results } }).result.results ?? []); setSearchError(null); }
      else { setResults([]); setSearchError(explain(reply.error)); }
      setActive(0);
    }, 180);
    return () => clearTimeout(timer);
  }, [query, target, showHidden, ctxKey, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  // The 180 ms pause of typing is not a wait: the indicator counts from the request, after the usual 150 ms.
  const searchBusy = useDelayedFlag(searching, 180 + 150);
  const open = (index: number) => {
    const row = results?.[index];
    if (!row) return;
    onOpen(row.path, row.heading ? slug(row.heading) : null);
    setQuery("");
  };
  const listId = "dr-search-results";
  return <div className="relative flex min-w-0 flex-1">
    <label className="dr-field flex-1" aria-busy={searchBusy || undefined} data-search-busy={searchBusy || undefined}>
      {searchBusy ? <Spinner size={14} /> : <Icon name="Search" />}
      <input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("Path or section…", "Путь или раздел…")} aria-label={VERB.search.hint}
        role="combobox" aria-expanded={Boolean(results)} aria-controls={listId} aria-activedescendant={results?.length ? `${listId}-${active}` : undefined}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => Math.min((results?.length ?? 1) - 1, value + 1)); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); }
          else if (event.key === "Enter") { event.preventDefault(); open(active); }
          else if (event.key === "Escape") { event.preventDefault(); setQuery(""); input.current?.blur(); }
        }} />
      {query ? <button type="button" className="dr-btn dr-btn--ghost dr-btn--sm dr-btn--icon" aria-label={tr("Clear search", "Очистить поиск")} onClick={() => { setQuery(""); input.current?.focus(); }}><Icon name="X" /></button> : <Kbd>/</Kbd>}
    </label>
    {results && <ul id={listId} role="listbox" aria-label={tr("Search results", "Результаты поиска")} className="absolute left-0 right-0 top-full z-40 m-0 mt-1 max-h-80 list-none overflow-y-auto rounded-[var(--dr-r-md)] border border-border bg-popover p-1 shadow-[var(--shadow-lg)]">
      {results.map((row, index) => <li key={`${row.path}#${row.heading ?? ""}#${index}`} role="none">
        <button type="button" role="option" id={`${listId}-${index}`} aria-selected={index === active} tabIndex={-1} onMouseEnter={() => setActive(index)} onClick={() => open(index)} className="dr-option" data-active={index === active}>
          <Icon name={row.heading ? "ListTree" : "FileText"} />
          <span className="dr-trunc">{row.heading ?? row.path}</span>
          {row.heading && <span className="dr-option__detail dr-trunc" style={{ maxWidth: "45%" }}>{row.path}</span>}
          {row.hidden && <span className="dr-word">{tr("hidden", "скрыт")}</span>}
        </button>
      </li>)}
      {searchError && <li role="none" className="p-1"><InlineError onRetry={() => setAttempt((value) => value + 1)}>{tr("Search failed: ", "Поиск не выполнен: ")}{searchError}</InlineError></li>}
      {!results.length && !searchError && <li role="none" className="dr-note">{searching ? tr("Searching…", "Ищу…") : <>{tr("Nothing found", "Ничего не найдено")}{showHidden ? "" : tr(". Hidden documents are not searched", " — скрытые документы не ищутся")}.</>}</li>}
    </ul>}
  </div>;
}

/** Keep the tree visible: summarize missing files in one row and open a dialog for decisions. Bulk actions accept unique same-content/Git rename candidates or confirm files with no destination as deleted; review ambiguous cases individually with complete destination paths. */
function MovePanel({ setForgetLocal }: { setForgetLocal: (path: string) => void }) {
  const tree = useUi((ui) => ui.tree);
  const [open, setOpen] = useState(false);
  const summary = useRef<HTMLButtonElement>(null);
  const proposals = tree?.moves.proposals ?? [];
  if (!tree || !proposals.length) return null;
  const notes = proposals.reduce((sum, proposal) => sum + proposal.open, 0);
  return <div className="dr-tree__panel">
    <button ref={summary} type="button" className="dr-attn" data-moves-summary aria-haspopup="dialog" onClick={() => setOpen(true)}
      title={tr("Files are gone from the checkout: renamed or deleted? The decision moves history, comments and read marks", "Файлы исчезли из рабочей копии: переименованы или удалены? Решение переносит историю, замечания и «Прочитано»")}>
      <Icon name="TriangleAlert" />
      <span className="dr-attn__text"><b>{counted(proposals.length, W.file)}</b> {plural(proposals.length, MISSING)}{notes ? ` · ${counted(notes, W.annotation)}` : ""}</span>
      <span className="dr-attn__action">{tr("Review", "Разобрать")}</span>
    </button>
    <MovesDialog open={open} onOpenChange={setOpen} returnFocus={() => summary.current?.focus()} setForgetLocal={(path) => { setOpen(false); setForgetLocal(path); }} />
  </div>;
}

function MovesDialog({ open, onOpenChange, setForgetLocal, returnFocus }: { open: boolean; onOpenChange: (open: boolean) => void; setForgetLocal: (path: string) => void; returnFocus: () => void }) {
  const tree = useUi((ui) => ui.tree);
  const proposals = tree?.moves.proposals ?? [];
  const { sure, gone } = moveGroups(proposals);
  const writable = Boolean(tree?.writable);
  useEffect(() => { if (open && tree && !proposals.length) onOpenChange(false); }, [open, tree, proposals.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const reason = (candidate: MoveProposal["candidates"][number]) => candidate.exact ? tr("same content", "то же содержимое") : candidate.git ? tr("renamed in Git", "переименован по Git") : tr(`${Math.round(candidate.similarity * 100)}% similar`, `похож на ${Math.round(candidate.similarity * 100)} %`);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent data-dr data-moves-dialog className="dr-moves" style={{ maxWidth: 720 }} onCloseAutoFocus={(event) => { event.preventDefault(); returnFocus(); }}>
      <DialogHeader>
        <DialogTitle>{tr("Missing files · ", "Пропавшие файлы · ")}{proposals.length}</DialogTitle>
        <DialogDescription>{tr("Files are gone from the checkout. If a file was renamed, its history, comments and read marks move to the new path; if it was deleted, its history stays in the review and the deletion is marked read.", "Файлы исчезли из рабочей копии. Если файл переименован — его история, замечания и «Прочитано» переедут к новому пути; если удалён — история останется в обзоре, удаление отметится прочитанным.")}</DialogDescription>
      </DialogHeader>
      {writable && (sure.length > 0 || gone.length > 0) && <div className="dr-moves__bulk">
        {sure.length > 0 && <CommandButton size="sm" icon="MoveRight" data-moves-accept run={() => resolveMoves(sure.map((proposal) => ({ docId: proposal.docId, to: sureCandidate(proposal)!.path })))}
          title={tr("One obvious new path: same content or a rename in Git", "Один очевидный новый путь: то же содержимое или переименование по Git")}>{tr("Accept renames · ", "Принять переименования · ")}{sure.length}</CommandButton>}
        {gone.length > 0 && <CommandButton size="sm" variant="ghost" icon="Trash2" data-moves-gone run={() => resolveMoves(gone.map((proposal) => ({ docId: proposal.docId, to: null })))}
          title={tr("No new paths found: mark as deleted", "Новых путей не найдено: отметить удалёнными")}>{tr("Mark deleted · ", "Отметить удалёнными · ")}{gone.length}</CommandButton>}
      </div>}
      {!writable && <Banner icon="Info" tone="quiet">{tr("The checkout is read-only: decisions are unavailable.", "Рабочая копия только для чтения — решения недоступны.")}</Banner>}
      <ul className="dr-moves__list" aria-label={tr("Missing files", "Пропавшие файлы")}>
        {proposals.map((proposal) => {
          const from = splitPath(proposal.from);
          return <li key={proposal.docId} className="dr-move">
            <div className="dr-move__from" title={proposal.from}>
              <Icon name="FileX2" /><span className="dr-move__path"><span className="dr-move__dir dr-meta">{from.dir}</span><b className="dr-move__name">{from.name}</b></span>
              {proposal.open > 0 && <span className="dr-count" title={tr(`${counted(proposal.open, W.annotation)} on this file`, `${counted(proposal.open, W.annotation)} к этому файлу`)}>{proposal.open}</span>}
            </div>
            <div className="dr-move__actions">
              {proposal.candidates.map((candidate) => {
                const to = splitPath(candidate.path);
                return <CommandButton key={candidate.path} size="sm" icon="MoveRight" disabled={!writable} run={() => resolveMove(proposal.docId, candidate.path)}
                  title={tr(`Move history, comments and read marks to ${candidate.path}`, `Перенести историю, замечания и прочитанное в ${candidate.path}`)}>
                  <span className="dr-move__path"><span className="dr-move__dir dr-meta">{to.dir}</span><span className="dr-move__name">{to.name}</span></span>
                  <span className="dr-meta">{reason(candidate)}</span>
                </CommandButton>;
              })}
              {(proposal as { local?: boolean }).local
                ? <Button size="sm" variant="ghost" onClick={() => setForgetLocal(proposal.from)}>{tr("Forget file…", "Забыть файл…")}</Button>
                : <CommandButton size="sm" variant="ghost" disabled={!writable} run={() => resolveMove(proposal.docId, null)}>{tr("Deleted", "Удалён")}</CommandButton>}
            </div>
          </li>;
        })}
      </ul>
      <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>{VERB.close.button}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function MissingRoots({ tree }: { tree: TreeInfo }) {
  const ctxKey = useUi((ui) => ui.ctxKey);
  if (!tree.missingRoots.length) return null;
  const all = tree.missingRoots.length === tree.roots.length;
  return <div className="dr-tree__panel">
    <Banner icon="Inbox" role="status" actions={all && !tree.enabled && tree.suggestions.length > 0 ? <div className="flex w-full flex-wrap gap-1">
      {tree.suggestions.map((root) => <Button key={root} size="sm" onClick={() => { chooseReadingRoots(ctxKey, [root]); void loadTree(); }}><Icon name="Folder" />{root === "." ? tr("Whole repository", "Весь репозиторий") : `${root}/`}</Button>)}
    </div> : undefined}>
      {all ? tr(`No ${tree.missingRoots.map((root) => `${root}/`).join(", ")} in this checkout.`, `Нет ${tree.missingRoots.map((root) => `${root}/`).join(", ")} в этой рабочей копии.`) : tr(`Missing roots: ${tree.missingRoots.join(", ")}.`, `Нет корней: ${tree.missingRoots.join(", ")}.`)}{tr(" The folder is not created automatically.", " Каталог автоматически не создаётся.")}
      {all && !tree.enabled && tree.suggestions.length > 0 && tr(" Choose a folder with documents:", " Выберите каталог с документами:")}
      {all && !tree.enabled && !tree.suggestions.length && tr(" No Markdown documents found in the repository.", " Markdown-документов в репозитории не найдено.")}
    </Banner>
  </div>;
}

type Item = { key: string; depth: number; node: ReactNode };

export function DocsTree({ onNavigate, compact = false, navigateTo }: { onNavigate?: () => void; compact?: boolean; navigateTo?: (route: Route) => void }) {
  const enableJob = useEnableJob();
  const navigate = useBbNavigate();
  const bb = useBbContext();
  const route = useUi((ui) => ui.route);
  const ctxKey = useUi((ui) => ui.ctxKey);
  const tree = useUi((ui) => ui.tree);
  const treeError = useUi((ui) => ui.treeError);
  const showHidden = useUi((ui) => ui.showHidden);
  const batch = useUi((ui) => ui.batch);
  const view = useUi((ui) => ui.view);
  const [readingAll, setReadingAll] = useState(false);
  const [picking, setPicking] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  useAutoTransfer();
  /** Forget file requires confirmation in a dialog. */
  const [forgetting, setForgetting] = useState<string | null>(null);
  // Folders that hold files outside Git: they can be tracked locally as a whole (a folder rule).
  const outsideDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const entry of tree?.entries ?? []) {
      if (entry.fileClass !== "outside" && !entry.local) continue;
      const parts = entry.path.split("/");
      for (let index = 1; index < parts.length; index++) dirs.add(parts.slice(0, index).join("/"));
    }
    return dirs;
  }, [tree]);
  // Refresh tree replaces its icon with feedback while retaining rows; duplicate activation starts no second request.
  const refreshTree = useCommand(async () => { await loadTree(); });
  // The chosen document gets a loading rail beneath its row after 150 ms until its text arrives.
  const slowTree = useSlowFlag(!tree && !treeError);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const collapsed = useStoredSet(COLLAPSED, ctxKey);
  const sectionsOff = useStoredSet(SECTIONS_OFF, ctxKey);
  const listRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const doc = route.kind === "none" ? null : route.doc;
  const typeFilter = useUi((ui) => ui.typeFilter);
  const outsideOnly = useUi((ui) => ui.outsideOnly);
  // W-06c: the type filter and «Outside Git only» are a view of this session (nothing is written).
  const shownTree = useMemo(() => (tree && (typeFilter || outsideOnly) ? {
    ...tree,
    entries: tree.entries.filter((entry) => (!typeFilter || typeFilter.includes(entry.group ?? "markdown")) && (!outsideOnly || entry.fileClass === "outside")),
    virtual: outsideOnly ? [] : tree.virtual,
  } : tree), [tree, typeFilter, outsideOnly]);
  const model = useMemo(() => (shownTree ? buildTree(shownTree, showHidden) : null), [shownTree, showHidden]);
  const go = (next: Route) => {
    chooseDocument(next);
    // Inside a thread panel or a file tab the tree navigates that tab, not the «Documents» screen.
    if (navigateTo) navigateTo(next);
    else navigate.toPluginPanel(PANEL_PATH, { subPath: subPathOf(next) });
    onNavigate?.();
  };
  const openDoc = (path: string, hash: string | null = null) => {
    if (route.kind === "none") return;
    if (path === doc && hash) { revealHeading(hash); onNavigate?.(); return; }
    setUi({ pendingHash: hash });
    go({ ...route, doc: path });
  };
  const openSection = (path: string, block: number, text: string) => {
    // The open document: its section at once, even if a large document has not mounted that part yet (EP-027-T08).
    if (path === doc && getUi().view?.document.path === doc) { revealIndex(block, "start"); setUi({ currentHeading: block }); onNavigate?.(); return; }
    openDoc(path, slug(text));
  };
  const openBeside = (path: string) => (bb.threadId && !navigateTo ? () => {
    if (route.kind === "none") return;
    navigate.openThreadPanel({ actionId: "docs", title: path.split("/").pop(), params: { subPath: subPathOf({ ...route, doc: path }) } });
    onNavigate?.();
  } : null);

  // Roving focus: one row is in the Tab order — the focused one, else the selected document, else the first row.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const rows = [...list.querySelectorAll<HTMLElement>("[data-tree-row]")];
    const wanted = rows.find((row) => row.dataset.key === focusKey) ?? rows.find((row) => row.getAttribute("aria-current") === "page") ?? rows[0];
    // Only real changes touch the DOM (this runs after every render of the tree).
    for (const row of rows) { const index = row === wanted ? 0 : -1; if (row.tabIndex !== index) row.tabIndex = index; }
  });

  if (route.kind === "none" || picking) {
    return <div className="dr-tree" data-docs-tree data-dr>
      <div className="dr-tree__head">
        <div className="flex items-center gap-2"><span className="dr-grow text-[12px] font-medium text-muted-foreground">{tr("Checkout", "Рабочая копия")}</span>
          {picking && <Button size="sm" variant="ghost" onClick={() => setPicking(false)}>{tr("Cancel", "Отмена")}</Button>}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"><ContextList compact autoFocus={picking} current={ctxKey} onPick={(next) => { setPicking(false); go(next); }} /></div>
    </div>;
  }

  const guides = (depth: number) => Array.from({ length: depth }, (_, level) => <span key={level} className="dr-guide" style={{ left: 4 + level * 12 + 7 }} aria-hidden />);
  const pad = (depth: number) => ({ paddingLeft: 4 + depth * 12 });
  const rowMenu = (key: string, path: string, isDir: boolean, entry: RuleEntry, beside: (() => void) | null) => <Menu open={menu === key} onOpenChange={(open) => setMenu(open ? key : null)}>
    <MenuTrigger asChild>
      <button type="button" tabIndex={-1} className="dr-btn dr-btn--ghost dr-btn--sm dr-btn--icon dr-row__more" aria-label={tr(`Actions: ${path}`, `Действия: ${path}`)} title={tr("Actions (Shift+F10)", "Действия (Shift+F10)")}><Icon name="Ellipsis" /></button>
    </MenuTrigger>
    <MenuContent align="end" mobileTitle={path} onCloseAutoFocus={(event) => { event.preventDefault(); listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus(); }}>
      <RowMenuItems path={path} isDir={isDir} entry={entry} onOpenBeside={beside} />
    </MenuContent>
  </Menu>;

  const items: Item[] = [];
  const walk = (node: DirNode, depth: number) => {
    for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const open = !collapsed.value.has(dir.path);
      const key = `d:${dir.path}`;
      items.push({ key, depth, node: <div key={key} className="dr-rowwrap">
        {guides(depth)}
        <div role="treeitem" aria-level={depth + 1} aria-expanded={open} aria-selected={false} tabIndex={-1} data-tree-row data-key={key} data-tree-dir={dir.path}
          className={`dr-row${dir.hidden ? " dr-row--dim" : ""}`} style={pad(depth)} onClick={() => collapsed.toggle(dir.path)}>
          <span className="dr-row__chev"><Icon name={open ? "ChevronDown" : "ChevronRight"} /></span>
          <Icon name={open ? "FolderOpen" : "Folder"} />
          <span className="dr-row__name">{dir.name}</span>
          {!open && dir.attention > 0 && <span className="dr-sig" title={tr("Something to look at inside", "Внутри есть что посмотреть")}><span className="dr-dot dr-dot--changed" /><span className="dr-sr">{tr("has changes", "есть изменения")}</span></span>}
        </div>
        <span className="dr-rowwrap__acts">{rowMenu(key, dir.path, true, { ...dirRule(tree!, dir.path), supported: true,
          localTrack: { possible: outsideDirs.has(dir.path), tracked: Boolean(tree?.localRules?.roots.includes(dir.path)) } }, null)}</span>
      </div> });
      if (open) walk(dir, depth + 1);
    }
    for (const entry of node.files) {
      const active = entry.path === doc;
      const key = `f:${entry.path}`;
      const hasSections = active && entry.supported && Boolean(view && view.document.path === entry.path && sectionsOf(view, getUi().textInfo).length);
      const showSections = hasSections && !sectionsOff.value.has(entry.path);
      const row = <div key={key} className={`dr-rowwrap dr-rowwrap--acts${active ? " dr-rowwrap--sel" : ""}`}>
        {guides(depth)}
        <div role="treeitem" aria-level={depth + 1} aria-selected={active} aria-current={active ? "page" : undefined}
          aria-expanded={hasSections ? showSections : undefined} tabIndex={-1} data-tree-row data-key={key} data-tree-file={entry.path} data-format={entry.format} data-class={entry.fileClass}
          title={entry.note ?? `${entry.path} · ${typeLabel(entry.format)}`}
          className={`dr-row${!entry.hidden && !entry.untracked ? "" : " dr-row--dim"}`} style={pad(depth)} onClick={() => openDoc(entry.path)}
          onPointerEnter={() => { if (!active) hoverPrefetch(entry.path); }} onPointerLeave={() => hoverPrefetch(null)} onFocus={() => { if (!active) hoverPrefetch(entry.path); }}>
          <span className="dr-row__chev" />
          <Icon name={entry.kind === "symlink" ? "Link" : iconOf(entry.format)} className="dr-row__type" />
          <span className="dr-row__name">{entry.path.split("/").pop()}</span>
          {entry.local
            ? <span className="dr-word dr-word--local" title={tr("Ignored by Git; local review: data stays on this machine only, nothing goes to .bb-docs", "Игнорируется Git; обзор локальный — данные только на этой машине, в .bb-docs ничего")}>{tr("outside Git · local", "вне Git · локально")}</span>
            : entry.fileClass === "outside" && <span className="dr-word dr-word--outside" title={tr("Ignored by Git: view only. “Track locally” is in the row menu (⋯)", "Игнорируется Git: только просмотр. «Отслеживать локально» — в меню строки (⋯)")}>{tr("outside Git", "вне Git")}</span>}
          {entry.transfer && <span className="dr-word dr-word--local" title={entry.transfer === "to-git" ? tr("The file is now in Git: its review data can move to the shared review", "Файл теперь в Git: данные обзора можно перенести в общий обзор") : tr("The file left Git: its review data will move to local storage", "Файл исключён из Git: данные обзора перенесутся в локальное хранилище")}>{entry.transfer === "to-git" ? tr("in Git · move?", "в Git · перенести?") : tr("out of Git", "из Git")}</span>}
          <Signals entry={entry} />
        </div>
        <span className="dr-rowwrap__acts">
          {hasSections && <Tip label={showSections ? tr("Collapse sections", "Свернуть разделы") : tr("Show sections", "Показать разделы")}><button type="button" tabIndex={-1} className="dr-btn dr-btn--ghost dr-btn--sm dr-btn--icon" aria-label={tr("Document sections", "Разделы документа")} aria-expanded={showSections} onClick={() => sectionsOff.toggle(entry.path)}><Icon name="ListTree" /></button></Tip>}
          {entry.kind === "file" && rowMenu(key, entry.path, false, { ...entry, localTrack: { possible: entry.fileClass === "outside" || Boolean(entry.local), tracked: Boolean(entry.local) && Boolean(tree?.localRules?.roots.includes(entry.path)) } }, entry.supported ? openBeside(entry.path) : null)}
        </span>
      </div>;
      if (showSections) {
        items.push({ key, depth, node: <div key={key} className="dr-grp">
          {row}
          <span className="dr-secline" style={{ left: 4 + depth * 12 + 29, top: "var(--dr-row)" }} aria-hidden />
          <Sections path={entry.path} depth={depth} onOpen={(block, text) => openSection(entry.path, block, text)} />
        </div> });
      } else items.push({ key, depth, node: row });
    }
    for (const entry of node.virtual) {
      const active = entry.path === doc;
      const key = `v:${entry.path}`;
      items.push({ key, depth, node: <div key={key} className="dr-rowwrap">
        {guides(depth)}
        <div role="treeitem" aria-level={depth + 1} aria-selected={active} aria-current={active ? "page" : undefined} tabIndex={-1} data-tree-row data-key={key} data-tree-file={entry.path}
          title={entry.deletionUnread ? tr("Document deleted: you have not marked the deletion read yet", "Документ удалён: вы ещё не отметили удаление прочитанным") : entry.reason === "missing" ? tr("Document deleted from the checkout", "Документ удалён из рабочей копии") : tr("Deleted; open comments remain", "Удалён; остались открытые замечания")}
          className="dr-row dr-row--gone" style={pad(depth)} onClick={() => openDoc(entry.path)}>
          <span className="dr-row__chev" />
          <Icon name="FileX" />
          <span className="dr-row__name">{entry.path.split("/").pop()}</span>
          {entry.conflict && <span className="dr-word dr-word--conflict">{tr("conflict", "конфликт")}</span>}
          {entry.open > 0 && <span className="dr-sig" title={counted(entry.open, W.annotation)}><Icon name="MessageSquare" size={12} />{entry.open}</span>}
          <span className="dr-word dr-word--removed">{entry.local ? tr("deleted · local", "удалён · локально") : tr("deleted", "удалён")}</span>
          {entry.deletionUnread && <span className="dr-sig" title={tr("Deletion unread", "Удаление не прочитано")}><span className="dr-dot dr-dot--changed" /><span className="dr-sr">{tr("unread", "не прочитано")}</span></span>}
        </div>
        {entry.local && <span className="dr-rowwrap__acts"><Tip label={tr("Forget file: delete its local review data", "Забыть файл — удалить его локальные данные обзора")}><button type="button" tabIndex={-1} className="dr-btn dr-btn--ghost dr-btn--sm dr-btn--icon" aria-label={tr(`Forget file ${entry.path}`, `Забыть файл ${entry.path}`)}
          onClick={() => setForgetting(entry.path)}><Icon name="Trash2" /></button></Tip></span>}
      </div> });
    }
  };
  if (model) walk(model, 0);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-tree-row]")];
    const current = (event.target as HTMLElement).closest<HTMLElement>("[data-tree-row]");
    const index = current ? rows.indexOf(current) : -1;
    if (index < 0 || !current) return;
    const focus = (next: number) => { event.preventDefault(); const row = rows[Math.max(0, Math.min(rows.length - 1, next))]; if (row) { setFocusKey(row.dataset.key ?? null); row.focus(); } };
    // Expanding or collapsing may re-mount the row (the selected document moves into or out of its section group):
    // the focus is put back on the same row after the render.
    const keep = () => { const key = current.dataset.key; requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key ?? "")}"]`)?.focus()); };
    const dir = current.dataset.treeDir;
    const file = current.dataset.treeFile;
    const sec = current.dataset.treeSec;
    const expanded = current.getAttribute("aria-expanded");
    if (event.key === "ArrowDown") focus(index + 1);
    else if (event.key === "ArrowUp") focus(index - 1);
    else if (event.key === "Home") focus(0);
    else if (event.key === "End") focus(rows.length - 1);
    else if (event.key === "ArrowRight") {
      if (dir && expanded === "false") { event.preventDefault(); collapsed.toggle(dir); keep(); }
      else if (file && expanded === "false") { event.preventDefault(); sectionsOff.toggle(file, false); keep(); }
      else if (expanded === "true") focus(index + 1);
    } else if (event.key === "ArrowLeft") {
      if (dir && expanded === "true") { event.preventDefault(); collapsed.toggle(dir); keep(); return; }
      if (file && expanded === "true") { event.preventDefault(); sectionsOff.toggle(file, true); keep(); return; }
      const parent = sec ? rows.find((row) => row.dataset.treeFile === current.dataset.treeDoc && !row.dataset.treeSec) : rows.find((row) => row.dataset.treeDir === (dir ?? file ?? "").split("/").slice(0, -1).join("/"));
      if (parent) focus(rows.indexOf(parent));
    } else if (event.key === "Enter" || event.key === " ") {
      if (sec) return;
      event.preventDefault();
      current.click();
    } else if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
      event.preventDefault();
      if (!sec && current.dataset.key) setMenu(current.dataset.key);
    } else if (event.key.length === 1 && /\S/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // Type-ahead: the next row whose name starts with the typed letters.
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : "") + event.key.toLowerCase(), at: now };
      const names = rows.map((row) => (row.querySelector(".dr-row__name, .dr-sec__name")?.textContent ?? "").toLowerCase());
      const order = [...rows.keys()].map((offset) => (index + (typed.current.text.length > 1 ? 0 : 1) + offset) % rows.length);
      const found = order.find((at) => names[at].startsWith(typed.current.text));
      if (found !== undefined) focus(found);
    }
  };

  const machine = tree?.machine.name ?? batch?.machine.name ?? "…";
  const unseen = tree ? tree.totals.unreadDocs + tree.totals.changedDocs : 0;
  const rootsText = tree ? tree.roots.map((root) => (root === "." ? tr("the repository", "репозитории") : `${root}/`)).join(", ") : "";
  return <div className="dr-tree" data-docs-tree data-dr data-compact={compact || undefined}>
    <div className="dr-tree__head">
      <Tip label={tr("Switch checkout", "Сменить рабочую копию")}><button type="button" onClick={() => setPicking(true)} className="dr-ctx" aria-label={tr(`Checkout: ${machine} · ${tree?.branch ?? "—"} · ${(tree?.root ?? "").split("/").pop()}. Switch`, `Рабочая копия: ${machine} · ${tree?.branch ?? "—"} · ${(tree?.root ?? "").split("/").pop()}. Сменить`)}>
        <Icon name="FolderGit2" /><span className="dr-trunc"><b>{machine}</b> · {tree?.branch ?? "—"} · {(tree?.root ?? "").split("/").pop()}</span>
        <Icon name="ChevronsUpDown" />
      </button></Tip>
      <div className="flex items-center gap-1">
        <Search onOpen={openDoc} />
        {tree && <TypeFilter tree={tree} />}
        <IconButton icon="RefreshCw" label={tr("Refresh tree", "Обновить дерево")} busy={refreshTree.state} onClick={() => void refreshTree.start()} data-tree-refresh />
        {tree?.enabled && <IconButton icon="Settings" label={tr("Review settings", "Настройки обзора")} onClick={openSettings} data-open-settings />}
      </div>
    </div>
    <SettingsHost />
    <Dialog open={forgetting !== null} onOpenChange={(open) => { if (!open) setForgetting(null); }}>
      <DialogContent data-dr data-forget-dialog style={{ maxWidth: 440 }}>
        <DialogHeader><DialogTitle>{tr("Forget file?", "Забыть файл?")}</DialogTitle>
          <DialogDescription>{tr("Local review data of ", "Локальные данные обзора ")}<code>{forgetting}</code>{tr(" (read marks, comments and bases) will be deleted from this machine. The file itself is not touched. You can undo while the toast is shown.", " — пометки «Прочитано», замечания и базы — будут удалены с этой машины. Сам файл не трогается. Отменить можно, пока виден тост.")}</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="ghost" onClick={() => setForgetting(null)}>{tr("Cancel", "Отмена")}</Button>
          <Button variant="danger" onClick={() => { const path = forgetting; setForgetting(null); if (path) forgetLocal(path); }}><Icon name="Trash2" />{tr("Forget", "Забыть")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    {treeError && <div className="dr-tree__panel"><Banner icon="WifiOff" tone="error" role="alert" actions={<CommandButton size="sm" icon="RefreshCw" run={() => loadTree()}>{tr("Retry", "Повторить")}</CommandButton>}>
      {treeError.code === "host-unavailable" ? tr(`No connection to ${machine}. Another machine is not substituted.`, `Нет связи с ${machine} — другая машина не подставляется.`) : explain(treeError)}
    </Banner></div>}
    {tree && tree.writable && tree.reader && !tree.reader.known && (unseen > 0 || readingAll) && <div className="dr-tree__panel"><Banner icon="Info" role="status" data-new-reader
      actions={<ReadAllButton newReader count={unseen} onState={setReadingAll} />}>
      {tr(`You are a new reader (${tree.reader.id}): changes since the review started are shown as unread, ${counted(unseen, W.document)}. Accept the current state as read?`, `Вы новый читатель (${tree.reader.id}): изменения с начала обзора показаны непрочитанными — ${counted(unseen, W.document)}. Принять текущее состояние за прочитанное?`)}
    </Banner></div>}
    {tree && <MissingRoots tree={tree} />}
    <MovePanel setForgetLocal={setForgetting} />
    <div ref={listRef} role="tree" aria-label={tr("Checkout documents", "Документы рабочей копии")} className="dr-tree__list" onKeyDown={onKeyDown}
      onFocus={(event) => { const row = (event.target as HTMLElement).closest<HTMLElement>("[data-tree-row]"); if (row?.dataset.key) setFocusKey(row.dataset.key); }}>
      {items.map((item) => item.node)}
      <OpeningRow listRef={listRef} />
      {!tree && !treeError && <>{slowTree && <div className="px-1 py-1"><WaitNote>{tr("Waiting for machine", "Жду ответа машины")}{batch?.machine.name ? ` ${batch.machine.name}` : ""}…</WaitNote></div>}<SkeletonRows count={8} row={28} /></>}
      {tree && model && !items.length && !tree.missingRoots.length && (typeFilter || outsideOnly
        ? <Empty icon="ListFilter" title={tr("No files of the selected types", "Нет файлов выбранных типов")} action={<Button size="sm" variant="ghost" onClick={() => setUi({ typeFilter: null, outsideOnly: false })}>{tr("Show all types", "Показать все типы")}</Button>} />
        : <Empty icon="Inbox" title={tr("No files of supported types here", "Здесь нет файлов поддерживаемых типов")}>
          {showHidden ? tr(`No Markdown, YAML, JSON, TOML, .env, text or CSV/TSV files in ${rootsText}.`, `В ${rootsText} нет файлов Markdown, YAML, JSON, TOML, .env, текста и CSV/TSV.`) : tr("No visible files: rules may hide them.", "Нет видимых файлов — возможно, они скрыты правилами.")}
        </Empty>)}
    </div>
    {tree && <div className="dr-tree__foot">
      <ToggleButton pressed={showHidden} onChange={(next) => setUi({ showHidden: next })} icon={showHidden ? "Eye" : "EyeOff"} label={tr("Hidden", "Скрытые")} hint={tr("Show documents hidden by rules", "Показать скрытые правилами документы")} />
      <span className="dr-grow" />
      {tree.writable && tree.reader?.known && (tree.totals.unreadDocs > 0 || readingAll) && <ReadAllButton count={tree.totals.unreadDocs} onState={setReadingAll} />}
      {!tree.enabled && (enableJob?.state === "running"
        ? <WaitNote>{tr("Enabling", "Включается")}{enableJob.total ? tr(` · ${Math.round((enableJob.done / enableJob.total) * 100)}%`, ` · ${Math.round((enableJob.done / enableJob.total) * 100)} %`) : "…"}</WaitNote>
        // The job is done, the tree of a large checkout is still being recounted: not «Enable review» again.
        : enableJob?.state === "done" ? <WaitNote>{tr("Review enabled · refreshing the tree…", "Обзор включён · обновляю дерево…")}</WaitNote>
        : <Tip label={tr("Reading needs no setup; comments and read marks come once review is enabled", "Чтение не требует настройки; замечания и «Прочитано» — после включения обзора")}><Button size="sm" variant="ghost" onClick={() => requestEnable(tr("Enabling creates .bb-docs/ and takes the current state of the documents as the base.", "Включение создаст .bb-docs/ и примет текущее состояние документов за исходную базу."))}>{enableJob ? tr("Continue enabling", "Продолжить включение") : tr("Enable review", "Включить обзор")}</Button></Tip>)}
      <NotShownTip tree={tree} />
    </div>}
  </div>;
}

/**
 * D12: the row of the document that is opening gets the running bar after 150 ms (and aria-busy) — set on the row
 * directly from this small subscriber, so the whole tree (rows with their menus) is not rendered again for it.
 */
function OpeningRow({ listRef }: { listRef: React.RefObject<HTMLDivElement | null> }) {
  const ctxKey = useUi((ui) => ui.ctxKey);
  const routed = useUi((ui) => (ui.route.kind !== "none" ? ui.route.doc : null));
  const chosen = useChosen(ctxKey, routed);
  const shownPath = useUi((ui) => ui.view?.document.path ?? null);
  const failed = useUi((ui) => ui.viewError !== null);
  const opening = chosen && shownPath !== chosen && !failed ? chosen : null;
  // Move aria-current to the chosen row immediately, before tree rendering follows navigation.
  useLayoutEffect(() => {
    if (!chosen || chosen === routed) return;
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-tree-file="${CSS.escape(chosen)}"]`);
    if (!list || !row) return;
    const previous = [...list.querySelectorAll<HTMLElement>('[data-tree-file][aria-current="page"]')].filter((element) => element !== row);
    for (const element of previous) { element.removeAttribute("aria-current"); element.setAttribute("aria-selected", "false"); }
    row.setAttribute("aria-current", "page");
    row.setAttribute("aria-selected", "true");
  }, [chosen, routed, listRef]);
  const busy = useDelayedFlag(Boolean(opening));
  const [marked, setMarked] = useState<string | null>(null);
  if (busy && opening && marked !== opening) setMarked(opening);
  useLayoutEffect(() => {
    if (!busy || !marked) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-tree-file="${CSS.escape(marked)}"]`);
    row?.setAttribute("data-fb-row-busy", "");
    row?.setAttribute("aria-busy", "true");
    return () => { row?.removeAttribute("data-fb-row-busy"); row?.removeAttribute("aria-busy"); };
  }, [busy, marked, listRef]);
  return null;
}

/**
 * «All read · N» (W-06b): the rows are read at once (optimistic), the button stays a command until the host is done
 * (up to minutes on a large checkout) with an explanation after 1 s; it stays in place while the count is already 0.
 */
function ReadAllButton({ count, onState, newReader = false }: { count: number; onState: (running: boolean) => void; newReader?: boolean }) {
  const command = useCommand(async () => { onState(true); try { await acknowledgeAll(newReader); } finally { onState(false); } });
  const hint = newReader ? tr("Accept the current state of the documents as read. You can undo it", "Принять текущее состояние документов за прочитанное — можно отменить") : tr("Mark all documents with changes read. You can undo it", "Отметить прочитанными все документы с изменениями — можно отменить");
  return <>
    <Tip label={command.state.running ? tr("Marking read…", "Отмечаю прочитанными…") : hint}>
      <Button size="sm" variant={newReader ? "default" : "ghost"} {...busyProps(command.state)} onClick={() => void command.start()} data-read-all={newReader ? "new-reader" : ""}>
        <BusyGlyph name="CheckCheck" size={14} />{newReader ? tr("Accept current state", "Принять текущее состояние") : <>{VERB.readAll.button}{count ? ` · ${num(count)}` : ""}</>}
      </Button>
    </Tip>
    {command.state.slow && <WaitNote>{tr("Marking documents read: on a large checkout this takes up to a minute…", "Отмечаю документы прочитанными — на большой копии это до минуты…")}</WaitNote>}
  </>;
}

/** The rule state of a directory, from the decisions of its files. */
function dirRule(tree: TreeInfo, dir: string): { hidden: boolean; hiddenFrom: string | null; untracked: boolean; untrackedFrom: string | null } {
  const inside = tree.entries.filter((entry) => entry.path.startsWith(`${dir}/`));
  const hidden = inside.length > 0 && inside.every((entry) => entry.hidden);
  const untracked = inside.filter((entry) => entry.supported).length > 0 && inside.filter((entry) => entry.supported).every((entry) => entry.untracked);
  const own = (pattern: string | null) => (pattern === `${dir}/` ? null : pattern);
  return { hidden, hiddenFrom: hidden ? own(inside[0]?.hiddenFrom ?? null) : null, untracked, untrackedFrom: untracked ? own(inside.find((entry) => entry.supported)?.untrackedFrom ?? null) : null };
}


const RULE_LEVEL: Record<string, string> = {
  immutable: tr("internal", "служебные"),
  builtin: tr("built-in exclusions", "встроенные исключения"),
  global: tr("my global", "глобальные мои"),
  repo: tr("repository exclusions", "исключения репозитория"),
};
/** Localized hint reporting how many agent replies await a decision. */
const WAIT = forms(["waits", "wait"], ["ждёт", "ждут", "ждут"]);
/** Localized missing-file count with singular and plural forms. */
const MISSING = forms(["is missing", "are missing"], ["пропал", "пропали", "пропали"]);
const FOLDER = forms(["folder", "folders"], ["папка", "папки", "папок"]);

/** Lucide icon of a file type (design system «Files of any type»). */
function iconOf(format: string | undefined): string {
  return format && format in FORMATS ? FORMATS[format as FormatId].icon : "FileText";
}

function typeLabel(format: string | undefined): string {
  return format && format in FORMATS ? FORMATS[format as FormatId].label : "Markdown";
}

/** «File types» (W-06c, §4): groups of the registry with counts and «Outside Git only» — a view of this session. */
function TypeFilter({ tree }: { tree: TreeInfo }) {
  const typeFilter = useUi((ui) => ui.typeFilter);
  const outsideOnly = useUi((ui) => ui.outsideOnly);
  const counts = new Map<string, number>();
  for (const entry of tree.entries) counts.set(entry.group ?? "markdown", (counts.get(entry.group ?? "markdown") ?? 0) + 1);
  const outside = tree.entries.filter((entry) => entry.fileClass === "outside").length;
  const shown = typeFilter ?? TYPE_GROUPS;
  const active = Boolean(typeFilter) || outsideOnly;
  const toggle = (group: string) => {
    const next = shown.includes(group) ? shown.filter((item) => item !== group) : [...shown, group];
    setUi({ typeFilter: next.length === TYPE_GROUPS.length ? null : next });
  };
  const icon: Record<string, string> = { markdown: "FileText", yaml: "FileCog", json: "FileBraces", toml: "FileSliders", dotenv: "FileKey", text: "FileType", csv: "FileSpreadsheet" };
  return <Menu>
    <Tip label={active ? tr("File types: filter on", "Типы файлов: фильтр включён") : tr("File types", "Типы файлов")}>
      <MenuTrigger asChild>
        <button type="button" className="dr-btn dr-btn--ghost dr-btn--icon" aria-label={tr(`File types: ${active ? "filter on" : "all"}`, `Типы файлов: ${active ? "фильтр включён" : "все"}`)} aria-pressed={active} data-tree-types>
          <Icon name="ListFilter" />{active && <span className="dr-dot" style={{ position: "absolute", top: 5, right: 5 }} aria-hidden />}
        </button>
      </MenuTrigger>
    </Tip>
    <MenuContent align="end" mobileTitle={tr("File types", "Типы файлов")}>
      <MenuLabel>{tr("Types · this session only", "Типы · только этот сеанс")}</MenuLabel>
      {TYPE_GROUPS.map((group) => <MenuCheck key={group} checked={shown.includes(group)} onSelect={(event) => event.preventDefault()} onCheckedChange={() => toggle(group)}>
        <Icon name={icon[group]} size={14} /><span className="dr-grow">{GROUP_LABEL[group]}</span><span className="dr-meta">{num(counts.get(group) ?? 0)}</span>
      </MenuCheck>)}
      <MenuSeparator />
      <MenuCheck checked={outsideOnly} onSelect={(event) => event.preventDefault()} onCheckedChange={(next) => setUi({ outsideOnly: Boolean(next) })} disabled={!outside && !outsideOnly}>
        <Icon name="GitBranchMinus" size={14} /><span className="dr-grow">{tr("Outside Git only", "Только вне Git")}</span><span className="dr-meta">{num(outside)}</span>
      </MenuCheck>
      {active && <MenuItem onSelect={() => setUi({ typeFilter: null, outsideOnly: false })}>{tr("Show all types", "Показать все типы")}</MenuItem>}
    </MenuContent>
  </Menu>;
}

/** «Not shown: N» (W-06c, §4): exclusions by rule and level, other types, symlinks, a partial tree — in the footer. */
function NotShownTip({ tree }: { tree: TreeInfo }) {
  const ns = tree.notShown;
  const rules = (ns?.rules ?? []).filter((rule) => rule.level !== "immutable");
  const lines: { label: string; value: string }[] = [
    ...rules.slice(0, 8).map((rule) => ({ label: `${RULE_LEVEL[rule.level]} · ${rule.pattern}`, value: [rule.files ? counted(rule.files, W.file) : "", rule.dirs ? counted(rule.dirs, FOLDER) : ""].filter(Boolean).join(", ") })),
    ...(ns?.types.wave2 ? [{ label: tr("Future types (ini, xml, Dockerfile, html…)", "Будущие типы (ini, xml, Dockerfile, html…)"), value: num(ns.types.wave2) }] : []),
    ...(ns?.types.other ? [{ label: tr("Other files (code, images…)", "Другие файлы (код, картинки…)"), value: num(ns.types.other) }] : []),
    ...(ns?.types.disabled ? [{ label: tr("Types turned off in the repository", "Типы, выключенные в репозитории"), value: num(ns.types.disabled) }] : []),
    ...((ns?.symlinks ?? tree.skipped?.symlinks) ? [{ label: tr("Symbolic links", "Символьные ссылки"), value: num(ns?.symlinks ?? tree.skipped?.symlinks ?? 0) }] : []),
    ...(tree.truncated ? [{ label: tr(`Over the limit of ${num(20000)}: hide generated files with a rule`, "Сверх предела 20 000 — скройте сгенерированное правилом"), value: num(tree.truncated) }] : []),
  ];
  if (!lines.length && !tree.partial) return null;
  const total = rules.reduce((sum, rule) => sum + rule.files + rule.dirs, 0) + (ns ? ns.types.wave2 + ns.types.other + ns.types.disabled + ns.symlinks : 0) + tree.truncated;
  const label = <span className="block" style={{ maxWidth: 360 }}>
    <b>{tr("Not shown: ", "Не показано: ")}{num(total)}</b>{tree.partial && <span className="block">{tr("The tree is incomplete: the scan stopped on a time limit. Refresh, or hide the noise with a rule.", "Дерево неполное: обход остановлен по времени — обновите или скройте шум правилом.")}</span>}
    <dl className="dr-hidden-why">{lines.map((line) => <Fragment key={line.label}><dt>{line.label}</dt><dd>{line.value}</dd></Fragment>)}</dl>
  </span>;
  return <Tip label={label}>
    <button type="button" className="dr-btn dr-btn--ghost dr-btn--sm dr-btn--icon" aria-label={tr(`Not shown: ${num(total)}${tree.partial ? "; tree incomplete" : ""}`, `Не показано: ${num(total)}${tree.partial ? "; дерево неполное" : ""}`)} data-tree-skipped><Icon name="Info" /></button>
  </Tip>;
}
