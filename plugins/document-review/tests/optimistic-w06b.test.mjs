// W-06b (EP-033-T01): optimistic marks of «Documents» — shown in the same frame, one write per key (a second press sends
// nothing), writes in click order, reports the failure reason with Retry, and rolls back the overlay
// survives a reload that started before the write; stale tree answers are dropped.
import assert from "node:assert/strict";
import test from "node:test";
import { encodeOverlay } from "../core/wire.ts";
import { bindRpc, decideMark, loadTree, loadView, readMark, setRule } from "../ui/actions.ts";
import { markRead, readAllOverlay, readSet, restoreRead, ruleOverlay } from "../ui/optimistic.ts";
import { parseRoute } from "../ui/route.ts";
import { getUi, setNotifySink, setUi } from "../ui/store.ts";

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

const SHA = "s1";
function block(index, read) {
  return { index, type: "paragraph", text: `Блок ${index}`, range: { start: index * 10, end: index * 10 + 6 }, inline: [`Блок ${index}`], attrs: {}, depth: null, cell: null, headings: [],
    lineageId: `doc.${index}`, versionId: "", read, change: read === "unread" ? "edited" : null, diff: null, movedFrom: null, moved: false };
}
function makeView(path, reads, annotations = []) {
  const blocks = reads.map((read, index) => block(index, read));
  return { context: { root: "/r", isRepo: true, head: "h", branch: "main", enabled: true, repoId: null, identity: { name: "a", email: "a@x" }, readerId: "a@x", writable: true, readOnlyReason: null, roots: ["docs"], configConflict: null },
    document: { path, docId: "d1", sha: SHA, size: 10, revisionId: "r1", ephemeral: false, tracked: true, insideRoots: true, projectionLength: 30, headRevisions: [], missing: false, deletionUnread: false, hidden: false, trackingResumed: null, readOnly: null, conflict: null },
    blocks, removed: [], annotations, unread: blocks.filter((entry) => entry.read === "unread").length, lastReceipt: null, computeMs: 0 };
}
function makeTree(path, unread) {
  return { enabled: true, isRepo: true, roots: ["docs"], missingRoots: [], suggestions: [], virtual: [], moves: { applied: [], proposals: [] }, excluded: [], truncated: 0, pending: 0,
    entries: [{ path, kind: "file", size: 1, supported: true, note: null, hidden: false, hiddenFrom: null, untracked: false, untrackedFrom: null, docId: "d1", state: unread ? "unread" : "read", unread, open: 0, waiting: 0, candidates: 0 },
      { path: "docs/other.md", kind: "file", size: 1, supported: true, note: null, hidden: false, hiddenFrom: null, untracked: false, untrackedFrom: null, docId: "d2", state: "unread", unread: 3, open: 0, waiting: 0, candidates: 0 }],
    totals: { waiting: 0, candidates: 0, unreadDocs: 2, unread: 5, changedDocs: 0, open: 0 }, computeMs: 0, head: "h", branch: "main", hiddenRules: [], untrackedRules: [], writable: true, configSha: null,
    machine: { hostId: "host", name: "the workstation" }, root: "/r" };
}

/** A fake host: the document's read states change only when a write lands. */
function host(path, reads) {
  const state = { reads: [...reads], calls: [], writes: [], fail: null };
  bindRpc({ call: (method, input) => {
    state.calls.push(method);
    if (method === "review.view") {
      const blocks = state.reads.map((read, index) => block(index, read));
      return Promise.resolve({ ok: true, result: { ...makeView(path, state.reads), blocks: [], overlay: encodeOverlay(SHA, blocks) } });
    }
    if (method === "review.tree") return Promise.resolve({ ok: true, result: makeTree(path, state.reads.filter((read) => read === "unread").length), machine: { hostId: "host", name: "the workstation" }, root: "/r" });
    if (method === "review.batch.status") return Promise.resolve({ ok: false, error: { code: "x", message: "x" } });
    if (method === "review.lang") return Promise.resolve({ ok: true, result: { lang: input.lang } });
    const write = deferred();
    state.writes.push({ method, input, write });
    return write.promise.then((outcome) => {
      if (outcome === "fail") return { ok: false, error: { code: "host-unavailable", message: "no link" } };
      if (method === "review.acknowledge") for (const index of input.blocks ?? []) state.reads[index] = "read";
      return { ok: true, result: { receiptId: "11111111-1111-4111-8111-111111111111", staleBlocks: 0, eventId: "e", resumed: 0, merged: false } };
    });
  } });
  return state;
}

function setup(name, reads) {
  const path = `docs/${name}.md`;
  const notices = [];
  setNotifySink((notice) => notices.push(notice));
  const state = host(path, reads);
  setUi({ route: parseRoute(`env/env_${name}/${path}`), target: { environmentId: `env_${name}` }, ctxKey: `env:env_${name}`, view: makeView(path, reads), viewPhase: "full", tree: makeTree(path, reads.filter((read) => read === "unread").length), viewError: null, holding: false });
  return { path, notices, state };
}

test("«Прочитано» is shown in the same frame with «Отменить»; a failed write rolls back and offers «Повторить» (D14)", async () => {
  const { notices, state } = setup("rollback", ["unread", "unread"]);
  void readMark(getUi().view, { scope: "block", blocks: [0] });
  // Same frame: the block is read, the counter and the tree row follow, the toast is there with «Undo».
  assert.equal(getUi().view.blocks[0].read, "read");
  assert.equal(getUi().view.unread, 1);
  assert.equal(getUi().tree.entries[0].unread, 1);
  assert.equal(notices[0].text, "Marked read");
  assert.ok(notices[0].undo, "the toast offers «Отменить» at once");
  await settle();
  assert.equal(state.writes.length, 1);
  state.writes[0].write.resolve("fail");
  await settle(5);
  assert.equal(getUi().view.blocks[0].read, "unread", "rolled back to the host's state");
  assert.equal(getUi().view.unread, 2);
  assert.equal(getUi().tree.entries[0].unread, 2);
  const error = notices.at(-1);
  assert.equal(error.tone, "error");
  assert.match(error.text, /^Couldn't mark read: the machine of this checkout is unreachable/i);
  assert.equal(error.actionLabel, "Retry");
  assert.equal(error.id, notices[0].id, "the error replaces the «Отменить» toast");
  // «Retry» writes again and shows the mark again.
  await error.undo();
  assert.equal(getUi().view.blocks[0].read, "read");
  await settle();
  assert.equal(state.writes.length, 2);
  state.writes[1].write.resolve("ok");
  await settle(5);
  assert.equal(getUi().view.blocks[0].read, "read");
});

test("a second press of the same mark while it is written sends nothing; different marks are written one after another", async () => {
  const { state } = setup("double", ["unread", "unread", "unread"]);
  const view = getUi().view;
  void readMark(view, { scope: "block", blocks: [0] });
  const second = await Promise.race([readMark(view, { scope: "block", blocks: [0] }), settle(5).then(() => "pending")]);
  assert.equal(second, null, "the duplicate resolves at once without a request");
  void readMark(getUi().view, { scope: "block", blocks: [1] });
  await settle();
  assert.equal(state.writes.length, 1, "the next write waits for the previous one (click order)");
  assert.deepEqual(state.writes[0].input.blocks, [0]);
  assert.equal(getUi().view.unread, 1, "both marks are shown at once");
  state.writes[0].write.resolve("ok");
  await settle(5);
  assert.equal(state.writes.length, 2);
  assert.deepEqual(state.writes[1].input.blocks, [1]);
  state.writes[1].write.resolve("ok");
  await settle(10);
  assert.equal(state.calls.filter((method) => method === "review.acknowledge").length, 2, "two clicks on one block and one on another: two writes");
  assert.equal(getUi().view.unread, 1, "the host's view after the writes");
});

test("a reload that started before the write lands never brings the old state back", async () => {
  const { path, state } = setup("reload", ["unread", "unread"]);
  void readMark(getUi().view, { scope: "block", blocks: [1] });
  await loadView(path, { quiet: true });
  assert.equal(getUi().view.blocks[1].read, "read", "the host still says unread, the mark stays");
  await settle();
  state.writes[0].write.resolve("ok");
  await settle(10);
  assert.equal(getUi().view.blocks[1].read, "read");
  assert.equal(getUi().tree.entries[0].unread, 1, "the tree read after the write");
});

test("decisions are shown at once and rolled back on failure; rules hide a row at once", async () => {
  const annotation = { annotationId: "a1", path: "docs/decide.md", status: "open", kind: "action", waiting: true, heads: ["h1"], conflicts: [], latest: null };
  const { state, notices } = setup("decide", ["read"]);
  setUi({ view: { ...getUi().view, annotations: [annotation] } });
  void decideMark(annotation, "close");
  assert.equal(getUi().view.annotations[0].status, "closed");
  assert.equal(notices.at(-1).text, "Comment closed and archived");
  await settle();
  state.writes[0].write.resolve("fail");
  await settle(5);
  assert.equal(getUi().view.annotations[0].status, "open");
  assert.match(notices.at(-1).text, /^Couldn't close the comment: /);
  void setRule({ list: "hidden", path: "docs/other.md", isDir: false, action: "add" });
  assert.equal(getUi().tree.entries[1].hidden, true);
  await settle();
  state.writes[1].write.resolve("ok");
  await settle(10);
});

test("a tree answer of an older request never replaces a newer one", async () => {
  const answers = [];
  bindRpc({ call: (method) => (method === "review.tree" ? new Promise((resolve) => answers.push(resolve)) : Promise.resolve({ ok: false, error: { code: "x", message: "x" } })) });
  setUi({ route: parseRoute("env/env_tree/docs/a.md"), target: { environmentId: "env_tree" }, ctxKey: "env:env_tree", tree: null });
  const first = loadTree();
  const second = loadTree();
  await settle();
  answers[1]({ ok: true, result: { ...makeTree("docs/a.md", 0), branch: "new" }, machine: { hostId: "host", name: "the workstation" }, root: "/r" });
  await second;
  answers[0]({ ok: true, result: { ...makeTree("docs/a.md", 4), branch: "old" }, machine: { hostId: "host", name: "the workstation" }, root: "/r" });
  await first;
  assert.equal(getUi().tree.branch, "new");
});

test("overlays: read sets, undo, read-all and rules are pure and exact", () => {
  const view = makeView("docs/p.md", ["unread", "read", "unread"]);
  view.removed = [{ tombstoneId: "t1", lineageId: "x", text: "старое", type: "paragraph", after: 0, section: null, read: false }];
  view.unread = 3;
  const all = readSet(view, { scope: "document" });
  const read = markRead(view, all);
  assert.equal(read.unread, 0);
  assert.equal(read.removed.length, 0);
  assert.equal(read.blocks[1], view.blocks[1], "unchanged blocks keep their identity (memoised rows do not re-render)");
  const back = restoreRead(read, view, all);
  assert.deepEqual(back.blocks.map((entry) => entry.read), ["unread", "read", "unread"]);
  assert.equal(back.unread, 3);
  const tree = makeTree("docs/p.md", 2);
  const allRead = readAllOverlay().tree(tree);
  assert.ok(allRead.entries.every((entry) => entry.state === "read"));
  assert.equal(allRead.totals.unreadDocs, 0);
  const hidden = ruleOverlay({ list: "hidden", path: "docs", isDir: true, action: "add" }).tree(tree);
  assert.ok(hidden.entries.every((entry) => entry.hidden && entry.hiddenFrom === "docs/"));
});

test("W-06b regression: choosing a document in the tree does not touch the main store (no re-render of its subscribers)", async () => {
  const { chooseDocument } = await import("../ui/actions.ts");
  const { subscribe, setChosen } = await import("../ui/store.ts");
  setUi({ route: parseRoute("env/env_choose/docs/a.md"), target: { environmentId: "env_choose" }, ctxKey: "env:env_choose" });
  let notified = 0;
  const off = subscribe(() => { notified++; });
  const before = getUi().route;
  chooseDocument(parseRoute("env/env_choose/docs/b.md"));
  off();
  assert.equal(notified, 0, "the tree and the page are not rendered again in the click");
  assert.equal(getUi().route, before, "the routed document changes when bb's navigation arrives");
  setChosen(null);
});
