// Move review data when a file's Git classification changes:
// when a file enters Git, list the data that will become shared, including annotations,
// authors, receipts and bases; then offer Move to Git with confirmation, Keep local
// or Later. When a file leaves Git, show a local-transfer notice with Undo and
// the move after it. Writes go through `mutate` (W-06b); the toast says what moved.
import { useEffect, useState } from "react";
import { call, explain, loadTree, mutate } from "./actions.ts";
import { Icon } from "./icons.tsx";
import { Banner, Button, CommandButton, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./kit.tsx";
import { getUi, notify, useUi } from "./store.ts";
import { tr } from "../core/i18n.ts";
import { W, counted, plural } from "./words.ts";

type Preview = { conflict?: boolean; annotations: { annotationId: string; firstLine: string; author: string; status: string }[]; receipts: number; revisions: number; where: string };

const later = new Set<string>();
const announced = new Set<string>();

async function move(path: string, direction: "to-git" | "to-local") {
  const done = await mutate<{ annotations: number; receipts: number }>("review.local.transfer", { path, direction }, { verb: tr("move", "Перенести") });
  if (!done) return false;
  notify(tr(`Moved ${direction === "to-git" ? "to the shared review" : "to local storage"}: ${counted(done.annotations, W.annotation)}, ${counted(done.receipts, ["read mark", "read marks", "read marks"])}`, `Перенесено ${direction === "to-git" ? "в общий обзор" : "в локальное хранилище"}: ${counted(done.annotations, W.annotation)}, ${counted(done.receipts, ["отметка", "отметки", "отметок"])} «Прочитано»`));
  void loadTree({ quick: true });
  return true;
}

/** The offer on a file with local data that is now in Git (and the dialog with what becomes shared). */
export function TransferBanner({ path }: { path: string }) {
  const entry = useUi((ui) => ui.tree?.entries.find((item) => item.path === path) ?? null);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | { error: string } | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPreview(null);
    void call<Preview>("review.local.transferPreview", { target: getUi().target, path, direction: "to-git" }).then((reply) => {
      if (!cancelled) setPreview(reply.ok ? (reply as unknown as { result: Preview }).result : { error: explain(reply.error) });
    });
    return () => { cancelled = true; };
  }, [open, path]);
  if (entry?.transfer !== "to-git" || later.has(path)) return null;
  return <>
    <Banner icon="GitBranchPlus" role="status" data-transfer-banner actions={<div className="flex w-full flex-wrap gap-1">
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}><Icon name="GitBranchPlus" />{tr("Move to Git…", "Перенести…")}</Button>
      <CommandButton size="sm" variant="ghost" run={async () => { if (await mutate("review.local.keep", { path }, { verb: tr("keep local", "Оставить локальными") })) { notify(tr("Data kept local and read-only. The shared review starts from a clean base", "Данные оставлены локальными — только для чтения; общий обзор начнётся с чистой базы")); void loadTree({ quick: true }); } }}>{tr("Keep local", "Оставить локальными")}</CommandButton>
      <Button size="sm" variant="ghost" onClick={() => { later.add(path); setTick((value) => value + 1); }}>{tr("Later", "Позже")}</Button>
    </div>}>
      {tr("The file is now in Git. Move its review data to the shared review? It goes to Git along with ", "Файл теперь в Git. Перенести данные обзора в общий обзор? Они уйдут в Git вместе с ")}<code>.bb-docs</code>.
    </Banner>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent data-dr data-transfer-dialog style={{ maxWidth: 520 }}>
        <DialogHeader><DialogTitle>{tr("Move review data to the shared review", "Перенести данные обзора в общий обзор")}</DialogTitle>
          <DialogDescription>{tr("It becomes shared and goes to Git with your commit of ", "Станет общим и уйдёт в Git с вашим коммитом ")}<code>.bb-docs</code>{tr(". Secret values are not moved: the storage has none.", ". Значения секретов не переносятся — их в хранилище нет.")}</DialogDescription></DialogHeader>
        {preview === null ? <p className="dr-meta" aria-busy>{tr("Counting what will be moved…", "Считаем, что будет перенесено…")}</p>
          : "error" in preview ? <Banner icon="TriangleAlert" tone="error" role="alert">{preview.error}</Banner>
          : <div className="dr-prev" data-transfer-list>
            <div className="dr-prev__row"><span className="dr-prev__num">{preview.annotations.length}</span><span>{plural(preview.annotations.length, W.annotation)}{tr(" (by you or the agent):", " (автор — вы или агент):")}</span></div>
            <ul className="dr-prev__paths" style={{ fontFamily: "var(--font-sans)" }}>{preview.annotations.slice(0, 20).map((entry) => <li key={entry.annotationId}>{tr(`“${entry.firstLine}”, ${entry.author}`, `«${entry.firstLine}» — ${entry.author}`)}</li>)}</ul>
            <div className="dr-prev__row"><span className="dr-prev__num">{preview.receipts}</span><span>{tr(plural(preview.receipts, ["your read mark", "your read marks", "your read marks"]), `${plural(preview.receipts, ["ваша отметка", "ваши отметки", "ваших отметок"])} «Прочитано»`)}</span></div>
            <div className="dr-prev__row"><span className="dr-prev__num">{preview.revisions}</span><span>{tr(`${plural(preview.revisions, ["revision", "revisions", "revisions"])} (bases, redacted snapshots)`, `${plural(preview.revisions, ["редакция", "редакции", "редакций"])} (базы, редактированные снимки)`)}</span></div>
            <div className="dr-prev__warn"><Icon name="Info" /><span>{tr("Agent rounds stay in the local log, their replies are moved as messages.", "Раунды агента остаются в локальном журнале, их ответы переносятся сообщениями.")}</span></div>
            {preview.conflict && <div className="dr-prev__warn" role="alert"><Icon name="TriangleAlert" /><span>{tr("This file already has data in the shared review, and moving doesn't merge them. Keep the local data read-only (“Keep local”).", "У этого файла уже есть данные в общем обзоре — перенос их не объединяет. Оставьте локальные данные только для чтения («Оставить локальными»).")}</span></div>}
          </div>}
        <DialogFooter><Button variant="ghost" onClick={() => setOpen(false)}>{tr("Cancel", "Отмена")}</Button>
          <CommandButton variant="primary" icon="GitBranchPlus" disabled={!preview || "error" in preview || Boolean(preview.conflict)} run={async () => { if (await move(path, "to-git")) setOpen(false); }}>{tr("Move to Git", "Перенести")}</CommandButton></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

/**
 * A file with shared data that left Git (ignored, not in the index): the notice with «Undo», the move after it
 * (once per file in this window; «Undo» keeps the file outside Git without tracking, the data stay in .bb-docs).
 */
export function useAutoTransfer() {
  const entries = useUi((ui) => ui.tree?.entries ?? null);
  useEffect(() => {
    for (const entry of entries ?? []) {
      if (entry.transfer !== "to-local" || announced.has(entry.path)) continue;
      announced.add(entry.path);
      let cancelled = false;
      const ms = 9000;
      notify(tr(`${entry.path} is excluded from Git: its review data will move to local storage`, `Файл ${entry.path} исключён из Git — данные обзора перенесутся в локальное хранилище`), { undo: async () => { cancelled = true; notify(tr("Move canceled: the data stays as history in .bb-docs, the file is untracked", "Перенос отменён: данные остаются историей в .bb-docs, файл — без отслеживания")); }, ms });
      setTimeout(() => { if (!cancelled) void move(entry.path, "to-local"); }, ms + 300);
    }
  }, [entries]);
}
