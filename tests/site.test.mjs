import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
test("site installation command targets the actual collection and tag convention", () => {
  const collection = JSON.parse(read(".bb/plugins.json"));
  const entry = collection.plugins.find((p) => p.name === "document-review");
  assert.equal(entry.source, "./plugins/document-review");
  const pkg = JSON.parse(read("plugins/document-review/package.json"));
  const html = read("site/index.html");
  assert.ok(html.includes(`@^${pkg.version} --plugin document-review --tag-prefix document-review-`));
  const listing = JSON.parse(read("site/marketplace.json")).plugins[0];
  assert.equal(listing.source.git.range, `^${pkg.version}`);
  assert.equal(listing.source.git.subdir, entry.source.slice(2));
  assert.equal(listing.source.git.tagPrefix, "document-review-");
});
test("all local page assets exist and the install controls are accessible", () => {
  const html = read("site/index.html");
  for (const match of html.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g)) {
    if (match[1] === "./") continue;
    assert.ok(fs.existsSync(new URL(`../site/${match[1].slice(2)}`, import.meta.url)), match[1]);
  }
  assert.match(html, /lang="en"/);
  assert.match(html, /aria-label="Copy installation command"/);
  assert.match(html, /role="status"/);
  assert.match(html, /href="#main"/);
});
