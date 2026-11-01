// W-06f (EP-060-T01…T03, T07; EP-062-T03 data part): format 1.3 — a reader's personal layout of a Mermaid block.
// Gates and schema; the service write with an exact read-back; per-node merge of two machines, a conflict of one node
// and its resolution by the reader's next write; another actor is ignored (validate foreign-layout); transfer with the
// document to Git; the previous release (document-review-v1.5.2) opens 1.3 data read-only only for the layout entity,
// the document and the reader's receipts stay writable, nothing is lost; the current release reads the pins again.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { newId, sha256 } from "../core/hash.ts";
import { entity, loadRepository, operationEntities, parentsFor, project } from "../core/journal.ts";
import { layoutOf } from "../core/layouts.ts";
import { operationVersion, parseOperation, requiredVersion } from "../core/schema.ts";
import { publish } from "../core/store.ts";
import { localFor, trackLocally } from "../node/local.ts";
import { batchGet, prepareBatch } from "../node/batches.ts";
import { ReviewService } from "../node/service.ts";
import { transferDocument } from "../node/transfer.ts";
import { documentView } from "../node/view.ts";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = process.env.PACTUM_PREVIOUS_REPOSITORY ?? path.resolve(pluginDir, "../..");
const PREVIOUS = "document-review-v1.5.2";
function spawnPreviousUnavailable() {
  try { execFileSync("git", ["rev-parse", "--verify", PREVIOUS], { cwd: repoRoot, stdio: "pipe" }); return false; }
  catch { return "Historical source drill requires PACTUM_PREVIOUS_REPOSITORY; current schema compatibility remains covered by format tests"; }
}
const DIAGRAM = "# Схема\n\n```mermaid\nflowchart LR\n  A --> C\n  C --> G\n```\n";

async function repo(extra = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-13-")));
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Owner");
  git("config", "user.email", "owner@bb-docs.invalid");
  await fs.mkdir(path.join(dir, "docs"), { recursive: true });
  await fs.writeFile(path.join(dir, "docs/a.md"), DIAGRAM);
  for (const [file, text] of Object.entries(extra)) { await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await fs.writeFile(path.join(dir, file), text); }
  git("add", "-A"); git("commit", "-q", "-m", "init");
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-13-data-"));
  const service = new ReviewService(dir, data);
  await service.enable({ roots: ["."] });
  return { dir, data, git, service, cleanup: () => Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]) };
}
const diagramBlock = (view) => view.layouts[0]?.block ?? view.blocks.findIndex((block) => block.type === "code");

async function digest(dir) {
  const out = [];
  const walk = async (current) => {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full); else out.push(`${path.relative(dir, full)} ${createHash("sha256").update(await fs.readFile(full)).digest("hex")}`);
    }
  };
  await walk(dir);
  return sha256(out.join("\n"));
}

test("1.3 gates: layout changes need 1.3; duplicate nodes and out-of-range coordinates are refused", () => {
  const scope = { doc: newId(), lineage: `${newId()}.1`, reader: "owner@bb-docs.invalid" };
  const pinned = { type: "layout.pinned", scope, revisionId: newId(), engine: "dagre-3.1.1+route-1", nodes: [{ id: "C", x: 10, y: -20 }] };
  assert.equal(requiredVersion({ changes: [pinned] }), "1.3");
  const op = (schemaVersion, changes) => ({ schemaVersion, id: newId(), actor: { kind: "human", name: "O", email: "owner@bb-docs.invalid" }, timestamp: "2026-10-09T08:00:00.000Z", parents: [], changes });
  assert.equal(parseOperation(op("1.3", [pinned])).ok, true);
  assert.equal(parseOperation(op("1.2", [pinned])).ok, false, "declared below the required minor");
  assert.equal(parseOperation(op("1.3", [{ ...pinned, nodes: [{ id: "C", x: 1, y: 1 }, { id: "C", x: 2, y: 2 }] }])).ok, false);
  assert.equal(parseOperation(op("1.3", [{ ...pinned, nodes: [{ id: "C", x: 1.5, y: 1 }] }])).ok, false, "integers only");
  assert.equal(parseOperation(op("1.3", [{ ...pinned, nodes: [{ id: "C", x: 200_000, y: 1 }] }])).ok, false);
  assert.equal(parseOperation(op("1.3", [{ type: "layout.unpinned", scope, revisionId: newId(), nodes: ["C"] }])).ok, true);
});

test("service: a finished gesture is written by the reader and read back exactly; the view carries the pins; reset unpins", async () => {
  const r = await repo();
  try {
    let view = await documentView(r.service, "docs/a.md");
    assert.equal(view.layouts.length, 1, "one Mermaid block");
    const block = diagramBlock(view);
    const saved = await r.service.layout({ path: "docs/a.md", observation: { sha: view.document.sha }, block, engine: "test@0/engine", pins: [{ id: "C", x: 120, y: 80 }, { id: "G", x: 300, y: 80 }] });
    assert.deepEqual(saved.pins, { C: { x: 120, y: 80 }, G: { x: 300, y: 80 } });
    r.service.invalidate();
    view = await documentView(r.service, "docs/a.md");
    assert.deepEqual(view.layouts[0].pins, { C: { x: 120, y: 80 }, G: { x: 300, y: 80 } });
    assert.equal(view.layouts[0].readOnly, null);
    const events = [...(await loadRepository(r.service.store)).events.values()].filter((event) => event.changes.some((change) => change.type.startsWith("layout.")));
    assert.ok(events.every((event) => event.schemaVersion === "1.3"));
    assert.ok(events[0].changes.find((change) => change.type === "layout.pinned").scope.reader === "owner@bb-docs.invalid");
    const reset = await r.service.layout({ path: "docs/a.md", observation: { sha: view.document.sha }, block, unpin: ["C", "G"] });
    assert.deepEqual(reset.pins, {});
    // Editing the diagram source keeps the lineage: pins of known nodes still apply.
    await r.service.layout({ path: "docs/a.md", observation: { sha: view.document.sha }, block, engine: "test@0/engine", pins: [{ id: "C", x: 50, y: 60 }] });
    await fs.writeFile(path.join(r.dir, "docs/a.md"), DIAGRAM.replace("C --> G", "C --> G\n  G --> A"));
    r.service.invalidate();
    const edited = await documentView(r.service, "docs/a.md");
    assert.deepEqual(edited.layouts[0].pins, { C: { x: 50, y: 60 } }, "the pin follows the block lineage after an edit");
    assert.equal((await r.service.validate()).ok, true);
  } finally { await r.cleanup(); }
});

test("two machines of one reader: different nodes merge; one node with two values is a conflict; the reader's next write settles it; another actor is ignored", async () => {
  const r = await repo();
  try {
    const view = await documentView(r.service, "docs/a.md");
    const block = diagramBlock(view);
    await r.service.layout({ path: "docs/a.md", observation: { sha: view.document.sha }, block, engine: "test@0/engine", pins: [{ id: "A", x: 0, y: 0 }] });
    let state = await r.service.state();
    const layoutEvent = [...state.events.values()].find((event) => event.changes.some((change) => change.type === "layout.pinned"));
    const scope = layoutEvent.changes.find((change) => change.type === "layout.pinned").scope;
    const owner = { kind: "human", name: "Owner", email: "owner@bb-docs.invalid" };
    const base = parentsFor(state, [entity.layout(scope)]);
    const write = async (actor, changes) => {
      const operation = { schemaVersion: operationVersion(changes), id: newId(), actor, timestamp: "2026-10-09T09:00:00.000Z", parents: base, changes };
      await publish(r.service.store, { operation, objects: [], snapshots: [] }, { isKnownRevision: (id) => state.revisions.has(id) });
    };
    const { revisionId } = layoutEvent.changes.find((change) => change.type === "layout.pinned");
    const pin = (id, x, y) => ({ type: "layout.pinned", scope, revisionId, engine: "dagre-3.1.1+route-1", nodes: [{ id, x, y }] });
    // Machine 1 and machine 2 from the same base: different nodes.
    await write(owner, [pin("C", 10, 10)]);
    await write(owner, [pin("G", 20, 20)]);
    r.service.invalidate();
    state = project(await loadRepository(r.service.store));
    let layout = layoutOf(state, scope);
    assert.deepEqual(layout.pins, { A: { x: 0, y: 0 }, C: { x: 10, y: 10 }, G: { x: 20, y: 20 } }, "different nodes merge");
    assert.deepEqual(layout.conflicts, []);
    // Same node, two values from the same base: a conflict of that node only.
    await write(owner, [pin("A", 50, 50)]);
    await write(owner, [pin("A", 99, 99)]);
    r.service.invalidate();
    state = project(await loadRepository(r.service.store));
    layout = layoutOf(state, scope);
    assert.deepEqual(layout.conflicts.map((conflict) => conflict.node), ["A"]);
    assert.equal(layout.pins.A, undefined, "a conflicting node has no single value");
    // The reader chooses: the next write descends from both and settles the node.
    const fresh = await documentView(r.service, "docs/a.md");
    assert.deepEqual(fresh.layouts[0].conflicts.map((conflict) => conflict.node), ["A"]);
    const settled = await r.service.layout({ path: "docs/a.md", observation: { sha: fresh.document.sha }, block, engine: "test@0/engine", pins: [{ id: "A", x: 99, y: 99 }] });
    assert.deepEqual(settled.conflicts, []);
    assert.deepEqual(settled.pins.A, { x: 99, y: 99 });
    // Another actor cannot write this reader's layout: ignored by the projection, reported by validate.
    state = project(await loadRepository(r.service.store));
    await publish(r.service.store, { operation: { schemaVersion: "1.3", id: newId(), actor: { kind: "human", name: "Bob", email: "bob@bb-docs.invalid" }, timestamp: "2026-10-09T10:00:00.000Z",
      parents: parentsFor(state, [entity.layout(scope)]), changes: [pin("C", 777, 777)] }, objects: [], snapshots: [] }, { isKnownRevision: (id) => state.revisions.has(id) });
    r.service.invalidate();
    state = project(await loadRepository(r.service.store));
    assert.deepEqual(layoutOf(state, scope).pins.C, { x: 10, y: 10 });
    const report = await r.service.validate();
    assert.ok(report.problems.some((problem) => problem.code === "foreign-layout"));
  } finally { await r.cleanup(); }
});

test("transfer: the reader's layout moves with a local document to Git", async () => {
  const r = await repo({ ".gitignore": "notes/\n" });
  try {
    await fs.mkdir(path.join(r.dir, "notes"), { recursive: true });
    await fs.writeFile(path.join(r.dir, "notes/flow.md"), DIAGRAM);
    await trackLocally(r.service, { path: "notes/flow.md", isDir: false, action: "add" });
    const local = await localFor(r.service);
    const view = await documentView(local, "notes/flow.md");
    await local.layout({ path: "notes/flow.md", observation: { sha: view.document.sha }, block: diagramBlock(view), engine: "test@0/engine", pins: [{ id: "C", x: 5, y: 6 }] });
    r.git("add", "-f", "notes/flow.md"); r.git("commit", "-q", "-m", "in Git");
    r.service.invalidate(); local.invalidate();
    await transferDocument(r.service, { path: "notes/flow.md", direction: "to-git" });
    r.service.invalidate();
    const shared = await documentView(r.service, "notes/flow.md");
    assert.deepEqual(shared.layouts[0].pins, { C: { x: 5, y: 6 } });
    assert.equal((await r.service.validate()).ok, true);
  } finally { await r.cleanup(); }
});

test("previous release (document-review-v1.5.2) on 1.3 data: only the layout entity is read-only; the document and receipts stay writable; nothing lost; new release reads pins again", { skip: !process.env.PACTUM_PREVIOUS_REPOSITORY && spawnPreviousUnavailable() }, async () => {
  const r = await repo();
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-13-prev-")));
  try {
    const view = await documentView(r.service, "docs/a.md");
    await r.service.layout({ path: "docs/a.md", observation: { sha: view.document.sha }, block: diagramBlock(view), engine: "test@0/engine", pins: [{ id: "C", x: 1, y: 2 }] });
    r.service.invalidate();
    // A document first recorded together with a 1.3 write (an element annotation on a never-read file): the promotion
    // is its own operation, so the previous release still sees the document — only the annotation is read-only.
    await fs.writeFile(path.join(r.dir, "docs/fresh.md"), DIAGRAM);
    r.git("add", "docs/fresh.md"); r.git("commit", "-q", "-m", "fresh");
    r.service.invalidate();
    const freshView = await documentView(r.service, "docs/fresh.md");
    await r.service.annotate({ path: "docs/fresh.md", observation: { sha: freshView.document.sha }, text: "к узлу", kind: "note", targetKind: "block", block: diagramBlock(freshView), element: { id: "C", kind: "node", label: "C" } });
    r.service.invalidate();
    const before = await digest(path.join(r.dir, ".bb-docs"));
    const target = path.join(base, "previous");
    await fs.mkdir(target, { recursive: true });
    const tar = execFileSync("git", ["archive", PREVIOUS, "plugins/document-review/core", "plugins/document-review/node"], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
    const archive = path.join(base, "previous.tar");
    await fs.writeFile(archive, tar);
    execFileSync("tar", ["-xf", archive, "-C", target]);
    await fs.symlink(path.join(pluginDir, "node_modules"), path.join(target, "plugins/document-review/node_modules"));
    const previous = path.join(target, "plugins/document-review");
    const { ReviewService: Previous } = await import(pathToFileURL(path.join(previous, "node/service.ts")).href);
    const { documentView: previousView } = await import(pathToFileURL(path.join(previous, "node/view.ts")).href);
    const old = new Previous(r.dir, path.join(base, "data-old"));
    const oldState = await old.state();
    const docId = [...oldState.documents.keys()][0];
    assert.equal(oldState.repoReadOnly.length, 0, "a newer minor event does not lock the whole catalog");
    assert.equal(oldState.documents.size, 2, "the previous release sees both documents, including the one first recorded next to a 1.3 write");
    const freshId = [...oldState.documents.values()].find((entry) => entry.path === "docs/fresh.md")?.docId;
    assert.ok(freshId);
    assert.equal((oldState.readOnly.get(`doc:${freshId}`) ?? []).length + (oldState.incomplete.get(`doc:${freshId}`) ?? []).length, 0, "that document is writable in the previous release");
    assert.equal((oldState.readOnly.get(`doc:${docId}`) ?? []).length + (oldState.incomplete.get(`doc:${docId}`) ?? []).length, 0, "the document is not locked");
    assert.equal((oldState.readOnly.get("reader:owner@bb-docs.invalid") ?? []).length, 0, "the reader's receipts are not locked");
    assert.equal(await digest(path.join(r.dir, ".bb-docs")), before, "reading changed nothing");
    // The previous release still writes: a receipt for the document.
    const oldDoc = await previousView(old, "docs/a.md");
    await old.acknowledge({ path: "docs/a.md", observation: { sha: oldDoc.document.sha }, scope: "document" });
    // Back to the current release: the pins are there, the old receipt too, validate OK.
    const again = new ReviewService(r.dir, r.data);
    const now = await documentView(again, "docs/a.md");
    assert.deepEqual(now.layouts[0].pins, { C: { x: 1, y: 2 } });
    assert.equal(now.unread, 0, "the receipt written by the previous release counts");
    assert.equal((await again.validate()).ok, true);
  } finally { await r.cleanup(); await fs.rm(base, { recursive: true, force: true }); }
});

test("previous version of a diagram (EP-061-T01): the ancestor where the block differs; a new block has none; nothing is written by viewing", async () => {
  const r = await repo();
  try {
    const file = path.join(r.dir, "docs/a.md");
    const read = async () => { r.service.invalidate(); const view = await documentView(r.service, "docs/a.md"); await r.service.acknowledge({ path: "docs/a.md", observation: { sha: view.document.sha }, scope: "document" }); };
    await read();
    await fs.writeFile(file, DIAGRAM.replace("C --> G", "C --> G\n  G --> A"));
    await read();
    // An edit elsewhere: the diagram's previous version is still the one before its own last change.
    await fs.writeFile(file, DIAGRAM.replace("C --> G", "C --> G\n  G --> A") + "\nТекст после схемы.\n\n```mermaid\nflowchart TB\n  X --> Y\n```\n");
    await read();
    r.service.invalidate();
    const events = (await loadRepository(r.service.store)).events.size;
    const view = await documentView(r.service, "docs/a.md");
    const [first, second] = view.layouts;
    assert.equal(first.previous.kind, "version");
    assert.equal(first.previous.base.text, DIAGRAM.split("```mermaid\n")[1].split("```")[0].trimEnd());
    assert.ok(first.previous.base.diff.words.some((word) => word.op === "insert" && word.text.includes("G")));
    assert.ok(first.previous.base.at);
    assert.deepEqual(second.previous, { kind: "none", reason: "added" });
    r.service.invalidate();
    assert.equal((await loadRepository(r.service.store)).events.size, events, "viewing and comparing write nothing");
  } finally { await r.cleanup(); }
});

test("annotations to elements of an object (EP-073-T08): stored as bbdr:ObjectSelector at 1.3, shown with the element, handed to the agent with its words and line", async () => {
  const r = await repo();
  try {
    const view = await documentView(r.service, "docs/a.md");
    const block = diagramBlock(view);
    const made = await r.service.annotate({ path: "docs/a.md", observation: { sha: view.document.sha }, text: "Переименуйте узел", kind: "action", targetKind: "block", block,
      element: { id: "C", kind: "node", label: "C", range: { line: 2, start: 9, end: 10 } } });
    assert.ok(made.annotationId);
    r.service.invalidate();
    const after = await documentView(r.service, "docs/a.md");
    const note = after.annotations.find((entry) => entry.annotationId === made.annotationId);
    assert.deepEqual(note.element, { id: "C", kind: "node", label: "C" });
    assert.deepEqual(note.anchor.blocks, [block], "the annotation sits on the block of the object");
    const objects = [...(await loadRepository(r.service.store)).objects.values()].filter((object) => object.type === "Annotation");
    const stored = objects.find((object) => object.id.endsWith(made.annotationId));
    assert.equal(stored["bbdr:schemaVersion"], "1.3");
    assert.ok(stored.target.selector.some((selector) => selector.type === "bbdr:ObjectSelector" && selector.id === "C" && selector.range.line === 2));
    await assert.rejects(r.service.annotate({ path: "docs/a.md", observation: { sha: view.document.sha }, text: "x", kind: "note", targetKind: "block", block: 0, element: { id: "C", kind: "node", label: "C" } }), /fenced block/);
    assert.equal((await r.service.validate()).ok, true);
    // The agent's packet names the element and its line in the block.
    const prepared = await prepareBatch(r.service, { scope: { kind: "document", path: "docs/a.md" }, recipient: { mode: "current-thread", threadId: "thr_vis" } });
    const batch = await batchGet(r.service, { runId: prepared.runId, threadId: "thr_vis" });
    const item = batch.items.find((entry) => entry.annotationId === made.annotationId);
    assert.deepEqual(item.element, { id: "C", kind: "node", label: "C", lineInBlock: 2 });
  } finally { await r.cleanup(); }
});
