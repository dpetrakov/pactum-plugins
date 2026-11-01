// W-04 rounds over several documents (EP-012-T01/T02/T04): «All documents» with the summary before sending (hidden
// documents with instructions, lost places), one batch per checkout, an extra document registered before the edit
// with the manifest untouched, answer ↔ edit links across documents, edits outside the batch never attributed;
// a block moved to another section without an edit is shown as moved but stays read (F4 without DR-02 violation).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runsOf } from "../core/batch.ts";
import { batchGet, finishBatch, itemReply, markDispatched, prepareBatch, registerInput, sendSummary } from "../node/batches.ts";
import { setRule } from "../node/catalog.ts";
import { ReviewService } from "../node/service.ts";
import { documentView } from "../node/view.ts";
import { projectionText } from "../ui/text.ts";

async function repo(files) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-w04-")));
  const run = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.name", "Owner");
  run("config", "user.email", "owner@bb-docs.invalid");
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), text);
  }
  run("add", "-A");
  run("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "init");
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-w04-data-"));
  const service = new ReviewService(dir, data);
  await service.enable({});
  return { service, write: (file, text) => fs.writeFile(path.join(dir, file), text), remove: (file) => fs.rm(path.join(dir, file)),
    cleanup: () => Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]) };
}

const cp = (text) => [...text].length;
async function annotate(service, doc, needle, text) {
  const view = await documentView(service, doc);
  const all = projectionText(view.blocks);
  const at = all.indexOf(needle);
  const start = cp(all.slice(0, at));
  return service.annotate({ path: doc, observation: { sha: view.document.sha }, kind: "action", text, range: { start, end: start + cp(needle) }, quote: needle });
}
const agent = { model: "claude-opus-5-5", threadId: "thr_w04" };

test("«Все документы»: summary before sending names documents, hidden ones and lost places; one batch for the checkout", async () => {
  const r = await repo({ "docs/a.md": "# A\n\nПервый абзац A.\n\nВторой абзац A.\n", "docs/b.md": "# B\n\nАбзац B.\n", "docs/hidden/h.md": "# H\n\nСкрытый абзац.\n" });
  try {
    await annotate(r.service, "docs/a.md", "Первый абзац A", "Сократи");
    await annotate(r.service, "docs/b.md", "Абзац B", "Поясни");
    await annotate(r.service, "docs/hidden/h.md", "Скрытый абзац", "Удали лишнее");
    await setRule(r.service, { list: "hidden", path: "docs/hidden", isDir: true, action: "add" });
    // The quoted text of a.md disappears: the place is lost; the summary warns, it does not block.
    await r.write("docs/a.md", "# A\n\nСовсем другой текст.\n\nВторой абзац A.\n");
    const summary = await sendSummary(r.service, { scope: { kind: "all" } });
    assert.equal(summary.total, 3);
    assert.deepEqual(summary.documents.map((doc) => [doc.path, doc.count, doc.hidden]), [["docs/a.md", 1, false], ["docs/b.md", 1, false], ["docs/hidden/h.md", 1, true]]);
    assert.equal(summary.hidden, 1);
    assert.equal(summary.lost, 1);
    const one = await sendSummary(r.service, { scope: { kind: "document", path: "docs/b.md" } });
    assert.deepEqual(one.documents.map((doc) => doc.path), ["docs/b.md"]);
    const prepared = await prepareBatch(r.service, { scope: { kind: "all" }, recipient: { mode: "new-thread", threadId: null } });
    assert.equal(prepared.items, 3);
    assert.deepEqual(prepared.documents, ["docs/a.md", "docs/b.md", "docs/hidden/h.md"]);
    await assert.rejects(prepareBatch(r.service, { scope: { kind: "document", path: "docs/b.md" }, recipient: { mode: "new-thread", threadId: null } }), (error) => error.code === "busy", "one batch per checkout (DR-01)");
  } finally {
    await r.cleanup();
  }
});

test("edits of several documents in one round: the third is registered before the edit, links cross documents, outside edits are not attributed", async () => {
  const r = await repo({ "docs/a.md": "# A\n\nТермин старый в A.\n", "docs/b.md": "# B\n\nТермин старый в B.\n", "docs/c.md": "# C\n\nТермин старый в C.\n", "docs/d.md": "# D\n\nНезависимый документ.\n" });
  try {
    const ann = await annotate(r.service, "docs/a.md", "Термин старый", "Переименуй термин во всей документации");
    await annotate(r.service, "docs/b.md", "Термин старый", "И здесь");
    const prepared = await prepareBatch(r.service, { scope: { kind: "all" }, recipient: { mode: "current-thread", threadId: agent.threadId } });
    await markDispatched(r.service, { runId: prepared.runId, attemptId: prepared.attemptId, recipient: { mode: "current-thread", threadId: agent.threadId }, delivery: "sent" });
    const before = runsOf(await r.service.state()).find((run) => run.runId === prepared.runId);
    // The agent needs c.md as well: registered before its first edit (DR-01); the manifest stays as prepared.
    const registered = await registerInput(r.service, { runId: prepared.runId, path: "docs/c.md", agent });
    assert.equal(registered.status, "registered");
    const after = runsOf(await r.service.state()).find((run) => run.runId === prepared.runId);
    assert.deepEqual(after.documents, before.documents, "the prepared manifest is unchanged");
    assert.deepEqual(after.inputs.map((entry) => entry.docId).length, 1);
    await r.write("docs/a.md", "# A\n\nТермин новый в A.\n");
    await r.write("docs/b.md", "# B\n\nТермин новый в B.\n");
    await r.write("docs/c.md", "# C\n\nТермин новый в C.\n");
    // Somebody else edits d.md meanwhile: visible in the round, attributed to nobody (AC20).
    await r.write("docs/d.md", "# D\n\nНезависимый документ, внешняя правка.\n");
    const batch = await batchGet(r.service, { runId: prepared.runId, threadId: agent.threadId });
    const item = batch.items.find((entry) => entry.annotationId === ann.annotationId);
    await assert.rejects(itemReply(r.service, { runId: prepared.runId, itemId: item.itemId, responseId: "x", status: "done", text: "x", edits: [{ path: "docs/d.md", quote: "внешняя правка" }], agent }), (error) => error.code === "not-input", "an unregistered document cannot be claimed");
    const reply = await itemReply(r.service, { runId: prepared.runId, itemId: item.itemId, responseId: "r1", status: "done", text: "Переименовал в A и C.",
      edits: [{ path: "docs/a.md", quote: "Термин новый в A" }, { path: "docs/c.md", quote: "Термин новый в C" }], agent });
    assert.equal(reply.confirmedBlocks, 2, "edits in two documents are confirmed for this answer");
    const finished = await finishBatch(r.service, { runId: prepared.runId, agent });
    assert.equal(finished.outcome, "partial", "the b.md item was not answered");
    const docs = Object.fromEntries(finished.summary.documents.map((doc) => [doc.path, doc]));
    assert.ok(docs["docs/a.md"].inBatch && docs["docs/b.md"].inBatch && docs["docs/c.md"].inBatch, "all edits of the round, inputs included");
    assert.deepEqual(finished.summary.outside, ["docs/d.md"], "the outside edit is named apart");
    const view = await documentView(r.service, "docs/a.md");
    const shown = view.annotations.find((entry) => entry.annotationId === ann.annotationId);
    assert.equal(shown.latest.linked.length, 1, "the link in this document");
    assert.deepEqual(shown.latest.linkedElsewhere, [{ path: "docs/c.md", count: 1 }], "and the link in the other document");
    const outside = await documentView(r.service, "docs/d.md");
    assert.ok(outside.blocks.some((block) => block.read === "unread"), "the outside edit is unread …");
    assert.ok(outside.annotations.every((entry) => !entry.latest), "… and linked to no annotation");
  } finally {
    await r.cleanup();
  }
});

test("F4 without an edit: a block moved to another section is shown as moved and stays read (DR-02)", async () => {
  const r = await repo({ "docs/m.md": "# M\n\n## Первый\n\nПереносимый абзац без правки.\n\nОстаётся здесь.\n\n## Второй\n\nКонец.\n" });
  try {
    await r.write("docs/m.md", "# M\n\n## Первый\n\nОстаётся здесь.\n\n## Второй\n\nКонец.\n\nПереносимый абзац без правки.\n");
    const view = await documentView(r.service, "docs/m.md");
    const moved = view.blocks.find((block) => block.text === "Переносимый абзац без правки.");
    assert.equal(moved.read, "read", "the same version is not unread again");
    assert.equal(moved.moved, true);
    assert.equal(moved.movedFrom, "Первый");
    assert.equal(view.blocks.find((block) => block.text === "Остаётся здесь.").moved, false);
    // After confirming the document the reader's base moves: no «moved» any more.
    await r.service.acknowledge({ path: "docs/m.md", observation: { sha: view.document.sha }, scope: "document" });
    const again = await documentView(r.service, "docs/m.md");
    assert.equal(again.blocks.find((block) => block.text === "Переносимый абзац без правки.").moved, false);
  } finally {
    await r.cleanup();
  }
});
