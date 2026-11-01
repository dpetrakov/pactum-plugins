// Enable review in the background: the server records the initial base incrementally and the UI shows progress
// without a blocking modal. One job belongs to each machine/root pair; state arrives through
// review.enable.progress events and review.enable.status when the checkout opens.
import { useSyncExternalStore } from "react";
import { call as invoke, explain, loadTree, refresh } from "./actions.ts";
import { type ErrorInfo, getUi, notify, readingRoots, useUi } from "./store.ts";
import { W, counted } from "./words.ts";
import { tr } from "../core/i18n.ts";

export type EnableJob = {
  machine: { hostId: string; name: string }; root: string; state: "running" | "done" | "failed" | "stopped";
  done: number; total: number | null; error: { code: string; message: string } | null; stopping: boolean; markGenerated: boolean;
};

const jobs = new Map<string, EnableJob>();
const listeners = new Set<() => void>();
const keyOf = (hostId: string, root: string) => `${hostId}\n${root}`;
const emit = () => { for (const listener of listeners) listener(); };

function isJob(value: unknown): value is EnableJob {
  const job = value as EnableJob | null;
  return !!job && typeof job.root === "string" && typeof job.machine?.hostId === "string" && typeof job.state === "string" && typeof job.done === "number";
}

/**
 * While the base is being saved every step writes .bb-docs and the host watch reports a change about twice a second;
 * the window skips those for this checkout (the tree and the view reload once, when the job ends).
 */
export function isEnableRunning(hostId: string | undefined, root: string | undefined): boolean {
  return !!hostId && !!root && jobs.get(keyOf(hostId, root))?.state === "running";
}

/** A job update from the server; the end of a job this window watched is said once (toast) and the tree reloads. */
export function applyEnableProgress(payload: unknown): void {
  if (!isJob(payload)) return;
  const key = keyOf(payload.machine.hostId, payload.root);
  const previous = jobs.get(key);
  jobs.set(key, payload);
  emit();
  if (previous?.state !== "running" || payload.state === "running") return;
  if (payload.state === "done") {
    notify(tr(`Review enabled: the base is ${counted(payload.total ?? payload.done, W.document)} in .bb-docs/. Commit the folder together with the documents.`, `Обзор включён: исходная база — ${counted(payload.total ?? payload.done, W.document)} в .bb-docs/. Закоммитьте каталог вместе с документами.`));
    // The document and the tree both change: writable view, «Enable review» gone from the tree footer.
    void refresh({ force: true });
    void loadTree();
  }
}

async function call(method: string, input: Record<string, unknown>): Promise<{ job: EnableJob | null } | { error: string }> {
  const reply = await invoke<never>(method, input);
  if (!reply.ok) return { error: explain(reply.error as ErrorInfo) };
  const job = isJob(reply.job) ? reply.job : null;
  if (job) { jobs.set(keyOf(job.machine.hostId, job.root), job); emit(); }
  return { job };
}

/** Start (or continue — the host enable is resumable) the background enable of the current checkout; an error text if it did not start. */
export async function startEnableJob(head: string | null, markGenerated: boolean): Promise<string | null> {
  const { target, ctxKey } = getUi();
  if (!target) return tr("no checkout selected", "рабочая копия не выбрана");
  const roots = readingRoots(ctxKey);
  const reply = await call("review.enable.start", { target, head, markGenerated, ...(roots ? { roots } : {}) });
  return "error" in reply ? reply.error : null;
}

export async function stopEnableJob(): Promise<void> {
  const { target } = getUi();
  if (!target) return;
  const reply = await call("review.enable.cancel", { target });
  if ("error" in reply) notify(tr(`Could not stop enabling: ${reply.error}`, `Не удалось остановить включение: ${reply.error}`), { tone: "error" });
}

/** The job of the opened checkout, if the server has one (a window opened while it runs, or after it ended). */
export async function loadEnableJob(): Promise<void> {
  const { target } = getUi();
  if (target) await call("review.enable.status", { target });
}

/** The enable job of the checkout the tree shows, or null. */
export function useEnableJob(): EnableJob | null {
  const hostId = useUi((ui) => ui.tree?.machine.hostId ?? null);
  const root = useUi((ui) => ui.tree?.root ?? null);
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => (hostId && root ? jobs.get(keyOf(hostId, root)) ?? null : null));
}
