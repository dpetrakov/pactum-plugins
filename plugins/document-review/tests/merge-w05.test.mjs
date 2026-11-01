// EP-014-T02: branches and merges of review data on real Git clones. Independent entities unite, ambiguity is shown and
// resolved explicitly (never last-write-wins): rename against removal, two renames, a config.json conflict after a Git
// merge, concurrent replies and receipts (AC10, AC12, AC27). A conflict never breaks reading of the other documents.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discussion } from "../core/discussion.ts";
import { resolveDocumentConflict, resolveMove, setRule, treeWithMoves } from "../node/catalog.ts";
import { ReviewService } from "../node/service.ts";
import { documentView } from "../node/view.ts";

const DOC = "# A\n\nПервый абзац.\n\nВторой абзац.\n";

async function origin() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-merge-")));
  const make = async (name, email) => {
    const dir = path.join(base, name);
    const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, stdio: "pipe" }).toString();
    return { dir, git, email, service: () => new ReviewService(dir, path.join(base, `${name}-data`)) };
  };
  const a = await make("a", "owner@bb-docs.invalid");
  await fs.mkdir(a.dir);
  a.git("init", "-q", "-b", "main");
  a.git("config", "user.name", "Owner");
  a.git("config", "user.email", a.email);
  for (const [file, text] of Object.entries({ "docs/a.md": DOC, "docs/r.md": "# R\n\nабзац один\n\nабзац два\n", "docs/other.md": "# Other\n\nЧитается всегда.\n" })) {
    await fs.mkdir(path.dirname(path.join(a.dir, file)), { recursive: true });
    await fs.writeFile(path.join(a.dir, file), text);
  }
  const serviceA = a.service();
  await serviceA.enable({});
  a.git("add", "-A");
  a.git("commit", "-q", "-m", "base");
  execFileSync("git", ["clone", "-q", a.dir, path.join(base, "b")]);
  const b = await make("b", "owner@bb-docs.invalid");
  b.git("config", "user.name", "Owner on b");
  b.git("config", "user.email", b.email);
  const commit = (side, message) => {
    side.git("add", "-A");
    side.git("commit", "-q", "-m", message);
  };
  /** Pull the other clone into `into`; returns git's exit status (1 on a content conflict). */
  const merge = (into, from) => {
    try {
      into.git("pull", "-q", "--no-rebase", "--no-edit", from.dir, "main");
      return 0;
    } catch {
      return 1;
    }
  };
  return { base, a, b, commit, merge, cleanup: () => fs.rm(base, { recursive: true, force: true }) };
}

const block = (view, prefix) => view.blocks.find((entry) => entry.text.startsWith(prefix));

test("rename on one branch against removal on the other: an explicit conflict, other documents stay readable and writable", async () => {
  const o = await origin();
  try {
    const sa = o.a.service();
    const before = await documentView(sa, "docs/r.md");
    const docId = before.document.docId;
    const annotated = await sa.annotate({ path: "docs/r.md", observation: { sha: before.document.sha }, kind: "action", text: "Проверить", targetKind: "block", block: 1 });
    o.commit(o.a, "annotation");
    assert.equal(o.merge(o.b, o.a), 0);
    // a: rename r.md → r2.md (Git and the journal); b: delete r.md and acknowledge the deletion.
    o.a.git("mv", "docs/r.md", "docs/r2.md");
    await treeWithMoves(sa);
    assert.equal((await sa.state()).documents.get(docId).path, "docs/r2.md");
    o.commit(o.a, "rename");
    const sb = o.b.service();
    o.b.git("rm", "-q", "docs/r.md");
    await resolveMove(sb, { docId, to: null });
    o.commit(o.b, "remove");
    // Git: rename/delete conflict; the user keeps the renamed file in Git as usual.
    assert.equal(o.merge(o.a, o.b), 1, "Git reports the rename/delete conflict");
    o.a.git("add", "docs/r2.md");
    o.a.git("commit", "-q", "--no-edit");
    const merged = new ReviewService(o.a.dir, path.join(o.base, "a-data"));
    const state = await merged.state();
    const record = state.documents.get(docId);
    assert.equal(record.conflict.register, "presence", "the journal does not pick a winner");
    assert.deepEqual(record.conflict.candidates.map((candidate) => candidate.value).sort(), ["present", "removed"]);
    assert.equal(record.path, "docs/r2.md", "the document stays reachable");
    const tree = await treeWithMoves(merged);
    assert.equal(tree.entries.find((entry) => entry.path === "docs/r2.md").conflict, true, "the tree marks the conflict");
    const view = await documentView(merged, "docs/r2.md");
    assert.equal(view.document.conflict.register, "presence");
    assert.equal(view.annotations[0].annotationId, annotated.annotationId, "annotations stay reachable");
    await assert.rejects(resolveMove(merged, { docId, to: null }), (error) => error.code === "conflict", "no ordinary decision while in conflict");
    // Other documents: reading and writing are unaffected.
    const other = await documentView(merged, "docs/other.md");
    assert.equal(other.context.writable, true);
    await merged.annotate({ path: "docs/other.md", observation: { sha: other.document.sha }, kind: "note", text: "работает", targetKind: "block", block: 1 });
    // Explicit resolution: keep the document (its file is observed as reconcile, a descendant of both branches).
    await resolveDocumentConflict(merged, { docId, choice: "keep" });
    const resolved = await merged.state();
    assert.equal(resolved.documents.get(docId).conflict, null);
    assert.equal(resolved.documents.get(docId).removed, false);
    assert.equal((await merged.validate()).ok, true);
  } finally {
    await o.cleanup();
  }
});

test("two renames on two branches: a path conflict resolved by choosing one; removal can also be chosen", async () => {
  const o = await origin();
  try {
    const sa = o.a.service();
    const docId = (await documentView(sa, "docs/r.md")).document.docId;
    o.a.git("mv", "docs/r.md", "docs/left.md");
    await treeWithMoves(sa);
    o.commit(o.a, "left");
    const sb = o.b.service();
    o.b.git("mv", "docs/r.md", "docs/right.md");
    await treeWithMoves(sb);
    o.commit(o.b, "right");
    o.merge(o.a, o.b);
    // Git keeps both names after a rename/rename conflict; the user decides in Git and in the review.
    o.a.git("add", "-A");
    o.a.git("commit", "-q", "--no-edit");
    const merged = new ReviewService(o.a.dir, path.join(o.base, "a-data"));
    const record = (await merged.state()).documents.get(docId);
    assert.equal(record.conflict.register, "path");
    assert.deepEqual(record.conflict.candidates.map((candidate) => candidate.value).sort(), ["docs/left.md", "docs/right.md"]);
    await assert.rejects(resolveDocumentConflict(merged, { docId, choice: "docs/elsewhere.md" }), (error) => error.code === "bad-input");
    await resolveDocumentConflict(merged, { docId, choice: "docs/right.md" });
    const after = (await merged.state()).documents.get(docId);
    assert.equal(after.path, "docs/right.md");
    assert.equal(after.conflict, null);
  } finally {
    await o.cleanup();
  }
});

test("config.json conflict after a Git merge: reading goes on with this branch's rules, writes wait, the three-way merge is explicit", async () => {
  const o = await origin();
  try {
    const sa = o.a.service();
    const shown = await documentView(sa, "docs/a.md");
    await sa.annotate({ path: "docs/a.md", observation: { sha: shown.document.sha }, kind: "action", text: "Остаётся видимым", targetKind: "block", block: 1 });
    o.commit(o.a, "annotation");
    o.merge(o.b, o.a);
    await setRule(sa, { list: "hidden", path: "docs/other.md", isDir: false, action: "add" });
    o.commit(o.a, "hide other");
    const sb = o.b.service();
    // Rules in different lists merge cleanly in Git (the keys are far apart in canonical JSON) …
    await setRule(sb, { list: "untracked", path: "docs/r.md", isDir: false, action: "add" });
    o.commit(o.b, "untrack r");
    assert.equal(o.merge(o.a, o.b), 0, "different lists: no Git conflict");
    assert.deepEqual([(await sa.config()).value.hidden, (await sa.config()).value.untracked], [["/docs/other.md"], ["/docs/r.md"]]);
    // … the same list changed on both branches is a Git conflict.
    await setRule(sa, { list: "hidden", path: "docs/a.md", isDir: false, action: "add" });
    o.commit(o.a, "hide a");
    o.merge(o.b, o.a);
    await setRule(sa, { list: "hidden", path: "docs/other.md", isDir: false, action: "remove" });
    o.commit(o.a, "show other");
    await setRule(sb, { list: "hidden", path: "docs/r.md", isDir: false, action: "add" });
    o.commit(o.b, "hide r");
    assert.equal(o.merge(o.a, o.b), 1, "Git: content conflict in .bb-docs/config.json");
    const merged = new ReviewService(o.a.dir, path.join(o.base, "a-data"));
    const config = await merged.config();
    assert.equal(config.readOnly, true);
    assert.match(config.problem, /merge conflict/);
    assert.deepEqual(config.value.hidden, ["/docs/a.md"], "reading uses this branch's rules");
    const view = await documentView(merged, "docs/a.md");
    assert.equal(view.annotations.length, 1, "annotations are still shown");
    assert.equal(view.context.writable, false);
    // Three-way: a removed other.md and added a.md, b added r.md (base: other.md, a.md).
    assert.deepEqual(view.context.configConflict.merged, { roots: ["."], hidden: ["/docs/a.md", "/docs/r.md"], untracked: ["/docs/r.md"] });
    await assert.rejects(merged.reply({ annotationId: view.annotations[0].annotationId, text: "нельзя" }), (error) => error.code === "read-only");
    const tree = await treeWithMoves(merged);
    assert.ok(tree.entries.some((entry) => entry.path === "docs/a.md"), "the tree is readable");
    await merged.resolveConfigConflict({ configSha: view.context.configConflict.configSha });
    assert.equal(o.a.git("ls-files", "-u", "--", ".bb-docs/config.json").trim(), "", "marked resolved in Git");
    const after = await merged.config();
    assert.deepEqual([after.readOnly, after.value.hidden, after.value.untracked], [false, ["/docs/a.md", "/docs/r.md"], ["/docs/r.md"]]);
    await merged.reply({ annotationId: view.annotations[0].annotationId, text: "снова можно" });
    o.a.git("commit", "-q", "--no-edit");
    assert.equal((await merged.validate()).ok, true);
  } finally {
    await o.cleanup();
  }
});

test("AC10/AC12/AC27 on two clones: both replies kept, receipts of each branch stay their own, the merge is read only where versions were confirmed", async () => {
  const o = await origin();
  try {
    const sa = o.a.service();
    const shown = await documentView(sa, "docs/a.md");
    const created = await sa.annotate({ path: "docs/a.md", observation: { sha: shown.document.sha }, kind: "action", text: "Обсудим", targetKind: "block", block: 1 });
    o.commit(o.a, "annotation");
    o.merge(o.b, o.a);
    const sb = o.b.service();
    // Concurrent replies and edits of different paragraphs, each read on its own branch.
    await sa.reply({ annotationId: created.annotationId, text: "ответ из a" });
    await sb.reply({ annotationId: created.annotationId, text: "ответ из b" });
    await fs.writeFile(path.join(o.a.dir, "docs/a.md"), DOC.replace("Первый абзац.", "Первый абзац, правка a."));
    await fs.writeFile(path.join(o.b.dir, "docs/a.md"), DOC.replace("Второй абзац.", "Второй абзац, правка b."));
    const va = await documentView(sa, "docs/a.md");
    await sa.acknowledge({ path: "docs/a.md", observation: { sha: va.document.sha }, scope: "document" });
    const vb = await documentView(sb, "docs/a.md");
    await sb.acknowledge({ path: "docs/a.md", observation: { sha: vb.document.sha }, scope: "document" });
    o.commit(o.a, "a: reply, edit, read");
    o.commit(o.b, "b: reply, edit, read");
    assert.equal(o.merge(o.a, o.b), 0, "different paragraphs merge in Git");
    const merged = new ReviewService(o.a.dir, path.join(o.base, "a-data"));
    const state = await merged.state();
    const texts = discussion(state, created.annotationId).messages.map((message) => message.current?.text);
    assert.ok(texts.includes("ответ из a") && texts.includes("ответ из b"), "AC10: no reply lost");
    assert.equal(state.conflicts.length, 0, "independent entities unite without conflicts");
    const view = await documentView(merged, "docs/a.md");
    assert.equal(block(view, "Первый абзац, правка a").read, "read", "the version confirmed on a stays read");
    assert.equal(block(view, "Второй абзац, правка b").read, "read", "the version confirmed on b stays read (same reader on both clones)");
    assert.equal(view.unread, 0);
    // A receipt of the old branch delivered later never rolls the base back (AC27): the merged revision is current.
    assert.equal((await merged.validate()).ok, true);
  } finally {
    await o.cleanup();
  }
});

test("drill: two clones exchanged only as Git bundles; Git and review conflicts listed and resolved explicitly; the merged bundle restores the same state (AC01)", async () => {
  const { drillStart, drillMerge, drillClean, DRILL_READER } = await import("../node/drill.ts");
  const { summarize } = await import("../node/check.ts");
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-drill-test-")));
  try {
    const first = await drillStart({ tempDir: temp });
    const merged = await drillMerge({ bundle: first.bundle, tempDir: temp });
    assert.equal(merged.gitMerge, "conflicts");
    assert.ok(merged.unmerged.includes(".bb-docs/config.json"), `config.json unmerged: ${merged.unmerged}`);
    assert.equal(merged.readable.annotations, 1, "the clone without plugin data shows the annotation (AC01)");
    assert.equal(merged.duringConflict.configReadOnly, true);
    assert.equal(merged.duringConflict.otherReadable, true, "other documents stay readable during the config conflict");
    assert.deepEqual(merged.duringConflict.proposed.hidden, ["/docs/a.md", "/docs/other.md"]);
    assert.deepEqual(merged.conflicts.map((entry) => `${entry.entity}#${entry.register}`).sort(), ["annotation#status", "doc#presence"]);
    assert.equal(merged.replies.length, 3, "the instruction and both machines' replies");
    assert.equal(merged.reading.unread, 0, "each paragraph was confirmed on its machine by the same reader");
    assert.deepEqual(merged.resolved, { conflictsLeft: 0, rPath: "docs/r2.md", status: "closed" });
    assert.equal(merged.validate.ok, true);
    const restored = await summarize({ bundle: merged.bundle, reader: DRILL_READER, dataDir: path.join(temp, "d"), tempDir: temp });
    assert.equal(restored.digest, merged.digest, "the merged bundle restores the same state for the reader");
    assert.equal((await drillClean({ tempDir: temp })).removed.length, 2);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
