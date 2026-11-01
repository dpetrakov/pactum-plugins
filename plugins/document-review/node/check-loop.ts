// W-03 part of `bb document-review check`: the review loop on the temporary clone of the machine the host entry
// runs on — the host-computed view of a 1 MiB document, a whole batch round with the agent's commands (DR-01,
// DR-04), finish with the round summary, «Accept» with its undo. No bb thread is involved: dispatch is recorded
// as the server records it after bb accepted the message; the thread side is checked live separately.
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { discussion } from "../core/discussion.ts";
import { accept, batchGet, batchStatus, finishBatch, itemReply, markDispatched, prepareBatch, registerInput, undoAccept } from "./batches.ts";
import type { ReviewService } from "./service.ts";
import { documentView } from "./view.ts";

type Step = (name: string, run: () => Promise<string | void>) => Promise<void>;

const LOOP = [
  "# Цикл обзора",
  "",
  "Первый абзац, который агент перепишет.",
  "",
  "Второй абзац с вопросом к агенту.",
  "",
  "## Детали",
  "",
  "Деталь, которую правит внешний редактор.",
  "",
].join("\n");

export async function loopSteps(input: { step: Step; assert: (condition: unknown, message: string) => void; service: () => ReviewService; root: string; docDir: string; measurements: Record<string, string> }) {
  const { step, assert, measurements } = input;
  const doc = `${input.docDir}/loop.md`;
  const extra = `${input.docDir}/extra.md`;
  const agent = { model: "check-agent", threadId: "thr_check" };
  const cp = (text: string) => [...text].length;
  const select = async (needle: string) => {
    const view = await documentView(input.service(), doc);
    const block = view.blocks.find((entry) => entry.text.includes(needle))!;
    const start = block.range.start + cp(block.text.slice(0, block.text.indexOf(needle)));
    return { view, range: { start, end: start + cp(needle) }, quote: needle };
  };
  let runId = "";
  let one = "";
  let two = "";

  await step("W-03/W-04 view: 1 MiB document computed on the host (blocks, read state, anchors); cold, warm, after an edit", async () => {
    const big = `${input.docDir}/big.md`;
    // Distinct paragraphs (numbered), so the cold view parses everything and nothing is reused by accident.
    const paragraphs: string[] = [];
    let size = 0;
    for (let index = 0; size < 1024 * 1024; index++) {
      const paragraph = index % 40 === 0 ? `## Раздел ${index / 40}` : `Абзац ${index} большого документа со [ссылкой](https://example.com/${index}) и **выделением ${index}**, чтобы проекция была непустой.`;
      paragraphs.push(paragraph);
      size += Buffer.byteLength(paragraph) + 2;
    }
    const text = `# Большой\n\n${paragraphs.join("\n\n")}\n`;
    await fs.writeFile(path.join(input.root, big), text);
    const t0 = performance.now();
    const cold = await documentView(input.service(), big);
    const coldMs = performance.now() - t0;
    const t1 = performance.now();
    await documentView(input.service(), big);
    const warmMs = performance.now() - t1;
    // EP-012-T04: an agent edits one paragraph in the middle; unchanged chunks are not parsed again.
    const middle = paragraphs.length >> 1;
    paragraphs[middle] = `${paragraphs[middle]} Дописано агентом.`;
    await fs.writeFile(path.join(input.root, big), `# Большой\n\n${paragraphs.join("\n\n")}\n`);
    const t2 = performance.now();
    const edited = await documentView(input.service(), big);
    const editMs = performance.now() - t2;
    measurements["view 1 MiB"] = `${cold.blocks.length} blocks; cold ${Math.round(coldMs)} ms, warm (same revision) ${Math.round(warmMs)} ms, after a one-paragraph edit ${Math.round(editMs)} ms`;
    assert(cold.blocks.length > 1000 && edited.blocks.length === cold.blocks.length, "blocks");
    assert(edited.blocks[middle + 1]?.text.includes("Дописано агентом") || edited.blocks.some((block) => block.text.includes("Дописано агентом")), "the edit is shown");
    await fs.rm(path.join(input.root, big));
    return measurements["view 1 MiB"];
  });

  await step("W-03 batch: one item per annotation, DR-01 lock across documents, agent reads every page", async () => {
    await fs.writeFile(path.join(input.root, doc), LOOP);
    await fs.writeFile(path.join(input.root, extra), "# Дополнительный\n\nТекст другого документа.\n");
    const service = input.service();
    let s = await select("Первый абзац");
    one = (await service.annotate({ path: doc, observation: { sha: s.view.document.sha }, text: "Перепиши короче", kind: "action", range: s.range, quote: s.quote })).annotationId;
    s = await select("вопросом к агенту");
    two = (await service.annotate({ path: doc, observation: { sha: s.view.document.sha }, text: "Ответь на вопрос", kind: "action", range: s.range, quote: s.quote })).annotationId;
    await service.reply({ annotationId: two, text: "И приведи пример" });
    const prepared = await prepareBatch(service, { scope: { kind: "document", path: doc }, recipient: { mode: "current-thread", threadId: agent.threadId } });
    runId = prepared.runId;
    assert(prepared.items === 2, `items ${prepared.items}`);
    let refused = false;
    try {
      await prepareBatch(service, { scope: { kind: "all" }, recipient: { mode: "new-thread", threadId: null } });
    } catch (error) {
      refused = (error as { code?: string }).code === "busy";
    }
    assert(refused, "a second batch of the same checkout must wait (DR-01)");
    await markDispatched(service, { runId, attemptId: prepared.attemptId, recipient: { mode: "current-thread", threadId: agent.threadId }, delivery: "queued", queuedMessageId: "check" });
    const batch = await batchGet(service, { runId, threadId: agent.threadId });
    assert(batch.totalItems === 2 && batch.pages === 1, "manifest");
    const slice = batch.items.find((item) => item.annotationId === two)!.messages.filter((message) => message.newInstruction).length;
    assert(slice === 2, `slice of item two: ${slice}`);
    return `run ${runId.slice(0, 8)}: 2 items, second batch refused`;
  });

  await step("W-03 agent: register an extra input before editing, idempotent replies, a user reply during work stays new (AC05, AC26)", async () => {
    const service = input.service();
    const registered = await registerInput(service, { runId, path: extra, agent });
    assert(registered.status === "registered", "registered");
    await service.reply({ annotationId: two, text: "Пока агент работает: ещё короче" });
    await fs.writeFile(path.join(input.root, doc), LOOP.replace("Первый абзац, который агент перепишет.", "Короткий первый абзац.").replace("Деталь, которую правит внешний редактор.", "Деталь после внешнего редактора."));
    await fs.writeFile(path.join(input.root, extra), "# Дополнительный\n\nТекст другого документа, поправлен агентом.\n");
    const batch = await batchGet(service, { runId, threadId: agent.threadId });
    const itemOne = batch.items.find((item) => item.annotationId === one)!;
    const itemTwo = batch.items.find((item) => item.annotationId === two)!;
    const r1 = await itemReply(service, { runId, itemId: itemOne.itemId, responseId: "one", status: "done", text: "Сократил.", edits: [{ path: doc, quote: "Короткий первый абзац." }], agent });
    const again = await itemReply(service, { runId, itemId: itemOne.itemId, responseId: "one", status: "done", text: "Сократил.", agent });
    assert(r1.confirmedBlocks === 1 && again.status === "duplicate", "idempotent result with a confirmed edit");
    await itemReply(service, { runId, itemId: itemTwo.itemId, responseId: "two", status: "needs-input", text: "Какой пример нужен?", agent });
    const state = await service.state();
    assert(discussion(state, two).newInstructions.length === 1, "the reply during work is not covered by the running item");
    return "extra input registered; duplicate result ignored; reply during work stays a new instruction";
  });

  await step("W-03 finish: completed, round summary names edits outside the batch documents (AC20)", async () => {
    const service = input.service();
    await fs.writeFile(path.join(input.root, input.docDir, "notes.md"), `${await fs.readFile(path.join(input.root, input.docDir, "notes.md"), "utf8")}\nВнешняя правка во время раунда.\n`);
    const finished = await finishBatch(service, { runId, agent });
    assert(finished.status === "finished" && finished.outcome === "completed", `outcome ${finished.status} ${"outcome" in finished ? finished.outcome : ""}`);
    const summary = "summary" in finished ? finished.summary : null;
    assert(summary && summary.outside.some((file) => file.endsWith("notes.md")), `outside: ${JSON.stringify(summary?.outside)}`);
    const status = await batchStatus(service);
    assert(!status.active && !status.launch, "the checkout is released");
    return `${JSON.stringify(summary!.counts)}; changed ${summary!.changedBlocks} blocks; outside ${summary!.outside.join(", ")}`;
  });

  await step("W-03 accept: closes and confirms only the linked shown edit; undo restores both parts", async () => {
    const service = input.service();
    let view = await documentView(service, doc);
    const card = view.annotations.find((annotation) => annotation.annotationId === one)!;
    assert(card.waiting && card.latest?.linked.length === 1, "waiting with one linked edit");
    const external = view.blocks.find((block) => block.text.startsWith("Деталь после"))!;
    assert(external.read === "unread", "the external edit is unread");
    const result = await accept(service, { annotationId: one, expectedHeads: card.heads, resultEventId: card.latest!.eventId, path: doc, observation: { sha: view.document.sha },
      blocks: [...card.latest!.linked.map((entry) => entry.block), external.index] });
    assert(result.confirmed === 1, "only the linked edit is confirmed");
    view = await documentView(service, doc);
    assert(view.annotations.find((annotation) => annotation.annotationId === one)!.status === "closed", "closed");
    assert(view.blocks.find((block) => block.text.startsWith("Деталь после"))!.read === "unread", "external edit stays unread");
    const undone = await undoAccept(service, { annotationId: one, acceptEventId: result.eventId, receiptId: result.receiptId });
    assert(undone.status === "undone" && undone.reopened, "undo reopens and revokes");
    const report = await service.validate();
    assert(report.ok, `validate: ${JSON.stringify(report.problems.slice(0, 3))}`);
    return `accepted ${result.confirmed} linked block; undo reopened; validate OK (${report.counts.events} events)`;
  });
}
