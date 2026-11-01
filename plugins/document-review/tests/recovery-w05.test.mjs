// EP-014-T01: a crash at every write step of every W-03/W-04 write command, then a host restart (a new service on the
// same checkout and plugin data). Confirmed data is never lost, nothing is half-referenced, no second executor
// appears, and repeating the command (or the next catalog command) finishes it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discussion } from "../core/discussion.ts";
import { runsOf, unfinishedRuns } from "../core/batch.ts";
import { abandonRun, accept, batchGet, batchStatus, finishBatch, itemReply, markDispatched, prepareBatch } from "../node/batches.ts";
import { acknowledgeDeletion, resolveMove, setRule, treeWithMoves } from "../node/catalog.ts";
import { ReviewService } from "../node/service.ts";
import { documentView } from "../node/view.ts";

const DOC = "# Обзор\n\nПервый абзац для замечаний.\n\nВторой абзац.\n";
const agentA = { model: "claude-opus-5-5", threadId: "thr_crash" };

async function template(files = { "docs/a.md": DOC, "docs/b.md": "# B\n\nДругой.\n" }) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-crash-")));
  const dir = path.join(base, "repo");
  await fs.mkdir(dir);
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
  const data = path.join(base, "data");
  const service = new ReviewService(dir, data);
  await service.enable({});
  let copies = 0;
  return {
    base, dir, data, service,
    /** A copy of the checkout and the plugin data: one independent run of a crash scenario. */
    async fork() {
      const target = path.join(base, `fork-${++copies}`);
      await fs.cp(dir, path.join(target, "repo"), { recursive: true });
      await fs.cp(data, path.join(target, "data"), { recursive: true }).catch(() => undefined);
      const root = path.join(target, "repo");
      return { root, data: path.join(target, "data"), service: new ReviewService(root, path.join(target, "data")), write: (file, text) => fs.writeFile(path.join(root, file), text) };
    },
    cleanup: () => fs.rm(base, { recursive: true, force: true }),
  };
}

class Crash extends Error {
  constructor(step) {
    super(`injected crash at step ${step}`);
    this.code = "crash";
  }
}

/**
 * Make every mutating step of the service fail at `crashAt`: `before` loses the write, `after` performs it and then
 * dies (like a process killed right after rename/link). Steps: .bb-docs files, config CAS, launch and intent records.
 */
function inject(service, crashAt, when) {
  let steps = 0;
  const wrap = (object, name) => {
    const original = object[name].bind(object);
    object[name] = async (...args) => {
      const index = steps++;
      if (index === crashAt && when === "before") throw new Crash(index);
      const result = await original(...args);
      if (index === crashAt && when === "after") throw new Crash(index);
      return result;
    };
  };
  wrap(service.store, "createExclusive");
  wrap(service.store, "replace");
  wrap(service.launch, "put");
  wrap(service.intents, "put");
  wrap(service.intents, "clear");
  return { steps: () => steps };
}

/** Run `operation` with a crash at every step until one run completes without reaching the crash point. */
async function everyStep(t, prepare, operation, verify) {
  let total = 0;
  for (let crashAt = 0; ; crashAt++) {
    let finished = true;
    for (const when of ["before", "after"]) {
      const fork = await t.fork();
      const context = await prepare(fork);
      const counter = inject(fork.service, crashAt, when);
      let crashed = false;
      try {
        await operation(fork.service, context);
      } catch (error) {
        if (error?.code !== "crash") throw error;
        crashed = true;
      }
      if (!crashed) {
        finished = finished && true;
        continue;
      }
      finished = false;
      total++;
      // Restart: a new service on the same checkout and plugin data; no runtime state survives.
      const restarted = new ReviewService(fork.root, fork.data);
      const report = await restarted.validate();
      assert.equal(report.problems.filter((problem) => problem.severity === "error").length, 0, `no damaged or dangling data after a crash at step ${crashAt} ${when}: ${JSON.stringify(report.problems.slice(0, 2))}`);
      await verify(restarted, context, { crashAt, when, fork });
      void counter;
    }
    if (finished) return total;
  }
}

async function annotate(service, docPath, needle, text = "Перепиши") {
  const view = await documentView(service, docPath);
  const plain = view.blocks.map((block) => block.text).join("\n\n");
  const at = plain.indexOf(needle);
  const start = [...plain.slice(0, at)].length;
  return service.annotate({ path: docPath, observation: { sha: view.document.sha }, kind: "action", text, range: { start, end: start + [...needle].length }, quote: needle });
}

test("AC11: crash at every step of the agent's answer — after restart the same answer completes once, nothing is lost", async () => {
  const t = await template();
  try {
    const created = await annotate(t.service, "docs/a.md", "Первый абзац");
    const prepared = await prepareBatch(t.service, { scope: { kind: "all" }, recipient: { mode: "current-thread", threadId: "thr_crash" } });
    await markDispatched(t.service, { runId: prepared.runId, attemptId: prepared.attemptId, recipient: { mode: "current-thread", threadId: "thr_crash" }, delivery: "sent" });
    const { items } = await batchGet(t.service, { runId: prepared.runId, threadId: "thr_crash" });
    const answer = (service) => itemReply(service, { runId: prepared.runId, itemId: items[0].itemId, responseId: "answer-1", status: "done", text: "Переписал первый абзац.",
      edits: [{ path: "docs/a.md", quote: "Переписанный первый абзац" }], agent: agentA });
    const crashes = await everyStep(t, async (fork) => {
      await fork.write("docs/a.md", DOC.replace("Первый абзац", "Переписанный первый абзац"));
      return {};
    }, answer, async (restarted) => {
      const before = runsOf(await restarted.state()).find((run) => run.runId === prepared.runId);
      assert.ok(before.results.length <= 1, "at most the one confirmed answer");
      const retried = await answer(restarted);
      assert.ok(["recorded", "duplicate"].includes(retried.status));
      const after = runsOf(await restarted.state()).find((run) => run.runId === prepared.runId);
      assert.equal(after.results.length, 1, "exactly one result after the retry: no lost and no duplicated answer");
      assert.equal(discussion(await restarted.state(), created.annotationId).messages.filter((message) => message.role === "agent").length, 1);
      assert.equal(unfinishedRuns(await restarted.state()).length, 1, "the run is still the only executor");
    });
    assert.ok(crashes >= 4, `crash points exercised: ${crashes}`);
  } finally {
    await t.cleanup();
  }
});

test("AC11: crash at every step of preparing a batch — the checkout stays held, no second executor, explicit recovery releases it", async () => {
  const t = await template();
  try {
    await annotate(t.service, "docs/a.md", "Первый абзац");
    const send = (service) => prepareBatch(service, { scope: { kind: "all" }, recipient: { mode: "new-thread", threadId: null } });
    const crashes = await everyStep(t, async () => ({}), send, async (restarted) => {
      const state = await restarted.state();
      const launch = await restarted.launch.get();
      const unfinished = unfinishedRuns(state);
      // Either nothing happened at all, or the checkout is held by the journal or by the launch record.
      if (!launch && !unfinished.length) {
        const again = await send(restarted);
        assert.equal(again.items, 1);
        return;
      }
      await assert.rejects(send(restarted), (error) => error.code === "busy", "no second batch while the first is unresolved (DR-01)");
      const status = await batchStatus(restarted);
      const runId = status.active?.runId ?? status.launch?.runId;
      assert.ok(runId, "the held run is visible to the user");
      await abandonRun(restarted, { runId, outcome: "cancelled", reason: "recovery after restart" }).catch((error) => assert.equal(error.code, "not-found"));
      assert.equal(await restarted.launch.get(), null, "recovery released the checkout");
      assert.equal(unfinishedRuns(await restarted.state()).length, 0);
      const again = await send(restarted);
      assert.equal(again.items, 1, "the instruction is sent again by the user's explicit action, once");
    });
    assert.ok(crashes >= 3, `crash points exercised: ${crashes}`);
  } finally {
    await t.cleanup();
  }
});

test("AC11: crash at every step of finishing a round and of «Принять»; retry finishes once", async () => {
  const t = await template();
  try {
    const created = await annotate(t.service, "docs/a.md", "Первый абзац");
    const prepared = await prepareBatch(t.service, { scope: { kind: "all" }, recipient: { mode: "current-thread", threadId: "thr_crash" } });
    await markDispatched(t.service, { runId: prepared.runId, attemptId: prepared.attemptId, recipient: { mode: "current-thread", threadId: "thr_crash" }, delivery: "sent" });
    const { items } = await batchGet(t.service, { runId: prepared.runId, threadId: "thr_crash" });
    await fs.writeFile(path.join(t.dir, "docs/a.md"), DOC.replace("Первый абзац", "Новый первый абзац"));
    await itemReply(t.service, { runId: prepared.runId, itemId: items[0].itemId, responseId: "r", status: "done", text: "Готово", edits: [{ path: "docs/a.md", quote: "Новый первый абзац" }], agent: agentA });

    const finish = (service) => finishBatch(service, { runId: prepared.runId, agent: agentA });
    await everyStep(t, async () => ({}), finish, async (restarted) => {
      const retried = await finish(restarted);
      assert.ok(["finished", "already-finished"].includes(retried.status));
      const runs = runsOf(await restarted.state()).filter((run) => run.runId === prepared.runId);
      assert.equal(runs[0].finished.outcome, "completed");
      assert.equal((await batchStatus(restarted)).launch, null, "the checkout is released");
    });

    await finish(t.service);
    const shown = await documentView(t.service, "docs/a.md");
    const card = shown.annotations.find((annotation) => annotation.annotationId === created.annotationId);
    const take = (service) => accept(service, { annotationId: created.annotationId, expectedHeads: card.heads, resultEventId: card.latest.eventId, path: "docs/a.md",
      observation: { sha: shown.document.sha }, blocks: card.latest.linked.map((entry) => entry.block) });
    await everyStep(t, async () => ({}), take, async (restarted) => {
      const state = await restarted.state();
      if (discussion(state, created.annotationId).status !== "closed") await take(restarted);
      const view = await documentView(restarted, "docs/a.md");
      assert.equal(view.annotations.find((annotation) => annotation.annotationId === created.annotationId).status, "closed");
      assert.equal(view.blocks.find((block) => block.text.startsWith("Новый первый")).read, "read", "the linked edit is confirmed together with the close (one operation)");
    });
  } finally {
    await t.cleanup();
  }
});

test("A7: crash between config.json and tracking-resumed keeps the rule, never marks the pause read; the next catalog command finishes it", async () => {
  const t = await template();
  try {
    await setRule(t.service, { list: "untracked", path: "docs/a.md", isDir: false, action: "add" });
    const resume = (service) => setRule(service, { list: "untracked", path: "docs/a.md", isDir: false, action: "remove" });
    const crashes = await everyStep(t, async (fork) => {
      // An edit made during the pause.
      await fork.write("docs/a.md", DOC.replace("Второй абзац.", "Второй абзац, правка во время паузы."));
      return {};
    }, resume, async (restarted, _context, { crashAt, when }) => {
      const config = (await restarted.config()).value;
      const tracked = !config.untracked.length;
      const view = await documentView(restarted, "docs/a.md");
      const paused = view.blocks.find((block) => block.text.includes("во время паузы"));
      if (tracked && !view.document.trackingResumed) {
        // The rule landed, the base did not (yet): the pause is visible as unread, never claimed as read.
        assert.equal(paused.read, "unread", `pause shown as unread at step ${crashAt} ${when}`);
      }
      // The next catalog command (the tree or another rule) finishes the interrupted resume.
      await treeWithMoves(restarted);
      const again = await resume(restarted);
      assert.ok(["unchanged", "published"].includes(again.status));
      const finalView = await documentView(restarted, "docs/a.md");
      assert.deepEqual((await restarted.config()).value.untracked, [], "the rule is not lost");
      assert.ok(finalView.document.trackingResumed, `the resumed base is recorded at step ${crashAt} ${when}`);
      assert.equal(finalView.blocks.find((block) => block.text.includes("во время паузы")).read, "read", "the current revision is the new base");
      assert.equal(await restarted.intents.get(), null, "the intent is cleared");
    });
    assert.ok(crashes >= 4, `crash points exercised: ${crashes}`);
  } finally {
    await t.cleanup();
  }
});

test("rename and deletion: a crash leaves either the old or the new state; the retry completes it", async () => {
  const t = await template({ "docs/a.md": DOC, "docs/one.md": "# One\n\nабзац один\n\nабзац два\n" });
  try {
    const before = await documentView(t.service, "docs/one.md");
    const docId = before.document.docId;
    await fs.rm(path.join(t.dir, "docs/one.md"));
    await fs.writeFile(path.join(t.dir, "docs/two.md"), "# One\n\nабзац один\n\nабзац два изменён\n");
    await everyStep(t, async () => ({}), (service) => resolveMove(service, { docId, to: "docs/two.md" }), async (restarted) => {
      const state = await restarted.state();
      if (state.documents.get(docId).path !== "docs/two.md") await resolveMove(restarted, { docId, to: "docs/two.md" });
      assert.equal((await restarted.state()).documents.get(docId).path, "docs/two.md");
    });
    await fs.rm(path.join(t.dir, "docs/two.md"));
    await everyStep(t, async () => ({}), (service) => acknowledgeDeletion(service, { docId }), async (restarted) => {
      await acknowledgeDeletion(restarted, { docId });
      const view = await documentView(restarted, "docs/one.md");
      assert.equal(view.document.deletionUnread, false);
    });
  } finally {
    await t.cleanup();
  }
});

test("host restart in the middle of a batch: the launch record and the journal are reconciled, the agent's answer proves delivery", async () => {
  const t = await template();
  try {
    await annotate(t.service, "docs/a.md", "Первый абзац");
    const prepared = await prepareBatch(t.service, { scope: { kind: "all" }, recipient: { mode: "new-thread", threadId: null } });
    // The host dies while bb creates the thread: the spawn outcome is unknown; after restart nothing is retried.
    const restarted = new ReviewService(t.dir, t.data);
    const status = await batchStatus(restarted);
    assert.equal(status.launch.state, "dispatching");
    assert.equal(status.active.runId, prepared.runId);
    await assert.rejects(prepareBatch(restarted, { scope: { kind: "all" }, recipient: { mode: "new-thread", threadId: null } }), (error) => error.code === "busy");
    // The agent of the new thread answers: delivery is proven and recorded first, there is still one run.
    const { items } = await batchGet(restarted, { runId: prepared.runId, threadId: "thr_new" });
    await itemReply(restarted, { runId: prepared.runId, itemId: items[0].itemId, responseId: "x", status: "done", text: "Сделано", agent: { model: "m", threadId: "thr_new" } });
    const state = await restarted.state();
    const run = runsOf(state).find((entry) => entry.runId === prepared.runId);
    assert.deepEqual(run.attempts.map((attempt) => attempt.threadId), ["thr_new"]);
    assert.equal((await restarted.launch.get()).state, "sent");
    // Losing the plugin data entirely never hides the unfinished run: the journal still holds the checkout.
    await fs.rm(t.data, { recursive: true, force: true });
    const blank = new ReviewService(t.dir, t.data);
    await assert.rejects(prepareBatch(blank, { scope: { kind: "all" }, recipient: { mode: "new-thread", threadId: null } }), (error) => error.code === "busy");
    const finished = await finishBatch(blank, { runId: prepared.runId, agent: { model: "m", threadId: "thr_new" } });
    assert.equal(finished.outcome, "completed");
  } finally {
    await t.cleanup();
  }
});
