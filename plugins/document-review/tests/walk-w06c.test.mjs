// EP-041-T01: the walk from the root «.» — classes of files (in Git / new / outside Git), exclusion levels (built-in,
// returned in the repository, global, global with an exemption, repository over global), nested .gitignore with
// negations, .env ignored → outside Git (shown, not tracked), a non-ignored .env → new, a file inside an ignored folder
// shown with its class unless an exclusion removes it, .venv/ and node_modules/ never shown, symlinks never listed,
// MAX_ENTRIES and the time budget give a partial tree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Exclusions, exclusionPatternProblem } from "../node/exclusions.ts";
import { ReviewService } from "../node/service.ts";
import { documentTree } from "../node/tree.ts";
import { updateUserSettings } from "../node/user-settings.ts";
import { walkRoots } from "../node/walk.ts";

async function repo(files, ignored = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-walk-")));
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Owner");
  git("config", "user.email", "owner@bb-docs.invalid");
  const write = async (file, text) => { await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await fs.writeFile(path.join(dir, file), text); };
  for (const [file, text] of Object.entries(files)) await write(file, text);
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  for (const [file, text] of Object.entries(ignored)) await write(file, text);
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-walk-data-"));
  return { dir, data, git, write, service: new ReviewService(dir, data), cleanup: () => Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]) };
}

test("EP-041-T01 exclusion levels: built-in, returned in the repository, global, exempted global, repository over global", () => {
  const plain = new Exclusions();
  assert.equal(plain.decide("build", true).excluded, true);
  assert.deepEqual(plain.decide("build/x.md").rule, { level: "builtin", pattern: "build/" });
  assert.equal(plain.decide("pkg/node_modules", true).rule.pattern, "node_modules/");
  assert.equal(plain.decide("package-lock.json").excluded, true);
  assert.equal(plain.decide(".venv", true).excluded, true);
  assert.equal(plain.decide("src/__pycache__", true).excluded, true);
  assert.equal(plain.decide("docs/a.md").excluded, false);
  assert.equal(plain.decide(".git", true).rule.level, "immutable");
  const returned = new Exclusions({ repo: ["!build/"] });
  assert.equal(returned.decide("build", true).excluded, false, "the repository returns a built-in rule");
  const returnedGlobally = new Exclusions({ global: ["!build/"] });
  assert.equal(returnedGlobally.decide("build", true).excluded, false, "the user returns it for all their checkouts");
  const global = new Exclusions({ global: ["fixtures/big/"] });
  assert.deepEqual(global.decide("fixtures/big", true).rule, { level: "global", pattern: "fixtures/big/" });
  const exempt = new Exclusions({ global: ["fixtures/big/"], globalExempt: ["fixtures/big/"] });
  assert.equal(exempt.decide("fixtures/big", true).excluded, false, "a personal exemption for this repository");
  const over = new Exclusions({ global: ["fixtures/*"], repo: ["!fixtures/keep/"] });
  assert.equal(over.decide("fixtures/x.md").excluded, true);
  assert.equal(over.decide("fixtures/keep", true).excluded, false, "the repository rule comes after the global one");
  // .gitignore semantics: a file cannot be returned from an excluded folder (exclude its contents instead).
  assert.equal(new Exclusions({ global: ["fixtures/"], repo: ["!fixtures/keep/"] }).decide("fixtures/keep", true).excluded, true);
  const immutable = new Exclusions({ repo: ["!.git/", "!.bb-docs/"] });
  assert.equal(immutable.decide(".bb-docs", true).excluded, true, "immutable rules cannot be returned");
  assert.match(exclusionPatternProblem("") ?? "", /empty/);
  assert.match(exclusionPatternProblem("a\\b") ?? "", /invalid/);
  assert.equal(exclusionPatternProblem("docs/archive/"), null);
  assert.ok(plain.listing().some((entry) => entry.level === "builtin" && entry.pattern === "dist/"));
});

test("EP-041-T01 classes and the tree from «.»: ignored files shown with their class, never tracked; built-in exclusions; symlinks", async () => {
  const r = await repo({
    ".gitignore": ".env\nlocal/\nbuild/\n!build/keep.md\n",
    "docs/a.md": "# A\n", "config/app.yaml": "a: 1\n", "package.json": "{\"name\":\"x\"}\n", "package-lock.json": "{}\n", "data/list.csv": "a,b\n1,2\n",
    "sub/.gitignore": "*.log.txt\n!keep.log.txt\n",
  }, {
    ".env": "TOKEN=abc\n", ".env.example2": "", "local/notes.txt": "локально\n", "node_modules/x/readme.md": "# dep\n", ".venv/lib/a.txt": "venv\n",
    "sub/run.log.txt": "log\n", "sub/keep.log.txt": "keep\n", "new.md": "# New\n",
  });
  try {
    await fs.symlink(path.join(r.dir, "docs/a.md"), path.join(r.dir, "docs/link.md"));
    await r.service.enable({ roots: ["."] });
    const tree = await documentTree(r.service, { budgetMs: 30_000 });
    const entry = (file) => tree.entries.find((item) => item.path === file);
    assert.equal(entry("docs/a.md").fileClass, "git");
    assert.equal(entry("config/app.yaml").format, "yaml");
    assert.equal(entry(".env").fileClass, "outside", ".env in .gitignore is outside Git");
    assert.equal(entry(".env").supported, false, "shown only");
    assert.equal(entry(".env").state, null, "no review state");
    assert.equal(entry("local/notes.txt").fileClass, "outside", "a file in an ignored folder is shown with its class");
    assert.equal(entry("sub/run.log.txt").fileClass, "outside", "nested .gitignore");
    assert.equal(entry("sub/keep.log.txt").fileClass, "new", "negation in a nested .gitignore");
    assert.equal(entry("new.md").fileClass, "new");
    assert.equal(entry("package-lock.json"), undefined, "lock files are built-in exclusions");
    assert.equal(entry("node_modules/x/readme.md"), undefined);
    assert.equal(entry(".venv/lib/a.txt"), undefined, ".venv/ is a built-in exclusion even though it is ignored");
    assert.equal(entry("docs/link.md"), undefined, "symlinks are not listed");
    assert.ok(tree.notShown.symlinks >= 1);
    assert.ok(tree.notShown.rules.some((rule) => rule.pattern === "node_modules/" && rule.level === "builtin"));
    // The tracked set: same walk, without files outside Git.
    const tracked = (await r.service.trackedDocuments((await r.service.config()).value)).map((doc) => doc.path);
    assert.ok(tracked.includes("config/app.yaml") && tracked.includes("data/list.csv") && tracked.includes("package.json") && tracked.includes("new.md"));
    assert.ok(!tracked.includes(".env") && !tracked.includes("local/notes.txt") && !tracked.includes("package-lock.json"));
    // A .env that is not ignored is «new»: ordinary review (its values are masked in the shared data, §8).
    await r.write("deploy/.env.prod", "KEY=value\n");
    r.service.invalidate();
    assert.equal(await r.service.fileClass("deploy/.env.prod"), "new");
    // Global rule of the user and the repository rule.
    const readerId = "owner@bb-docs.invalid";
    await updateUserSettings(r.data, readerId, (settings) => { settings.exclude.push("data/"); });
    const config = (await r.service.config()).value;
    await fs.writeFile(path.join(r.dir, ".bb-docs/config.json"), JSON.stringify({ ...config, schemaVersion: "1.2", exclude: ["config/"] }, null, 2) + "\n");
    r.service.invalidate();
    const ruled = await documentTree(r.service, { budgetMs: 30_000 });
    assert.equal(ruled.entries.find((item) => item.path === "data/list.csv"), undefined, "global rule");
    assert.equal(ruled.entries.find((item) => item.path === "config/app.yaml"), undefined, "repository rule");
    assert.ok(ruled.notShown.rules.some((rule) => rule.level === "global" && rule.pattern === "data/"));
    assert.ok(ruled.notShown.rules.some((rule) => rule.level === "repo" && rule.pattern === "config/"));
    assert.ok(!ruled.virtual.some((item) => item.path === "config/app.yaml"), "an excluded registered document is not «missing»");
    await assert.rejects(r.service.annotate({ path: "config/app.yaml", observation: { sha: "0".repeat(64) }, text: "x", kind: "note", targetKind: "document" }), (error) => error.code === "excluded");
  } finally {
    await r.cleanup();
  }
});

test("EP-041-T01 MAX_ENTRIES and the time budget give a partial tree that says so", async () => {
  const files = {};
  for (let i = 0; i < 60; i++) files[`docs/f${String(i).padStart(2, "0")}.md`] = `# ${i}\n`;
  const r = await repo(files);
  try {
    const capped = await walkRoots(r.dir, ["."], { exclusions: new Exclusions(), maxEntries: 50 });
    assert.equal(capped.files.size, 50);
    assert.equal(capped.truncated, 10);
    const timed = await walkRoots(r.dir, ["."], { exclusions: new Exclusions(), budgetMs: -1 });
    assert.equal(timed.partial, true);
  } finally {
    await r.cleanup();
  }
});
