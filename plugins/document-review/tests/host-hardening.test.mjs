// Regression tests for the W-02 code review: crafted repositories, untrusted paths, role rules, races.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalBytes } from "../core/canonical-json.ts";
import { discussion } from "../core/discussion.ts";
import { sha256 } from "../core/hash.ts";
import { entity, loadRepository, project } from "../core/journal.ts";
import { readState } from "../core/reading.ts";
import { SCHEMA_VERSION } from "../core/schema.ts";
import { layout, MemoryBackend } from "../core/store.ts";
import { validate } from "../core/validate.ts";
import { resolveCheckout } from "../node/checkout.ts";
import { ObservationLog } from "../node/observations.ts";
import { ReviewService } from "../node/service.ts";
import { agent, alice, annotationObject, bob, id, objectSha, observe, revision, stateOf, write } from "./helpers.mjs";

async function repo() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-hard-")));
  const run = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.name", "Owner");
  run("config", "user.email", "owner@bb-docs.invalid");
  await fs.mkdir(path.join(dir, "docs"));
  await fs.writeFile(path.join(dir, "docs/a.md"), "# A\n\nПервый абзац.\n");
  await fs.writeFile(path.join(dir, "docs/b.md"), "# B\n\nДругой документ.\n");
  run("add", "-A");
  run("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "init");
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-hard-data-"));
  return { dir, data, service: new ReviewService(dir, data), cleanup: () => Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]) };
}

const quoteOf = async (service, docPath, needle) => {
  const shown = await service.readDocument(docPath);
  const { project: projectMarkdown } = await import("../core/markdown/index.ts");
  const text = projectMarkdown(shown.text).text;
  const start = [...text.slice(0, text.indexOf(needle))].length;
  return { shown, range: { start, end: start + [...needle].length }, quote: needle };
};

test("H1: a symlink inside .bb-docs (or .bb-docs itself) is refused and nothing is written outside", async () => {
  const { dir, service, cleanup } = await repo();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-outside-"));
  try {
    await fs.mkdir(path.join(dir, ".bb-docs"));
    await fs.symlink(outside, path.join(dir, ".bb-docs/snapshots"));
    await assert.rejects(service.enable({}), (error) => error.code === "bad-path" || /symlink/.test(error.message));
    assert.deepEqual(await fs.readdir(outside), []);
    await fs.rm(path.join(dir, ".bb-docs"), { recursive: true });
    await fs.symlink(outside, path.join(dir, ".bb-docs"));
    await assert.rejects(service.enable({}), /symlink/);
    assert.deepEqual(await fs.readdir(outside), []);
    // A symlinked config.json neither leaks the target through validate nor breaks status.
    await fs.rm(path.join(dir, ".bb-docs"));
    await fs.mkdir(path.join(dir, ".bb-docs"));
    await fs.writeFile(path.join(outside, "secret"), "SECRET_TOKEN=abc");
    await fs.symlink(path.join(outside, "secret"), path.join(dir, ".bb-docs/config.json"));
    const report = await service.validate();
    assert.ok(report.problems.some((problem) => problem.code === "unreadable"));
    assert.ok(!JSON.stringify(report).includes("SECRET"), "target content does not leak");
    const status = await service.status();
    assert.equal(status.readOnly, true);
  } finally {
    await cleanup();
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("H2: --mark-generated refuses a symlinked .gitattributes", async () => {
  const { dir, service, cleanup } = await repo();
  const outside = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-outside-")), "rc");
  try {
    await fs.writeFile(outside, "keep\n");
    await fs.symlink(outside, path.join(dir, ".gitattributes"));
    await assert.rejects(service.enable({ markGenerated: true }));
    assert.equal(await fs.readFile(outside, "utf8"), "keep\n");
  } finally {
    await cleanup();
    await fs.rm(path.dirname(outside), { recursive: true, force: true });
  }
});

test("H3: two long concurrent chains of status changes project quickly", async () => {
  const store = new MemoryBackend();
  const docId = id("doc");
  const revisionId = id("rev");
  const rev = revision({ revisionId, docId, blocks: [{ lineageId: `${revisionId}.0`, versionId: `${revisionId}.0`, content: "x" }] });
  await observe(store, rev, { register: true, reason: "baseline" });
  const annotationId = id("ann");
  const annotation = annotationObject({ repoId: id("repo"), annotationId, docId, revisionId, snapshotSha: rev.object.snapshot });
  const created = await write(store, { changes: [{ type: "annotation.created", annotationId, docId, annotation: objectSha(annotation), kind: "action", messageId: id("m") }], objects: [annotation] });
  // Craft events directly: two branches of 1000 status changes each.
  for (const branch of ["l", "r"]) {
    let parent = created.operation.id;
    for (let index = 0; index < 1000; index++) {
      const eventId = id(`${branch}-${index}`);
      const operation = { schemaVersion: SCHEMA_VERSION, id: eventId, actor: alice, timestamp: "2026-10-06T12:00:00.000Z", parents: [parent],
        changes: [{ type: index % 2 ? "discussion.reopened" : "discussion.closed", annotationId }] };
      store.files.set(layout.event(eventId), canonicalBytes(operation));
      parent = eventId;
    }
  }
  const started = performance.now();
  const state = project(await loadRepository(store));
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5000, `projection took ${Math.round(elapsed)} ms`);
  assert.equal(state.registers.get(`${entity.annotation(annotationId)}#status`).value, "open", "both chains end with reopen");
});

test("M1: only regular files of reviewable types outside service directories are served — .env only in redacted form; persistent refs only inside roots", async () => {
  const { dir, service, cleanup } = await repo();
  try {
    // W-06c (EP-039-T04): .env opens, but only in its redacted form — the value never leaves the host.
    await fs.writeFile(path.join(dir, ".env"), "SECRET=hunter2-value\n");
    const env = await service.readDocument(".env");
    assert.equal(env.text, "SECRET=••••••••\n");
    assert.ok(!JSON.stringify(env).includes("hunter2"), "no value in the answer");
    await assert.rejects(service.readDocument("program.ts"), (error) => error.code === "not-supported");
    await assert.rejects(service.readDocument(".git/config"), (error) => error.code === "bad-path");
    execFileSync("mkfifo", [path.join(dir, "docs/pipe.md")]);
    await assert.rejects(service.readDocument("docs/pipe.md"), (error) => error.code === "bad-path");
    await fs.writeFile(path.join(dir, "outside.md"), "# Outside\n\nТекст.\n");
    await service.enable({ roots: ["docs"] });
    const { shown, range, quote } = await quoteOf(service, "outside.md", "Текст");
    await assert.rejects(service.annotate({ path: "outside.md", observation: { sha: shown.sha }, range, quote, text: "x", kind: "note" }), (error) => error.code === "outside-roots");
  } finally {
    await cleanup();
  }
});

test("M2: parallel reads of identical documents record every observation", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-obs-"));
  try {
    const log = new ObservationLog(dir);
    const bytes = new TextEncoder().encode("");
    const sha = sha256(bytes);
    const paths = Array.from({ length: 8 }, (_, index) => `docs/empty-${index}.md`);
    await Promise.all(Array.from({ length: 10 }, () => Promise.all(paths.map((docPath) => log.record({ sha, path: docPath, heads: [], bytes })))));
    for (const docPath of paths) assert.ok(await log.getAt(sha, docPath), docPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("M3: an agent cannot rewrite a human message, close, retype or mark read; validate reports it", async () => {
  const store = new MemoryBackend();
  const docId = id("doc");
  const revisionId = id("rev");
  const rev = revision({ revisionId, docId, blocks: [{ lineageId: `${revisionId}.0`, versionId: `${revisionId}.0`, content: "x" }] });
  await observe(store, rev, { register: true, reason: "baseline" });
  const annotationId = id("ann");
  const annotation = annotationObject({ repoId: id("repo"), annotationId, docId, revisionId, snapshotSha: rev.object.snapshot, text: "human text" });
  await write(store, { changes: [{ type: "annotation.created", annotationId, docId, annotation: objectSha(annotation), kind: "action", messageId: id("m1") }], objects: [annotation] });
  await write(store, { actor: agent, changes: [
    { type: "message.appended", annotationId, messageId: id("m1"), text: "rewritten by agent" },
    { type: "discussion.closed", annotationId },
    { type: "annotation.kind-changed", annotationId, kind: "note" },
    { type: "read.acknowledged", receiptId: id("r"), readerId: "alice@example.com", docId, revisionId, scope: "document", versions: [{ lineageId: `${revisionId}.0`, versionId: `${revisionId}.0` }], tombstones: [] },
  ] });
  const state = await stateOf(store);
  const view = discussion(state, annotationId);
  assert.equal(view.status, "open");
  assert.equal(view.kind, "action");
  assert.deepEqual(view.messages.map((message) => message.current.text), ["human text"]);
  assert.equal(readState(state, "alice@example.com", revisionId).blocks[0].base.versionId, `${revisionId}.0`, "baseline only");
  const report = await validate(store);
  assert.ok(report.problems.filter((problem) => problem.code === "ignored-change").length >= 3);
  assert.ok(report.problems.some((problem) => problem.code === "foreign-receipt"));
  assert.equal(report.ok, false);
});

test("M3/L5: invalid resolutions are not applied", async () => {
  const store = new MemoryBackend();
  const docId = id("doc");
  const revisionId = id("rev");
  const rev = revision({ revisionId, docId, blocks: [{ lineageId: `${revisionId}.0`, versionId: `${revisionId}.0`, content: "x" }] });
  await observe(store, rev, { register: true, reason: "baseline" });
  const annotationId = id("ann");
  const annotation = annotationObject({ repoId: id("repo"), annotationId, docId, revisionId, snapshotSha: rev.object.snapshot });
  const created = await write(store, { changes: [{ type: "annotation.created", annotationId, docId, annotation: objectSha(annotation), kind: "action", messageId: id("m1") }], objects: [annotation] });
  const closed = await write(store, { changes: [{ type: "discussion.closed", annotationId }] });
  await write(store, { actor: bob, changes: [{ type: "conflict.resolved", annotationId, field: "status", value: "banana", resolves: [created.operation.id, closed.operation.id].sort() }] });
  const state = await stateOf(store);
  assert.equal(state.registers.get(`${entity.annotation(annotationId)}#status`).value, "closed");
});

test("M4: another document's snapshot is not a shown revision; an older comment target is reused, never parentless", async () => {
  const { dir, data, service, cleanup } = await repo();
  try {
    await service.enable({});
    const b = await service.readDocument("docs/b.md");
    const { range, quote } = await quoteOf(service, "docs/a.md", "Первый");
    await assert.rejects(service.annotate({ path: "docs/a.md", observation: { sha: b.sha }, range, quote, text: "x", kind: "note" }), (error) => error.code === "unverifiable");
    const shownA = await service.readDocument("docs/a.md");
    await fs.writeFile(path.join(dir, "docs/a.md"), "# A\n\nПервый абзац изменён.\n");
    // Lose the observation log: the comment on the old A must target the existing baseline revision.
    await fs.rm(path.join(data, "observations"), { recursive: true, force: true });
    const fresh = new ReviewService(dir, data);
    const created = await fresh.annotate({ path: "docs/a.md", observation: { sha: shownA.sha }, range, quote, text: "на старую A", kind: "note" });
    assert.equal(created.promoted, false);
    const state = await fresh.state();
    const docId = fresh.docIdOf(state, "docs/a.md");
    assert.equal(state.documents.get(docId).revisions.length, 1, "no parentless second revision");
    assert.ok((await fresh.validate()).ok);
  } finally {
    await cleanup();
  }
});

test("M5: a result covers its prepared slice, not what it claims to have seen; unprepared results cover nothing", async () => {
  const store = new MemoryBackend();
  const docId = id("doc");
  const revisionId = id("rev");
  const rev = revision({ revisionId, docId, blocks: [{ lineageId: `${revisionId}.0`, versionId: `${revisionId}.0`, content: "x" }] });
  await observe(store, rev, { register: true, reason: "baseline" });
  const annotationId = id("ann");
  const annotation = annotationObject({ repoId: id("repo"), annotationId, docId, revisionId, snapshotSha: rev.object.snapshot });
  await write(store, { changes: [{ type: "annotation.created", annotationId, docId, annotation: objectSha(annotation), kind: "action", messageId: id("m1") }], objects: [annotation] });
  const state0 = await stateOf(store);
  const seen = state0.heads.get(entity.annotation(annotationId));
  const runId = id("run");
  const items = [{ itemId: "item-1", annotationId, seenHeads: seen }];
  const manifest = { type: "BatchManifest", schemaVersion: SCHEMA_VERSION, runId, scope: { kind: "all" }, editScope: ["docs"], documents: [], items, requestedBy: { name: "Alice", email: "alice@example.com" } };
  await write(store, { changes: [{ type: "batch.prepared", runId, manifest: objectSha(manifest), items }], objects: [manifest] });
  const later = await write(store, { changes: [{ type: "message.appended", annotationId, messageId: id("m2"), text: "later" }] });
  const result = (runIdValue, itemId, responseId) => ({ type: "item.result-recorded", runId: runIdValue, attemptId: id("att"), itemId, responseId, annotationId, status: "done",
    seenHeads: [later.operation.id], messageId: id(`a-${responseId}`), before: [], after: [], claimedEdits: [] });
  await write(store, { actor: agent, changes: [{ type: "message.appended", annotationId, messageId: id(`a-${id("x")}`), text: "done" }, result(runId, "item-1", id("x"))] });
  await write(store, { actor: agent, changes: [result(id("other-run"), "item-9", id("y"))] });
  const view = discussion(await stateOf(store), annotationId);
  assert.deepEqual(view.instructions.map((instruction) => instruction.covered), [true, false], "the later message is not covered");
});

test("M6: a reused receipt id is answered as duplicate; a revoked one is refused", async () => {
  const { service, cleanup } = await repo();
  try {
    await service.enable({});
    const shown = await service.readDocument("docs/a.md");
    const receiptId = "11111111-1111-4111-8111-111111111111";
    const first = await service.acknowledge({ path: "docs/a.md", observation: { sha: shown.sha }, scope: "document", receiptId });
    const again = await service.acknowledge({ path: "docs/a.md", observation: { sha: shown.sha }, scope: "document", receiptId });
    assert.equal(first.status, "published");
    assert.equal(again.status, "duplicate");
  } finally {
    await cleanup();
  }
});

test("L1/L2: damaged config opens read-only; an interrupted enable is finished by running it again", async () => {
  const { dir, service, cleanup } = await repo();
  try {
    await fs.mkdir(path.join(dir, ".bb-docs"));
    await fs.writeFile(path.join(dir, ".bb-docs/config.json"), "{ not json");
    const status = await service.status();
    assert.equal(status.readOnly, true);
    await fs.rm(path.join(dir, ".bb-docs"), { recursive: true });
    // Interrupted after the base, before config: running enable again finishes without duplicates.
    await service.enable({});
    await fs.rm(path.join(dir, ".bb-docs/config.json"));
    service.invalidate();
    const second = await service.enable({});
    assert.equal(second.documents, 0, "already registered documents are not registered twice");
    assert.ok((await service.validate()).ok);
  } finally {
    await cleanup();
  }
});

test("L7: a plain folder inside an enclosing repository is not that repository", async () => {
  const { dir, cleanup } = await repo();
  try {
    await fs.mkdir(path.join(dir, "nested"));
    const info = await resolveCheckout(path.join(dir, "nested"));
    assert.equal(info.isRepo, false);
  } finally {
    await cleanup();
  }
});

test("re-review 1: several actions on one shown observation share one promoted revision", async () => {
  const { dir, service, cleanup } = await repo();
  try {
    await service.enable({});
    await fs.writeFile(path.join(dir, "docs/a.md"), "# A\n\nПервый абзац после правки.\n\nВторой абзац.\n");
    const first = await quoteOf(service, "docs/a.md", "Первый");
    const second = await quoteOf(service, "docs/a.md", "Второй");
    const shown = first.shown;
    await service.annotate({ path: "docs/a.md", observation: { sha: shown.sha }, range: first.range, quote: first.quote, text: "1", kind: "note" });
    await service.annotate({ path: "docs/a.md", observation: { sha: shown.sha }, range: second.range, quote: second.quote, text: "2", kind: "note" });
    await service.acknowledge({ path: "docs/a.md", observation: { sha: shown.sha }, scope: "document" });
    const state = await service.state();
    const doc = state.documents.get(service.docIdOf(state, "docs/a.md"));
    assert.equal(doc.revisions.length, 2, "baseline + one promotion");
    assert.equal(doc.headRevisions.length, 1);
    // A new document inside the roots, two comments on one read: one parentless revision.
    await fs.writeFile(path.join(dir, "docs/new.md"), "# New\n\nНовый текст.\n");
    const n1 = await quoteOf(service, "docs/new.md", "Новый");
    await service.annotate({ path: "docs/new.md", observation: { sha: n1.shown.sha }, range: n1.range, quote: n1.quote, text: "a", kind: "note" });
    await service.annotate({ path: "docs/new.md", observation: { sha: n1.shown.sha }, range: n1.range, quote: n1.quote, text: "b", kind: "note" });
    const after = await service.state();
    assert.equal(after.documents.get(service.docIdOf(after, "docs/new.md")).revisions.length, 1);
    assert.ok((await service.validate()).ok);
  } finally {
    await cleanup();
  }
});

test("re-review 2–4: revoked receipt id refused; service dirs in any case refused; enable checks .gitattributes first", async () => {
  const { dir, service, cleanup } = await repo();
  const outside = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-outside-")), "rc");
  try {
    await fs.writeFile(outside, "keep\n");
    await fs.symlink(outside, path.join(dir, ".gitattributes"));
    await assert.rejects(service.enable({ markGenerated: true }));
    await assert.rejects(fs.access(path.join(dir, ".bb-docs/config.json")), "nothing enabled");
    await fs.rm(path.join(dir, ".gitattributes"));
    await service.enable({});
    const shown = await service.readDocument("docs/a.md");
    const receiptId = "22222222-2222-4222-8222-222222222222";
    await service.acknowledge({ path: "docs/a.md", observation: { sha: shown.sha }, scope: "document", receiptId });
    await write(service.store, { actor: { kind: "human", name: "Owner", email: "owner@bb-docs.invalid" }, changes: [{ type: "read.revoked", receiptId, readerId: "owner@bb-docs.invalid" }] });
    service.invalidate();
    await assert.rejects(service.acknowledge({ path: "docs/a.md", observation: { sha: shown.sha }, scope: "document", receiptId }), (error) => error.code === "bad-input");
    await assert.rejects(service.readDocument(".BB-DOCS/x.md"), (error) => error.code === "bad-path");
    await assert.rejects(service.readDocument("Node_Modules/x.md"), (error) => error.code === "bad-path");
  } finally {
    await cleanup();
    await fs.rm(path.dirname(outside), { recursive: true, force: true });
  }
});
