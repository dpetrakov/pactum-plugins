// EP-040-T06: format .bb-docs 1.2 and compatibility G3. Markdown-only data is still written 1.0/1.1; the new
// features (structured and line revisions, redaction flag, key-path and line-range selectors, config exclude/types/
// secret rules, document.transferred) declare 1.2; the previous release (tag document-review-v1.3.1) opens a catalog
// with 1.2 data read-only for what it does not understand, keeps Markdown writable and loses nothing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalBytes } from "../core/canonical-json.ts";
import { keyPathString } from "../core/formats/assemble.ts";
import { newId, sha256 } from "../core/hash.ts";
import { loadRepository, operationEntities, parentsFor, project } from "../core/journal.ts";
import { buildRevision, quoteAt } from "../core/markdown/index.ts";
import { configVersion, CONTEXT, operationVersion, parseConfig, parseObject, requiredVersion } from "../core/schema.ts";
import { layout, publish, writeConfig } from "../core/store.ts";
import { ReviewService } from "../node/service.ts";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = process.env.PACTUM_PREVIOUS_REPOSITORY ?? path.resolve(pluginDir, "../..");
const PREVIOUS = "document-review-v1.3.1";
function previousUnavailable() {
  try { execFileSync("git", ["rev-parse", "--verify", PREVIOUS], { cwd: repoRoot, stdio: "pipe" }); return false; }
  catch { return "Historical source drill requires PACTUM_PREVIOUS_REPOSITORY; current format gates remain covered"; }
}

async function digest(dir) {
  const out = [];
  const walk = async (current) => {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(`${path.relative(dir, full)} ${createHash("sha256").update(await fs.readFile(full)).digest("hex")}`);
    }
  };
  await walk(dir);
  return sha256(out.join("\n"));
}

async function previousRelease(base) {
  // The previous plugin's core and host code, run against the same files (the node_modules are the same versions).
  const target = path.join(base, "previous");
  await fs.mkdir(target, { recursive: true });
  const tar = execFileSync("git", ["archive", PREVIOUS, "plugins/document-review/core", "plugins/document-review/node"], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  const archive = path.join(base, "previous.tar");
  await fs.writeFile(archive, tar);
  execFileSync("tar", ["-xf", archive, "-C", target]);
  await fs.symlink(path.join(pluginDir, "node_modules"), path.join(target, "plugins/document-review/node_modules"));
  return path.join(target, "plugins/document-review");
}

test("EP-040-T06 schema 1.2: versions are the oldest that express the data; gates refuse undeclared 1.2 features", () => {
  assert.equal(configVersion({ roots: ["."], hidden: [], untracked: [] }), "1.0", "root «.» is expressed in 1.0");
  assert.equal(configVersion({ roots: ["."], hidden: [], untracked: [], exclude: ["build/"] }), "1.2");
  const base = { repoId: "00000000-0000-4000-8000-000000000001", roots: ["."], hidden: [], untracked: [] };
  assert.equal(parseConfig({ schemaVersion: "1.0", ...base, exclude: ["x/"] }).ok, false, "1.2 fields need 1.2");
  assert.equal(parseConfig({ schemaVersion: "1.2", ...base, exclude: ["x/"], types: ["markdown", "yaml"], secretKeys: ["salt"], secretExemptions: [{ path: "a.yaml", keyPath: '["a"]' }] }).ok, true);
  assert.equal(requiredVersion({ changes: [{ type: "document.transferred", docId: base.repoId, direction: "to-local" }] }), "1.2");
  const yaml = buildRevision({ revisionId: newId(), docId: newId(), path: "a.yaml", source: "a: 1\n", snapshot: sha256("a: 1\n"), parents: [] }).revision;
  assert.equal(yaml.schemaVersion, "1.2");
  assert.equal(yaml.projection.profile, "bbdr-structured");
  assert.equal(parseObject(JSON.parse(new TextDecoder().decode(canonicalBytes(yaml)))).ok, true);
  assert.equal(parseObject({ ...yaml, schemaVersion: "1.0" }).ok, false, "new block types need 1.2");
  const md = buildRevision({ revisionId: newId(), docId: newId(), path: "a.md", source: "# A\n", snapshot: sha256("# A\n"), parents: [] }).revision;
  assert.equal(md.schemaVersion, "1.0", "Markdown revisions stay 1.0");
});

test("EP-040-T06 a catalog with 1.2 data opens in the previous release read-only for what it does not know, Markdown stays writable, nothing is lost", { skip: !process.env.PACTUM_PREVIOUS_REPOSITORY && previousUnavailable() }, async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-12-")));
  try {
    const dir = path.join(base, "repo");
    await fs.mkdir(path.join(dir, "docs"), { recursive: true });
    const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, stdio: "pipe" }).toString();
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Owner");
    git("config", "user.email", "owner@bb-docs.invalid");
    await fs.writeFile(path.join(dir, "docs/a.md"), "# A\n\nабзац\n");
    await fs.writeFile(path.join(dir, "docs/b.md"), "# B\n\nдругой\n");
    const yamlText = "services:\n  api:\n    port: 8080\n";
    await fs.mkdir(path.join(dir, "config"), { recursive: true });
    await fs.writeFile(path.join(dir, "config/svc.yaml"), yamlText);
    const service = new ReviewService(dir, path.join(base, "data"));
    await service.enable({ roots: ["docs"] });

    // Markdown-only data is written 1.0.
    const store = service.store;
    const data = await loadRepository(store);
    assert.ok([...data.events.values()].every((event) => event.schemaVersion === "1.0"), "events 1.0");
    assert.ok([...data.objects.values()].every((object) => object.schemaVersion === "1.0"), "revisions 1.0");
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, ".bb-docs/config.json"), "utf8")).schemaVersion, "1.0");

    // 1.2 data written through the real protocol: a structured revision, an annotation with key-path and line-range
    // selectors, a transfer event, config with exclude.
    let state = project(await loadRepository(store));
    const docId = newId();
    const built = buildRevision({ revisionId: newId(), docId, path: "config/svc.yaml", source: yamlText, snapshot: sha256(yamlText), parents: [] });
    const repoId = JSON.parse(await fs.readFile(path.join(dir, ".bb-docs/config.json"), "utf8")).repoId;
    const node = built.projection.blocks.findIndex((block) => block.text === "port: 8080");
    const range = built.projection.blocks[node].range;
    const quote = quoteAt(built.projection, range);
    const annotationId = newId();
    const annotation = {
      "@context": [CONTEXT[0], { bbdr: CONTEXT[1].bbdr }], type: "Annotation", id: `urn:bb-docs:${repoId}:annotation:${annotationId}`, created: "2026-10-09T08:00:00.000Z",
      creator: { type: "Person", name: "Owner", email: "mailto:owner@bb-docs.invalid" }, motivation: "commenting", body: { type: "TextualBody", value: "порт?", format: "text/markdown" },
      target: { type: "SpecificResource", source: `urn:bb-docs:${repoId}:doc:${docId}:rev:${built.revision.revisionId}:proj:bbdr-structured/1`,
        selector: [{ type: "TextQuoteSelector", ...quote }, { type: "TextPositionSelector", ...range }, { type: "bbdr:KeyPathSelector", value: keyPathString(built.projection.meta[node].path) }, { type: "bbdr:LineRangeSelector", start: 3, end: 3 }],
        "bbdr:targetKind": "block", "bbdr:docId": docId, "bbdr:revisionId": built.revision.revisionId, "bbdr:path": "config/svc.yaml", "bbdr:snapshot": built.revision.snapshot,
        "bbdr:segments": [{ lineageId: built.revision.blocks[node].lineageId, versionId: built.revision.blocks[node].versionId, start: range.start, end: range.end }],
        "bbdr:sourceRanges": [built.projection.blocks[node].source] },
      "bbdr:schemaVersion": "1.2",
    };
    const actor = { kind: "human", name: "Owner", email: "owner@bb-docs.invalid" };
    const writeOp = async (changes, objects, snapshots) => {
      state = project(await loadRepository(store));
      const operation = { schemaVersion: operationVersion(changes, objects), id: newId(), actor, timestamp: "2026-10-09T08:00:00.000Z", parents: [], changes };
      operation.parents = parentsFor(state, operationEntities(operation));
      await publish(store, { operation, objects, snapshots }, { isKnownRevision: (id) => state.revisions.has(id) });
    };
    await writeOp([
      { type: "document.registered", docId, path: "config/svc.yaml" },
      { type: "document.observed", docId, revisionId: built.revision.revisionId, revision: sha256(canonicalBytes(built.revision)), reason: "baseline" },
      { type: "annotation.created", annotationId, docId, annotation: sha256(canonicalBytes(annotation)), kind: "action", messageId: newId() },
    ], [built.revision, annotation], [new TextEncoder().encode(yamlText)]);
    await writeOp([{ type: "document.transferred", docId, direction: "to-local" }], [], []);
    const config = JSON.parse(await fs.readFile(path.join(dir, ".bb-docs/config.json"), "utf8"));
    const config12 = { ...config, schemaVersion: "1.2", exclude: ["build/"] };
    assert.equal(await writeConfig(store, canonicalBytes(config12), sha256(await fs.readFile(path.join(dir, ".bb-docs/config.json")))), "replaced");
    service.invalidate();

    // The current release reads everything: validate OK, nothing read-only.
    const report = await service.validate();
    assert.equal(report.ok, true, JSON.stringify(report.problems.slice(0, 3)));
    state = await service.state();
    assert.equal(state.repoReadOnly.length, 0);
    assert.equal(state.documents.get(docId).transferred, "to-local");
    assert.equal((await service.config()).readOnly, false);
    const before = await digest(path.join(dir, ".bb-docs"));

    // The previous release (tag) on the same files.
    const previous = await previousRelease(base);
    const { ReviewService: Previous } = await import(pathToFileURL(path.join(previous, "node/service.ts")).href);
    const old = new Previous(dir, path.join(base, "data-old"));
    const oldConfig = await old.config();
    assert.equal(oldConfig.readOnly, true, "config 1.2: rules read, not written");
    assert.deepEqual(oldConfig.value?.roots, ["docs"], "the rules it knows are read");
    const oldState = await old.state();
    const docA = [...oldState.documents.values()].find((doc) => doc.path === "docs/a.md").docId;
    const docB = [...oldState.documents.values()].find((doc) => doc.path === "docs/b.md").docId;
    assert.equal((oldState.readOnly.get(`doc:${docA}`) ?? []).length, 0, "Markdown documents are not touched by 1.2 entities");
    const structuredBlockers = [...(oldState.readOnly.get(`doc:${docId}`) ?? []), ...(oldState.incomplete.get(`doc:${docId}`) ?? [])];
    assert.ok(structuredBlockers.length > 0, "the structured document is read-only for the previous release");
    const oldReport = await old.validate(500);
    // The previous release knew newer-minor events (G3, W-05) but not newer-minor objects: it names the 1.2 objects
    // «schema-invalid» and their entities incomplete. That is its frozen behaviour, not damage — every problem concerns
    // only the 1.2 files and entities, the Markdown data validates clean, and nothing is changed (digest below).
    const sha12 = new Set([sha256(canonicalBytes(built.revision)), sha256(canonicalBytes(annotation))]);
    for (const problem of oldReport.problems) {
      const about12 = (problem.path && [...sha12].some((sha) => problem.path.includes(sha))) || (problem.entity && (problem.entity === `doc:${docId}` || problem.entity === `annotation:${annotationId}`))
        || (problem.path && problem.path.startsWith("events/")) || problem.code === "read-only" || problem.code === "unreferenced";
      assert.ok(about12, `previous release: unexpected problem ${JSON.stringify(problem)}`);
    }
    assert.ok(!oldReport.problems.some((problem) => problem.entity === `doc:${docA}`), "Markdown data is clean for the previous release");
    assert.equal(await digest(path.join(dir, ".bb-docs")), before, "the previous release changed nothing");
    // And the current release still reads all of it afterwards.
    service.invalidate();
    assert.equal((await service.validate()).ok, true);
    // Forward compatibility of this release: an object of a future minor (1.3) is a read-only warning, not damage.
    const future = { ...built.revision, schemaVersion: "1.4", revisionId: newId(), blocks: built.revision.blocks.map((block) => ({ ...block, type: "future-kind" })) };
    // Written as a newer plugin would (its own publish), straight into the layout: object, then the event naming it.
    const futureSha = sha256(canonicalBytes(future));
    await fs.mkdir(path.dirname(path.join(dir, ".bb-docs", layout.object(futureSha))), { recursive: true });
    await fs.writeFile(path.join(dir, ".bb-docs", layout.object(futureSha)), canonicalBytes(future));
    state = project(await loadRepository(store));
    const futureEvent = { schemaVersion: "1.0", id: newId(), actor, timestamp: "2026-10-09T08:00:00.000Z", parents: [], changes: [{ type: "document.observed", docId: docB, revisionId: future.revisionId, revision: futureSha, reason: "reference" }] };
    futureEvent.parents = parentsFor(state, operationEntities(futureEvent));
    await fs.mkdir(path.dirname(path.join(dir, ".bb-docs", layout.event(futureEvent.id))), { recursive: true });
    await fs.writeFile(path.join(dir, ".bb-docs", layout.event(futureEvent.id)), canonicalBytes(futureEvent));
    service.invalidate();
    const forward = await service.validate();
    assert.equal(forward.ok, true, JSON.stringify(forward.problems.slice(0, 3)));
    assert.ok(forward.problems.some((problem) => problem.code === "read-only" && /newer schema/.test(problem.message)));
    const forwardState = await service.state();
    assert.ok((forwardState.readOnly.get(`doc:${docB}`) ?? []).length > 0, "its entity is read-only");
    assert.equal(forwardState.incomplete.has(`doc:${docB}`), false, "not incomplete");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
