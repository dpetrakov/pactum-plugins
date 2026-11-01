// W-06a regression (EP-027-T01): bb's chat links a bare `format.md` as a workspace file with exactly that path; the
// the file opener resolved it from the repository root and incorrectly reported the file missing. The
// checkout's machine now resolves a workspace path: exact file, else the unique Markdown file ending with it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveCheckoutFile } from "../node/checkout.ts";

async function repo(files, untracked = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-locate-")));
  const run = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  const write = async (file, text) => {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), text);
  };
  for (const [file, text] of Object.entries(files)) await write(file, text);
  run("add", "-A");
  run("-c", "user.name=O", "-c", "user.email=o@bb-docs.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "init", "--allow-empty");
  for (const [file, text] of Object.entries(untracked)) await write(file, text);
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test("bare name from the chat: `format.md` resolves to the only docs/…/format.md of the checkout", async () => {
  const r = await repo({ "README.md": "# R\n", "docs/plugins/document-review/format.md": "# Формат\n", "docs/plugins/document-review/README.md": "# D\n" });
  try {
    assert.deepEqual(await resolveCheckoutFile(r.dir, "format.md"), { relative: "docs/plugins/document-review/format.md", candidates: ["docs/plugins/document-review/format.md"] });
    assert.deepEqual(await resolveCheckoutFile(r.dir, "./format.md"), { relative: "docs/plugins/document-review/format.md", candidates: ["docs/plugins/document-review/format.md"] });
    // A partial path matches by whole trailing segments only.
    assert.equal((await resolveCheckoutFile(r.dir, "document-review/format.md")).relative, "docs/plugins/document-review/format.md");
    assert.equal((await resolveCheckoutFile(r.dir, "mat.md")).relative, null);
  } finally {
    await r.cleanup();
  }
});

test("exact workspace path is kept as is, even when other files share the name", async () => {
  const r = await repo({ "README.md": "# R\n", "docs/README.md": "# D\n" });
  try {
    assert.deepEqual(await resolveCheckoutFile(r.dir, "README.md"), { relative: "README.md", candidates: ["README.md"] });
    assert.deepEqual(await resolveCheckoutFile(r.dir, "docs/README.md"), { relative: "docs/README.md", candidates: ["docs/README.md"] });
  } finally {
    await r.cleanup();
  }
});

test("several matches are offered, none is reported; untracked files count, ignored ones do not", async () => {
  const r = await repo({ ".gitignore": "build/\n", "docs/a/notes.md": "# A\n", "docs/b/notes.md": "# B\n" }, { "drafts/plan.md": "# P\n", "build/plan.md": "# ignored\n", "build/only.md": "# ignored\n" });
  try {
    assert.deepEqual(await resolveCheckoutFile(r.dir, "notes.md"), { relative: null, candidates: ["docs/a/notes.md", "docs/b/notes.md"] });
    assert.deepEqual(await resolveCheckoutFile(r.dir, "plan.md"), { relative: "drafts/plan.md", candidates: ["drafts/plan.md"] });
    assert.deepEqual(await resolveCheckoutFile(r.dir, "only.md"), { relative: null, candidates: [] });
    assert.deepEqual(await resolveCheckoutFile(r.dir, "missing.md"), { relative: null, candidates: [] });
  } finally {
    await r.cleanup();
  }
});

test("paths out of the checkout, symlinks out of it and non-Markdown files are refused", async () => {
  const r = await repo({ "docs/a.md": "# A\n", "docs/x.txt": "x" });
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-locate-out-")));
  try {
    await fs.writeFile(path.join(outside, "secret.md"), "# S\n");
    await fs.symlink(path.join(outside, "secret.md"), path.join(r.dir, "secret.md"));
    await assert.rejects(resolveCheckoutFile(r.dir, "../a.md"), (error) => error.code === "bad-path");
    await assert.rejects(resolveCheckoutFile(r.dir, "/etc/hosts.md"), (error) => error.code === "bad-path");
    await assert.rejects(resolveCheckoutFile(r.dir, "docs/x.png"), (error) => error.code === "bad-path");
    assert.deepEqual(await resolveCheckoutFile(r.dir, "secret.md"), { relative: null, candidates: [] });
    await assert.rejects(resolveCheckoutFile(path.join(r.dir, "nope"), "a.md"), (error) => error.code === "not-found");
  } finally {
    await r.cleanup();
    await fs.rm(outside, { recursive: true, force: true });
  }
});
