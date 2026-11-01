// «Agent» tab (EP-009-T05; design W-06 EP-021-T03): the batch without nested frames — state badge, «Agent: k of n», the
// progress rail, «Waiting for you in the thread» with «Open thread», the unconfirmed dispatch with explicit actions (AC11), cancel of
// a queued batch, «Remind agent», the items with their states, «Last round» with «Review» (the pass over the
// result, E16) and «Round history» as a collapsible section; the thread's chat below.
import { ThreadChat, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { type CommandState, useCommand } from "../feedback.ts";
import { call, chooseDocument, explain, loadBatch, mutate } from "./actions.ts";
import { revealLineLater } from "./code.tsx";
import { formatOf } from "../core/formats/registry.ts";
import { subPathOf } from "./route.ts";
import { PANEL_PATH } from "./tree.tsx";
import { setViewMode } from "./viewmode.ts";
import { Icon } from "./icons.tsx";
import { Badge, Banner, BusyOverlay, busyProps, Button, Empty, InlineError, SkeletonRows, Tip, WaitNote } from "./kit.tsx";
import { batchLabel } from "./labels.ts";
import { getUi, notify, setUi, useUi } from "./store.ts";
import { forms, lang, tr } from "../core/i18n.ts";
import { VERB, W, counted, fullDate, num, plural } from "./words.ts";

type Summary = { runId: string; outcome: string | null; counts: Record<string, number>; changedBlocks: number; documents: { path: string; inBatch: boolean; changedBlocks: number }[]; outside: string[]; items: { annotationId: string; status: string | null; linked: number; claimed: number }[];
  /** W-06c (§10): structured files of the round that do not parse now (from the current file; fixed — gone). */
  parseErrors?: { path: string; line: number; message: string }[] };

const COUNT_LABEL: [string, string][] = [["done", tr("done", "сделано")], ["needs-input", tr("need input", "нужен ответ")], ["failed", tr("failed", "не удалось")], ["skipped", tr("skipped", "пропущено")], ["missing", tr("no reply", "без ответа")]];
const OUTCOME: Record<string, string> = { completed: tr("Completed", "Завершён"), partial: tr("Partially completed", "Завершён частично"), failed: tr("Failed", "Ошибка"), cancelled: tr("Cancelled", "Отменён") };
const ITEM: Record<string, string> = { done: tr("Done", "Сделано"), "needs-input": tr("Needs input", "Нужен ответ"), failed: tr("Failed", "Не удалось"), skipped: tr("Skipped", "Пропущено") };
/** Choose the count-dependent verb for waiting instructions. */
const WAIT = forms(["is waiting", "are waiting"], ["ждёт", "ждут", "ждут"]);

/** The document at a line of “Raw” on the «Documents» screen (a parse error of the round). */
function useOpenLine() {
  const navigate = useBbNavigate();
  return (path: string, line: number) => {
    const { route } = getUi();
    if (route.kind === "none") return;
    const format = formatOf(path);
    if (format) setViewMode(format, "raw");
    revealLineLater(path, line);
    const next = { ...route, doc: path };
    chooseDocument(next);
    navigate.toPluginPanel(PANEL_PATH, { subPath: subPathOf(next) });
  };
}

function RoundSummary({ runId }: { runId: string }) {
  const openLine = useOpenLine();
  const target = useUi((ui) => ui.target);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setError(null);
    void call<Summary>("review.round", { target, runId }).then((reply) => {
      if (!current) return;
      if (reply.ok) setSummary((reply as unknown as { result: Summary }).result);
      else setError(explain(reply.error));
    });
    return () => { current = false; };
  }, [runId, target, attempt]);
  // Show an inline error with Retry instead of an endless skeleton.
  if (error && !summary) return <InlineError onRetry={() => setAttempt((value) => value + 1)}>{tr("Couldn't load the round summary", "Итог раунда не загружен")}: {error}</InlineError>;
  if (!summary) return <div className="dr-skel" style={{ width: "60%" }} />;
  const counts = COUNT_LABEL.filter(([key]) => summary.counts[key]).map(([key, label]) => `${num(summary.counts[key])} ${label}`).join(" · ");
  const docs = summary.documents.filter((doc) => doc.changedBlocks > 0);
  return <div className="flex flex-col gap-1.5">
    <div className="flex flex-wrap items-center gap-1.5"><Badge tone={summary.outcome === "completed" ? "added" : summary.outcome === "failed" ? "removed" : undefined}>{OUTCOME[summary.outcome ?? ""] ?? tr("Round", "Раунд")}</Badge><span>{counts || tr("no results", "нет результатов")}</span></div>
    <div className="dr-meta">{tr(`Changed ${counted(summary.changedBlocks, W.block)} in ${counted(docs.length, W.document)}`, `Изменено ${counted(summary.changedBlocks, W.block)} в ${counted(docs.length, W.document)}`)}{docs.length ? `: ${docs.map((doc) => `${doc.path.split("/").pop()} (${doc.changedBlocks})`).join(", ")}` : ""}</div>
    {summary.outside.length > 0 && <div className="dr-warn" style={{ padding: 0 }}><Icon name="TriangleAlert" />{tr("Edits outside the batch documents", "Правки вне документов пакета")}: {summary.outside.join(", ")}</div>}
    {(summary.parseErrors ?? []).map((entry) => <div key={entry.path} className="dr-warn" style={{ padding: 0 }} data-round-parse-error>
      <Icon name="FileWarning" /><span>{lang() === "ru"
        ? <>После правок агента <b>{entry.path}</b> не разбирается: строка {entry.line} — {entry.message.slice(0, 120)}</>
        : <><b>{entry.path}</b> doesn't parse after the agent's edits (line {entry.line}): {entry.message.slice(0, 120)}</>}</span>
      <Button size="sm" variant="ghost" onClick={() => openLine(entry.path, entry.line)}>{tr(`Go to line ${entry.line}`, `К строке ${entry.line}`)}</Button>
    </div>)}
    <div><Tip label={tr("Walk through all results of the round", "Проход «Всё» по результату раунда")}><Button size="sm" variant="primary" onClick={() => setUi({ passMode: "all", passKey: null, passNonce: getUi().passNonce + 1 })}><Icon name="Play" />{tr("Review", "Просмотреть")}</Button></Tip></div>
  </div>;
}

/** A batch card runs one command at a time; only the pressed button shows the busy indicator. */
function CardButton({ id, pressed, state, onRun, children, variant, slow, hint }: { id: string; pressed: string | null; state: CommandState; onRun: (id: string) => void; children: React.ReactNode; variant?: "danger" | "ghost"; slow?: string; hint?: string }) {
  const mine = pressed === id;
  const props = mine ? busyProps(state) : state.running ? { "aria-disabled": true as const } : {};
  const button = <Button size="sm" variant={variant} {...props} onClick={() => { if (!state.running) onRun(id); }} data-agent-action={id}><span>{children}</span><BusyOverlay size={14} /></Button>;
  return <>
    {hint ? <Tip label={hint}>{button}</Tip> : button}
    {mine && state.slow && slow && <WaitNote>{slow}</WaitNote>}
  </>;
}

function StatusCard() {
  const batch = useUi((ui) => ui.batch);
  const batchError = useUi((ui) => ui.batchError);
  const navigate = useBbNavigate();
  const [pressed, setPressed] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => { if (getUi().batch?.active) void loadBatch(); }, 5000);
    return () => clearInterval(timer);
  }, []);
  const command = useCommand(async (_signal, method: string, input: Record<string, unknown>, done: string) => {
    const result = await mutate<Record<string, unknown>>(method, input, { withContext: false, retry: () => void command.start(method, input, done) });
    if (result) notify(done);
    return result;
  });
  const retryLoad = useCommand(async () => { await loadBatch(); });
  // First load uses a skeleton; failures replace it with an inline error and Retry.
  if (!batch) return <div className="dr-agent" data-dr>
    {batchError ? <InlineError onRetry={() => void retryLoad.start()}>{tr("Couldn't load the batch state", "Состояние пакета не загружено")}: {explain(batchError)}</InlineError> : <SkeletonRows count={4} row={24} />}
  </div>;
  const active = batch.active;
  const label = batchLabel(batch);
  const run = (id: string, method: string, input: Record<string, unknown>, done: string) => {
    setPressed(id);
    return command.start(method, input, done);
  };
  const state = command.state;
  const threadId = batch.thread?.threadId ?? batch.lastThreadId;
  const recent = batch.recent[0];
  return <div className="dr-agent" data-dr data-agent>
    {active ? <section aria-label={tr("Batch for agent", "Пакет агенту")} className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={label?.tone === "warn" ? "waiting" : "strong"}>{label?.text}</Badge>
        {batch.local && <Badge tone="quiet" title={tr("Batch of files outside Git: its log stays on this machine only, nothing goes to .bb-docs", "Пакет по файлам вне Git: журнал только на этой машине, в .bb-docs ничего")}>{tr("local batch", "локальный пакет")}</Badge>}
        <span className="text-muted-foreground">{tr("Agent:", "Агент:")} <b className="text-foreground tabular-nums">{num(active.answered)}</b> {tr("of", "из")} {num(active.total)}</span>
        {batch.thread?.title && <span className="dr-trunc dr-meta">· {batch.thread.title}</span>}
      </div>
      <div className="dr-progress" role="progressbar" aria-label={tr("Agent replies", "Ответы агента")} aria-valuemin={0} aria-valuemax={active.total} aria-valuenow={active.answered}>
        <span style={{ width: `${active.total ? (active.answered / active.total) * 100 : 0}%` }} />
      </div>
      {batch.thread?.waitingUser && <Banner icon="Hand" tone="warn" role="status" actions={<Button size="sm" variant="primary" onClick={() => navigate.toThread(batch.thread!.threadId)}>{tr("Open thread", "Открыть тред")}</Button>}>
        {tr("Waiting for you in the thread", "Ждёт вас в треде")}: {batch.thread.interactions.join(", ") || tr("a question or a permission", "вопрос или разрешение")}
      </Banner>}
      {batch.launch?.state === "dispatch-unknown" && <Banner icon="TriangleAlert" tone="error" role="alert" actions={<div className="flex w-full flex-wrap gap-1">
        <CardButton id="check" pressed={pressed} state={state} onRun={async (id) => { const result = await run(id, "review.batch.recover", { runId: active.runId, action: "check" }, tr("Checked", "Проверено")); if (result && !(result as { found?: boolean }).found) notify(tr("The batch message wasn't found in bb. You can send it again or cancel the batch.", "Сообщение пакета в bb не найдено. Можно отправить снова или отменить пакет.")); }}>{tr("Check", "Проверить")}</CardButton>
        <CardButton id="resend" pressed={pressed} state={state} onRun={(id) => void run(id, "review.batch.recover", { runId: active.runId, action: "resend" }, tr("Sent again as a new attempt", "Отправлено снова — новая попытка"))}>{tr("Send again", "Отправить снова")}</CardButton>
        <CardButton id="cancel" pressed={pressed} state={state} variant="danger" onRun={(id) => void run(id, "review.batch.recover", { runId: active.runId, action: "cancel" }, tr("Batch cancelled", "Пакет отменён"))}>{tr("Cancel batch", "Отменить пакет")}</CardButton>
      </div>}>
        {tr(`Delivery not confirmed${batch.launch.reason ? `: ${batch.launch.reason}` : ""}. No second run is started automatically.`, `Отправка не подтверждена${batch.launch.reason ? `: ${batch.launch.reason}` : ""}. Второй исполнитель автоматически не создаётся.`)}
      </Banner>}
      {batch.thread && !batch.thread.exists && <Banner icon="WifiOff" tone="warn" role="status">{tr("The batch thread is unavailable: it was deleted or the machine is unreachable.", "Тред пакета недоступен — его удалили или нет связи с машиной.")}</Banner>}
      <div className="flex flex-wrap gap-1">
        {batch.thread?.queued && <CardButton id="unqueue" pressed={pressed} state={state} variant="danger" onRun={(id) => void run(id, "review.batch.recover", { runId: active.runId, action: "cancel" }, tr("Batch removed from the queue and cancelled", "Пакет снят с очереди и отменён"))}>{tr("Remove from queue", "Снять с очереди")}</CardButton>}
        {batch.thread && !batch.thread.queued && batch.thread.status === "idle" && active.answered < active.total && <CardButton id="remind" pressed={pressed} state={state} onRun={(id) => void run(id, "review.batch.remind", { runId: active.runId }, tr("Reminder sent", "Напоминание отправлено"))}>{tr("Remind agent", "Напомнить агенту")}</CardButton>}
        {active.attempts.length > 0 && batch.launch?.state !== "dispatch-unknown" && (!batch.thread || !batch.thread.exists || batch.thread.status === "idle" || batch.thread.status === "error") && !batch.thread?.queued &&
          <CardButton id="finish" pressed={pressed} state={state} variant="ghost" hint={tr("The agent won't finish the batch: finish it now, partially", "Агент не завершит пакет: завершить его сейчас частично")} slow={tr("Finishing the batch: returning unanswered items to new instructions…", "Завершаю пакет: возвращаю пункты без ответа в новые инструкции…")} onRun={(id) => void run(id, "review.batch.recover", { runId: active.runId, action: "finish" }, tr("Batch finished manually; unanswered items return to new instructions", "Пакет завершён вручную; пункты без ответа вернутся в новые инструкции"))}>{tr("Finish batch", "Завершить пакет")}</CardButton>}
      </div>
      <ul className="dr-items" aria-label={tr("Batch items", "Пункты пакета")}>
        {active.items.map((item) => {
          const annotation = getUi().view?.annotations.find((entry) => entry.annotationId === item.annotationId);
          return <li key={item.itemId}><span className="text-muted-foreground">{item.status ? ITEM[item.status] ?? item.status : tr("In progress", "В работе")}</span>
            <span className="dr-trunc">{annotation?.messages[0]?.text ?? item.annotationId}</span></li>;
        })}
      </ul>
    </section> : <Empty icon="Bot" title={tr("No active batch", "Активного пакета нет")}>{batch.newInstructions.all
      ? tr(`${counted(batch.newInstructions.all, W.instruction)} ${plural(batch.newInstructions.all, WAIT)} to be sent. Use “${VERB.send.button}” in the document header.`, `${counted(batch.newInstructions.all, W.instruction)} ${plural(batch.newInstructions.all, WAIT)} отправки — «${VERB.send.button}» в хедере документа.`)
      : tr("No new instructions.", "Новых инструкций нет.")}</Empty>}
    {recent && <details className="dr-section" open>
      <summary><Icon name="ChevronRight" />{tr("Last round", "Последний раунд")} · {fullDate(recent.preparedAt)}</summary>
      <RoundSummary runId={recent.runId} />
    </details>}
    {batch.recent.length > 1 && <details className="dr-section">
      <summary><Icon name="ChevronRight" />{tr("Round history", "История раундов")} · {num(batch.recent.length)}</summary>
      <ul className="dr-items">{batch.recent.map((entry) => <li key={entry.runId}><span className="text-muted-foreground tabular-nums">{fullDate(entry.preparedAt)}</span>
        <span className="dr-trunc">{OUTCOME[entry.finished?.outcome ?? ""] ?? "—"} · {tr(`${num(entry.counts.done ?? 0)} of ${num(entry.total)} done`, `${num(entry.counts.done ?? 0)} из ${num(entry.total)} сделано`)} · {entry.documents.map((path) => path.split("/").pop()).join(", ")}</span></li>)}</ul>
    </details>}
    {threadId && <div className="dr-meta">{tr("Batch thread:", "Тред пакета:")} <button type="button" className="dr-link" onClick={() => navigate.toThread(threadId)}>{batch.thread?.title ?? threadId}</button></div>}
  </div>;
}

export function AgentTab() {
  const batch = useUi((ui) => ui.batch);
  const threadId = batch?.thread?.threadId ?? batch?.lastThreadId ?? null;
  if (!batch && !getUi().target) return <div className="dr-panel" data-dr><Empty icon="FileText" title={tr("No document open", "Документ не открыт")}>{tr("Open a document on the “Documents” screen to see the state of the agent batch here.", "Откройте документ на экране «Документы» — здесь появится состояние пакета агенту.")}</Empty></div>;
  if (!threadId) return <div className="dr-panel overflow-y-auto" data-dr><StatusCard /></div>;
  // Pin the batch card above the conversation so it remains visible even when bb cannot
  // show the thread (removed or unavailable), where the chat would render only its error.
  return <div className="dr-panel" data-dr>
    <div className="max-h-[55%] shrink-0 overflow-y-auto"><StatusCard /></div>
    <ThreadChat threadId={threadId} variant="compact" layout="contained" className="min-h-0 flex-1" />
  </div>;
}
