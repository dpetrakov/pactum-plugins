// EP-005-T02: publish protocol and recovery after a crash at every step.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256 } from "../core/hash.ts";
import { loadRepository, project } from "../core/journal.ts";
import { SCHEMA_VERSION } from "../core/schema.ts";
import { CrashingBackend, encodeOperation, layout, MemoryBackend, publish, StoreError, writeConfig } from "../core/store.ts";
import { validate } from "../core/validate.ts";
import { FsBackend } from "../node/fs-backend.ts";
import { alice, annotationObject, bytes, id, objectSha, observe, revision, stateOf, timestamp } from "./helpers.mjs";

const repoId = id("repo");
const docId = id("doc");
const revA = id("revA");

/** An operation that needs one snapshot and two objects: observe a revision and annotate it. */
function annotateDraft(parents = []) {
  const rev = revision({ revisionId: revA, docId, text: "# Title\n\nHello world\n", blocks: [{ lineageId: `${revA}.0`, versionId: `${revA}.0`, content: "Title" }, { lineageId: `${revA}.1`, versionId: `${revA}.1`, content: "Hello world" }] });
  const annotationId = id("ann");
  const annotation = annotationObject({ repoId, annotationId, docId, revisionId: revA, snapshotSha: rev.object.snapshot });
  const operation = {
    schemaVersion: SCHEMA_VERSION, id: id("op-annotate"), actor: alice, timestamp: "2026-10-06T12:00:00.000Z", parents,
    changes: [
      { type: "document.registered", docId, path: "docs/a.md" },
      { type: "document.observed", docId, revisionId: revA, revision: objectSha(rev.object), reason: "reference" },
      { type: "annotation.created", annotationId, docId, annotation: objectSha(annotation), kind: "action", messageId: id("m1") },
    ],
  };
  return { operation, objects: [rev.object, annotation], snapshots: [rev.snapshot] };
}

const noRevisions = { isKnownRevision: () => false };

test("publish writes snapshot and objects before the event; the event is the commit point", async () => {
  const store = new MemoryBackend();
  const order = [];
  const spy = { read: (p) => store.read(p), list: (d) => store.list(d), replace: store.replace.bind(store),
    createExclusive: async (p, b) => { order.push(p.split("/")[0]); return store.createExclusive(p, b); } };
  const result = await publish(spy, annotateDraft(), noRevisions);
  assert.equal(result.status, "published");
  assert.deepEqual(order, ["snapshots", "objects", "objects", "events"]);
  assert.deepEqual(result.created, { snapshots: 1, objects: 2 });
  const report = await validate(store);
  assert.equal(report.bySeverity.error, 1, "only the missing config");
  assert.equal(report.problems[0].code, "missing-config");
});

test("a crash at any step never confirms an operation without its objects and never loses a confirmed one", async () => {
  const steps = 4; // snapshot, object, object, event
  for (let crashAt = 0; crashAt < steps; crashAt++) {
    for (const when of ["before", "after"]) {
      const store = new MemoryBackend();
      const crashing = new CrashingBackend(store, crashAt, when);
      const draft = annotateDraft();
      await assert.rejects(publish(crashing, draft, noRevisions), (error) => error instanceof StoreError && error.code === "crash");
      const confirmed = (await store.read(layout.event(draft.operation.id))) !== null;
      // Only a crash after the event write leaves a confirmed operation.
      assert.equal(confirmed, crashAt === steps - 1 && when === "after", `step ${crashAt} ${when}`);
      const before = await validate(store);
      assert.equal(before.problems.filter((problem) => problem.code.startsWith("dangling")).length, 0, `no dangling refs at step ${crashAt} ${when}`);

      // Recovery: the client retries the same operation (same id, same bytes); replay restores the projection.
      const retry = await publish(store, draft, noRevisions);
      assert.equal(retry.status, confirmed ? "duplicate" : "published");
      const state = project(await loadRepository(store));
      assert.deepEqual([...state.events.keys()], [draft.operation.id]);
      assert.equal(state.documents.get(docId).path, "docs/a.md");
      assert.ok(state.revisions.has(revA));
      assert.equal(state.incomplete.size, 0);
    }
  }
});

test("idempotent by operation id: same bytes are a duplicate, other bytes are refused and nothing is replaced", async () => {
  const store = new MemoryBackend();
  const draft = annotateDraft();
  await publish(store, draft, noRevisions);
  assert.equal((await publish(store, draft, noRevisions)).status, "duplicate");
  const original = await store.read(layout.event(draft.operation.id));
  const other = structuredClone(draft);
  other.operation.timestamp = "2026-10-06T13:00:00.000Z";
  await assert.rejects(publish(store, other, noRevisions), (error) => error.code === "operation-conflict");
  assert.deepEqual(await store.read(layout.event(draft.operation.id)), original);
  assert.deepEqual(await store.read(layout.event(draft.operation.id)), encodeOperation(draft.operation));
});

test("an existing content-hash file is reused only with identical bytes; a damaged one is replaced atomically", async () => {
  const store = new MemoryBackend();
  const draft = annotateDraft();
  const snapshotSha = sha256(draft.snapshots[0]);
  // A short file left by a crash: its bytes do not match its own name.
  store.files.set(layout.snapshot(snapshotSha), bytes("# Tit"));
  const result = await publish(store, draft, noRevisions);
  assert.equal(result.status, "published");
  assert.deepEqual(await store.read(layout.snapshot(snapshotSha)), draft.snapshots[0]);
  // A backend that refuses the replacement: the write stops before the event.
  const stubborn = new MemoryBackend();
  stubborn.files.set(layout.snapshot(snapshotSha), bytes("# Tit"));
  stubborn.replace = async () => "mismatch";
  await assert.rejects(publish(stubborn, annotateDraft(), noRevisions), (error) => error.code === "corrupt-object");
  assert.equal(await stubborn.read(layout.event(draft.operation.id)), null, "no event after a refused write");
});

test("references must resolve before anything is written: missing parent, object or revision", async () => {
  const store = new MemoryBackend();
  const withParent = annotateDraft([id("never-written")]);
  await assert.rejects(publish(store, withParent, noRevisions), (error) => error.code === "missing-reference");
  const withoutObjects = annotateDraft();
  withoutObjects.objects = [];
  await assert.rejects(publish(store, withoutObjects, noRevisions), (error) => error.code === "missing-reference");
  const receipt = {
    schemaVersion: SCHEMA_VERSION, id: id("op-receipt"), actor: alice, timestamp: timestamp(), parents: [],
    changes: [{ type: "read.acknowledged", receiptId: id("r"), readerId: "alice@example.com", docId, revisionId: id("unknown-rev"), scope: "block", versions: [], tombstones: [] }],
  };
  await assert.rejects(publish(store, { operation: receipt, objects: [], snapshots: [] }, noRevisions), /revision/);
  assert.equal(store.files.size, 0);
});

test("a revision object must match its document.observed change", async () => {
  const draft = annotateDraft();
  draft.operation.changes[1].revisionId = id("other");
  await assert.rejects(publish(new MemoryBackend(), draft, { isKnownRevision: () => true }), (error) => error.code === "invalid-operation");
});

test("config is replaced only by compare-and-swap on its sha256", async () => {
  const store = new MemoryBackend();
  const first = bytes(`{"schemaVersion":"1.0"}\n`);
  assert.equal(await writeConfig(store, first, "0".repeat(64)), "mismatch");
  assert.equal(await writeConfig(store, first, null), "replaced");
  assert.equal(await writeConfig(store, bytes("x"), null), "mismatch");
  assert.equal(await writeConfig(store, bytes("x"), sha256(first)), "replaced");
});

test("FsBackend: create-only via link never replaces, CAS rename, no temp files left", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-"));
  try {
    const store = new FsBackend(path.join(dir, ".bb-docs"));
    const result = await publish(store, annotateDraft(), noRevisions);
    assert.equal(result.status, "published");
    assert.equal(store.lastCreateMode, "link");
    const eventPath = layout.event(id("op-annotate"));
    assert.equal(await store.createExclusive(eventPath, bytes("other")), "exists");
    assert.deepEqual(await store.read(eventPath), encodeOperation(annotateDraft().operation));
    const config = bytes("{}\n");
    assert.equal(await store.replace("config.json", config, null), "replaced");
    assert.equal(await store.replace("config.json", bytes("[]\n"), null), "mismatch");
    // Concurrent CAS from one process: exactly one of two writers with the same expectation wins.
    const outcomes = await Promise.all([store.replace("config.json", bytes("1\n"), sha256(config)), store.replace("config.json", bytes("2\n"), sha256(config))]);
    assert.deepEqual(outcomes.sort(), ["mismatch", "replaced"]);
    const all = await fs.readdir(path.join(dir, ".bb-docs"), { recursive: true });
    assert.equal(all.filter((name) => path.basename(name).startsWith(".tmp-")).length, 0);
    assert.deepEqual(await store.list("events"), [eventPath]);
    await assert.rejects(store.read("../outside.json"), /not a .bb-docs path/);
    await assert.rejects(store.createExclusive("events/../../x.json", bytes("x")), /not a .bb-docs path/);
    // Replay from disk equals replay from memory.
    const state = project(await loadRepository(store));
    assert.equal(state.documents.get(docId).path, "docs/a.md");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("FsBackend: concurrent create-only of one event, exactly one creates", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-"));
  try {
    const store = new FsBackend(path.join(dir, ".bb-docs"));
    const target = layout.event(id("race"));
    const outcomes = await Promise.all(Array.from({ length: 8 }, (_, index) => store.createExclusive(target, bytes(`writer ${index}`))));
    assert.equal(outcomes.filter((outcome) => outcome === "created").length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("observe helper: a later operation names the current heads as parents", async () => {
  const store = new MemoryBackend();
  const rev = revision({ revisionId: revA, docId, blocks: [{ lineageId: `${revA}.0`, versionId: `${revA}.0`, content: "x" }] });
  const first = await observe(store, rev, { register: true, reason: "baseline" });
  const revB = id("revB");
  const second = await observe(store, revision({ revisionId: revB, docId, parents: [revA], text: "y", blocks: [{ lineageId: `${revA}.0`, versionId: `${revB}.0`, content: "y" }] }));
  assert.deepEqual(second.operation.parents, [first.operation.id]);
  const state = await stateOf(store);
  assert.deepEqual(state.documents.get(docId).headRevisions, [revB]);
});
