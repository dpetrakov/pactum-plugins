// The Comments tab uses a feed with Open, Waiting for you and
// Archive» + the «More» menu and the sort menu; annotations as a feed separated by hairlines, the focused one with the
// rail; quote well, messages of the human and the agent, linked edits, one main action («Accept A» / «Reply E»),
// «Close» and the «⋯» menu; the reply field folded into one line until focus or E. Decisions (DR-04) are unchanged.
import { Markdown } from "@get-bb/plugin-sdk/app";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ViewAnnotation } from "../node/view.ts";
import { useCommand } from "../feedback.ts";
import { acceptMark, decideMark, mutate, resolveConflictMark } from "./actions.ts";
import { Icon } from "./icons.tsx";
import { Badge, BusyGlyph, BusyOverlay, busyProps, Button, CommandButton, Empty, Kbd, Menu, MenuContent, MenuItem, MenuLabel, MenuRadio, MenuRadioGroup, MenuSeparator, MenuTrigger, Segments, Skeleton, Tip } from "./kit.tsx";
import { AGENT_LABEL } from "./labels.ts";
import { revealIndex } from "./reveal.ts";
import { type DraftTarget, draftKey, draftsOf, dropDraft, getUi, notify, saveDraft, setUi, type UiState, useUi } from "./store.ts";
import { VERB, W, counted, when } from "./words.ts";
import { tr } from "../core/i18n.ts";

const ANCHOR_NOTE: Record<string, string> = { approximate: tr("approximate place", "место приблизительно"), ambiguous: tr("ambiguous place, clarify it", "место неоднозначно — уточните"), orphaned: tr("fragment deleted", "фрагмент удалён") };
const MORE: { id: UiState["filter"]; label: string }[] = [{ id: "agent", label: tr("Waiting for agent", "Ждут агента") }, { id: "new", label: tr("New", "Новые") }, { id: "place", label: tr("Clarify place", "Уточнить место") }];
const TARGET: Record<string, string> = { text: tr("on the selection", "к выделенному"), block: tr("on the block", "к блоку"), section: tr("on the section", "к разделу"), document: tr("on the document", "к документу"), change: tr("on the change", "к изменению") };

function matches(annotation: ViewAnnotation, filter: UiState["filter"]): boolean {
  switch (filter) {
    // A status in conflict after a merge (status null) stays in sight until it is resolved (EP-014-T02).
    case "open": return annotation.status === "open" || annotation.conflicts.length > 0;
    case "waiting": return annotation.waiting;
    case "agent": return annotation.status === "open" && annotation.agent === "in-progress";
    case "new": return annotation.status === "open" && annotation.candidate;
    case "place": return annotation.status === "open" && Boolean(ANCHOR_NOTE[annotation.anchor.status]) && !(annotation.anchor.status === "orphaned" && !annotation.tombstoneId && (annotation.latest?.linked.length ?? 0) > 0);
    case "archive": return annotation.status === "closed";
  }
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

/** The reply field: one line «Reply… E» until focus (or E), then the area with ⌘↵. */
function ReplyBox({ annotation }: { annotation: ViewAnnotation }) {
  const ctxKey = useUi((ui) => ui.ctxKey);
  const doc = annotation.path;
  const target: DraftTarget = { kind: "reply", annotationId: annotation.annotationId, quote: "" };
  const key = draftKey(ctxKey, doc, target);
  const [text, setText] = useState(() => draftsOf(ctxKey, doc).find((draft) => draft.key === key)?.text ?? "");
  const [status, setStatus] = useState<"draft" | "saving" | "error">("draft");
  const [open, setOpen] = useState(Boolean(text));
  const ref = useRef<HTMLTextAreaElement>(null);
  const replyFor = useUi((ui) => ui.replyFor);
  // «E» (or a focus request): open the field and put the caret in it once it is rendered; the panel may still be
  // switching tabs, so the focus is retried for a few frames.
  const wantFocus = useRef(false);
  const focusField = () => {
    wantFocus.current = true;
    setOpen(true);
    // bb may move the focus to the panel while it switches tabs: for ~1.5 s the field takes it back, unless the
    // user has meanwhile focused another control.
    let frames = 0;
    const attempt = () => {
      if (!wantFocus.current) return;
      const active = document.activeElement;
      const elsewhere = active && active !== ref.current && active !== document.body && active.matches("input, textarea, select, [contenteditable=true], [role=menuitem], [role=option]");
      if (ref.current && active !== ref.current && !elsewhere) ref.current.focus();
      if (elsewhere || frames++ > 90) { wantFocus.current = false; return; }
      requestAnimationFrame(attempt);
    };
    requestAnimationFrame(attempt);
  };
  useEffect(() => {
    if (replyFor !== annotation.annotationId) return;
    setUi({ replyFor: null });
    focusField();
  }, [replyFor]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!text.trim()) return;
    const timer = setTimeout(() => saveDraft({ key, ctxKey, doc, target, text, noteKind: "action", sha: "", head: null, branch: null, updatedAt: Date.now(), status: "draft" }), 250);
    return () => clearTimeout(timer);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  const closed = annotation.status === "closed";
  // Keep the field read-only while saving. Repeated shortcuts or clicks do not resubmit; preserve text on failure.
  const command = useCommand(async () => {
    if (!text.trim()) return;
    setStatus("saving");
    const result = await mutate("review.reply", { annotationId: annotation.annotationId, text: text.trim(), ...(closed ? { reopen: true } : {}) }, { retry: () => void command.start(), verb: tr("save the reply", "сохранить ответ") });
    if (!result) { setStatus("error"); return; }
    dropDraft(key);
    setText("");
    setStatus("draft");
    setOpen(false);
    notify(annotation.kind === "action" ? tr("Reply saved: a new instruction for the next batch", "Ответ сохранён — это новая инструкция для следующего пакета") : VERB.reply.toast);
  });
  const send = () => command.start();
  const placeholder = closed ? tr("Reopen and reply…", "Возобновить и ответить…") : annotation.kind === "action" ? tr("Reply: a new instruction for the agent…", "Ответить — новая инструкция агенту…") : tr("Reply…", "Ответить…");
  if (!open) return <button type="button" className="dr-reply" onClick={focusField} onFocus={focusField}>
    <Icon name="Reply" /><span>{placeholder}</span><Kbd>E</Kbd>
  </button>;
  return <div className="mt-2">
    <label className="dr-field dr-field--area">
      <textarea ref={ref} value={text} onChange={(event) => setText(event.target.value)} rows={2} aria-label={tr("Reply", "Ответ")} placeholder={placeholder} readOnly={command.state.running}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); }
          if (event.key === "Escape") { event.preventDefault(); wantFocus.current = false; if (!text.trim()) setOpen(false); (event.target as HTMLTextAreaElement).blur(); }
        }}
        onBlur={() => { if (!text.trim()) setOpen(false); }} />
    </label>
    {text.trim() && <div className="mt-1.5 flex items-center gap-2 text-[12px] text-muted-foreground">
      <span aria-live="polite">{status === "saving" ? tr("Saving…", "Сохраняется…") : status === "error" ? tr("Not saved, the text is kept as a draft", "Не сохранено — текст в черновике") : tr("Draft", "Черновик")}</span>
      <Button className="ml-auto" size="sm" variant="primary" {...busyProps(command.state)} onClick={() => void send()}><span className="inline-flex items-center gap-1.5">{closed ? tr("Reopen and reply", "Возобновить и ответить") : VERB.reply.button} <Kbd>⌘↵</Kbd></span><BusyOverlay size={14} /></Button>
    </div>}
  </div>;
}

function MessageEdit({ annotation, messageId, text, onDone }: { annotation: ViewAnnotation; messageId: string; text: string; onDone: () => void }) {
  const [value, setValue] = useState(text);
  const command = useCommand(async () => { if (await mutate("review.revise", { annotationId: annotation.annotationId, messageId, text: value.trim() }, { retry: () => void command.start(), verb: tr("save the edit", "сохранить правку") })) onDone(); });
  const save = () => command.start();
  return <div className="mt-1">
    <label className="dr-field dr-field--area">
      <textarea value={value} onChange={(event) => setValue(event.target.value)} rows={3} aria-label={tr("Edit message", "Править сообщение")} autoFocus readOnly={command.state.running}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
          if (event.key === "Escape" && !command.state.running) onDone();
        }} />
    </label>
    <div className="mt-1.5 flex justify-end gap-1">
      <Button size="sm" variant="ghost" onClick={onDone}>{tr("Cancel", "Отмена")} <Kbd>Esc</Kbd></Button>
      <Button size="sm" variant="primary" {...busyProps(command.state)} onClick={() => void save()}><span className="inline-flex items-center gap-1.5">{tr("Save", "Сохранить")} <Kbd>⌘↵</Kbd></span><BusyOverlay size={14} /></Button>
    </div>
  </div>;
}

function AgentBadge({ annotation }: { annotation: ViewAnnotation }) {
  if (!annotation.agent) return annotation.candidate && annotation.status === "open" ? <Badge>{tr("New", "Новое")}</Badge> : null;
  const label = AGENT_LABEL[annotation.agent] ?? annotation.agent;
  if (annotation.waiting && annotation.agent === "done") return <Badge tone="strong">{tr("Done · waiting for you", "Сделано · ждёт вас")}</Badge>;
  if (annotation.waiting) return <Badge tone="waiting">{label}{tr(" · waiting for you", " · ждёт вас")}</Badge>;
  if (annotation.agent === "in-progress") return <Badge tone="changed">{label}</Badge>;
  return <Badge>{label}</Badge>;
}

function Item({ annotation, focused, focusNonce }: { annotation: ViewAnnotation; focused: boolean; focusNonce: number }) {
  const view = useUi((ui) => ui.view);
  const [editing, setEditing] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ block: "nearest" }); }, [focused, focusNonce]);
  // W-06b (D14): decisions and «Accept» are shown at once and written in the background, with rollback on failure.
  const decide = (action: "close" | "reopen" | "withdraw" | "restore" | "note" | "action") => { void decideMark(annotation, action); };
  const accept = () => { if (view && annotation.latest) void acceptMark(view, annotation); };
  // Send only this and Retry processing become busy immediately and reject duplicate activation.
  const sendOne = async () => {
    const recipient = getUi().batch?.recipient;
    const result = await mutate<{ state: string; items: number }>("review.batch.send", { scope: { kind: "annotation", annotationId: annotation.annotationId },
      recipient: recipient?.mode === "current-thread" ? { mode: "current-thread", threadId: recipient.threadId } : { mode: "new-thread", threadId: null } }, { retry: () => void sendOne(), verb: tr("send to the agent", "передать агенту") });
    if (result) notify(`${VERB.send.toast}${result.state === "queued" ? tr(" · queued in the thread", " · в очереди треда") : ""}`);
  };
  const retryCommand = useCommand(async () => {
    const done = await mutate("review.retry", { annotationId: annotation.annotationId, expectedHeads: annotation.heads }, { retry: () => void retryCommand.start(), verb: tr("retry processing", "повторить обработку") });
    if (done) notify(VERB.retry.toast);
  });
  const showPlace = () => {
    const place = annotation.anchor.place;
    if (place === null || place === undefined) return;
    revealIndex(place, "center");
  };
  // The agent rewrote exactly the quoted text for this annotation (confirmed linked edits): that is the result, not a
  // lost place (found in W-05 dogfooding: «fragment deleted» alarmed on every successful rewrite).
  const rewritten = annotation.anchor.status === "orphaned" && !annotation.tombstoneId && (annotation.latest?.linked.length ?? 0) > 0;
  const attention = rewritten ? null : ANCHOR_NOTE[annotation.anchor.status];
  const open = annotation.status === "open";
  const canRetry = open && annotation.kind === "action" && annotation.latest && !annotation.candidate && annotation.agent !== "in-progress";
  const ELEMENT: Record<string, string> = { node: tr("on the node", "к узлу"), edge: tr("on the connection", "к связи"), group: tr("on the group", "к группе"), text: tr("on the text", "к тексту"), other: tr("on the element", "к элементу") };
  const targetLabel = annotation.element ? tr(`${ELEMENT[annotation.element.kind] ?? ELEMENT.other} “${annotation.element.label}” of the diagram`, `${ELEMENT[annotation.element.kind] ?? ELEMENT.other} «${annotation.element.label}» схемы`)
    : annotation.targetKind === "change" && annotation.tombstoneId ? tr("on a deleted block", "к удалённому блоку") : TARGET[annotation.targetKind] ?? annotation.targetKind;
  const created = annotation.messages[annotation.messages.length - 1]?.timestamp ?? annotation.created;
  return <article ref={ref} className={`dr-cmt${focused ? " dr-cmt--focus" : ""}${open ? "" : " dr-cmt--done"}`} aria-current={focused || undefined}
    aria-label={tr(`Comment ${targetLabel}: ${(annotation.messages[0]?.text ?? "").slice(0, 80)}`, `Замечание ${targetLabel}: ${(annotation.messages[0]?.text ?? "").slice(0, 80)}`)}
    onClick={() => { setUi({ focusAnnotation: annotation.annotationId }); showPlace(); }}>
    <div className="dr-cmt__top">
      <span className="dr-cmt__kind"><Icon name={annotation.kind === "action" ? "Bot" : "StickyNote"} />{annotation.kind === "action" ? tr("For agent", "Для агента") : tr("Note", "Заметка")}</span>
      <AgentBadge annotation={annotation} />
      {annotation.status === "closed" && <Badge tone="quiet">{tr("Closed", "Закрыто")}</Badge>}
      {annotation.status === "withdrawn" && <Badge tone="quiet">{tr("Withdrawn", "Отозвано")}</Badge>}
      {annotation.status === null && <Badge tone="removed">{tr("Status in conflict", "Статус в конфликте")}</Badge>}
      {rewritten && <Badge tone="quiet" title={tr("The original fragment was replaced by the agent's edit for this comment", "Исходный фрагмент заменён правкой агента по этому замечанию")}>{tr("text rewritten per comment", "текст переписан по замечанию")}</Badge>}
      {attention && open && <Badge tone="removed">{attention}</Badge>}
      <span className="dr-trunc">{targetLabel}</span>
      <time className="dr-cmt__time" dateTime={created}>{when(created)}</time>
    </div>
    {annotation.quote.exact && annotation.targetKind !== "document" && <div className={`dr-quote${annotation.tombstoneId ? " dr-quote--removed" : ""}`}>{annotation.quote.exact}</div>}
    {annotation.conflicts.length > 0 && <div className="dr-conflict" role="alert">
      <div className="dr-conflict__head"><Icon name="GitMerge" />{tr("Conflict after a branch merge: choose a value", "Конфликт после слияния веток — выберите значение")}</div>
      {annotation.conflicts.map((conflict) => <div key={conflict.register} className="flex flex-wrap gap-1">
        {[...new Set(conflict.candidates.map((candidate) => candidate.value))].map((value) => <Button key={value} size="sm" onClick={(event) => { event.stopPropagation(); void resolveConflictMark(annotation, conflict.register, value); }}>
          {/(^|#)status$/.test(conflict.register) ? ({ open: tr("Open", "Открыто"), closed: tr("Closed", "Закрыто"), withdrawn: tr("Withdrawn", "Отозвано") } as Record<string, string>)[value] ?? value : /(^|#)kind$/.test(conflict.register) ? (value === "action" ? tr("For agent", "Для агента") : tr("Note", "Заметка")) : tr(`Revision ${value.slice(0, 8)}`, `Редакция ${value.slice(0, 8)}`)}
        </Button>)}
      </div>)}
    </div>}
    {annotation.messages.map((message) => <div key={message.messageId} className={`dr-msg${message.role === "agent" ? " dr-msg--agent" : ""}`}>
      <div className="dr-msg__who">
        {message.role === "agent" ? <><Icon name="Bot" /><b>{tr("Agent", "Агент")}</b><span>· {message.model}{message.requestedBy ? tr(` · batch requested by ${message.requestedBy}`, ` · по пакету от ${message.requestedBy}`) : ""}</span></>
          : <><span className="dr-ava" aria-hidden>{initials(message.author)}</span><b title={message.email ?? undefined}>{message.author}</b></>}
        <span>· {when(message.timestamp)}</span>
        {message.revisions > 1 && <span title={tr("Has earlier revisions", "Есть прежние редакции")}>{tr("· edited", "· изменено")}</span>}
        {message.resultStatus && <span>· {AGENT_LABEL[message.resultStatus] ?? message.resultStatus}</span>}
        {message.role === "human" && open && editing !== message.messageId && <button type="button" className="dr-link ml-auto" onClick={(event) => { event.stopPropagation(); setEditing(message.messageId); }}>{tr("Edit", "Править")}</button>}
      </div>
      {editing === message.messageId ? <MessageEdit annotation={annotation} messageId={message.messageId} text={message.text ?? ""} onDone={() => setEditing(null)} />
        : message.conflict ? <div className="dr-msg__body">{tr("Two parallel edits of the message: choose one above.", "Две параллельные правки сообщения — выберите одну выше.")}</div>
        : <div className="dr-msg__body"><Markdown content={message.text ?? ""} /></div>}
    </div>)}
    {annotation.latest && <div className="dr-linked">
      {annotation.latest.linked.length ? <>{tr("Linked edits: ", "Связанные правки: ")}{counted(annotation.latest.linked.length, W.block)}{tr(" in this document · ", " в этом документе · ")}<button type="button" className="dr-link" onClick={(event) => { event.stopPropagation(); revealIndex(annotation.latest!.linked[0].block, "center"); }}>{tr("Show", "Показать")}</button></> : tr("No linked edits confirmed by the text", "Связанных правок, подтверждённых текстом, нет")}
      {annotation.latest.linkedChanged ? tr(` · ${annotation.latest.linkedChanged} already changed`, ` · ${annotation.latest.linkedChanged} уже изменились`) : ""}
      {annotation.latest.linkedElsewhere.map((entry) => tr(` · ${entry.count} in ${entry.path ?? "another document"}`, ` · ${entry.count} в ${entry.path ?? "другом документе"}`)).join("")}
    </div>}
    {annotation.newInstructions > 0 && open && annotation.kind === "action" && <div className="dr-linked">{tr("New instructions waiting to be sent", "Новые инструкции ждут отправки")}</div>}
    <div className="dr-cmt__acts" onClick={(event) => event.stopPropagation()}>
      {open && annotation.waiting && annotation.latest && <Tip label={tr("Close and mark linked edits read", "Закрыть и отметить связанные правки прочитанными")} keys="A"><Button size="sm" variant="primary" onClick={() => void accept()}><Icon name="CheckCheck" />{VERB.accept.button} <Kbd>A</Kbd></Button></Tip>}
      {open && annotation.candidate && <CommandButton size="sm" icon="Send" run={sendOne} data-send-one>{VERB.sendOne.button}</CommandButton>}
      {open && <Button size="sm" onClick={() => void decide("close")}>{VERB.close.button}</Button>}
      {annotation.status === "closed" && <Button size="sm" onClick={() => void decide("reopen")}>{VERB.reopen.button}</Button>}
      {annotation.status === "withdrawn" && <Button size="sm" onClick={() => void decide("restore")}>{VERB.restore.button}</Button>}
      {annotation.status !== "withdrawn" && <Menu>
        <Tip label={retryCommand.state.running ? tr("Retrying processing…", "Повторяю обработку…") : tr("More", "Ещё")}><MenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={tr("More actions", "Ещё действия")} {...busyProps(retryCommand.state)}><BusyGlyph name="Ellipsis" size={14} /></Button></MenuTrigger></Tip>
        <MenuContent align="start" mobileTitle={tr("Comment", "Замечание")}>
          <MenuItem onSelect={() => void decide(annotation.kind === "action" ? "note" : "action")}><Icon name={annotation.kind === "action" ? "StickyNote" : "Bot"} />{annotation.kind === "action" ? VERB.toNote.button : VERB.toAgent.button}</MenuItem>
          {canRetry && <MenuItem disabled={retryCommand.state.running} onSelect={() => void retryCommand.start()}><Icon name="RefreshCw" />{VERB.retry.button}</MenuItem>}
          {open && !annotation.dispatched && <MenuItem onSelect={() => void decide("withdraw")} title={tr("Delete the unsent comment, with a quick undo", "Удалить неотправленное замечание — с быстрой отменой")}><Icon name="Trash2" />{VERB.withdraw.button}</MenuItem>}
          {annotation.anchor.place !== null && <><MenuSeparator /><MenuItem onSelect={showPlace}><Icon name="MoveRight" />{tr("Show in document", "Показать в документе")}</MenuItem></>}
        </MenuContent>
      </Menu>}
    </div>
    {annotation.status !== "withdrawn" && <ReplyBox annotation={annotation} />}
  </article>;
}

export function CommentsTab() {
  const liveView = useUi((ui) => ui.view);
  const routeDoc = useUi((ui) => (ui.route.kind === "none" ? null : ui.route.doc));
  const phase = useUi((ui) => ui.viewPhase);
  const viewError = useUi((ui) => ui.viewError);
  // Keep the last complete comment feed while another document or its review state loads;
  // dimmed, with the rail on the seam — and is replaced once, when the new full view arrives. Swapping the feed for a
  // skeleton and back rebuilt the panel twice per switch, and every rebuild restyled the whole bb panel (bb's own
  // :has() rule on the panel container) — document switching was 0.3–0.5 s slower (measured). A skeleton only when
  // there is nothing to show yet.
  const liveDoc = liveView?.document.path ?? null;
  const waiting = Boolean(routeDoc) && !viewError && (liveDoc !== routeDoc || phase === "text");
  const lastFull = useRef<typeof liveView>(null);
  if (liveView && !waiting && phase === "full") lastFull.current = liveView;
  const view = waiting ? lastFull.current : liveView;
  const filter = useUi((ui) => ui.filter);
  const focus = useUi((ui) => ui.focusAnnotation);
  const focusNonce = useUi((ui) => ui.focusNonce);
  const [order, setOrder] = useState<"place" | "activity">("place");
  const list = useMemo(() => {
    const items = (view?.annotations ?? []).filter((annotation) => matches(annotation, filter));
    const place = (annotation: ViewAnnotation) => annotation.anchor.place ?? (annotation.targetKind === "document" ? -1 : 1e9);
    const activity = (annotation: ViewAnnotation) => annotation.messages[annotation.messages.length - 1]?.timestamp ?? annotation.created;
    return items.sort((a, b) => order === "place" ? place(a) - place(b) : activity(a) < activity(b) ? 1 : -1);
  }, [view, filter, order]);
  // do not show a false empty document, empty comments list or zero counters while loading. Cached annotations
  // with the rail on the seam.
  if (waiting && !view) return <div className="dr-panel" data-dr data-comments data-comments-loading>
    <div className="dr-cm-head" data-fb-seam-busy=""><Skeleton widths={[46]} label={tr("Loading comments…", "Загружаю замечания…")} /></div>
    <div className="dr-cm-list" aria-busy="true">{[0, 1, 2].map((index) => <div key={index} className="dr-cmt"><Skeleton widths={[38, 92, 74, 56]} label={tr("Loading comments…", "Загружаю замечания…")} /></div>)}</div>
  </div>;
  if (!view) return <div className="dr-panel" data-dr><Empty icon="FileText" title={tr("No document open", "Документ не открыт")}>{tr("Open a document on the “Documents” screen to see its comments here.", "Откройте документ на экране «Документы» — здесь появятся его замечания.")}</Empty></div>;
  const count = (id: UiState["filter"]) => view.annotations.filter((annotation) => matches(annotation, id)).length;
  const segment = filter === "open" || filter === "waiting" || filter === "archive" ? filter : null;
  const more = MORE.find((entry) => entry.id === filter);
  const sortLabel = order === "place" ? tr("Sort: by place", "Сортировка: по месту") : tr("Sort: by activity", "Сортировка: по активности");
  const empty = filter === "archive" ? tr("The archive is empty.", "Архив пуст.") : filter === "waiting" ? tr("No agent replies waiting for a decision.", "Ответов агента, ждущих решения, нет.") : filter === "open" ? tr("No comments.", "Замечаний нет.") : tr(`Nothing in “${more?.label}”.`, `«${more?.label}» — пусто.`);
  return <div className="dr-panel" data-dr data-comments data-comments-loading={waiting || undefined}>
    <div className="dr-cm-head" data-fb-seam-busy={waiting || phase === "cached" ? "" : undefined}>
      <Segments value={(segment ?? "") as "open" | "waiting" | "archive"} onChange={(next) => setUi({ filter: next })} label={tr("Comment filter", "Фильтр замечаний")} items={[
        { value: "open", label: <>{tr("Open", "Открытые")} <span className="dr-count">{count("open")}</span></>, aria: tr(`Open: ${count("open")}`, `Открытые: ${count("open")}`) },
        { value: "waiting", label: <>{tr("Waiting for you", "Ждут вас")} <span className="dr-count">{count("waiting")}</span></>, aria: tr(`Waiting for you: ${count("waiting")}`, `Ждут вас: ${count("waiting")}`) },
        { value: "archive", label: tr("Archive", "Архив") },
      ]} />
      <span className="dr-grow" />
      <Menu>
        <Tip label={tr("Waiting for agent, new, clarify place", "Ждут агента, новые, уточнить место")}><MenuTrigger asChild><Button size="sm" variant="ghost" aria-pressed={Boolean(more)}><Icon name="ListFilter" />{more ? more.label : tr("More", "Ещё")}</Button></MenuTrigger></Tip>
        <MenuContent align="end" mobileTitle={tr("Filter", "Фильтр")}>
          <MenuLabel>{tr("Show", "Показать")}</MenuLabel>
          <MenuRadioGroup value={filter} onValueChange={(next) => setUi({ filter: next as UiState["filter"] })}>
            {MORE.map((entry) => <MenuRadio key={entry.id} value={entry.id}>{entry.label}<span className="ml-auto pl-3 text-[11px] text-muted-foreground tabular-nums">{count(entry.id)}</span></MenuRadio>)}
          </MenuRadioGroup>
          {more && <><MenuSeparator /><MenuItem onSelect={() => setUi({ filter: "open" })}><Icon name="X" />{tr("Reset filter", "Сбросить фильтр")}</MenuItem></>}
        </MenuContent>
      </Menu>
      <Menu>
        <Tip label={sortLabel}><MenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={sortLabel}><Icon name="ArrowUpDown" /></Button></MenuTrigger></Tip>
        <MenuContent align="end" mobileTitle={tr("Sort", "Сортировка")}>
          <MenuRadioGroup value={order} onValueChange={(next) => setOrder(next as "place" | "activity")}>
            <MenuRadio value="place">{tr("By place in document", "По месту в документе")}</MenuRadio>
            <MenuRadio value="activity">{tr("By activity", "По активности")}</MenuRadio>
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
    </div>
    <div className="dr-cm-list" role="feed" aria-label={tr("Comments", "Замечания")} aria-busy={waiting} data-fb-dim={waiting || undefined}>
      {list.map((annotation) => <Item key={annotation.annotationId} annotation={annotation} focused={annotation.annotationId === focus} focusNonce={focusNonce} />)}
      {!list.length && <Empty icon="MessageSquare" title={empty}>{filter === "open" || filter === "waiting" ? <>{tr("Select text in the document and press ", "Выделите текст в документе и нажмите ")}<Kbd>C</Kbd>.</> : null}</Empty>}
    </div>
    <span className="dr-sr" aria-live="polite">{counted(list.length, W.annotation)}</span>
  </div>;
}

