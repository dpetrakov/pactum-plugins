// Client logic of the viewer without a browser: coordinates, projection text, route, pass stops, generation token
// and the held revision (F9). The DOM part is exercised live in bb (docs/plugins/document-review/evidence/w03-*).
import assert from "node:assert/strict";
import test from "node:test";
import { project } from "../core/markdown/index.ts";
import { encodeOverlay, lineageKey } from "../core/wire.ts";
import { bindRpc, loadView, mutate, openContext, refresh } from "../ui/actions.ts";
import { nextIndex, passStops } from "../ui/pass.ts";
import { contextKey, parseRoute, resolveLink, subPathOf } from "../ui/route.ts";
import { getUi, setUi } from "../ui/store.ts";
import { cpLength, cpToUtf16, projectionText, selectionRange, sliceCp, trimRange, utf16ToCp } from "../ui/text.ts";
import { corpusDocuments, read } from "./markdown-helpers.mjs";

test("UTF-16 ↔ code points: emoji, combining marks and Cyrillic; half a surrogate pair never selected", () => {
  const text = "Ёж 👩‍💻 и́ 🚀!";
  assert.equal(cpLength(text), [...text].length);
  for (let cp = 0; cp <= [...text].length; cp++) assert.equal(utf16ToCp(text, cpToUtf16(text, cp)), cp);
  const rocket = text.indexOf("🚀");
  assert.equal(utf16ToCp(text, rocket + 1), utf16ToCp(text, rocket), "an offset inside a pair moves to its start");
});

test("the viewer's projection text equals the host projection on the whole corpus (blocks + separators)", () => {
  for (const doc of corpusDocuments()) {
    const projection = project(read(doc));
    const blocks = projection.blocks.map((block) => ({ text: block.text, range: block.range, cell: block.cell ?? null }));
    assert.equal(projectionText(blocks), projection.text, doc);
    for (const [index, block] of blocks.entries()) assert.equal(cpLength(block.text), block.range.end - block.range.start, `${doc} block ${index}`);
  }
});

test("selection across blocks maps to the W3C range and its quote; whitespace at the ends is trimmed", () => {
  const projection = project("Первый абзац с [ссылкой](https://x.y) и 🙂.\n\nВторой абзац.\n");
  const blocks = projection.blocks.map((block) => ({ text: block.text, range: block.range, cell: null }));
  const text = projectionText(blocks);
  const start = { block: 0, offset: blocks[0].text.indexOf("ссылкой") };
  const end = { block: 1, offset: "Второй".length };
  const range = selectionRange(blocks, start, end);
  assert.equal(sliceCp(text, range), "ссылкой и 🙂.\n\nВторой");
  assert.equal(selectionRange(blocks, end, start), null, "reversed or empty");
  const padded = { start: range.start - 1, end: range.end };
  assert.deepEqual(trimRange(text, padded), range);
});

test("route: explicit checkout in the path, doc segments encoded, traversal refused; relative links resolve", () => {
  const env = { kind: "env", environmentId: "env_abc", doc: "docs/a b/план.md" };
  assert.deepEqual(parseRoute(subPathOf(env)), env);
  const host = { kind: "host", hostId: "host_x", root: "/Users/me/проект", doc: "docs/x.md" };
  assert.deepEqual(parseRoute(subPathOf(host)), host);
  assert.equal(parseRoute("env/env_abc/docs/../../etc/passwd").doc, null);
  assert.equal(parseRoute("host/host_x/bm90LWFic29sdXRl/docs/x.md").kind, "none", "a relative root is not a checkout");
  assert.notEqual(contextKey(env), contextKey({ ...env, environmentId: "env_other" }));
  assert.deepEqual(resolveLink("docs/plugins/a.md", "../b.md#Раздел"), { doc: "docs/b.md", hash: "Раздел" });
  assert.equal(resolveLink("docs/a.md", "https://example.com"), null);
  assert.equal(resolveLink("docs/a.md", "../../../x.md"), null);
});

test("pass: one stop per place, text order, read and resolved never stop (AC19 pass on five places)", () => {
  const blocks = Array.from({ length: 12 }, (_, index) => ({ index, read: [1, 3, 5, 7, 9, 10].includes(index) ? "unread" : "read" }));
  const annotation = (id, block, extra = {}) => ({ annotationId: id, status: "open", kind: "action", waiting: true, anchor: { status: "exact", place: block, blocks: [block] }, latest: { linked: [{ block }] }, ...extra });
  const view = {
    blocks,
    removed: [{ tombstoneId: "t1", after: 4 }],
    annotations: [
      annotation("a1", 1), annotation("a3", 3), annotation("a5", 5),
      annotation("a7", 6, { latest: { linked: [{ block: 7 }] } }),
      annotation("a9", 9, { waiting: false, anchor: { status: "ambiguous", place: 9, blocks: [] } }),
      annotation("closed", 2, { status: "closed" }),
      annotation("note", 11, { waiting: false }),
    ],
  };
  const all = passStops(view, "all");
  // Stops: 1, 3, removal after 4, 5, 7 (a7 joins its linked edit), 9, 10 → seven; the closed and the quiet note are not stops.
  assert.deepEqual(all.map((stop) => stop.key), ["b1", "b3", "tt1", "b5", "b7", "b9"]);
  assert.deepEqual(all.find((stop) => stop.key === "b7").annotations, ["a7"], "an annotation and its linked edit are one stop");
  assert.equal(passStops(view, "changes").length, 6, "five runs of unread blocks and a removal");
  assert.equal(passStops(view, "comments").length, 6, "open annotations only");
  // After «Mark read» of the current stop the next one is chosen, not the first.
  const after = passStops({ ...view, blocks: blocks.map((block) => block.index === 3 ? { ...block, read: "read" } : block), annotations: view.annotations.filter((entry) => entry.annotationId !== "a3") }, "all");
  assert.equal(after[nextIndex(after, all[1])].key, "tt1");
});

test("generation token: a late answer of the previous checkout never replaces the new one; F9 holds a newer revision", async () => {
  const pending = [];
  const textSha = { env_old: "old", env_new: "new" };
  // A document without blocks: the overlay of zero blocks applies to an empty text.
  const view = (path, sha) => ({ ok: true, result: { document: { path, sha }, context: { head: "h", branch: "main" }, blocks: [], removed: [], annotations: [], unread: 0, overlay: encodeOverlay(sha, []) } });
  bindRpc({ call: (method, input) => new Promise((resolve) => {
    if (method === "review.text") return resolve({ ok: true, result: { path: input.path, sha: textSha[input.target.environmentId], size: 0, total: 0, from: 0, blocks: [], headings: [], lengths: null, computeMs: 0 } });
    if (method !== "review.view") return resolve({ ok: true, newInstructions: { document: {}, all: 0 }, documents: [] });
    pending.push({ input, resolve });
  }) });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const viewOf = (env) => pending.find((entry) => entry.input.target.environmentId === env);
  // The text each checkout's fast path would return (the file's current hash).
  await openContext(parseRoute("env/env_old/docs/a.md"));
  const old = loadView("docs/a.md");
  await openContext(parseRoute("env/env_new/docs/a.md"));
  const fresh = loadView("docs/a.md");
  await settle();
  viewOf("env_new").resolve(view("docs/a.md", "new"));
  await fresh;
  // The old checkout's request is dropped (after its fast path or when its view answers late).
  viewOf("env_old")?.resolve(view("docs/a.md", "old"));
  await old;
  assert.equal(getUi().view.document.sha, "new");
  assert.equal(getUi().viewPhase, "full");
  // While the user types, a newer revision of the same document waits in the update bar.
  setUi({ holding: true });
  textSha.env_new = "newer";
  const count = pending.length;
  const held = loadView("docs/a.md", { quiet: true });
  await settle();
  pending[count].resolve(view("docs/a.md", "newer"));
  await held;
  assert.equal(getUi().view.document.sha, "new");
  assert.equal(getUi().pendingView.document.sha, "newer");
  setUi({ holding: false });
});

test("progressive document (EP-027-T08): the fast path's text shows first, read-only; the full view replaces it; a stale text never wins", async () => {
  const pending = [];
  // The fast path's compact blocks (core/wire.ts) and the compact full view (overlay for the same hash).
  const text = (path, sha, blocks = 2, total = blocks, from = 0) => ({ ok: true, result: { path, sha, size: 10, total, from, computeMs: 1,
    blocks: Array.from({ length: blocks }, (_, offset) => ({ t: "paragraph", r: [(from + offset) * 2, (from + offset) * 2 + 1], x: "т" })),
    headings: [], lengths: from > 0 || from + blocks < total ? Array(total).fill(1) : null } });
  const counts = { "docs/a.md": 2, "docs/b.md": 2, "docs/c.md": 2, "docs/big.md": 10 };
  const full = (path, sha) => ({ ok: true, result: { document: { path, sha }, context: { head: "h", branch: "main", writable: true }, blocks: [], removed: [], annotations: [], unread: 3,
    overlay: encodeOverlay(sha, Array.from({ length: counts[path] }, (_, index) => ({ lineageId: `lineage-${index}-0000000`, read: index ? "read" : "unread", change: index ? null : "edited", diff: null, movedFrom: null, moved: false }))) } });
  bindRpc({ call: (method, input) => new Promise((resolve) => {
    if (method === "review.text" || method === "review.view") return pending.push({ method, input, resolve });
    resolve({ ok: true, newInstructions: { document: {}, all: 0 }, documents: [] });
  }) });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const find = (method, path, from) => pending.find((entry) => entry.method === method && entry.input.path === path && (from === undefined || (entry.input.from ?? 0) === from) && !entry.done);
  const answer = (entry, value) => { entry.done = true; entry.resolve(value); };
  await openContext(parseRoute("env/env_p/docs/a.md"));
  const loading = loadView("docs/a.md");
  await settle();
  // Only the fast path is asked first; the full view after it (the host answers the text before the heavy part).
  assert.ok(find("review.text", "docs/a.md"));
  assert.equal(find("review.view", "docs/a.md"), undefined);
  answer(find("review.text", "docs/a.md"), text("docs/a.md", "s1"));
  await settle();
  assert.equal(getUi().viewPhase, "text");
  assert.equal(getUi().view.blocks.length, 2);
  assert.equal(getUi().view.context.writable, false, "the text is read-only until the review state arrives");
  answer(find("review.view", "docs/a.md"), full("docs/a.md", "s1"));
  await loading;
  assert.equal(getUi().viewPhase, "full");
  assert.equal(getUi().view.unread, 3);
  // Fast switching: b, then c; b's text and view answer late and never replace c.
  const toB = loadView("docs/b.md");
  await settle();
  const toC = loadView("docs/c.md");
  await settle();
  answer(find("review.text", "docs/c.md"), text("docs/c.md", "c1"));
  await settle();
  answer(find("review.text", "docs/b.md"), text("docs/b.md", "b1"));
  await settle();
  assert.equal(getUi().view.document.path, "docs/c.md");
  answer(find("review.view", "docs/c.md"), full("docs/c.md", "c1"));
  await toC;
  find("review.view", "docs/b.md") && answer(find("review.view", "docs/b.md"), full("docs/b.md", "b1"));
  await toB;
  assert.equal(getUi().view.document.path, "docs/c.md");
  assert.equal(getUi().viewPhase, "full");
  // A revisit shows the session's full view at once («cached»), then the host's answer.
  const back = loadView("docs/a.md");
  assert.equal(getUi().viewPhase, "cached");
  assert.equal(getUi().view.document.path, "docs/a.md");
  await settle();
  answer(find("review.view", "docs/a.md"), full("docs/a.md", "s2"));
  // s2 is a new revision: its text is fetched for the overlay.
  await settle();
  answer(find("review.text", "docs/a.md"), text("docs/a.md", "s2"));
  await back;
  assert.equal(getUi().viewPhase, "full");
  assert.equal(getUi().view.document.sha, "s2");
  // A large document: the first part, then the rest; the outline covers every heading at once.
  const big = loadView("docs/big.md");
  await settle();
  answer(find("review.text", "docs/big.md"), text("docs/big.md", "g1", 3, 10));
  await settle();
  assert.equal(getUi().textInfo.total, 10);
  answer(find("review.text", "docs/big.md", 3), text("docs/big.md", "g1", 7, 10, 3));
  await settle();
  assert.equal(getUi().view.blocks.length, 10, "the part extends the shown run");
  answer(find("review.view", "docs/big.md"), full("docs/big.md", "g1"));
  await big;
  assert.equal(getUi().textInfo, null);
  assert.equal(getUi().view.blocks.length, 10);
  assert.equal(getUi().view.blocks[0].read, "unread", "the overlay's state is applied to the text");
  assert.equal(getUi().view.blocks[0].lineageId, lineageKey("lineage-0-0000000"), "lineage ids travel as a 14-character key");
  assert.notEqual(getUi().view.blocks[0].lineageId, getUi().view.blocks[1].lineageId);
  assert.equal(getUi().view.blocks[1].read, "read");
});

test("refresh reloads the routed document, never the first document of the checkout (W-06a)", async () => {
  const asked = [];
  bindRpc({ call: (method, input) => {
    if (method === "review.view" || method === "review.text") asked.push(input.path);
    return Promise.resolve({ ok: false, error: { code: "x", message: "x" } });
  } });
  await openContext(parseRoute("env/env_r/docs/first.md"));
  // The page puts every navigation into the shared route (ui/page.tsx); refresh follows it.
  setUi({ route: parseRoute("env/env_r/docs/second.md") });
  await refresh();
  assert.ok(asked.includes("docs/second.md"));
  assert.ok(!asked.includes("docs/first.md"), "the first document is not reloaded over the current one");
});

test("W-06b: refreshes asked while one runs join it and leave one trailing refresh; review.documents is not loaded", async () => {
  const calls = [];
  // Every answer arrives a little later, so the refreshes below are asked while the first one runs.
  bindRpc({ call: (method) => { calls.push(method); return new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: { code: "x", message: "x" } }), 20)); } });
  setUi({ route: parseRoute("env/env_w06b/docs/a.md"), target: { environmentId: "env_w06b" }, ctxKey: "env:env_w06b" });
  const first = refresh();
  void refresh(); void refresh(); void refresh();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(!calls.includes("review.documents"), "the unused document list is not requested");
  assert.equal(calls.filter((method) => method === "review.tree").length, 2, "four refreshes: the first and one trailing");
  assert.equal(calls.filter((method) => method === "review.batch.status").length, 2);
});

test("W-06b: a write waits for the document view only; the tree and the batch follow in the background", async () => {
  const calls = [];
  const slow = [];
  bindRpc({ call: (method) => {
    calls.push(method);
    if (method === "review.acknowledge") return Promise.resolve({ ok: true, result: { status: "ok" } });
    if (method === "review.tree" || method === "review.batch.status") return new Promise((resolve) => slow.push(() => resolve({ ok: false, error: { code: "x", message: "x" } })));
    return Promise.resolve({ ok: false, error: { code: "x", message: "x" } });
  } });
  setUi({ route: parseRoute("env/env_w06b2/docs/a.md"), target: { environmentId: "env_w06b2" }, ctxKey: "env:env_w06b2", view: null });
  const result = await mutate("review.acknowledge", { scope: "document" }, { withContext: false });
  assert.deepEqual(result, { status: "ok" }, "the write returns while the tree and the batch are still loading");
  assert.ok(calls.includes("review.text") || calls.includes("review.view"), "the document view is read after the write");
  for (const release of slow.splice(0)) release();
});
