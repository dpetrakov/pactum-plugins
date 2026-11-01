// Interface wording of «Documents» (EP-017-T05, EP-126): plural forms and numbers through core/i18n.ts in the language
// of the window (English by default, Russian by choice), dates through Intl of the same locale, one verb per action —
// the button, its hint and its toast use the same word. Built once at load: the window fixes the language then.
import { counted, forms, locale, num, plural, tr, type Forms } from "../core/i18n.ts";

export { counted, num, plural, type Forms };

export const W = {
  block: forms(["block", "blocks"], ["блок", "блока", "блоков"]),
  edit: forms(["edit", "edits"], ["правка", "правки", "правок"]),
  annotation: forms(["comment", "comments"], ["замечание", "замечания", "замечаний"]),
  answer: forms(["reply", "replies"], ["ответ", "ответа", "ответов"]),
  change: forms(["change", "changes"], ["изменение", "изменения", "изменений"]),
  document: forms(["document", "documents"], ["документ", "документа", "документов"]),
  file: forms(["file", "files"], ["файл", "файла", "файлов"]),
  instruction: forms(["instruction", "instructions"], ["инструкция", "инструкции", "инструкций"]),
  section: forms(["section", "sections"], ["раздел", "раздела", "разделов"]),
  directory: forms(["folder", "folders"], ["каталог", "каталога", "каталогов"]),
  item: forms(["item", "items"], ["пункт", "пункта", "пунктов"]),
  round: forms(["round", "rounds"], ["раунд", "раунда", "раундов"]),
  key: forms(["key", "keys"], ["ключ", "ключа", "ключей"]),
  element: forms(["element", "elements"], ["элемент", "элемента", "элементов"]),
  line: forms(["line", "lines"], ["строка", "строки", "строк"]),
  row: forms(["row", "rows"], ["строка", "строки", "строк"]),
  column: forms(["column", "columns"], ["колонка", "колонки", "колонок"]),
} satisfies Record<string, Forms>;

const short = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const time = new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit" });

/** Show time alone today or localized date and time otherwise. Invalid timestamps produce an empty string. */
export function when(value: string | number | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  return date.toDateString() === now.toDateString() ? time.format(date) : short.format(date);
}

export function fullDate(value: string | number | Date): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : short.format(date);
}

/** Middle ellipsis for long paths: the start and the file name stay readable. */
export function middle(text: string, max = 48): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) * 0.4);
  return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`;
}

/** Central action vocabulary: button label, keyboard hint and success toast. UI components use this table. */
export const VERB = {
  read: { button: tr("Mark read", "Прочитано"), toast: tr("Marked read", "Прочитано"), key: "R" },
  readNext: { button: tr("Mark read and next", "Прочитано и дальше"), toast: tr("Marked read", "Прочитано"), key: "R" },
  readDoc: { button: tr("Document read", "Прочитан"), hint: tr("Document read", "Документ прочитан"), toast: tr("Document marked read", "Документ прочитан") },
  readSection: { button: tr("Section read", "Раздел прочитан"), toast: tr("Section marked read", "Раздел прочитан") },
  readAll: { button: tr("All read", "Всё прочитано"), toast: tr("All marked read", "Всё прочитано") },
  accept: { button: tr("Accept", "Принять"), toast: tr("Accepted", "Принято"), key: "A" },
  reply: { button: tr("Reply", "Ответить"), toast: tr("Reply saved", "Ответ сохранён"), key: "E" },
  comment: { button: tr("Comment", "Замечание"), toast: tr("Comment saved", "Замечание сохранено"), key: "C" },
  send: { button: tr("Send to agent", "Передать агенту"), toast: tr("Sent to agent", "Передано агенту"), key: "S" },
  sendOne: { button: tr("Send only this", "Передать только это"), toast: tr("Sent to agent", "Передано агенту") },
  close: { button: tr("Close", "Закрыть"), toast: tr("Closed", "Закрыто") },
  reopen: { button: tr("Reopen", "Возобновить"), toast: tr("Reopened", "Возобновлено") },
  withdraw: { button: tr("Withdraw", "Отозвать"), toast: tr("Withdrawn", "Отозвано") },
  restore: { button: tr("Restore", "Вернуть"), toast: tr("Restored", "Возвращено") },
  toNote: { button: tr("Make a note", "В заметки"), toast: tr("Turned into a note", "Переведено в заметки") },
  toAgent: { button: tr("For agent", "Для агента"), toast: tr("Marked “For agent”", "Переведено «Для агента»") },
  retry: { button: tr("Retry processing", "Повторить обработку"), toast: tr("Will be processed again in the next batch", "Обработка повторится в следующем пакете") },
  undo: { button: tr("Undo", "Отменить") },
  diff: { button: tr("Changes", "Правки"), hint: tr("Changes in the text", "Правки в тексте"), key: "D" },
  onlyChanges: { button: tr("Only changes", "Только изменения"), hint: tr("Only changes", "Только изменения") },
  search: { hint: tr("Search documents and sections", "Поиск документов и разделов"), key: "/" },
};
