// Batches and rounds (EP-009). Pure functions of the projected journal: what was prepared, sent, answered and
// finished; which run occupies a checkout (DR-01); which claimed edits are confirmed by the text (E4, AC20).
import { discussion, type DiscussionView, type ResultStatus } from "./discussion.ts";
import { entity, revisionObject, type State } from "./journal.ts";
import type { Actor, CpRange, GitIdentity, Revision } from "./types.ts";

export interface RunItem {
  itemId: string;
  annotationId: string;
  seenHeads: string[];
}

export interface RunResult {
  eventId: string;
  attemptId: string;
  itemId: string;
  responseId: string;
  annotationId: string;
  status: ResultStatus;
  messageId: string;
  before: string[];
  after: string[];
  claimedEdits: { docId: string; revisionId: string; range: CpRange }[];
  actor: Actor;
  timestamp: string;
}

export interface RunView {
  runId: string;
  preparedEvent: string;
  preparedAt: string;
  requestedBy: GitIdentity | null;
  scope: { kind: "document"; docId: string } | { kind: "all" } | { kind: "annotation"; annotationId: string } | null;
  editScope: string[];
  /** Input documents of the manifest (DR-01: the manifest is immutable). */
  documents: { docId: string; path: string; revisionId: string }[];
  items: RunItem[];
  attempts: { attemptId: string; eventId: string; mode: "current-thread" | "new-thread"; threadId: string | null; timestamp: string }[];
  /** Documents registered as additional inputs before the agent's first edit (DR-01). */
  inputs: { docId: string; revisionId: string; eventId: string }[];
  /** One result per responseId (redelivery is idempotent), in journal order. */
  results: RunResult[];
  finished: { attemptId: string; outcome: "completed" | "partial" | "failed" | "cancelled"; eventId: string; timestamp: string } | null;
  /** Output revisions observed by finish (reason batch-output), per document. */
  outputs: { docId: string; revisionId: string }[];
}

/** Every run of the checkout, in journal order. */
export function runsOf(state: State): RunView[] {
  const runs = new Map<string, RunView>();
  const outputsByEvent = new Map<string, { docId: string; revisionId: string }[]>();
  for (const eventId of state.order) {
    const operation = state.events.get(eventId)!;
    for (const change of operation.changes) {
      if (change.type === "document.observed" && change.reason === "batch-output") {
        outputsByEvent.set(eventId, [...(outputsByEvent.get(eventId) ?? []), { docId: change.docId, revisionId: change.revisionId }]);
      }
    }
    for (const change of operation.changes) {
      switch (change.type) {
        case "batch.prepared": {
          if (runs.has(change.runId)) break;
          const manifest = state.objects.get(change.manifest);
          const value = manifest?.type === "BatchManifest" ? manifest : null;
          runs.set(change.runId, {
            runId: change.runId, preparedEvent: eventId, preparedAt: operation.timestamp,
            requestedBy: value?.requestedBy ?? null, scope: value?.scope ?? null, editScope: value?.editScope ?? [],
            documents: value?.documents ?? [], items: change.items.map((item) => ({ ...item })),
            attempts: [], inputs: [], results: [], finished: null, outputs: [],
          });
          break;
        }
        case "batch.dispatched": {
          const run = runs.get(change.runId);
          if (run && !run.attempts.some((attempt) => attempt.attemptId === change.attemptId)) {
            run.attempts.push({ attemptId: change.attemptId, eventId, mode: change.recipient.mode, threadId: change.recipient.threadId, timestamp: operation.timestamp });
          }
          break;
        }
        case "batch.input-registered": {
          const run = runs.get(change.runId);
          if (run && !run.inputs.some((input) => input.docId === change.docId)) run.inputs.push({ docId: change.docId, revisionId: change.revisionId, eventId });
          break;
        }
        case "item.result-recorded": {
          const run = runs.get(change.runId);
          // Only items of the prepared manifest count; a result for anything else is history of nothing.
          if (!run || !run.items.some((item) => item.itemId === change.itemId && item.annotationId === change.annotationId)) break;
          if (run.results.some((result) => result.responseId === change.responseId && result.itemId === change.itemId)) break;
          run.results.push({ eventId, attemptId: change.attemptId, itemId: change.itemId, responseId: change.responseId, annotationId: change.annotationId,
            status: change.status, messageId: change.messageId, before: change.before, after: change.after, claimedEdits: change.claimedEdits,
            actor: operation.actor, timestamp: operation.timestamp });
          break;
        }
        case "batch.finished": {
          const run = runs.get(change.runId);
          if (run && !run.finished) {
            run.finished = { attemptId: change.attemptId, outcome: change.outcome, eventId, timestamp: operation.timestamp };
            run.outputs = outputsByEvent.get(eventId) ?? [];
          }
          break;
        }
        default: break;
      }
    }
  }
  return [...runs.values()];
}

/** Runs not yet finished: DR-01 allows at most one per checkout; more can only come from a Git merge. */
export function unfinishedRuns(state: State): RunView[] {
  return runsOf(state).filter((run) => !run.finished);
}

/** Latest result per item (the last recorded response). */
export function latestResults(run: RunView): Map<string, RunResult> {
  const latest = new Map<string, RunResult>();
  for (const result of run.results) latest.set(result.itemId, result);
  return latest;
}

/** Outcome of a finish: every item answered (skipped counts as an answer) → completed, else partial (E3). */
export function finishOutcome(run: RunView): "completed" | "partial" {
  const latest = latestResults(run);
  return run.items.every((item) => latest.has(item.itemId)) ? "completed" : "partial";
}

/** Count of results by kind for the round summary (E16). */
export function resultCounts(run: RunView): Record<ResultStatus | "missing", number> {
  const counts = { done: 0, "needs-input": 0, failed: 0, skipped: 0, missing: 0 };
  const latest = latestResults(run);
  for (const item of run.items) {
    const result = latest.get(item.itemId);
    if (result) counts[result.status]++;
    else counts.missing++;
  }
  return counts;
}

/**
 * Claimed edits confirmed by the text (E4): a claimed range of the output revision that overlaps a block whose
 * version is not in the input revision. A claim on unchanged text, outside the revision or on another document
 * confirms nothing. The result is recomputed from persistent revisions; nothing about it is stored.
 */
export function confirmedEdits(input: Revision | null, after: Revision, claims: CpRange[]): { lineageId: string; versionId: string; index: number }[] {
  const before = new Set((input?.blocks ?? []).map((block) => block.versionId));
  const found = new Map<string, { lineageId: string; versionId: string; index: number }>();
  for (const claim of claims) {
    after.blocks.forEach((block, index) => {
      if (before.has(block.versionId)) return;
      const overlaps = claim.start === claim.end
        ? claim.start >= block.range.start && claim.start <= block.range.end
        : claim.start < block.range.end && claim.end > block.range.start;
      const emptyBlock = block.range.start === block.range.end && claim.start <= block.range.start && claim.end >= block.range.end;
      if (overlaps || emptyBlock) found.set(block.versionId, { lineageId: block.lineageId, versionId: block.versionId, index });
    });
  }
  return [...found.values()].sort((a, b) => a.index - b.index);
}

/** Input revision of a document in a run: the manifest document, else a registered input. */
export function inputRevision(run: RunView, docId: string): string | null {
  return run.documents.find((doc) => doc.docId === docId)?.revisionId ?? run.inputs.find((input) => input.docId === docId)?.revisionId ?? null;
}

/**
 * Edits linked to an annotation by its latest result: claimed and confirmed per document. Each entry names the
 * output revision and the confirmed block versions there; unconfirmed claims are dropped (not shown, not accepted).
 */
export function linkedEdits(state: State, run: RunView, result: RunResult): { docId: string; revisionId: string; versions: { lineageId: string; versionId: string }[] }[] {
  const byRevision = new Map<string, CpRange[]>();
  for (const claim of result.claimedEdits) byRevision.set(`${claim.docId} ${claim.revisionId}`, [...(byRevision.get(`${claim.docId} ${claim.revisionId}`) ?? []), claim.range]);
  const linked: { docId: string; revisionId: string; versions: { lineageId: string; versionId: string }[] }[] = [];
  for (const [key, ranges] of byRevision) {
    const [docId, revisionId] = key.split(" ");
    const after = revisionObject(state, revisionId) as Revision | null;
    if (!after || after.docId !== docId) continue;
    const inputId = inputRevision(run, docId);
    const input = inputId ? (revisionObject(state, inputId) as Revision | null) : null;
    const versions = confirmedEdits(input, after, ranges).map(({ lineageId, versionId }) => ({ lineageId, versionId }));
    if (versions.length) linked.push({ docId, revisionId, versions });
  }
  return linked;
}

export type AgentState = "new" | "in-progress" | "done" | "needs-input" | "failed" | "skipped" | null;

/** «Agent work on an annotation» (concept): what happened to the latest instruction. */
export function agentState(view: DiscussionView, state?: State): AgentState {
  if (view.kind !== "action" && !view.items.length) return null;
  if (view.instructions.some((instruction) => instruction.inFlight)) return "in-progress";
  if (view.newInstructions.length && view.kind === "action") return "new";
  const results = view.items.flatMap((item) => item.results);
  if (results.length) {
    // Runs of independent batches are not causally ordered; results of one annotation are (its own events).
    const order = state?.byEntity.get(entity.annotation(view.annotationId)) ?? [];
    const latest = results.reduce((best, result) => (order.indexOf(result.eventId) > order.indexOf(best.eventId) ? result : best));
    return latest.status;
  }
  return view.kind === "action" ? "new" : null;
}

/**
 * «Waiting for you» (concept, I6): an open action annotation the agent answered, without a newer user instruction.
 * It stops waiting when the user accepts, closes, replies or turns it into a note.
 */
export function waitsForUser(view: DiscussionView): boolean {
  if (view.status !== "open" || view.kind !== "action") return false;
  if (view.newInstructions.length || view.instructions.some((instruction) => instruction.inFlight)) return false;
  return view.items.some((item) => item.results.length > 0);
}

/** The latest result of an annotation with its run, if any. */
export function latestResultOf(state: State, annotationId: string): { run: RunView; result: RunResult } | null {
  const order = state.byEntity.get(entity.annotation(annotationId)) ?? [];
  let found: { run: RunView; result: RunResult } | null = null;
  for (const run of runsOf(state)) {
    for (const result of run.results) {
      if (result.annotationId !== annotationId) continue;
      if (!found || order.indexOf(result.eventId) > order.indexOf(found.result.eventId)) found = { run, result };
    }
  }
  return found;
}

/** Candidates of a new batch in a scope: open action annotations with new instructions (DR-04, AC29). */
export function candidates(state: State, scope: { kind: "document"; docId: string } | { kind: "all" } | { kind: "annotation"; annotationId: string }): DiscussionView[] {
  const result: DiscussionView[] = [];
  for (const key of state.byEntity.keys()) {
    if (!key.startsWith("annotation:")) continue;
    const annotationId = key.slice("annotation:".length);
    if (scope.kind === "annotation" && scope.annotationId !== annotationId) continue;
    const view = discussion(state, annotationId);
    if (scope.kind === "document" && view.docId !== scope.docId) continue;
    if (view.candidate) result.push(view);
  }
  return result.sort((a, b) => (a.annotationId < b.annotationId ? -1 : 1));
}

export { entity };
