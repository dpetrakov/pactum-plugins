// EP-007: checkout context, confinement and the end-to-end core check on this machine.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCheck } from "../node/check.ts";

process.env.DOCUMENT_REVIEW_CHECK_TREE_FILES ??= "60";
process.env.DOCUMENT_REVIEW_CHECK_CRASH_POINTS ??= "2";
process.env.DOCUMENT_REVIEW_CHECK_ROUNDS ??= "1";
process.env.DOCUMENT_REVIEW_CHECK_H7_SCALE ??= "0.1";
import { resolveCheckout } from "../node/checkout.ts";
import { ReviewService } from "../node/service.ts";

async function tempRepo({ email = "owner@bb-docs.invalid" } = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-src-")));
  const run = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.name", "Owner");
  if (email) run("config", "user.email", email);
  run("config", "commit.gpgsign", "false");
  await fs.mkdir(path.join(dir, "docs"));
  await fs.writeFile(path.join(dir, "docs/readme.md"), "# Readme\n\nText.\n");
  await fs.writeFile(path.join(dir, "notes.txt"), "not markdown\n");
  run("add", "-A");
  run("-c", `user.email=${email || "tmp@bb-docs.invalid"}`, "commit", "-q", "-m", "init");
  return dir;
}

/** Run with an empty HOME so the user's global Git identity does not leak into the test. */
async function withIsolatedHome(run) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-home-"));
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await fs.rm(home, { recursive: true, force: true });
  }
}

test("end-to-end core check passes on a temporary clone and leaves the source untouched", { timeout: 600_000 }, async () => {
  const source = await tempRepo();
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-data-"));
  try {
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: source }).toString() + execFileSync("git", ["rev-parse", "HEAD"], { cwd: source }).toString();
    const report = await runCheck({ source, dataDir: data, tempDir: data, keep: false, watch: null });
    const failed = report.steps.filter((step) => !step.ok);
    assert.deepEqual(failed, [], JSON.stringify(failed, null, 2));
    assert.ok(report.steps.length >= 15, `${report.steps.length} steps`);
    const after = execFileSync("git", ["status", "--porcelain"], { cwd: source }).toString() + execFileSync("git", ["rev-parse", "HEAD"], { cwd: source }).toString();
    assert.equal(after, before, "source repository unchanged");
    await assert.rejects(fs.access(path.join(source, ".bb-docs")));
  } finally {
    await fs.rm(source, { recursive: true, force: true });
    await fs.rm(data, { recursive: true, force: true });
  }
});

test("without user.email the checkout is read-only; a folder without Git has no review", async () => {
  const source = await tempRepo({ email: "" });
  const plain = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-plain-")));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-data-"));
  try {
    await withIsolatedHome(async () => {
      const info = await resolveCheckout(source);
      assert.equal(info.identity.email, null);
      const service = new ReviewService(info.root, data);
      const plan = await service.enablePlan();
      assert.equal(plan.documents, 2, "root «.» (W-06c): docs/readme.md and notes.txt");
      await assert.rejects(service.enable({}), (error) => error.code === "no-identity");
      const status = await service.status();
      assert.equal(status.readerId, null);
      assert.equal(status.enabled, false);
      const shown = await service.readDocument("docs/readme.md");
      assert.match(shown.text, /Readme/, "reading works without an identity");
    });
    const noGit = await resolveCheckout(plain);
    assert.equal(noGit.isRepo, false);
    const service = new ReviewService(noGit.root, data);
    await assert.rejects(service.enablePlan(), (error) => error.code === "read-only");
  } finally {
    for (const dir of [source, plain, data]) await fs.rm(dir, { recursive: true, force: true });
  }
});

test("explicit context: relative or missing checkout paths are refused, never resolved elsewhere", async () => {
  await assert.rejects(resolveCheckout("relative/path"), (error) => error.code === "bad-path");
  await assert.rejects(resolveCheckout(path.join(os.tmpdir(), "definitely-missing-bb-docs-dir")), (error) => error.code === "not-found");
});
