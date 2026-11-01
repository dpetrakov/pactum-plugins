import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../core/canonical-json.ts";
import { sha256 } from "../core/hash.ts";
import { buildRevision, checkRevision, PARSER, project, PROJECTION_PROFILE, PROJECTION_VERSION, semanticDiff } from "../core/markdown/index.ts";
import { buildChain, loadSequence, read, revise, withSource } from "./markdown-helpers.mjs";

const hashOf = (source, index = 0) => project(source).blocks[index].semanticHash;

test("AC15 changing a link URL with the same text changes the block (inline and reference links)", () => {
  const seq = loadSequence("url-only");
  const { chain } = buildChain(seq);
  const [a, b] = [chain.a, chain.b];
  const i = a.projection.blocks.findIndex((x) => x.text.startsWith("Подробности"));
  assert.equal(a.projection.blocks[i].text, b.projection.blocks[i].text, "same visible text");
  assert.equal(a.projection.blocks[i].textHash, b.projection.blocks[i].textHash);
  assert.notEqual(a.projection.blocks[i].semanticHash, b.projection.blocks[i].semanticHash);
  assert.equal(b.revision.blocks[i].lineageId, a.revision.blocks[i].lineageId, "same lineage");
  assert.notEqual(b.revision.blocks[i].versionId, a.revision.blocks[i].versionId, "new version");
  const changes = semanticDiff(a, b);
  assert.deepEqual(changes.map((c) => [c.kinds, c.textChanged]), [[["edited"], false]]);
  assert.notEqual(hashOf("[a](https://x/1)"), hashOf("[a](https://x/2)"));
  assert.notEqual(hashOf('[a](https://x "t1")'), hashOf('[a](https://x "t2")'), "link title too");
  assert.notEqual(hashOf("[a][r]\n\n[r]: https://x/1"), hashOf("[a][r]\n\n[r]: https://x/2"), "definition URL reaches the paragraph");
  assert.equal(hashOf("[a][r]\n\n[r]: https://x/1"), hashOf("[a](https://x/1)"), "reference and inline link with the same URL are the same content");
});

test("F10 re-wrapping source lines only (same text and structure) does not change semanticHash", () => {
  const seq = loadSequence("rewrap");
  const { chain } = buildChain(seq);
  assert.notEqual(seq.versions.a, seq.versions.b);
  assert.deepEqual(chain.b.projection.blocks.map((x) => x.semanticHash), chain.a.projection.blocks.map((x) => x.semanticHash));
  assert.deepEqual(chain.b.revision.blocks.map((x) => x.versionId), chain.a.revision.blocks.map((x) => x.versionId), "versions kept");
  assert.deepEqual(semanticDiff(chain.a, chain.b), []);
  assert.equal(hashOf("Setext\n===="), hashOf("# Setext"), "setext and ATX headings");
  assert.equal(hashOf("```\ncode\n```"), hashOf("    code"), "fenced and indented code without info");
  assert.notEqual(hashOf("a *b* c"), hashOf("a b c"), "formatting that changes the presentation is tracked");
  assert.notEqual(hashOf("a b"), hashOf("a  \nb"), "a hard break is not a re-wrap");
});

test("T03 list state, image alt/src and table structure are part of the fingerprint", () => {
  assert.notEqual(hashOf("- [ ] x"), hashOf("- [x] x"), "checkbox");
  assert.notEqual(hashOf("- x"), hashOf("1. x"), "ordered");
  assert.notEqual(hashOf("1. x"), hashOf("3. x"), "start");
  assert.notEqual(hashOf("- x"), hashOf("- a\n  - x", 1), "nesting depth");
  assert.equal(hashOf("- x"), hashOf("* x"), "bullet character is source formatting");
  assert.notEqual(hashOf("![a](s.png)"), hashOf("![b](s.png)"), "image alt");
  assert.notEqual(hashOf("![a](s.png)"), hashOf("![a](t.png)"), "image src");
  assert.notEqual(hashOf("x ![a](s.png) y"), hashOf("x ![a](t.png) y"), "inline image src");
  assert.equal(project("![a](s.png)").blocks[0].type, "image");
  const table = (align, extra = "") => `| h | g${extra} |\n|${align}|---${extra ? "|---" : ""}|\n| v | w${extra ? " | z" : ""} |`;
  assert.notEqual(hashOf(table("---"), 2), hashOf(table(":--"), 2), "column alignment");
  assert.notEqual(hashOf(table("---"), 2), hashOf(table("---", " | k"), 3), "column count");
  assert.notEqual(project("| v |\n|---|\n| h |").blocks[0].semanticHash, project("| h |\n|---|\n| v |").blocks[1].semanticHash, "header flag");
  assert.notEqual(hashOf("```js\nx\n```"), hashOf("```ts\nx\n```"), "code fence language");
  assert.notEqual(hashOf("> x"), hashOf("x"), "blockquote context");
  assert.notEqual(hashOf("a[^1]\n\n[^1]: n"), hashOf("a[^2]\n\n[^2]: n"), "footnote reference identifier");
  const fp = project("- [x] **a** [l](u)").blocks[0].fingerprint;
  assert.deepEqual(fp, { type: "listItem", attrs: { quote: 0, list: 1, footnote: null, checked: true, ordered: false, start: null }, inline: [{ open: "strong" }, "a", { close: "strong" }, " ", { open: "link", url: "u", title: null }, "l", { close: "link" }] });
});

test("T03 identical blocks are distinct lineages, not just equal hashes", () => {
  const { chain } = buildChain(loadSequence("dup-delete-second"));
  const blocks = chain.a.revision.blocks;
  assert.equal(blocks[3].semanticHash, blocks[7].semanticHash);
  assert.notEqual(blocks[3].lineageId, blocks[7].lineageId);
  assert.deepEqual(blocks.map((b) => b.lineageId), blocks.map((_, n) => `dup-delete-second:a.${n}`));
});

test("T03 Revision records schema, parser and projection versions, snapshot and sorted parents", () => {
  const source = read("syntax/lists.md");
  const { revision, projection } = revise("r1", source);
  assert.equal(revision.type, "Revision");
  assert.equal(revision.schemaVersion, "1.0");
  assert.deepEqual(revision.parser, PARSER);
  assert.deepEqual(revision.projection, { profile: PROJECTION_PROFILE, version: PROJECTION_VERSION });
  assert.equal(revision.snapshot, sha256(source));
  assert.equal(revision.blocks.length, projection.blocks.length);
  revision.blocks.forEach((b, i) => {
    assert.deepEqual(b.range, projection.blocks[i].range);
    assert.deepEqual(b.headings, projection.blocks[i].headings);
    assert.equal(b.textHash, sha256(projection.blocks[i].text));
    assert.equal(b.semanticHash, sha256(canonicalJson(projection.blocks[i].fingerprint)));
  });
  assert.doesNotThrow(() => canonicalJson(revision));
});

test("T03 lineage and version ids: born R.n, kept on one-to-one match, version kept iff semanticHash equal; A→B→A gives three versions", () => {
  const { chain } = buildChain(loadSequence("revert"));
  const [a, b, c] = [chain.a.revision, chain.b.revision, chain.c.revision];
  const i = 1; // The masked password field.
  assert.equal(a.blocks[i].lineageId, "revert:a.1");
  assert.equal(b.blocks[i].lineageId, "revert:a.1");
  assert.equal(c.blocks[i].lineageId, "revert:a.1");
  assert.deepEqual([a.blocks[i].versionId, b.blocks[i].versionId, c.blocks[i].versionId], ["revert:a.1", "revert:b.1", "revert:c.1"]);
  assert.equal(c.blocks[i].semanticHash, a.blocks[i].semanticHash);
  assert.equal(b.blocks[0].versionId, "revert:a.0", "unchanged heading keeps its version");
  assert.equal(b.blocks[3].lineageId, "revert:b.3", "new block");
  assert.deepEqual(c.removed.map((t) => [t.tombstoneId, t.lineageId, t.versionId, t.text]), [["revert:c~revert:b.3", "revert:b.3", "revert:b.3", "Новый абзац про двухфакторную аутентификацию."]]);
});

test("T03 buildRevision is a pure function: byte-identical canonicalJson twice and for permuted parents", () => {
  for (const name of ["real-guide", "split-merge", "table-rows"]) {
    const seq = loadSequence(name);
    const one = buildChain(seq);
    const two = buildChain(seq);
    for (const letter of one.letters) assert.equal(canonicalJson(one.chain[letter].revision), canonicalJson(two.chain[letter].revision), `${name}:${letter}`);
  }
  // A Git merge of two branches: parent order must not matter.
  const base = "# Д\n\nОбщий абзац один.\n\nОбщий абзац два.\n\nОбщий абзац три.\n";
  const left = base.replace("абзац один.", "абзац один, правка слева.");
  const right = base.replace("абзац три.", "абзац три, правка справа.");
  const merged = "# Д\n\nОбщий абзац один, правка слева.\n\nОбщий абзац два.\n\nОбщий абзац три, правка справа.\n\nНовый после слияния.\n";
  const A = withSource(revise("m:a", base), base);
  const L = withSource(revise("m:l", left, [A]), left);
  const R = withSource(revise("m:r", right, [A]), right);
  const m1 = revise("m:m", merged, [L, R]).revision;
  const m2 = revise("m:m", merged, [R, L]).revision;
  assert.equal(canonicalJson(m1), canonicalJson(m2));
  assert.deepEqual(m1.parents, ["m:l", "m:r"]);
  assert.deepEqual(m1.blocks.map((b) => b.lineageId), ["m:a.0", "m:a.1", "m:a.2", "m:a.3", "m:m.4"], "lineages present in both branches survive the merge");
  assert.equal(m1.blocks[1].versionId, "m:l.1", "version of the branch with the same content");
  assert.equal(m1.blocks[3].versionId, "m:r.3");
  assert.deepEqual(m1.removed, []);
});

test("T03 several parents: conflicting one-to-one claims make the block new (deterministic merge rule)", () => {
  // Two unrelated histories that both contain the same paragraph are merged: which lineage continues is unknowable.
  const text = "Одинаковый абзац в двух историях.\n";
  const X = withSource(revise("x:x", text), text);
  const Y = withSource(revise("x:y", text), text);
  const merged = revise("x:m", text, [Y, X]).revision;
  assert.deepEqual(merged.parents, ["x:x", "x:y"]);
  assert.deepEqual(merged.blocks.map((b) => [b.lineageId, b.versionId]), [["x:m.0", "x:m.0"]]);
  assert.deepEqual(merged.removed.map((t) => t.tombstoneId), ["x:m~x:x.0", "x:m~x:y.0"]);
  // Parents that agree keep the lineage.
  const base = "Первый общий абзац текста.\n\nВторой общий абзац текста.\n";
  const A = withSource(revise("z:a", base), base);
  const swapped = "Второй общий абзац текста.\n\nПервый общий абзац текста.\n";
  const S = withSource(revise("z:s", swapped, [A]), swapped);
  const agreed = revise("z:m", base, [A, S]).revision;
  assert.deepEqual(agreed.blocks.map((b) => b.lineageId), ["z:a.0", "z:a.1"]);
  assert.deepEqual(agreed.removed, []);
});

test("T03 Revision is reproducible from the snapshot: checkRevision recomputes blocks and lineage and reports tampering", () => {
  const seq = loadSequence("real-guide");
  const { chain, letters } = buildChain(seq);
  for (const [k, letter] of letters.entries()) {
    const parents = k ? [chain[letters[k - 1]]] : [];
    const result = checkRevision({ revision: chain[letter].revision, source: chain[letter].source, parents });
    assert.deepEqual(result, { ok: true, problems: [] }, letter);
  }
  const stored = JSON.parse(canonicalJson(chain.b.revision));
  const parents = [chain.a];
  const tamper = (edit) => {
    const copy = JSON.parse(JSON.stringify(stored));
    edit(copy);
    return checkRevision({ revision: copy, source: chain.b.source, parents }).problems;
  };
  assert.deepEqual(tamper((r) => (r.blocks[2].semanticHash = "0".repeat(64))), ["block 2: semanticHash differs"]);
  assert.deepEqual(tamper((r) => (r.blocks[2].range.end += 1)), ["block 2: range differs"]);
  assert.deepEqual(tamper((r) => (r.blocks[5].lineageId = "forged")), ["block 5: lineageId differs"]);
  assert.deepEqual(tamper((r) => (r.blocks[5].versionId = "forged")), ["block 5: versionId differs"]);
  assert.deepEqual(tamper((r) => r.removed.pop()), ["removed (tombstones) differ"]);
  assert.deepEqual(tamper((r) => r.blocks.pop()), [`blocks: ${stored.blocks.length - 1} stored, ${stored.blocks.length} recomputed`]);
  assert.match(checkRevision({ revision: stored, source: chain.b.source.replace("Write a precise instruction", "Write a forged instruction"), parents }).problems.join("\n"), /snapshot hash/);
  assert.match(checkRevision({ revision: stored, source: chain.b.source, parents: [] }).problems.join("\n"), /parents/);
});
