// EP-009-T03: the server's dispatch against the real host entry on a temporary checkout and a fake bb SDK of
// threads: queue-if-active into a busy thread, refusal for another checkout, a new visible thread with run
// metadata, unknown outcome without a second executor, definite refusal, reconciliation, cancel of a queued
// batch, «Waiting for you in the thread» from pending interactions, default recipient (E12).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import hostEntry from "../host.ts";
import plugin, { isDefiniteFailure } from "../server.ts";

process.env.DOCUMENT_REVIEW_DISPATCH_TIMEOUT_MS = "300";

async function setup() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-srv-")));
  const run = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.name", "Owner");
  run("config", "user.email", "owner@bb-docs.invalid");
  await fs.mkdir(path.join(dir, "docs"));
  await fs.writeFile(path.join(dir, "docs/a.md"), "# A\n\nПервый абзац для агента.\n\nВторой абзац.\n");
  run("add", "-A");
  run("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "init");
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-srv-data-"));
  const context = { experimental_paths: { dataDir: data, tempDir: os.tmpdir() }, experimental_watch: async () => ({ dispose: async () => {} }), experimental_emitSignal: async () => {} };
  const callHost = async (method, input) => hostEntry.handlers[method](input, context);

  // Fake bb: threads with a queue, interactions, metadata; environments and hosts.
  const threads = new Map([
    ["thr_busy", { id: "thr_busy", title: "Занятый", status: "active", environmentId: "env_a", projectId: "proj", providerId: "claude-code", archivedAt: null, deletedAt: null }],
    ["thr_other", { id: "thr_other", title: "Чужой", status: "idle", environmentId: "env_b", projectId: "proj", providerId: "claude-code", archivedAt: null, deletedAt: null }],
  ]);
  const queues = new Map();
  const turns = new Map();
  const interactions = new Map();
  const metadata = new Map();
  const behaviour = { send: "ok", spawn: "ok" };
  let spawned = 0;
  let seq = 0;
  const sdk = {
    threads: {
      get: async ({ threadId }) => { const thread = threads.get(threadId); if (!thread) throw new Error("HTTP 404: not found"); return thread; },
      send: async ({ threadId, input }) => {
        if (behaviour.send === "timeout") return new Promise(() => {});
        if (behaviour.send === "refuse") throw new Error("HTTP 409: thread cannot accept messages");
        const thread = threads.get(threadId);
        if (thread.status === "active") {
          const row = { id: `qmsg_${++seq}`, content: input };
          queues.set(threadId, [...(queues.get(threadId) ?? []), row]);
          return { ok: true, delivery: "queued", queuedMessage: row };
        }
        turns.set(threadId, [...(turns.get(threadId) ?? []), { data: { input } }]);
        return { ok: true, delivery: "sent" };
      },
      spawn: async (args) => {
        if (behaviour.spawn === "timeout") {
          // bb created the thread but the answer never came back.
          const id = `thr_new${++spawned}`;
          threads.set(id, { id, title: args.title, status: "active", environmentId: "env_a", projectId: args.projectId, providerId: "claude-code", archivedAt: null, deletedAt: null, originPluginId: "document-review" });
          metadata.set(id, args.pluginMetadata);
          return new Promise(() => {});
        }
        const id = `thr_new${++spawned}`;
        threads.set(id, { id, title: args.title, status: "active", environmentId: args.environment.environmentId, projectId: args.projectId, providerId: "claude-code", archivedAt: null, deletedAt: null, visibility: args.visibility ?? "visible", originPluginId: "document-review" });
        metadata.set(id, args.pluginMetadata);
        return threads.get(id);
      },
      queuedMessages: {
        list: async ({ threadId }) => queues.get(threadId) ?? [],
        delete: async ({ threadId, queuedMessageId }) => {
          const rows = queues.get(threadId) ?? [];
          if (!rows.some((row) => row.id === queuedMessageId)) throw new Error("HTTP 404: Queued message not found");
          queues.set(threadId, rows.filter((row) => row.id !== queuedMessageId));
          return { ok: true };
        },
      },
      interactions: { list: async ({ threadId }) => interactions.get(threadId) ?? [] },
      events: { list: async ({ threadId }) => [...(turns.get(threadId) ?? [])].reverse() },
      list: async () => [...threads.values()].filter((thread) => thread.originPluginId === "document-review"),
      getPluginMetadata: async ({ threadId }) => metadata.get(threadId) ?? {},
      // bb 0.46: metadata of many threads at once; threads without it are absent.
      experimental_listPluginMetadata: async ({ threadIds }) => ({ threads: threadIds.filter((id) => metadata.has(id)).map((threadId) => ({ threadId, metadata: metadata.get(threadId) })) }),
    },
    environments: {
      get: async ({ environmentId }) => ({ env_a: { id: "env_a", projectId: "proj", hostId: "host_1", path: dir }, env_b: { id: "env_b", projectId: "proj", hostId: "host_1", path: "/elsewhere" } })[environmentId],
      list: async () => [{ id: "env_a", projectId: "proj", hostId: "host_1", path: dir, status: "ready" }],
    },
    hosts: { get: async () => ({ id: "host_1", name: "test", status: "connected" }), list: async () => [] },
    projects: { list: async () => [] },
  };
  const handlers = {};
  const bb = {
    sdk,
    hosts: { experimental_client: () => ({ call: (method, input) => callHost(method, input), experimental_onSignal: () => () => {} }) },
    onDispose: () => {},
    realtime: { publish: () => {} },
    rpc: { register: (_contract, impl) => Object.assign(handlers, impl) },
    agents: { registerTool: () => {}, configure: () => {} },
    cli: { register: () => {} },
  };
  await plugin(bb);
  const target = { environmentId: "env_a" };
  await callHost("enable", { root: dir });
  const view = (await callHost("view", { root: dir, path: "docs/a.md" })).result;
  const annotate = async (needle, text) => {
    const block = view.blocks.find((entry) => entry.text.includes(needle));
    const start = block.range.start + [...block.text.slice(0, block.text.indexOf(needle))].length;
    const reply = await callHost("annotate", { root: dir, path: "docs/a.md", observation: { sha: view.document.sha }, text, kind: "action", range: { start, end: start + [...needle].length }, quote: needle });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply.result.annotationId;
  };
  return { dir, data, handlers, target, annotate, threads, queues, turns, interactions, metadata, behaviour, callHost, cleanup: () => Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]) };
}

test("dispatch: busy current thread gets the batch queued; another checkout is refused; status says «В очереди», then waiting for the user", async () => {
  const t = await setup();
  try {
    await t.annotate("Первый абзац", "Перепиши");
    const foreign = await t.handlers["review.batch.send"]({ target: t.target, scope: { kind: "document", path: "docs/a.md" }, recipient: { mode: "current-thread", threadId: "thr_other" } });
    assert.equal(foreign.ok, false);
    assert.equal(foreign.error.code, "foreign-checkout", "a thread of another checkout is refused with an explanation (AC18)");
    const sent = await t.handlers["review.batch.send"]({ target: t.target, scope: { kind: "document", path: "docs/a.md" }, recipient: { mode: "current-thread", threadId: "thr_busy" } });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.equal(sent.state, "queued", "a busy thread queues the batch without interrupting (AC18)");
    assert.equal(t.queues.get("thr_busy").length, 1);
    assert.match(t.queues.get("thr_busy")[0].content[0].text, new RegExp(sent.runId));
    let status = await t.handlers["review.batch.status"]({ target: t.target });
    assert.equal(status.thread.queued, true);
    assert.equal(status.recipient.threadId, "thr_busy", "the default recipient is the previous batch's thread (E12)");
    // The thread takes the message and asks for a permission: «Waiting for you in the thread» (AC21).
    // Only a removal from the queue is not proof of delivery: status stays «queued» until the turn is seen.
    const row = t.queues.get("thr_busy")[0];
    t.queues.set("thr_busy", []);
    let interim = await t.handlers["review.batch.status"]({ target: t.target });
    assert.equal(interim.launch.state, "queued", "a vanished queue row alone is not recorded as delivered");
    t.turns.set("thr_busy", [{ data: { input: row.content } }]);
    t.interactions.set("thr_busy", [{ payload: { kind: "approval" } }]);
    status = await t.handlers["review.batch.status"]({ target: t.target });
    assert.equal(status.thread.queued, false);
    assert.equal(status.thread.waitingUser, true);
    assert.deepEqual(status.thread.interactions, ["approval"]);
    assert.equal(status.launch.state, "sent", "leaving the queue is remembered as delivered");
    // DR-01: while it runs, the next batch waits.
    await t.annotate("Второй абзац", "И этот");
    const second = await t.handlers["review.batch.send"]({ target: t.target, scope: { kind: "all" }, recipient: { mode: "current-thread", threadId: "thr_busy" } });
    assert.equal(second.error.code, "busy");
    // A queued batch that was already delivered is not «cancelled».
    const cancel = await t.handlers["review.batch.recover"]({ target: t.target, runId: sent.runId, action: "cancel" });
    assert.equal(cancel.ok, false);
    assert.equal(cancel.error.code, "already-delivered");
  } finally {
    await t.cleanup();
  }
});

test("dispatch: a new visible thread in the same checkout with run metadata; cancel of a still queued batch withdraws it", async () => {
  const t = await setup();
  try {
    await t.annotate("Первый абзац", "Перепиши");
    const sent = await t.handlers["review.batch.send"]({ target: t.target, scope: { kind: "all" }, recipient: { mode: "new-thread", threadId: null } });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const thread = t.threads.get(sent.threadId);
    assert.equal(thread.environmentId, "env_a", "the new thread works in the shown checkout");
    assert.equal(thread.visibility, "visible");
    assert.equal(t.metadata.get(sent.threadId).runId, sent.runId);
    await t.handlers["review.batch.recover"]({ target: t.target, runId: sent.runId, action: "cancel" }).then((reply) => assert.equal(reply.error?.code, "already-delivered"));
  } finally {
    await t.cleanup();
  }
  const u = await setup();
  try {
    await u.annotate("Первый абзац", "Перепиши");
    const sent = await u.handlers["review.batch.send"]({ target: u.target, scope: { kind: "all" }, recipient: { mode: "current-thread", threadId: "thr_busy" } });
    assert.equal(sent.state, "queued");
    const cancelled = await u.handlers["review.batch.recover"]({ target: u.target, runId: sent.runId, action: "cancel" });
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    assert.equal(u.queues.get("thr_busy").length, 0, "the queued message is withdrawn");
    const status = await u.handlers["review.batch.status"]({ target: u.target });
    assert.equal(status.active, null);
    assert.equal(status.recent[0].finished.outcome, "cancelled");
  } finally {
    await u.cleanup();
  }
});

test("dispatch: a refusal fails the run; a timeout is «dispatch-unknown» — no second executor until an explicit check (AC11)", { timeout: 120_000 }, async () => {
  assert.equal(isDefiniteFailure(new Error("HTTP 409: busy")), true);
  assert.equal(isDefiniteFailure(new Error("dispatch timeout: the outcome is unknown")), false);
  const t = await setup();
  try {
    await t.annotate("Первый абзац", "Перепиши");
    t.behaviour.send = "refuse";
    const refused = await t.handlers["review.batch.send"]({ target: t.target, scope: { kind: "all" }, recipient: { mode: "current-thread", threadId: "thr_busy" } });
    assert.equal(refused.error.code, "dispatch-failed");
    let status = await t.handlers["review.batch.status"]({ target: t.target });
    assert.equal(status.active, null, "a definite refusal releases the checkout");
    assert.equal(status.recent[0].finished.outcome, "failed");
    // The spawn hangs although bb created the thread.
    t.behaviour.spawn = "timeout";
    const pending = t.handlers["review.batch.send"]({ target: t.target, scope: { kind: "all" }, recipient: { mode: "new-thread", threadId: null } });
    const unknown = await pending;
    assert.equal(unknown.state, "dispatch-unknown");
    status = await t.handlers["review.batch.status"]({ target: t.target });
    assert.equal(status.launch.state, "dispatch-unknown");
    const again = await t.handlers["review.batch.send"]({ target: t.target, scope: { kind: "all" }, recipient: { mode: "new-thread", threadId: null } });
    assert.equal(again.error.code, "busy", "no second executor while the outcome is unknown");
    const resend = await t.handlers["review.batch.recover"]({ target: t.target, runId: unknown.runId, action: "resend" });
    assert.equal(resend.error.code, "already-delivered", "the explicit resend finds the created thread first");
    const check = await t.handlers["review.batch.recover"]({ target: t.target, runId: unknown.runId, action: "check" });
    assert.equal(check.found, true);
    assert.equal(t.metadata.get(check.threadId).runId, unknown.runId);
    status = await t.handlers["review.batch.status"]({ target: t.target });
    assert.equal(status.launch.state, "sent");
    assert.equal(status.active.attempts.at(-1).threadId, check.threadId);
  } finally {
    await t.cleanup();
  }
});

test("review fixes: a delivered batch the agent will not finish is finished by the user; late spawn; claims and late results", { timeout: 120_000 }, async () => {
  const t = await setup();
  try {
    await t.annotate("Первый абзац", "Перепиши");
    await t.annotate("Второй абзац", "И этот");
    // Late spawn: the thread exists, the attempt is not recorded; the agent's answer proves delivery.
    t.behaviour.spawn = "timeout";
    const unknown = await t.handlers["review.batch.send"]({ target: t.target, scope: { kind: "all" }, recipient: { mode: "new-thread", threadId: null } });
    assert.equal(unknown.state, "dispatch-unknown");
    const threadId = [...t.threads.keys()].find((id) => id.startsWith("thr_new"));
    const batch = (await t.callHost("batchGet", { root: t.dir, runId: unknown.runId, threadId })).result;
    const agent = { model: "claude-code", threadId };
    const foreign = await t.callHost("itemReply", { root: t.dir, runId: unknown.runId, itemId: batch.items[0].itemId, responseId: "x", status: "done", text: "чужой", agent: { model: "m", threadId: "thr_busy" } });
    assert.equal(foreign.ok, true, "the launch has no recipient thread yet for a new thread: the first answering thread is recorded");
    const second = await t.callHost("itemReply", { root: t.dir, runId: unknown.runId, itemId: batch.items[1].itemId, responseId: "y", status: "done", text: "ok", agent });
    assert.equal(second.ok, false);
    assert.equal(second.error.code, "foreign-thread", "after the first answer only that thread may act");
    // A claim on a document that is not an input of the batch is refused.
    await fs.writeFile(path.join(t.dir, "docs/b.md"), "# B\n\nДругой текст.\n");
    const claim = await t.callHost("itemReply", { root: t.dir, runId: unknown.runId, itemId: batch.items[1].itemId, responseId: "z", status: "done", text: "b", edits: [{ path: "docs/b.md", quote: "Другой текст." }], agent: { model: "m", threadId: "thr_busy" } });
    assert.equal(claim.error.code, "not-input");
    // The agent stops; the user finishes the delivered batch: partial, the checkout is released.
    const cancel = await t.handlers["review.batch.recover"]({ target: t.target, runId: unknown.runId, action: "cancel" });
    assert.equal(cancel.error.code, "already-delivered");
    const finished = await t.handlers["review.batch.recover"]({ target: t.target, runId: unknown.runId, action: "finish" });
    assert.equal(finished.ok, true, JSON.stringify(finished));
    assert.equal(finished.result.outcome, "partial");
    const status = await t.handlers["review.batch.status"]({ target: t.target });
    assert.equal(status.active, null);
    // A late answer to the finished batch is refused and covers nothing.
    const late = await t.callHost("itemReply", { root: t.dir, runId: unknown.runId, itemId: batch.items[1].itemId, responseId: "late", status: "done", text: "поздно", agent: { model: "m", threadId: "thr_busy" } });
    assert.equal(late.error.code, "finished");
    assert.equal(status.newInstructions.all, 1, "the unanswered item is a candidate again");
  } finally {
    await t.cleanup();
  }
});

test("W-06a: a bare `a.md` from bb's chat (workspace path of the thread's checkout) locates docs/a.md, not a missing root file", async () => {
  const t = await setup();
  try {
    const bare = await t.handlers["review.locate"]({ path: "a.md", kind: "workspace", environmentId: null, threadId: "thr_busy", hostId: null });
    assert.equal(bare.ok, true, JSON.stringify(bare));
    assert.equal(bare.result.relative, "docs/a.md");
    assert.equal(bare.result.environmentId, "env_a");
    assert.equal(bare.result.requested, "a.md");
    const exact = await t.handlers["review.locate"]({ path: "docs/a.md", kind: "workspace", environmentId: "env_a" });
    assert.equal(exact.result.relative, "docs/a.md");
    const none = await t.handlers["review.locate"]({ path: "format.md", kind: "workspace", environmentId: "env_a" });
    assert.equal(none.ok, true);
    assert.equal(none.result.relative, null, "nothing to open: the reader is told, not shown «удалён или переименован»");
    assert.deepEqual(none.result.candidates, []);
  } finally {
    await t.cleanup();
  }
});
