// EP-039: secrets never leave the checkout. A temporary repository holds unique canaries in every wave-1 format
// (.env.example, .env vars with export/quotes/multi-line, YAML with nested keys, an object under a secret key, anchors,
// block scalars, JSON, JSONC, TOML with inline tables and arrays of tables, PEM and URL passwords under harmless keys
// and in Markdown, text and CSV) and an ignored .env.local. The full cycle runs through the real host entry and the
// server with a fake bb (UI RPCs, agent tools, CLI): enable, views, reveal by click, annotations, a batch with an agent
// changing a secret value, «Accept», validate, orphans, perf, check. Every output is searched for each canary and its
// encodings (tests/leak-harness.mjs): .bb-docs, the plugin's data directory (except the device HMAC store), RPC
// answers, thread messages, agent tool results, CLI stdout/stderr, logs, errors. Zero findings is required.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canary, LeakHarness } from "./leak-harness.mjs";
import { runLeakCycle, setup } from "./leak-cycle.mjs";

test("EP-039 leak: the full cycle over every format leaves no canary in any output", { timeout: 900_000 }, async () => {
  const t = await setup();
  const result = await runLeakCycle(t);
  if (process.env.LEAK_REPORT) await fs.writeFile(process.env.LEAK_REPORT, JSON.stringify(result, null, 2));
  assert.deepEqual(result.findings, [], `leaks: ${JSON.stringify(result.findings.slice(0, 5), null, 1)}`);
  const failed = result.steps.filter((s) => !s.ok);
  assert.deepEqual(failed, [], `cycle steps failed: ${JSON.stringify(failed, null, 1)}`);
  assert.ok(Object.keys(result.outputs).length >= 20, "every output was checked");
});

test("EP-039-T01 harness self-check: a deliberate leak into a log, a snapshot and a batch answer is found each", async () => {
  const c = { A: canary(), B: canary(), C: canary() };
  const h = new LeakHarness(c);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-leak-self-"));
  try {
    await fs.mkdir(path.join(dir, "snapshots/ab"), { recursive: true });
    await fs.writeFile(path.join(dir, "snapshots/ab/x.md"), `text ${Buffer.from(c.B).toString("base64")} text`);
    h.scan("logs", `debug: value=${c.A.slice(0, 7)}…`);
    await h.scanDir(".bb-docs", dir);
    h.scan("agent:review_batch_get", { quote: encodeURIComponent(c.C) });
    const found = new Set(h.report().findings.map((f) => `${f.output}:${f.canary}:${f.encoding}`));
    assert.ok(found.has("logs:A:prefix-6"), "prefix in a log");
    assert.ok(found.has(".bb-docs:B:base64"), "base64 in a snapshot");
    assert.ok(found.has("agent:review_batch_get:C:url"), "URL-encoded in a batch answer");
    h.allow("rpc:reveal", "A");
    const before = h.report().findings.length;
    h.scan("rpc:reveal", c.A);
    assert.equal(h.report().findings.length, before, "an allowed positive control is not a finding");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
