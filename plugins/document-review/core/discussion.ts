// Discussion of one annotation and its batch item (DR-04, EP-005-T05). Pure functions of the projected journal.
// One item per annotation: a slice of every not yet covered human message up to seenHeads. A result covers
// exactly that slice; later messages stay new. Results never change status or kind.
import { sha256 } from "./hash.ts";
import { type Conflict, entity, type State } from "./journal.ts";
import type { Actor } from "./types.ts";

export type Status = "open" | "closed" | "withdrawn";
export type Kind = "action" | "note";
export type ResultStatus = "done" | "needs-input" | "failed" | "skipped";

export interface MessageRevision {
  eventId: string;
  text: string;
  actor: Actor;
  timestamp: string;
  runId?: string;
  itemId?: string;
}

export interface Message {
  messageId: string;
  role: "human" | "agent";
  /** Revisions in causal order; the first is the original message. */
  revisions: MessageRevision[];
  /** Current text; null while concurrent edits conflict. */
  current: MessageRevision | null;
}

export interface Instruction {
  /** Event carrying a human message or a revision of it: the unit an item slice consists of. */
  eventId: string;
  messageId: string;
  covered: boolean;
  /** Run whose prepared, unanswered item contains this instruction. */
  inFlight: string | null;
}

export interface ResultRecord {
  eventId: string;
  runId: string;
  attemptId: string;
  itemId: string;
  responseId: string;
  status: ResultStatus;
  seenHeads: string[];
  messageId: string;
}

export interface ItemRecord {
  runId: string;
  itemId: string;
  seenHeads: string[];
  preparedEvent: string;
  results: ResultRecord[];
  runFinished: boolean;
}

export interface DiscussionView {
  annotationId: string;
  docId: string | null;
  status: Status | null;
  kind: Kind | null;
  messages: Message[];
  instructions: Instruction[];
  /** Human instructions neither covered by a result nor inside an in-flight item: what the next batch would send. */
  newInstructions: string[];
  /** Counts towards «Send to agent»: an open action annotation with new instructions. */
  candidate: boolean;
  items: ItemRecord[];
  /** Ever put into a batch: withdrawal is then impossible (C6). */
  dispatched: boolean;
  conflicts: Conflict[];
  incomplete: string[];
}

function register(state: State, annotationId: string, field: string): string | null {
  return state.registers.get(`${entity.annotation(annotationId)}#${field}`)?.value ?? null;
}

/** Stable item id of an annotation inside a run. */
export function itemIdFor(runId: string, annotationId: string): string {
  return `item-${sha256(`${runId}\n${annotationId}`).slice(0, 24)}`;
}

function inSlice(state: State, key: string, eventId: string, heads: string[]): boolean {
  return heads.some((head) => head === eventId || state.isAncestorIn(key, eventId, head));
}

export function discussion(state: State, annotationId: string): DiscussionView {
  const key = entity.annotation(annotationId);
  const eventIds = state.byEntity.get(key) ?? [];
  const messages = new Map<string, Message>();
  const humanEvents: { eventId: string; messageId: string }[] = [];
  const results: ResultRecord[] = [];
  const retries: string[] = [];
  let docId: string | null = null;

  const refused = new Set(state.ignored.filter((entry) => entry.messageId).map((entry) => `${entry.eventId}/${entry.messageId}`));
  for (const eventId of eventIds) {
    const operation = state.events.get(eventId)!;
    for (const change of operation.changes) {
      if (!("annotationId" in change) || change.annotationId !== annotationId) continue;
      const human = operation.actor.kind === "human";
      const add = (messageId: string, text: string, extra: Partial<MessageRevision> = {}) => {
        const message = messages.get(messageId) ?? { messageId, role: human ? "human" as const : "agent" as const, revisions: [], current: null };
        // The projection refused this change (reused message id, other side's revision): not part of history.
        if (refused.has(`${eventId}/${messageId}`)) return;
        message.revisions.push({ eventId, text, actor: operation.actor, timestamp: operation.timestamp, ...extra });
        messages.set(messageId, message);
        if (message.role === "human" && human) humanEvents.push({ eventId, messageId });
      };
      switch (change.type) {
        case "annotation.created": {
          docId = change.docId;
          const object = state.objects.get(change.annotation);
          add(change.messageId, object?.type === "Annotation" ? object.body.value : "");
          break;
        }
        case "message.appended": add(change.messageId, change.text, { runId: change.runId, itemId: change.itemId }); break;
        case "message.revised":
          // Only the author's side may revise: an agent cannot rewrite a human instruction and vice versa.
          if (messages.get(change.messageId)?.role === (human ? "human" : "agent")) add(change.messageId, change.text);
          break;
        case "item.result-recorded":
          results.push({ eventId, runId: change.runId, attemptId: change.attemptId, itemId: change.itemId, responseId: change.responseId,
            status: change.status, seenHeads: change.seenHeads, messageId: change.messageId });
          break;
        case "discussion.retry-requested": if (human) retries.push(eventId); break;
        default: break;
      }
    }
  }
  for (const message of messages.values()) {
    const chosen = register(state, annotationId, `message:${message.messageId}`);
    message.current = message.revisions.find((revision) => revision.eventId === chosen) ?? null;
  }

  // Items of this annotation from prepared batches.
  const items: ItemRecord[] = [];
  for (const eventId of state.order) {
    for (const change of state.events.get(eventId)!.changes) {
      if (change.type !== "batch.prepared") continue;
      for (const item of change.items) {
        if (item.annotationId !== annotationId) continue;
        const runEvents = state.byEntity.get(entity.run(change.runId)) ?? [];
        const runFinished = runEvents.some((id) => state.events.get(id)!.changes.some((other) => other.type === "batch.finished" && other.runId === change.runId));
        items.push({ runId: change.runId, itemId: item.itemId, seenHeads: item.seenHeads, preparedEvent: eventId,
          results: results.filter((result) => result.runId === change.runId && result.itemId === item.itemId), runFinished });
      }
    }
  }

  // A result covers the slice fixed when its item was prepared, never what the result itself claims to have seen;
  // results without a prepared item of this annotation cover nothing. Redeliveries (same responseId) count once.
  const covering = items.filter((item) => {
    const unique = [...new Map(item.results.map((result) => [result.responseId, result])).values()];
    return unique.some((result) => result.status !== "skipped" && !retries.some((retry) => state.isAncestorIn(key, result.eventId, retry)));
  });

  const instructions: Instruction[] = humanEvents.map(({ eventId, messageId }) => {
    const covered = covering.some((item) => inSlice(state, key, eventId, item.seenHeads));
    const flying = items.find((item) => !item.runFinished && item.results.length === 0 && inSlice(state, key, eventId, item.seenHeads));
    return { eventId, messageId, covered, inFlight: flying ? flying.runId : null };
  });

  const status = register(state, annotationId, "status") as Status | null;
  const kind = register(state, annotationId, "kind") as Kind | null;
  const newInstructions = instructions.filter((instruction) => !instruction.covered && !instruction.inFlight).map((instruction) => instruction.eventId);
  const conflicts = state.conflicts.filter((conflict) => conflict.entity === key);
  const incomplete = state.incomplete.get(key) ?? [];
  return {
    annotationId, docId, status, kind,
    messages: [...messages.values()],
    instructions, newInstructions,
    candidate: status === "open" && kind === "action" && newInstructions.length > 0 && conflicts.length === 0 && incomplete.length === 0,
    items, dispatched: items.length > 0, conflicts, incomplete,
  };
}

export interface ItemSlice {
  itemId: string;
  annotationId: string;
  /** Heads of the annotation at preparation: the cut of the slice. */
  seenHeads: string[];
  /** Instruction events the item answers; messages after seenHeads are left for the next batch. */
  slice: string[];
}

/** The item a new batch would contain for this annotation, or null when it is not a candidate. */
export function nextItem(state: State, annotationId: string, runId: string): ItemSlice | null {
  const view = discussion(state, annotationId);
  if (!view.candidate) return null;
  const seenHeads = state.heads.get(entity.annotation(annotationId)) ?? [];
  const slice = view.newInstructions.filter((eventId) => inSlice(state, entity.annotation(annotationId), eventId, seenHeads));
  if (!slice.length) return null;
  return { itemId: itemIdFor(runId, annotationId), annotationId, seenHeads, slice };
}

/**
 * DR-04: after preparation the manifest stays; an item whose annotation was closed or turned into a note
 * gets a skip request the agent checks before working. Already done edits are not rolled back.
 */
export function skipRequested(view: DiscussionView): boolean {
  return view.status !== "open" || view.kind !== "action";
}

export type Transition =
  | { type: "withdraw" }
  | { type: "restore" }
  | { type: "close" }
  | { type: "reopen" }
  | { type: "change-kind"; kind: Kind }
  | { type: "append"; role: "human" | "agent" }
  | { type: "revise"; messageId: string; role: "human" | "agent" }
  | { type: "retry" };

export type TransitionCheck = { ok: true } | { ok: false; reason: string };

/** Whether a user/agent action is allowed now. Conflicting or incomplete annotations accept no changes but resolution. */
export function checkTransition(view: DiscussionView, transition: Transition): TransitionCheck {
  if (view.incomplete.length) return { ok: false, reason: `incomplete: ${view.incomplete[0]}` };
  if (view.conflicts.length) return { ok: false, reason: `conflict in ${view.conflicts[0].register}; resolve it first` };
  if (view.status === null) return { ok: false, reason: "unknown annotation" };
  const deny = (reason: string) => ({ ok: false as const, reason });
  switch (transition.type) {
    case "withdraw":
      if (view.status !== "open") return deny("only an open annotation can be withdrawn");
      if (view.dispatched) return deny("already sent to an agent: close it instead (C6)");
      return { ok: true };
    case "restore": return view.status === "withdrawn" ? { ok: true } : deny("not withdrawn");
    case "close": return view.status === "open" ? { ok: true } : deny("not open");
    case "reopen": return view.status === "closed" ? { ok: true } : deny("not closed");
    case "change-kind":
      if (view.status === "withdrawn") return deny("withdrawn");
      return view.kind === transition.kind ? deny(`already ${transition.kind}`) : { ok: true };
    case "append":
      // An agent reply is history and is kept even after closing; a human reply to a closed annotation needs «Reopen and reply».
      if (transition.role === "agent") return { ok: true };
      return view.status === "open" ? { ok: true } : deny(view.status === "closed" ? "closed: reopen and reply" : "withdrawn");
    case "revise": {
      const message = view.messages.find((candidate) => candidate.messageId === transition.messageId);
      if (!message) return deny("unknown message");
      if (message.role !== transition.role) return deny("only the author's side revises a message");
      return transition.role === "agent" || view.status === "open" ? { ok: true } : deny("not open");
    }
    case "retry":
      if (view.status !== "open" || view.kind !== "action") return deny("retry needs an open action annotation");
      return view.instructions.some((instruction) => instruction.covered) ? { ok: true } : deny("nothing was processed yet");
  }
}
