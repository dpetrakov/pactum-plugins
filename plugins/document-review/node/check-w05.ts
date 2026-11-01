// W-05 part of `bb document-review check` (EP-014, EP-015), on the machine the host entry runs on. Every step works in
// its own temporary repository inside the check's work directory; the source checkout is never written.
import fs from "node:fs/promises";
import path from "node:path";
import { runsOf, unfinishedRuns } from "../core/batch.ts";
import { tr } from "../core/i18n.ts";
import { performance } from "node:perf_hooks";
import { clearParsedObjects, loadRepository, project } from "../core/journal.ts";
import { accept } from "./batches.ts";
import { batchGet, finishBatch, itemReply, markDispatched, prepareBatch, abandonRun } from "./batches.ts";
import { setRule, treeWithMoves } from "./catalog.ts";
import { scratch } from "./check-catalog.ts";
import { summary } from "./check.ts";
import { git } from "./checkout.ts";
import { documentTree } from "./tree.ts";
import { ReviewService } from "./service.ts";
import { documentView } from "./view.ts";

type Step = (name: string, run: () => Promise<string | void>) => Promise<void>;
type Assert = (condition: unknown, message: string) => void;

class Crash extends Error {
  readonly code = "crash";
}

/** Fail the `crashAt`-th mutating step of a service (.bb-docs files, config CAS, launch and intent records). */
export function injectCrash(service: ReviewService, crashAt: number, when: "before" | "after") {
  let steps = 0;
  const wrap = <T extends object>(object: T, name: keyof T & string) => {
    const original = (object[name] as unknown as (...args: unknown[]) => Promise<unknown>).bind(object);
    (object as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      const index = steps++;
      if (index === crashAt && when === "before") throw new Crash(`crash before step ${index}`);
      const result = await original(...args);
      if (index === crashAt && when === "after") throw new Crash(`crash after step ${index}`);
      return result;
    };
  };
  wrap(service.store, "createExclusive");
  wrap(service.store, "replace");
  wrap(service.launch, "put");
  wrap(service.intents, "put");
  wrap(service.intents, "clear");
}

export const isCrash = (error: unknown) => (error as { code?: string })?.code === "crash";

export async function w05ReliabilitySteps(input: { step: Step; assert: Assert; work: string; measurements: Record<string, string> }) {
  const { step, assert, work } = input;

  await step(tr("W-05 AC11: crash at every write of an agent answer, a batch and “Track”; host restart; retry completes once",
    "W-05 AC11: crash at every write of an agent answer, a batch and «Отслеживать»; host restart; retry completes once"), async () => {
    const doc = "# Сбой\n\nПервый абзац.\n\nВторой абзац.\n";
    let points = 0;
    // Agent answer: every step, before and after the write.
    let exhausted = false;
    // Tests shorten the scenario; the real check covers every write step.
    const limit = Number(process.env.DOCUMENT_REVIEW_CHECK_CRASH_POINTS) || 16;
    for (let crashAt = 0; crashAt < limit && !exhausted; crashAt++) {
      for (const when of ["before", "after"] as const) {
        const repo = await scratch(work, `crash-${crashAt}-${when}`, { "docs/a.md": doc });
        const shown = await documentView(repo.service, "docs/a.md");
        await repo.service.annotate({ path: "docs/a.md", observation: { sha: shown.document.sha }, kind: "action", text: "Перепиши", targetKind: "block", block: 1 });
        const prepared = await prepareBatch(repo.service, { scope: { kind: "all" }, recipient: { mode: "current-thread", threadId: "thr_check" } });
        await markDispatched(repo.service, { runId: prepared.runId, attemptId: prepared.attemptId, recipient: { mode: "current-thread", threadId: "thr_check" }, delivery: "sent" });
        const { items } = await batchGet(repo.service, { runId: prepared.runId, threadId: "thr_check" });
        await repo.write("docs/a.md", doc.replace("Первый абзац.", "Новый первый абзац."));
        const answer = (service: ReviewService) => itemReply(service, { runId: prepared.runId, itemId: items[0].itemId, responseId: "a1", status: "done", text: "Готово", edits: [{ path: "docs/a.md", quote: "Новый первый абзац." }], agent: { model: "check", threadId: "thr_check" } });
        const dataDir = path.join(work, `crash-${crashAt}-${when}-data`); // the same plugin data as the scratch service
        const victim = new ReviewService(repo.dir, dataDir);
        injectCrash(victim, crashAt, when);
        let crashed = false;
        await answer(victim).catch((error) => {
          if (!isCrash(error)) throw error;
          crashed = true;
        });
        if (!crashed) {
          await fs.rm(repo.dir, { recursive: true, force: true });
          exhausted = true;
          break;
        }
        points++;
        const restarted = new ReviewService(repo.dir, dataDir);
        const report = await restarted.validate(5);
        assert(report.problems.every((problem) => problem.severity !== "error"), `damaged data after crash ${crashAt} ${when}: ${JSON.stringify(report.problems.slice(0, 2))}`);
        await answer(restarted);
        const run = runsOf(await restarted.state()).find((entry) => entry.runId === prepared.runId)!;
        assert(run.results.length === 1, `one result after retry (crash ${crashAt} ${when}), got ${run.results.length}`);
        assert(unfinishedRuns(await restarted.state()).length === 1, "still the only executor");
        await finishBatch(restarted, { runId: prepared.runId, agent: { model: "check", threadId: "thr_check" } });
        await fs.rm(repo.dir, { recursive: true, force: true });
      }
    }
    // Preparing a batch: a crash leaves the checkout held (launch record or journal) until explicit recovery.
    for (let crashAt = 0; crashAt < Math.min(4, limit); crashAt++) {
      const repo = await scratch(work, `prep-${crashAt}`, { "docs/a.md": doc });
      const shown = await documentView(repo.service, "docs/a.md");
      await repo.service.annotate({ path: "docs/a.md", observation: { sha: shown.document.sha }, kind: "action", text: "Сделай", targetKind: "block", block: 1 });
      const dataDir = path.join(work, `prep-${crashAt}-data`); // the same plugin data as the scratch service
      const victim = new ReviewService(repo.dir, dataDir);
      injectCrash(victim, crashAt, "after");
      const send = (service: ReviewService) => prepareBatch(service, { scope: { kind: "all" }, recipient: { mode: "new-thread", threadId: null } });
      const crashed = await send(victim).then(() => false, (error) => { if (!isCrash(error)) throw error; return true; });
      if (!crashed) break;
      points++;
      const restarted = new ReviewService(repo.dir, dataDir);
      const held = Boolean(await restarted.launch.get()) || unfinishedRuns(await restarted.state()).length > 0;
      if (!held) {
        // Nothing reached the journal and the failed preparation released its own launch record.
        assert((await send(restarted)).items === 1, "nothing was half-sent");
        await fs.rm(repo.dir, { recursive: true, force: true });
        continue;
      }
      const busy = await send(restarted).then(() => false, (error) => (error as { code?: string }).code === "busy");
      assert(busy, "no second executor after restart (DR-01)");
      const runId = (await restarted.launch.get())?.runId ?? unfinishedRuns(await restarted.state())[0].runId;
      await abandonRun(restarted, { runId, outcome: "cancelled" }).catch(() => undefined);
      assert((await send(restarted)).items === 1, "explicit recovery releases the checkout");
      await fs.rm(repo.dir, { recursive: true, force: true });
    }
    // «Track»: crash between config.json and tracking-resumed; the next catalog command finishes it.
    for (let crashAt = 0; crashAt < Math.min(6, limit); crashAt++) {
      const repo = await scratch(work, `resume-${crashAt}`, { "docs/a.md": doc });
      await setRule(repo.service, { list: "untracked", path: "docs/a.md", isDir: false, action: "add" });
      await repo.write("docs/a.md", doc.replace("Второй абзац.", "Второй абзац, правка в паузе."));
      const dataDir = path.join(work, `resume-${crashAt}-data`); // the same plugin data as the scratch service
      const victim = new ReviewService(repo.dir, dataDir);
      injectCrash(victim, crashAt, "after");
      const resume = (service: ReviewService) => setRule(service, { list: "untracked", path: "docs/a.md", isDir: false, action: "remove" });
      const crashed = await resume(victim).then(() => false, (error) => { if (!isCrash(error)) throw error; return true; });
      if (!crashed) break;
      points++;
      const restarted = new ReviewService(repo.dir, dataDir);
      const mid = await documentView(restarted, "docs/a.md");
      const paused = mid.blocks.find((block) => block.text.includes("в паузе"))!;
      assert(mid.document.trackingResumed || paused.read !== "read", "the pause is never claimed as read");
      await treeWithMoves(restarted);
      await resume(restarted);
      const done = await documentView(restarted, "docs/a.md");
      assert(done.document.trackingResumed && !(await restarted.config()).value!.untracked.length, `rule kept and base recorded after crash ${crashAt}`);
      await fs.rm(repo.dir, { recursive: true, force: true });
    }
    return `${points} crash points; validate clean after each; retries completed once`;
  });

  await step("W-05 AC01/AC17: clone without plugin data — the same email restores the state, a new email accepts the current state (undoable), no email is read-only", async () => {
    const repo = await scratch(work, "readers", { "docs/one.md": "# One\n\nПервый.\n", "docs/two.md": "# Two\n\nТекст.\n" });
    await repo.write("docs/two.md", "# Two\n\nТекст, правка.\n");
    const shown = await documentView(repo.service, "docs/one.md");
    await repo.service.annotate({ path: "docs/one.md", observation: { sha: shown.document.sha }, kind: "action", text: "Проверить", targetKind: "block", block: 1 });
    const gx = (cwd: string, args: string[]) => git(cwd, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { timeoutMs: 60_000 });
    await gx(repo.dir, ["add", "-A"]);
    await gx(repo.dir, ["commit", "-q", "-m", "review"]);
    const clone = async (name: string, email: string) => {
      const dir = path.join(work, name);
      await gx(work, ["clone", "-q", repo.dir, dir]);
      await gx(dir, ["config", "user.name", name]);
      await gx(dir, ["config", "user.email", email]);
      return new ReviewService(await fs.realpath(dir), path.join(work, `${name}-data`));
    };
    const same = await clone("readers-same", "check@bb-docs.invalid");
    assert(await summary(same, "check@bb-docs.invalid") === await summary(repo.service, "check@bb-docs.invalid"), "same email: the same state after clone");
    assert((await same.status()).enabled, "no enabling after clone");
    const fresh = await clone("readers-new", "new.reader@bb-docs.invalid");
    const before = await documentTree(fresh);
    assert(!before.reader.known && before.totals.unreadDocs === 1, `new reader offered: ${JSON.stringify(before.reader)} ${before.totals.unreadDocs}`);
    const accepted = await fresh.acknowledgeAll({});
    assert((await documentTree(fresh)).totals.unreadDocs === 0, "accepted");
    await fresh.revokeMany({ receiptIds: accepted.receipts });
    assert((await documentTree(fresh)).totals.unreadDocs === 1, "undone exactly");
    const anonymous = await clone("readers-none", "");
    const view = await documentView(anonymous, "docs/one.md");
    assert(!view.context.writable && view.annotations.length === 1, "no email: read only, annotations visible");
    return `same email digest equal; new reader accepted ${accepted.documents} doc(s) and undid it; without email read-only`;
  });

  await step("W-05 G8: history growth — rounds of review on 1000 documents: volume of .bb-docs and cold journal load", async () => {
    const count = Number(process.env.DOCUMENT_REVIEW_CHECK_TREE_FILES) || 1000;
    const rounds = Number(process.env.DOCUMENT_REVIEW_CHECK_ROUNDS) || 3;
    const files: Record<string, string> = {};
    const paragraph = "Текст абзаца для замера роста истории. ".repeat(6);
    for (let index = 0; index < count; index++) files[`docs/d${Math.floor(index / 50)}/f${index}.md`] = `# Документ ${index}\n\n${Array.from({ length: 22 }, () => paragraph).join("\n\n")}\n`;
    const repo = await scratch(work, "growth", files);
    const service = repo.service;
    const agent = { model: "check", threadId: "thr_growth" };
    let annotations = 0;
    const phases: Record<string, number> = {};
    const phase = async <T>(name: string, run: () => Promise<T>): Promise<T> => { const t0 = performance.now(); try { return await run(); } finally { phases[name] = (phases[name] ?? 0) + performance.now() - t0; } };
    for (let round = 0; round < rounds; round++) {
      const touched = Array.from({ length: 10 }, (_, index) => (round * 10 + index * 7) % count).map((k) => `docs/d${Math.floor(k / 50)}/f${k}.md`);
      for (const doc of [...new Set(touched)]) await repo.write(doc, `${files[doc]}\nРаунд ${round}: новый абзац.\n`);
      for (const doc of [...new Set(touched)].slice(0, 3)) {
        const shown = await phase("view", () => documentView(service, doc));
        await phase("annotate", () => service.annotate({ path: doc, observation: { sha: shown.document.sha }, kind: "action", text: `Раунд ${round}: уточнить`, targetKind: "block", block: 1 }));
        annotations++;
      }
      const prepared = await phase("prepare", () => prepareBatch(service, { scope: { kind: "all" }, recipient: { mode: "current-thread", threadId: "thr_growth" } }));
      await markDispatched(service, { runId: prepared.runId, attemptId: prepared.attemptId, recipient: { mode: "current-thread", threadId: "thr_growth" }, delivery: "sent" });
      const batch = await batchGet(service, { runId: prepared.runId, threadId: "thr_growth" });
      for (const item of batch.items) {
        await repo.write(item.path!, `${files[item.path!]}\nРаунд ${round}: новый абзац.\nПравка агента ${round}.\n`);
        await phase("reply", () => itemReply(service, { runId: prepared.runId, itemId: item.itemId, responseId: `r${round}`, status: "done", text: "Готово", edits: [{ path: item.path!, quote: `Правка агента ${round}.` }], agent }));
      }
      await phase("finish", () => finishBatch(service, { runId: prepared.runId, agent }));
      for (const item of batch.items) {
        const view = await phase("view", () => documentView(service, item.path!));
        const card = view.annotations.find((annotation) => annotation.annotationId === item.annotationId)!;
        await phase("accept", () => accept(service, { annotationId: item.annotationId, expectedHeads: card.heads, resultEventId: card.latest!.eventId, path: item.path!, observation: { sha: view.document.sha }, blocks: card.latest!.linked.map((entry) => entry.block) }));
      }
      for (const doc of [...new Set(touched)]) {
        const view = await phase("view", () => documentView(service, doc));
        if (view.unread) await phase("acknowledge", () => service.acknowledge({ path: doc, observation: { sha: view.document.sha }, scope: "document" }));
      }
    }
    const size = await service.size();
    clearParsedObjects();
    const t0 = performance.now();
    const state = project(await loadRepository(service.store));
    const coldMs = performance.now() - t0;
    const t1 = performance.now();
    project(await loadRepository(service.store));
    const warmMs = performance.now() - t1;
    const report = await service.validate(5);
    assert(report.ok, `validate after growth: ${JSON.stringify(report.problems.slice(0, 2))}`);
    const orphans = await service.orphans();
    assert(!orphans.objects.length && !orphans.snapshots.length, "no unreferenced files after normal rounds");
    const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);
    input.measurements[`W-05 growth ${count} docs × ${rounds} rounds`] = `${state.events.size} events (${mib(size.events.bytes)} MiB), ${size.objects.files} objects (${mib(size.objects.bytes)} MiB), ${size.snapshots.files} snapshots (${mib(size.snapshots.bytes)} MiB); ${annotations} annotations; journal load cold ${Math.round(coldMs)} ms, warm ${Math.round(warmMs)} ms; validate OK, 0 orphans; time by phase ${Object.entries(phases).map(([name, ms]) => `${name} ${Math.round(ms / 1000)} s`).join(", ")}`;
    return `${state.events.size} events, .bb-docs ${mib(size.events.bytes + size.objects.bytes + size.snapshots.bytes)} MiB, cold load ${Math.round(coldMs)} ms`;
  });
}

/** EP-015-T01: H7 targets measured on this machine after a simulated host restart, with and without the host caches. */
export async function w05PerformanceSteps(input: { step: Step; assert: Assert; work: string; measurements: Record<string, string> }) {
  const { step, work, measurements } = input;
  await step("W-05 H7: restart of the host — tree of 1000 files, 200 KiB cold/warm, 1 MiB first view, reaction to a save; with and without host caches", async () => {
    const { clearChunkCache } = await import("../core/markdown/parse.ts");
    const { clearViewCaches } = await import("./view.ts");
    const count = Number(process.env.DOCUMENT_REVIEW_CHECK_TREE_FILES) || 1000;
    const paragraph = "Текст абзаца для замера дерева документов. ".repeat(6);
    const files: Record<string, string> = {};
    for (let index = 0; index < count; index++) files[`docs/d${Math.floor(index / 50)}/f${index}.md`] = `# Документ ${index}\n\n${Array.from({ length: 22 }, () => paragraph).join("\n\n")}\n`;
    const section = (index: number) => `## Раздел ${index}\n\nАбзац ${index} с **жирным** и [ссылкой](https://example.com/${index}) — ${paragraph}`;
    const sized = (bytes: number) => { let text = ""; for (let index = 0; Buffer.byteLength(text) < bytes; index++) text += `${section(index)}\n\n`; return text; };
    // Tests shrink the large documents; the real check measures 200 KiB and 1 MiB.
    const scale = Number(process.env.DOCUMENT_REVIEW_CHECK_H7_SCALE) || 1;
    files["docs/kib200.md"] = sized(200 * 1024 * scale);
    files["docs/mib1.md"] = sized(1024 * 1024 * scale);
    const repo = await scratch(work, "h7", files);
    const dataDir = path.join(work, "h7-data");
    const cold = () => { clearParsedObjects(); clearChunkCache(); clearViewCaches(); };
    const time = async (run: () => Promise<unknown>) => { const t0 = performance.now(); await run(); return Math.round(performance.now() - t0); };
    const results: Record<string, number> = {};
    for (const variant of ["no host cache", "host cache"] as const) {
      if (variant === "no host cache") { await fs.rm(path.join(dataDir, "cache"), { recursive: true, force: true }); await fs.rm(path.join(dataDir, "chunks"), { recursive: true, force: true }); }
      cold();
      const service = new ReviewService(repo.dir, dataDir);
      results[`${variant}: first tree`] = await time(() => documentTree(service));
      results[`${variant}: 200 KiB first view`] = await time(() => documentView(service, "docs/kib200.md"));
      results[`${variant}: 200 KiB warm view`] = await time(() => documentView(service, "docs/kib200.md"));
      results[`${variant}: 1 MiB first view`] = await time(() => documentView(service, "docs/mib1.md"));
      results[`${variant}: tree again`] = await time(() => documentTree(service));
      // Let background writes of parsed parts finish before the next variant.
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const service = new ReviewService(repo.dir, dataDir);
    await repo.write("docs/kib200.md", `${files["docs/kib200.md"]}\nСохранение: новый абзац.\n`);
    results["reaction to a save (200 KiB view with the unread edit)"] = await time(async () => {
      service.invalidate();
      const view = await documentView(service, "docs/kib200.md");
      input.assert(view.unread === 1, `the saved edit is unread (${view.unread})`);
    });
    const line = Object.entries(results).map(([name, ms]) => `${name} ${ms} ms`).join("; ");
    measurements["W-05 H7 (targets: tree ≤2000, 200 KiB warm ≤300, cold ≤1500, save ≤2000 ms)"] = line;
    const misses = [
      results["host cache: first tree"] > 2000 && "tree after restart",
      results["host cache: 200 KiB warm view"] > 300 && "200 KiB warm",
      results["host cache: 200 KiB first view"] > 1500 && "200 KiB cold",
      results["reaction to a save (200 KiB view with the unread edit)"] > 2000 && "save",
    ].filter(Boolean);
    return misses.length ? `over target on this machine: ${misses.join(", ")} — ${line}` : `within H7 targets with the host cache — ${line}`;
  });
}
