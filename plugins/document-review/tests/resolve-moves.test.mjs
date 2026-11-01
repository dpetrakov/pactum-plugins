// Resolve missing files in a batch: process each independently so one failure cannot block other decisions.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReviewService } from "../node/service.ts";

test("resolveMoves: renames by Git carry history, an unknown document fails alone", async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-moves-")));
  const dir = path.join(base, "repo");
  const data = path.join(base, "data");
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, stdio: "pipe" });
  try {
    await fs.mkdir(path.join(dir, "docs/_archive"), { recursive: true });
    git("init", "-q", "-b", "main"); git("config", "user.name", "Owner"); git("config", "user.email", "owner@bb-docs.invalid");
    for (const name of ["a", "b"]) await fs.writeFile(path.join(dir, `docs/${name}.md`), `# ${name}\n\nТекст ${name} — достаточно длинный абзац, чтобы сравнение было уверенным.\n`);
    git("add", "."); git("commit", "-q", "-m", "docs");
    let service = new ReviewService(dir, data);
    for (;;) { const step = await service.enable({ limit: 100, markGenerated: true }); if (step.enabled) break; }
    git("add", "."); git("commit", "-q", "-m", "enable");
    const state = await service.state();
    const ids = Object.fromEntries([...state.documents.values()].map((doc) => [doc.path, doc.docId]));
    git("mv", "docs/a.md", "docs/_archive/a.md"); git("mv", "docs/b.md", "docs/_archive/b.md"); git("commit", "-q", "-m", "archive");
    const { default: entry } = await import("../host.ts");
    const paths = { dataDir: data, tempDir: path.join(data, "tmp") };
    const reply = await entry.handlers.resolveMoves({ root: dir, items: [
      { docId: ids["docs/a.md"], to: "docs/_archive/a.md" },
      { docId: "00000000-0000-4000-8000-000000000000", to: null },
      { docId: ids["docs/b.md"], to: "docs/_archive/b.md" },
    ] }, { signal: new AbortController().signal, experimental_paths: paths });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const results = reply.result?.results ?? reply.results;
    assert.deepEqual(results.map((item) => item.status), ["moved", "failed", "moved"]);
    service = new ReviewService(dir, data);
    const after = [...(await service.state()).documents.values()].map((doc) => doc.path).sort();
    assert.deepEqual(after, ["docs/_archive/a.md", "docs/_archive/b.md"]);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});
