// EP-048-T01/T02 (W-06c, file-types.md §9): local review of files outside Git — a store under the plugin's data
// directory per checkout and reader, the same journal and rules; “Track locally” for a file and a folder
// (bases recorded, new files in a tracked folder follow), reading, marks and annotations from the local journal;
// nothing in .bb-docs or the repository; another reader sees nothing; switching off keeps the data.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clearContentCache } from "../node/content.ts";
import { isTrackedLocally, localFor, localForget, localList, serviceForAnnotation, serviceForPath, trackLocally } from "../node/local.ts";
import { documentTree } from "../node/tree.ts";
import { ReviewService } from "../node/service.ts";
import { documentView } from "../node/view.ts";

async function repo() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-local-")));
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Owner");
  git("config", "user.email", "owner@bb-docs.invalid");
  const write = async (file, text) => { await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await fs.writeFile(path.join(dir, file), text); };
  await write(".gitignore", ".env\nscratch/\n");
  await write("docs/a.md", "# A\n\nТекст.\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  await write(".env", "API_TOKEN=tok_local_secret_value_000\nMODE=dev\n");
  await write("scratch/notes.md", "# Заметки\n\nПервый абзац.\n");
  await write("scratch/plan.yaml", "step: 1\n");
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-local-data-"));
  const service = new ReviewService(dir, data);
  await service.enable({ roots: ["."] });
  git("add", "-A");
  git("commit", "-q", "-m", "enable");
  return { dir, data, git, write, service, cleanup: () => Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]) };
}
const listFiles = async (dir) => (await fs.readdir(dir, { recursive: true })).map(String);

test("EP-048-T01/T02 local store, switching on for a file and a folder, marks and annotations from the local journal, nothing in .bb-docs", async () => {
  const r = await repo();
  try {
    const bbDocsBefore = await listFiles(path.join(r.dir, ".bb-docs"));
    assert.equal(await isTrackedLocally(r.service, ".env"), false);
    await assert.rejects(r.service.annotate({ path: ".env", observation: { sha: "0".repeat(64) }, text: "x", kind: "note", targetKind: "document" }), (error) => error.code === "outside-git");
    const env = await trackLocally(r.service, { path: ".env", isDir: false, action: "add" });
    assert.equal(env.registered, 1);
    const folder = await trackLocally(r.service, { path: "scratch", isDir: true, action: "add" });
    assert.equal(folder.registered, 2);
    await assert.rejects(trackLocally(r.service, { path: "docs/a.md", isDir: false, action: "add" }), (error) => error.code === "not-outside");
    assert.equal(await isTrackedLocally(r.service, "scratch/notes.md"), true);
    const local = await localFor(r.service);
    assert.equal(local.scope, "local");
    assert.ok((await fs.stat(path.join(r.data, "local-review"))).isDirectory(), "the store is under the plugin's data directory");
    // A change after switching on is unread; an annotation and «Mark read» go to the local journal.
    await r.write("scratch/notes.md", "# Заметки\n\nПервый абзац, исправленный.\n");
    r.service.invalidate(); local.invalidate();
    const served = await serviceForPath(r.service, "scratch/notes.md");
    assert.equal(served, local);
    const view = await documentView(served, "scratch/notes.md");
    assert.equal(view.context.writable, true);
    assert.ok(view.blocks.some((block) => block.read === "unread"), "the edit after switching on is unread");
    const annotation = await served.annotate({ path: "scratch/notes.md", observation: { sha: view.document.sha }, text: "Уточнить", kind: "action", targetKind: "block", block: 1 });
    assert.equal(await serviceForAnnotation(r.service, annotation.annotationId), local);
    await served.acknowledge({ path: "scratch/notes.md", observation: { sha: view.document.sha }, scope: "document" });
    const after = await documentView(served, "scratch/notes.md");
    assert.equal(after.unread, 0);
    assert.equal(after.annotations.length, 1);
    // .env tracked locally: masks as everywhere, the value nowhere in the local store.
    const envView = await documentView(await serviceForPath(r.service, ".env"), ".env");
    assert.ok(envView.secrets.length >= 1);
    for (const file of await listFiles(path.join(r.data, "local-review"))) {
      const full = path.join(r.data, "local-review", file);
      if ((await fs.stat(full)).isFile()) assert.ok(!(await fs.readFile(full, "utf8")).includes("tok_local_secret_value_000"), `no secret value in ${file}`);
    }
    // The tree: tracked local files carry their state from the local journal; untracked outside files — none.
    await r.write("scratch/plan.yaml", "step: 2\n");
    r.service.invalidate(); local.invalidate();
    const tree = await documentTree(r.service, { budgetMs: 30_000 });
    const plan = tree.entries.find((entry) => entry.path === "scratch/plan.yaml");
    assert.equal(plan.local, true);
    assert.equal(plan.state, "unread");
    assert.equal(tree.entries.find((entry) => entry.path === "scratch/notes.md").open, 1);
    assert.deepEqual(tree.localRules.roots.sort(), [".env", "scratch"]);
    // A tracked file that is gone: a virtual entry of the local review, its data kept.
    await fs.rm(path.join(r.dir, "scratch/plan.yaml"));
    r.service.invalidate(); local.invalidate();
    const gone = await documentTree(r.service, { budgetMs: 30_000 });
    assert.ok(gone.virtual.some((entry) => entry.path === "scratch/plan.yaml" && entry.local), "«удалён отслеживаемый файл»");
    // Forget file removes its events, objects and snapshots while leaving other local review data intact.
    const forgotten = await localForget(r.service, { path: "scratch/plan.yaml" });
    assert.ok(forgotten.events >= 1 && forgotten.files >= 1, JSON.stringify(forgotten));
    assert.ok(!(await localList(r.service)).documents.some((doc) => doc.path === "scratch/plan.yaml"));
    assert.ok((await localList(r.service)).documents.some((doc) => doc.path === "scratch/notes.md"));
    assert.equal((await local.validate()).ok, true, "the local journal stays valid");
    // Nothing in the repository: .bb-docs unchanged, git status clean.
    assert.deepEqual(await listFiles(path.join(r.dir, ".bb-docs")), bbDocsBefore);
    assert.equal(r.git("status", "--porcelain"), "");
    // Another reader on the same machine: their own store, nothing seen.
    const ownStore = (await localList(r.service)).store;
    r.git("config", "user.email", "other@bb-docs.invalid");
    const other = new ReviewService(r.dir, r.data);
    clearContentCache();
    assert.equal(await isTrackedLocally(other, "scratch/notes.md"), false);
    assert.notEqual((await localList(other)).store, ownStore);
    r.git("config", "user.email", "owner@bb-docs.invalid");
    // Switching off keeps the data.
    await trackLocally(r.service, { path: "scratch", isDir: true, action: "remove" });
    r.service.invalidate();
    assert.equal(await isTrackedLocally(r.service, "scratch/notes.md"), false);
    const listed = await localList(r.service);
    assert.ok(listed.documents.some((doc) => doc.path === "scratch/notes.md"), "data kept after switching off");
  } finally {
    await r.cleanup();
  }
});

test("EP-048-T01 a crash at every write step of the local journal recovers: validate OK, the write repeats once", async () => {
  const { injectCrash, isCrash } = await import("../node/check-w05.ts");
  const { localStoreDir } = await import("../node/local.ts");
  let points = 0;
  for (let crashAt = 0; crashAt < 8; crashAt++) {
    for (const when of ["before", "after"]) {
      const r = await repo();
      try {
        await trackLocally(r.service, { path: "scratch", isDir: true, action: "add" });
        const local = await localFor(r.service);
        const view = await documentView(local, "scratch/notes.md");
        const storeDir = localStoreDir(r.data, (await r.service.config()).value.repoId, r.dir, "owner@bb-docs.invalid");
        const fresh = () => new ReviewService(r.dir, r.data, { storeDir, key: "test" });
        const victim = fresh();
        injectCrash(victim, crashAt, when);
        const write = (service) => service.annotate({ path: "scratch/notes.md", observation: { sha: view.document.sha }, text: "Проверь", kind: "action", targetKind: "block", block: 1 });
        let crashed = false;
        await write(victim).catch((error) => { if (!isCrash(error)) throw error; crashed = true; });
        if (!crashed) continue;
        points++;
        const restarted = fresh();
        const report = await restarted.validate(5);
        assert.ok(report.problems.every((problem) => problem.severity !== "error"), `crash ${crashAt} ${when}: ${JSON.stringify(report.problems.slice(0, 2))}`);
        await write(restarted);
        const annotations = (await documentView(restarted, "scratch/notes.md")).annotations.length;
        assert.ok(annotations >= 1 && annotations <= 2, `crash ${crashAt} ${when}: ${annotations}`);
        assert.equal(r.git("status", "--porcelain"), "", "nothing in the repository after the crash either");
      } finally {
        await r.cleanup();
      }
    }
  }
  assert.ok(points >= 4, `crash points exercised: ${points}`);
});

test("EP-048-T02 a new file in a tracked folder follows; switching off and on again keeps the data; receipts DR-02 locally", async () => {
  const r = await repo();
  try {
    await trackLocally(r.service, { path: "scratch", isDir: true, action: "add" });
    await r.write("scratch/new.txt", "новый файл\n");
    r.service.invalidate();
    assert.equal(await isTrackedLocally(r.service, "scratch/new.txt"), true, "a folder rule tracks new files outside Git inside it");
    const tree = await documentTree(r.service, { budgetMs: 30_000 });
    assert.equal(tree.entries.find((entry) => entry.path === "scratch/new.txt").state, "new");
    const local = await localFor(r.service);
    const view = await documentView(local, "scratch/notes.md");
    const receipt = await local.acknowledge({ path: "scratch/notes.md", observation: { sha: view.document.sha }, scope: "document" });
    assert.ok(receipt.receiptId);
    await trackLocally(r.service, { path: "scratch", isDir: true, action: "remove" });
    r.service.invalidate();
    assert.equal(await isTrackedLocally(r.service, "scratch/notes.md"), false);
    await trackLocally(r.service, { path: "scratch", isDir: true, action: "add" });
    r.service.invalidate(); local.invalidate();
    const again = await documentView(await serviceForPath(r.service, "scratch/notes.md"), "scratch/notes.md");
    assert.equal(again.unread, 0, "the receipt survives switching off and on");
    // A receipt is revoked like any other (DR-02): the base goes back, nothing is lost.
    await local.revoke({ receiptId: receipt.receiptId });
    local.invalidate();
    assert.equal((await local.validate()).ok, true);
    assert.equal(r.git("status", "--porcelain"), "");
  } finally {
    await r.cleanup();
  }
});

test("EP-048-T03 scenarios of §9: rename by proposal, branch switch, two worktrees, moved and deleted checkout, retention with a fake clock", async () => {
  const { bindStore, cleanupLocal, localRulesForMove, missingCheckouts, serviceForDoc } = await import("../node/local.ts");
  const { resolveMove } = await import("../node/catalog.ts");
  const { updateUserSettings } = await import("../node/user-settings.ts");
  const r = await repo();
  const extra = [];
  try {
    await trackLocally(r.service, { path: "scratch/notes.md", isDir: false, action: "add" });
    const local = await localFor(r.service);
    const docId = (await localList(r.service)).documents.find((doc) => doc.path === "scratch/notes.md").docId;
    // A manually renamed tracked file is missing at the old path; propose identical bytes elsewhere first.
    await fs.rename(path.join(r.dir, "scratch/notes.md"), path.join(r.dir, "scratch/renamed.md"));
    r.service.invalidate(); local.invalidate();
    const tree = await documentTree(r.service, { budgetMs: 30_000 });
    assert.ok(tree.virtual.some((entry) => entry.path === "scratch/notes.md" && entry.local));
    const proposal = tree.moves.proposals.find((entry) => entry.local && entry.from === "scratch/notes.md");
    assert.equal(proposal?.candidates[0].path, "scratch/renamed.md", "«Это переименование…» proposes the same content first");
    const owner = await serviceForDoc(r.service, docId);
    assert.equal(owner, local);
    await localRulesForMove(owner, "scratch/notes.md", "scratch/renamed.md");
    await resolveMove(owner, { docId, to: "scratch/renamed.md" });
    r.service.invalidate(); local.invalidate();
    assert.equal(await isTrackedLocally(r.service, "scratch/renamed.md"), true, "the data moved with the file");
    // Branch switch: in a branch where the file is not ignored and not in the index it stays local (§4).
    await r.write(".gitignore", ".env\n");
    r.git("add", ".gitignore");
    r.git("commit", "-q", "-m", "scratch is not ignored here");
    r.service.invalidate(); local.invalidate();
    assert.equal(await r.service.fileClass("scratch/renamed.md"), "new");
    assert.equal(await isTrackedLocally(r.service, "scratch/renamed.md"), true, "sticky local mode");
    assert.equal(await serviceForPath(r.service, "scratch/renamed.md"), local);
    assert.equal(await isTrackedLocally(r.service, "scratch/plan.yaml"), false, "a new file without local data is the shared review's");
    // Two worktrees: separate local data (the key is the checkout path).
    const tree2 = await fs.realpath(path.dirname(r.dir)) + `/wt-${path.basename(r.dir)}`;
    r.git("worktree", "add", "-q", tree2);
    extra.push(tree2);
    const other = new ReviewService(tree2, r.data);
    assert.equal((await localList(other)).rules, null, "the second worktree has no local data");
    assert.notEqual((await localList(other)).store, (await localList(r.service)).store);
    r.git("worktree", "remove", "--force", tree2);
    // A moved checkout leaves a missing store; Attach adopts it at the new location.
    const moved = `${r.dir}-moved`;
    await fs.rename(r.dir, moved);
    extra.push(moved);
    const atNew = new ReviewService(await fs.realpath(moved), r.data);
    const missing = await missingCheckouts(atNew);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].root, r.dir);
    await bindStore(atNew, { storeDir: missing[0].storeDir });
    assert.ok((await localList(atNew)).documents.some((doc) => doc.path === "scratch/renamed.md"), "bound: the data is here");
    assert.equal((await missingCheckouts(atNew)).length, 0);
    // Retention: a gone tracked file is removed after N days (fake clock); a deleted checkout's store too.
    await fs.rename(moved, r.dir);
    const back = new ReviewService(r.dir, r.data);
    await bindStore(back, { storeDir: (await missingCheckouts(back))[0].storeDir });
    await updateUserSettings(r.data, "owner@bb-docs.invalid", (settings) => { settings.retentionDays = 30; });
    await fs.rm(path.join(r.dir, "scratch/renamed.md"));
    back.invalidate();
    const first = await cleanupLocal(back, { now: Date.now() });
    assert.deepEqual(first.forgotten, [], "not yet: the first sight is recorded");
    const later = await cleanupLocal(back, { now: Date.now() + 31 * 86_400_000 });
    assert.deepEqual(later.forgotten, ["scratch/renamed.md"]);
    assert.ok(!(await localList(back)).documents.some((doc) => doc.path === "scratch/renamed.md"));
    // scratch/ is not ignored in this branch any more (the scenario above): only it is untracked, nothing of review.
    assert.ok(!r.git("status", "--porcelain").includes(".bb-docs"));
  } finally {
    for (const dir of extra) await fs.rm(dir, { recursive: true, force: true });
    await r.cleanup();
  }
});

test("EP-048-T04 batches of local files: a batch of its own in the local store, answers and «Принять», one DR-01 queue with shared batches, no secret in the package", async () => {
  const { prepareAny, serviceForRun } = await import("../node/local.ts");
  const { accept, batchGet, finishBatch, itemReply, markDispatched } = await import("../node/batches.ts");
  const r = await repo();
  try {
    const bbDocsBefore = await listFiles(path.join(r.dir, ".bb-docs"));
    await trackLocally(r.service, { path: ".env", isDir: false, action: "add" });
    await trackLocally(r.service, { path: "scratch", isDir: true, action: "add" });
    const local = await localFor(r.service);
    const notes = await documentView(local, "scratch/notes.md");
    const annotation = await local.annotate({ path: "scratch/notes.md", observation: { sha: notes.document.sha }, text: "Добавь второй абзац", kind: "action", targetKind: "block", block: 1 });
    const env = await documentView(local, ".env");
    await local.annotate({ path: ".env", observation: { sha: env.document.sha }, text: "Поясни MODE", kind: "action", targetKind: "block", block: 1 });
    // A shared batch in thread A holds the checkout: a local batch for thread B waits (one DR-01 queue).
    const shown = await documentView(r.service, "docs/a.md");
    await r.service.annotate({ path: "docs/a.md", observation: { sha: shown.document.sha }, text: "Общее", kind: "action", targetKind: "block", block: 1 });
    const sharedRun = await prepareAny(r.service, { scope: { kind: "document", path: "docs/a.md" }, recipient: { mode: "current-thread", threadId: "thr_A" } });
    assert.equal(sharedRun.local, false);
    await markDispatched(r.service, { runId: sharedRun.runId, attemptId: sharedRun.attemptId, recipient: { mode: "current-thread", threadId: "thr_A" }, delivery: "sent" });
    await assert.rejects(prepareAny(r.service, { scope: { kind: "document", path: "scratch/notes.md" }, recipient: { mode: "current-thread", threadId: "thr_B" } }), (error) => error.code === "busy");
    await finishBatch(r.service, { runId: sharedRun.runId, agent: { model: "test", threadId: "thr_A" } });
    // «All documents»: the unanswered shared item comes back — a shared batch, and the local items follow as a batch of
    // their own for the same thread (two batches in a row).
    const both = await prepareAny(r.service, { scope: { kind: "all" }, recipient: { mode: "current-thread", threadId: "thr_A" } });
    assert.equal(both.local, false);
    const prepared = both.next;
    assert.equal(prepared.local, true);
    assert.equal(prepared.items, 2);
    await markDispatched(r.service, { runId: both.runId, attemptId: both.attemptId, recipient: { mode: "current-thread", threadId: "thr_A" }, delivery: "sent" });
    assert.equal(await serviceForRun(r.service, prepared.runId), local);
    await markDispatched(local, { runId: prepared.runId, attemptId: prepared.attemptId, recipient: { mode: "current-thread", threadId: "thr_A" }, delivery: "sent" });
    const batch = await batchGet(local, { runId: prepared.runId, threadId: "thr_A" });
    assert.ok(!JSON.stringify(batch).includes("tok_local_secret_value_000"), "no secret value in the package");
    assert.ok(batch.items.some((item) => item.lines), "a line-based file names its lines");
    await r.write("scratch/notes.md", "# Заметки\n\nПервый абзац.\n\nВторой абзац.\n");
    r.service.invalidate(); local.invalidate();
    const item = batch.items.find((entry) => entry.annotationId === annotation.annotationId);
    await itemReply(local, { runId: prepared.runId, itemId: item.itemId, responseId: "r1", status: "done", text: "Добавил", edits: [{ path: "scratch/notes.md", quote: "Второй абзац." }], agent: { model: "test", threadId: "thr_A" } });
    const finished = await finishBatch(local, { runId: prepared.runId, agent: { model: "test", threadId: "thr_A" } });
    assert.equal(finished.outcome, "partial", "the .env item was not answered");
    const after = await documentView(local, "scratch/notes.md");
    const shownAnnotation = after.annotations.find((entry) => entry.annotationId === annotation.annotationId);
    await accept(local, { annotationId: annotation.annotationId, expectedHeads: shownAnnotation.heads, resultEventId: shownAnnotation.latest.eventId, path: "scratch/notes.md", observation: { sha: after.document.sha }, blocks: shownAnnotation.latest.linked.map((entry) => entry.block) });
    assert.equal((await documentView(local, "scratch/notes.md")).annotations.find((entry) => entry.annotationId === annotation.annotationId).status, "closed");
    // .bb-docs knows nothing of the local batch (only the shared batch above was written there).
    const added = (await listFiles(path.join(r.dir, ".bb-docs"))).filter((file) => !bbDocsBefore.includes(file));
    for (const file of added) {
      const full = path.join(r.dir, ".bb-docs", file);
      if ((await fs.stat(full)).isFile()) assert.ok(!(await fs.readFile(full, "utf8")).includes(prepared.runId), `local run ${prepared.runId} not in ${file}`);
    }
    assert.equal((await local.validate()).ok, true);
  } finally {
    await r.cleanup();
  }
});
