import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { documentFileInfo } from "../node/file.ts";
import { ReviewService } from "../node/service.ts";
import { changeRun, changeRuns } from "../ui/change-runs.ts";
import { passStops } from "../ui/pass.ts";

test("download preserves original UTF-8 bytes across bounded chunks and rejects changed files and traversal", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "docs-file-info-")));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "docs-file-info-data-"));
  try {
    const bytes = Buffer.from("# Русский документ\r\n🙂\n".repeat(40000));
    await fs.writeFile(path.join(root, "sample.md"), bytes);
    const service = new ReviewService(root, data);
    const info = await documentFileInfo(service, "sample.md");
    assert.equal(info.absolutePath, path.join(root, "sample.md"));
    assert.equal(info.relativePath, "sample.md");
    assert.equal(info.size, bytes.length);
    assert.equal(info.format, "markdown");
    const parts = [];
    let offset = 0;
    while (offset < info.size) {
      const chunk = await documentFileInfo(service, "sample.md", { offset, version: info.version });
      parts.push(Buffer.from(chunk.content, "base64"));
      assert.ok(parts.at(-1).length <= 512 * 1024);
      offset = chunk.next;
    }
    assert.deepEqual(Buffer.concat(parts), bytes);
    await fs.writeFile(path.join(root, "sample.md"), "changed");
    await assert.rejects(documentFileInfo(service, "sample.md", { offset: 0, version: info.version }), /file changed/i);
    await assert.rejects(documentFileInfo(service, "../outside.md"));
    await fs.symlink(path.join(root, "sample.md"), path.join(root, "link.md"));
    await assert.rejects(documentFileInfo(service, "link.md"));
    await fs.writeFile(path.join(root, "empty.md"), "");
    const empty = await documentFileInfo(service, "empty.md");
    assert.equal((await documentFileInfo(service, "empty.md", { offset: 0, version: empty.version })).content, "");
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(data, { recursive: true, force: true }); }
});

test("read marks and pass stops follow visual runs, with boundaries at read blocks, different marks, removals and tables", () => {
  const blocks = ["edited", "edited", null, "added", "added", "edited", "edited", "edited", "edited"].map((change, index) => ({ index, change, read: change ? "unread" : "read", type: index === 7 ? "tableCell" : "paragraph" }));
  const view = { blocks, removed: [{ after: 5, tombstoneId: "gone" }], annotations: [] };
  assert.deepEqual(changeRuns(view), [[0, 1], [3, 4], [5], [6], [7], [8]]);
  assert.deepEqual(changeRun(view, 1), [0, 1]);
  assert.deepEqual(passStops(view, "changes").filter((stop) => stop.blocks.length).map((stop) => stop.blocks), changeRuns(view));
  const annotated = { ...view, annotations: [{ annotationId: "note", status: "open", waiting: true, anchor: { status: "exact", place: 1, blocks: [1] }, latest: null }] };
  assert.deepEqual(passStops(annotated, "all")[0].annotations, ["note"], "an annotation on an inner block belongs to its run");
});
