// EP-015-T01: restorable host caches (parsed .bb-docs files, parsed Markdown chunks) change only the time: the
// projection with the cache, without it, after deleting it and with a damaged cache file is the same.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJson } from "../core/canonical-json.ts";
import { clearParsedObjects, loadRepository, project } from "../core/journal.ts";
import { clearChunkCache } from "../core/markdown/parse.ts";
import { summary } from "../node/check.ts";
import { ReviewService } from "../node/service.ts";
import { clearViewCaches, documentView } from "../node/view.ts";

const para = "Абзац с **жирным**, `кодом` и [ссылкой](https://example.com) для проверки кеша. ".repeat(4);

async function setup() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-cache-")));
  const dir = path.join(base, "repo");
  await fs.mkdir(path.join(dir, "docs"), { recursive: true });
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Owner");
  git("config", "user.email", "owner@bb-docs.invalid");
  for (let index = 0; index < 30; index++) await fs.writeFile(path.join(dir, `docs/d${index}.md`), `# Документ ${index}\n\n${para}\n\n${para}\n`);
  // Large enough for chunked parsing and the worker pool.
  await fs.writeFile(path.join(dir, "docs/big.md"), Array.from({ length: 900 }, (_, index) => `## Раздел ${index}\n\n${para}\n\n- пункт ${index}\n- ещё\n`).join("\n"));
  const data = path.join(base, "data");
  const service = new ReviewService(dir, data);
  await service.enable({});
  await fs.writeFile(path.join(dir, "docs/d1.md"), `# Документ 1\n\n${para} правка\n`);
  const view = await documentView(service, "docs/d1.md");
  await service.annotate({ path: "docs/d1.md", observation: { sha: view.document.sha }, kind: "action", text: "кеш", targetKind: "block", block: 1 });
  return { base, dir, data, cleanup: () => fs.rm(base, { recursive: true, force: true }) };
}

/** A deterministic picture of the projection: order, heads, registers, documents, conflicts. */
function picture(state) {
  return canonicalJson({
    order: state.order,
    heads: [...state.heads].sort(),
    registers: [...state.registers].sort(([a], [b]) => (a < b ? -1 : 1)),
    documents: [...state.documents.values()].sort((a, b) => (a.docId < b.docId ? -1 : 1)),
    revisions: [...state.revisions.keys()].sort(),
    incomplete: [...state.incomplete], readOnly: [...state.readOnly], conflicts: state.conflicts,
  });
}

test("journal cache: a restart with the cache, without it, after deleting it and with a damaged file gives the same projection", async () => {
  const s = await setup();
  try {
    const full = picture(project(await loadRepository(new ReviewService(s.dir, path.join(s.base, "none")).store)));
    clearParsedObjects();
    const first = new ReviewService(s.dir, s.data);
    assert.equal(picture(await first.state()), full, "the run that fills the cache");
    const cacheFile = first.journalCache.file;
    assert.ok((await fs.stat(cacheFile)).size > 0, "the cache was written");
    clearParsedObjects();
    const restarted = new ReviewService(s.dir, s.data);
    assert.equal(picture(await restarted.state()), full, "from the cache");
    assert.equal(await summary(restarted, "owner@bb-docs.invalid"), await summary(first, "owner@bb-docs.invalid"));
    await fs.writeFile(cacheFile, "{ damaged");
    clearParsedObjects();
    assert.equal(picture(await new ReviewService(s.dir, s.data).state()), full, "a damaged cache is ignored");
    await fs.rm(path.dirname(cacheFile), { recursive: true, force: true });
    clearParsedObjects();
    assert.equal(picture(await new ReviewService(s.dir, s.data).state()), full, "deleting the cache changes nothing");
    // New events after the cache was written are read from the files.
    const service = new ReviewService(s.dir, s.data);
    const view = await documentView(service, "docs/d2.md");
    await service.annotate({ path: "docs/d2.md", observation: { sha: view.document.sha }, kind: "note", text: "после кеша", targetKind: "document" });
    clearParsedObjects();
    const again = await new ReviewService(s.dir, s.data).state();
    assert.equal(picture(again), picture(project(await loadRepository(new ReviewService(s.dir, path.join(s.base, "none2")).store))));
  } finally {
    await s.cleanup();
  }
});

test("chunk cache on disk: the first view of a large document after a restart equals the view without any cache", async () => {
  const s = await setup();
  try {
    const strip = (view) => canonicalJson({ blocks: view.blocks, removed: view.removed, unread: view.unread, annotations: view.annotations.map((a) => [a.annotationId, a.anchor]) });
    clearChunkCache(); clearViewCaches();
    const none = strip(await documentView(new ReviewService(s.dir, path.join(s.base, "no-cache")), "docs/big.md"));
    clearChunkCache(); clearViewCaches();
    const filling = new ReviewService(s.dir, s.data);
    assert.equal(strip(await documentView(filling, "docs/big.md")), none);
    // Let the background writes of parsed chunks land.
    for (let attempt = 0; attempt < 50; attempt++) {
      const names = await fs.readdir(path.join(s.data, "chunks")).catch(() => []);
      if (names.filter((name) => name.endsWith(".json")).length) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    clearChunkCache(); clearViewCaches();
    clearParsedObjects();
    const restarted = new ReviewService(s.dir, s.data);
    assert.equal(strip(await documentView(restarted, "docs/big.md")), none, "parts from disk give the same view");
    // A damaged chunk file is a miss, never a wrong parse.
    for (const name of await fs.readdir(path.join(s.data, "chunks"))) await fs.writeFile(path.join(s.data, "chunks", name), "{\"key\":\"x\",\"children\":[]}");
    clearChunkCache(); clearViewCaches();
    assert.equal(strip(await documentView(new ReviewService(s.dir, s.data), "docs/big.md")), none, "foreign or damaged chunk files are ignored");
  } finally {
    await s.cleanup();
  }
});
