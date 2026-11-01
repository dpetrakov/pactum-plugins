// W-03 review loop on a real checkout: targets of every kind, the host-computed view, batches with the checkout
// lock (DR-01), agent results (DR-04), finish and round summary, «Accept» with its two-part undo (DR-02).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discussion } from "../core/discussion.ts";
import { accept, abandonRun, batchGet, batchStatus, finishBatch, itemReply, markDispatched, markUnknown, prepareBatch, registerInput, roundSummary, undoAccept } from "../node/batches.ts";
import { ReviewService } from "../node/service.ts";
import { documentView } from "../node/view.ts";

const DOC = `# Обзор

Первый абзац с [ссылкой](https://example.com) и 🙂 эмодзи.

Второй абзац для замечаний.

## Детали

Деталь один.

Деталь два будет удалена.

![схема](img.png)
`;

async function repo() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-loop-")));
  const run = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.name", "Owner");
  run("config", "user.email", "owner@bb-docs.invalid");
  await fs.mkdir(path.join(dir, "docs"));
  await fs.writeFile(path.join(dir, "docs/a.md"), DOC);
  await fs.writeFile(path.join(dir, "docs/b.md"), "# B\n\nДругой документ.\n");
  await fs.writeFile(path.join(dir, "docs/c.md"), "# C\n\nТретий документ.\n");
  run("add", "-A");
  run("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "init");
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-loop-data-"));
  const service = new ReviewService(dir, data);
  await service.enable({});
  const write = (file, text) => fs.writeFile(path.join(dir, file), text);
  return { dir, data, service, write, cleanup: () => Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]) };
}

const agentA = { model: "claude-opus-5-5", threadId: "thr_loop" };
const cp = (text) => [...text].length;

/** The projection text as the viewer assembles it from blocks and separators (projection.md). */
export function projectionText(view) {
  let text = "";
  view.blocks.forEach((block, index) => {
    const previous = view.blocks[index - 1];
    if (previous) text += previous.cell && block.cell && previous.cell.table === block.cell.table ? (previous.cell.row === block.cell.row ? "\t" : "\n") : "\n\n";
    text += block.text;
  });
  return text;
}

/** Range and quote of a needle in the shown projection, as the viewer would send it. */
function selection(view, needle) {
  const text = projectionText(view);
  const at = text.indexOf(needle);
  if (at < 0) throw new Error(`no ${needle}`);
  const start = cp(text.slice(0, at));
  return { range: { start, end: start + cp(needle) }, quote: needle };
}

async function annotate(service, docPath, input) {
  const view = await documentView(service, docPath);
  return service.annotate({ path: docPath, observation: { sha: view.document.sha }, kind: "action", ...input(view) });
}

test("targets: text with link and emoji, block, section, document, change of a block and of a removed block", async () => {
  const { service, write, cleanup } = await repo();
  try {
    let view = await documentView(service, "docs/a.md");
    assert.equal(view.context.writable, true);
    assert.equal(view.unread, 0, "the initial base is read (F1)");
    const image = view.blocks.findIndex((block) => block.type === "image");
    const heading = view.blocks.findIndex((block) => block.type === "heading" && block.depth === 2);
    const text = await annotate(service, "docs/a.md", (v) => ({ text: "Уточнить", ...selection(v, "ссылкой и 🙂 эмодзи.\n\nВторой") }));
    assert.equal(text.targetKind, "text");
    const block = await annotate(service, "docs/a.md", () => ({ text: "Картинка", targetKind: "block", block: image }));
    const section = await annotate(service, "docs/a.md", () => ({ text: "Раздел", targetKind: "section", block: heading }));
    const whole = await annotate(service, "docs/a.md", () => ({ text: "Документ", targetKind: "document" }));
    assert.equal(whole.range.start, 0);
    view = await documentView(service, "docs/a.md");
    assert.equal(section.range.start, view.blocks[heading].range.start);
    assert.equal(section.range.end, view.blocks[view.blocks.length - 1].range.end, "the section runs to the end (nested blocks included)");
    const byId = new Map(view.annotations.map((annotation) => [annotation.annotationId, annotation]));
    assert.equal(byId.get(text.annotationId).quote.exact, "ссылкой и 🙂 эмодзи.\n\nВторой");
    assert.equal(byId.get(text.annotationId).anchor.status, "exact");
    assert.deepEqual(byId.get(block.annotationId).anchor.blocks, [image], "an image block is targeted by its lineage");
    assert.equal(byId.get(whole.annotationId).anchor.place, null);
    await assert.rejects(annotate(service, "docs/a.md", (v) => ({ text: "x", range: selection(v, "Второй").range, quote: "Другой" })), /quote-mismatch|does not match/);
    await assert.rejects(annotate(service, "docs/a.md", () => ({ text: "x", targetKind: "section", block: 1 })), /not a heading/);

    // The document changes: a block is edited and one is removed.
    await write("docs/a.md", DOC.replace("Деталь один.", "Деталь один, исправлена.").replace("Деталь два будет удалена.\n\n", ""));
    view = await documentView(service, "docs/a.md");
    const edited = view.blocks.find((entry) => entry.text.startsWith("Деталь один"));
    assert.equal(edited.read, "unread");
    assert.equal(edited.change, "edited");
    assert.equal(edited.diff.words.filter((op) => op.op !== "delete").map((op) => op.text).join(""), edited.text, "equal + insert spell the current text exactly");
    assert.equal(view.removed.length, 1);
    assert.equal(view.removed[0].text, "Деталь два будет удалена.");
    const change = await annotate(service, "docs/a.md", () => ({ text: "Почему так?", targetKind: "change", block: edited.index }));
    const gone = await annotate(service, "docs/a.md", (v) => ({ text: "Зачем удалил, верни", targetKind: "change", tombstoneId: v.removed[0].tombstoneId }));
    view = await documentView(service, "docs/a.md");
    const goneView = view.annotations.find((annotation) => annotation.annotationId === gone.annotationId);
    assert.equal(goneView.quote.exact, "Деталь два будет удалена.", "the target keeps the old revision's text (AC22 first part)");
    assert.equal(goneView.anchor.status, "orphaned");
    assert.equal(goneView.anchor.place, view.removed[0].after, "the card stands at the deletion");
    assert.ok(view.annotations.find((annotation) => annotation.annotationId === change.annotationId));
  } finally {
    await cleanup();
  }
});

test("read: section on the host, revoke of one receipt, stale blocks named, no «устарело»", async () => {
  const { service, write, cleanup } = await repo();
  try {
    await write("docs/a.md", DOC.replace("Деталь один.", "Деталь один!").replace("Второй абзац", "Второй, новый, абзац"));
    let view = await documentView(service, "docs/a.md");
    assert.equal(view.unread, 2);
    const heading = view.blocks.findIndex((block) => block.type === "heading" && block.depth === 2);
    const shown = view.document.sha;
    // An external edit lands between showing and clicking: shown versions are confirmed, the rest stays unread.
    await write("docs/a.md", DOC.replace("Деталь один.", "Деталь один!?").replace("Второй абзац", "Второй, новый, абзац"));
    const receipt = await service.acknowledge({ path: "docs/a.md", observation: { sha: shown }, scope: "section", heading });
    assert.equal(receipt.staleBlocks, 1, "the UI names how many confirmed blocks changed since (AC07)");
    view = await documentView(service, "docs/a.md");
    assert.equal(view.blocks.find((block) => block.text.startsWith("Деталь")).read, "unread");
    assert.equal(view.blocks.find((block) => block.text.startsWith("Второй")).read, "unread", "outside the section");
    assert.equal(view.lastReceipt.receiptId, receipt.receiptId);
    const second = await service.acknowledge({ path: "docs/a.md", observation: { sha: view.document.sha }, scope: "document" });
    view = await documentView(service, "docs/a.md");
    assert.equal(view.unread, 0);
    await service.revoke({ receiptId: second.receiptId });
    view = await documentView(service, "docs/a.md");
    assert.equal(view.unread, 2, "revoking the document receipt brings back exactly what it confirmed; the section receipt stays");
    assert.equal((await service.revoke({ receiptId: second.receiptId })).status, "duplicate");
  } finally {
    await cleanup();
  }
});

test("batch: DR-01 lock, one item per annotation, reply during work, idempotent results, partial, finish and summary", async () => {
  const { service, write, cleanup } = await repo();
  try {
    const one = await annotate(service, "docs/a.md", (v) => ({ text: "Перепиши первый абзац", ...selection(v, "Первый абзац") }));
    const two = await annotate(service, "docs/a.md", (v) => ({ text: "Уточни", ...selection(v, "Второй абзац") }));
    await service.reply({ annotationId: two.annotationId, text: "И добавь пример" });
    const note = await annotate(service, "docs/a.md", (v) => ({ text: "Просто заметка", kind: "note", ...selection(v, "Деталь один") }));
    let status = await batchStatus(service);
    assert.equal(status.newInstructions.document["docs/a.md"], 2, "the button counts annotations with new instructions, not messages; notes excluded");
    void note;

    const prepared = await prepareBatch(service, { scope: { kind: "document", path: "docs/a.md" }, recipient: { mode: "current-thread", threadId: "thr_loop" } });
    assert.equal(prepared.items, 2);
    // DR-01: a second batch of the same checkout, for another document, waits.
    await annotate(service, "docs/b.md", (v) => ({ text: "Другой файл", ...selection(v, "Другой документ") }));
    await assert.rejects(prepareBatch(service, { scope: { kind: "document", path: "docs/b.md" }, recipient: { mode: "new-thread", threadId: null } }), (error) => error.code === "busy");
    status = await batchStatus(service);
    assert.equal(status.launch.state, "dispatching");
    await markDispatched(service, { runId: prepared.runId, attemptId: prepared.attemptId, recipient: { mode: "current-thread", threadId: "thr_loop" }, delivery: "queued", queuedMessageId: "q1" });
    status = await batchStatus(service);
    assert.equal(status.launch.state, "queued");
    assert.equal(status.active.total, 2);

    const batch = await batchGet(service, { runId: prepared.runId, threadId: "thr_loop" });
    assert.equal(batch.totalItems, 2);
    const itemTwo = batch.items.find((item) => item.annotationId === two.annotationId);
    assert.equal(itemTwo.messages.filter((message) => message.newInstruction).length, 2, "both messages are one item's slice (DR-04)");
    await assert.rejects(batchGet(service, { runId: prepared.runId, threadId: "thr_other" }), (error) => error.code === "foreign-thread");

    // The user replies while the agent works: the reply is not covered by the running item (AC05).
    await service.reply({ annotationId: two.annotationId, text: "Ещё одно: короче" });
    // DR-01: an extra document is registered before the agent edits it.
    const registered = await registerInput(service, { runId: prepared.runId, path: "docs/c.md", agent: agentA });
    assert.equal(registered.status, "registered");
    await write("docs/c.md", "# C\n\nТретий документ, правка агента.\n");
    await write("docs/a.md", DOC.replace("Первый абзац с", "Переписанный первый абзац с"));
    await write("docs/b.md", "# B\n\nДругой документ, внешняя правка.\n");
    const itemOne = batch.items.find((item) => item.annotationId === one.annotationId);
    const reply = await itemReply(service, { runId: prepared.runId, itemId: itemOne.itemId, responseId: "r-1", status: "done", text: "Переписал.", edits: [{ path: "docs/a.md", quote: "Переписанный первый абзац" }], agent: agentA });
    assert.equal(reply.confirmedBlocks, 1);
    const again = await itemReply(service, { runId: prepared.runId, itemId: itemOne.itemId, responseId: "r-1", status: "done", text: "Переписал.", agent: agentA });
    assert.equal(again.status, "duplicate", "redelivery of the same responseId is idempotent (AC11)");
    await assert.rejects(itemReply(service, { runId: prepared.runId, itemId: itemOne.itemId, responseId: "r-x", status: "done", text: "x", edits: [{ path: "docs/a.md", quote: "нет такого текста" }], agent: agentA }), (error) => error.code === "bad-claim");

    let finish = await finishBatch(service, { runId: prepared.runId, agent: agentA });
    assert.equal(finish.outcome, "partial", "an item without an answer gives partial, not done (E3)");
    assert.deepEqual(finish.summary.counts, { done: 1, "needs-input": 0, failed: 0, skipped: 0, missing: 1 });
    assert.ok(finish.summary.outside.includes("docs/b.md"), "an edit outside the batch documents is named (AC20)");
    assert.ok(finish.summary.documents.some((doc) => doc.path === "docs/c.md" && doc.inBatch), "a registered input is part of the round");
    status = await batchStatus(service);
    assert.equal(status.active, null);
    assert.equal(status.launch, null, "the checkout is released");

    const state = await service.state();
    const viewTwo = discussion(state, two.annotationId);
    assert.equal(viewTwo.candidate, true);
    assert.equal(viewTwo.newInstructions.length, 3, "the unanswered item returns to candidates with the new reply");
    const viewOne = discussion(state, one.annotationId);
    assert.equal(viewOne.candidate, false, "an answered item without new instructions is not sent again");
    const summary = await roundSummary(service, state, prepared.runId);
    assert.equal(summary.items.find((item) => item.annotationId === one.annotationId).linked, 1);
    finish = await finishBatch(service, { runId: prepared.runId, agent: agentA });
    assert.equal(finish.status, "already-finished");
  } finally {
    await cleanup();
  }
});

test("dispatch-unknown holds the checkout until an explicit recovery; abandon releases it", async () => {
  const { service, cleanup } = await repo();
  try {
    await annotate(service, "docs/a.md", (v) => ({ text: "Сделай", ...selection(v, "Первый абзац") }));
    const prepared = await prepareBatch(service, { scope: { kind: "all" }, recipient: { mode: "new-thread", threadId: null } });
    await markUnknown(service, { runId: prepared.runId, reason: "timeout" });
    let status = await batchStatus(service);
    assert.equal(status.launch.state, "dispatch-unknown");
    await assert.rejects(prepareBatch(service, { scope: { kind: "all" }, recipient: { mode: "new-thread", threadId: null } }), (error) => error.code === "busy");
    await abandonRun(service, { runId: prepared.runId, outcome: "cancelled", reason: "user" });
    status = await batchStatus(service);
    assert.equal(status.launch, null);
    assert.equal(status.recent[0].finished.outcome, "cancelled");
    const again = await prepareBatch(service, { scope: { kind: "all" }, recipient: { mode: "new-thread", threadId: null } });
    assert.equal(again.items, 1, "an item skipped by cancellation is a candidate again (DR-04)");
  } finally {
    await cleanup();
  }
});

test("«Принять»: closes and confirms only shown linked edits; stale after a new reply; undo has two addressed parts", async () => {
  const { service, write, cleanup } = await repo();
  try {
    const one = await annotate(service, "docs/a.md", (v) => ({ text: "Перепиши", ...selection(v, "Первый абзац") }));
    const prepared = await prepareBatch(service, { scope: { kind: "all" }, recipient: { mode: "current-thread", threadId: "thr_loop" } });
    await markDispatched(service, { runId: prepared.runId, attemptId: prepared.attemptId, recipient: { mode: "current-thread", threadId: "thr_loop" }, delivery: "sent" });
    const batch = await batchGet(service, { threadId: "thr_loop" });
    await write("docs/a.md", DOC.replace("Первый абзац с", "Новый первый абзац с").replace("Деталь один.", "Деталь один (не по замечанию)."));
    await itemReply(service, { runId: prepared.runId, itemId: batch.items[0].itemId, responseId: "r", status: "done", text: "Готово", edits: [{ path: "docs/a.md", quote: "Новый первый абзац" }], agent: agentA });
    await finishBatch(service, { runId: prepared.runId, agent: agentA });

    let view = await documentView(service, "docs/a.md");
    let card = view.annotations.find((annotation) => annotation.annotationId === one.annotationId);
    assert.equal(card.waiting, true, "«Ждёт вас»: answered, no newer instruction");
    assert.equal(card.agent, "done");
    assert.equal(card.latest.linked.length, 1, "the confirmed link is shown");
    const unrelated = view.blocks.find((block) => block.text.startsWith("Деталь один"));
    assert.equal(unrelated.read, "unread");

    // A newer reply makes the old button stale (DR-04).
    const shownHeads = card.heads;
    await service.reply({ annotationId: one.annotationId, text: "Подожди, ещё вопрос" });
    await assert.rejects(accept(service, { annotationId: one.annotationId, expectedHeads: shownHeads, resultEventId: card.latest.eventId, path: "docs/a.md",
      observation: { sha: view.document.sha }, blocks: card.latest.linked.map((entry) => entry.block) }), (error) => error.code === "stale");

    view = await documentView(service, "docs/a.md");
    card = view.annotations.find((annotation) => annotation.annotationId === one.annotationId);
    assert.equal(card.waiting, false, "a new instruction: no longer waiting for the user");
    const accepted = await accept(service, { annotationId: one.annotationId, expectedHeads: card.heads, resultEventId: card.latest.eventId, path: "docs/a.md",
      observation: { sha: view.document.sha }, blocks: [...card.latest.linked.map((entry) => entry.block), unrelated.index] });
    assert.equal(accepted.confirmed, 1, "an unlinked block is not confirmed by «Принять»");
    view = await documentView(service, "docs/a.md");
    card = view.annotations.find((annotation) => annotation.annotationId === one.annotationId);
    assert.equal(card.status, "closed");
    assert.equal(view.blocks.find((block) => block.text.startsWith("Новый первый")).read, "read");
    assert.equal(view.blocks.find((block) => block.text.startsWith("Деталь один")).read, "unread");

    const undone = await undoAccept(service, { annotationId: one.annotationId, acceptEventId: accepted.eventId, receiptId: accepted.receiptId });
    assert.equal(undone.reopened, true);
    view = await documentView(service, "docs/a.md");
    assert.equal(view.annotations.find((annotation) => annotation.annotationId === one.annotationId).status, "open");
    assert.equal(view.blocks.find((block) => block.text.startsWith("Новый первый")).read, "unread");

    // A later decision is not overwritten by an undo.
    view = await documentView(service, "docs/a.md");
    card = view.annotations.find((annotation) => annotation.annotationId === one.annotationId);
    const second = await accept(service, { annotationId: one.annotationId, expectedHeads: card.heads, resultEventId: card.latest.eventId, path: "docs/a.md", observation: { sha: view.document.sha }, blocks: [] });
    await service.decide({ annotationId: one.annotationId, action: "reopen", expectedHeads: [second.eventId] });
    view = await documentView(service, "docs/a.md");
    card = view.annotations.find((annotation) => annotation.annotationId === one.annotationId);
    await service.decide({ annotationId: one.annotationId, action: "close", expectedHeads: card.heads });
    const late = await undoAccept(service, { annotationId: one.annotationId, acceptEventId: second.eventId, receiptId: null });
    assert.equal(late.reopened, false);
  } finally {
    await cleanup();
  }
});

test("closing or turning into a note after preparation: skip requested, the late answer stays history and reopens nothing", async () => {
  const { service, cleanup } = await repo();
  try {
    const one = await annotate(service, "docs/a.md", (v) => ({ text: "Сделай", ...selection(v, "Первый абзац") }));
    const prepared = await prepareBatch(service, { scope: { kind: "all" }, recipient: { mode: "current-thread", threadId: "thr_loop" } });
    await markDispatched(service, { runId: prepared.runId, attemptId: prepared.attemptId, recipient: { mode: "current-thread", threadId: "thr_loop" }, delivery: "sent" });
    let view = await documentView(service, "docs/a.md");
    const card = view.annotations.find((annotation) => annotation.annotationId === one.annotationId);
    await service.decide({ annotationId: one.annotationId, action: "close", expectedHeads: card.heads });
    const batch = await batchGet(service, { threadId: "thr_loop" });
    assert.equal(batch.items[0].skipRequested, true);
    const reply = await itemReply(service, { runId: prepared.runId, itemId: batch.items[0].itemId, responseId: "late", status: "done", text: "Сделал всё равно", agent: agentA });
    assert.match(reply.note, /history only/);
    view = await documentView(service, "docs/a.md");
    const after = view.annotations.find((annotation) => annotation.annotationId === one.annotationId);
    assert.equal(after.status, "closed", "a late result does not reopen (AC29)");
    assert.equal(after.messages.at(-1).role, "agent");
    // An agent cannot withdraw or close through the service: decisions belong to people.
    await assert.rejects(service.revise({ annotationId: one.annotationId, messageId: after.messages.at(-1).messageId, text: "чужая правка" }), /author|transition/);
  } finally {
    await cleanup();
  }
});

test("withdraw before sending with undo; edit after sending is a new instruction (C6, AC22 second part)", async () => {
  const { service, cleanup } = await repo();
  try {
    const one = await annotate(service, "docs/a.md", (v) => ({ text: "Черновая мысль", ...selection(v, "Первый абзац") }));
    let view = await documentView(service, "docs/a.md");
    let card = view.annotations.find((annotation) => annotation.annotationId === one.annotationId);
    await service.decide({ annotationId: one.annotationId, action: "withdraw", expectedHeads: card.heads });
    view = await documentView(service, "docs/a.md");
    card = view.annotations.find((annotation) => annotation.annotationId === one.annotationId);
    assert.equal(card.status, "withdrawn");
    await service.decide({ annotationId: one.annotationId, action: "restore", expectedHeads: card.heads });
    view = await documentView(service, "docs/a.md");
    card = view.annotations.find((annotation) => annotation.annotationId === one.annotationId);
    assert.equal(card.status, "open");
    await service.revise({ annotationId: one.annotationId, messageId: card.messages[0].messageId, text: "Чистовая мысль" });
    const prepared = await prepareBatch(service, { scope: { kind: "all" }, recipient: { mode: "current-thread", threadId: "thr_loop" } });
    await markDispatched(service, { runId: prepared.runId, attemptId: prepared.attemptId, recipient: { mode: "current-thread", threadId: "thr_loop" }, delivery: "sent" });
    view = await documentView(service, "docs/a.md");
    card = view.annotations.find((annotation) => annotation.annotationId === one.annotationId);
    await assert.rejects(service.decide({ annotationId: one.annotationId, action: "withdraw", expectedHeads: card.heads }), /already sent/);
    await service.revise({ annotationId: one.annotationId, messageId: card.messages[0].messageId, text: "Чистовая мысль, уточнённая" });
    const state = await service.state();
    assert.equal(discussion(state, one.annotationId).newInstructions.length, 1, "an edit after sending is the next batch's instruction");
  } finally {
    await cleanup();
  }
});

test("the latest result of an annotation follows its own causal order, not the order of independent runs", async () => {
  const { service, cleanup } = await repo();
  try {
    const one = await annotate(service, "docs/a.md", (v) => ({ text: "Сделай", ...selection(v, "Первый абзац") }));
    for (const [key, status] of [["first", "done"], ["second", "needs-input"]]) {
      const prepared = await prepareBatch(service, { scope: { kind: "all" }, recipient: { mode: "current-thread", threadId: "thr_loop" } });
      await markDispatched(service, { runId: prepared.runId, attemptId: prepared.attemptId, recipient: { mode: "current-thread", threadId: "thr_loop" }, delivery: "sent" });
      const batch = await batchGet(service, { runId: prepared.runId, threadId: "thr_loop" });
      await itemReply(service, { runId: prepared.runId, itemId: batch.items[0].itemId, responseId: key, status, text: key, agent: agentA });
      await finishBatch(service, { runId: prepared.runId, agent: agentA });
      if (key === "first") await service.reply({ annotationId: one.annotationId, text: "Ещё" });
    }
    const view = await documentView(service, "docs/a.md");
    const card = view.annotations.find((annotation) => annotation.annotationId === one.annotationId);
    assert.equal(card.agent, "needs-input");
    assert.equal(card.latest.status, "needs-input");
  } finally {
    await cleanup();
  }
});

test("new files stay read until an explicit viewer opening; first opening persists one baseline", async () => {
  const r = await repo();
  try {
    await r.write("docs/new.md", "# New\n\nFirst version.\n");
    assert.equal((await documentView(r.service, "docs/new.md")).unread, 0, "passive reads do not show a new file as changed");
    await r.write("docs/new.md", "# New\n\nEdited before opening.\n");
    assert.equal((await documentView(r.service, "docs/new.md")).unread, 0);
    assert.equal([...(await r.service.state()).documents.values()].some((doc) => doc.path === "docs/new.md"), false);
    await Promise.all([r.service.openDocument("docs/new.md"), r.service.openDocument("docs/new.md")]);
    const opened = await documentView(r.service, "docs/new.md");
    assert.equal(opened.unread, 0);
    assert.ok(opened.document.docId);
    const record = (await r.service.state()).documents.get(opened.document.docId);
    assert.equal(record.revisions.length, 1, "concurrent opens cannot create duplicate baselines");
    await r.write("docs/new.md", "# New\n\nEdited after opening.\n");
    const cold = new ReviewService(r.dir, r.data);
    await cold.openDocument("docs/new.md");
    assert.equal((await documentView(cold, "docs/new.md")).unread, 1, "restart and reopening preserve edits after the first opening");
  } finally { await r.cleanup(); }
});

test("an agent-registered new file also starts reading only on its first human opening", async () => {
  const r = await repo();
  try {
    await r.write("docs/agent.md", "# Agent\n\nBefore first opening.\n");
    const { state } = await r.service.writable({});
    const current = await r.service.readDocument("docs/agent.md");
    const promoted = await r.service.promote(state, "docs/agent.md", null, { sha: current.sha }, "target", "batch-input");
    await r.service.commit(state, { kind: "agent", model: "test", threadId: "thr_test", requestedBy: { name: "Owner", email: "owner@bb-docs.invalid" } }, promoted.changes, promoted.objects, promoted.snapshots);
    await r.write("docs/agent.md", "# Agent\n\nAgent completed its draft.\n");
    assert.equal((await documentView(r.service, "docs/agent.md")).unread, 0);
    await r.service.openDocument("docs/agent.md");
    assert.equal((await documentView(r.service, "docs/agent.md")).unread, 0);
    await r.write("docs/agent.md", "# Agent\n\nAgent completed its draft, with another change after opening.\n");
    assert.equal((await documentView(r.service, "docs/agent.md")).unread, 1);
  } finally { await r.cleanup(); }
});
