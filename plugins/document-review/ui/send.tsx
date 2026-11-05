import { openFixedTab } from "./bb-compat.ts";
// «Send to agent» (E12, E15; design EP-020-T06): the split button «Send to agent · N» and its menu — «Scope» and
// «Recipient» as rows of choice with counts, unavailable ones with the reason, the summary with warnings and the
// button with the same verb and number. While a batch runs the button shows the agent state («Agent: Queued in the thread»).
import { experimental_useAppPanel, useRealtime } from "@get-bb/plugin-sdk/app";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createLatest, useCommand } from "../feedback.ts";
import { call, explain, mutate } from "./actions.ts";
import { Icon } from "./icons.tsx";
import { BusyGlyph, Button, busyProps, InlineError, Popover, PopoverContent, PopoverTrigger, Skeleton, Spinner, Tip, WaitNote } from "./kit.tsx";
import { batchLabel } from "./labels.ts";
import { type ErrorInfo, getUi, notify, useUi } from "./store.ts";
import { agentTab } from "./tabs.ts";
import { forms, lang, tr } from "../core/i18n.ts";
import { W, counted, middle, plural } from "./words.ts";

/** Choose the count-dependent verb for waiting instructions. */
const WAIT = forms(["is waiting", "are waiting"], ["ждёт", "ждут", "ждут"]);

type Summary = { total: number; documents: { path: string; count: number; hidden: boolean; lost: number; missing: boolean }[]; hidden: number; lost: number };

/** Recipient-row state: free, busy with a turn, offline, or being checked. */
type RecipientState = { text: string; tone: "ok" | "busy" | "off" | "checking" };

/** The state of the thread recipient from bb's thread status (idle, active, pending, starting, stopping, error). */
export function threadState(status: string | undefined): RecipientState | null {
  if (!status) return null;
  if (status === "idle") return { text: tr("free", "свободен"), tone: "ok" };
  if (status === "active" || status === "pending" || status === "starting") return { text: tr("busy: a turn is running", "занят: идёт ход"), tone: "busy" };
  if (status === "stopping") return { text: tr("busy: the turn is stopping", "занят: ход останавливается"), tone: "busy" };
  if (status === "error") return { text: tr("error in the thread", "ошибка в треде"), tone: "busy" };
  return null;
}

function RecipientStatus({ state }: { state: RecipientState | null }) {
  if (!state) return null;
  return <span className="dr-option__detail dr-recipient" data-recipient-state={state.tone}>
    {state.tone === "checking" ? <Spinner size={14} /> : state.tone === "off" ? <Icon name="WifiOff" size={14} /> : <span className={`dr-dot${state.tone === "busy" ? " dr-dot--changed" : ""}`} aria-hidden />}
    {state.text}
  </span>;
}

function Choice({ checked, disabled, onSelect, children, detail, reason, autoFocus }: { checked: boolean; disabled?: boolean; onSelect: () => void; children: ReactNode; detail?: ReactNode; reason?: string; autoFocus?: boolean }) {
  return <button type="button" role="radio" aria-checked={checked} aria-disabled={disabled || undefined} disabled={disabled} autoFocus={autoFocus} className="dr-option" onClick={onSelect} title={reason}
    onKeyDown={(event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const group = (event.currentTarget.closest("[role=radiogroup]")?.querySelectorAll<HTMLButtonElement>("[role=radio]:not(:disabled)")) ?? [];
      const list = [...group];
      const next = list[(list.indexOf(event.currentTarget) + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length];
      event.preventDefault();
      next?.focus();
      next?.click();
    }}>
    <Icon name={checked ? "CircleDot" : "Circle"} />
    <span className="dr-grow">{children}{reason && <span className="block text-[12px] text-muted-foreground">{reason}</span>}</span>
    {detail}
  </button>;
}

export function SendButton({ doc, compact = false }: { doc: string; compact?: boolean }) {
  const batch = useUi((ui) => ui.batch);
  const view = useUi((ui) => ui.view);
  const isHost = useUi((ui) => ui.route.kind === "host");
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<"document" | "all">("document");
  const [mode, setMode] = useState<"current-thread" | "new-thread" | null>(null);
  const panel = experimental_useAppPanel();
  const recipient = batch?.recipient ?? { mode: "new-thread" as const, threadId: null, title: null, reason: null };
  const chosen = mode ?? recipient.mode;
  const docCount = batch?.newInstructions.document[doc] ?? 0;
  const allCount = batch?.newInstructions.all ?? 0;
  const count = scope === "document" ? docCount : allCount;
  const label = batchLabel(batch);
  // E15: the host's summary of the chosen scope — documents, hidden ones with instructions, lost places. Warns only.
  // Show a skeleton while counting and an inline error with Retry on failure; discard stale replies from other scopes.
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryError, setSummaryError] = useState<ErrorInfo | null>(null);
  const [summaryAttempt, setSummaryAttempt] = useState(0);
  const summaries = useMemo(() => createLatest(), []);
  useEffect(() => {
    if (!open) return;
    setSummary(null);
    setSummaryError(null);
    const token = summaries.begin();
    void call<Summary>("review.batch.summary", { target: getUi().target, scope: scope === "document" ? { kind: "document", path: doc } : { kind: "all" } }).then((reply) => {
      if (!summaries.isCurrent(token)) return;
      if (reply.ok) setSummary((reply as unknown as { result: Summary }).result);
      else setSummaryError(reply.error);
    });
  }, [open, scope, doc, allCount, summaryAttempt]); // eslint-disable-line react-hooks/exhaustive-deps
  const where = chosen === "current-thread"
    ? tr(`to the thread “${recipient.title ?? recipient.threadId ?? "…"}”`, `в тред «${recipient.title ?? recipient.threadId ?? "…"}»`)
    : tr("to a new thread", "в новый тред");
  // The stage of a long send (> 1 s): the batch is prepared on the machine (its write to .bb-docs comes back as a file
  // hint of this checkout), then the message goes to the thread.
  const [stage, setStage] = useState<"prepare" | "deliver">("prepare");
  const sendingRef = useRef(false);
  useRealtime("review.changed", (payload) => {
    const { root } = (payload ?? {}) as { root?: string };
    if (sendingRef.current && (!root || root === batch?.root)) setStage("deliver");
  });
  const command = useCommand(async () => {
    sendingRef.current = true;
    setStage("prepare");
    try {
      const result = await mutate<{ runId: string; state: string; threadId: string | null; items: number }>("review.batch.send", {
        scope: scope === "document" ? { kind: "document", path: doc } : { kind: "all" },
        recipient: chosen === "current-thread" ? { mode: "current-thread", threadId: recipient.threadId } : { mode: "new-thread", threadId: null },
      }, { retry: () => void command.start(), verb: tr("send to agent", "передать агенту") });
      if (result) {
        notify(result.state === "dispatch-unknown"
          ? tr("Delivery not confirmed. Check the “Agent” tab; it isn't retried automatically.", "Отправка не подтверждена — проверьте во вкладке «Агент»; повтор автоматически не выполняется.")
          : tr(`Sent to agent: ${counted(result.items, W.annotation)}${result.state === "queued" ? " · queued in the thread" : ""}`, `Передано агенту: ${counted(result.items, W.annotation)}${result.state === "queued" ? " · в очереди треда" : ""}`));
        openFixedTab(panel, { surface: { kind: "current" }, tab: agentTab });
      }
    } finally {
      sendingRef.current = false;
    }
  });
  const sending = command.state.running;
  const stageText = stage === "prepare" ? tr("Preparing the batch…", "Готовлю пакет…") : tr("Sending to the thread…", "Отправляю в тред…");
  /** From the menu: it closes at once, the header button carries the command. */
  const send = () => { setOpen(false); void command.start(); };
  if (label) {
    return <Tip label={tr(`This checkout's batch isn't finished yet${allCount ? ` · ${counted(allCount, W.instruction)} ${plural(allCount, WAIT)} for the next one` : ""}`, `Пакет этой рабочей копии ещё не завершён${allCount ? ` · ${counted(allCount, W.instruction)} ${plural(allCount, WAIT)} следующего` : ""}`)}>
      <Button onClick={() => openFixedTab(panel, { surface: { kind: "current" }, tab: agentTab })} aria-label={tr(`Agent: ${label.text}`, `Агент: ${label.text}`)}>
        <Icon name="Bot" />{compact ? null : <span className="dr-trunc" style={{ maxWidth: 220 }}>{tr(`Agent: ${label.text}`, `Агент: ${label.text}`)}</span>}
        {label.tone === "warn" && <span className="dr-dot dr-dot--waiting" aria-hidden />}
      </Button>
    </Tip>;
  }
  // A recipient that is not available (no thread of a previous batch; no bb project for a new thread) never sends.
  const offline = summaryError?.code === "host-unavailable";
  const machine = batch?.machine.name ?? null;
  const available = (chosen === "current-thread" ? Boolean(recipient.threadId) : !isHost) && !offline;
  const disabled = !sending && (!count || !view?.context.writable || !available);
  // Check recipient state while batch status or summary loads; use machine availability for offline.
  const checking: RecipientState = { text: tr("checking", "проверяю"), tone: "checking" };
  const noLink: RecipientState = { text: machine ? tr(`no connection to ${machine}`, `нет связи с ${machine}`) : tr("no connection to the machine", "нет связи с машиной"), tone: "off" };
  const threadRow = offline ? noLink : !batch || (!summary && !summaryError) ? checking : threadState(recipient.status);
  const newRow = offline ? noLink : !summary && !summaryError ? checking : machine ? { text: `${machine} · ${getUi().tree?.branch ?? "—"}`, tone: "ok" as const } : null;
  return <Popover open={open} onOpenChange={setOpen}>
    <span className="dr-split">
      <Tip label={sending && command.state.slow ? stageText : tr(`Scope: ${scope === "document" ? "this document" : "all documents"}; recipient: ${where}`, `Область: ${scope === "document" ? "этот документ" : "все документы"}; получатель: ${where}`)} keys={sending ? undefined : "S"}>
        <Button variant="primary" disabled={disabled} {...busyProps(command.state)} onClick={() => void command.start()} aria-label={tr(`Send to agent: ${count}`, `Передать агенту: ${count}`)} data-send-button>
          <BusyGlyph name="Send" />{compact ? count : tr(`Send to agent · ${count}`, `Передать агенту · ${count}`)}
        </Button>
      </Tip>
      <PopoverTrigger asChild>
        <Button variant="primary" data-send-menu aria-label={tr("Scope, recipient and summary", "Область, получатель и сводка")} aria-expanded={open} aria-disabled={sending || undefined}
          onClick={(event) => { if (sending) event.preventDefault(); }}><Icon name="ChevronDown" /></Button>
      </PopoverTrigger>
      {sending && command.state.slow && <WaitNote className="dr-split__note" data-send-stage>{stageText}</WaitNote>}
    </span>
    <PopoverContent align="end" className="w-[22rem] p-1" mobileTitle={tr("Send to agent", "Передать агенту")}>
      <div className="dr-label">{tr("Scope", "Область")}</div>
      <div role="radiogroup" aria-label={tr("Scope", "Область")}>
        <Choice checked={scope === "document"} onSelect={() => setScope("document")} autoFocus detail={<span className="dr-count">{docCount}</span>}>{tr("This document", "Этот документ")}</Choice>
        <Choice checked={scope === "all"} onSelect={() => setScope("all")} detail={<span className="dr-count">{allCount}</span>}>{tr("All documents", "Все документы")}</Choice>
      </div>
      <div className="dr-sep" />
      <div className="dr-label">{tr("Recipient", "Получатель")}</div>
      <div role="radiogroup" aria-label={tr("Recipient", "Получатель")}>
        <Choice checked={chosen === "current-thread"} disabled={!recipient.threadId || offline} onSelect={() => setMode("current-thread")}
          reason={recipient.threadId ? undefined : recipient.reason ?? tr("No thread of a previous batch", "Нет треда предыдущего пакета")} detail={recipient.threadId ? <RecipientStatus state={threadRow} /> : undefined}>
          {recipient.threadId
            ? lang() === "ru" ? <>В тред «<span className="dr-trunc">{recipient.title ?? recipient.threadId}</span>»</> : <>To the thread “<span className="dr-trunc">{recipient.title ?? recipient.threadId}</span>”</>
            : tr("To the current thread", "В текущий тред")}
        </Choice>
        <Choice checked={chosen === "new-thread"} disabled={isHost || offline} onSelect={() => setMode("new-thread")} detail={isHost ? undefined : <RecipientStatus state={newRow} />}
          reason={isHost ? tr("This checkout has no bb project. Add the folder as a bb project (Projects → Add) to send to a new thread.", "У этой копии нет проекта bb. Добавьте каталог как проект bb (Projects → Add), чтобы отправлять в новый тред.") : undefined}>{tr("To a new thread of this checkout", "В новый тред этой рабочей копии")}</Choice>
      </div>
      <div className="dr-sep" />
      <div className="dr-label">{tr("Summary", "Сводка")}</div>
      <div data-send-summary>
        {!summary && !summaryError && <Skeleton widths={[82, 54]} label={tr("Counting the summary…", "Считаю сводку…")} />}
        {summaryError && <div className="px-2 py-1"><InlineError onRetry={() => setSummaryAttempt((value) => value + 1)}>{tr("Couldn't count the summary", "Сводка не посчитана")}: {explain(summaryError)}</InlineError></div>}
        {summary && <div className="dr-note">{summary.documents.length ? summary.documents.map((entry) => `${middle(entry.path, 40)} · ${entry.count}`).join(", ") : tr("No comments with new instructions", "Нет замечаний с новыми инструкциями")}</div>}
        {summary && summary.hidden > 0 && <div className="dr-warn"><Icon name="TriangleAlert" />{tr("Hidden documents with instructions will go into the batch", "Скрытые документы с инструкциями уйдут в пакет")}: {summary.documents.filter((entry) => entry.hidden).map((entry) => entry.path).join(", ")}</div>}
        {summary && summary.lost > 0 && <div className="dr-warn"><Icon name="TriangleAlert" />{tr(
          `${counted(summary.lost, W.annotation)} lost the exact anchor${summary.documents.some((entry) => entry.missing) ? " (including in deleted documents)" : ""} and will go marked “place unclear”`,
          `${counted(summary.lost, W.annotation)} потеряли точную привязку${summary.documents.some((entry) => entry.missing) ? " (в том числе в удалённых документах)" : ""} — уйдут с пометкой «место неясно»`)}</div>}
        <div className="dr-note">{tr("The agent can reach documents inside the roots; it registers a document outside the batch before editing it; edits outside the batch show up in the round summary.", "Агенту доступны документы внутри корней; документ вне пакета он регистрирует до правки; правки вне пакета покажет итог раунда.")}</div>
      </div>
      <div className="flex justify-end p-1">
        <Button variant="primary" disabled={disabled || sending} onClick={send}><Icon name="Send" />{available ? tr(`Send ${count} ${where}`, `Передать ${count} ${where}`) : tr("Recipient unavailable", "Получатель недоступен")}</Button>
      </div>
    </PopoverContent>
  </Popover>;
}
