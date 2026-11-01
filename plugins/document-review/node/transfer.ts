// Moving review data between `.bb-docs` and the local store when a file's Git status changes (W-06c, file-types.md §9
// Moving review data when Git classification changes: a local file that enters the index is offered
// «Move to Git…» (what becomes shared is listed first); a file with shared data that is now ignored and not in the index
// moves to the local store after a notice with «Undo». The changes of the document — its registration and
// revisions, its annotations and their messages, this reader's receipts — are replayed in the target journal in their
// order, with the same document, revision and annotation ids and the same objects and snapshots; each replayed event
// gets an id derived from the source event and the direction, so an interrupted transfer finishes when repeated and a
// repeat writes nothing twice. Rounds stay where they were (an agent's answer moves as a message). The marker
// `document.transferred` is written in the target, then in the source; the side the data left is read-only for it.
import { sha256 } from "../core/hash.ts";
import { tr } from "../core/i18n.ts";
import { entity, operationEntities, parentsFor, type State } from "../core/journal.ts";
import { type ObjectValue, type Operation, operationVersion } from "../core/schema.ts";
import { layout, objectReferences, operationReferences, publish } from "../core/store.ts";
import { ensureLocalRule, localFor } from "./local.ts";
import { readerOf, sharedConfigOf, sharedRules } from "./content.ts";
import { confine } from "./checkout.ts";
import { isRepoPath } from "../core/schema.ts";
import { isRedactedFixedPoint } from "../core/formats/secrets.ts";

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
import { ReviewError, type Expectation, type ReviewService } from "./service.ts";

export type Direction = "to-git" | "to-local";

/** A UUID derived from the source event and the direction: the same replay always has the same id. */
function derivedId(sourceEventId: string, direction: Direction): string {
  const hex = sha256(`bbdr-transfer|${direction}|${sourceEventId}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function liveRecord(state: State, docPath: string) {
  return [...state.documents.values()].find((doc) => doc.path === docPath && !doc.removed) ?? null;
}

/** The changes of one source event that belong to the document's data (and to this reader, for receipts). */
function relevant(operation: Operation, docId: string, readerId: string, annotations: Set<string>, receipts: Set<string>): Operation["changes"] {
  const out: Operation["changes"] = [];
  for (const change of operation.changes) {
    switch (change.type) {
      case "document.registered": case "document.observed": case "document.moved": case "document.removed":
        if (change.docId === docId) out.push(change);
        break;
      case "document.transferred":
        break;
      case "annotation.created":
        if (change.docId === docId) { annotations.add(change.annotationId); out.push(change); }
        break;
      case "message.appended":
        // A round stays where it ran: the agent's answer moves as a message of the discussion.
        if (annotations.has(change.annotationId)) out.push({ type: "message.appended", annotationId: change.annotationId, messageId: change.messageId, text: change.text });
        break;
      case "read.acknowledged":
        if (change.docId === docId && change.readerId === readerId) { receipts.add(change.receiptId); out.push(change); }
        break;
      case "read.revoked":
        if (receipts.has(change.receiptId)) out.push(change);
        break;
      case "layout.pinned": case "layout.unpinned":
        // 1.3: this reader's diagram layouts move with the document, like receipts.
        if (change.scope.doc === docId && change.scope.reader === readerId) out.push(change);
        break;
      case "conflict.resolved": case "item.result-recorded": case "batch.prepared": case "batch.dispatched": case "batch.input-registered": case "batch.finished":
        break;
      default:
        if ("annotationId" in change && annotations.has(change.annotationId)) out.push(change);
    }
  }
  return out;
}

/** What a transfer would move (shown before «Move to Git…»): annotations with their first lines and authors, receipts, revisions. */
export async function transferPreview(shared: ReviewService, input: { path: string; direction: Direction }) {
  const { from } = await sides(shared, input.direction);
  const state = await from.state();
  const record = liveRecord(state, input.path);
  if (!record) throw new ReviewError("not-found", `no review data of ${input.path} to move`);
  const readerId = (await readerOf(shared))!;
  const annotations = new Set<string>();
  const receipts = new Set<string>();
  const list: { annotationId: string; firstLine: string; author: string; status: string }[] = [];
  let events = 0;
  for (const id of state.order) {
    const operation = state.events.get(id)!;
    const changes = relevant(operation, record.docId, readerId, annotations, receipts);
    if (!changes.length) continue;
    events++;
    for (const change of changes) {
      if (change.type !== "annotation.created") continue;
      const object = state.objects.get(change.annotation) as { body?: { value?: string } } | undefined;
      list.push({ annotationId: change.annotationId, firstLine: (object?.body?.value ?? "").split("\n")[0].slice(0, 160),
        author: operation.actor.kind === "human" ? operation.actor.name : "agent", status: state.registers.get(`${entity.annotation(change.annotationId)}#status`)?.value ?? "open" });
    }
  }
  const { to } = await sides(shared, input.direction);
  const other = liveRecord(await to.state(), input.path);
  return { path: input.path, direction: input.direction, docId: record.docId, annotations: list, receipts: receipts.size, revisions: record.revisions.length, events,
    conflict: Boolean(other && other.docId !== record.docId),
    where: input.direction === "to-git" ? tr(".bb-docs (goes to Git with your commit)", ".bb-docs (уйдёт в Git с вашим коммитом)") : tr("local storage of this machine", "локальное хранилище этой машины") };
}

async function sides(shared: ReviewService, direction: Direction): Promise<{ from: ReviewService; to: ReviewService; local: ReviewService }> {
  const local = await localFor(shared);
  if (!local) throw new ReviewError("no-identity", "Git user.email is not set in this checkout: local data is kept per reader");
  return direction === "to-git" ? { from: local, to: shared, local } : { from: shared, to: local, local };
}

/**
 * Move the review data of one document (§9). Objects and snapshots, then events, then the marker in the target, then
 * the marker in the source. Repeating after a failure continues where it stopped; nothing is written twice.
 */
export async function transferDocument(shared: ReviewService, input: { path: string; direction: Direction } & Expectation) {
  const { from, to, local } = await sides(shared, input.direction);
  if (!isRepoPath(input.path)) throw new ReviewError("bad-path", `not a repository path: ${input.path}`);
  await confine(shared.root, input.path);
  // The Git status is read afresh and must be known: a failing listing never moves data (security review, finding 4).
  shared.invalidate();
  if ((await shared.fileClasses()).failed) throw new ReviewError("git-unavailable", "Git could not list the files of this checkout: nothing is moved; try again");
  const fileClass = await shared.fileClass(input.path);
  if (input.direction === "to-git" && fileClass !== "git") throw new ReviewError("bad-input", `${input.path} is not in the Git index: nothing to move to the shared review`);
  if (input.direction === "to-local" && fileClass !== "outside") throw new ReviewError("bad-input", `${input.path} is not ignored by Git: its review stays shared`);
  // The file joins the local rules first (no base is recorded: its history comes with the transfer).
  if (input.direction === "to-local") await ensureLocalRule(shared, input.path);
  const target = await to.writable(input);
  const readerId = target.readerId;
  return to.serial(async () => {
    const fromState = await from.state();
    const record = liveRecord(fromState, input.path);
    if (!record) throw new ReviewError("not-found", `no review data of ${input.path} to move`);
    // A live document of the same path on the other side would make two (security review, finding 7): no merge here.
    const other = liveRecord(await to.state(), input.path);
    if (other && other.docId !== record.docId) throw new ReviewError("conflict", `${input.path} already has review data ${input.direction === "to-git" ? "in the shared review" : "in the local store"}: nothing moved; keep the data ${input.direction === "to-git" ? "local" : "shared"}`);
    // Into .bb-docs only what the repository's rules would have stored themselves (§8): every revision's snapshot must
    // be a fixed point of the shared redaction — a value masked only by weaker rules never reaches Git.
    if (input.direction === "to-git") {
      const rules = sharedRules(await sharedConfigOf(shared.root), input.path, "git");
      for (const revisionId of record.revisions) {
        const revision = fromState.objects.get(fromState.revisions.get(revisionId)?.objectSha ?? "") as { snapshot?: string } | undefined;
        const sha = revision?.snapshot;
        const bytes = sha ? await from.store.read(layout.snapshot(sha)) : null;
        if (!bytes) continue;
        if (!isRedactedFixedPoint(input.path, decoder.decode(bytes), rules, "shared")) {
          throw new ReviewError("unverifiable", `a stored revision of ${input.path} is not masked by the repository's rules: nothing moved; keep the data local`);
        }
      }
    }
    const annotations = new Set<string>();
    const receipts = new Set<string>();
    let written = 0;
    let toState = await to.state();
    // What the target already has — from an earlier move the other way (round trip, finding 6) — is not written again.
    const present = (state: State) => {
      const receiptsThere = new Set<string>();
      for (const operation of state.events.values()) for (const change of operation.changes) if (change.type === "read.acknowledged") receiptsThere.add(change.receiptId);
      return (change: Operation["changes"][number]): boolean => {
        switch (change.type) {
          case "document.registered": return state.documents.has(change.docId);
          case "document.observed": return state.revisions.has(change.revisionId);
          case "annotation.created": return state.byEntity.has(entity.annotation(change.annotationId));
          case "message.appended": return state.registers.has(`${entity.annotation(change.annotationId)}#message:${change.messageId}`);
          case "read.acknowledged": return receiptsThere.has(change.receiptId);
          default: return false;
        }
      };
    };
    let already = present(toState);
    // The journal's order is topological per entity: a receipt may come before the event that recorded the revision it
    // names. Events whose revisions are not in the target yet wait for the next pass.
    let pending = fromState.order.map((id) => fromState.events.get(id)!);
    for (let pass = 0; pending.length && pass < 64; pass++) {
      const waiting: Operation[] = [];
      for (const source of pending) {
        const changes = relevant(source, record.docId, readerId, annotations, receipts).filter((change) => !already(change));
        if (!changes.length) continue;
        const eventId = derivedId(source.id, input.direction);
        if (toState.events.has(eventId)) continue;
        const draft = { ...source, changes } as Operation;
        const objects: ObjectValue[] = [];
        const snapshots: Uint8Array[] = [];
        for (const sha of operationReferences(draft).objects) {
          const object = fromState.objects.get(sha);
          if (!object) throw new ReviewError("incomplete", `object ${sha} of ${input.path} is missing in the source`);
          objects.push(object);
          for (const snapshot of objectReferences(object).snapshots) {
            const bytes = await from.store.read(layout.snapshot(snapshot));
            if (!bytes) throw new ReviewError("incomplete", `snapshot ${snapshot} of ${input.path} is missing in the source`);
            snapshots.push(bytes);
          }
        }
        const observed = new Set(changes.flatMap((change) => (change.type === "document.observed" ? [change.revisionId] : [])));
        const needs = [...operationReferences(draft).revisions, ...objects.flatMap((object) => objectReferences(object).revisions)];
        if (needs.some((id) => !observed.has(id) && !toState.revisions.has(id))) { waiting.push(source); continue; }
        const operation: Operation = { schemaVersion: operationVersion(changes, objects as { schemaVersion?: string }[]), id: eventId, actor: source.actor, timestamp: source.timestamp,
          parents: parentsFor(toState, operationEntities(draft)), changes };
        await publish(to.store, { operation, objects, snapshots }, { isKnownRevision: (revisionId) => toState.revisions.has(revisionId) });
        to.invalidate();
        toState = await to.state();
        already = present(toState);
        written++;
      }
      if (waiting.length === pending.length) throw new ReviewError("incomplete", `the review data of ${input.path} references revisions that are not in the source`);
      pending = waiting;
    }
    // Markers: target first, then source; each once per direction (a later move back writes the other direction).
    const marker = async (service: ReviewService, state: State) => {
      const docRecord = state.documents.get(record.docId);
      if (docRecord?.transferred === input.direction) return;
      await service.commit(state, target.actor, [{ type: "document.transferred", docId: record.docId, direction: input.direction }], [], []);
    };
    await marker(to, await to.state());
    await marker(from, (await from.writable(input)).state);
    from.invalidate();
    to.invalidate();
    shared.invalidate();
    return { status: "transferred" as const, direction: input.direction, path: input.path, events: written, annotations: annotations.size, receipts: receipts.size };
  });
}

/**
 * “Keep local” (§9): the file is shared now, its local data stays as it was — read-only, kept in the local
 * store; the shared review starts from a clean base. The offer does not come back.
 */
export async function keepLocal(shared: ReviewService, input: { path: string } & Expectation) {
  const local = await localFor(shared);
  if (!local) throw new ReviewError("no-identity", "Git user.email is not set in this checkout");
  if ((await shared.fileClass(input.path)) !== "git") throw new ReviewError("bad-input", `${input.path} is not in the Git index: ${tr("“Keep local”", "«Оставить локальными»")} is for a file that came into Git`);
  const { actor, state } = await local.writable(input);
  const record = liveRecord(state, input.path);
  if (!record) throw new ReviewError("not-found", `no local data of ${input.path}`);
  if (record.transferred === "to-git") return { status: "unchanged" as const };
  await local.commit(state, actor, [{ type: "document.transferred", docId: record.docId, direction: "to-git" }], [], []);
  return { status: "kept" as const, path: input.path };
}
