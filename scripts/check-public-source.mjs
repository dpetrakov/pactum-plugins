import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "plugins/document-review/package.json"));
const ts = require("typescript");
const problems = [];
let sources = 0;
const nonEnglish = /[\u0400-\u04ff]/u;
const excluded = new Set([".git", "node_modules", ".qa", "dist", "test-results", "playwright-report"]);
function check(file) {
  const rel = path.relative(root, file);
  const text = fs.readFileSync(file, "utf8");
  const fixture = rel.includes("tests/fixtures/");
  if (/(?:^|\/)\.bb-docs(?:\/|$)|(?:^|\/)\.env(?:\.|$)/.test(rel)) problems.push(`${rel}: private runtime data`);
  if (/\/(?:Users|home)\/(?:dim|dpetrakov)\b|host_(?:pt63ia4s3r|jtiaqvv2gt)/.test(text)) problems.push(`${rel}: private path, identity or credential marker`);
  if (/\.(?:ts|tsx|mjs)$/.test(file)) {
    sources++;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const comments = new Map();
    function visit(node) {
      for (const pos of [node.pos, node.end]) for (const range of [...(ts.getLeadingCommentRanges(text, pos) ?? []), ...(ts.getTrailingCommentRanges(text, pos) ?? [])]) comments.set(range.pos, range);
      for (const child of node.getChildren(sf)) visit(child);
    }
    visit(sf);
    for (const { pos, end } of comments.values()) if (nonEnglish.test(text.slice(pos, end))) problems.push(`${rel}: source comment must be English`);
  }
  if (/\.css$/.test(file)) for (const comment of text.match(/\/\*[\s\S]*?\*\//g) ?? []) if (nonEnglish.test(comment)) problems.push(`${rel}: CSS comment must be English`);
  if (/\.md$/.test(file) && !fixture && nonEnglish.test(text)) problems.push(`${rel}: project documentation must be English`);
}
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) problems.push(`${path.relative(root, file)}: unexpected symbolic link`);
    else if (entry.isDirectory()) walk(file);
    else if (/\.(?:ts|tsx|mjs|css|md|json|yml|yaml|txt)$/.test(entry.name)) check(file);
  }
}
walk(root);
assert.deepEqual(problems, [], problems.join("\n"));
console.log(`Public source check passed (${sources} code files; localized strings and Unicode fixture data retained).`);
