// validate (EP-005-T06): schemas, hashes, canonical form, closure of references, incomplete entities and
// conflicts of one .bb-docs directory. Output is bounded and structured; nothing is repaired.
import { isCanonical } from "./canonical-json.ts";
import { sha256 } from "./hash.ts";
import { loadRepository, type Problem, project, type RepositoryData, revisionObject, type State } from "./journal.ts";
import type { ObjectValue } from "./schema.ts";
import { layout, objectReferences, operationReferences, type StorageBackend } from "./store.ts";

export interface ValidateOptions {
  /** Maximum problems in the result (default 50); the rest are only counted. */
  limit?: number;
  /**
   * Recompute a revision from its snapshot and parents (EP-006); returns problems, empty when it matches.
   * `parents` are the parent Revision objects with their snapshot bytes.
   */
  checkRevision?(input: { revision: ObjectValue & { type: "Revision" }; snapshot: Uint8Array; parents: { revision: ObjectValue & { type: "Revision" }; snapshot: Uint8Array }[] }): string[];
}

export interface ValidateResult {
  ok: boolean;
  counts: { events: number; objects: number; snapshots: number; documents: number; annotations: number; conflicts: number; incomplete: number };
  bySeverity: { error: number; warning: number; info: number };
  problems: Problem[];
  truncated: number;
}

const decoder = new TextDecoder();

export async function validate(store: StorageBackend, options: ValidateOptions = {}): Promise<ValidateResult> {
  const data = await loadRepository(store);
  const state = project(data);
  const problems: Problem[] = [...data.problems];
  const add = (problem: Problem) => problems.push(problem);

  if (data.config.version === "missing") add({ code: "missing-config", severity: data.events.size ? "error" : "info", path: layout.config, message: "review is not enabled in this checkout (no config.json)" });

  // Snapshots: the name is the hash of the bytes.
  for (const sha of data.snapshots) {
    const bytes = await store.read(layout.snapshot(sha));
    if (bytes && sha256(bytes) !== sha) add({ code: "hash-mismatch", severity: "error", path: layout.snapshot(sha), message: "snapshot bytes do not match the file name hash" });
  }
  // Canonical serialization: hand edits or merge tools that reformat JSON change object hashes.
  for (const sha of data.objects.keys()) {
    const bytes = await store.read(layout.object(sha));
    if (bytes && !isCanonical(decoder.decode(bytes))) add({ code: "non-canonical", severity: "warning", path: layout.object(sha), message: "not in canonical serialization" });
  }
  for (const id of data.events.keys()) {
    const bytes = await store.read(layout.event(id));
    if (bytes && !isCanonical(decoder.decode(bytes))) add({ code: "non-canonical", severity: "warning", path: layout.event(id), message: "not in canonical serialization" });
  }

  checkReferences(data, state, add);
  checkSemantics(state, add);

  for (const { eventId, reason } of state.ignored) {
    add({ code: "ignored-change", severity: "error", path: layout.event(eventId), message: reason });
  }
  for (const [entity, reasons] of [...state.incomplete].sort(([a], [b]) => (a < b ? -1 : 1))) {
    add({ code: "incomplete", severity: "error", entity, message: reasons.slice(0, 3).join("; ") + (reasons.length > 3 ? ` (+${reasons.length - 3})` : "") });
  }
  for (const conflict of state.conflicts) {
    add({ code: "conflict", severity: "warning", entity: conflict.entity, message: `${conflict.register}: ${conflict.candidates.map((candidate) => candidate.eventId).join(", ")} disagree` });
  }
  for (const reason of state.repoReadOnly) add({ code: "read-only", severity: "warning", message: reason });

  if (options.checkRevision) {
    for (const record of state.revisions.values()) {
      const revision = revisionObject(state, record.revisionId);
      if (!revision) continue;
      const snapshot = await store.read(layout.snapshot(revision.snapshot));
      if (!snapshot) continue;
      const parents = [];
      let complete = true;
      for (const parentId of revision.parents) {
        const parent = revisionObject(state, parentId);
        const parentSnapshot = parent ? await store.read(layout.snapshot(parent.snapshot)) : null;
        if (!parent || !parentSnapshot) { complete = false; break; }
        parents.push({ revision: parent, snapshot: parentSnapshot });
      }
      if (!complete) continue; // already reported as incomplete
      for (const message of options.checkRevision({ revision, snapshot, parents })) {
        add({ code: "revision-mismatch", severity: "error", path: layout.object(record.objectSha), entity: `doc:${record.docId}`, message });
      }
    }
  }

  // Orphans: left by an interrupted publish before its event; harmless and reported for the size view.
  const referencedObjects = new Set<string>();
  const referencedSnapshots = new Set<string>();
  for (const operation of data.events.values()) for (const sha of operationReferences(operation).objects) referencedObjects.add(sha);
  for (const sha of referencedObjects) {
    const object = data.objects.get(sha);
    if (object) for (const snapshot of objectReferences(object).snapshots) referencedSnapshots.add(snapshot);
  }
  const orphanObjects = [...data.objects.keys()].filter((sha) => !referencedObjects.has(sha));
  const orphanSnapshots = [...data.snapshots].filter((sha) => !referencedSnapshots.has(sha));
  if (orphanObjects.length || orphanSnapshots.length) {
    add({ code: "unreferenced", severity: "info", message: `${orphanObjects.length} object(s) and ${orphanSnapshots.length} snapshot(s) are not referenced by any event (an interrupted write leaves these)` });
  }

  const limit = options.limit ?? 50;
  const order = { error: 0, warning: 1, info: 2 } as const;
  problems.sort((a, b) => order[a.severity] - order[b.severity] || a.code.localeCompare(b.code) || (a.path ?? a.entity ?? "").localeCompare(b.path ?? b.entity ?? ""));
  const bySeverity = { error: 0, warning: 0, info: 0 };
  for (const problem of problems) bySeverity[problem.severity]++;
  const annotations = [...state.byEntity.keys()].filter((key) => key.startsWith("annotation:")).length;
  return {
    ok: bySeverity.error === 0,
    counts: { events: data.events.size, objects: data.objects.size, snapshots: data.snapshots.size, documents: state.documents.size, annotations, conflicts: state.conflicts.length, incomplete: state.incomplete.size },
    bySeverity,
    problems: problems.slice(0, limit),
    truncated: Math.max(0, problems.length - limit),
  };
}

function checkReferences(data: RepositoryData, state: State, add: (problem: Problem) => void) {
  for (const [id, operation] of data.events) {
    const refs = operationReferences(operation);
    for (const sha of refs.objects) {
      if (!data.objects.has(sha) && !data.opaqueObjects.has(sha)) add({ code: "dangling-object", severity: "error", path: layout.event(id), message: `object ${sha} is missing or invalid` });
    }
    for (const parent of refs.events) {
      if (!data.events.has(parent) && !data.opaque.has(parent)) add({ code: "dangling-parent", severity: "error", path: layout.event(id), message: `parent event ${parent} is missing` });
    }
    for (const revisionId of refs.revisions) {
      if (!state.revisions.has(revisionId)) add({ code: "dangling-revision", severity: "error", path: layout.event(id), message: `revision ${revisionId} is not persistent in this journal` });
    }
  }
  // Only objects some event points at: an orphan of an interrupted write confirms nothing.
  const reachable = new Set([...data.events.values()].flatMap((operation) => operationReferences(operation).objects));
  for (const [sha, object] of data.objects) {
    if (!reachable.has(sha)) continue;
    const refs = objectReferences(object);
    for (const snapshot of refs.snapshots) {
      if (!data.snapshots.has(snapshot)) add({ code: "dangling-snapshot", severity: "error", path: layout.object(sha), message: `snapshot ${snapshot} is missing` });
    }
    for (const revisionId of refs.revisions) {
      if (!state.revisions.has(revisionId)) add({ code: "dangling-revision", severity: "error", path: layout.object(sha), message: `revision ${revisionId} is not persistent in this journal` });
    }
  }
}

function checkSemantics(state: State, add: (problem: Problem) => void) {
  const receipts = new Map<string, string>();
  for (const id of state.order) {
    const operation = state.events.get(id)!;
    for (const change of operation.changes) {
      if (change.type === "conflict.resolved") {
        const notAncestors = change.resolves.filter((resolved) => !state.isAncestorIn(`annotation:${change.annotationId}`, resolved, id));
        if (notAncestors.length) add({ code: "bad-resolution", severity: "error", path: layout.event(id), message: `resolves events that are not its ancestors: ${notAncestors.join(", ")}` });
      }
      if (change.type === "read.acknowledged") {
        const key = JSON.stringify(change);
        const previous = receipts.get(change.receiptId);
        if (previous !== undefined && previous !== key) add({ code: "duplicate-receipt", severity: "error", path: layout.event(id), message: `receipt ${change.receiptId} reused with other content` });
        receipts.set(change.receiptId, key);
        const revision = revisionObject(state, change.revisionId);
        if (revision) {
          const versions = new Set(revision.blocks.map((block) => block.versionId));
          const foreign = change.versions.filter((ref) => !versions.has(ref.versionId)).length;
          if (foreign) add({ code: "foreign-version", severity: "warning", path: layout.event(id), message: `${foreign} receipt version(s) are not in revision ${change.revisionId}; they are ignored` });
        }
      }
      if ((change.type === "read.acknowledged" || change.type === "read.revoked") && (operation.actor.kind !== "human" || operation.actor.email.trim().toLowerCase() !== change.readerId)) {
        add({ code: "foreign-receipt", severity: "error", path: layout.event(id), message: `${change.type} for ${change.readerId} written by another actor; ignored` });
      }
      if ((change.type === "layout.pinned" || change.type === "layout.unpinned") && (operation.actor.kind !== "human" || operation.actor.email.trim().toLowerCase() !== change.scope.reader)) {
        add({ code: "foreign-layout", severity: "error", path: layout.event(id), message: `${change.type} for ${change.scope.reader} written by another actor; ignored` });
      }
    }
  }
}
