// EP-005-T01: schemas v1 and deterministic serialization.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson, isCanonical } from "../core/canonical-json.ts";
import { CHANGE_TYPES, parseConfig, parseObject, parseOperation, versionOf } from "../core/schema.ts";
import { renderSchemas } from "../scripts/write-schemas.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures/schema");
const parserFor = (name) => (name.startsWith("config") ? parseConfig : name.startsWith("operation") ? parseOperation : parseObject);
const readFixture = (dir, file) => fs.readFileSync(path.join(fixtures, dir, file), "utf8");

test("valid fixtures parse as schema 1.0 and are already canonical", () => {
  const files = fs.readdirSync(path.join(fixtures, "valid"));
  assert.ok(files.length >= 8);
  for (const file of files) {
    const text = readFixture("valid", file);
    const parsed = parserFor(file)(JSON.parse(text));
    assert.ok(parsed.ok, `${file}: ${parsed.ok ? "" : parsed.issues.join("; ")}`);
    assert.equal(parsed.version, "current");
    assert.ok(isCanonical(text), `${file} is canonical`);
  }
});

test("invalid fixtures are rejected with a reason", () => {
  const files = fs.readdirSync(path.join(fixtures, "invalid"));
  assert.ok(files.length >= 10);
  for (const file of files) {
    const text = readFixture("invalid", file);
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      continue; // not-json: rejected before any schema
    }
    const parsed = parserFor(file)(value);
    assert.equal(parsed.ok, false, `${file} must be rejected`);
    assert.ok(parsed.issues.length > 0);
  }
});

test("serialization is deterministic: key order, LF, trailing newline, same bytes on rewrite", () => {
  const a = canonicalJson({ b: 1, a: { d: [3, { z: 1, y: "ё😀" }], c: null } });
  const b = canonicalJson(JSON.parse(JSON.stringify({ a: { c: null, d: [3, { y: "ё😀", z: 1 }] }, b: 1 })));
  assert.equal(a, b);
  assert.equal(canonicalJson(JSON.parse(a)), a);
  assert.ok(a.endsWith("}\n"));
  assert.ok(!a.includes("\r"));
  assert.match(a, /^\{\n  "a"/);
  assert.throws(() => canonicalJson({ x: 0.5 }), /safe integers/);
  assert.throws(() => canonicalJson({ x: undefined }), /undefined/);
  assert.throws(() => canonicalJson({ x: Number.NaN }), /safe integers/);
});

test("no absolute machine paths: roots, document paths and target sources are repo-relative", () => {
  for (const file of ["config-absolute-root.json", "config-dotdot-root.json", "annotation-machine-path-source.json"]) {
    assert.equal(parserFor(file)(JSON.parse(readFixture("invalid", file))).ok, false, file);
  }
  for (const bad of ["/abs/x.md", "C:/x.md", "a/../b.md", "a//b.md", "./a.md", "a\\b.md", "~/a.md"]) {
    const raw = JSON.parse(readFixture("valid", "operation-observe.json"));
    raw.changes[0].path = bad;
    assert.equal(parseOperation(raw).ok, false, bad);
  }
});

test("G3: an unknown major opens read-only, a newer minor keeps known fields, unknown fields of 1.0 are errors", () => {
  assert.equal(versionOf("1.0"), "current");
  assert.equal(versionOf("1.7"), "newer-minor");
  assert.equal(versionOf("2.0"), "unknown-major");
  assert.equal(versionOf("v1"), "invalid");
  const config = JSON.parse(readFixture("valid", "config.json"));
  const major = parseConfig({ ...config, schemaVersion: "2.0" });
  assert.equal(major.ok, false);
  assert.equal(major.version, "unknown-major");
  const minor = parseConfig({ ...config, schemaVersion: "1.4", futureField: true });
  assert.ok(minor.ok);
  assert.equal(minor.version, "newer-minor");
  assert.equal("futureField" in minor.value, false);
  assert.equal(parseConfig({ ...config, futureField: true }).ok, false);
});

test("W3C: only W3C terms are unprefixed; our vocabulary is namespaced and pinned", () => {
  const annotation = JSON.parse(readFixture("valid", "annotation.json"));
  const W3C_ANNOTATION = new Set(["@context", "type", "id", "created", "creator", "motivation", "body", "target"]);
  const W3C_TARGET = new Set(["type", "source", "selector"]);
  for (const key of Object.keys(annotation)) assert.ok(W3C_ANNOTATION.has(key) || key.startsWith("bbdr:"), key);
  for (const key of Object.keys(annotation.target)) assert.ok(W3C_TARGET.has(key) || key.startsWith("bbdr:"), key);
  assert.deepEqual(annotation["@context"], ["http://www.w3.org/ns/anno.jsonld", { bbdr: "urn:bb-docs:vocab:v1#" }]);
  assert.deepEqual(annotation.target.selector.map((selector) => selector.type), ["TextQuoteSelector", "TextPositionSelector"]);
  for (const file of ["annotation-unprefixed-extension.json", "revision-confidence-field.json"]) {
    assert.equal(parserFor(file)(JSON.parse(readFixture("invalid", file))).ok, false, file);
  }
});

test("schemas cover every change type of architecture §4 and every entity of §3", () => {
  for (const type of ["annotation.created", "annotation.withdrawn", "message.appended", "discussion.closed", "document.observed", "read.acknowledged", "batch.prepared", "batch.dispatched", "item.result-recorded"]) {
    assert.ok(CHANGE_TYPES.includes(type), type);
  }
  const files = renderSchemas().map((schema) => schema.file);
  assert.deepEqual(files.sort(), ["anchor-resolution.schema.json", "annotation.schema.json", "batch-manifest.schema.json", "config.schema.json", "operation.schema.json", "revision.schema.json"]);
});

test("committed JSON Schemas in schemas/v1 match core/schema.ts", () => {
  for (const { file, text } of renderSchemas()) {
    assert.equal(fs.readFileSync(path.join(here, "../schemas/v1", file), "utf8"), text, `schemas/v1/${file} is stale: npm run schemas`);
  }
});
