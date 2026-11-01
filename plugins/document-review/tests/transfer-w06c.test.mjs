// Review data moves between the local store
// and .bb-docs when a file's Git status changes — the list of what becomes shared first; both directions; a failure at
// every step and a repeat lose nothing and duplicate nothing (validate OK in both stores); “Keep local”;
// only this reader's receipts move; no secret value in .bb-docs after the move to Git.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { injectCrash, isCrash } from "../node/check-w05.ts";
import { localFor, serviceForPath, trackLocally } from "../node/local.ts";
import { ReviewService } from "../node/service.ts";
import { keepLocal, transferDocument, transferPreview } from "../node/transfer.ts";
import { documentView } from "../node/view.ts";
import { documentTree } from "../node/tree.ts";

async function repo() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-transfer-")));
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Owner");
  git("config", "user.email", "owner@bb-docs.invalid");
  const write = async (file, text) => { await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await fs.writeFile(path.join(dir, file), text); };
  await write(".gitignore", "notes/\n");
  await write("docs/a.md", "# A\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  await write("notes/plan.yaml", "service:\n  port: 8080\n  password: hunter2hunter2xyz\n");
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-transfer-data-"));
  const service = new ReviewService(dir, data);
  await service.enable({ roots: ["."] });
  git("add", "-A");
  git("commit", "-q", "-m", "enable");
  return { dir, data, git, write, service, cleanup: () => Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]) };
}
const blockOf = (view, text) => view.blocks.findIndex((block) => block.text === text);
const bbDocsHas = async (dir, needle) => {
  for (const file of (await fs.readdir(path.join(dir, ".bb-docs"), { recursive: true })).map(String)) {
    const full = path.join(dir, ".bb-docs", file);
    if ((await fs.stat(full)).isFile() && (await fs.readFile(full, "utf8")).includes(needle)) return true;
  }
  return false;
};

async function localWithData(r) {
  await trackLocally(r.service, { path: "notes/plan.yaml", isDir: false, action: "add" });
  const local = await localFor(r.service);
  const view = await documentView(local, "notes/plan.yaml");
  const annotation = await local.annotate({ path: "notes/plan.yaml", observation: { sha: view.document.sha }, text: "Порт вынести\nв переменную", kind: "action", targetKind: "block", block: blockOf(view, "port: 8080") });
  await local.acknowledge({ path: "notes/plan.yaml", observation: { sha: view.document.sha }, scope: "document" });
  return { local, annotation };
}

test("EP-048-T08 local → Git: the list first, then the move; the local data becomes read-only; no secret value in .bb-docs", async () => {
  const r = await repo();
  try {
    const { local, annotation } = await localWithData(r);
    r.git("add", "-f", "notes/plan.yaml");
    r.git("commit", "-q", "-m", "plan in Git now");
    r.service.invalidate(); local.invalidate();
    assert.equal((await documentTree(r.service, { budgetMs: 30_000 })).entries.find((entry) => entry.path === "notes/plan.yaml").transfer, "to-git", "the offer is in the tree");
    // Back and forth without a confirmation moves nothing.
    r.git("rm", "-q", "--cached", "notes/plan.yaml");
    r.git("commit", "-q", "-m", "out again");
    r.service.invalidate();
    assert.equal((await documentTree(r.service, { budgetMs: 30_000 })).entries.find((entry) => entry.path === "notes/plan.yaml").transfer, undefined);
    r.git("add", "-f", "notes/plan.yaml");
    r.git("commit", "-q", "-m", "in again");
    r.service.invalidate();
    assert.equal((await r.service.state()).documents.size, 1, "nothing moved while the status flipped (only docs/a.md is shared)");
    const preview = await transferPreview(r.service, { path: "notes/plan.yaml", direction: "to-git" });
    assert.deepEqual(preview.annotations.map((entry) => [entry.annotationId, entry.firstLine, entry.author]), [[annotation.annotationId, "Порт вынести", "Owner"]]);
    assert.equal(preview.receipts, 1);
    const moved = await transferDocument(r.service, { path: "notes/plan.yaml", direction: "to-git" });
    assert.equal(moved.annotations, preview.annotations.length, "what was listed is what moved");
    assert.equal(moved.receipts, preview.receipts);
    r.service.invalidate(); local.invalidate();
    assert.equal(await serviceForPath(r.service, "notes/plan.yaml"), r.service);
    const view = await documentView(r.service, "notes/plan.yaml");
    assert.deepEqual(view.annotations.map((entry) => entry.annotationId), [annotation.annotationId], "the same annotation id in the shared review");
    assert.equal(view.unread, 0, "this reader's receipt moved too");
    assert.equal((await r.service.validate()).ok, true);
    assert.equal((await local.validate()).ok, true);
    assert.equal(await bbDocsHas(r.dir, "hunter2hunter2xyz"), false, "no secret value in .bb-docs");
    await assert.rejects(local.annotate({ path: "notes/plan.yaml", observation: { sha: view.document.sha }, text: "x", kind: "note", targetKind: "document" }), (error) => ["transferred", "not-local"].includes(error.code));
    assert.equal((await documentTree(r.service, { budgetMs: 30_000 })).entries.find((entry) => entry.path === "notes/plan.yaml").transfer, undefined, "the offer is gone");
    // A repeat writes nothing.
    const again = await transferDocument(r.service, { path: "notes/plan.yaml", direction: "to-git" });
    assert.equal(again.events, 0);
  } finally {
    await r.cleanup();
  }
});

test("EP-048-T08 a failure at every step of the move and a repeat: no losses, no duplicates, validate OK in both stores", async () => {
  let points = 0;
  for (let crashAt = 0; crashAt < 10; crashAt++) {
    const r = await repo();
    try {
      const { local } = await localWithData(r);
      r.git("add", "-f", "notes/plan.yaml");
      r.git("commit", "-q", "-m", "plan in Git now");
      const victim = new ReviewService(r.dir, r.data);
      injectCrash(victim, crashAt, "after");
      const crashed = await transferDocument(victim, { path: "notes/plan.yaml", direction: "to-git" }).then(() => false, (error) => { if (!isCrash(error)) throw error; return true; });
      if (!crashed) break;
      points++;
      const restarted = new ReviewService(r.dir, r.data);
      assert.equal((await restarted.validate()).problems.filter((problem) => problem.severity === "error").length, 0, `crash ${crashAt}`);
      await transferDocument(restarted, { path: "notes/plan.yaml", direction: "to-git" });
      restarted.invalidate();
      const view = await documentView(restarted, "notes/plan.yaml");
      assert.equal(view.annotations.length, 1, `one annotation after the repeat (crash ${crashAt})`);
      assert.equal((await restarted.validate()).ok, true);
      local.invalidate();
      assert.equal((await local.validate()).ok, true);
    } finally {
      await r.cleanup();
    }
  }
  assert.ok(points >= 3, `crash points: ${points}`);
});

test("EP-048-T08 Git → local after the file is ignored; «Оставить локальными»; only this reader's receipts move", async () => {
  const r = await repo();
  try {
    await r.write("docs/b.md", "# B\n\nАбзац.\n");
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "b");
    r.service.invalidate();
    const shown = await documentView(r.service, "docs/b.md");
    const annotation = await r.service.annotate({ path: "docs/b.md", observation: { sha: shown.document.sha }, text: "Сократить", kind: "note", targetKind: "block", block: 1 });
    // Another reader's receipt stays shared.
    r.git("config", "user.email", "other@bb-docs.invalid");
    const other = new ReviewService(r.dir, r.data);
    await other.acknowledge({ path: "docs/b.md", observation: { sha: shown.document.sha }, scope: "document" });
    r.git("config", "user.email", "owner@bb-docs.invalid");
    // The file leaves Git: ignored and not in the index.
    await r.write(".gitignore", "notes/\ndocs/b.md\n");
    r.git("rm", "-q", "--cached", "docs/b.md");
    r.git("add", ".gitignore");
    r.git("commit", "-q", "-m", "b is local now");
    r.service.invalidate();
    const moved = await transferDocument(r.service, { path: "docs/b.md", direction: "to-local" });
    assert.equal(moved.annotations, 1);
    assert.equal(moved.receipts, 0, "the other reader's receipt is not moved");
    r.service.invalidate();
    const local = await localFor(r.service);
    assert.equal(await serviceForPath(r.service, "docs/b.md"), local);
    const view = await documentView(local, "docs/b.md");
    assert.deepEqual(view.annotations.map((entry) => entry.annotationId), [annotation.annotationId]);
    await assert.rejects(r.service.annotate({ path: "docs/b.md", observation: { sha: view.document.sha }, text: "x", kind: "note", targetKind: "document" }), (error) => ["transferred", "outside-git"].includes(error.code), "the shared data is read-only now");
    assert.equal((await r.service.validate()).ok, true);
    assert.equal((await local.validate()).ok, true);
    // “Keep local” on a file that came into Git: the local data stays read-only, nothing moves.
    const { local: local2 } = await localWithData(r);
    r.git("add", "-f", "notes/plan.yaml");
    r.git("commit", "-q", "-m", "plan in Git");
    r.service.invalidate(); local2.invalidate();
    await keepLocal(r.service, { path: "notes/plan.yaml" });
    local2.invalidate();
    const shared = await documentView(r.service, "notes/plan.yaml");
    assert.equal(shared.annotations.length, 0, "the shared review starts clean");
  } finally {
    await r.cleanup();
  }
});

test("EP-048-T06 security review: repository secret keys mask the local store; forget keeps the journal usable; a sticky local file stays out of .bb-docs; bad paths are refused", async () => {
  const { localForget, trackLocally: track, localFor: localOf } = await import("../node/local.ts");
  const r = await repo();
  try {
    // 1. A repository secret key masks the local view and store too.
    const config = JSON.parse(await fs.readFile(path.join(r.dir, ".bb-docs/config.json"), "utf8"));
    await fs.writeFile(path.join(r.dir, ".bb-docs/config.json"), JSON.stringify({ ...config, schemaVersion: "1.2", secretKeys: ["corpcode"] }) + "\n");
    await r.write("notes/corp.yaml", "corpcode: ZZSECRETVALUE0001\nname: x\n");
    r.service.invalidate();
    await track(r.service, { path: "notes", isDir: true, action: "add" });
    const local = await localOf(r.service);
    const corp = await documentView(local, "notes/corp.yaml");
    assert.ok(!JSON.stringify(corp).includes("ZZSECRETVALUE0001"), "masked in the local view");
    for (const file of (await fs.readdir(path.join(r.data, "local-review"), { recursive: true })).map(String)) {
      const full = path.join(r.data, "local-review", file);
      if ((await fs.stat(full)).isFile()) assert.ok(!(await fs.readFile(full, "utf8")).includes("ZZSECRETVALUE0001"), `masked in the local store (${file})`);
    }
    // 2. Forget file after a receipt: other local receipts still work and validation succeeds.
    const plan = await documentView(local, "notes/plan.yaml");
    await local.acknowledge({ path: "notes/plan.yaml", observation: { sha: plan.document.sha }, scope: "document" });
    await localForget(r.service, { path: "notes/plan.yaml" });
    local.invalidate();
    assert.equal((await local.validate()).ok, true, "the local journal is valid after «Забыть»");
    const corpAgain = await documentView(local, "notes/corp.yaml");
    await local.acknowledge({ path: "notes/corp.yaml", observation: { sha: corpAgain.document.sha }, scope: "document" });
    // 3. A sticky local «new» file is never registered by the shared review (acknowledgeAll walks every document).
    await r.write(".gitignore", "\n");
    r.git("add", ".gitignore");
    r.git("commit", "-q", "-m", "notes not ignored here");
    r.service.invalidate(); local.invalidate();
    assert.equal(await r.service.fileClass("notes/corp.yaml"), "new");
    await r.service.acknowledgeAll({});
    const sharedPaths = [...(await r.service.state()).documents.values()].map((doc) => doc.path);
    assert.ok(!sharedPaths.includes("notes/corp.yaml"), "the sticky local file is not in .bb-docs");
    // 4. Bad paths are refused before anything is written.
    await assert.rejects(transferDocument(r.service, { path: "notes//x.md", direction: "to-local" }), (error) => error.code === "bad-path");
  } finally {
    await r.cleanup();
  }
});
