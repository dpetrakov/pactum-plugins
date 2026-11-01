// Test helpers: deterministic ids, synthetic revisions and a tiny writer over the real publish protocol.
import { sha256 } from "../core/hash.ts";
import { loadRepository, operationEntities, parentsFor, project } from "../core/journal.ts";
import { SCHEMA_VERSION } from "../core/schema.ts";
import { encodeObject, MemoryBackend, publish } from "../core/store.ts";

/** Deterministic UUID-shaped id from a number or a short label. */
export function id(seed) {
  const hex = typeof seed === "number" ? seed.toString(16) : sha256(String(seed)).slice(0, 12);
  return `00000000-0000-4000-8000-${hex.padStart(12, "0").slice(-12)}`;
}

export const alice = { kind: "human", name: "Alice", email: "alice@example.com" };
export const bob = { kind: "human", name: "Bob", email: "bob@example.com" };
export const agent = { kind: "agent", model: "claude-opus-5-5", threadId: "thr_test", requestedBy: { name: "Alice", email: "alice@example.com" } };

let clock = 0;
let opCounter = 0;
export function timestamp() {
  clock++;
  return new Date(Date.UTC(2026, 9, 6, 12, 0, 0) + clock * 1000).toISOString();
}

const encoder = new TextEncoder();
export const bytes = (text) => encoder.encode(text);

/**
 * Synthetic Revision: blocks given as [lineageSuffix, versionSuffix, contentLabel]; ids are `${revisionId}.${n}`
 * of the revisions named by the caller, so tests can model lineage across revisions without a parser.
 */
export function revision({ revisionId, docId, path = "docs/a.md", parents = [], text = "x", blocks = [], removed = [] }) {
  const snapshot = bytes(text);
  let offset = 0;
  return {
    snapshot,
    object: {
      type: "Revision",
      schemaVersion: SCHEMA_VERSION,
      revisionId,
      docId,
      path,
      parents,
      snapshot: sha256(snapshot),
      parser: { name: "test", version: "0" },
      projection: { profile: "bbdr-markdown", version: 1 },
      blocks: blocks.map(({ lineageId, versionId, content }) => {
        const start = offset;
        offset += content.length + 2;
        return {
          lineageId, versionId, type: "paragraph",
          range: { start, end: start + content.length }, source: { start, end: start + content.length },
          semanticHash: sha256(`semantic:${content}`), textHash: sha256(content), headings: [],
        };
      }),
      removed: removed.map(({ lineageId, versionId, text: removedText = "gone" }) => ({
        tombstoneId: `${revisionId}~${lineageId}`, lineageId, versionId, text: removedText, type: "paragraph",
        placement: { afterLineageId: null, beforeLineageId: null, sectionLineageId: null },
      })),
    },
  };
}

/** Write one operation through the real protocol with parents = current heads of the touched entities. */
export async function write(store, { actor = alice, changes, objects = [], snapshots = [], opId = undefined, parents = undefined }) {
  const state = project(await loadRepository(store));
  const operation = { schemaVersion: SCHEMA_VERSION, id: opId ?? id(`op-${++opCounter}`), actor, timestamp: timestamp(), parents: [], changes };
  operation.parents = parents ?? parentsFor(state, operationEntities(operation));
  const result = await publish(store, { operation, objects, snapshots }, { isKnownRevision: (revisionId) => state.revisions.has(revisionId) });
  return { operation, result };
}

export async function stateOf(store) {
  return project(await loadRepository(store));
}

export function objectSha(object) {
  return encodeObject(object).sha;
}

/** Register a document and observe a synthetic revision of it. */
export async function observe(store, rev, { reason = "reference", register = false, actor = alice } = {}) {
  const changes = [];
  if (register) changes.push({ type: "document.registered", docId: rev.object.docId, path: rev.object.path });
  changes.push({ type: "document.observed", docId: rev.object.docId, revisionId: rev.object.revisionId, revision: objectSha(rev.object), reason });
  return write(store, { actor, changes, objects: [rev.object], snapshots: [rev.snapshot] });
}

export function annotationObject({ repoId, annotationId, docId, revisionId, snapshotSha, text = "Fix this", path = "docs/a.md" }) {
  return {
    "@context": ["http://www.w3.org/ns/anno.jsonld", { bbdr: "urn:bb-docs:vocab:v1#" }],
    type: "Annotation",
    id: `urn:bb-docs:${repoId}:annotation:${annotationId}`,
    created: "2026-10-06T12:00:00.000Z",
    creator: { type: "Person", name: "Alice", email: "mailto:alice@example.com" },
    motivation: "commenting",
    body: { type: "TextualBody", value: text, format: "text/markdown" },
    target: {
      type: "SpecificResource",
      source: `urn:bb-docs:${repoId}:doc:${docId}:rev:${revisionId}:proj:bbdr-markdown/1`,
      selector: [
        { type: "TextQuoteSelector", exact: "quote", prefix: "", suffix: "" },
        { type: "TextPositionSelector", start: 0, end: 5 },
      ],
      "bbdr:targetKind": "text",
      "bbdr:docId": docId,
      "bbdr:revisionId": revisionId,
      "bbdr:path": path,
      "bbdr:snapshot": snapshotSha,
      "bbdr:segments": [],
      "bbdr:sourceRanges": [{ start: 0, end: 5 }],
    },
    "bbdr:schemaVersion": SCHEMA_VERSION,
  };
}

export function newStore() {
  return new MemoryBackend();
}

/** Union of two stores' files, like a Git merge of two branches that only added files. */
export function mergeStores(a, b) {
  const merged = a.clone();
  for (const [path, content] of b.files) if (!merged.files.has(path)) merged.files.set(path, content.slice());
  return merged;
}

/** Fisher–Yates with a seeded generator. */
export function shuffled(list, seed) {
  const copy = [...list];
  let state = seed;
  for (let index = copy.length - 1; index > 0; index--) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const other = state % (index + 1);
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}
