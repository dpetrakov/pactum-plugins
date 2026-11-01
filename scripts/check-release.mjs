import assert from "node:assert/strict";
import fs from "node:fs";
const version = JSON.parse(fs.readFileSync(new URL("../plugins/document-review/package.json", import.meta.url))).version;
assert.equal(process.argv[2], `document-review-v${version}`, "Release tag must match the package version");
console.log(`Release tag matches Documents ${version}`);
