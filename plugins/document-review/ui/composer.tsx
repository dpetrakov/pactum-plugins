// The composer of an annotation at the selection, a block, a section, a change or the document (B7, B8, DR-03; design
// The composer is a popover beside its target, with a quoted excerpt, field, For agent/Note choice,
// «Collapse Esc» and «Save ⌘↵». The draft is kept while typing and on close (B8).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { composerTop } from "./composer-position.ts";
import { chromeOf, focusWithoutScroll } from "./reveal.ts";
import { call, explain, refresh } from "./actions.ts";
import { Icon } from "./icons.tsx";
import { useCommand } from "../feedback.ts";
import { BusyOverlay, busyProps, Button, Kbd, Segments } from "./kit.tsx";
import { type Draft, type DraftTarget, draftKey, draftsOf, dropDraft, getUi, notify, saveDraft, setUi, useUi } from "./store.ts";
import { tr } from "../core/i18n.ts";

export interface ComposerState {
  target: DraftTarget;
  anchor: { top: number; left: number };
  sha: string;
  initial?: string;
  returnFocus?: Element | null;
  fallbackFocus?: HTMLElement | null;
}

/** Select and type: buffer keys between the first printable key and field focus, then hand the buffer to the mounted field so fast typing loses nothing. */
export const typing = { active: false, buffer: "" };

const LABELS: Record<string, string> = { text: tr("on the selection", "к выделенному"), block: tr("on the block", "к блоку"), section: tr("on the section", "к разделу"), document: tr("on the document", "к документу"), change: tr("on the change", "к изменению") };

export function Composer({ state, doc, onClose }: { state: ComposerState; doc: string; onClose: () => void }) {
  const ctxKey = useUi((ui) => ui.ctxKey);
  const view = useUi((ui) => ui.view);
  const key = draftKey(ctxKey, doc, state.target);
  const existing = useMemo(() => draftsOf(ctxKey, doc).find((draft) => draft.key === key), [ctxKey, doc, key]);
  const [text, setText] = useState(existing?.text ?? state.initial ?? "");
  const [kind, setKind] = useState<"action" | "note">(existing?.noteKind ?? "action");
  const [status, setStatus] = useState<"draft" | "saving" | "error">("draft");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Element | null>(state.returnFocus ?? (typeof document !== "undefined" ? document.activeElement : null));
  useLayoutEffect(() => {
    const element = overlay.current;
    const scroll = element?.closest<HTMLElement>("[data-dr-scroll]");
    const parent = element?.offsetParent;
    if (!element || !scroll || !parent) return;
    const origin = parent.getBoundingClientRect().top;
    const viewport = scroll.getBoundingClientRect();
    const chrome = chromeOf(scroll);
    element.style.top = `${composerTop(origin, { top: viewport.top + chrome.header, bottom: viewport.bottom - chrome.footer }, origin + state.anchor.top, element.offsetHeight)}px`;
  }, [state.anchor.top]);
  useEffect(() => {
    if (typing.active) {
      const extra = typing.buffer;
      typing.active = false;
      typing.buffer = "";
      if (extra) setText((current) => current + extra);
    }
    ref.current?.focus({ preventScroll: true });
    const length = ref.current?.value.length ?? 0;
    ref.current?.setSelectionRange(length, length);
  }, []);
  useEffect(() => { const length = ref.current?.value.length ?? 0; ref.current?.setSelectionRange(length, length); }, [text === ""]); // eslint-disable-line react-hooks/exhaustive-deps
  const latest = useRef<Draft | null>(null);
  const saved = useRef(false);
  useEffect(() => {
    if (!text.trim()) { latest.current = null; return; }
    const draft: Draft = { key, ctxKey, doc, target: state.target, text, noteKind: kind, sha: existing?.sha ?? state.sha, head: view?.context.head ?? null, branch: view?.context.branch ?? null, updatedAt: Date.now(), status: "draft" };
    latest.current = draft;
    const timer = setTimeout(() => saveDraft(draft), 250);
    return () => clearTimeout(timer);
  }, [text, kind]); // eslint-disable-line react-hooks/exhaustive-deps
  // Closing the field (Esc, switching documents) right after typing keeps the draft: it is written at once (B8).
  useEffect(() => () => { if (latest.current && !saved.current) saveDraft(latest.current); }, []);

  const close = () => {
    onClose();
    // Focus returns to where it was before the composer (a block action, the header button) — never lost (APG).
    const back = returnFocus.current?.isConnected && returnFocus.current !== document.body ? returnFocus.current : state.fallbackFocus;
    requestAnimationFrame(() => {
      if (back instanceof HTMLElement && back.isConnected) focusWithoutScroll(back);
      // On touch a block action is hidden until its block has focus again.
      if (document.activeElement !== back && state.fallbackFocus?.isConnected) focusWithoutScroll(state.fallbackFocus);
    });
  };

  // Save is a command: the field is read-only, duplicate shortcuts and clicks are ignored, and the indicator
  // after 150 ms over the label; the composer closes as soon as the host saved (the reload follows in the background).
  const command = useCommand(() => save());
  async function save() {
    if (!text.trim() || status === "saving") return;
    setStatus("saving");
    setError(null);
    saveDraft({ key, ctxKey, doc, target: state.target, text, noteKind: kind, sha: existing?.sha ?? state.sha, head: view?.context.head ?? null, branch: view?.context.branch ?? null, updatedAt: Date.now(), status: "saving" });
    const target = state.target;
    const sha = existing?.sha ?? state.sha;
    const input: Record<string, unknown> = { path: doc, observation: { sha }, text: text.trim(), kind, targetKind: target.kind === "reply" ? "text" : target.kind };
    if (target.kind === "text") Object.assign(input, { range: target.range, quote: target.quote });
    if ("block" in target) input.block = target.block;
    if ("tombstoneId" in target) input.tombstoneId = target.tombstoneId;
    if ("element" in target && target.element) input.element = target.element;
    const { target: checkout } = getUi();
    const reply = await call<{ annotationId: string }>("review.annotate", { target: checkout, ...input, head: existing?.head ?? view?.context.head ?? null, branch: existing?.branch ?? view?.context.branch ?? null });
    if (!reply.ok) {
      setStatus("error");
      setError(explain(reply.error));
      if (reply.error.code === "not-enabled") setUi({});
      return;
    }
    saved.current = true;
    dropDraft(key);
    notify(kind === "action" ? tr("Comment saved in the repository, not in Git yet", "Замечание сохранено в репозитории — ещё не в Git") : tr("Note saved in the repository, not in Git yet", "Заметка сохранена в репозитории — ещё не в Git"));
    close();
    void refresh();
  }

  return <div ref={overlay} className="dr-composer" style={{ top: state.anchor.top, left: state.anchor.left }} onMouseUp={(event) => event.stopPropagation()} role="dialog" aria-label={tr("New comment", "Новое замечание")}>
    <div className="dr-composer__top">
      <Icon name="MessageSquarePlus" size={14} />
      <span>{tr("Comment ", "Замечание ")}{LABELS[state.target.kind] ?? ""}</span>
      {state.target.quote && state.target.kind !== "document" && <span className="dr-composer__quote">{tr("· “", "· «")}{state.target.quote.slice(0, 80)}{tr("”", "»")}</span>}
    </div>
    <label className="dr-field dr-field--area">
      <textarea ref={ref} value={text} onChange={(event) => setText(event.target.value)} rows={3} aria-label={tr("Comment text", "Текст замечания")} placeholder={tr("What should the agent do, or what to note…", "Что сделать агенту или что отметить…")} readOnly={command.state.running}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void command.start(); }
          if (event.key === "Escape") { event.preventDefault(); close(); }
        }} />
    </label>
    <div className="dr-composer__bot">
      <Segments value={kind} onChange={setKind} label={tr("Comment type", "Вид замечания")} items={[
        { value: "action", label: <><Icon name="Bot" />{tr("For agent", "Для агента")}</> },
        { value: "note", label: <><Icon name="StickyNote" />{tr("Note", "Заметка")}</> },
      ]} />
      <span className={`dr-composer__state${status === "error" ? " dr-composer__state--error" : ""}`} aria-live="polite">
        {status === "saving" ? tr("Saving…", "Сохраняется…") : status === "error" ? tr(`Not saved, the text is kept as a draft: ${error}`, `Не сохранено — текст в черновике: ${error}`) : text.trim() ? tr("Draft", "Черновик") : ""}
      </span>
      <Button size="sm" variant="ghost" onClick={close} title={tr("Collapse, the draft is kept", "Свернуть — черновик сохранится")}>{tr("Collapse", "Свернуть")} <Kbd>Esc</Kbd></Button>
      <Button size="sm" variant="primary" disabled={!text.trim() && !command.state.running} {...busyProps(command.state)} onClick={() => void command.start()} data-composer-save><span className="inline-flex items-center gap-1.5">{tr("Save", "Сохранить")} <Kbd>⌘↵</Kbd></span><BusyOverlay size={14} /></Button>
    </div>
  </div>;
}
