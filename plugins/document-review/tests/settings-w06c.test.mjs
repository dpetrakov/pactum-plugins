// EP-045-T01 (W-06c, file-types.md §4, §12): «Review settings» on the host — the rules by level, the preview of a
// change equals the tree after it is written (repository level by CAS, the user's global level and an exemption for
// one repository), a built-in rule returned in the repository, CAS mismatch, invalid patterns in place, the preview of
// the secret-key pattern counts what the write then masks and holds no values; a global rule leaves Git clean.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReviewService } from "../node/service.ts";
import { settingsGet, settingsPreview, settingsSave } from "../node/settings.ts";
import { documentTree } from "../node/tree.ts";
import { documentText } from "../node/view.ts";
import { canary, LeakHarness } from "./leak-harness.mjs";

async function repo(files) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-settings-")));
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Owner");
  git("config", "user.email", "owner@bb-docs.invalid");
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), text);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-settings-data-"));
  const service = new ReviewService(dir, data);
  await service.enable({ roots: ["."] });
  git("add", "-A");
  git("commit", "-q", "-m", "enable");
  return { dir, git, service, cleanup: () => Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]) };
}
const shown = async (service) => (await documentTree(service, { budgetMs: 30_000 })).entries.map((entry) => entry.path).sort();

test("EP-045-T01 levels, preview = tree after the write, CAS, invalid patterns, a global rule leaves Git clean", async () => {
  const r = await repo({ "docs/a.md": "# A\n", "build/out.md": "# built\n", "fixtures/big/x.yaml": "a: 1\n", "fixtures/keep/y.yaml": "b: 2\n", "notes/n.txt": "n\n" });
  try {
    const got = await settingsGet(r.service);
    assert.ok(got.builtin.exclude.includes("build/") && got.builtin.secretKeys.includes("password"));
    assert.deepEqual(got.repo.roots, ["."]);
    // Repository level: return the built-in build/ and exclude notes/.
    const repoChange = { repo: { exclude: ["!build/", "notes/"] } };
    const preview = await settingsPreview(r.service, repoChange);
    assert.equal(preview.status, "ok");
    assert.deepEqual(preview.shown.paths, ["build/out.md"]);
    assert.deepEqual(preview.hidden.paths, ["notes/n.txt"]);
    assert.deepEqual(preview.hidden.reasons, [{ level: "repo", pattern: "notes/", count: 1 }]);
    const before = await shown(r.service);
    await assert.rejects(settingsSave(r.service, { ...repoChange, configSha: "0".repeat(64) }), (error) => error.code === "stale", "CAS mismatch");
    const saved = await settingsSave(r.service, { ...repoChange, configSha: got.configSha });
    assert.equal(saved.status, "saved");
    const after = await shown(r.service);
    assert.deepEqual(after, [...before.filter((file) => file !== "notes/n.txt"), "build/out.md"].sort(), "the tree after the write is the preview");
    const config = JSON.parse(await fs.readFile(path.join(r.dir, ".bb-docs/config.json"), "utf8"));
    assert.equal(config.schemaVersion, "1.2");
    assert.deepEqual(config.exclude, ["!build/", "notes/"]);
    // The user's global level and an exemption for this repository only.
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "settings");
    const global = { user: { exclude: ["fixtures/big/"] } };
    const globalPreview = await settingsPreview(r.service, global);
    assert.deepEqual(globalPreview.hidden.paths, ["fixtures/big/x.yaml"]);
    assert.equal(globalPreview.hidden.reasons[0].level, "global");
    await settingsSave(r.service, global);
    assert.ok(!(await shown(r.service)).includes("fixtures/big/x.yaml"));
    assert.equal(r.git("status", "--porcelain"), "", "a global rule is not in the repository");
    const exempt = { user: { exemptHere: ["fixtures/big/"] } };
    assert.deepEqual((await settingsPreview(r.service, exempt)).shown.paths, ["fixtures/big/x.yaml"]);
    await settingsSave(r.service, exempt);
    assert.ok((await shown(r.service)).includes("fixtures/big/x.yaml"), "exempted here");
    // Invalid patterns: in place, nothing computed or written.
    const invalid = await settingsPreview(r.service, { repo: { exclude: ["a\\b"], secretKeys: ["(a+)+"] } });
    assert.equal(invalid.status, "invalid");
    assert.deepEqual(invalid.problems.map((entry) => entry.field), ["repo.exclude", "repo.secretKeys"]);
    await assert.rejects(settingsSave(r.service, { repo: { exclude: ["a\\b"] } }), (error) => error.code === "bad-input");
  } finally {
    await r.cleanup();
  }
});

test("EP-045-T01 the preview of the secret-key pattern counts what the write masks, without values", async () => {
  const c = { A: canary(), B: canary() };
  const r = await repo({ "config/app.yaml": `vault_phrase: ${c.A}\nother: x\n`, "config/b.json": `{ "vault_phrase": "${c.B}" }\n` });
  try {
    const change = { repo: { secretKeys: ["vault_phrase"] } };
    const preview = await settingsPreview(r.service, change);
    assert.deepEqual({ values: preview.secrets.values, files: preview.secrets.files }, { values: 2, files: 2 });
    assert.equal(preview.secrets.inHistory, 2, "both files already have revisions in .bb-docs");
    const harness = new LeakHarness(c);
    harness.scan("settings:preview", preview);
    assert.deepEqual(harness.findings, []);
    await settingsSave(r.service, { ...change, configSha: (await settingsGet(r.service)).configSha });
    r.service.invalidate();
    const text = await documentText(r.service, "config/app.yaml");
    assert.equal(text.secrets.length, 1, "the write masks what the preview counted");
    assert.ok(!JSON.stringify(text).includes(c.A));
    const personal = await settingsPreview(r.service, { user: { secretKeys: ["other"] } });
    assert.equal(personal.secrets.values, 1);
    assert.match(personal.secrets.globalWarning, /not the shared .bb-docs data/);
  } finally {
    await r.cleanup();
  }
});
