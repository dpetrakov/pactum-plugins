// EP-005-T04: read reducer per DR-02 (AC27, AC17 model part, F3).
import assert from "node:assert/strict";
import test from "node:test";
import { checkReceipt, isKnownReader, normalizeReaderId, readState, ReaderIdError } from "../core/reading.ts";
import { MemoryBackend } from "../core/store.ts";
import { bob, id, mergeStores, observe, revision, shuffled, stateOf, write } from "./helpers.mjs";

const docId = id("doc");
const reader = "alice@example.com";
const A = id("A");
const B = id("B");
const C = id("C");
const L = `${A}.0`; // lineage of the only paragraph
const M = `${A}.1`; // a second paragraph that never changes

const rev = (revisionId, parents, content, extra = {}) => revision({
  revisionId, docId, parents, text: `${content}\n`,
  blocks: [{ lineageId: L, versionId: extra.version ?? `${revisionId}.0`, content }, { lineageId: M, versionId: `${A}.1`, content: "stable" }, ...(extra.blocks ?? [])],
  removed: extra.removed ?? [],
});

/** A (baseline) → B → C, paragraph text "a" → "b" → "c". */
async function chain() {
  const store = new MemoryBackend();
  await observe(store, rev(A, [], "a", { version: `${A}.0` }), { register: true, reason: "baseline" });
  await observe(store, rev(B, [A], "b"));
  await observe(store, rev(C, [B], "c"));
  return store;
}

const receipt = (revisionId, versions, extra = {}) => ({
  type: "read.acknowledged", receiptId: extra.receiptId ?? id(`receipt-${revisionId}-${versions.join()}`), readerId: extra.readerId ?? reader,
  docId, revisionId, scope: "block", versions: versions.map((versionId) => ({ lineageId: L, versionId })), tombstones: extra.tombstones ?? [],
});
const blockState = (state, revisionId, readerId = reader) => readState(state, readerId, revisionId).blocks.find((block) => block.lineageId === L);

test("baseline: existing content is the initial base, not new (F1)", async () => {
  const store = await chain();
  const state = await stateOf(store);
  assert.equal(readState(state, reader, A).unread, 0);
  const atC = blockState(state, C);
  assert.equal(atC.state, "unread");
  assert.equal(atC.change, "edited");
  assert.equal(atC.base.versionId, `${A}.0`, "A→B→C unread shows A→C (F3)");
  assert.equal(readState(state, reader, C).blocks.find((block) => block.lineageId === M).state, "read");
});

test("AC27: receipts of B and C in any delivery order give the same base; a late ancestor never rolls back", async () => {
  const results = new Set();
  for (const order of [["B", "C"], ["C", "B"]]) {
    const store = await chain();
    for (const name of order) {
      const revisionId = name === "B" ? B : C;
      await write(store, { changes: [receipt(revisionId, [`${revisionId}.0`])] });
    }
    const state = await stateOf(store);
    const atC = blockState(state, C);
    assert.equal(atC.state, "read", `order ${order}`);
    assert.equal(atC.base.versionId, `${C}.0`);
    results.add(JSON.stringify(readState(state, reader, C)));
  }
  assert.equal(results.size, 1);
});

test("AC27: revoking a receipt removes only its own contribution", async () => {
  const store = await chain();
  const rB = id("rB");
  const rC = id("rC");
  await write(store, { changes: [receipt(B, [`${B}.0`], { receiptId: rB })] });
  await write(store, { changes: [receipt(C, [`${C}.0`], { receiptId: rC })] });
  await write(store, { changes: [{ type: "read.revoked", receiptId: rB, readerId: reader }] });
  let state = await stateOf(store);
  assert.equal(blockState(state, C).state, "read", "the later independent confirmation stays");
  await write(store, { changes: [{ type: "read.revoked", receiptId: rC, readerId: reader }] });
  state = await stateOf(store);
  // Both revoked: back to the baseline A, not to "everything read".
  assert.equal(blockState(state, C).state, "unread");
  assert.equal(blockState(state, C).base.versionId, `${A}.0`);
  // Revocation by another reader does not touch alice's receipt.
  const other = await chain();
  const rX = id("rX");
  await write(other, { changes: [receipt(B, [`${B}.0`], { receiptId: rX })] });
  await write(other, { actor: bob, changes: [{ type: "read.revoked", receiptId: rX, readerId: "bob@example.com" }] });
  assert.equal(blockState(await stateOf(other), B).state, "read");
});

test("AC27: A→B→A after reading B stays a change B→A; without reading B the return to A clears it (F3)", async () => {
  const store = new MemoryBackend();
  const A2 = id("A2");
  await observe(store, rev(A, [], "a", { version: `${A}.0` }), { register: true, reason: "baseline" });
  await observe(store, rev(B, [A], "b"));
  await observe(store, rev(A2, [B], "a"));
  let state = await stateOf(store);
  assert.equal(blockState(state, A2).state, "read", "C = A: no mark");
  await write(store, { changes: [receipt(B, [`${B}.0`])] });
  state = await stateOf(store);
  const back = blockState(state, A2);
  assert.equal(back.state, "unread");
  assert.equal(back.base.versionId, `${B}.0`, "content hash equal to A is not enough: base is B");
});

test("AC27: receipts of another branch are kept apart; a merge is not read without its own versions", async () => {
  const base = new MemoryBackend();
  await observe(base, rev(A, [], "a", { version: `${A}.0` }), { register: true, reason: "baseline" });
  const left = base.clone();
  const right = base.clone();
  const X = id("X");
  const Y = id("Y");
  await observe(left, rev(X, [A], "x"));
  await write(left, { changes: [receipt(X, [`${X}.0`])] });
  await observe(right, rev(Y, [A], "y"));
  await write(right, { changes: [receipt(Y, [`${Y}.0`])] });
  const merged = mergeStores(left, right);
  let state = await stateOf(merged);
  assert.equal(blockState(state, X).state, "read");
  assert.equal(blockState(state, Y).state, "read");
  // A merged revision with new content: two incomparable bases → conservatively unread.
  const MX = id("MX");
  await observe(merged, rev(MX, [X, Y], "xy"));
  state = await stateOf(merged);
  const atMerge = blockState(state, MX);
  assert.equal(atMerge.state, "ambiguous");
  assert.equal(atMerge.bases.length, 2);
  // A merged revision that keeps X's version (proved preservation of a specific version) is read.
  const MK = id("MK");
  await observe(merged, rev(MK, [X, Y], "x", { version: `${X}.0` }));
  state = await stateOf(merged);
  assert.equal(blockState(state, MK).state, "read");
});

test("receipt delivery order across many receipts never changes the result (permutations)", async () => {
  const revisions = [A, B, C];
  const expected = new Set();
  for (let seed = 1; seed <= 8; seed++) {
    const store = await chain();
    for (const revisionId of shuffled(revisions, seed)) await write(store, { changes: [receipt(revisionId, [`${revisionId}.0`])] });
    expected.add(JSON.stringify(readState(await stateOf(store), reader, C)));
  }
  assert.equal(expected.size, 1);
});

test("deleted blocks: unread tombstone after reading, cleared by confirming it; added and removed unseen leaves no mark", async () => {
  const store = new MemoryBackend();
  const N = `${B}.5`;
  await observe(store, rev(A, [], "a", { version: `${A}.0` }), { register: true, reason: "baseline" });
  // B adds paragraph N, C removes M (read at baseline) and N (never read).
  await observe(store, rev(B, [A], "a", { version: `${A}.0`, blocks: [{ lineageId: N, versionId: N, content: "new" }] }));
  await observe(store, revision({ revisionId: C, docId, parents: [B], text: "a\n", blocks: [{ lineageId: L, versionId: `${A}.0`, content: "a" }],
    removed: [{ lineageId: M, versionId: `${A}.1`, text: "stable" }, { lineageId: N, versionId: N, text: "new" }] }));
  let state = await stateOf(store);
  let atC = readState(state, reader, C);
  assert.deepEqual(atC.removed.map((entry) => [entry.lineageId, entry.state]), [[M, "unread"]]);
  assert.equal(atC.unread, 1);
  await write(store, { changes: [{ ...receipt(C, []), tombstones: [`${C}~${M}`] }] });
  state = await stateOf(store);
  atC = readState(state, reader, C);
  assert.equal(atC.unread, 0);
});

test("split/merge inherit a base only when every source is the confirmed base and the caller proves the text unchanged", async () => {
  const store = new MemoryBackend();
  await observe(store, rev(A, [], "a b", { version: `${A}.0` }), { register: true, reason: "baseline" });
  const S = id("S");
  await observe(store, revision({ revisionId: S, docId, parents: [A], text: "a\n\nb\n", blocks: [
    { lineageId: `${S}.0`, versionId: `${S}.0`, content: "a" }, { lineageId: `${S}.1`, versionId: `${S}.1`, content: "b" },
    { lineageId: M, versionId: `${A}.1`, content: "stable" },
  ], removed: [{ lineageId: L, versionId: `${A}.0`, text: "a b" }] }));
  // Synthetic revision helper has no origin field; add it to the stored objects through a fresh projection.
  const state = await stateOf(store);
  const object = [...state.objects.values()].find((value) => value.type === "Revision" && value.revisionId === S);
  object.blocks[0].origin = { kind: "split", sources: [{ lineageId: L, versionId: `${A}.0` }] };
  object.blocks[1].origin = { kind: "split", sources: [{ lineageId: L, versionId: `${A}.0` }] };
  const strict = readState(state, reader, S);
  assert.deepEqual(strict.blocks.slice(0, 2).map((block) => block.state), ["unread", "unread"], "without proof stays unread");
  const proven = readState(state, reader, S, { splitMergeUnchanged: () => true });
  assert.deepEqual(proven.blocks.slice(0, 2).map((block) => block.state), ["read", "read"]);
});

test("AC17 model: readerId is the normalized email; another email is another reader; no email no writes", async () => {
  assert.equal(normalizeReaderId("  Alice@Example.COM "), "alice@example.com");
  assert.throws(() => normalizeReaderId(""), ReaderIdError);
  assert.throws(() => normalizeReaderId(null), ReaderIdError);
  assert.throws(() => normalizeReaderId("not-an-email"), ReaderIdError);
  const store = await chain();
  await write(store, { changes: [receipt(C, [`${C}.0`])] });
  const state = await stateOf(store);
  assert.equal(blockState(state, C, "alice@example.com").state, "read");
  assert.equal(blockState(state, C, "alice@other.example").state, "unread", "a changed email has its own base");
  assert.equal(isKnownReader(state, "alice@example.com"), true);
  assert.equal(isKnownReader(state, "alice@other.example"), false, "a new reader is offered to accept the current state");
});

test("DR-02: a newer revision is not a refusal; an unknown revision is a context change, not a stale error", async () => {
  const store = await chain();
  const state = await stateOf(store);
  const ok = checkReceipt(state, { revisionId: B, versions: [{ lineageId: L, versionId: `${B}.0` }, { lineageId: M, versionId: `${A}.1` }], tombstones: [], currentRevisionId: C });
  assert.deepEqual(ok, { ok: true, staleBlocks: 1 });
  const otherBranch = checkReceipt(state, { revisionId: id("revision-of-another-branch"), versions: [], tombstones: [], currentRevisionId: C });
  assert.equal(otherBranch.ok, false);
  assert.equal(otherBranch.reason, "context-changed");
  const foreign = checkReceipt(state, { revisionId: B, versions: [{ lineageId: L, versionId: `${C}.0` }], tombstones: [], currentRevisionId: C });
  assert.equal(foreign.reason, "unknown-version");
});
