// EP-005-T05: discussion transitions and the batch item slice (DR-04; model parts of AC05, AC14, AC29).
import assert from "node:assert/strict";
import test from "node:test";
import { checkTransition, discussion, itemIdFor, nextItem, skipRequested } from "../core/discussion.ts";
import { SCHEMA_VERSION } from "../core/schema.ts";
import { MemoryBackend } from "../core/store.ts";
import { agent, alice, annotationObject, bob, id, objectSha, observe, revision, stateOf, write } from "./helpers.mjs";

const repoId = id("repo");
const docId = id("doc");
const revA = id("revA");

async function setup({ kind = "action" } = {}) {
  const store = new MemoryBackend();
  const rev = revision({ revisionId: revA, docId, text: "Hello\n", blocks: [{ lineageId: `${revA}.0`, versionId: `${revA}.0`, content: "Hello" }] });
  await observe(store, rev, { register: true, reason: "baseline" });
  const annotationId = id("ann");
  const annotation = annotationObject({ repoId, annotationId, docId, revisionId: revA, snapshotSha: rev.object.snapshot, text: "first" });
  await write(store, { changes: [{ type: "annotation.created", annotationId, docId, annotation: objectSha(annotation), kind, messageId: id("m1") }], objects: [annotation] });
  return { store, annotationId };
}

const say = (store, annotationId, text, actor = alice) => write(store, { actor, changes: [{ type: "message.appended", annotationId, messageId: id(`msg-${text}`), text }] });

async function prepare(store, runId, annotationIds) {
  const state = await stateOf(store);
  const items = annotationIds.map((annotationId) => nextItem(state, annotationId, runId)).filter(Boolean)
    .map(({ itemId, annotationId, seenHeads }) => ({ itemId, annotationId, seenHeads }));
  const manifest = { type: "BatchManifest", schemaVersion: SCHEMA_VERSION, runId, scope: { kind: "document", docId }, editScope: ["docs"],
    documents: [{ docId, path: "docs/a.md", revisionId: revA }], items, requestedBy: { name: "Alice", email: "alice@example.com" } };
  await write(store, { changes: [{ type: "batch.prepared", runId, manifest: objectSha(manifest), items }], objects: [manifest] });
  return items;
}

async function result(store, runId, item, status = "done", text = "Done.", responseId = id(`resp-${runId}-${status}-${text}`)) {
  const messageId = id(`agent-msg-${responseId}`);
  return write(store, { actor: agent, changes: [
    { type: "message.appended", annotationId: item.annotationId, messageId, text, runId, itemId: item.itemId },
    { type: "item.result-recorded", runId, attemptId: id(`att-${runId}`), itemId: item.itemId, responseId, annotationId: item.annotationId, status,
      seenHeads: item.seenHeads, messageId, before: [revA], after: [revA], claimedEdits: [] },
  ] });
}

test("AC29: three messages of one annotation are one item with a stable id and one slice", async () => {
  const { store, annotationId } = await setup();
  await say(store, annotationId, "second");
  await say(store, annotationId, "third");
  const state = await stateOf(store);
  const runId = id("run1");
  const item = nextItem(state, annotationId, runId);
  assert.equal(item.slice.length, 3);
  assert.equal(item.itemId, itemIdFor(runId, annotationId));
  assert.equal(nextItem(state, annotationId, runId).itemId, item.itemId, "stable");
  assert.notEqual(itemIdFor(id("run2"), annotationId), item.itemId);
  const view = discussion(state, annotationId);
  assert.equal(view.candidate, true);
  assert.equal(view.newInstructions.length, 3);
});

test("AC05: a reply written while the item runs is not consumed by the agent's answer", async () => {
  const { store, annotationId } = await setup();
  const runId = id("run1");
  const [item] = await prepare(store, runId, [annotationId]);
  let view = discussion(await stateOf(store), annotationId);
  assert.equal(view.candidate, false, "in flight");
  assert.equal(view.instructions[0].inFlight, runId);
  await say(store, annotationId, "also fix the title");
  await result(store, runId, item);
  view = discussion(await stateOf(store), annotationId);
  assert.deepEqual(view.instructions.map((instruction) => instruction.covered), [true, false]);
  assert.equal(view.candidate, true);
  const next = nextItem(await stateOf(store), annotationId, id("run2"));
  assert.equal(next.slice.length, 1, "only the new reply goes to the next batch");
});

test("DR-04: redelivery of the same response is idempotent; a skipped result covers nothing", async () => {
  const { store, annotationId } = await setup();
  const runId = id("run1");
  const [item] = await prepare(store, runId, [annotationId]);
  const responseId = id("resp-same");
  await result(store, runId, item, "skipped", "Skipped: closed", responseId);
  let view = discussion(await stateOf(store), annotationId);
  assert.equal(view.instructions[0].covered, false);
  assert.equal(view.candidate, true, "a skipped instruction is a candidate again");
  const again = await stateOf(store);
  const items = discussion(again, annotationId).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].results.length, 1);
});

test("AC29: a late result after closing or switching to note neither reopens nor turns the note into a task", async () => {
  for (const change of ["close", "note"]) {
    const { store, annotationId } = await setup();
    const runId = id(`run-${change}`);
    const [item] = await prepare(store, runId, [annotationId]);
    await write(store, { changes: [change === "close" ? { type: "discussion.closed", annotationId } : { type: "annotation.kind-changed", annotationId, kind: "note" }] });
    let view = discussion(await stateOf(store), annotationId);
    assert.equal(skipRequested(view), true, "the prepared item gets a skip request; the manifest stays");
    assert.equal(view.items.length, 1);
    await result(store, runId, item, "done", `late ${change}`);
    view = discussion(await stateOf(store), annotationId);
    assert.equal(view.status, change === "close" ? "closed" : "open");
    assert.equal(view.kind, change === "close" ? "action" : "note");
    assert.equal(view.candidate, false);
    assert.ok(view.messages.some((message) => message.role === "agent" && message.current.text === `late ${change}`), "the answer is kept in history");
  }
});

test("DR-04: note → action makes uncovered messages a task; action → note before sending removes the candidate", async () => {
  const { store, annotationId } = await setup({ kind: "note" });
  await say(store, annotationId, "more context");
  let view = discussion(await stateOf(store), annotationId);
  assert.equal(view.candidate, false, "notes are never sent");
  await write(store, { changes: [{ type: "annotation.kind-changed", annotationId, kind: "action" }] });
  view = discussion(await stateOf(store), annotationId);
  assert.equal(view.candidate, true);
  assert.equal(view.newInstructions.length, 2);
  await write(store, { changes: [{ type: "annotation.kind-changed", annotationId, kind: "note" }] });
  assert.equal(discussion(await stateOf(store), annotationId).candidate, false);
});

test("AC14 model: close, archive and reopen keep history; processed instructions are not re-sent without «Повторить»", async () => {
  const { store, annotationId } = await setup();
  const runId = id("run1");
  const [item] = await prepare(store, runId, [annotationId]);
  await result(store, runId, item, "done");
  await write(store, { changes: [{ type: "discussion.closed", annotationId }] });
  let view = discussion(await stateOf(store), annotationId);
  assert.equal(view.status, "closed");
  assert.equal(checkTransition(view, { type: "append", role: "human" }).ok, false, "reply to closed needs «Возобновить и ответить»");
  await write(store, { changes: [{ type: "discussion.reopened", annotationId }] });
  view = discussion(await stateOf(store), annotationId);
  assert.equal(view.messages.length, 2, "history intact");
  assert.equal(view.candidate, false, "covered instruction is not a new task");
  await say(store, annotationId, "one more thing");
  view = discussion(await stateOf(store), annotationId);
  assert.equal(view.newInstructions.length, 1, "new instructions are separated");
  assert.equal(nextItem(await stateOf(store), annotationId, id("run2")).slice.length, 1);
  await write(store, { changes: [{ type: "discussion.retry-requested", annotationId }] });
  view = discussion(await stateOf(store), annotationId);
  assert.equal(view.newInstructions.length, 2, "«Повторить обработку» returns the processed instruction");
});

test("AC14 model: an instruction never processed (cancelled run) is a candidate again after reopening", async () => {
  const { store, annotationId } = await setup();
  const runId = id("run1");
  await prepare(store, runId, [annotationId]);
  await write(store, { changes: [{ type: "discussion.closed", annotationId }] });
  await write(store, { changes: [{ type: "batch.finished", runId, attemptId: id("att"), outcome: "cancelled" }] });
  await write(store, { changes: [{ type: "discussion.reopened", annotationId }] });
  const view = discussion(await stateOf(store), annotationId);
  assert.equal(view.candidate, true);
});

test("C6: withdrawal only before the first dispatch, with undo; revisions keep history", async () => {
  const { store, annotationId } = await setup();
  let view = discussion(await stateOf(store), annotationId);
  assert.equal(checkTransition(view, { type: "withdraw" }).ok, true);
  await write(store, { changes: [{ type: "annotation.withdrawn", annotationId }] });
  view = discussion(await stateOf(store), annotationId);
  assert.equal(view.status, "withdrawn");
  assert.equal(view.candidate, false);
  await write(store, { changes: [{ type: "annotation.restored", annotationId }] });
  await prepare(store, id("run1"), [annotationId]);
  view = discussion(await stateOf(store), annotationId);
  assert.equal(checkTransition(view, { type: "withdraw" }).ok, false, "after sending: close instead");
  await write(store, { changes: [{ type: "message.revised", annotationId, messageId: id("m1"), text: "first, clarified" }] });
  view = discussion(await stateOf(store), annotationId);
  assert.equal(view.messages[0].revisions.length, 2);
  assert.equal(view.messages[0].current.text, "first, clarified");
  assert.equal(view.newInstructions.length, 1, "an edit after sending is a new instruction");
});

test("roles: an agent cannot revise a human message; a human reply by another author is still an instruction", async () => {
  const { store, annotationId } = await setup();
  const view = discussion(await stateOf(store), annotationId);
  assert.equal(checkTransition(view, { type: "revise", messageId: id("m1"), role: "agent" }).ok, false);
  await write(store, { actor: agent, changes: [{ type: "message.revised", annotationId, messageId: id("m1"), text: "agent rewrote it" }] });
  const after = discussion(await stateOf(store), annotationId);
  assert.equal(after.messages[0].current.text, "first", "a forged agent revision is ignored by the projection");
  await say(store, annotationId, "from bob", bob);
  assert.equal(discussion(await stateOf(store), annotationId).newInstructions.length, 2);
});
