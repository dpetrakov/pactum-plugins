// W-06a (EP-027-T07/T08): the fast path of a document (text without review state; first screens, around a heading,
// the rest), the host tree's reuse while nothing changed, the height estimate of blocks not mounted yet.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bigMarkdown } from "../node/perf.ts";
import { ReviewService } from "../node/service.ts";
import { documentTree } from "../node/tree.ts";
import { documentText, documentView } from "../node/view.ts";
import { blockAt, estimateHeight, windowAround, WINDOW_FROM } from "../ui/progressive.ts";
import { project } from "../core/markdown/index.ts";
import { applyOverlay, decodeBlocks, encodeBlocks, encodeOverlay, headingStack, lineageKey } from "../core/wire.ts";
import { compactView } from "../node/view.ts";
import { corpusDocuments, read } from "./markdown-helpers.mjs";
import { slug } from "../ui/route.ts";

async function repo(files) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-text-")));
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
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-text-data-"));
  const service = new ReviewService(dir, data);
  await service.enable({ roots: ["docs"] });
  return { dir, service, cleanup: () => Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]) };
}

test("fast path: the same blocks and text as the full view, without review state; nothing is recorded", async () => {
  const r = await repo({ "docs/a.md": "# Заголовок\n\nПервый абзац.\n\n## Раздел\n\n- пункт\n" });
  try {
    const text = await documentText(r.service, "docs/a.md");
    const full = await documentView(r.service, "docs/a.md");
    assert.equal(text.sha, full.document.sha);
    assert.equal(text.total, full.blocks.length);
    const blocks = decodeBlocks(text.blocks, 0);
    assert.deepEqual(blocks.map((block) => [block.index, block.type, block.text, block.range.start, block.headings.join(",")]), full.blocks.map((block) => [block.index, block.type, block.text, block.range.start, block.headings.join(",")]));
    // The compact full view: the overlay applied to the fast path's text gives the full view's blocks.
    const compact = compactView(full);
    assert.deepEqual(compact.blocks, []);
    const merged = applyOverlay(blocks, compact.overlay);
    assert.deepEqual(merged.map((block) => [block.read, block.change, block.lineageId]), full.blocks.map((block) => [block.read, block.change, lineageKey(block.lineageId)]));
    assert.equal(new Set(merged.map((block) => block.lineageId)).size, merged.length, "lineage keys are unique within the document");
    assert.deepEqual(text.headings.map((heading) => heading.text), ["Заголовок", "Раздел"]);
    assert.equal(text.lengths, null, "a whole document needs no estimate");
    await assert.rejects(documentText(r.service, "docs/missing.md"), (error) => error.code === "not-found");
    await assert.rejects(documentText(r.service, "../outside.md"), (error) => /outside|bad-path|repo/i.test(`${error.code} ${error.message}`));
  } finally {
    await r.cleanup();
  }
});

test("fast path of a 1 MiB document: the first screens, then from a heading in the middle; lengths for the estimate", async () => {
  const r = await repo({ "docs/big.md": bigMarkdown() });
  try {
    const first = await documentText(r.service, "docs/big.md", { limit: 400 });
    assert.equal(first.from, 0);
    assert.equal(first.blocks.length, 400);
    assert.ok(first.total > 10_000);
    assert.equal(first.lengths.length, first.total);
    const middle = first.headings.find((heading) => heading.text === "Раздел 500");
    const around = await documentText(r.service, "docs/big.md", { limit: 400, around: slug("Раздел 500"), slug });
    assert.ok(around.from <= middle.index && middle.index < around.from + around.blocks.length, "the target heading is in the first answer");
    assert.equal(decodeBlocks(around.blocks, around.from, headingStack(around.headings, around.from))[0].index, around.from);
    assert.ok(JSON.stringify(first).length < 200_000, "the first answer of a 1 MiB document is small");
    const rest = await documentText(r.service, "docs/big.md");
    assert.equal(rest.blocks.length, rest.total);
    assert.equal(rest.sha, first.sha);
  } finally {
    await r.cleanup();
  }
});

test("host tree is reused while files, journal and rules are the same; a change is seen at once", async () => {
  const r = await repo({ "docs/a.md": "# A\n\nтекст\n", "docs/b.md": "# B\n" });
  try {
    const first = await documentTree(r.service, { budgetMs: 30_000 });
    const again = await documentTree(r.service, { budgetMs: 30_000 });
    assert.ok("reused" in again.phases, "the second call reuses the tree");
    assert.deepEqual(again.entries, first.entries);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(path.join(r.dir, "docs/a.md"), "# A\n\nтекст изменён\n");
    const changed = await documentTree(r.service, { budgetMs: 30_000 });
    assert.ok(!("reused" in changed.phases), "a changed file is recomputed");
    assert.equal(changed.entries.find((entry) => entry.path === "docs/a.md").state, "unread");
    await fs.writeFile(path.join(r.dir, "docs/c.md"), "# C\n");
    const added = await documentTree(r.service, { budgetMs: 30_000 });
    assert.ok(added.entries.some((entry) => entry.path === "docs/c.md"));
  } finally {
    await r.cleanup();
  }
});

test("height estimate of blocks not mounted: lines of the reading column plus block padding", () => {
  assert.equal(estimateHeight([], 80), 0);
  assert.equal(estimateHeight([10], 80), 34);
  assert.equal(estimateHeight([160], 80), 59);
  assert.equal(estimateHeight([0, 0], 80), 67, "an empty block still takes a line (2 × 33.5, rounded once)");
});

test("wire format: blocks of the whole corpus survive encode → decode (text, inline, attrs that render, headings), parts included", () => {
  for (const doc of corpusDocuments()) {
    const projection = project(read(doc));
    const plain = projection.blocks.map((block, index) => ({ index, type: block.type, range: block.range, text: block.text, inline: block.fingerprint.inline, attrs: block.fingerprint.attrs, depth: block.depth ?? null, cell: block.cell ?? null, headings: block.headings }));
    const headings = plain.filter((block) => block.type === "heading").map((block) => ({ index: block.index, text: block.text, depth: block.depth ?? 1 }));
    const norm = (blocks) => blocks.map((block) => ({ ...block, attrs: Object.fromEntries(Object.entries(block.attrs).filter(([, value]) => value !== null && value !== undefined)) }));
    assert.deepEqual(norm(decodeBlocks(encodeBlocks(plain), 0)), norm(plain), doc);
    const cut = Math.floor(plain.length / 2);
    const part = plain.slice(cut);
    assert.deepEqual(norm(decodeBlocks(encodeBlocks(part, headingStack(headings, cut)), cut, headingStack(headings, cut))), norm(part), `${doc} from ${cut}`);
  }
});

test("overlay: states, short lineage ids and rare extras round-trip; a wrong block count is refused", () => {
  const blocks = [
    { lineageId: "aaaaaaaa-1111-4000-8000-000000000001", read: "read", change: null, diff: null, movedFrom: null, moved: false },
    { lineageId: "bbbbbbbb-2222-4000-8000-000000000002", read: "unread", change: "edited", diff: { words: [], rewritten: false, before: "x" }, movedFrom: "Раздел", moved: false },
    { lineageId: "cccccccc-3333-4000-8000-000000000003", read: "ambiguous", change: "edited", diff: null, movedFrom: null, moved: false },
    { lineageId: "dddddddd-4444-4000-8000-000000000004", read: null, change: null, diff: null, movedFrom: "Другой", moved: true },
  ];
  const overlay = encodeOverlay("sha", blocks);
  const plain = blocks.map((_, index) => ({ index, type: "paragraph", range: { start: 0, end: 0 }, text: "", inline: [], attrs: {}, depth: null, cell: null, headings: [] }));
  const merged = applyOverlay(plain, overlay);
  assert.deepEqual(merged.map((block) => [block.lineageId, block.read, block.change, block.diff, block.movedFrom, block.moved]), blocks.map((block) => [lineageKey(block.lineageId), block.read, block.change, block.diff, block.movedFrom, block.moved]));
  assert.equal(overlay.extras.length, 2, "only blocks with a diff or a move carry extras");
  assert.throws(() => applyOverlay(plain.slice(1), overlay), /overlay of 4 blocks/);
});

test("windowed document (≥ WINDOW_FROM blocks): the window around a block and the block at an offset", () => {
  assert.ok(WINDOW_FROM >= 1000);
  assert.deepEqual(windowAround(0, 0, 18000), { start: 0, end: 500 });
  assert.deepEqual(windowAround(9000, 0, 18000), { start: 8850, end: 9350 });
  assert.deepEqual(windowAround(17990, 0, 18000), { start: 17500, end: 18000 });
  const prefix = new Float64Array([0, 30, 60, 100, 150]);
  assert.equal(blockAt(prefix, 0), 0);
  assert.equal(blockAt(prefix, 59), 1);
  assert.equal(blockAt(prefix, 60), 2);
  assert.equal(blockAt(prefix, 10_000), 3, "past the end: the last block");
});
