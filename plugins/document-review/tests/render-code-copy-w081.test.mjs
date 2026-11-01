// EP-081-T04: «Copy» at every block of code, highlighting of fenced blocks and the basic Markdown fixes of the
// renderer (hard breaks, table alignment, nesting of quotes and list content, footnote links). Rendered with
// react-dom/server: the text nodes of `[data-text]` must still spell the block's projected text exactly, and the copy
// button must stay outside of it (`[data-skip]`, no text of its own).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { project } from "../core/markdown/index.ts";
import { fenceLanguage, fenceTokens } from "../ui/fence-highlight.ts";

register("./tsx-loader.mjs", import.meta.url);
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { DocumentBody } = await import("../ui/render.tsx");
const { copyText } = await import("../ui/copy.tsx");

const DEMO = new URL("./fixtures/markdown/syntax/code-gallery.md", import.meta.url);
const decode = (html) => html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const textOf = (html) => decode(html.replace(/<[^>]+>/g, ""));

function view(blocks) {
  return blocks.map((block, index) => ({ ...block, index, inline: block.fingerprint?.inline ?? [block.text], attrs: block.fingerprint?.attrs ?? {}, depth: block.depth ?? null,
    cell: block.cell ?? null, headings: block.headings ?? [], lineageId: `l${index}`, versionId: "", read: "read", change: null, diff: null, movedFrom: null, moved: false }));
}
const handlers = { doc: "docs/demo/visualizers/09-markdown-basics.md", previewBase: null, showDiff: true, onlyChanges: false, markers: new Map(), focusBlocks: new Set(), writable: true,
  openDoc() {}, openUrl() {}, onRead() {}, onReadSection() {}, onComment() {}, onReadRemoved() {}, onCommentRemoved() {}, onMarker() {} };
const render = (blocks) => renderToStaticMarkup(createElement(DocumentBody, { blocks, removed: [], handlers }));

test("every block of code has «Копировать» outside its text; the highlighted text equals the block text", () => {
  const blocks = view(project(readFileSync(DEMO, "utf8")).blocks);
  const code = blocks.filter((block) => block.type === "code" || block.type === "html");
  assert.ok(code.length >= 10, "the demo page has many code blocks");
  const html = render(blocks);
  const buttons = [...html.matchAll(/<button[^>]*class="[^"]*dr-codeblock__copy[^"]*"[^>]*>/g)].map((match) => match[0]);
  assert.equal(buttons.length, code.length, "one copy button per block of code");
  for (const button of buttons) {
    assert.match(button, /data-skip/, "the button is skipped by the selection mapping");
    assert.match(button, /aria-label="Copy code"/);
    assert.match(button, /title="Copy code"/);
  }
  for (const block of code) {
    const one = render([block]);
    const inner = /<code data-text="true">([\s\S]*?)<\/code><\/pre>/.exec(one)?.[1];
    assert.notEqual(inner, undefined, `block ${block.index}: code in the text`);
    assert.equal(textOf(inner), block.text, `block ${block.index} (${block.attrs.lang ?? block.type}): the text is exact`);
    assert.match(one, /<\/pre><button/, "the button follows the code, inside the block wrapper");
  }
  const ts = code.find((block) => block.attrs.lang === "ts" && block.text.includes("copyText"));
  assert.match(render([ts]), /<span class="dr-sy-k">export<\/span>/, "TypeScript keywords are highlighted");
  assert.match(render([ts]), /<span class="dr-sy-c">\/\/ A comment/, "comments are highlighted");
});

test("a claimed block of an object and the front matter get no copy button from the code block", () => {
  const blocks = view(project("---\ntitle: x\n---\n\n# Заголовок\n").blocks);
  assert.doesNotMatch(render(blocks), /dr-codeblock__copy/);
});

test("fence tokens: languages, exact slices, no overlaps; unknown and huge blocks stay plain", () => {
  assert.equal(fenceLanguage("TS"), "ts");
  assert.equal(fenceLanguage("mermaid"), null);
  assert.equal(fenceLanguage(null), null);
  assert.equal(fenceTokens("rust-unknown", "x"), null);
  assert.equal(fenceTokens("ts", "x".repeat(300_000)), null);
  const samples = {
    ts: "const a = `t${1}`; // c\n/* block\n still */ let b = 'q\\'s' + 0x1f;",
    bash: "#!/bin/sh\necho \"$HOME\" 'it''s' $1 # tail\nexport A=${B:-c}",
    python: "def f(x):\n    return None  # c\n",
    json: "{ \"a\": [1, true, null] }",
    yaml: "a: 1 # c\nb: [x, y]",
    diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n same",
    sql: "SELECT * FROM t WHERE a = 'x' -- c",
  };
  for (const [lang, text] of Object.entries(samples)) {
    const lines = fenceTokens(lang, text);
    assert.ok(lines, lang);
    const split = text.split("\n");
    assert.equal(lines.length, split.length, `${lang}: one token list per line`);
    lines.forEach((tokens, no) => {
      let at = 0;
      for (const token of tokens) {
        assert.ok(token.s >= at && token.e > token.s && token.e <= split[no].length, `${lang} line ${no}: ${JSON.stringify(token)}`);
        at = token.e;
      }
    });
  }
  const diff = fenceTokens("diff", samples.diff);
  assert.deepEqual(diff.map((line) => line[0]?.role ?? null), ["d", "d", "l", "del", "s", null]);
  const bash = fenceTokens("bash", samples.bash);
  assert.equal(bash[0][0].role, "c", "a shebang is a comment");
  assert.ok(bash[1].some((token) => token.role === "l" && samples.bash.split("\n")[1].slice(token.s, token.e) === "$1"), "shell variables");
  const ts = fenceTokens("ts", samples.ts);
  assert.equal(ts[1][0].role, "c", "a block comment continues on the next line");
});

test("basic Markdown: hard breaks stay in the text, table alignment, nested quotes and list content, footnote links", () => {
  const blocks = view(project([
    "Строка  ", "следующая", "", "| a | b | c |", "| :-- | :-: | --: |", "| 1 | 2 | 3 |", "",
    "> один", ">", "> > два", "", "- пункт", "", "  абзац пункта", "", "Сноска[^n].", "", "[^n]: Определение.", "",
  ].join("\n")).blocks);
  const html = render(blocks);
  assert.match(html, /<span data-text="true">Строка\nследующая<\/span>/, "the hard break is a newline of the text (white-space: pre-line)");
  assert.match(html, /<td[^>]*style="text-align:center"[^>]*>/, "centered column");
  assert.match(html, /<td[^>]*style="text-align:right"[^>]*>/, "right column");
  assert.match(html, /class="dr-quoteblock" style="--dr-quote:2"/, "a nested quote knows its depth");
  assert.match(html, /margin-left:calc\(0rem \+ var\(--dr-li-text\)\)[^>]*>(?:<[^>]+>)*абзац пункта/, "a paragraph inside a list item lines up with its text");
  assert.match(html, /<sup data-skip="true" class="dr-fn"><a href="#" title="Go to footnote">\[n\]<\/a><\/sup>/, "the footnote reference is a link");
  assert.match(html, /data-footnote="n"/, "the definition is found by its id");
});

test("copyText: the Clipboard API, the error when there is no way to copy", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let written = null;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (text) => { written = text; } } } });
  try {
    await copyText("код\nблока");
    assert.equal(written, "код\nблока");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => { throw new Error("denied"); } } } });
    await assert.rejects(copyText("x"), /clipboard unavailable/, "refused and no document for the legacy command");
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
  }
});
