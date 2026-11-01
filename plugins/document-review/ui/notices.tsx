// What sits above the document (design EP-020-T02): «Waiting for you» (buttons-counters; one summary button on a narrow
// column), banners of one shape (deleted, conflicts of the document and config.json, read-only, outside the roots,
// review not enabled, tracking resumed, hidden), drafts as buttons, and the dialog that enables the review (A10).
import { FORMATS, type FormatId } from "../core/formats/registry.ts";
import { useEffect, useState } from "react";
import type { DocumentView } from "../node/view.ts";
import { enablePlan, explain, resolveConfigConflict, resolveDocumentConflict, resolveMove, trackLocal } from "./actions.ts";
import { loadEnableJob, startEnableJob, stopEnableJob, useEnableJob } from "./enable-job.ts";
import { TransferBanner } from "./transfer.tsx";
import { Icon } from "./icons.tsx";
import { withBreaks } from "./render.tsx";
import { Banner, Button, CommandButton, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, InlineError, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Skeleton, Tip } from "./kit.tsx";
import type { PassMode } from "./pass.ts";
import { type Draft, type ErrorInfo, notify, useUi } from "./store.ts";
import { W, counted, fullDate, num, plural } from "./words.ts";
import { forms, locale, tr } from "../core/i18n.ts";

type OnPass = (mode: PassMode, scope: "document" | "all", filter?: "waiting" | "place") => void;
type Row = { key: string; text: string; count: number; run: () => void; quiet?: boolean };

const ANSWERS = forms(["agent reply", "agent replies"], ["ответ агента", "ответа агента", "ответов агента"]);
const LOST = forms(["comment lost its anchor", "comments lost their anchor"], ["потеряло привязку", "потеряли привязку", "потеряли привязку"]);
const UNSENT = forms(["unsent comment", "unsent comments"], ["неотправленное", "неотправленных", "неотправленных"]);
const OF_DOCUMENTS = forms(["document", "documents"], ["документа", "документов", "документов"]);

/** «Waiting for you» (I1): this document and the whole checkout; each button starts the pass over its set. */
export function WaitingBlock({ onPass, narrow }: { onPass: OnPass; narrow: boolean }) {
  const view = useUi((ui) => ui.view);
  const batch = useUi((ui) => ui.batch);
  const tree = useUi((ui) => ui.tree);
  if (!view) return null;
  const waiting = view.annotations.filter((annotation) => annotation.waiting).length;
  const lost = view.annotations.filter((annotation) => annotation.status === "open" && ["approximate", "ambiguous", "orphaned"].includes(annotation.anchor.status)
    && !(annotation.anchor.status === "orphaned" && !annotation.tombstoneId && (annotation.latest?.linked.length ?? 0) > 0)).length;
  const unsent = view.annotations.filter((annotation) => annotation.candidate).length;
  const rows: Row[] = [];
  if (batch?.thread?.waitingUser) rows.push({ key: "thread", text: tr("Agent is waiting for you in the thread", "Агент ждёт вас в треде"), count: 1, run: () => onPass("comments", "document") });
  if (waiting) rows.push({ key: "waiting", text: plural(waiting, ANSWERS), count: waiting, run: () => onPass("comments", "document", "waiting") });
  if (view.unread) rows.push({ key: "unread", text: plural(view.unread, W.change), count: view.unread, run: () => onPass("changes", "document") });
  if (lost) rows.push({ key: "lost", text: plural(lost, LOST), count: lost, run: () => onPass("comments", "document", "place") });
  if (unsent) rows.push({ key: "unsent", text: plural(unsent, UNSENT), count: unsent, run: () => onPass("comments", "document") });
  // The whole checkout (I1): other documents with answers waiting or unread changes.
  const others = (tree?.entries ?? []).filter((entry) => entry.path !== view.document.path);
  const waitingElsewhere = others.reduce((sum, entry) => sum + entry.waiting, 0) + (tree?.virtual ?? []).reduce((sum, entry) => sum + entry.waiting, 0);
  const changedElsewhere = others.filter((entry) => entry.state === "unread" || entry.state === "new" || entry.state === "changed").length + (tree?.virtual ?? []).filter((entry) => entry.reason === "missing").length;
  const copyRows: Row[] = [];
  if (waitingElsewhere) copyRows.push({ key: "w-all", text: tr(`${plural(waitingElsewhere, W.answer)} in other documents`, `${plural(waitingElsewhere, W.answer)} в других документах`), count: waitingElsewhere, run: () => onPass("comments", "all", "waiting"), quiet: true });
  if (changedElsewhere) copyRows.push({ key: "c-all", text: tr(`${plural(changedElsewhere, W.document)} with changes`, `${plural(changedElsewhere, W.document)} с изменениями`), count: changedElsewhere, run: () => onPass("changes", "all"), quiet: true });
  if (!rows.length && !copyRows.length) return null;
  const total = rows.reduce((sum, row) => sum + row.count, 0) + copyRows.reduce((sum, row) => sum + row.count, 0);
  if (narrow) {
    return <div className="dr-wait" role="region" aria-label={tr("Waiting for you", "Ждёт вас")} data-waiting>
      <Menu>
        <MenuTrigger asChild><button type="button" className="dr-wchip"><Icon name="Inbox" size={14} />{tr("Waiting for you", "Ждёт вас")} <b>{num(total)}</b><Icon name="ChevronDown" size={14} /></button></MenuTrigger>
        <MenuContent align="start" mobileTitle={tr("Waiting for you", "Ждёт вас")}>
          {rows.map((row) => <MenuItem key={row.key} onSelect={row.run}><b className="tabular-nums">{num(row.count)}</b>{row.text}</MenuItem>)}
          {copyRows.length > 0 && <><MenuSeparator /><MenuLabel>{tr("In the checkout", "В рабочей копии")}</MenuLabel></>}
          {copyRows.map((row) => <MenuItem key={row.key} onSelect={row.run}><b className="tabular-nums">{num(row.count)}</b>{row.text}</MenuItem>)}
        </MenuContent>
      </Menu>
      <span className="dr-trunc">{[...rows, ...copyRows].map((row) => `${num(row.count)} ${row.text}`).join(" · ")}</span>
    </div>;
  }
  return <div className="dr-wait" role="region" aria-label={tr("Waiting for you", "Ждёт вас")} data-waiting>
    <span className="dr-wait__label"><Icon name="Inbox" />{tr("Waiting for you", "Ждёт вас")}</span>
    {rows.map((row) => <button key={row.key} type="button" onClick={row.run} className="dr-wchip" title={tr("Go through this set", "Пройти по этому набору")}>{row.key === "thread" ? row.text : <><b>{num(row.count)}</b>{row.text}</>}</button>)}
    {copyRows.length > 0 && <span style={{ marginLeft: 6 }}>{tr("in the checkout:", "в рабочей копии:")}</span>}
    {copyRows.map((row) => <button key={row.key} type="button" onClick={row.run} className="dr-wchip dr-wchip--quiet" title={tr("Go through all documents of the checkout in tree order", "Проход по всем документам рабочей копии в порядке дерева")}><b>{num(row.count)}</b>{row.text}</button>)}
  </div>;
}

/** What the three-way merge of config.json will write: per list, ours / theirs / merged (EP-014-T02). */
function ConfigMergePreview({ conflict }: { conflict: NonNullable<DocumentView["context"]["configConflict"]> }) {
  const label: Record<string, string> = { roots: tr("Roots", "Корни"), hidden: tr("Hidden", "Скрыто"), untracked: tr("Untracked", "Без отслеживания") };
  // EP-047: whole words in the cells, long paths wrap after «/» and «.» (<wbr>), never in the middle of a word.
  const show = (list: string[]) => (list.length ? withBreaks(list.join(", "), list.join("|")) : "—");
  return <div className="dr-table w-full" style={{ margin: "4px 0 0" }}><table style={{ fontSize: 12 }}><thead><tr><th /><th>{tr("This branch", "Эта ветка")}</th><th>{tr("Other branch", "Другая ветка")}</th><th>{tr("After merge", "После объединения")}</th></tr></thead>
    <tbody>{(["roots", "hidden", "untracked"] as const).map((key) => <tr key={key}><td className="text-muted-foreground">{label[key]}</td>
      <td className="font-mono">{show(conflict.ours[key])}</td><td className="font-mono">{show(conflict.theirs[key])}</td><td className="font-mono">{show(conflict.merged[key])}</td></tr>)}</tbody></table></div>;
}

/** Banners of the document, in one shape: blocking ones are alerts, the rest statuses. */
export function DocBanners({ view, viewError, onEnable, onRetry }: { view: DocumentView | null; viewError: ErrorInfo | null; onEnable: (reason: string) => void; onRetry: () => Promise<unknown> }) {
  // W-06b: every banner action is a command — busy at once, the indicator after 150 ms, a second press sends nothing.
  const enableJob = useEnableJob();
  return <>
    {viewError && <Banner icon={viewError.code === "host-unavailable" ? "WifiOff" : "TriangleAlert"} tone="error" role="alert"
      actions={<CommandButton size="sm" icon="RefreshCw" run={onRetry}>{tr("Retry", "Повторить")}</CommandButton>}>
      {explain(viewError)}{viewError.code === "host-unavailable" && view ? tr(" Showing the last received text, it may be out of date.", " Показан последний полученный текст — он может быть устаревшим.") : ""}
    </Banner>}
    {view?.document.missing && <Banner icon="FileX" role="status" data-missing-banner
      actions={view.document.deletionUnread && view.document.docId && view.context.enabled ? <CommandButton size="sm" icon="Check" run={() => resolveMove(view.document.docId!, null)}>{tr("Mark deletion read", "Удаление прочитано")}</CommandButton> : undefined}>
      {tr("The document was deleted from the checkout. Showing the last saved revision; comments are available, new ones can't be added to the text.", "Документ удалён из рабочей копии. Показана последняя сохранённая редакция; замечания доступны, новые к тексту не ставятся.")}
    </Banner>}
    {view?.document.conflict && view.document.docId && <Banner icon="GitMerge" tone="error" role="alert" data-doc-conflict
      actions={<div className="flex w-full flex-wrap gap-1">
        {view.document.conflict.register === "path"
          ? [...new Set(view.document.conflict.candidates.map((candidate) => candidate.value))].map((value) => <CommandButton key={value} size="sm" run={() => resolveDocumentConflict(view.document.docId!, value)}>{tr("Path ", "Путь ")}{value}</CommandButton>)
          : <>{!view.document.missing && <CommandButton size="sm" run={() => resolveDocumentConflict(view.document.docId!, "keep")}>{tr("Keep document", "Оставить документ")}</CommandButton>}
            <CommandButton size="sm" run={() => resolveDocumentConflict(view.document.docId!, "removed")}>{tr("Document deleted", "Документ удалён")}</CommandButton></>}
      </div>}>
      {view.document.conflict.register === "path"
        ? tr(`The branches renamed the document differently: ${[...new Set(view.document.conflict.candidates.map((candidate) => candidate.value))].join(" / ")}. Choose a path, none was chosen automatically.`, `Ветки по-разному переименовали документ: ${[...new Set(view.document.conflict.candidates.map((candidate) => candidate.value))].join(" / ")}. Выберите путь — ни один не выбран автоматически.`)
        : tr("The branches diverged: one changed or renamed the document, the other deleted it. Choose which is right; nothing was decided automatically.", "Ветки разошлись: на одной документ изменён или переименован, на другой — удалён. Выберите, что верно; автоматически ничего не решено.")}
    </Banner>}
    {view?.context.configConflict && <Banner icon="GitMerge" tone="error" role="alert" data-config-conflict>
      {tr("After a branch merge, .bb-docs/config.json has a Git conflict. Reading follows the rules of this branch; writing waits for the resolution.", "После слияния веток в .bb-docs/config.json конфликт Git. Чтение продолжается по правилам этой ветки; запись ждёт разрешения.")}
      <ConfigMergePreview conflict={view.context.configConflict} />
      {view.context.configConflict.problem
        ? <div className="mt-1">{view.context.configConflict.problem}</div>
        : <div className="mt-2"><CommandButton size="sm" run={() => resolveConfigConflict(view.context.configConflict!.configSha)}>{tr("Merge the rules of both branches", "Объединить правила обеих веток")}</CommandButton></div>}
    </Banner>}
    {view?.document.trackingResumed && <Banner icon="History" tone="quiet" role="status" data-resumed-banner>
      {tr("Tracking resumed ", "Отслеживание возобновлено ")}{fullDate(view.document.trackingResumed)}{tr(": edits made during the pause were not tracked, they are neither marked unread nor counted as read.", ": правки за время паузы не отслеживались — они не помечены непрочитанными и не считаются прочитанными.")}
    </Banner>}
    {view && view.scope === "local" && <Banner icon="HardDrive" tone="quiet" role="status" data-local-banner>{tr("File outside Git, the review is local: marks, “Mark read” and comments are stored only on this machine, nothing goes into ", "Файл вне Git — обзор локальный: пометки, «Прочитано» и замечания хранятся только на этой машине, в ")}<code>.bb-docs</code>{tr(".", " ничего не попадает.")}</Banner>}
    {view && view.fileClass === "outside" && view.scope !== "local" && <Banner icon="Eye" tone="quiet" role="status" data-outside-banner
      actions={<CommandButton size="sm" icon="HardDrive" run={() => trackLocal(view.document.path, false, "add")}>{tr("Track locally", "Отслеживать локально")}</CommandButton>}>
      {tr("File outside Git (ignored): view only; secret values are hidden, “Reveal value” on click. Track locally to keep marks and comments on this machine only.", "Файл вне Git (игнорируется): только просмотр; значения секретов скрыты, «Показать значение» — по клику. Отслеживать локально — пометки и замечания только на этой машине.")}
    </Banner>}
    {view && <TransferBanner path={view.document.path} />}
    {view?.parseError && view.format && <Banner icon="FileWarning" tone="warn" role="status" data-parse-error>
      {tr("The file doesn't parse as ", "Файл не разбирается как ")}{FORMATS[view.format as FormatId]?.label ?? view.format}{tr(": line ", ": строка ")}{view.parseError.line}{tr(", ", " — ")}<code className="dr-trunc">{view.parseError.message.slice(0, 200)}</code>{tr(". Shown “Raw” line by line: marks and comments go to lines, secrets are hidden more strictly than usual; “Pretty” after the fix.", ". Показан «Как есть» построчно: пометки и замечания — к строкам, секреты скрыты строже обычного; «Красиво» — после исправления.")}
    </Banner>}
    {view?.document.hidden && <Banner icon="EyeOff" tone="quiet" role="status">{tr("The document is hidden by visibility rules: it doesn't show in the tree or search, but it is readable and tracked.", "Документ скрыт правилами видимости: он не виден в дереве и поиске, но читается и отслеживается.")}</Banner>}
    {view && !view.context.enabled && view.context.isRepo && <EnableJobLine />}
    {view && !view.context.enabled && view.context.isRepo && !enableJob && <Banner icon="Info" role="status"
      actions={<Button size="sm" onClick={() => onEnable(tr("Enabling creates .bb-docs/ and takes the current state of the documents as the baseline.", "Включение создаст .bb-docs/ и примет текущее состояние документов за исходную базу."))}>{tr("Enable review", "Включить обзор")}</Button>}>
      {tr("You can read right away. To leave comments and mark things read, enable review in this checkout.", "Читать можно сразу. Чтобы оставлять замечания и отмечать прочитанное, включите обзор в этой рабочей копии.")}
    </Banner>}
    {view?.document.readOnly && !view.context.readOnlyReason && <Banner icon="Info" role="status" data-doc-readonly>{tr("Read-only document: ", "Документ только для чтения: ")}{view.document.readOnly}</Banner>}
    {view?.context.readOnlyReason && !view.context.configConflict && <Banner icon="Info" role="status">{view.context.readOnlyReason}</Banner>}
    {view && view.context.enabled && !view.document.insideRoots && <Banner icon="Info" tone="quiet" role="status">{tr(`The document is outside the review roots (${view.context.roots.join(", ")}): you can read it, but comments and marks are not saved.`, `Документ вне корней обзора (${view.context.roots.join(", ")}): читать можно, замечания и отметки не сохраняются.`)}</Banner>}
  </>;
}

export function Drafts({ drafts, sha, onOpen }: { drafts: Draft[]; sha: string | undefined; onOpen: (draft: Draft) => void }) {
  if (!drafts.length) return null;
  return <div className="dr-wait" role="region" aria-label={tr("Drafts", "Черновики")}>
    <span className="dr-wait__label"><Icon name="StickyNote" />{tr("Drafts", "Черновики")}</span>
    {drafts.map((draft) => <Tip key={draft.key} label={draft.text.slice(0, 300)}><button type="button" className="dr-wchip dr-wchip--quiet" disabled={draft.target.kind === "reply"} onClick={() => onOpen(draft)}>
      {tr("“", "«")}{draft.text.slice(0, 40)}{draft.text.length > 40 ? "…" : ""}{tr("”", "»")}{draft.sha !== sha ? <span className="dr-meta">{tr("· for an earlier revision", "· к прежней редакции")}</span> : null}
    </button></Tip>)}
  </div>;
}

/** The skeleton of a document: the heading and paragraphs by the shape of the result. */
export function DocSkeleton() {
  const lines = [38, 0, 92, 88, 64, 0, 52, 0, 95, 90, 86, 40];
  return <div aria-busy="true" role="status" aria-label={tr("Loading document", "Документ загружается")} style={{ paddingLeft: "calc(var(--dr-gutter) + 12px)", paddingTop: 16 }}>
    {lines.map((width, index) => width ? <div key={index} className="dr-skel" style={{ width: `${width}%`, height: index === 0 ? 22 : 12, margin: index === 0 ? "0 0 18px" : "0 0 12px" }} /> : <div key={index} style={{ height: 14 }} />)}
  </div>;
}

function Switch({ checked, onChange, children }: { checked: boolean; onChange: (next: boolean) => void; children: string }) {
  return <button type="button" role="switch" aria-checked={checked} className="dr-switch" onClick={() => onChange(!checked)}><i aria-hidden />{children}</button>;
}

/** Background enabling shows the initial-base count, a progress rail and Stop. After stopping or failure, report what was saved and offer Continue; the host resumes the unfinished work. */
/** «7,5 MiB». */
const mib = (bytes: number) => `${new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)}\u00a0${tr("MiB", "МиБ")}`;

/** Localized document count after the of separator. */
const ofDocuments = (total: number) => plural(total, OF_DOCUMENTS);

export function EnableJobLine() {
  const job = useEnableJob();
  const hostId = useUi((ui) => ui.tree?.machine.hostId ?? null);
  const root = useUi((ui) => ui.tree?.root ?? null);
  const enabled = useUi((ui) => ui.tree?.enabled ?? null);
  useEffect(() => { if (hostId && root && enabled === false) void loadEnableJob(); }, [hostId, root, enabled]);
  if (!job || job.state === "done") return null;
  const total = job.total;
  if (job.state === "running") {
    const share = total ? Math.min(1, job.done / total) : 0;
    return <div className="fb-progress" role="status" aria-live="polite" data-enable-job="running"
      title={tr("The baseline of the documents is saved in the background: you can keep reading and working", "Исходная база документов сохраняется в фоне: можно читать и работать дальше")}>
      <span className="fb-grow">{job.stopping ? tr("Stopping after the current chunk of documents…", "Останавливаю после текущей пачки документов…")
        : total === null ? tr("Enabling review: collecting the list of documents…", "Включаю обзор: собираю список документов…")
        : <>{tr("Enabling review: ", "Включаю обзор: ")}<b>{num(job.done)}{tr(" of ", " из ")}{num(total)}</b> {ofDocuments(total)}…</>}</span>
      {!job.stopping && <button type="button" className="fb-btn" onClick={() => void stopEnableJob()}>{tr("Stop", "Остановить")}</button>}
      <span className="fb-bar" style={{ width: `${Math.round(share * 100)}%` }} />
    </div>;
  }
  const failure = job.state === "failed" ? explain(job.error ?? { code: "internal", message: tr("unknown error", "неизвестная ошибка") }) : "";
  const saved = total ? tr(` Saved ${num(job.done)} of ${num(total)} ${ofDocuments(total)}.`, ` Сохранено ${num(job.done)} из ${num(total)} ${ofDocuments(total)}.`) : "";
  return <Banner icon={job.state === "failed" ? "TriangleAlert" : "Info"} tone={job.state === "failed" ? "error" : undefined} role="status" data-enable-job={job.state}
    actions={<CommandButton size="sm" icon="Play" run={async () => { const error = await startEnableJob(null, job.markGenerated); if (error) notify(tr(`Couldn't continue enabling: ${error}`, `Не удалось продолжить включение: ${error}`), { tone: "error" }); }}>{tr("Continue", "Продолжить")}</CommandButton>}>
    {job.state === "failed" ? tr(`Enabling review was interrupted: ${failure}`, `Включение обзора прервано: ${failure}`) : tr("Enabling review stopped.", "Включение обзора остановлено.")}{saved}{tr(" “Continue” picks up where it left off.", " «Продолжить» доделает с того же места.")}
  </Banner>;
}

/** Enable the review in this checkout (A10): the plan, the identity and the .gitattributes switch. */
export function EnableDialog({ reason, onClose }: { reason: string | null; onClose: () => void }) {
  const [plan, setPlan] = useState<Record<string, any> | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [mark, setMark] = useState(true);
  useEffect(() => {
    if (!reason) return;
    setPlan(null);
    setPlanError(null);
    let current = true;
    // W-06b: a failure is said in the dialog with «Retry» — not an endless skeleton and an unavailable button.
    void enablePlan().then((value) => { if (!current) return; if ("plan" in value) setPlan(value.plan); else setPlanError(value.error); });
    return () => { current = false; };
  }, [reason, attempt]);
  const job = useEnableJob();
  const running = job?.state === "running";
  const blocked = !plan || !plan.identity?.email || plan.alreadyEnabled || running;
  return <Dialog open={Boolean(reason)} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-w-lg" aria-describedby={undefined}>
      <DialogHeader>
        <DialogTitle className="text-[15px] font-semibold">{tr("Enable review in this checkout", "Включить обзор в этой рабочей копии")}</DialogTitle>
        <DialogDescription className="text-[13px] text-muted-foreground">{reason}</DialogDescription>
      </DialogHeader>
      {running && <EnableJobLine />}
      {planError ? <InlineError onRetry={() => setAttempt((value) => value + 1)}>{tr("Couldn't prepare enabling: ", "Не удалось подготовить включение: ")}{planError}</InlineError>
        : !plan ? <Skeleton widths={[70, 55, 62, 48, 66]} label={tr("Preparing the enable plan…", "Готовлю план включения…")} />
        : <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
          <dt className="text-muted-foreground">{tr("Storage", "Хранилище")}</dt><dd className="font-mono text-[12px]">{plan.storage}</dd>
          <dt className="text-muted-foreground">{tr("Roots", "Корни")}</dt><dd>{plan.roots.join(", ")}{plan.rootsMissing?.length ? tr(` (missing: ${plan.rootsMissing.join(", ")})`, ` (нет: ${plan.rootsMissing.join(", ")})`) : ""}</dd>
          <dt className="text-muted-foreground">{tr("Baseline", "Исходная база")}</dt><dd>{counted(plan.documents, W.document)}, {new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(plan.snapshotBytes / 1024)}&nbsp;{tr("KiB of snapshots", "КиБ снимков")}</dd>
          {plan.deferred?.count > 0 && <>
            <dt className="text-muted-foreground">{tr("Large files", "Большие файлы")}</dt>
            <dd title={plan.deferred.largest.map((file: { path: string; size: number }) => `${file.path} — ${mib(file.size)}`).join("\n")}>
              {counted(plan.deferred.count, W.file)}{tr(" larger than ", " больше ")}{mib(plan.deferred.limit)} ({mib(plan.deferred.bytes)}){tr(": no baseline; readable right away, they join the review with the first comment or “Mark read”", " — без исходной базы: читать можно сразу, в обзор войдут с первым замечанием или «Прочитано»")}
            </dd>
          </>}
          <dt className="text-muted-foreground">{tr("Signature", "Подпись")}</dt><dd>{plan.identity?.name ?? "—"} &lt;{plan.identity?.email ?? tr("user.email is not set, can't enable", "user.email не задан — включение невозможно")}&gt;</dd>
          <dt className="text-muted-foreground">Git</dt><dd className="flex items-start gap-1.5">{plan.ignoredByGit && <Icon name="TriangleAlert" size={14} style={{ color: "var(--dr-changed)", marginTop: 3, flex: "none" }} />}{plan.ignoredByGit ? tr(".bb-docs is ignored by Git: review data won't reach the repository; change .gitignore yourself", ".bb-docs игнорируется Git — данные обзора не попадут в репозиторий; .gitignore меняйте сами") : tr(".bb-docs will be visible to Git: commit it together with the documents", ".bb-docs будет виден Git: закоммитьте его вместе с документами")}</dd>
        </dl>}
      <Switch checked={mark} onChange={setMark}>{tr("Mark .bb-docs as generated in .gitattributes", "Пометить .bb-docs как сгенерированный в .gitattributes")}</Switch>
      <DialogFooter className="flex flex-row justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>{tr("Cancel", "Отмена")}</Button>
        {/* The base is saved in the background: the dialog closes as soon as the server has the job (2026-10-16). */}
        <CommandButton variant="primary" disabled={blocked} slow={tr("Starting to enable…", "Запускаю включение…")}
          run={async () => {
            const error = await startEnableJob(plan!.head ?? null, mark);
            if (error) notify(tr(`Couldn't enable review: ${error}`, `Не удалось включить обзор: ${error}`), { tone: "error" });
            else onClose();
          }}>{running ? tr("Enabling…", "Включается…") : tr("Enable review", "Включить обзор")}</CommandButton>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
