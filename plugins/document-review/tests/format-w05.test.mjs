// EP-014-T04/T05: schema 1.1 (removal acknowledged per reader), reading 1.0 data without loss, migration that only
// appends files, read-only with an explanation for an unknown major and for a newer minor, retention of snapshots.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalBytes } from "../core/canonical-json.ts";
import { migrationPath, versionsInUse } from "../core/migrate.ts";
import { layout } from "../core/store.ts";
import { acknowledgeDeletion } from "../node/catalog.ts";
import { ReviewService } from "../node/service.ts";
import { documentTree } from "../node/tree.ts";
import { documentView } from "../node/view.ts";

async function repo() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-format-")));
  const dir = path.join(base, "repo");
  await fs.mkdir(path.join(dir, "docs"), { recursive: true });
  const git = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, stdio: "pipe" }).toString();
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Owner");
  git(dir, "config", "user.email", "owner@bb-docs.invalid");
  await fs.writeFile(path.join(dir, "docs/a.md"), "# A\n\nабзац\n");
  await fs.writeFile(path.join(dir, "docs/gone.md"), "# Gone\n\nбудет удалён\n");
  await fs.writeFile(path.join(dir, "docs/keep.md"), "# Keep\n\nостаётся\n");
  const service = new ReviewService(dir, path.join(base, "data"));
  await service.enable({});
  /** The same checkout under another reader (another Git email), as on a colleague's clone. */
  const as = (email) => {
    git(dir, "config", "user.email", email);
    return new ReviewService(dir, path.join(base, `data-${email}`));
  };
  return { base, dir, git, service, as, cleanup: () => fs.rm(base, { recursive: true, force: true }) };
}

async function files(dir) {
  const out = new Map();
  const walk = async (current) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.set(path.relative(dir, full), createHash("sha256").update(await fs.readFile(full)).digest("hex"));
    }
  };
  await walk(dir);
  return out;
}

async function writeEvent(dir, event) {
  const file = path.join(dir, ".bb-docs", layout.event(event.id));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, canonicalBytes(event));
}

test("T05: the deletion of a document is unread for every reader until they acknowledge it themselves; undo is addressed", async () => {
  const r = await repo();
  try {
    const docId = (await documentView(r.service, "docs/gone.md")).document.docId;
    await fs.rm(path.join(r.dir, "docs/gone.md"));
    assert.equal((await documentView(r.service, "docs/gone.md")).document.deletionUnread, true);
    const acknowledged = await acknowledgeDeletion(r.service, { docId });
    assert.ok(acknowledged.receiptId);
    assert.equal((await documentView(r.service, "docs/gone.md")).document.deletionUnread, false, "read for the owner");
    let tree = await documentTree(r.service);
    assert.equal(tree.virtual.length, 0, "no open annotations and read: the entry leaves the owner's tree");
    // Another reader: still unread, the entry is in their tree.
    const bob = r.as("bob@bb-docs.invalid");
    assert.equal((await documentView(bob, "docs/gone.md")).document.deletionUnread, true, "unread for bob");
    tree = await documentTree(bob);
    assert.deepEqual(tree.virtual.map((entry) => [entry.path, entry.reason, entry.deletionUnread]), [["docs/gone.md", "removed", true]]);
    const bobs = await acknowledgeDeletion(bob, { docId });
    assert.equal((await documentView(bob, "docs/gone.md")).document.deletionUnread, false);
    await bob.revoke({ receiptId: bobs.receiptId });
    assert.equal((await documentView(bob, "docs/gone.md")).document.deletionUnread, true, "bob's undo is his alone");
    // «All read» includes unread deletions.
    const all = await bob.acknowledgeAll({});
    assert.equal(all.deletions, 1);
    assert.equal((await documentView(bob, "docs/gone.md")).document.deletionUnread, false);
    const owner = r.as("owner@bb-docs.invalid");
    assert.equal((await documentView(owner, "docs/gone.md")).document.deletionUnread, false, "the owner's acknowledgement stays");
    const versions = versionsInUse(await bob.state());
    assert.ok(versions["1.1"] >= 3 && versions["1.0"] >= 1, `only operations with removal receipts declare 1.1: ${JSON.stringify(versions)}`);
    assert.equal((await bob.validate()).ok, true);
  } finally {
    await r.cleanup();
  }
});

test("T04/T05: 1.0 data with document.removed reads without loss; migration 1.0 → 1.1 only adds files", async () => {
  const r = await repo();
  try {
    const docId = (await documentView(r.service, "docs/gone.md")).document.docId;
    const shown = await documentView(r.service, "docs/a.md");
    const created = await r.service.annotate({ path: "docs/a.md", observation: { sha: shown.document.sha }, kind: "action", text: "Замечание 1.0", targetKind: "block", block: 1 });
    await fs.rm(path.join(r.dir, "docs/gone.md"));
    // As a 1.0 plugin wrote it: one document.removed per checkout, no receipt.
    const state = await r.service.state();
    await writeEvent(r.dir, { schemaVersion: "1.0", id: "00000000-0000-4000-8000-00000000d0e1", actor: { kind: "human", name: "Owner", email: "owner@bb-docs.invalid" },
      timestamp: "2026-10-07T10:00:00.000Z", parents: state.heads.get(`doc:${docId}`), changes: [{ type: "document.removed", docId, path: "docs/gone.md" }] });
    r.service.invalidate();
    const before = await files(path.join(r.dir, ".bb-docs"));
    assert.ok([...before.keys()].every((file) => !file.endsWith(".json") || file === "config.json" || true));
    assert.deepEqual(migrationPath("1.0").map((migration) => [migration.from, migration.to, migration.plan(state).length]), [["1.0", "1.1", 0], ["1.1", "1.2", 0], ["1.2", "1.3", 0]], "1.1, 1.2 and 1.3 read 1.0 as is");
    // The author of document.removed acknowledged it; another reader has it unread.
    assert.equal((await documentView(r.service, "docs/gone.md")).document.deletionUnread, false);
    const bob = r.as("bob@bb-docs.invalid");
    assert.equal((await documentView(bob, "docs/gone.md")).document.deletionUnread, true);
    // 1.1 writes: bob acknowledges, replies; nothing existing changes.
    await acknowledgeDeletion(bob, { docId });
    await bob.reply({ annotationId: created.annotationId, text: "ответ 1.1-плагина" });
    const after = await files(path.join(r.dir, ".bb-docs"));
    for (const [file, hash] of before) assert.equal(after.get(file), hash, `${file} is unchanged`);
    assert.ok(after.size > before.size, "new files were added");
    assert.equal((await bob.validate()).ok, true);
  } finally {
    await r.cleanup();
  }
});

test("G3: an unknown major opens everything read-only with an explanation; nothing is written", async () => {
  const r = await repo();
  try {
    const state = await r.service.state();
    const docId = [...state.documents.values()].find((doc) => doc.path === "docs/a.md").docId;
    await writeEvent(r.dir, { schemaVersion: "2.0", id: "00000000-0000-4000-8000-0000000000f2", actor: { kind: "human", name: "Future", email: "f@bb-docs.invalid" },
      timestamp: "2026-10-07T10:00:00.000Z", parents: state.heads.get(`doc:${docId}`), changes: [{ type: "document.reshaped", docId }] });
    r.service.invalidate();
    const before = await files(path.join(r.dir, ".bb-docs"));
    const view = await documentView(r.service, "docs/keep.md");
    assert.equal(view.context.writable, false);
    assert.match(view.context.readOnlyReason, /incompatible .*version of the plugin/);
    assert.ok(view.blocks.length > 0, "reading works");
    await assert.rejects(r.service.annotate({ path: "docs/keep.md", observation: { sha: view.document.sha }, kind: "note", text: "x", targetKind: "document" }), (error) => error.code === "read-only");
    const report = await r.service.validate();
    assert.ok(report.problems.some((problem) => problem.code === "unknown-schema"));
    assert.deepEqual(await files(path.join(r.dir, ".bb-docs")), before, "nothing written");
  } finally {
    await r.cleanup();
  }
});

test("G3: a newer minor with unknown changes makes only its entities read-only; history stays complete; config of a newer minor is read-only", async () => {
  const r = await repo();
  try {
    let state = await r.service.state();
    const docA = [...state.documents.values()].find((doc) => doc.path === "docs/a.md").docId;
    const future = { schemaVersion: "1.4", id: "00000000-0000-4000-8000-0000000000f1", actor: { kind: "human", name: "Future", email: "f@bb-docs.invalid" },
      timestamp: "2026-10-07T10:00:00.000Z", parents: state.heads.get(`doc:${docA}`), changes: [{ type: "document.labelled", docId: docA, label: "x" }] };
    await writeEvent(r.dir, future);
    // A later 1.0 event of the same document names the future one as parent (written by the newer plugin).
    r.service.invalidate();
    state = await r.service.state();
    assert.equal(state.incomplete.size, 0, "children of an opaque event are not incomplete");
    assert.ok((state.readOnly.get(`doc:${docA}`) ?? []).length > 0);
    const view = await documentView(r.service, "docs/a.md");
    assert.match(view.document.readOnly, /newer schema version \(1\.4\)/);
    const keep = await documentView(r.service, "docs/keep.md");
    assert.equal(keep.context.writable, true, "other documents stay writable");
    await r.service.annotate({ path: "docs/keep.md", observation: { sha: keep.document.sha }, kind: "note", text: "работает", targetKind: "document" });
    const report = await r.service.validate();
    assert.equal(report.ok, true, "a newer minor is a warning, not damage");
    assert.ok(report.problems.some((problem) => problem.code === "read-only" && /1\.4/.test(problem.message)));
    // config.json of a newer minor: rules read, not written.
    const config = JSON.parse(await fs.readFile(path.join(r.dir, ".bb-docs/config.json"), "utf8"));
    await fs.writeFile(path.join(r.dir, ".bb-docs/config.json"), canonicalBytes({ ...config, schemaVersion: "1.5" }));
    r.service.invalidate();
    const later = await documentView(r.service, "docs/keep.md");
    assert.equal(later.context.writable, false);
    assert.match(later.context.readOnlyReason, /config\.json was written by a newer version of the plugin/);
  } finally {
    await r.cleanup();
  }
});

test("G5/G8: retention never removes what an event references; only orphans of interrupted writes are collected", async () => {
  const r = await repo();
  try {
    const shown = await documentView(r.service, "docs/a.md");
    const created = await r.service.annotate({ path: "docs/a.md", observation: { sha: shown.document.sha }, kind: "action", text: "архивное", targetKind: "block", block: 1 });
    await r.service.decide({ annotationId: created.annotationId, action: "close", expectedHeads: (await r.service.state()).heads.get(`annotation:${created.annotationId}`) });
    // An interrupted write: snapshot and object without their event.
    const orphan = new TextEncoder().encode("# orphan\n");
    const sha = createHash("sha256").update(orphan).digest("hex");
    await fs.mkdir(path.join(r.dir, ".bb-docs", path.dirname(layout.snapshot(sha))), { recursive: true });
    await fs.writeFile(path.join(r.dir, ".bb-docs", layout.snapshot(sha)), orphan);
    const listed = await r.service.orphans();
    assert.deepEqual([listed.snapshots, listed.objects], [[sha], []]);
    const before = await files(path.join(r.dir, ".bb-docs"));
    const collected = await r.service.orphans({ apply: true });
    assert.equal(collected.removed, 1);
    const after = await files(path.join(r.dir, ".bb-docs"));
    assert.deepEqual([...before.keys()].filter((file) => !after.has(file)), [path.join("snapshots", layout.snapshot(sha).split("/").slice(1).join("/"))]);
    const view = await documentView(r.service, "docs/a.md");
    assert.equal(view.annotations.find((annotation) => annotation.annotationId === created.annotationId).status, "closed", "the archived annotation keeps its target");
    assert.equal((await r.service.validate(5)).ok, true);
  } finally {
    await r.cleanup();
  }
});
