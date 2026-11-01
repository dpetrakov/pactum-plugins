import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
test("site installation command targets the actual collection and tag convention", () => {
  const collection = JSON.parse(read(".bb/plugins.json"));
  const html = read("site/index.html");
  for (const entry of collection.plugins) {
    const pkg = JSON.parse(read(`${entry.source.slice(2)}/package.json`));
    assert.ok(html.includes(`@^${pkg.version} --plugin ${entry.name} --tag-prefix ${entry.name}-`));
    for (const manifest of ["marketplace.json", "site/marketplace.json"]) {
      const listing = JSON.parse(read(manifest)).plugins.find(p => p.id === entry.name);
      assert.equal(listing.source.git.range, `^${pkg.version}`);
      assert.equal(listing.source.git.subdir, entry.source.slice(2));
      assert.equal(listing.source.git.tagPrefix, `${entry.name}-`);
    }
  }
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
