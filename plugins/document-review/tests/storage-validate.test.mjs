// EP-005-T06: validate finds dangling refs, wrong hashes, unknown schemas and conflicts; output is bounded.
import assert from "node:assert/strict";
import test from "node:test";
import { canonicalBytes, canonicalJson } from "../core/canonical-json.ts";
import { sha256 } from "../core/hash.ts";
import { layout, MemoryBackend } from "../core/store.ts";
import { validate } from "../core/validate.ts";
import { annotationObject, bob, bytes, id, mergeStores, objectSha, observe, revision, stateOf, write } from "./helpers.mjs";

const repoId = id("repo");

async function healthy() {
  const store = new MemoryBackend();
  store.files.set(layout.config, canonicalBytes({ schemaVersion: "1.0", repoId, roots: ["docs"], hidden: [], untracked: [] }));
  const docId = id("doc");
  const revisionId = id("rev");
  const rev = revision({ revisionId, docId, text: "Hello\n", blocks: [{ lineageId: `${revisionId}.0`, versionId: `${revisionId}.0`, content: "Hello" }] });
  await observe(store, rev, { register: true, reason: "baseline" });
  const annotationId = id("ann");
  const annotation = annotationObject({ repoId, annotationId, docId, revisionId, snapshotSha: rev.object.snapshot });
  await write(store, { changes: [{ type: "annotation.created", annotationId, docId, annotation: objectSha(annotation), kind: "action", messageId: id("m1") }], objects: [annotation] });
  await write(store, { changes: [{ type: "read.acknowledged", receiptId: id("r1"), readerId: "alice@example.com", docId, revisionId, scope: "document", versions: [{ lineageId: `${revisionId}.0`, versionId: `${revisionId}.0` }], tombstones: [] }] });
  return { store, docId, revisionId, annotationId, rev, annotation };
}

const codes = (report) => report.problems.map((problem) => problem.code);

test("a consistent repository validates clean", async () => {
  const { store } = await healthy();
  const report = await validate(store);
  assert.equal(report.ok, true);
  assert.deepEqual(report.bySeverity, { error: 0, warning: 0, info: 0 });
  assert.deepEqual(report.counts, { events: 3, objects: 2, snapshots: 1, documents: 1, annotations: 1, conflicts: 0, incomplete: 0 });
});

test("dangling refs: missing object, snapshot and parent event are errors with paths", async () => {
  const { store, rev, annotation } = await healthy();
  store.files.delete(layout.object(objectSha(annotation)));
  store.files.delete(layout.snapshot(rev.object.snapshot));
  const report = await validate(store);
  assert.equal(report.ok, false);
  assert.ok(codes(report).includes("dangling-object"));
  assert.ok(codes(report).includes("dangling-snapshot"));
  assert.ok(codes(report).includes("incomplete"));
  for (const problem of report.problems.filter((p) => p.code.startsWith("dangling"))) assert.ok(problem.path, "each problem names its file");

  const second = await healthy();
  const parentless = second.store;
  await write(parentless, { changes: [{ type: "discussion.closed", annotationId: second.annotationId }] });
  const state = await stateOf(parentless);
  const named = state.order.find((eventId) => [...state.events.values()].some((operation) => operation.parents.includes(eventId)));
  parentless.files.delete(layout.event(named));
  assert.ok(codes(await validate(parentless)).includes("dangling-parent"));
});

test("wrong hashes: a snapshot or object whose bytes do not match its name", async () => {
  const { store, rev, annotation } = await healthy();
  store.files.set(layout.snapshot(rev.object.snapshot), bytes("edited by hand\n"));
  const objectPath = layout.object(objectSha(annotation));
  const tampered = JSON.parse(new TextDecoder().decode(store.files.get(objectPath)));
  tampered.body.value = "changed";
  store.files.set(objectPath, canonicalBytes(tampered));
  const report = await validate(store);
  assert.equal(report.problems.filter((problem) => problem.code === "hash-mismatch").length, 2);
});

test("unknown schemas and damaged files are reported, not loaded", async () => {
  const { store } = await healthy();
  const future = { schemaVersion: "3.0", id: id("future"), actor: { kind: "human", name: "X", email: "x@example.com" }, timestamp: "2026-10-06T12:00:00.000Z", parents: [], changes: [] };
  store.files.set(layout.event(future.id), canonicalBytes(future));
  store.files.set(layout.event(id("broken")), bytes("{ not json"));
  const strayObject = canonicalBytes({ type: "Mystery", schemaVersion: "1.0" });
  store.files.set(layout.object(sha256(strayObject)), strayObject);
  const report = await validate(store);
  assert.ok(codes(report).includes("unknown-schema"));
  assert.ok(codes(report).filter((code) => code === "schema-invalid").length >= 2);
  assert.ok(codes(report).includes("read-only"));
});

test("conflicts and non-canonical files are reported as warnings", async () => {
  const { store, annotationId } = await healthy();
  const left = store.clone();
  const right = store.clone();
  await write(left, { changes: [{ type: "discussion.closed", annotationId }] });
  await write(right, { actor: bob, changes: [{ type: "annotation.withdrawn", annotationId }] });
  const merged = mergeStores(left, right);
  const [eventPath] = (await merged.list("events"));
  const pretty = JSON.stringify(JSON.parse(new TextDecoder().decode(merged.files.get(eventPath))));
  merged.files.set(eventPath, bytes(pretty));
  const report = await validate(merged);
  assert.ok(codes(report).includes("conflict"));
  assert.ok(codes(report).includes("non-canonical"));
  assert.equal(report.counts.conflicts, 1);
});

test("a resolution must name its own ancestors; a reused receipt id with other content is an error", async () => {
  const { store, annotationId, docId, revisionId } = await healthy();
  await write(store, { changes: [{ type: "conflict.resolved", annotationId, field: "status", value: "closed", resolves: [id("x"), id("y")].sort() }] });
  await write(store, { changes: [{ type: "read.acknowledged", receiptId: id("r1"), readerId: "alice@example.com", docId, revisionId, scope: "block", versions: [], tombstones: [] }] });
  const report = await validate(store);
  assert.ok(codes(report).includes("bad-resolution"));
  assert.ok(codes(report).includes("duplicate-receipt"));
});

test("output is bounded and structured", async () => {
  const { store } = await healthy();
  for (let index = 0; index < 120; index++) store.files.set(`objects/zz/junk-${index}.json`, bytes("{}"));
  const report = await validate(store, { limit: 10 });
  assert.equal(report.problems.length, 10);
  assert.equal(report.truncated, 110);
  assert.equal(report.bySeverity.warning, 120);
  assert.doesNotThrow(() => canonicalJson(report));
  for (const problem of report.problems) {
    assert.ok(["error", "warning", "info"].includes(problem.severity));
    assert.equal(typeof problem.code, "string");
    assert.equal(typeof problem.message, "string");
  }
});

test("revision recomputation hook reports mismatches", async () => {
  const { store } = await healthy();
  const report = await validate(store, { checkRevision: ({ revision }) => (revision.blocks.length === 1 ? ["block 0: semanticHash differs"] : []) });
  assert.ok(codes(report).includes("revision-mismatch"));
});
