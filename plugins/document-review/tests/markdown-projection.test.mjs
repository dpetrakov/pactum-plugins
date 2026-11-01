import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { decodeNamedCharacterReference } from "decode-named-character-reference";
import {
  blockSegments,
  PARSER,
  project,
  PROJECTION_PROFILE,
  PROJECTION_VERSION,
  projectionToSource,
  quoteAt,
  sliceText,
  sourceToProjection,
  TextCoords,
  verifyQuote,
} from "../core/markdown/index.ts";
import { CORPUS, corpusDocuments, read, readBytes, sequenceNames } from "./markdown-helpers.mjs";

function rangeOf(p, needle, from = 0) {
  const at = p.text.indexOf(needle, p.textCoords.cpToUtf16(from));
  assert.ok(at >= 0, `"${needle}" not in projection`);
  const start = p.textCoords.utf16ToCp(at);
  return { start, end: start + Array.from(needle).length };
}

function rawSlice(p, range) {
  return p.sourceCoords.slice(range);
}

/** Every projected code point must be explained by its raw span. */
function explained(char, raw) {
  if (raw === char) return true;
  if (/^[\s>]+$/u.test(raw) && /^\s$/u.test(char)) return true; // collapsed whitespace, line endings, container prefixes
  if (char === " " && /^\s/u.test(raw) && /\s$/u.test(raw)) return true; // one collapsed space for whitespace around dropped inline markup
  if (char === "\n" && (/^(\\|[ \t]{2,})?\r?\n?$/.test(raw) || /^ {2,}\r?\n$/.test(raw) || raw === "\\\n" || raw === "\\\r\n")) return true; // hard break
  if (raw === `\\${char}`) return true;
  const ref = /^&(#[xX]?[0-9a-fA-F]+|[A-Za-z0-9]+);$/.exec(raw);
  if (ref) {
    const name = ref[1];
    const decoded = name.startsWith("#") ? String.fromCodePoint(Number.parseInt(name.replace(/^#[xX]?/, ""), /^#[xX]/.test(name) ? 16 : 10) || 0xfffd) : decodeNamedCharacterReference(name);
    return typeof decoded === "string" && (decoded.includes(char) || decoded === "\u0000" || char === "�");
  }
  return false;
}

test("T01 corpus: every fixture file is listed with its source in fixtures/markdown/README.md", () => {
  const readme = fs.readFileSync(path.join(CORPUS, "README.md"), "utf8");
  for (const doc of corpusDocuments()) assert.ok(readme.includes(doc), `${doc} missing from README`);
  for (const name of sequenceNames()) assert.ok(readme.includes(`sequences/${name}`), `sequence ${name} missing from README`);
  assert.match(readme, /synthetic|public/i);
});

test("T01 corpus covers Cyrillic, emoji, links, tables, nested lists, duplicates, split/merge, rename/delete, revert", () => {
  const all = corpusDocuments().map((doc) => ({ doc, text: read(doc), p: project(read(doc)) }));
  const has = (predicate) => all.some(predicate);
  const types = new Set(all.flatMap(({ p }) => p.blocks.map((b) => b.type)));
  for (const type of ["heading", "paragraph", "listItem", "tableCell", "code", "image", "thematicBreak", "html", "frontmatter", "footnoteDefinition"]) {
    if (type === "thematicBreak" || type === "image") continue;
    assert.ok(types.has(type), `no ${type} block in corpus`);
  }
  assert.ok(has(({ text }) => /[а-яё]/i.test(text)), "Cyrillic");
  assert.ok(has(({ text }) => text.includes("‍")), "ZWJ emoji");
  assert.ok(has(({ text }) => /\p{Emoji_Modifier}/u.test(text)), "skin tone");
  assert.ok(has(({ text }) => /\p{M}/u.test(text)), "combining marks");
  assert.ok(has(({ p }) => p.blocks.some((b) => b.fingerprint.attrs.list >= 2)), "nested lists");
  assert.ok(has(({ p }) => p.blocks.some((b) => b.fingerprint.attrs.checked === true)), "task lists");
  assert.ok(has(({ p }) => p.blocks.some((b) => b.fingerprint.attrs.quote >= 2)), "nested blockquotes");
  assert.ok(has(({ text }) => /\]\[[^\]]*\]/.test(text)), "reference links");
  assert.ok(has(({ text }) => /&[a-z]+;/.test(text) && /\\\*/.test(text)), "entities and escapes");
  assert.ok(readBytes("syntax/crlf.md").includes(Buffer.from("\r\n")), "CRLF file keeps CRLF bytes");
  assert.ok(has(({ doc }) => doc.startsWith("real/")), "long-form public examples");
  const sequences = sequenceNames();
  for (const name of ["dup-delete-first", "dup-delete-second", "dup-adjacent", "split-merge", "section-move", "rename-delete", "revert", "url-only", "rewrap", "rewrite", "real-guide"]) {
    assert.ok(sequences.includes(name), `sequence ${name}`);
  }
});

test("T01 spike: the stack parses the whole corpus and the source map explains every projected code point", () => {
  for (const doc of corpusDocuments()) {
    const source = read(doc);
    const p = project(source);
    assert.equal(p.misses, 0, `${doc}: unexplained raw characters`);
    const text = Array.from(p.text);
    for (let i = 0; i < text.length; i += 1) {
      if (p.blockOf[i] < 0) {
        assert.equal(p.srcStart[i], p.srcEnd[i], "separators have no source");
        continue;
      }
      const raw = rawSlice(p, { start: p.srcStart[i], end: p.srcEnd[i] });
      assert.ok(explained(text[i], raw), `${doc}: projected ${JSON.stringify(text[i])} at ${i} from raw ${JSON.stringify(raw)}`);
    }
    for (const block of p.blocks) {
      assert.equal(sliceText(p, block.range), block.text);
      assert.ok(block.source.start <= block.source.end && block.source.end <= p.sourceCoords.length);
    }
    assert.deepEqual(project(source), p, `${doc}: projection is deterministic`);
  }
  assert.equal(PROJECTION_PROFILE, "bbdr-markdown");
  assert.equal(PROJECTION_VERSION, 1);
  assert.match(PARSER.version, /^2\.1\.0;gfm 3\.0\.0\/3\.1\.0;frontmatter 2\.0\.0\/2\.0\.1$/);
});

test("T01 profile v1: CRLF→LF and lone CR in the projection, raw bytes and BOM stay in the source", () => {
  const crlf = project(read("syntax/crlf.md"));
  assert.ok(!crlf.text.includes("\r"));
  assert.ok(crlf.source.includes("\r\n"));
  assert.equal(crlf.blocks.find((b) => b.type === "code").text, "code", "a CR inside code is a line ending too");
  const lf = project(read("syntax/crlf.md").replace(/\r\n/g, "\n"));
  assert.equal(lf.text, crlf.text, "same projection with LF");
  assert.deepEqual(lf.blocks.map((b) => b.semanticHash), crlf.blocks.map((b) => b.semanticHash));
  const cr = project(read("syntax/cr.md"));
  assert.deepEqual(cr.blocks.map((b) => b.text), ["Старый Mac", "Абзац продолжение.", "Второй."]);
  const bom = project(read("syntax/bom.md"));
  assert.ok(bom.source.startsWith("﻿"));
  assert.ok(bom.text.startsWith("С BOM"));
  assert.equal(bom.blocks[0].source.start, 1, "source offsets count the BOM");
  assert.equal(rawSlice(bom, bom.blocks[0].source), "# С BOM");
});

test("T01 profile v1: separators — blocks \\n\\n, table cells \\t, table rows \\n", () => {
  const p = project("# A\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\nP\n");
  assert.equal(p.text, "A\n\nx\ty\n1\t2\n\nP");
  const q = project("A\n\n---\n\n![i](s.png)\n\nB");
  assert.equal(q.text, "A\n\n\n\n\n\nB", "empty blocks (rule, image) keep their separators");
  assert.deepEqual(q.blocks.map((b) => b.type), ["paragraph", "thematicBreak", "image", "paragraph"]);
});

test("T01 profile v1: prose whitespace collapses and trims, hard break is \\n, code/html/frontmatter verbatim", () => {
  const p = project("  a \t b\n   c  \n\nx  \ny\\\nz\n\n```\n  k  \n\tl\n```\n\n<div>\n  h  </div>\n");
  assert.deepEqual(p.blocks.map((b) => b.text), ["a b c", "x\ny\nz", "  k  \n\tl", "<div>\n  h  </div>"]);
  const fm = project(read("syntax/frontmatter.md"));
  assert.equal(fm.blocks[0].type, "frontmatter");
  assert.equal(fm.blocks[0].text, "title: Документ\ntags: [a, b]");
  assert.equal(project("a  b").blocks[0].text, "a  b", "no-break spaces are not collapsed");
});

test("T01 profile v1: no NFC/NFD normalization", () => {
  const p = project(read("syntax/unicode.md"));
  const last = p.blocks[p.blocks.length - 1].text;
  assert.ok(last.includes("é") && last.includes("é"), "precomposed and decomposed forms kept apart");
  assert.notEqual(project("Café").blocks[0].semanticHash, project("Café").blocks[0].semanticHash);
});

test("T01 profile v1: generated and markup text excluded — list numbers, bullets, checkboxes, footnote marks, image alt, definitions", () => {
  const lists = project(read("syntax/lists.md"));
  for (const b of lists.blocks) assert.doesNotMatch(b.text, /^(\d+[.)]|[-*+]|\[[ x]\])\s/);
  const notes = project(read("syntax/footnotes.md"));
  assert.equal(notes.blocks[1].text, "Текст со сноской и второй.");
  const links = project(read("syntax/links.md"));
  assert.ok(!links.text.includes("https://example.com/ref"), "definitions contribute no text");
  assert.ok(!links.text.includes("логотип"), "image alt is not text");
  assert.equal(links.blocks[2].text, "Reference полная, collapsed и shortcut.");
});

test("T02 entities and escapes map back to their raw spans (&amp; → 5 code points, \\* → 2)", () => {
  const p = project(read("syntax/entities.md"));
  const amp = rangeOf(p, "AT&T");
  const [src] = projectionToSource(p, { start: amp.start + 2, end: amp.start + 3 });
  assert.equal(rawSlice(p, src), "&amp;");
  const star = rangeOf(p, "*не курсив*");
  assert.equal(rawSlice(p, projectionToSource(p, { start: star.start, end: star.start + 1 })[0]), "\\*");
  const two = rangeOf(p, "≧̸");
  assert.equal(rawSlice(p, projectionToSource(p, two)[0]), "&ngE;", "one reference, two code points");
  assert.deepEqual(sourceToProjection(p, projectionToSource(p, two)[0]), two);
  const quoted = project("> a\n> b &copy; c");
  assert.equal(quoted.blocks[0].text, "a b © c");
  assert.equal(rawSlice(quoted, projectionToSource(quoted, rangeOf(quoted, "a b © c"))[0]), "a\n> b &copy; c", "the source span includes the container prefix");
});

test("AC02 selection with a link, an emoji and two paragraphs: the quote matches, source and projection addresses stay apart", () => {
  const source = "# Заметка\r\n\r\nПервый абзац со [ссылкой](https://example.com/a?x=1&amp;y=2) и семьёй 👨‍👩‍👧 рядом.\r\n\r\nВторой **абзац** &amp; конец.\r\n";
  const p = project(source);
  const start = rangeOf(p, "ссылкой").start;
  const end = rangeOf(p, "Второй").end;
  const range = { start, end };
  const quote = quoteAt(p, range);
  assert.equal(quote.exact, "ссылкой и семьёй 👨‍👩‍👧 рядом.\n\nВторой");
  assert.ok(verifyQuote(p, range, quote.exact));
  assert.equal(quote.prefix, "Заметка\n\nПервый абзац со ");
  const segments = blockSegments(p, range);
  assert.deepEqual(segments.map((s) => s.block), [1, 2]);
  assert.deepEqual(segments.map((s) => sliceText(p, s.range)), ["ссылкой и семьёй 👨‍👩‍👧 рядом.", "Второй"]);
  const raw = projectionToSource(p, range);
  assert.deepEqual(raw.map((r) => rawSlice(p, r)), ["ссылкой](https://example.com/a?x=1&amp;y=2) и семьёй 👨‍👩‍👧 рядом.", "Второй"]);
  assert.notEqual(raw[0].start, range.start, "raw offsets are not projection offsets");
  assert.deepEqual(sourceToProjection(p, raw[0]), segments[0].range);
  assert.deepEqual(sourceToProjection(p, raw[1]), segments[1].range);
  // The same selection in other units: UTF-16 (DOM) and UTF-8 bytes of the source differ from code points.
  const q = new TextCoords(quote.exact);
  assert.ok(q.utf16Length > q.length);
  assert.ok(q.utf8Length > q.utf16Length);
  assert.equal(p.sourceCoords.cpToUtf8(raw[1].end) - p.sourceCoords.cpToUtf8(raw[1].start), Buffer.byteLength("Второй"));
  assert.equal(sourceToProjection(p, { start: 0, end: 2 }), null, "markup-only raw ranges have no projection");
});

test("T02 a quote that does not match the revision is rejected; DOM (UTF-16) offsets are not accepted as W3C offsets", () => {
  const p = project("👍🏽 abc\n\nдве строки");
  const range = rangeOf(p, "abc");
  assert.ok(verifyQuote(p, range, "abc"));
  assert.equal(verifyQuote(p, range, "abd"), false);
  assert.equal(verifyQuote(p, { start: 5, end: 99 }, "abc"), false);
  assert.equal(verifyQuote(p, { start: 1.5, end: 3 }, "abc"), false);
  assert.equal(verifyQuote(p, { start: 3, end: 2 }, ""), false);
  const domStart = p.text.indexOf("abc");
  assert.equal(domStart, 5, "DOM/UTF-16 offset");
  assert.equal(verifyQuote(p, { start: domStart, end: domStart + 3 }, "abc"), false, "a UTF-16 offset taken as a code point offset fails verification");
  const converted = { start: p.textCoords.utf16ToCp(domStart), end: p.textCoords.utf16ToCp(domStart + 3) };
  assert.ok(verifyQuote(p, converted, "abc"));
});

test("T02 multi-block ranges become per-block segments, including table cells and empty image blocks", () => {
  const p = project(read("syntax/tables.md"));
  const range = { start: rangeOf(p, "Значение").start, end: rangeOf(p, "α").end };
  const segments = blockSegments(p, range);
  assert.deepEqual(segments.map((s) => p.blocks[s.block].text), ["Значение", "Комментарий", "α"]);
  assert.equal(quoteAt(p, range).exact, "Значение\tКомментарий\nα");
  const img = project("До\n\n![схема](d.png)\n\nПосле");
  const across = { start: 0, end: img.textCoords.length };
  assert.deepEqual(blockSegments(img, across).map((s) => img.blocks[s.block].type), ["paragraph", "image", "paragraph"]);
  assert.deepEqual(projectionToSource(img, across).map((r) => rawSlice(img, r)), ["До", "![схема](d.png)", "После"]);
  assert.deepEqual(blockSegments(img, { start: 1, end: 1 }), [{ block: 0, range: { start: 1, end: 1 } }]);
});

test("incremental parse (EP-012-T04): an edit re-parses only the chunks around it; the result equals a whole parse", async () => {
  const { chunkStats } = await import("../core/markdown/parse.ts");
  const paragraphs = Array.from({ length: 3000 }, (_, index) => (index % 40 === 0 ? `## Раздел ${index}` : `Абзац ${index} со [ссылкой](https://example.com/${index}) и **словом ${index}**.`));
  const before = `# Док\n\n${paragraphs.join("\n\n")}\n`;
  project(before);
  paragraphs[1500] += " Правка.";
  const after = `# Док\n\n${paragraphs.join("\n\n")}\n`;
  const misses = chunkStats.misses;
  const hits = chunkStats.hits;
  const incremental = project(after);
  assert.ok(chunkStats.misses - misses <= 3, `re-parsed ${chunkStats.misses - misses} chunks`);
  assert.ok(chunkStats.hits - hits >= 5, `reused ${chunkStats.hits - hits} chunks`);
  const whole = project(after, { wholeDocument: true });
  assert.deepEqual(incremental.blocks.map((block) => [block.type, block.range, block.source, block.semanticHash, block.text]), whole.blocks.map((block) => [block.type, block.range, block.source, block.semanticHash, block.text]));
  assert.equal(incremental.text, whole.text);
});
