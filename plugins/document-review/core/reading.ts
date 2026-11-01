// Read state per DR-02 (EP-005-T04). For each block lineage the base is the maximal confirmed version
// in the causal history of the current revision: a late receipt of an ancestor cannot roll the base back,
// a revocation removes only its own contribution, incomparable bases from two branches stay unread.
import { entity, revisionHistory, revisionObject, type State } from "./journal.ts";
import { Email } from "./schema.ts";
import type { Revision, VersionRef } from "./types.ts";

export class ReaderIdError extends Error {}

/** readerId is the lowercased, trimmed Git email. Without an email nothing can be written (AC17). */
export function normalizeReaderId(email: string | null | undefined): string {
  const value = (email ?? "").trim().toLowerCase();
  if (!value) throw new ReaderIdError("Git user.email is not set for this checkout: reading works, writing is disabled");
  if (!Email.safeParse(value).success) throw new ReaderIdError(`not an email: ${value}`);
  return value;
}

export interface Receipt {
  receiptId: string;
  eventId: string;
  readerId: string;
  docId: string;
  revisionId: string;
  versions: VersionRef[];
  tombstones: string[];
}

/** Receipts of one reader for one document, without revoked ones. A revocation names its receipt. */
export function receiptsOf(state: State, readerId: string, docId: string): Receipt[] {
  const ids = state.byEntity.get(entity.reader(readerId)) ?? [];
  const receipts: Receipt[] = [];
  const revoked = new Set<string>();
  for (const eventId of ids) {
    const actor = state.events.get(eventId)!.actor;
    // A receipt is the reader's own act: an agent or another Git identity cannot mark it read or revoke it.
    if (actor.kind !== "human" || actor.email.trim().toLowerCase() !== readerId) continue;
    for (const change of state.events.get(eventId)!.changes) {
      if (change.type === "read.revoked" && change.readerId === readerId) revoked.add(change.receiptId);
      if (change.type === "read.acknowledged" && change.readerId === readerId && change.docId === docId) {
        receipts.push({ receiptId: change.receiptId, eventId, readerId, docId, revisionId: change.revisionId, versions: change.versions, tombstones: change.tombstones });
      }
    }
  }
  // The same receipt id published twice (e.g. on two branches) counts once.
  const unique = new Map<string, Receipt>();
  for (const receipt of receipts) if (!revoked.has(receipt.receiptId) && !unique.has(receipt.receiptId)) unique.set(receipt.receiptId, receipt);
  return [...unique.values()];
}

/**
 * Whether a reader has any standing receipt of their own: a new reader (e.g. after an email change) is offered to accept
 * the current state; after undoing that acceptance the offer comes back (revoked receipts do not count).
 */
export function isKnownReader(state: State, readerId: string): boolean {
  const acknowledged = new Set<string>();
  const revoked = new Set<string>();
  for (const eventId of state.byEntity.get(entity.reader(readerId)) ?? []) {
    const operation = state.events.get(eventId)!;
    if (operation.actor.kind !== "human" || operation.actor.email.trim().toLowerCase() !== readerId) continue;
    for (const change of operation.changes) {
      if (change.type === "read.acknowledged" && change.readerId === readerId) acknowledged.add(change.receiptId);
      if (change.type === "read.revoked" && change.readerId === readerId) revoked.add(change.receiptId);
    }
  }
  return [...acknowledged].some((receiptId) => !revoked.has(receiptId));
}

/** The revision a version or lineage id was born in: `<revisionId>.<n>`. */
export function bornIn(ref: string): string {
  return ref.slice(0, ref.lastIndexOf("."));
}

/** An agent's references alone do not start human reading. Old human interactions keep their existing base. */
export function hasReadingBase(state: State, docId: string): boolean {
  if ((state.documents.get(docId)?.revisions ?? []).some((id) => {
    const record = state.revisions.get(id);
    return record && (record.reason === "baseline" || record.reason === "tracking-resumed" || state.events.get(record.eventId)?.actor.kind === "human");
  })) return true;
  // A direct human read mark may reuse an agent's existing revision without publishing another snapshot.
  return [...state.events.values()].some(({ actor, changes }) => actor.kind === "human" && changes.some((change) =>
    change.type === "read.acknowledged" && change.docId === docId && change.readerId === actor.email.trim().toLowerCase()));
}

export type BlockReadState =
  | { state: "read"; lineageId: string; versionId: string; base: VersionRef }
  | { state: "unread"; lineageId: string; versionId: string; change: "added" | "edited"; base: VersionRef | null }
  | { state: "ambiguous"; lineageId: string; versionId: string; bases: VersionRef[] };

export interface RemovedReadState {
  tombstoneId: string;
  lineageId: string;
  state: "read" | "unread";
  base: VersionRef | null;
}

export interface DocumentReadState {
  readerId: string;
  docId: string;
  revisionId: string;
  blocks: BlockReadState[];
  /** Deletions the reader has not acknowledged; added-then-removed before reading is not listed (F3). */
  removed: RemovedReadState[];
  unread: number;
}

interface VersionInfo {
  semanticHash: string;
  revisionId: string;
}

/**
 * Read state of `revisionId` for `readerId`.
 * Confirmed versions: receipts whose revision is in the causal history of the current revision, plus the
 * baseline/tracking-resumed observations of that history (the initial base, F1).
 */
export interface ReadOptions {
  /**
   * For a split/merge block whose every source version is the reader's base: true when the block's text is
   * covered by the source texts without edits (needs the snapshots, so the caller decides). Without it such
   * blocks stay unread.
   */
  splitMergeUnchanged?(block: Revision["blocks"][number], sources: VersionRef[]): boolean;
}

export function readState(state: State, readerId: string, revisionId: string, options: ReadOptions = {}): DocumentReadState {
  const current = revisionObject(state, revisionId);
  if (!current) throw new Error(`unknown revision ${revisionId}`);
  if (!hasReadingBase(state, current.docId)) return {
    readerId, docId: current.docId, revisionId, unread: 0, removed: [],
    blocks: current.blocks.map(({ lineageId, versionId }) => ({ state: "read", lineageId, versionId, base: { lineageId, versionId } })),
  };
  const history = revisionHistory(state, revisionId);
  const revisionsInHistory = new Map<string, Revision>();
  for (const id of history) {
    const object = revisionObject(state, id);
    if (object) revisionsInHistory.set(id, object as Revision);
  }

  const versionInfo = new Map<string, VersionInfo>();
  for (const [id, revision] of revisionsInHistory) {
    for (const block of revision.blocks) if (bornIn(block.versionId) === id) versionInfo.set(block.versionId, { semanticHash: block.semanticHash, revisionId: id });
  }
  // A version is ancestor-or-equal of another if the revision it was born in is in the other's history.
  const historyCache = new Map<string, Set<string>>();
  const historyOf = (id: string) => {
    let value = historyCache.get(id);
    if (!value) {
      value = revisionHistory(state, id);
      historyCache.set(id, value);
    }
    return value;
  };
  const precedes = (a: string, b: string) => a !== b && historyOf(bornIn(b)).has(bornIn(a));

  const confirmed = new Map<string, Set<string>>();
  const confirmedTombstones = new Set<string>();
  const confirm = (ref: VersionRef) => {
    // Only versions that really belong to this history count; anything else is a foreign or damaged receipt.
    if (!versionInfo.has(ref.versionId) || !history.has(bornIn(ref.versionId))) return;
    const set = confirmed.get(ref.lineageId) ?? new Set<string>();
    set.add(ref.versionId);
    confirmed.set(ref.lineageId, set);
  };
  for (const id of history) {
    const record = state.revisions.get(id)!;
    if (record.reason === "baseline" || record.reason === "tracking-resumed") {
      for (const block of revisionsInHistory.get(id)?.blocks ?? []) confirm({ lineageId: block.lineageId, versionId: block.versionId });
    }
  }
  for (const receipt of receiptsOf(state, readerId, current.docId)) {
    if (!history.has(receipt.revisionId)) continue; // another branch: kept, but not part of this history
    const receiptRevision = revisionsInHistory.get(receipt.revisionId);
    const present = new Set(receiptRevision?.blocks.map((block) => block.versionId) ?? []);
    for (const ref of receipt.versions) if (present.has(ref.versionId)) confirm(ref);
    for (const id of receipt.tombstones) confirmedTombstones.add(id);
  }

  const maximal = (lineageId: string): VersionRef[] => {
    const set = [...(confirmed.get(lineageId) ?? [])];
    return set.filter((version) => !set.some((other) => precedes(version, other))).sort().map((versionId) => ({ lineageId, versionId }));
  };
  const hashOf = (versionId: string) => versionInfo.get(versionId)?.semanticHash;

  const blocks: BlockReadState[] = current.blocks.map((block) => {
    const { lineageId, versionId } = block;
    if (confirmed.get(lineageId)?.has(versionId)) return { state: "read", lineageId, versionId, base: { lineageId, versionId } };
    const bases = maximal(lineageId);
    if (bases.length === 1) {
      const [base] = bases;
      // Same content as the confirmed base (A→B→A unread, then back): nothing to read (F3).
      if (hashOf(base.versionId) === block.semanticHash) return { state: "read", lineageId, versionId, base };
      return { state: "unread", lineageId, versionId, change: "edited", base };
    }
    if (bases.length > 1) return { state: "ambiguous", lineageId, versionId, bases };
    if (block.origin) {
      // Split/merge inherit the base only when every source version is confirmed as the base of its lineage.
      const inherited = block.origin.sources.every((source) => {
        const sourceBases = maximal(source.lineageId);
        return sourceBases.length === 1 && hashOf(sourceBases[0].versionId) === hashOf(source.versionId);
      });
      if (inherited && options.splitMergeUnchanged?.(block, block.origin.sources)) {
        return { state: "read", lineageId, versionId, base: block.origin.sources[0] };
      }
      if (inherited) return { state: "unread", lineageId, versionId, change: "edited", base: null };
    }
    return { state: "unread", lineageId, versionId, change: "added", base: null };
  });

  const present = new Set(current.blocks.map((block) => block.lineageId));
  const removedByLineage = new Map<string, string[]>();
  for (const revision of revisionsInHistory.values()) {
    for (const tombstone of revision.removed) {
      if (present.has(tombstone.lineageId)) continue;
      removedByLineage.set(tombstone.lineageId, [...(removedByLineage.get(tombstone.lineageId) ?? []), tombstone.tombstoneId]);
    }
  }
  const removed: RemovedReadState[] = [];
  for (const [lineageId, tombstones] of [...removedByLineage].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const bases = maximal(lineageId);
    if (bases.length === 0) continue; // never read: an addition removed again leaves no mark
    for (const tombstoneId of tombstones.sort()) {
      removed.push({ tombstoneId, lineageId, state: confirmedTombstones.has(tombstoneId) ? "read" : "unread", base: bases.length === 1 ? bases[0] : null });
    }
  }

  const unread = blocks.filter((block) => block.state !== "read").length + removed.filter((entry) => entry.state === "unread").length;
  return { readerId, docId: current.docId, revisionId, blocks, removed, unread };
}

export type ReceiptCheck = { ok: true; staleBlocks: number } | { ok: false; reason: "context-changed" | "unknown-version"; message: string };

/**
 * Before publishing a receipt: the shown revision must be persistent in this checkout's journal; otherwise
 * the branch/checkout changed and the receipt would point at history that is not here (DR-02).
 * A newer revision is not a refusal: shown versions are confirmed and the newer changes stay unread.
 */
export function checkReceipt(state: State, input: { revisionId: string; versions: VersionRef[]; tombstones: string[]; currentRevisionId: string | null }): ReceiptCheck {
  const shown = revisionObject(state, input.revisionId);
  if (!shown) return { ok: false, reason: "context-changed", message: "the shown revision is not in this checkout's history; nothing was saved in this branch" };
  const versions = new Set(shown.blocks.map((block) => block.versionId));
  const tombstones = new Set<string>();
  for (const id of revisionHistory(state, input.revisionId)) for (const tombstone of revisionObject(state, id)?.removed ?? []) tombstones.add(tombstone.tombstoneId);
  const foreign = input.versions.filter((ref) => !versions.has(ref.versionId)).length + input.tombstones.filter((id) => !tombstones.has(id)).length;
  if (foreign) return { ok: false, reason: "unknown-version", message: `${foreign} confirmed version(s) are not part of the shown revision` };
  let staleBlocks = 0;
  if (input.currentRevisionId && input.currentRevisionId !== input.revisionId) {
    const current = revisionObject(state, input.currentRevisionId);
    if (current) {
      const confirmedVersions = new Set(input.versions.map((ref) => ref.versionId));
      const lineages = new Set(input.versions.map((ref) => ref.lineageId));
      staleBlocks = current.blocks.filter((block) => lineages.has(block.lineageId) && !confirmedVersions.has(block.versionId)).length;
    }
  }
  return { ok: true, staleBlocks };
}

/**
 * Whether the reader has acknowledged the deletion of a whole document (EP-014-T05, DR-02 per reader): a removal
 * receipt of this reader for a current head revision of the document. Data of schema 1.0 had one document.removed per
 * checkout: the person who wrote it acknowledged it (their own act); for everybody else it is unread. A reader who
 * never had a base of the document (added and removed before any reading, F3) gets no mark: "none".
 */
export function removalState(state: State, readerId: string, docId: string): "read" | "unread" | "none" {
  const record = state.documents.get(docId);
  if (!record) return "none";
  const heads = new Set(record.headRevisions);
  for (const receipt of receiptsOfAnyScope(state, readerId, docId)) {
    if (receipt.scope === "removal" && heads.has(receipt.revisionId)) return "read";
  }
  for (const eventId of state.heads.get(entity.doc(docId)) ?? []) {
    const operation = state.events.get(eventId);
    if (!operation || operation.actor.kind !== "human" || operation.actor.email.trim().toLowerCase() !== readerId) continue;
    if (operation.changes.some((change) => change.type === "document.removed" && change.docId === docId)) {
      // A removal acknowledged by this reader and later revoked (1.1) is unread again.
      const revoked = receiptsRevoked(state, readerId);
      const own = operation.changes.find((change) => change.type === "read.acknowledged" && change.scope === "removal");
      if (!own || own.type !== "read.acknowledged" || !revoked.has(own.receiptId)) return "read";
    }
  }
  const hadBase = record.revisions.some((revisionId) => ["baseline", "tracking-resumed"].includes(state.revisions.get(revisionId)?.reason ?? ""))
    || receiptsOfAnyScope(state, readerId, docId).some((receipt) => receipt.scope !== "removal");
  return hadBase ? "unread" : "none";
}

function receiptsRevoked(state: State, readerId: string): Set<string> {
  const revoked = new Set<string>();
  for (const eventId of state.byEntity.get(entity.reader(readerId)) ?? []) {
    const operation = state.events.get(eventId)!;
    if (operation.actor.kind !== "human" || operation.actor.email.trim().toLowerCase() !== readerId) continue;
    for (const change of operation.changes) if (change.type === "read.revoked" && change.readerId === readerId) revoked.add(change.receiptId);
  }
  return revoked;
}

/** Receipts of a reader for a document with their scope, without revoked ones. */
function receiptsOfAnyScope(state: State, readerId: string, docId: string): { receiptId: string; revisionId: string; scope: string }[] {
  const revoked = receiptsRevoked(state, readerId);
  const result: { receiptId: string; revisionId: string; scope: string }[] = [];
  for (const eventId of state.byEntity.get(entity.reader(readerId)) ?? []) {
    const operation = state.events.get(eventId)!;
    if (operation.actor.kind !== "human" || operation.actor.email.trim().toLowerCase() !== readerId) continue;
    for (const change of operation.changes) {
      if (change.type === "read.acknowledged" && change.readerId === readerId && change.docId === docId && !revoked.has(change.receiptId)) {
        result.push({ receiptId: change.receiptId, revisionId: change.revisionId, scope: change.scope });
      }
    }
  }
  return result;
}
