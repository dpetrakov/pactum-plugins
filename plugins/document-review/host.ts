// Host entry: runs on the machine that has the checkout. All file access and Git calls happen here, so a
// path never silently refers to another machine (EP-007-T02).
import { experimental_defineHostEntry, type ExperimentalHostWatchSubscription } from "@get-bb/plugin-sdk";
import { hostContract, hostSignals } from "./host-contract.ts";
import { runCheck, summarize } from "./node/check.ts";
import { drillClean, drillMerge, drillStart } from "./node/drill.ts";
import { CheckoutError, locateFile, resolveCheckoutFile } from "./node/checkout.ts";
import { abandonRun, accept, sendSummary, batchGet, batchStatus, discussionGet, documentGet, documentsList, finishBatch, itemReply, markDispatched, markUnknown, prepareBatch, registerInput, roundSummary, undoAccept } from "./node/batches.ts";
import { ReviewError, serviceFor } from "./node/service.ts";
import { documentFileInfo } from "./node/file.ts";
import { compactView, documentText, documentView, markSecretsSeen, prefetchViews } from "./node/view.ts";
import { revealSecret, setSecretExemption } from "./node/secrets-host.ts";
import { settingsGet, settingsPreview, settingsSave } from "./node/settings.ts";
import { keepLocal, transferDocument, transferPreview } from "./node/transfer.ts";
import { localMove, prepareAny, serviceForRun, bindStore, cleanupLocal, forgetStore, localForget, localList, serviceForAnnotation, serviceForDoc, serviceForPath, trackLocally } from "./node/local.ts";
import { blankPersonalDeep, maskPersonalDeep, readContent, readerOf } from "./node/content.ts";
import { slug } from "./ui/route.ts";
import { disposeParsePool } from "./node/parse-pool.ts";
import { cleanPerf, runPerf } from "./node/perf.ts";
import { configSha, resolveDocumentConflict, resolveMove, setRule, treeWithMoves } from "./node/catalog.ts";
import { documentTree, searchIndex } from "./node/tree.ts";
import { StoreError } from "./core/store.ts";
import { isLang, setLang } from "./core/i18n.ts";

type Envelope = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };

/** Strict JSON for the RPC boundary: drops undefined, rejects nothing silently. */
function json(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}

async function envelope(run: () => Promise<unknown>): Promise<Envelope> {
  try {
    return { ok: true, result: json(await run()) };
  } catch (error) {
    if (error instanceof ReviewError) return { ok: false, error: { code: error.code, message: error.message, details: json(error.details) as Record<string, unknown> } };
    if (error instanceof CheckoutError || error instanceof StoreError) return { ok: false, error: { code: error.code, message: error.message } };
    return { ok: false, error: { code: "internal", message: error instanceof Error ? error.message : String(error) } };
  }
}

/**
 * A cancelled call answers at once, even while it waits in the checkout's queue behind a long write: bb sends
 * «cancel» to a call past its deadline and kills the whole worker (SIGKILL) if the call is still pending 5 s later,
 * taking every other call with it — this is how a minutes-long enable on amber died (2026-10-16). The work itself
 * finishes in the background; only the answer is given up.
 */
function abortable<H extends object>(handlers: H): H {
  const wrapped: Record<string, (input: unknown, context: { signal?: AbortSignal }) => unknown> = {};
  for (const [name, handler] of Object.entries(handlers) as [string, (input: unknown, context: { signal?: AbortSignal }) => unknown][]) {
    wrapped[name] = (input, context) => {
      // The language of the texts of this answer (EP-126): one reader per window, the last call's language wins.
      const { lang: language, ...rest } = (input ?? {}) as { lang?: unknown };
      if (isLang(language)) setLang(language);
      const result = Promise.resolve().then(() => handler(rest, context));
      const signal = context?.signal;
      if (!signal) return result;
      return new Promise((resolve, reject) => {
        const cancelled = () => reject(Object.assign(new Error(`${name}: cancelled by the caller`), { name: "AbortError" }));
        if (signal.aborted) { result.catch(() => undefined); cancelled(); return; }
        signal.addEventListener("abort", cancelled, { once: true });
        result.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancelled));
      });
    };
  }
  return wrapped as H;
}

/** The review serving a document (EP-048): the local one for a file outside Git tracked locally, the shared one otherwise. */
async function routed(root: string, dataDir: string, docPath: string | null | undefined) {
  return serviceForPath(await serviceFor(root, dataDir), docPath);
}
async function byRun(root: string, dataDir: string, runId: string) {
  return serviceForRun(await serviceFor(root, dataDir), runId);
}
async function byAnnotation(root: string, dataDir: string, annotationId: string) {
  return serviceForAnnotation(await serviceFor(root, dataDir), annotationId);
}

/** Outputs to this checkout's UI: the user's personal secret extensions blanked (F14), lengths and offsets kept. */
async function blankPersonal<T>(service: Awaited<ReturnType<typeof serviceFor>>, path: string, value: T): Promise<T> {
  const content = await readContent(service, path, { readerId: await readerOf(service) }).catch(() => null);
  return content && content.secrets.some((secret) => secret.scope === "personal") ? blankPersonalDeep(content, value) : value;
}

/** A receipt is in the shared journal or in this reader's local one: the shared first, the local on «not found». */
async function withLocalFallback<T>(root: string, dataDir: string, run: (service: Awaited<ReturnType<typeof serviceFor>>) => Promise<T>): Promise<T> {
  const shared = await serviceFor(root, dataDir);
  try {
    return await run(shared);
  } catch (error) {
    if (!(error instanceof ReviewError) || error.code !== "not-found") throw error;
    const { localFor } = await import("./node/local.ts");
    const local = await localFor(shared);
    if (!local) throw error;
    return run(local);
  }
}

const watches = new Map<string, Promise<ExperimentalHostWatchSubscription>>();

const entry = experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    status: ({ root }, context) => envelope(async () => (await serviceFor(root, context.experimental_paths.dataDir)).status()),
    orphans: ({ root, apply }, context) => envelope(async () => (await serviceFor(root, context.experimental_paths.dataDir)).orphans({ apply })),
    validate: ({ root, limit }, context) => envelope(async () => (await serviceFor(root, context.experimental_paths.dataDir)).validate(limit)),
    enablePlan: ({ root, roots }, context) => envelope(async () => (await serviceFor(root, context.experimental_paths.dataDir)).enablePlan(roots)),
    enable: ({ root, ...input }, context) => envelope(async () => (await serviceFor(root, context.experimental_paths.dataDir)).enable(input)),
    read: ({ root, path }, context) => envelope(async () => {
      const service = await routed(root, context.experimental_paths.dataDir, path);
      const { personalText: _personal, ...read } = await service.readDocument(path);
      return blankPersonal(service, path, read);
    }),
    viewPersonal: ({ root, path }, context) => envelope(async () => {
      const service = await routed(root, context.experimental_paths.dataDir, path);
      const { secrets, ...view } = await documentView(service, path);
      const content = await readContent(service, path, { readerId: await readerOf(service) }).catch(() => null);
      const safe = { ...view, secrets: secrets.map((secret) => ({ line: secret.line, path: secret.path, key: secret.key, changed: secret.changed })) };
      return content ? maskPersonalDeep(content, safe) : safe;
    }),
    revealSecret: ({ root, ...input }, context) => envelope(async () => revealSecret(await routed(root, context.experimental_paths.dataDir, input.path), input)),
    secretsSeen: ({ root, path, places }, context) => envelope(async () => markSecretsSeen(await routed(root, context.experimental_paths.dataDir, path), path, places ?? null)),
    secretExempt: ({ root, ...input }, context) => envelope(async () => setSecretExemption(await serviceFor(root, context.experimental_paths.dataDir), input)),
    readState: ({ root, path }, context) => envelope(async () => (await routed(root, context.experimental_paths.dataDir, path)).readStatus(path)),
    annotate: ({ root, ...input }, context) => envelope(async () => (await routed(root, context.experimental_paths.dataDir, input.path)).annotate(input)),
    acknowledge: ({ root, ...input }, context) => envelope(async () => (await routed(root, context.experimental_paths.dataDir, input.path)).acknowledge(input)),
    layout: ({ root, ...input }, context) => envelope(async () => (await routed(root, context.experimental_paths.dataDir, input.path)).layout(input)),
    reply: ({ root, ...input }, context) => envelope(async () => (await byAnnotation(root, context.experimental_paths.dataDir, input.annotationId)).reply(input)),
    decide: ({ root, ...input }, context) => envelope(async () => (await byAnnotation(root, context.experimental_paths.dataDir, input.annotationId)).decide(input)),
    revoke: ({ root, ...input }, context) => envelope(async () => withLocalFallback(root, context.experimental_paths.dataDir, (service) => service.revoke(input))),
    revise: ({ root, ...input }, context) => envelope(async () => (await byAnnotation(root, context.experimental_paths.dataDir, input.annotationId)).revise(input)),
    retry: ({ root, ...input }, context) => envelope(async () => (await byAnnotation(root, context.experimental_paths.dataDir, input.annotationId)).retry(input)),
    resolveConflict: ({ root, ...input }, context) => envelope(async () => (await byAnnotation(root, context.experimental_paths.dataDir, input.annotationId)).resolveConflict(input)),
    trackLocal: ({ root, ...input }, context) => envelope(async () => trackLocally(await serviceFor(root, context.experimental_paths.dataDir), input)),
    localList: ({ root }, context) => envelope(async () => localList(await serviceFor(root, context.experimental_paths.dataDir))),
    localForget: ({ root, ...input }, context) => envelope(async () => localForget(await serviceFor(root, context.experimental_paths.dataDir), input)),
    view: ({ root, path, compact, opened }, context) => envelope(async () => {
      const service = await routed(root, context.experimental_paths.dataDir, path);
      if (opened) await service.openDocument(path);
      const view = await documentView(service, path);
      return blankPersonal(service, path, compact ? compactView(view) : view);
    }),
    fileInfo: ({ root, path, chunk }, context) => envelope(async () => documentFileInfo(await routed(root, context.experimental_paths.dataDir, path), path, chunk)),
    text: ({ root, path, from, limit, around, outline, source }, context) => envelope(async () => {
      const service = await routed(root, context.experimental_paths.dataDir, path);
      return blankPersonal(service, path, await documentText(service, path, { from, limit, around, outline, slug, source }));
    }),
    documents: ({ root }, context) => envelope(async () => documentsList(await serviceFor(root, context.experimental_paths.dataDir))),
    batchStatus: ({ root }, context) => envelope(async () => {
      const shared = await serviceFor(root, context.experimental_paths.dataDir);
      const status = await batchStatus(shared);
      const { localFor, localConfig } = await import("./node/local.ts");
      const local = await localFor(shared).catch(() => null);
      const localStatus = local && (await localConfig(local)) ? await batchStatus(local) : null;
      // An active local batch (EP-048) is the checkout's active batch when no shared one is; otherwise its unresolved
      // dispatch is still reported (security review, finding 14).
      if (status.active || status.launch) return localStatus?.launch ? { ...status, localLaunch: localStatus.launch } : status;
      return localStatus && (localStatus.active || localStatus.launch) ? { ...localStatus, enabled: status.enabled, local: true } : status;
    }),
    batchPrepare: ({ root, ...input }, context) => envelope(async () => prepareAny(await serviceFor(root, context.experimental_paths.dataDir), input)),
    batchDispatched: ({ root, ...input }, context) => envelope(async () => markDispatched(await byRun(root, context.experimental_paths.dataDir, input.runId), input)),
    batchUnknown: ({ root, ...input }, context) => envelope(async () => markUnknown(await byRun(root, context.experimental_paths.dataDir, input.runId), input)),
    batchAbandon: ({ root, ...input }, context) => envelope(async () => abandonRun(await byRun(root, context.experimental_paths.dataDir, input.runId), input)),
    batchGet: ({ root, ...input }, context) => envelope(async () => batchGet(input.runId ? await byRun(root, context.experimental_paths.dataDir, input.runId) : await serviceFor(root, context.experimental_paths.dataDir), input)),
    documentGet: ({ root, ...input }, context) => envelope(async () => documentGet(await routed(root, context.experimental_paths.dataDir, input.path), input)),
    discussionGet: ({ root, ...input }, context) => envelope(async () => discussionGet(await byAnnotation(root, context.experimental_paths.dataDir, input.annotationId), input)),
    registerInput: ({ root, ...input }, context) => envelope(async () => registerInput(await byRun(root, context.experimental_paths.dataDir, input.runId), input)),
    itemReply: ({ root, ...input }, context) => envelope(async () => itemReply(await byRun(root, context.experimental_paths.dataDir, input.runId), input)),
    batchFinish: ({ root, ...input }, context) => envelope(async () => finishBatch(await byRun(root, context.experimental_paths.dataDir, input.runId), input)),
    roundSummary: ({ root, runId }, context) => envelope(async () => {
      const service = await byRun(root, context.experimental_paths.dataDir, runId);
      return roundSummary(service, await service.state(), runId);
    }),
    accept: ({ root, ...input }, context) => envelope(async () => accept(await routed(root, context.experimental_paths.dataDir, input.path), input)),
    undoAccept: ({ root, ...input }, context) => envelope(async () => undoAccept(await byAnnotation(root, context.experimental_paths.dataDir, input.annotationId), input)),
    tree: ({ root, roots, budgetMs }, context) => envelope(async () => {
      const service = await serviceFor(root, context.experimental_paths.dataDir);
      // Local-data retention runs on the host while building the tree, without an open UI.
      void cleanupLocal(service).catch(() => undefined);
      return { ...(await treeWithMoves(service, { roots, budgetMs })), configSha: await configSha(service) };
    }),
    search: ({ root, query, showHidden, roots }, context) => envelope(async () => {
      const service = await serviceFor(root, context.experimental_paths.dataDir);
      return searchIndex(service, await documentTree(service, { roots, budgetMs: 100 }), query, { showHidden });
    }),
    locate: ({ path }) => envelope(async () => locateFile(path)),
    resolvePath: ({ root, path }) => envelope(async () => resolveCheckoutFile(root, path)),
    sendSummary: ({ root, scope }, context) => envelope(async () => sendSummary(await serviceFor(root, context.experimental_paths.dataDir), { scope })),
    settingsGet: ({ root }, context) => envelope(async () => settingsGet(await serviceFor(root, context.experimental_paths.dataDir))),
    settingsPreview: ({ root, ...input }, context) => envelope(async () => settingsPreview(await serviceFor(root, context.experimental_paths.dataDir), input)),
    settingsSave: ({ root, ...input }, context) => envelope(async () => settingsSave(await serviceFor(root, context.experimental_paths.dataDir), input)),
    setRule: ({ root, ...input }, context) => envelope(async () => setRule(await serviceFor(root, context.experimental_paths.dataDir), input)),
    resolveMove: ({ root, ...input }, context) => envelope(async () => {
      const shared = await serviceFor(root, context.experimental_paths.dataDir);
      const service = await serviceForDoc(shared, input.docId);
      if (service.scope === "local") return localMove(shared, service, input);
      return resolveMove(service, input);
    }),
    resolveMoves: ({ root, items }, context) => envelope(async () => {
      const shared = await serviceFor(root, context.experimental_paths.dataDir);
      const results: { docId: string; to: string | null; status: string; receiptId?: string | null; error?: string }[] = [];
      for (const item of items) {
        if (context.signal?.aborted) break;
        try {
          const service = await serviceForDoc(shared, item.docId);
          const result = service.scope === "local" ? await localMove(shared, service, item) : await resolveMove(service, item);
          results.push({ docId: item.docId, to: item.to, status: String((result as { status?: string }).status ?? "done"), receiptId: (result as { receiptId?: string | null }).receiptId ?? null });
        } catch (error) {
          results.push({ docId: item.docId, to: item.to, status: "failed", error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { results };
    }),
    transferPreview: ({ root, ...input }, context) => envelope(async () => transferPreview(await serviceFor(root, context.experimental_paths.dataDir), input)),
    transfer: ({ root, ...input }, context) => envelope(async () => transferDocument(await serviceFor(root, context.experimental_paths.dataDir), input)),
    keepLocal: ({ root, ...input }, context) => envelope(async () => keepLocal(await serviceFor(root, context.experimental_paths.dataDir), input)),
    localBind: ({ root, ...input }, context) => envelope(async () => bindStore(await serviceFor(root, context.experimental_paths.dataDir), input)),
    localForgetStore: ({ root, ...input }, context) => envelope(async () => forgetStore(await serviceFor(root, context.experimental_paths.dataDir), input)),
    acknowledgeAll: ({ root, ...input }, context) => envelope(async () => (await serviceFor(root, context.experimental_paths.dataDir)).acknowledgeAll(input)),
    revokeMany: ({ root, ...input }, context) => envelope(async () => (await serviceFor(root, context.experimental_paths.dataDir)).revokeMany(input)),
    resolveDocumentConflict: ({ root, ...input }, context) => envelope(async () => resolveDocumentConflict(await serviceFor(root, context.experimental_paths.dataDir), input)),
    resolveConfigConflict: ({ root, ...input }, context) => envelope(async () => (await serviceFor(root, context.experimental_paths.dataDir)).resolveConfigConflict(input)),
    watch: ({ root, enabled }, context) => envelope(async () => {
      const service = await serviceFor(root, context.experimental_paths.dataDir);
      const existing = watches.get(service.root);
      if (!enabled) {
        watches.delete(service.root);
        await (await existing?.catch(() => null))?.dispose();
        return { watching: false };
      }
      if (existing) {
        await existing;
        return { watching: true };
      }
      // Native watch only invalidates; re-reading and hashing stays the source of truth (rescan-required included).
      // The pending subscription is registered before awaiting, so concurrent calls share it.
      const subscription = context.experimental_watch({ rootPath: service.root, ignoredPaths: [".git", "node_modules"], debounceMs: 200, maxWaitMs: 2000 }, async (event) => {
        service.invalidate();
        const paths = event.kind === "changed" ? event.changes.slice(0, 64).map((change) => change.path) : [];
        await context.experimental_emitSignal("changed", { root: service.root, kind: event.kind, paths, ...(event.kind === "watch-error" ? { message: event.message } : {}) });
        if (event.kind === "changed") void prefetchViews(service, paths).catch(() => undefined);
      });
      watches.set(service.root, subscription);
      try {
        await subscription;
      } catch (error) {
        watches.delete(service.root);
        throw error;
      }
      return { watching: true };
    }),
    perf: ({ root, bundle, keep, docs, rounds, clean }, context) => envelope(() => clean ? cleanPerf(context.experimental_paths.dataDir)
      : runPerf({ root, bundle, keep, docs, rounds, tempDir: context.experimental_paths.tempDir, dataDir: context.experimental_paths.dataDir })),
    summary: ({ root, bundle, reader }, context) => envelope(() => summarize({ root, bundle, reader, dataDir: context.experimental_paths.dataDir, tempDir: context.experimental_paths.tempDir })),
    drillStart: (_input, context) => envelope(() => drillStart({ tempDir: context.experimental_paths.tempDir })),
    drillMerge: ({ bundle }, context) => envelope(() => drillMerge({ bundle, tempDir: context.experimental_paths.tempDir })),
    drillClean: (_input, context) => envelope(() => drillClean({ tempDir: context.experimental_paths.tempDir })),
    check: ({ root, keep }, context) => envelope(() => runCheck({ source: root, dataDir: context.experimental_paths.dataDir, tempDir: context.experimental_paths.tempDir, keep: keep ?? false, watch: context.experimental_watch.bind(context) })),
  },
  dispose: async () => {
    for (const subscription of watches.values()) await subscription.then((value) => value.dispose()).catch(() => undefined);
    watches.clear();
    await disposeParsePool();
  },
});

export default { ...entry, handlers: abortable(entry.handlers) };
