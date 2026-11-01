import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register("./tsx-loader.mjs", import.meta.url);
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { DocumentBody } = await import("../ui/render.tsx");
const handlers = { doc: "review.md", previewBase: null, showDiff: true, onlyChanges: false, markers: new Map(), focusBlocks: new Set(), writable: true,
  openDoc() {}, openUrl() {}, onRead() {}, onReadSection() {}, onComment() {}, onReadRemoved() {}, onCommentRemoved() {}, onMarker() {} };
const block = (type) => ({ type, text: "Review", index: 0, inline: ["Review"], attrs: {}, depth: type === "heading" ? 2 : null, headings: [], lineageId: "lineage", versionId: "v", read: "unread", change: "added", diff: null, movedFrom: null, moved: false });
const render = (type) => renderToStaticMarkup(createElement(DocumentBody, { blocks: [block(type)], removed: [], handlers }));
test("an unread heading has one section-read action and a comment action in the fixed gutter", () => {
  const html = render("heading");
  assert.match(html, /aria-label="Section read"/);
  assert.doesNotMatch(html, /aria-label="Mark read \(R\)"/);
  assert.match(html, /aria-label="Comment on section"/);
  const actions = html.match(/class="dr-bacts"[^>]*>([\s\S]*?)<\/span>/)[1];
  assert.equal((actions.match(/<button /g) ?? []).length, 2);
});
test("a paragraph keeps its change-group read action", () => {
  const html = render("paragraph");
  assert.match(html, /aria-label="Mark read \(R\)"/);
  assert.doesNotMatch(html, /aria-label="Section read"/);
});
