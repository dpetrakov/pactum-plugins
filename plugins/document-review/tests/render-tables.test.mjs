// EP-047: words in table cells never break in the middle — the cells do not inherit overflow-wrap: anywhere, and long
// tokens without spaces get break opportunities (<wbr>) after dots, slashes and hyphens. The text of every cell stays
// exactly the block's projected text, so selections and quotes are unchanged (rendered with react-dom/server).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { project } from "../core/markdown/index.ts";
import { breakSegments } from "../ui/breaks.ts";
import { selectionRange, sliceCp, projectionText, cpLength } from "../ui/text.ts";

register("./tsx-loader.mjs", import.meta.url);
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { DocumentBody } = await import("../ui/render.tsx");

const FORMAT = new URL("./fixtures/markdown/syntax/event-table.md", import.meta.url);
const decode = (html) => html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
/** The text a browser's text nodes spell inside an element's HTML: tags (and <wbr>) contribute nothing. */
const textOf = (html) => decode(html.replace(/<[^>]+>/g, ""));

function view(blocks) {
  return blocks.map((block, index) => ({ ...block, index, inline: block.fingerprint?.inline ?? block.inline ?? [block.text], attrs: block.attrs ?? {}, depth: block.depth ?? null,
    cell: block.cell ?? null, headings: block.headings ?? [], lineageId: `l${index}`, versionId: "", read: "read", change: null, diff: null, movedFrom: null, moved: false }));
}

const handlers = { doc: "docs/plugins/document-review/format.md", previewBase: null, showDiff: true, onlyChanges: false, markers: new Map(), focusBlocks: new Set(), writable: false,
  openDoc() {}, openUrl() {}, onRead() {}, onReadSection() {}, onComment() {}, onReadRemoved() {}, onCommentRemoved() {}, onMarker() {} };

test("break segments: the concatenation is the text; long tokens split after separators, short words and spaces untouched", () => {
  assert.deepEqual(breakSegments("annotation.kind-changed"), ["annotation.", "kind-", "changed"]);
  assert.deepEqual(breakSegments("docs/plugins/document-review/format.md"), ["docs/", "plugins/", "document-", "review/", "format.", "md"]);
  assert.deepEqual(breakSegments("Сущность"), ["Сущность"], "a word without separators is never split");
  assert.deepEqual(breakSegments("т. е. что-то"), ["т. е. что-то"], "short tokens wrap at spaces only");
  assert.deepEqual(breakSegments("https://example.com/a"), ["https://", "example.", "com/", "a"], "a run of separators breaks after its last one");
  for (const text of ["", "a.b", "....", "-leading.dash-and-trailing.", "путь/к/файлу.md и annotation.kind-changed", "x".repeat(40)]) {
    assert.equal(breakSegments(text).join(""), text, text);
  }
});

test("event-table.md events table: cells render with <wbr> in long tokens, and their text equals the projection exactly", () => {
  const projection = project(readFileSync(FORMAT, "utf8"));
  const blocks = view(projection.blocks);
  const table = blocks.find((block) => block.type === "tableCell" && block.text === "Entity")?.cell.table;
  assert.notEqual(table, undefined, "the events table is in the fixture");
  const cells = blocks.filter((block) => block.type === "tableCell" && block.cell.table === table);
  const html = renderToStaticMarkup(createElement(DocumentBody, { blocks: cells, removed: [], handlers }));
  assert.match(html, /<wbr\/?>/, "long identifiers get break opportunities");
  assert.match(html, /annotation\.<wbr\/?>kind-<wbr\/?>changed/, "annotation.kind-changed wraps after the dot and the hyphen");
  assert.doesNotMatch(html, /Сущ<wbr|annotatio<wbr/, "never inside a word");
  // Every cell: the text nodes of [data-text] spell the block text (what selection mapping and quotes read).
  const found = [...html.matchAll(/data-block="(\d+)"[^>]*><span data-text="true">([\s\S]*?)<\/span>(?:<button|<\/t[dh]>)/g)];
  assert.equal(found.length, cells.length, "one [data-text] per cell");
  for (const [, index, inner] of found) assert.equal(textOf(inner), blocks[Number(index)].text, `cell ${index}`);
});

test("a selection inside a cell with <wbr> maps to the same quote as the projection text", () => {
  const projection = project("| Изменение | Сущность |\n|---|---|\n| `annotation.withdrawn`, `annotation.kind-changed` {kind} | annotation |\n");
  const blocks = view(projection.blocks);
  const cell = blocks.find((block) => block.text.includes("kind-changed"));
  const html = renderToStaticMarkup(createElement(DocumentBody, { blocks, removed: [], handlers }));
  const inner = html.match(new RegExp(`data-block="${cell.index}"[^>]*><span data-text="true">([\\s\\S]*?)</span></t`))[1];
  assert.match(inner, /<wbr\/?>/);
  // Offsets counted over the rendered text nodes (as dom.ts pointOf does) equal offsets in the block text.
  const rendered = textOf(inner);
  assert.equal(rendered, cell.text);
  const start = rendered.indexOf("kind-changed");
  const plain = blocks.map((block) => ({ text: block.text, range: block.range, cell: block.cell }));
  const range = selectionRange(plain, { block: cell.index, offset: start }, { block: cell.index, offset: start + "kind-changed".length });
  assert.equal(sliceCp(projectionText(plain), range), "kind-changed");
  assert.equal(range.end - range.start, cpLength("kind-changed"));
});
