import assert from "node:assert/strict";
import test from "node:test";
import { buildRevision, project } from "../core/markdown/index.ts";
import { clearChunkCache, parseChunked } from "../core/markdown/parse.ts";
import { corpusDocuments, read } from "./markdown-helpers.mjs";

function synthetic(bytes) {
  const guide = read("real/review-guide.md");
  let out = "";
  for (let i = 0; Buffer.byteLength(out) < bytes; i += 1) out += `${guide.replace("# Document review", `# Document review ${i}`)}\n`;
  return out;
}

/** CPU time (user + system) of fn in ms: wall time on a loaded machine is not a property of the code. */
function cpu(fn) {
  const start = process.cpuUsage();
  const value = fn();
  const used = process.cpuUsage(start);
  return { ms: (used.user + used.system) / 1000, value };
}

test("H7 projection + buildRevision is roughly linear: 1 MiB under 3 s CPU, 1 MiB/256 KiB ratio under 6", () => {
  const small = synthetic(256 * 1024);
  const large = synthetic(1024 * 1024);
  project(small); // warm up the JIT
  const build = (source) => buildRevision({ revisionId: "p", docId: "d", path: "p.md", source, snapshot: "s", parents: [] });
  // The parser itself is measured: the incremental chunk cache (EP-012-T04) is emptied before each run.
  clearChunkCache();
  const s = cpu(() => build(small));
  clearChunkCache();
  const l = cpu(() => build(large));
  assert.ok(l.value.revision.blocks.length > 4000);
  assert.ok(l.ms < 3000, `1 MiB took ${l.ms.toFixed(0)} ms CPU`);
  assert.ok(l.ms / s.ms < 6, `1 MiB / 256 KiB = ${(l.ms / s.ms).toFixed(1)} (linear is 4)`);
  // With a parent (one edit), matching adds little on top of the projection.
  const edited = large.replace("explain the change", "explain the change in detail");
  clearChunkCache();
  const withParent = cpu(() => buildRevision({ revisionId: "q", docId: "d", path: "p.md", source: edited, snapshot: "t", parents: [{ ...l.value, source: large }] }));
  assert.ok(withParent.ms < 3 * l.ms + 500, `with parent ${withParent.ms.toFixed(0)} ms CPU`);
});

test("chunked parsing gives exactly the whole-document projection (corpus and large concatenations)", () => {
  const docs = corpusDocuments().map((doc) => read(doc).replace(/^﻿/, ""));
  const big = [docs.join("\n\n"), synthetic(160 * 1024), docs.filter((d) => !d.includes("<script")).join("\n\n")];
  let chunked = 0;
  for (const source of [...docs, ...big]) {
    if (parseChunked(source)) chunked += 1;
    const a = project(source);
    const b = project(source, { wholeDocument: true });
    assert.equal(a.text, b.text);
    assert.deepEqual(a.blocks, b.blocks);
    assert.deepEqual(a.srcStart, b.srcStart);
    assert.deepEqual(a.srcEnd, b.srcEnd);
  }
  assert.ok(chunked >= 3, `chunked documents: ${chunked}`);
  // Constructs that must stop or prevent a chunk boundary.
  const pad = "Абзац для объёма текста, чтобы части были достаточно большими. ".repeat(140);
  const tricky = [
    `${pad}\n\n[ссылка][далеко] и сноска[^n].\n\n${pad}\n\n\`\`\`\nкод\n\nстрока с нуля\n\`\`\`\n\n${pad}\n\n<!--\n\nкомментарий\n\n-->\n\n${pad}\n\n1. один\n\n2. два\n\n${pad}\n\n[далеко]: https://example.com/far\n\n[^n]: Текст сноски.\n`,
    `${pad}\n\n<div>\n\n${pad}\n\n</div>\n\n${pad}\n\n> цитата\n\n> вторая\n\n${pad}\n\nконец [x]\n\n[x]: <https://x.example>\n`,
  ];
  for (const source of tricky) {
    assert.ok(parseChunked(source), "the tricky document is chunked");
    assert.deepEqual(project(source).blocks, project(source, { wholeDocument: true }).blocks);
  }
  assert.equal(parseChunked(`${pad}\n\n> [q]: https://quoted\n\n${pad}\n\n[q]\n`), null, "a nested definition disables chunking");
});
