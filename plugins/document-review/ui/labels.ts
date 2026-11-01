// Labels shared by the screen, «Comments» and «Agent»: the agent state of an annotation and of the batch.
import { tr } from "../core/i18n.ts";
import type { getUi } from "./store.ts";

export const AGENT_LABEL: Record<string, string> = { new: tr("New", "Новое"), "in-progress": tr("In progress", "В работе"), done: tr("Done", "Сделано"), "needs-input": tr("Needs input", "Нужен ответ"), failed: tr("Failed", "Не удалось"), skipped: tr("Skipped", "Пропущено") };

/** The state of the active batch in one word group: the send button and the «Agent» panel show the same text. */
export function batchLabel(batch: ReturnType<typeof getUi>["batch"]): { text: string; tone: "info" | "warn" | "done" } | null {
  if (!batch?.active) return null;
  const { answered, total } = batch.active;
  if (batch.launch?.state === "dispatching") return { text: tr("Preparing", "Готовится"), tone: "info" };
  if (batch.launch?.state === "dispatch-unknown") return { text: tr("Delivery not confirmed", "Отправка не подтверждена"), tone: "warn" };
  if (batch.thread?.waitingUser) return { text: tr("Waiting for you in the thread", "Ждёт вас в треде"), tone: "warn" };
  if (batch.thread?.queued) return { text: tr("Queued in the thread", "В очереди треда"), tone: "info" };
  if (batch.thread && !batch.thread.exists) return { text: tr("Thread unavailable", "Тред недоступен"), tone: "warn" };
  if (batch.thread?.status === "active" || batch.thread?.status === "starting") return { text: tr(`Running · ${answered} of ${total}`, `Выполняется · ${answered} из ${total}`), tone: "info" };
  return { text: tr(`Agent stopped · ${answered} of ${total}`, `Агент остановился · ${answered} из ${total}`), tone: "warn" };
}
