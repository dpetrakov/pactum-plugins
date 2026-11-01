// EP-005-T03: projection by causal parents, merge of two branches, explicit conflicts, incomplete journals.
import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../core/canonical-json.ts";
import { discussion } from "../core/discussion.ts";
import { entity, loadRepository, project, writeBlockers } from "../core/journal.ts";
import { layout, MemoryBackend } from "../core/store.ts";
import { alice, annotationObject, bob, id, mergeStores, objectSha, observe, revision, shuffled, stateOf, write } from "./helpers.mjs";

const repoId = id("repo");

/** A document with one revision and one annotation. */
async function seed(store, label = "a") {
  const docId = id(`doc-${label}`);
  const revisionId = id(`rev-${label}`);
  const rev = revision({ revisionId, docId, path: `docs/${label}.md`, text: `# ${label}\n`, blocks: [{ lineageId: `${revisionId}.0`, versionId: `${revisionId}.0`, content: label }] });
  await observe(store, rev, { register: true, reason: "baseline" });
  const annotationId = id(`ann-${label}`);
  const annotation = annotationObject({ repoId, annotationId, docId, revisionId, snapshotSha: rev.object.snapshot, path: `docs/${label}.md` });
  await write(store, { changes: [{ type: "annotation.created", annotationId, docId, annotation: objectSha(annotation), kind: "action", messageId: id(`m1-${label}`) }], objects: [annotation] });
  return { docId, revisionId, annotationId };
}

/** Everything the projection decides, in a comparable form. */
function summary(state) {
  return canonicalJson({
    order: state.order,
    heads: Object.fromEntries([...state.heads].sort()),
    registers: Object.fromEntries([...state.registers].sort()),
    conflicts: state.conflicts,
    incomplete: Object.fromEntries([...state.incomplete].sort()),
    documents: Object.fromEntries([...state.documents].sort()),
  });
}

class ShuffledListing extends MemoryBackend {
  constructor(source, seed) {
    super();
    for (const [path, content] of source.files) this.files.set(path, content);
    this.seed = seed;
  }
  async list(dir) {
    return shuffled(await super.list(dir), this.seed);
  }
}

test("the projection does not depend on file order (permutations)", async () => {
  const store = new MemoryBackend();
  const a = await seed(store, "a");
  await seed(store, "b");
  for (let index = 0; index < 6; index++) {
    await write(store, { actor: index % 2 ? bob : alice, changes: [{ type: "message.appended", annotationId: a.annotationId, messageId: id(`extra-${index}`), text: `reply ${index}` }] });
  }
  await write(store, { changes: [{ type: "discussion.closed", annotationId: a.annotationId }] });
  const expected = summary(project(await loadRepository(store)));
  for (let seed = 1; seed <= 25; seed++) {
    assert.equal(summary(project(await loadRepository(new ShuffledListing(store, seed)))), expected, `seed ${seed}`);
  }
});

test("the projection does not depend on machine clocks", async () => {
  const build = async (timestamps) => {
    const store = new MemoryBackend();
    const a = await seed(store, "a");
    const opA = await write(store, { opId: id("x1"), changes: [{ type: "discussion.closed", annotationId: a.annotationId }] });
    const opB = await write(store, { opId: id("x2"), changes: [{ type: "discussion.reopened", annotationId: a.annotationId }] });
    // Rewrite timestamps as a skewed clock would: the second event "happens before" the first.
    for (const [index, op] of [opA, opB].entries()) {
      const path = layout.event(op.operation.id);
      const value = JSON.parse(new TextDecoder().decode(store.files.get(path)));
      value.timestamp = timestamps[index];
      store.files.set(path, new TextEncoder().encode(canonicalJson(value)));
    }
    return project(await loadRepository(store));
  };
  const normal = await build(["2026-10-06T12:00:00.000Z", "2026-10-06T12:05:00.000Z"]);
  const skewed = await build(["2026-10-06T12:05:00.000Z", "1999-01-01T00:00:00.000Z"]);
  assert.equal(normal.registers.get(`${entity.annotation(id("ann-a"))}#status`).value, "open");
  assert.equal(skewed.registers.get(`${entity.annotation(id("ann-a"))}#status`).value, "open", "parents decide, not timestamps");
  for (const state of [normal, skewed]) assert.ok(state.order.indexOf(id("x1")) < state.order.indexOf(id("x2")));
});

test("AC10/AC12: a merge of two branches unites independent entities and both replies", async () => {
  const base = new MemoryBackend();
  const { annotationId } = await seed(base, "a");
  const left = base.clone();
  const right = base.clone();
  await write(left, { actor: alice, changes: [{ type: "message.appended", annotationId, messageId: id("left-reply"), text: "from left" }] });
  await seed(left, "only-left");
  await write(right, { actor: bob, changes: [{ type: "message.appended", annotationId, messageId: id("right-reply"), text: "from right" }] });
  await seed(right, "only-right");
  const merged = project(await loadRepository(mergeStores(left, right)));
  assert.equal(merged.conflicts.length, 0);
  assert.equal(merged.documents.size, 3);
  const view = discussion(merged, annotationId);
  assert.deepEqual(view.messages.map((message) => message.current.text).sort(), ["Fix this", "from left", "from right"]);
  assert.equal(merged.heads.get(entity.annotation(annotationId)).length, 2, "two heads until the next write joins them");
  const next = await write(mergeStores(left, right), { changes: [{ type: "discussion.closed", annotationId }] });
  assert.equal(next.operation.parents.length, 2);
});

test("AC12: concurrent close/reopen is an explicit conflict, then a resolution event decides", async () => {
  const base = new MemoryBackend();
  const { annotationId } = await seed(base, "a");
  const left = base.clone();
  const right = base.clone();
  const closed = await write(left, { changes: [{ type: "discussion.closed", annotationId }] });
  await write(right, { actor: bob, changes: [{ type: "discussion.closed", annotationId }] });
  const reopened = await write(right, { actor: bob, changes: [{ type: "discussion.reopened", annotationId }] });
  const merged = mergeStores(left, right);
  let state = await stateOf(merged);
  assert.equal(state.registers.get(`${entity.annotation(annotationId)}#status`).value, null, "no last-write-wins");
  assert.deepEqual(state.conflicts.map((conflict) => conflict.register), ["status"]);
  assert.deepEqual(state.conflicts[0].candidates.map((candidate) => candidate.value).sort(), ["closed", "open"]);
  assert.ok(writeBlockers(state, [entity.annotation(annotationId)]).some((reason) => reason.includes("conflict")));
  assert.equal(discussion(state, annotationId).candidate, false, "conflicting annotation is not sent anywhere");
  await write(merged, { changes: [{ type: "conflict.resolved", annotationId, field: "status", value: "closed", resolves: [closed.operation.id, reopened.operation.id].sort() }] });
  state = await stateOf(merged);
  assert.equal(state.conflicts.length, 0);
  assert.equal(state.registers.get(`${entity.annotation(annotationId)}#status`).value, "closed");
});

test("AC12: two different edits of one message conflict; equal concurrent decisions do not", async () => {
  const base = new MemoryBackend();
  const { annotationId } = await seed(base, "a");
  const messageId = id("m1-a");
  const left = base.clone();
  const right = base.clone();
  const l = await write(left, { changes: [{ type: "message.revised", annotationId, messageId, text: "version L" }] });
  const r = await write(right, { changes: [{ type: "message.revised", annotationId, messageId, text: "version R" }] });
  await write(left, { changes: [{ type: "annotation.kind-changed", annotationId, kind: "note" }] });
  await write(right, { actor: bob, changes: [{ type: "annotation.kind-changed", annotationId, kind: "note" }] });
  const merged = mergeStores(left, right);
  let state = await stateOf(merged);
  assert.deepEqual(state.conflicts.map((conflict) => conflict.register), [`message:${messageId}`]);
  assert.equal(discussion(state, annotationId).messages[0].current, null);
  assert.equal(state.registers.get(`${entity.annotation(annotationId)}#kind`).value, "note");
  await write(merged, { changes: [{ type: "conflict.resolved", annotationId, field: "message", messageId, value: r.operation.id, resolves: [l.operation.id, r.operation.id].sort() }] });
  state = await stateOf(merged);
  assert.equal(state.conflicts.length, 0);
  assert.equal(discussion(state, annotationId).messages[0].current.text, "version R");
});

test("an incomplete journal marks only the affected entities and forbids dangerous writes there", async () => {
  const store = new MemoryBackend();
  const a = await seed(store, "a");
  const b = await seed(store, "b");
  // A partial commit: the annotation object of b is missing.
  const annotationEvent = [...(await stateOf(store)).byEntity.get(entity.annotation(b.annotationId))][0];
  const created = (await stateOf(store)).events.get(annotationEvent).changes[0];
  store.files.delete(layout.object(created.annotation));
  const state = await stateOf(store);
  assert.deepEqual([...state.incomplete.keys()], [entity.annotation(b.annotationId)]);
  assert.ok(writeBlockers(state, [entity.annotation(b.annotationId)]).length > 0);
  assert.deepEqual(writeBlockers(state, [entity.annotation(a.annotationId), entity.doc(a.docId)]), []);
  assert.equal(discussion(state, a.annotationId).candidate, true);
  assert.equal(discussion(state, b.annotationId).candidate, false);
});

test("a missing parent event (half-committed branch) marks the event's entities incomplete", async () => {
  const store = new MemoryBackend();
  const a = await seed(store, "a");
  const reply = await write(store, { changes: [{ type: "message.appended", annotationId: a.annotationId, messageId: id("r"), text: "reply" }] });
  await write(store, { changes: [{ type: "discussion.closed", annotationId: a.annotationId }] });
  store.files.delete(layout.event(reply.operation.id));
  const state = await stateOf(store);
  assert.ok(state.incomplete.get(entity.annotation(a.annotationId)).some((reason) => reason.includes("missing parent")));
  assert.equal(state.incomplete.has(entity.doc(a.docId)), false);
});

test("an event of an unknown major version makes the repository read-only instead of being misread", async () => {
  const store = new MemoryBackend();
  await seed(store, "a");
  const foreign = { schemaVersion: "2.0", id: id("future"), actor: alice, timestamp: "2026-10-06T12:00:00.000Z", parents: [], changes: [{ type: "quantum.entangled" }] };
  store.files.set(layout.event(foreign.id), new TextEncoder().encode(canonicalJson(foreign)));
  const state = await stateOf(store);
  assert.equal(state.events.has(foreign.id), false);
  assert.ok(state.repoReadOnly.length > 0);
  assert.ok(writeBlockers(state, []).length > 0);
});
