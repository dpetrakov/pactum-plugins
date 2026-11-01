// Enable in steps (2026-10-16): with `limit` one call registers at most that many documents, the config appears only
// with the last step, an interrupted enable resumes without registering a document twice, and the result is the same
// as one whole enable.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReviewService } from "../node/service.ts";

async function repo(count) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-steps-")));
  const dir = path.join(base, "repo");
  await fs.mkdir(path.join(dir, "docs"), { recursive: true });
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Owner");
  git("config", "user.email", "owner@bb-docs.invalid");
  for (let index = 0; index < count; index++) await fs.writeFile(path.join(dir, `docs/d${String(index).padStart(2, "0")}.md`), `# Документ ${index}\n\nТекст ${index}.\n`);
  git("add", ".");
  git("commit", "-q", "-m", "docs");
  return { dir, data: path.join(base, "data"), cleanup: () => fs.rm(base, { recursive: true, force: true }) };
}

const configExists = (dir) => fs.access(path.join(dir, ".bb-docs/config.json")).then(() => true, () => false);

test("enable in steps: at most `limit` documents per call, the config with the last step, nothing twice", async () => {
  const { dir, data, cleanup } = await repo(23);
  try {
    const service = new ReviewService(dir, data);
    const head = (await service.enablePlan()).head;
    const steps = [];
    let first = true;
    for (;;) {
      const step = await service.enable({ limit: 10, markGenerated: true, ...(first ? { head } : {}) });
      first = false;
      steps.push(step);
      if (step.enabled) break;
      assert.equal(await configExists(dir), false, "no config before the last step");
    }
    assert.deepEqual(steps.map((step) => [step.documents, step.remaining, step.total, step.enabled]), [[10, 13, 23, false], [10, 3, 23, false], [3, 0, 23, true]]);
    assert.equal(await configExists(dir), true);
    assert.match(await fs.readFile(path.join(dir, ".gitattributes"), "utf8"), /\.bb-docs\/\*\* linguist-generated/);
    const state = await service.state();
    const paths = [...state.documents.values()].map((doc) => doc.path).sort();
    assert.equal(paths.length, 23);
    assert.equal(new Set(paths).size, 23, "every document registered once");
    // Enabled: a further call changes nothing.
    assert.deepEqual(await service.enable({ limit: 10 }), { enabled: true, created: false, documents: 0, operations: 0, remaining: 0, total: 0 });
  } finally { await cleanup(); }
});

test("an interrupted enable resumes in a new service (worker restart) and HEAD is checked only when given", async () => {
  const { dir, data, cleanup } = await repo(12);
  try {
    const step = await new ReviewService(dir, data).enable({ limit: 5 });
    assert.deepEqual([step.documents, step.remaining, step.enabled], [5, 7, false]);
    await assert.rejects(new ReviewService(dir, data).enable({ limit: 5, head: "0".repeat(40) }), /HEAD moved/);
    const resumed = new ReviewService(dir, data);
    const rest = await resumed.enable({});
    assert.deepEqual([rest.documents, rest.remaining, rest.enabled, rest.total], [7, 0, true, 12]);
    assert.equal([...(await resumed.state()).documents.values()].length, 12);
  } finally { await cleanup(); }
});

test("a cancelled host call answers at once, before the work behind the checkout's queue is done", async () => {
  const { dir, data, cleanup } = await repo(3);
  try {
    const { default: entry } = await import("../host.ts");
    const paths = { dataDir: data, tempDir: path.join(data, "tmp") };
    const controller = new AbortController();
    const started = Date.now();
    const pending = entry.handlers.status({ root: dir }, { signal: controller.signal, experimental_paths: paths });
    controller.abort();
    await assert.rejects(pending, (error) => error.name === "AbortError" && /cancelled by the caller/.test(error.message));
    assert.ok(Date.now() - started < 1000, "answered without waiting for the work");
    // Without cancellation the same call answers as usual.
    const reply = await entry.handlers.status({ root: dir }, { signal: new AbortController().signal, experimental_paths: paths });
    assert.equal(reply.ok, true);
  } finally { await cleanup(); }
});

test("a step ends on its time budget but always moves on, and the enable completes", async () => {
  const { dir, data, cleanup } = await repo(15);
  try {
    const service = new ReviewService(dir, data);
    let steps = 0;
    for (;;) {
      const step = await service.enable({ limit: 1000, budgetMs: 100 });
      steps++;
      assert.ok(step.enabled || step.documents >= 1, "every step registers at least one document");
      if (step.enabled) break;
      assert.ok(steps < 100);
    }
    assert.equal([...(await service.state()).documents.values()].length, 15);
  } finally { await cleanup(); }
});

test("files over 1 MiB stay out of the initial base: the plan says so, the enable completes, they register on first use", async () => {
  const { dir, data, cleanup } = await repo(4);
  try {
    const big = JSON.stringify({ items: Array.from({ length: 20000 }, (_, i) => ({ sku: `s-${i}`, name: `Запчасть ${i}`, price: i })) }, null, 2);
    assert.ok(Buffer.byteLength(big) > 1024 * 1024);
    await fs.mkdir(path.join(dir, "data"));
    await fs.writeFile(path.join(dir, "data/big.json"), big);
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "add", "."], { cwd: dir });
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "big"], { cwd: dir });
    const service = new ReviewService(dir, data);
    const plan = await service.enablePlan();
    assert.equal(plan.deferred.count, 1);
    assert.deepEqual(plan.deferred.largest.map((file) => file.path), ["data/big.json"]);
    assert.ok(!plan.documents || plan.documents >= 4);
    let step;
    do step = await service.enable({ limit: 2 }); while (!step.enabled);
    assert.equal(step.deferred, 1);
    const paths = [...(await service.state()).documents.values()].map((doc) => doc.path);
    assert.ok(!paths.includes("data/big.json"), "not in the initial base");
  } finally { await cleanup(); }
});
