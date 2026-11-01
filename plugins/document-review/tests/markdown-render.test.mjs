import assert from "node:assert/strict";
import test from "node:test";
import { defaultSchema, sanitize } from "hast-util-sanitize";
import { toHtml } from "hast-util-to-html";
import { toHast } from "mdast-util-to-hast";
import { parseMarkdown } from "../core/markdown/parse.ts";
import { corpusDocuments, read } from "./markdown-helpers.mjs";

// Spike of the viewer pipeline chosen in T01: mdast → hast without allowDangerousHtml → GitHub sanitize schema → HTML.
function render(source) {
  const { tree } = parseMarkdown(source);
  return toHtml(sanitize(toHast(tree), defaultSchema));
}

test("T01 renderer: scripts, on* handlers, iframes and javascript: URLs do not survive on the whole corpus", () => {
  const hostile = read("syntax/html.md");
  assert.match(hostile, /<script>/);
  assert.match(hostile, /onclick=/);
  assert.match(hostile, /<iframe/);
  assert.match(hostile, /javascript:/);
  for (const doc of [...corpusDocuments(), "syntax/html.md"]) {
    const html = render(read(doc));
    assert.doesNotMatch(html, /<script/i, `${doc}: script`);
    assert.doesNotMatch(html, /<iframe/i, `${doc}: iframe`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${doc}: event handler`);
    assert.doesNotMatch(html, /(href|src)\s*=\s*"?\s*javascript:/i, `${doc}: javascript URL`);
    assert.doesNotMatch(html, /\sstyle\s*=/i, `${doc}: inline style`);
  }
  const html = render(hostile);
  assert.match(html, /<a>js link<\/a>/, "the link text stays, the javascript: URL is dropped");
  assert.match(html, /Абзац с\s+и ссылкой/, "inline raw HTML is dropped, its text stays");
});
