// EP-014-T03: restoring from a clone and readers (AC01, AC17, F1). The reader is the Git email of the checkout: the same
// email on another clone keeps its progress, a new email is offered to accept the current state (one undoable action),
// without an email the checkout is read-only. Enabling is not needed again after clone.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { summary } from "../node/check.ts";
import { documentTree } from "../node/tree.ts";
import { ReviewService } from "../node/service.ts";
import { documentView } from "../node/view.ts";

async function setup() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-readers-")));
  const a = path.join(base, "a");
  await fs.mkdir(path.join(a, "docs"), { recursive: true });
  const git = (dir, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, stdio: "pipe" }).toString();
  git(a, "init", "-q", "-b", "main");
  git(a, "config", "user.name", "Owner");
  git(a, "config", "user.email", "Owner@Example.com");
  await fs.writeFile(path.join(a, "docs/one.md"), "# One\n\nПервый.\n\nВторой.\n");
  await fs.writeFile(path.join(a, "docs/two.md"), "# Two\n\nТекст.\n");
  const owner = new ReviewService(a, path.join(base, "a-data"));
  await owner.enable({});
  // After enabling: an edit read by the owner, an annotation, an unread edit for everybody.
  await fs.writeFile(path.join(a, "docs/one.md"), "# One\n\nПервый, правка.\n\nВторой.\n");
  const shown = await documentView(owner, "docs/one.md");
  await owner.acknowledge({ path: "docs/one.md", observation: { sha: shown.document.sha }, scope: "document" });
  await owner.annotate({ path: "docs/one.md", observation: { sha: shown.document.sha }, kind: "action", text: "Проверить", targetKind: "block", block: 1 });
  await fs.writeFile(path.join(a, "docs/two.md"), "# Two\n\nТекст, правка без чтения.\n");
  await documentView(owner, "docs/two.md");
  const unreadTwo = await documentView(owner, "docs/two.md");
  await owner.annotate({ path: "docs/two.md", observation: { sha: unreadTwo.document.sha }, kind: "note", text: "Заметка", targetKind: "document" });
  git(a, "add", "-A");
  git(a, "commit", "-q", "-m", "review");
  const clone = (name, email) => {
    const dir = path.join(base, name);
    execFileSync("git", ["clone", "-q", a, dir]);
    git(dir, "config", "user.name", name);
    if (email !== null) git(dir, "config", "user.email", email);
    else git(dir, "config", "user.email", "");
    return new ReviewService(dir, path.join(base, `${name}-data`));
  };
  return { base, owner, clone, cleanup: () => fs.rm(base, { recursive: true, force: true }) };
}

test("AC01/AC17: the same email on a clone without plugin data restores annotations, archive and unread exactly; no enabling needed", async () => {
  const s = await setup();
  try {
    const same = s.clone("same", "owner@example.com");
    assert.equal(await summary(same, "owner@example.com"), await summary(s.owner, "owner@example.com"), "the same state from the repository alone");
    const status = await same.status();
    assert.equal(status.enabled, true, "enabled by the committed .bb-docs; nothing to enable after clone");
    const tree = await documentTree(same);
    assert.equal(tree.reader.known, true, "the email is normalized: Owner@Example.com and owner@example.com are one reader");
    assert.equal((await documentView(same, "docs/one.md")).unread, 0, "progress follows the email");
    const unread = (await documentView(same, "docs/two.md")).unread;
    assert.ok(unread > 0, "unread stays unread");
    assert.equal(unread, (await documentView(s.owner, "docs/two.md")).unread, "the same unread blocks as on the original");
  } finally {
    await s.cleanup();
  }
});

test("AC17/F1: a new email is offered to accept the current state; one undoable action; the old reader is untouched", async () => {
  const s = await setup();
  try {
    const fresh = s.clone("fresh", "new.reader@example.com");
    let tree = await documentTree(fresh);
    assert.deepEqual(tree.reader, { id: "new.reader@example.com", known: false });
    assert.equal(tree.totals.unreadDocs, 2, "for a new reader every change since enabling is unread");
    const accepted = await fresh.acknowledgeAll({});
    assert.equal(accepted.documents, 2);
    tree = await documentTree(fresh);
    assert.equal(tree.reader.known, true);
    assert.equal(tree.totals.unreadDocs, 0);
    // Undo as a whole: exactly these receipts.
    await fresh.revokeMany({ receiptIds: accepted.receipts });
    const undone = await documentTree(fresh);
    assert.equal(undone.totals.unreadDocs, 2);
    assert.equal(undone.reader.known, false, "after the undo the offer comes back");
    assert.equal(await summary(fresh, "owner@example.com"), await summary(s.owner, "owner@example.com"), "the owner's reading did not change");
    const report = await fresh.validate();
    assert.equal(report.ok, true);
  } finally {
    await s.cleanup();
  }
});

test("AC17: without user.email reading works and nothing can be written", async () => {
  const s = await setup();
  try {
    const anonymous = s.clone("anonymous", null);
    const view = await documentView(anonymous, "docs/one.md");
    assert.equal(view.annotations.length, 1, "annotations are readable");
    assert.equal(view.context.writable, false);
    assert.match(view.context.readOnlyReason, /user\.email/);
    assert.equal((await documentTree(anonymous)).writable, false);
    await assert.rejects(anonymous.acknowledgeAll({}), (error) => error.code === "no-identity");
    await assert.rejects(anonymous.reply({ annotationId: view.annotations[0].annotationId, text: "нельзя" }), (error) => error.code === "no-identity");
  } finally {
    await s.cleanup();
  }
});
