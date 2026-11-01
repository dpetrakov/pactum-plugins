// EP-044 (W-06c, file-types.md §10): a round on structured files — an annotation on a YAML node keeps its key path
// (bbdr:KeyPathSelector, schema 1.2), the batch names the node (keyPath, jsonPointer) and the lines of a line-based file,
// the agent claims an edit by the key path, a JSON file the agent broke gives a warning of the round with the line, and
// the warning goes away once the file parses again; secret values reach the agent masked.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { batchGet, documentGet, finishBatch, itemReply, markDispatched, prepareBatch, roundSummary } from "../node/batches.ts";
import { ReviewService } from "../node/service.ts";
import { documentView } from "../node/view.ts";

async function repo(files) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-agent-")));
  const run = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.name", "Owner");
  run("config", "user.email", "owner@bb-docs.invalid");
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), text);
  }
  run("add", "-A");
  run("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "init");
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-agent-data-"));
  const service = new ReviewService(dir, data);
  await service.enable({ roots: ["."] });
  return { dir, service, write: (file, text) => fs.writeFile(path.join(dir, file), text),
    cleanup: () => Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]) };
}
const agent = { model: "claude-opus-5-5", threadId: "thr_w06c" };
const blockOf = (view, text) => view.blocks.findIndex((block) => block.text === text);

test("EP-044-T01/T02 key paths in the batch, an edit claimed by key path, a broken JSON warns the round until fixed", async () => {
  const r = await repo({
    "config/app.yaml": "server:\n  port: 8080\n  password: hunter2hunter2\n",
    "config/app.json": '{\n  "name": "x",\n  "size": 1\n}\n',
    "notes/todo.txt": "first line\nsecond line\n",
  });
  try {
    const yaml = await documentView(r.service, "config/app.yaml");
    const port = await r.service.annotate({ path: "config/app.yaml", observation: { sha: yaml.document.sha }, kind: "action", text: "Порт 9090", targetKind: "block", block: blockOf(yaml, "port: 8080") });
    const json = await documentView(r.service, "config/app.json");
    await r.service.annotate({ path: "config/app.json", observation: { sha: json.document.sha }, kind: "action", text: "Размер 2", targetKind: "block", block: blockOf(json, '"size": 1') });
    const txt = await documentView(r.service, "notes/todo.txt");
    await r.service.annotate({ path: "notes/todo.txt", observation: { sha: txt.document.sha }, kind: "note", text: "Уточнить", targetKind: "block", block: blockOf(txt, "second line") });
    const state = await r.service.state();
    const object = [...state.objects.values()].find((value) => value.type === "Annotation" && value.body.value === "Порт 9090");
    assert.equal(object["bbdr:schemaVersion"], "1.2");
    assert.deepEqual(object.target.selector.find((selector) => selector.type === "bbdr:KeyPathSelector"), { type: "bbdr:KeyPathSelector", value: '["server","port"]' });
    const note = [...state.objects.values()].find((value) => value.type === "Annotation" && value.body.value === "Уточнить");
    assert.deepEqual(note.target.selector.find((selector) => selector.type === "bbdr:LineRangeSelector"), { type: "bbdr:LineRangeSelector", start: 2, end: 2 });

    const prepared = await prepareBatch(r.service, { scope: { kind: "all" }, recipient: { mode: "current-thread", threadId: agent.threadId } });
    await markDispatched(r.service, { runId: prepared.runId, attemptId: prepared.attemptId, recipient: { mode: "current-thread", threadId: agent.threadId }, delivery: "sent" });
    const batch = await batchGet(r.service, { runId: prepared.runId, threadId: agent.threadId });
    const item = batch.items.find((entry) => entry.annotationId === port.annotationId);
    assert.equal(item.keyPath, "server.port");
    assert.equal(item.jsonPointer, "/server/port");
    assert.ok(!JSON.stringify(batch).includes("hunter2"), "secret values reach the agent masked");
    assert.ok(!(await documentGet(r.service, { path: "config/app.yaml" })).text.includes("hunter2"));

    await r.write("config/app.yaml", "server:\n  port: 9090\n  password: hunter2hunter2\n");
    await r.write("config/app.json", '{\n  "name": "x",\n  "size": 2,\n}\n}\n');
    await assert.rejects(itemReply(r.service, { runId: prepared.runId, itemId: item.itemId, responseId: "bad", status: "done", text: "x", edits: [{ path: "config/app.yaml", keyPath: "server.nope" }], agent }),
      (error) => error.code === "bad-claim" && /key path not found/.test(error.message));
    const reply = await itemReply(r.service, { runId: prepared.runId, itemId: item.itemId, responseId: "r1", status: "done", text: "Порт 9090", edits: [{ path: "config/app.yaml", keyPath: "server.port" }], agent });
    assert.equal(reply.confirmedBlocks, 1, "the claim by key path is confirmed by the new text");
    const finished = await finishBatch(r.service, { runId: prepared.runId, agent });
    assert.equal(finished.summary.parseErrors.length, 1);
    assert.equal(finished.summary.parseErrors[0].path, "config/app.json");
    assert.ok(finished.summary.parseErrors[0].line >= 3);
    await r.write("config/app.json", '{\n  "name": "x",\n  "size": 2\n}\n');
    r.service.invalidate();
    assert.deepEqual((await roundSummary(r.service, await r.service.state(), prepared.runId)).parseErrors, [], "fixed: the warning is gone");
  } finally {
    await r.cleanup();
  }
});
