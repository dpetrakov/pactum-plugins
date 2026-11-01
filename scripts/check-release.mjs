import assert from "node:assert/strict";
import fs from "node:fs";
const tag = process.argv[2];
const id = ["document-review", "pactum-mermaid-flowchart"].find(id => tag?.startsWith(`${id}-v`));
assert.ok(id, "Unknown plugin release prefix");
const version = JSON.parse(fs.readFileSync(new URL(`../plugins/${id}/package.json`, import.meta.url))).version;
assert.equal(tag, `${id}-v${version}`, "Release tag must match the package version");
console.log(`Release tag matches ${id} ${version}`);
