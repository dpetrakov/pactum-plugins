// Batch lifecycle on the host of the checkout (EP-009-T02…T05, EP-010-T02). Every step runs inside the
// service's serial queue, re-checks the checkout and writes one operation. DR-01: one unfinished run per checkout
// (journal) plus a local launch record from preparation until the run is finished or explicitly recovered.
import ignore from "ignore";
import { canonicalBytes } from "../core/canonical-json.ts";
import { candidates, confirmedEdits, waitsForUser, finishOutcome, inputRevision, latestResultOf, latestResults, linkedEdits, resultCounts, runsOf, type RunView, unfinishedRuns } from "../core/batch.ts";
import { discussion, itemIdFor, nextItem, skipRequested } from "../core/discussion.ts";
import { newId, sha256 } from "../core/hash.ts";
import { entity, revisionObject, type State } from "../core/journal.ts";
import { quoteAt } from "../core/markdown/index.ts";
import { projectFile } from "../core/formats/project.ts";
import { FORMATS, formatOf } from "../core/formats/registry.ts";
import { dottedPath, jqPath, jsonPointer, keyPathString, parseKeyPath } from "../core/formats/paths.ts";
import { maskPersonal } from "./content.ts";
import { tr } from "../core/i18n.ts";
import { type ObjectValue, type Operation, SCHEMA_VERSION } from "../core/schema.ts";
import type { CpRange, Revision } from "../core/types.ts";
import type { LaunchRecord } from "./launch.ts";
import { type Expectation, ReviewError, type ReviewService } from "./service.ts";
import { anchorOf, currentBuilt, persistentBuilt, snapshotText } from "./view.ts";

export type Scope = { kind: "document"; path: string } | { kind: "all" } | { kind: "annotation"; annotationId: string };
export type Recipient = { mode: "current-thread" | "new-thread"; threadId: string | null };
export type AgentActor = { model: string; threadId: string | null };

const PAGE = 20;

function changedSince(a: Revision | null, b: Revision): number {
  const before = new Set((a?.blocks ?? []).map((block) => block.versionId));
  const removed = a ? a.blocks.filter((block) => !b.blocks.some((other) => other.lineageId === block.lineageId)).length : 0;
  return b.blocks.filter((block) => !before.has(block.versionId)).length + removed;
}

/** Tracked documents and their current sha256 (for edits outside the batch, AC20). */
async function trackedShas(service: ReviewService): Promise<Record<string, string>> {
  const config = (await service.config()).value;
  if (!config) return {};
  const shas: Record<string, string> = {};
  const docs = await service.trackedDocuments(config);
  const values = await Promise.all(docs.map((doc) => service.documentSha(doc.path)));
  docs.forEach((doc, index) => { if (values[index]) shas[doc.path] = values[index]!; });
  return shas;
}

/** Promote the current bytes of a document as a batch input/output revision (DR-03: snapshot before event). */
async function promoteCurrent(service: ReviewService, state: State, path: string, reason: "batch-input" | "batch-output") {
  const current = await service.readDocument(path, { record: false });
  return service.promote(state, path, current.docId, { sha: current.sha }, "receipt", reason);
}

function scopeLabel(scope: RunView["scope"]): string {
  return scope?.kind === "document" ? "document" : scope?.kind === "annotation" ? "annotation" : "all";
}

/** Status of batches in the checkout for the UI: unfinished run(s), launch record, last finished run summary. */
export async function batchStatus(service: ReviewService) {
  const info = await service.checkout();
  const config = info.isRepo ? (await service.config()).value : null;
  const launch = await service.launch.get();
  if (!config) return { enabled: false, active: null, launch, recent: [], newInstructions: { document: {}, all: 0 } };
  const state = await service.state(info);
  // Journal order is causal, not chronological: merged branches interleave. The latest round, active batch and the
  // last thread are chosen by time.
  const runs = [...runsOf(state)].sort((a, b) => a.preparedAt.localeCompare(b.preparedAt));
  const unfinished = runs.filter((run) => !run.finished);
  const byFinish = runs.filter((run) => run.finished).sort((a, b) => a.finished!.timestamp.localeCompare(b.finished!.timestamp));
  const summarize = (run: RunView) => {
    const latest = latestResults(run);
    return {
      runId: run.runId, preparedAt: run.preparedAt, scope: scopeLabel(run.scope),
      documents: run.documents.map((doc) => doc.path), requestedBy: run.requestedBy,
      items: run.items.map((item) => ({ itemId: item.itemId, annotationId: item.annotationId, status: latest.get(item.itemId)?.status ?? null })),
      answered: run.items.filter((item) => latest.has(item.itemId)).length, total: run.items.length,
      attempts: run.attempts, finished: run.finished, counts: resultCounts(run),
    };
  };
  // «Send to agent N»: annotations with new instructions per document and in the whole checkout (DR-04).
  const perDoc: Record<string, number> = {};
  let all = 0;
  for (const view of candidates(state, { kind: "all" })) {
    const path = view.docId ? state.documents.get(view.docId)?.path ?? null : null;
    if (path) perDoc[path] = (perDoc[path] ?? 0) + 1;
    all++;
  }
  return {
    enabled: true,
    active: unfinished.length ? summarize(unfinished[unfinished.length - 1]) : null,
    unfinished: unfinished.length,
    launch: launch && runs.some((run) => run.runId === launch.runId && !run.finished) ? launch : launch && !runs.some((run) => run.runId === launch.runId) ? launch : null,
    recent: byFinish.slice(-5).reverse().map(summarize),
    lastThreadId: runs.flatMap((run) => run.attempts).filter((attempt) => attempt.threadId).sort((a, b) => a.timestamp.localeCompare(b.timestamp)).pop()?.threadId ?? null,
    newInstructions: { document: perDoc, all },
  };
}

/**
 * Prepare a batch (DR-01, DR-04): refuses while another run of this checkout is unfinished or a launch is
 * unresolved; one item per candidate annotation with its slice up to seenHeads; input snapshots of the documents;
 * immutable manifest; then a local launch record «dispatching» that holds the checkout until recovery.
 */
export async function prepareBatch(service: ReviewService, input: { scope: Scope; recipient: Recipient } & Expectation) {
  return service.serial(async () => {
    const { actor, state } = await service.writable(input);
    if (actor.kind !== "human") throw new ReviewError("bad-input", "a batch is sent by a person");
    const busy = unfinishedRuns(state);
    if (busy.length) throw new ReviewError("busy", "another batch of this checkout is not finished yet; new instructions wait for it (DR-01)", { runId: busy[busy.length - 1].runId });
    const launch = await service.launch.get();
    if (launch) throw new ReviewError("busy", `the previous dispatch (${launch.state}) is not resolved; recover it first`, { runId: launch.runId, state: launch.state });
    const config = (await service.config()).value!;
    let scope: RunView["scope"];
    if (input.scope.kind === "document") {
      const docId = service.docIdOf(state, input.scope.path);
      if (!docId) throw new ReviewError("nothing-to-send", "the document has no annotations yet");
      scope = { kind: "document", docId };
    } else scope = input.scope;
    const chosen = candidates(state, scope!);
    if (!chosen.length) throw new ReviewError("nothing-to-send", "no annotation with new instructions in this scope");
    const runId = newId();
    const attemptId = newId();
    const items = chosen.map((view) => nextItem(state, view.annotationId, runId)).filter((item): item is NonNullable<typeof item> => item !== null);
    if (!items.length) throw new ReviewError("nothing-to-send", "no annotation with new instructions in this scope");
    const docIds = [...new Set(chosen.map((view) => view.docId).filter((id): id is string => Boolean(id)))];
    const changes: Operation["changes"] = [];
    const objects: ObjectValue[] = [];
    const snapshots: Uint8Array[] = [];
    const documents: { docId: string; path: string; revisionId: string }[] = [];
    for (const docId of docIds) {
      const path = state.documents.get(docId)?.path;
      if (!path) continue;
      const promoted = await promoteCurrent(service, state, path, "batch-input");
      changes.push(...promoted.changes);
      objects.push(...promoted.objects);
      snapshots.push(...promoted.snapshots);
      documents.push({ docId, path, revisionId: promoted.revision.revisionId });
    }
    const manifest = {
      type: "BatchManifest", schemaVersion: SCHEMA_VERSION, runId, scope, editScope: config.roots,
      documents: documents.sort((a, b) => (a.path < b.path ? -1 : 1)),
      items: items.map(({ itemId, annotationId, seenHeads }) => ({ itemId, annotationId, seenHeads })),
      requestedBy: { name: actor.name, email: actor.email },
    } as ObjectValue;
    changes.push({ type: "batch.prepared", runId, manifest: sha256(canonicalBytes(manifest)), items: items.map(({ itemId, annotationId, seenHeads }) => ({ itemId, annotationId, seenHeads })) });
    // The launch record first: if the host dies after the event, the checkout stays held until reconciliation.
    const record: LaunchRecord = { runId, attemptId, state: "dispatching", recipient: input.recipient, queuedMessageId: null,
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reason: null, shas: await trackedShas(service) };
    await service.launch.put(record);
    try {
      await service.commit(state, actor, changes, [...objects, manifest], snapshots);
    } catch (error) {
      await service.launch.clear(runId);
      throw error;
    }
    return { runId, attemptId, items: items.length, documents: documents.map((doc) => doc.path), requestedBy: { name: actor.name, email: actor.email } };
  });
}

/**
 * Summary before sending (E15, EP-012-T01): for the scope, the documents with new instructions, which of them are
 * hidden by the visibility rules, and the instructions whose place needs attention (approximate / ambiguous /
 * orphaned, or a deleted document). It warns, it never blocks.
 */
export async function sendSummary(service: ReviewService, input: { scope: Scope }) {
  const info = await service.checkout();
  const config = info.isRepo ? (await service.config()).value : null;
  if (!config) return { total: 0, documents: [], hidden: 0, lost: 0 };
  const state = await service.state(info);
  let scope: RunView["scope"];
  if (input.scope.kind === "document") {
    const docId = service.docIdOf(state, input.scope.path);
    if (!docId) return { total: 0, documents: [], hidden: 0, lost: 0 };
    scope = { kind: "document", docId };
  } else scope = input.scope;
  const hiddenRules = ignore().add(config.hidden);
  const groups = new Map<string, { path: string; count: number; hidden: boolean; lost: number; missing: boolean }>();
  const built = new Map<string, Awaited<ReturnType<typeof currentBuilt>> | null>();
  for (const view of candidates(state, scope!)) {
    const path = view.docId ? state.documents.get(view.docId)?.path ?? null : null;
    if (!path) continue;
    const group = groups.get(path) ?? { path, count: 0, hidden: hiddenRules.ignores(path), lost: 0, missing: false };
    group.count++;
    if (!built.has(path)) {
      const current = await service.readDocument(path).catch(() => null);
      built.set(path, current ? await currentBuilt(service, state, current).catch(() => null) : null);
    }
    const current = built.get(path);
    if (!current) {
      group.missing = true;
      group.lost++;
    } else {
      const created = state.byEntity.get(entity.annotation(view.annotationId))?.map((id) => state.events.get(id)!).flatMap((operation) => operation.changes).find((change) => change.type === "annotation.created");
      const object = created && created.type === "annotation.created" ? state.objects.get(created.annotation) : undefined;
      if (object?.type === "Annotation") {
        const anchor = await anchorOf(service, state, object, current, new Map());
        if (["approximate", "ambiguous", "orphaned"].includes(anchor.status) && !object.target["bbdr:tombstoneId"]) group.lost++;
      }
    }
    groups.set(path, group);
  }
  const documents = [...groups.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  return { total: documents.reduce((sum, doc) => sum + doc.count, 0), documents, hidden: documents.filter((doc) => doc.hidden).length, lost: documents.reduce((sum, doc) => sum + doc.lost, 0) };
}

/** The dispatch reached bb: queued in a busy thread or sent (EP-009-T03). */
export async function markDispatched(service: ReviewService, input: { runId: string; attemptId: string; recipient: Recipient; delivery: "queued" | "sent"; queuedMessageId?: string | null }) {
  return service.serial(async () => {
    const { actor, state } = await service.writable({});
    const run = runsOf(state).find((candidate) => candidate.runId === input.runId);
    if (!run) throw new ReviewError("not-found", "no such batch");
    if (!run.attempts.some((attempt) => attempt.attemptId === input.attemptId)) {
      await service.commit(state, actor, [{ type: "batch.dispatched", runId: input.runId, attemptId: input.attemptId, recipient: input.recipient }], [], []);
    }
    await service.launch.update(input.runId, { state: input.delivery, attemptId: input.attemptId, recipient: input.recipient, queuedMessageId: input.queuedMessageId ?? null, reason: null });
    return { runId: input.runId, attemptId: input.attemptId, delivery: input.delivery };
  });
}

/** The outcome of the dispatch is unknown (timeout): nothing is retried automatically (AC11, architecture §8). */
export async function markUnknown(service: ReviewService, input: { runId: string; reason: string }) {
  return service.serial(async () => ({ launch: await service.launch.update(input.runId, { state: "dispatch-unknown", reason: input.reason.slice(0, 500) }) }));
}

/**
 * End a run without agent work: a dispatch that certainly failed, an explicit cancel of an undelivered batch, or
 * the user's recovery of an unknown dispatch. The journal records the outcome; the checkout is released.
 */
export async function abandonRun(service: ReviewService, input: { runId: string; outcome: "failed" | "cancelled"; reason?: string } & Expectation) {
  return service.serial(async () => {
    const { actor, state } = await service.writable(input);
    const run = runsOf(state).find((candidate) => candidate.runId === input.runId);
    const launch = await service.launch.get();
    if (!run) {
      if (launch?.runId === input.runId) await service.launch.clear(input.runId);
      throw new ReviewError("not-found", "no such batch");
    }
    if (run.finished) {
      await service.launch.clear(input.runId);
      return { runId: input.runId, outcome: run.finished.outcome, status: "already-finished" as const };
    }
    const attemptId = run.attempts[run.attempts.length - 1]?.attemptId ?? (launch?.runId === input.runId ? launch.attemptId : newId());
    await service.commit(state, actor, [{ type: "batch.finished", runId: input.runId, attemptId, outcome: input.outcome }], [], []);
    await service.launch.clear(input.runId);
    return { runId: input.runId, outcome: input.outcome, status: "finished" as const };
  });
}

/**
 * The agent of a thread answers a run that has no recorded attempt (the spawn timed out but bb created the thread):
 * its answer proves delivery, so the attempt of the launch record is recorded first (AC11 — no second executor).
 */
async function deliveredBy(service: ReviewService, state: State, run: RunView, agent: AgentActor): Promise<string | null> {
  const launch = await service.launch.get();
  if (!launch || launch.runId !== run.runId || !agent.threadId) return null;
  if (launch.recipient.threadId && launch.recipient.threadId !== agent.threadId) throw new ReviewError("foreign-thread", "this batch was sent to another thread");
  const { actor } = await service.writable({});
  await service.commit(state, actor, [{ type: "batch.dispatched", runId: run.runId, attemptId: launch.attemptId, recipient: { mode: launch.recipient.mode, threadId: agent.threadId } }], [], []);
  await service.launch.update(run.runId, { state: "sent", recipient: { mode: launch.recipient.mode, threadId: agent.threadId }, queuedMessageId: null, reason: null });
  return launch.attemptId;
}

/** Run of a batch for the agent; the thread must be the run's recipient when one is known. */
function runFor(state: State, runId: string, threadId: string | null): RunView {
  const run = runsOf(state).find((candidate) => candidate.runId === runId);
  if (!run) throw new ReviewError("not-found", `no batch ${runId} in this checkout`);
  const recipients = run.attempts.map((attempt) => attempt.threadId).filter(Boolean);
  if (threadId && recipients.length && !recipients.includes(threadId)) throw new ReviewError("foreign-thread", "this batch was sent to another thread");
  // Not recorded yet: only the thread the launch was addressed to may act (checked in deliveredBy).
  return run;
}

/** The batch for the agent (review.batch.get): manifest, items with history and anchors, paged (E10). */
export async function batchGet(service: ReviewService, input: { runId?: string; page?: number; threadId: string | null }) {
  const info = await service.checkout();
  const state = await service.state(info);
  let run: RunView;
  if (input.runId) run = runFor(state, input.runId, input.threadId);
  else {
    const open = unfinishedRuns(state).filter((candidate) => !input.threadId || !candidate.attempts.length || candidate.attempts.some((attempt) => attempt.threadId === input.threadId));
    if (!open.length) throw new ReviewError("not-found", "no unfinished batch for this thread in this checkout");
    run = open[open.length - 1];
  }
  const page = Math.max(1, input.page ?? 1);
  const latest = latestResults(run);
  const slice = run.items.slice((page - 1) * PAGE, page * PAGE);
  const currents = new Map<string, Awaited<ReturnType<typeof currentBuilt>> | null>();
  const reads = new Map<string, Awaited<ReturnType<ReviewService["readDocument"]>> | null>();
  // This user's global secret extensions are masked in what the agent receives too (§8, F14).
  const personal = (path: string | null, value: string | null) => (value && path && reads.get(path) ? maskPersonal({ secrets: reads.get(path)!.secrets ?? [], text: reads.get(path)!.text }, value) : value);
  const items = [];
  for (const item of slice) {
    const view = discussion(state, item.annotationId);
    const created = state.byEntity.get(entity.annotation(item.annotationId))?.map((id) => state.events.get(id)!).flatMap((operation) => operation.changes)
      .find((change) => change.type === "annotation.created");
    const object = created && created.type === "annotation.created" ? state.objects.get(created.annotation) : undefined;
    const annotation = object?.type === "Annotation" ? object : null;
    const path = view.docId ? state.documents.get(view.docId)?.path ?? null : null;
    let anchor: { status: string; currentText: string | null } = { status: "unknown", currentText: null };
    if (annotation && path) {
      if (!currents.has(path)) {
        const current = await service.readDocument(path).catch(() => null);
        reads.set(path, current);
        currents.set(path, current ? await currentBuilt(service, state, current) : null);
      }
      const built = currents.get(path);
      if (built) {
        const resolved = await anchorOf(service, state, annotation, built, new Map());
        anchor = { status: resolved.status, currentText: resolved.ranges.length ? resolved.ranges.map((range) => [...built.projection.text].slice(range.start, range.end).join("")).join(" … ").slice(0, 4000) : null };
      }
    }
    const slice0 = new Set(view.instructions.filter((instruction) => item.seenHeads.some((head) => head === instruction.eventId || state.isAncestorIn(entity.annotation(item.annotationId), instruction.eventId, head))).map((instruction) => instruction.eventId));
    const quote = annotation?.target.selector?.find((selector) => selector.type === "TextQuoteSelector") as { exact: string } | undefined;
    // W-06c (§10): the node of a structured file by its key path, the lines of a line-based one.
    const keySelector = annotation?.target.selector?.find((selector) => selector.type === "bbdr:KeyPathSelector") as { value: string } | undefined;
    const lineSelector = annotation?.target.selector?.find((selector) => selector.type === "bbdr:LineRangeSelector") as { start: number; end: number } | undefined;
    const keyPath = keySelector ? parseKeyPath(keySelector.value) : null;
    // W-06f (EP-073-T08): an element of an embedded object — the visualizer's id, its words and its lines in the block.
    const elementSelector = annotation?.target.selector?.find((selector) => selector.type === "bbdr:ObjectSelector") as { id: string; kind: string; label: string; range?: { line: number; start: number; end: number } } | undefined;
    items.push({
      itemId: item.itemId, annotationId: item.annotationId, path,
      targetKind: annotation?.target["bbdr:targetKind"] ?? null,
      ...(keyPath ? { keyPath: dottedPath(keyPath), jsonPointer: jsonPointer(keyPath) } : {}),
      ...(lineSelector ? { lines: { start: lineSelector.start, end: lineSelector.end } } : {}),
      ...(elementSelector ? { element: { id: elementSelector.id, kind: elementSelector.kind, label: personal(path, elementSelector.label), ...(elementSelector.range ? { lineInBlock: elementSelector.range.line } : {}) } } : {}),
      quote: personal(path, quote?.exact.slice(0, 4000) ?? null),
      removedBlock: Boolean(annotation?.target["bbdr:tombstoneId"]),
      anchor: { status: anchor.status, note: anchor.status === "ambiguous" || anchor.status === "orphaned" || anchor.status === "approximate" ? tr("location unclear: do not edit by guesswork, return needs-input", "место неясно: не правьте по догадке, верните needs-input") : null, currentText: personal(path, anchor.currentText) },
      skipRequested: skipRequested(view),
      answered: latest.get(item.itemId)?.status ?? null,
      messages: view.messages.flatMap((message) => message.revisions.map((revision) => ({
        role: message.role, author: revision.actor.kind === "human" ? revision.actor.name : `agent ${revision.actor.model}`,
        text: revision.text, at: revision.timestamp, newInstruction: message.role === "human" && slice0.has(revision.eventId) && !view.instructions.find((instruction) => instruction.eventId === revision.eventId)?.covered,
      }))),
    });
  }
  return {
    runId: run.runId, attemptId: run.attempts[run.attempts.length - 1]?.attemptId ?? null,
    requestedBy: run.requestedBy, editScope: run.editScope, scope: scopeLabel(run.scope),
    documents: run.documents.map((doc) => ({ path: doc.path, inputRevision: doc.revisionId })),
    registeredInputs: run.inputs.map((entry) => ({ path: state.documents.get(entry.docId)?.path ?? null, revisionId: entry.revisionId })),
    finished: run.finished?.outcome ?? null,
    page, pages: Math.max(1, Math.ceil(run.items.length / PAGE)), totalItems: run.items.length, items,
  };
}

/** A document for the agent (review.document.get): current text and where annotations of open items point. */
export async function documentGet(service: ReviewService, input: { path: string; offset?: number; limit?: number }) {
  const current = await service.readDocument(input.path);
  const offset = Math.max(0, input.offset ?? 0);
  const limit = Math.min(Math.max(1, input.limit ?? 200_000), 400_000);
  // Secret values are masked (W-06c, §8): the shared redaction plus this user's global extensions.
  const full = current.personalText ?? current.text;
  const text = full.slice(offset, offset + limit);
  return { path: current.path, sha: current.sha, size: current.size, offset, returned: text.length, totalChars: full.length, truncated: offset + text.length < full.length, text,
    ...(current.secrets?.length ? { secretsMasked: current.secrets.length, note: "values of secrets are masked as ••••••••; never write a mask into the file — leave masked values as they are" } : {}) };
}

/** Whole history of one annotation (review.discussion.get). */
export async function discussionGet(service: ReviewService, input: { annotationId: string }) {
  const state = await service.state();
  const view = discussion(state, input.annotationId);
  if (view.status === null) throw new ReviewError("not-found", "no such annotation");
  return {
    annotationId: view.annotationId, status: view.status, kind: view.kind, path: view.docId ? state.documents.get(view.docId)?.path ?? null : null,
    messages: view.messages.flatMap((message) => message.revisions.map((revision) => ({ role: message.role, text: revision.text, at: revision.timestamp, runId: revision.runId ?? null }))),
    items: view.items.map((item) => ({ runId: item.runId, itemId: item.itemId, results: item.results.map((result) => ({ status: result.status, responseId: result.responseId })) })),
  };
}

function agentActor(run: RunView, agent: AgentActor): Operation["actor"] {
  if (!run.requestedBy) throw new ReviewError("incomplete", "the batch manifest is missing");
  return { kind: "agent", model: agent.model.slice(0, 256) || "agent", threadId: agent.threadId, requestedBy: run.requestedBy };
}

/** DR-01: a document outside the input manifest is registered before the agent's first edit. */
export async function registerInput(service: ReviewService, input: { runId: string; path: string; agent: AgentActor }) {
  return service.serial(async () => {
    const { state } = await service.writable({});
    const run = runFor(state, input.runId, input.agent.threadId);
    if (run.finished) throw new ReviewError("finished", "the batch is finished");
    const config = (await service.config()).value!;
    if (!service.insideRoots(config, input.path)) throw new ReviewError("outside-roots", `outside the review roots (${config.roots.join(", ")}): ask the user (needs-input)`);
    const docId = service.docIdOf(state, input.path);
    if (docId && inputRevision(run, docId)) return { path: input.path, status: "already-input" as const, revisionId: inputRevision(run, docId) };
    const promoted = await promoteCurrent(service, state, input.path, "batch-input");
    const changes: Operation["changes"] = [...promoted.changes, { type: "batch.input-registered", runId: input.runId, docId: promoted.revision.docId, revisionId: promoted.revision.revisionId }];
    await service.commit(state, agentActor(run, input.agent), changes, promoted.objects, promoted.snapshots);
    return { path: input.path, status: "registered" as const, revisionId: promoted.revision.revisionId };
  });
}

/** The node of a structured file at a key path in any of the forms people copy (dotted, JSON Pointer, jq, JSON array). */
function claimKeyPath(projection: ReturnType<typeof projectFile>, keyPath: string): CpRange | string {
  const wanted = keyPath.trim();
  const found = projection.meta.flatMap((entry, index) => (entry?.path && [dottedPath(entry.path, "document"), dottedPath(entry.path, "документ"), jsonPointer(entry.path), jqPath(entry.path), keyPathString(entry.path)].includes(wanted) ? [index] : []));
  if (!found.length) return projection.profile === "bbdr-structured" ? `key path not found in the new text: ${wanted.slice(0, 200)}` : "a key path names a node of a YAML/JSON/TOML file; quote the new text instead";
  const block = projection.blocks[found[found.length - 1]];
  return { start: block.range.start, end: block.range.end };
}

/** Find a quote in a projection; it must occur exactly once (a longer quote disambiguates). */
function claimRange(text: string, quote: string): CpRange | string {
  if (!quote.trim()) return "empty quote";
  const first = text.indexOf(quote);
  if (first < 0) return "quote not found in the current text of the document (quote the rendered text, not Markdown markup)";
  if (text.indexOf(quote, first + 1) >= 0) return "quote occurs more than once: quote a longer, unique passage";
  const start = [...text.slice(0, first)].length;
  return { start, end: start + [...quote].length };
}

/**
 * review.item.reply: the agent's answer to one item (DR-04). Idempotent by runId+attemptId+itemId+responseId; the
 * result covers the item's prepared slice, never later messages; a late answer to a closed annotation is history only.
 */
export async function itemReply(service: ReviewService, input: {
  runId: string; attemptId?: string; itemId: string; responseId: string; status: "done" | "needs-input" | "failed" | "skipped";
  text: string; edits?: { path: string; quote?: string; keyPath?: string }[]; agent: AgentActor;
}) {
  return service.serial(async () => {
    let { state } = await service.writable({});
    let run = runFor(state, input.runId, input.agent.threadId);
    if (run.finished) throw new ReviewError("finished", `batch ${input.runId} is ${run.finished.outcome}; results are not accepted any more`);
    const item = run.items.find((candidate) => candidate.itemId === input.itemId);
    if (!item) throw new ReviewError("not-found", `no item ${input.itemId} in batch ${input.runId}`);
    // The agent's key may be any string; the stored responseId is a UUID derived from run, item and that key.
    const hex = sha256(`${input.runId}\n${input.itemId}\n${input.responseId}`);
    const responseId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    const existing = run.results.find((result) => result.itemId === input.itemId && result.responseId === responseId);
    if (existing) return { status: "duplicate" as const, eventId: existing.eventId, itemId: input.itemId };
    const attemptId = input.attemptId ?? run.attempts[run.attempts.length - 1]?.attemptId ?? (await deliveredBy(service, state, run, input.agent));
    if (!attemptId) throw new ReviewError("bad-input", "the batch has no dispatch attempt yet");
    if (!run.attempts.length) {
      state = await service.state();
      run = runFor(state, input.runId, input.agent.threadId);
    }
    const view = discussion(state, item.annotationId);
    const docPath = view.docId ? state.documents.get(view.docId)?.path ?? null : null;
    for (const edit of input.edits ?? []) {
      const editDoc = service.docIdOf(state, edit.path);
      if (!editDoc || !inputRevision(run, editDoc)) throw new ReviewError("not-input", `${edit.path} is not a document of this batch: register it with input register before editing (DR-01)`);
    }
    const paths = [...new Set([...(docPath ? [docPath] : []), ...(input.edits ?? []).map((edit) => edit.path)])];
    const changes: Operation["changes"] = [];
    const objects: ObjectValue[] = [];
    const snapshots: Uint8Array[] = [];
    const after = new Map<string, Revision>();
    for (const path of paths) {
      const current = await service.readDocument(path).catch(() => null);
      if (!current) {
        if (path === docPath) continue;
        throw new ReviewError("bad-input", `no such document: ${path}`);
      }
      const promoted = await service.promote(state, path, current.docId, { sha: current.sha }, "receipt", "batch-output");
      changes.push(...promoted.changes);
      objects.push(...promoted.objects);
      snapshots.push(...promoted.snapshots);
      after.set(path, promoted.revision);
    }
    const claimedEdits: { docId: string; revisionId: string; range: CpRange }[] = [];
    const rejected: string[] = [];
    for (const edit of input.edits ?? []) {
      const revision = after.get(edit.path)!;
      const text = await snapshotText(service, revision.snapshot) ?? (await service.readDocument(edit.path)).text;
      const projection = projectFile(edit.path, text);
      const range = edit.keyPath ? claimKeyPath(projection, edit.keyPath) : claimRange(projection.text, edit.quote ?? "");
      if (typeof range === "string") {
        rejected.push(`${edit.path}: ${range}`);
        continue;
      }
      claimedEdits.push({ docId: revision.docId, revisionId: revision.revisionId, range });
    }
    if (rejected.length) throw new ReviewError("bad-claim", `claimed edits could not be located: ${rejected.join("; ")}`);
    const before = [...new Set([...after.values()].map((revision) => inputRevision(run, revision.docId)).filter((id): id is string => Boolean(id)))];
    const messageId = newId();
    changes.push({ type: "message.appended", annotationId: item.annotationId, messageId, text: input.text, runId: input.runId, itemId: input.itemId });
    changes.push({ type: "item.result-recorded", runId: input.runId, attemptId, itemId: input.itemId, responseId, annotationId: item.annotationId,
      status: input.status, seenHeads: item.seenHeads, messageId, before, after: [...new Set([...after.values()].map((revision) => revision.revisionId))], claimedEdits });
    const { operation } = await service.commit(state, agentActor(run, input.agent), changes, objects, snapshots);
    // What the user will see as linked: claims confirmed by the text (unconfirmed ones are not shown).
    let confirmed = 0;
    for (const claim of claimedEdits) {
      const out = [...after.values()].find((revision) => revision.revisionId === claim.revisionId)!;
      const inputId = inputRevision(run, claim.docId);
      const input0 = inputId ? (revisionObject(state, inputId) as Revision | null) : null;
      confirmed += confirmedEdits(input0, out, [claim.range]).length;
    }
    return { status: "recorded" as const, eventId: operation.id, itemId: input.itemId, claimed: claimedEdits.length, confirmedBlocks: confirmed,
      note: skipRequested(view) ? "the annotation was closed or turned into a note: your answer is kept as history only" : null };
  });
}

/**
 * review.batch.finish: results are checked against the manifest (missing → partial), documents are re-read and
 * output revisions recorded (manifest documents, registered inputs and tracked documents changed during the run).
 */
export async function finishBatch(service: ReviewService, input: { runId: string; attemptId?: string; agent: AgentActor | null } & Expectation) {
  return service.serial(async () => {
    const { actor: human, state } = await service.writable(input);
    const run = runFor(state, input.runId, input.agent?.threadId ?? null);
    if (run.finished) return { runId: run.runId, status: "already-finished" as const, outcome: run.finished.outcome };
    const launchRecord = await service.launch.get();
    const attemptId = input.attemptId ?? run.attempts[run.attempts.length - 1]?.attemptId ?? (launchRecord?.runId === run.runId ? launchRecord.attemptId : null);
    if (!attemptId) throw new ReviewError("bad-input", "the batch was never dispatched");
    const launch = await service.launch.get();
    const shasAtStart = launch?.runId === run.runId ? launch.shas : {};
    const paths = new Set<string>([...run.documents.map((doc) => doc.path), ...run.inputs.map((entry) => state.documents.get(entry.docId)?.path).filter((path): path is string => Boolean(path))]);
    const config = (await service.config()).value!;
    const untracked = ignore().add(config.untracked);
    const tracked = (await service.trackedDocuments(config)).filter((doc) => !paths.has(doc.path) && !untracked.ignores(doc.path));
    const nowShas = await Promise.all(tracked.map((doc) => service.documentSha(doc.path)));
    tracked.forEach((doc, index) => {
      const sha = nowShas[index];
      if (sha && shasAtStart[doc.path] !== undefined && shasAtStart[doc.path] !== sha) paths.add(doc.path);
      if (sha && shasAtStart[doc.path] === undefined && Object.keys(shasAtStart).length) paths.add(doc.path);
    });
    const changes: Operation["changes"] = [];
    const objects: ObjectValue[] = [];
    const snapshots: Uint8Array[] = [];
    for (const path of [...paths].sort()) {
      const current = await service.readDocument(path).catch(() => null);
      if (!current) continue;
      const promoted = await service.promote(state, path, current.docId, { sha: current.sha }, "receipt", "batch-output");
      changes.push(...promoted.changes);
      // An unchanged document reuses its revision: record the output explicitly so the round summary can name it.
      if (!promoted.changes.some((change) => change.type === "document.observed")) {
        const object = state.revisions.get(promoted.revision.revisionId);
        if (object) changes.push({ type: "document.observed", docId: promoted.revision.docId, revisionId: promoted.revision.revisionId, revision: object.objectSha, reason: "batch-output" });
      }
      objects.push(...promoted.objects);
      snapshots.push(...promoted.snapshots);
    }
    const outcome = finishOutcome(run);
    changes.push({ type: "batch.finished", runId: run.runId, attemptId, outcome });
    const actor = input.agent ? agentActor(run, input.agent) : human;
    const { operation } = await service.commit(state, actor, dedupeObserved(changes), objects, snapshots);
    await service.launch.clear(run.runId);
    const after = await service.state();
    return { runId: run.runId, status: "finished" as const, outcome, eventId: operation.id, summary: await roundSummary(service, after, run.runId) };
  });
}

/** document.observed of the same revision twice in one operation is pointless; keep the first. */
function dedupeObserved(changes: Operation["changes"]): Operation["changes"] {
  const seen = new Set<string>();
  return changes.filter((change) => {
    if (change.type !== "document.observed") return true;
    if (seen.has(change.revisionId)) return false;
    seen.add(change.revisionId);
    return true;
  });
}

/** Round summary (E16): results by kind, changed blocks per document, edits outside the batch documents. */
export async function roundSummary(service: ReviewService, state: State, runId: string) {
  const run = runsOf(state).find((candidate) => candidate.runId === runId);
  if (!run) throw new ReviewError("not-found", "no such batch");
  const inputDocs = new Set([...run.documents.map((doc) => doc.docId), ...run.inputs.map((entry) => entry.docId)]);
  const documents = [];
  let changedBlocks = 0;
  for (const output of run.outputs) {
    const outRevision = revisionObject(state, output.revisionId) as Revision | null;
    if (!outRevision) continue;
    const inputId = inputRevision(run, output.docId);
    const inRevision = inputId ? (revisionObject(state, inputId) as Revision | null) : null;
    // Outside documents: changed relative to their latest revision before the run (if any).
    const changed = inRevision ? changedSince(inRevision, outRevision) : outRevision.parents.length
      ? changedSince(revisionObject(state, outRevision.parents[0]) as Revision | null, outRevision) : outRevision.blocks.length;
    if (!changed && inputDocs.has(output.docId)) {
      documents.push({ path: outRevision.path, inBatch: true, changedBlocks: 0 });
      continue;
    }
    changedBlocks += changed;
    documents.push({ path: outRevision.path, inBatch: inputDocs.has(output.docId), changedBlocks: changed });
  }
  const latest = latestResults(run);
  const items = run.items.map((item) => {
    const result = latest.get(item.itemId) ?? null;
    return { itemId: item.itemId, annotationId: item.annotationId, status: result?.status ?? null,
      linked: result ? linkedEdits(state, run, result).reduce((sum, entry) => sum + entry.versions.length, 0) : 0,
      claimed: result?.claimedEdits.length ?? 0 };
  });
  // W-06c (§10): a structured file of the round that no longer parses — a warning with the line, read from the current
  // file (redacted form), so it goes away by itself once the file is fixed.
  const parseErrors: { path: string; line: number; message: string }[] = [];
  for (const doc of documents) {
    const format = formatOf(doc.path);
    if (!format || FORMATS[format].profile !== "bbdr-structured") continue;
    const current = await service.readDocument(doc.path, { record: false }).catch(() => null);
    const error = current?.parseError ?? null;
    if (error) parseErrors.push({ path: doc.path, line: error.line, message: error.message.slice(0, 300) });
  }
  return {
    runId, outcome: run.finished?.outcome ?? null, counts: resultCounts(run), changedBlocks,
    documents: documents.filter((doc) => doc.changedBlocks > 0 || doc.inBatch),
    outside: documents.filter((doc) => !doc.inBatch && doc.changedBlocks > 0).map((doc) => doc.path),
    items, parseErrors,
  };
}

/**
 * «Accept» (DR-04, EP-010-T02): one operation with discussion.closed and read.acknowledged (scope accept) for the
 * confirmed linked versions that are shown. Refused as stale when the annotation moved on after the shown result;
 * then the UI may offer to confirm only the shown edits.
 */
export async function accept(service: ReviewService, input: { annotationId: string; expectedHeads: string[]; resultEventId: string | null; path: string;
  observation: { sha: string }; blocks: number[] } & Expectation) {
  return service.serial(async () => {
    const { readerId, actor, state } = await service.writable(input);
    const heads = state.heads.get(entity.annotation(input.annotationId)) ?? [];
    const view = discussion(state, input.annotationId);
    const latest = latestResultOf(state, input.annotationId);
    if ([...heads].sort().join() !== [...input.expectedHeads].sort().join() || (latest?.result.eventId ?? null) !== input.resultEventId) {
      throw new ReviewError("stale", "the annotation has a newer message or result than the one shown; it is not closed by the old button", { heads });
    }
    if (view.status !== "open") throw new ReviewError("transition", "not open");
    const changes: Operation["changes"] = [{ type: "discussion.closed", annotationId: input.annotationId }];
    let receiptId: string | null = null;
    let objects: ObjectValue[] = [];
    let snapshots: Uint8Array[] = [];
    let confirmed = 0;
    if (latest && input.blocks.length) {
      const linked = linkedEdits(state, latest.run, latest.result);
      const allowed = new Set(linked.flatMap((entry) => entry.versions.map((version) => version.versionId)));
      const docId = service.docIdOf(state, input.path);
      const promoted = await service.promote(state, input.path, docId, input.observation, "receipt");
      const versions = input.blocks.map((index) => promoted.revision.blocks[index]).filter((block) => block && allowed.has(block.versionId))
        .map((block) => ({ lineageId: block.lineageId, versionId: block.versionId }));
      if (versions.length) {
        receiptId = newId();
        confirmed = versions.length;
        changes.unshift(...promoted.changes);
        changes.push({ type: "read.acknowledged", receiptId, readerId, docId: promoted.revision.docId, revisionId: promoted.revision.revisionId, scope: "accept", versions, tombstones: [] });
        objects = promoted.objects;
        snapshots = promoted.snapshots;
      }
    }
    const { operation } = await service.commit(state, actor, changes, objects, snapshots);
    return { eventId: operation.id, receiptId, confirmed };
  });
}

/**
 * Undo of «Accept» (DR-02): two addressed parts. The receipt is revoked; the discussion is reopened only if it is
 * still closed by this very acceptance — a later decision is never overwritten.
 */
export async function undoAccept(service: ReviewService, input: { annotationId: string; acceptEventId: string; receiptId: string | null } & Expectation) {
  return service.serial(async () => {
    const { readerId, actor, state } = await service.writable(input);
    const changes: Operation["changes"] = [];
    if (input.receiptId) changes.push({ type: "read.revoked", receiptId: input.receiptId, readerId });
    const heads = state.heads.get(entity.annotation(input.annotationId)) ?? [];
    const reopen = heads.length === 1 && heads[0] === input.acceptEventId && discussion(state, input.annotationId).status === "closed";
    if (reopen) changes.push({ type: "discussion.reopened", annotationId: input.annotationId });
    if (!changes.length) return { status: "nothing" as const, reopened: false };
    const { operation } = await service.commit(state, actor, changes, [], []);
    return { status: "undone" as const, eventId: operation.id, reopened: reopen, revoked: Boolean(input.receiptId) };
  });
}

export { itemIdFor, persistentBuilt, quoteAt };

/**
 * Markdown documents under the roots with per-document signals (I1 for one checkout): open annotations, those
 * waiting for the user, annotations with new instructions and anchors that need attention are counted by the view.
 */
export async function documentsList(service: ReviewService) {
  const info = await service.checkout();
  const config = info.isRepo ? (await service.config()).value : null;
  if (!config) return { enabled: false, roots: [], documents: [], waiting: 0, candidates: 0 };
  const state = await service.state(info);
  const docs = await service.trackedDocuments({ ...config, untracked: [] });
  const counts = new Map<string, { open: number; waiting: number; candidates: number }>();
  let waiting = 0;
  let candidatesTotal = 0;
  for (const key of state.byEntity.keys()) {
    if (!key.startsWith("annotation:")) continue;
    const view = discussion(state, key.slice("annotation:".length));
    const path = view.docId ? state.documents.get(view.docId)?.path ?? null : null;
    if (!path) continue;
    const entry = counts.get(path) ?? { open: 0, waiting: 0, candidates: 0 };
    if (view.status === "open") entry.open++;
    if (waitsForUser(view)) {
      entry.waiting++;
      waiting++;
    }
    if (view.candidate) {
      entry.candidates++;
      candidatesTotal++;
    }
    counts.set(path, entry);
  }
  const untracked = ignore().add(config.untracked);
  return {
    enabled: true, roots: config.roots, waiting, candidates: candidatesTotal,
    documents: docs.map((doc) => ({ path: doc.path, size: doc.size, tracked: !untracked.ignores(doc.path), ...(counts.get(doc.path) ?? { open: 0, waiting: 0, candidates: 0 }) })),
  };
}
