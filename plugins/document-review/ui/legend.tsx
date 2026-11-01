// «Legend» (W-06c, file-types.md §11, F21; EP-043-T06): the legend of the marks — blocks and lines, table cells
// and fragments, secrets and annotations — in «⋯» of the document header. The samples are the very classes the views
// use, so the legend and the document look the same by construction.
import { Icon } from "./icons.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./kit.tsx";
import { tr } from "../core/i18n.ts";

export function LegendDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent data-dr data-legend style={{ maxWidth: 520 }}>
      <DialogHeader><DialogTitle>{tr("Legend", "Обозначения")}</DialogTitle><DialogDescription className="dr-sr">{tr("Marks of changes, secrets and comments", "Пометки изменений, секретов и замечаний")}</DialogDescription></DialogHeader>
      <dl className="dr-legend">
        <div className="dr-legend__head">{tr("Blocks, lines and keys", "Блоки, строки и ключи")}</div>
        <dt><span className="dr-legend__sample dr-legend__sample--rail" style={{ ["--dr-mc" as string]: "var(--dr-changed)" }}>{tr("changed", "изменено")}</span></dt><dd><b>{tr("Changed", "Изменено")}</b> {tr("since you last read it · “Mark read”: R", "с вашего последнего прочтения · «Прочитано» — R")}</dd>
        <dt><span className="dr-legend__sample dr-legend__sample--rail" style={{ ["--dr-mc" as string]: "var(--dr-added)" }}>{tr("added", "добавлено")}</span></dt><dd><b>{tr("Added", "Добавлено")}</b>{tr(": new to you", " — нового для вас")}</dd>
        <dt><span className="dr-legend__sample dr-legend__sample--moved">{tr("moved", "перемещено")}</span></dt><dd><b>{tr("Moved", "Перемещено")}</b> {tr("to another section, same text", "в другой раздел, текст тот же")}</dd>
        <dt><span className="dr-legend__sample dr-legend__sample--unclear">{tr("unclear", "неясно")}</span></dt><dd><b>{tr("Unclear base", "Неясная база")}</b>{tr(": versions diverged, nothing to compare with", " — версии разошлись, сравнить не с чем")}</dd>
        <dt><span className="dr-cl__gone"><Icon name="Trash2" /><b>{tr("Deleted", "Удалено")}</b></span></dt><dd><b>{tr("Deleted", "Удалено")}</b>{tr(": a block, lines or a key", " — блок, строки или ключ")}</dd>
        <div className="dr-legend__head">{tr("Tables and fragments", "Таблицы и фрагменты")}</div>
        <dt><span className="dr-legend__sample dr-legend__sample--cell">{tr("cell", "ячейка")}</span></dt><dd><b>{tr("Table cell or row changed", "Ячейка или строка таблицы изменена")}</b> {tr("since you read it", "с вашего прочтения")}</dd>
        <dt><span><ins className="dr-ins">{tr("insertion", "вставка")}</ins> <del className="dr-del">{tr("deletion", "удаление")}</del></span></dt><dd><b>{tr("Word-level changes", "Правки по словам")}</b> {tr("(“Changes” toggle, D)", "(тогл «Правки», D)")}</dd>
        <dt><span><span className="dr-kn__was">1.8.2</span> → <span className="dr-sy-s" style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>1.9.0</span></span></dt><dd><b>{tr("Was → now", "Было → стало")}</b> {tr("for a key value", "у значения ключа")}</dd>
        <div className="dr-legend__head">{tr("Secrets and comments", "Секреты и замечания")}</div>
        <dt><span className="dr-mask"><span className="dr-mask__dots">••••••••</span><span className="dr-mask__len">{tr("32 chars", "32 симв.")}</span><Icon name="Eye" /></span></dt><dd><b>{tr("Hidden value", "Скрытое значение")}</b>{tr(": length and “Reveal” (only in this checkout)", ": длина и «Показать» (только в этой рабочей копии)")}</dd>
        <dt><span className="dr-mask__changed">{tr("value changed", "значение изменено")}</span></dt><dd><b>{tr("Secret value changed", "Значение секрета изменилось")}</b>{tr(": no values, only on this device", " — без значений, только на этом устройстве")}</dd>
        <dt><span className="dr-legend__sample" style={{ background: "var(--dr-note-wash)" }}>{tr("comment", "замечание")}</span></dt><dd><b>{tr("Open comment", "Открытое замечание")}</b></dd>
        <dt><span className="dr-count dr-count--waiting">1</span></dt><dd><b>{tr("Waiting for you", "Ждёт вас")}</b>{tr(": the agent replied and waits for your decision", " — ответ агента ждёт решения")}</dd>
      </dl>
    </DialogContent>
  </Dialog>;
}
