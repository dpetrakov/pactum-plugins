// The full leak cycle of W-06c secrets (EP-039), shared by tests/leak-w06c.test.mjs and the live run on a machine
// (scripts/w06c-leak-live.mjs): fixtures with canaries in a temporary repository (or under a prefix of a copy of a real
// repository), the real host entry and server with a fake bb, every output scanned by tests/leak-harness.mjs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LeakHarness } from "./leak-harness.mjs";
import { canaries, fixtures } from "./leak-fixtures.mjs";

process.env.DOCUMENT_REVIEW_DISPATCH_TIMEOUT_MS ??= "2000";

export async function setup(options = {}) {
  const prefix = options.prefix ?? "";
  const c = canaries();
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-leak-")));
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, stdio: "pipe", maxBuffer: 256 * 1024 * 1024 }).toString();
  if (options.source) {
    // A copy of a real repository (its history and .bb-docs), the fixtures under a prefix inside its review roots.
    execFileSync("git", ["clone", "-q", "--no-hardlinks", options.source, dir], { stdio: "pipe" });
  } else git("init", "-q", "-b", "main");
  git("config", "user.name", "Owner");
  git("config", "user.email", "owner@bb-docs.invalid");
  for (const [file, text] of Object.entries(fixtures(c))) {
    const target = file === ".gitignore" && prefix ? `${prefix}.gitignore` : `${prefix}${file}`;
    await fs.mkdir(path.dirname(path.join(dir, target)), { recursive: true });
    await fs.writeFile(path.join(dir, target), text);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "fixtures");
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-leak-data-"));
  const harness = new LeakHarness(c);
  // The revealed value is allowed exactly in the reveal answer (it is shown, not stored).
  harness.allow("rpc:reveal", "YAML_PASSWORD");
  harness.allow("host:revealSecret", "YAML_PASSWORD");
  const logs = [];
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  for (const level of Object.keys(original)) console[level] = (...args) => { logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };
  const restore = () => Object.assign(console, original);

  const hostEntry = (await import("../host.ts")).default;
  const plugin = (await import("../server.ts")).default;
  const context = { experimental_paths: { dataDir: data, tempDir: os.tmpdir() }, experimental_watch: async () => ({ dispose: async () => {} }), experimental_emitSignal: async () => {} };
  const callHost = async (method, input) => {
    const result = await hostEntry.handlers[method](input, context);
    harness.scan(`host:${method}`, result, input?.path ?? "");
    return result;
  };
  const threads = new Map([["thr_cur", { id: "thr_cur", title: "Текущий", status: "idle", environmentId: "env_a", projectId: "proj", providerId: "claude-code", archivedAt: null, deletedAt: null }]]);
  const sent = [];
  const sdk = {
    threads: {
      get: async ({ threadId }) => threads.get(threadId),
      send: async ({ threadId, input }) => { sent.push({ threadId, input }); harness.scan("thread:send", input); return { ok: true, delivery: "sent" }; },
      spawn: async (args) => { harness.scan("thread:spawn", args); const id = `thr_new${threads.size}`; threads.set(id, { id, status: "active", environmentId: "env_a", projectId: "proj", originPluginId: "document-review" }); return threads.get(id); },
      queuedMessages: { list: async () => [], delete: async () => ({ ok: true }) },
      interactions: { list: async () => [] },
      events: { list: async () => [] },
      list: async () => [],
      getPluginMetadata: async () => ({}),
      experimental_listPluginMetadata: async () => ({ threads: [] }),
      get_: null,
    },
    environments: {
      get: async ({ environmentId }) => (environmentId === "env_a" ? { id: "env_a", projectId: "proj", hostId: "host_1", path: dir } : undefined),
      list: async () => [{ id: "env_a", projectId: "proj", hostId: "host_1", path: dir, status: "ready" }],
    },
    hosts: { get: async () => ({ id: "host_1", name: "test", status: "connected" }), list: async () => [{ id: "host_1", name: "test", status: "connected" }] },
    projects: { list: async () => [] },
  };
  const handlers = {};
  const tools = {};
  let cli = null;
  const bb = {
    sdk,
    hosts: { experimental_client: () => ({ call: (method, input) => callHost(method, input), experimental_onSignal: () => () => {} }) },
    onDispose: () => {},
    realtime: { publish: (...args) => harness.scan("realtime", args) },
    rpc: { register: (_contract, impl) => Object.assign(handlers, impl) },
    agents: { registerTool: (tool) => { tools[tool.name] = tool; }, configure: () => {} },
    cli: { register: (definition) => { cli = definition; } },
    log: (...args) => logs.push(args.join(" ")),
  };
  await plugin(bb);
  const ui = async (name, input) => {
    const result = await handlers[name]({ target: { environmentId: "env_a" }, ...input });
    harness.scan(`ui:${name}`, result, input?.path ?? "");
    return result;
  };
  const tool = async (name, input) => {
    const result = await tools[name].execute(input, { threadId: "thr_cur" });
    harness.scan(`agent:${name}`, result, input?.path ?? "");
    return result;
  };
  const runCli = async (name, options = {}) => {
    const argv = [...name.split(" "), "--env", "env_a"];
    for (const [key, value] of Object.entries(options)) argv.push(`--${key}`, ...(value === "" ? [] : [String(value)]));
    try {
      const result = await cli.run(argv, { threadId: "thr_cur" });
      harness.scan(`cli:${name}`, result?.stdout ?? result);
      harness.scan(`cli:${name}:stderr`, result?.stderr ?? "");
      return result;
    } catch (error) {
      harness.scan(`cli:${name}:errors`, error?.message ?? String(error));
      return { error };
    }
  };
  return { c, prefix, dir, data, git, harness, logs, restore, callHost, ui, tool, runCli, sent, cleanup: async () => { restore(); await fs.rm(dir, { recursive: true, force: true }); await fs.rm(data, { recursive: true, force: true }); } };
}

export const FILES = ["config/app.yaml", "config/app.json", "config/settings.jsonc", "config/app.toml", ".env.example", "docs/keys.md", "notes/pem.txt", "data/list.csv"];

/** Run the cycle; returns the steps and the harness report (findings never include canary values when empty). */
export async function runLeakCycle(t, options = {}) {
  const steps = [];
  const P = (file) => `${t.prefix}${file}`;

    const step = async (name, run) => {
    try {
      const value = await run();
      // An RPC answer {ok: false} is a failed step too (named, with the code; never the values).
      if (value && typeof value === "object" && value.ok === false) {
        steps.push({ name, ok: false, error: `${value.error?.code ?? ""} ${String(value.error?.message ?? "").slice(0, 160)}` });
        return value;
      }
      steps.push({ name, ok: true });
      return value;
    } catch (error) {
      steps.push({ name, ok: false, error: `${error?.code ?? ""} ${error?.message ?? error}`.slice(0, 200) });
      t.harness.scan("errors", `${error?.code ?? ""} ${error?.message ?? error}`);
      return null;
    }
  };
  try {
    const target = { environmentId: "env_a" };
    await step("enable «.»", () => t.ui("review.enable", { roots: ["."] }));
    await step("tree", () => t.ui("review.tree", {}));
    const views = {};
    for (const file of FILES) {
      views[file] = await step(`view ${file}`, () => t.ui("review.view", { path: P(file) }));
      await step(`view compact ${file}`, () => t.ui("review.view", { path: P(file), compact: true }));
      await step(`text ${file}`, () => t.ui("review.text", { path: P(file) }));
      await step(`read ${file}`, () => t.ui("review.document.read", { path: P(file) }));
    }
    // .env.local is ignored by Git: view only, nothing written.
    const listing = async (root) => { const out = []; const walk = async (d) => { for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) { const f = path.join(d, e.name); if (e.isDirectory()) await walk(f); else out.push(path.relative(root, f)); } }; await walk(root); return out.sort(); };
    const beforeLocal = { docs: await listing(path.join(t.dir, ".bb-docs")), data: await listing(t.data) };
    const localView = await step("view .env.local (outside Git)", () => t.ui("review.view", { path: P(".env.local") }));
    await step("text .env.local (outside Git)", () => t.ui("review.text", { path: P(".env.local") }));
    await step("read .env.local (outside Git)", () => t.ui("review.document.read", { path: P(".env.local") }));
    const localNode = localView?.result?.blocks?.length ? 0 : null;
    const refusedLocal = localNode === null ? null : await t.ui("review.annotate", { path: P(".env.local"), observation: { sha: localView.result.document.sha }, text: "нельзя", kind: "note", targetKind: "block", block: 0 });
    steps.push({ name: ".env.local: annotation refused (shown only)", ok: refusedLocal?.ok === false && refusedLocal?.error?.code === "outside-git" });
    const afterLocal = { docs: await listing(path.join(t.dir, ".bb-docs")), data: await listing(t.data) };
    steps.push({ name: ".env.local: no new file in .bb-docs or the data directory", ok: JSON.stringify(afterLocal) === JSON.stringify(beforeLocal), error: JSON.stringify({ docs: afterLocal.docs.filter((f) => !beforeLocal.docs.includes(f)), data: afterLocal.data.filter((f) => !beforeLocal.data.includes(f)) }) });
    // Reveal by click: one value, only in the reveal answer.
    const yaml = views["config/app.yaml"]?.result ?? views["config/app.yaml"];
    const passwordSecret = yaml?.secrets?.find((secret) => JSON.stringify(secret.path) === JSON.stringify(["db", "password"]));
    const revealed = await step("reveal db.password", async () => {
      const result = await t.callHost("revealSecret", { root: t.dir, path: P("config/app.yaml"), keyPath: JSON.stringify(["db", "password"]), line: passwordSecret?.line ?? 5, head: yaml?.context?.head ?? null, branch: yaml?.context?.branch ?? null });
      t.harness.scan("rpc:reveal", result);
      return result;
    });
    if (revealed?.ok) assert.equal(revealed.result.value, t.c.YAML_PASSWORD, "reveal returns the value");
    // Annotations: on the secret node (block) and on a text selection with the mask; a quote with the real value is refused.
    if (yaml?.blocks) {
      const node = yaml.blocks.findIndex((block) => block.text.startsWith("password:"));
      await step("annotate secret node", () => t.ui("review.annotate", { path: P("config/app.yaml"), observation: { sha: yaml.document.sha }, text: "Пароль из хранилища, не в файле", kind: "action", targetKind: "block", block: node }));
      const refused = await t.ui("review.annotate", { path: P("config/app.yaml"), observation: { sha: yaml.document.sha }, text: "цитата из значения", kind: "note", targetKind: "text",
        range: { start: yaml.blocks[node].range.start + 10, end: yaml.blocks[node].range.start + 20 }, quote: t.c.YAML_PASSWORD.slice(0, 10) }).catch((error) => ({ ok: false, error }));
      steps.push({ name: "quote from a secret value is refused", ok: refused?.ok === false });
      t.harness.scan("errors", refused);
      const md = views["docs/keys.md"]?.result;
      const paragraph = md?.blocks?.findIndex((block) => block.text.startsWith("Обычный абзац"));
      if (md && paragraph >= 0) await step("annotate markdown", () => t.ui("review.annotate", { path: P("docs/keys.md"), observation: { sha: md.document.sha }, text: "Уточнить", kind: "action", targetKind: "block", block: paragraph }));
      const env = views[".env.example"]?.result;
      if (env?.blocks?.length) await step("annotate .env.example", () => t.ui("review.annotate", { path: P(".env.example"), observation: { sha: env.document.sha }, text: "Ротация", kind: "action", targetKind: "block", block: 1 }));
    }
    // A batch to the current thread; the agent reads it, changes the secret value and finishes.
    const sentBatch = await step("batch send", () => t.ui("review.batch.send", { scope: { kind: "all" }, recipient: { mode: "current-thread", threadId: "thr_cur" } }));
    const runId = sentBatch?.runId ?? sentBatch?.result?.runId;
    const batch = await step("agent batch get", () => t.tool("review_batch_get", { runId }));
    for (const file of FILES) await step(`agent document get ${file}`, () => t.tool("review_document_get", { path: P(file) }));
    const items = (() => { try { return JSON.parse(batch?.content?.[0]?.text ?? batch?.text ?? "{}").items ?? []; } catch { return batch?.result?.items ?? []; } })();
    const yamlPath = path.join(t.dir, P("config/app.yaml"));
    await fs.writeFile(yamlPath, (await fs.readFile(yamlPath, "utf8")).replace(t.c.YAML_PASSWORD, t.c.AGENT_NEW));
    for (const item of items) await step(`agent item reply ${item.itemId}`, () => t.tool("review_item_reply", { runId, itemId: item.itemId, responseId: `r-${item.itemId}`, status: "done", text: "Сделано", edits: [] }));
    await step("agent batch finish", () => t.tool("review_batch_finish", { runId }));
    const after = await step("view after round", () => t.ui("review.view", { path: P("config/app.yaml") }));
    const card = after?.result?.annotations?.find((annotation) => annotation.latest);
    if (card) await step("accept", () => t.ui("review.accept", { annotationId: card.annotationId, expectedHeads: card.heads, resultEventId: card.latest.eventId, path: P("config/app.yaml"), observation: { sha: after.result.document.sha }, blocks: card.latest.linked.map((entry) => entry.block) }));
    // Local review (EP-048): .env.local outside Git tracked locally — view, an annotation on a key, a local batch to the
    // same thread, the agent's answer; the local store, the user's settings file and the batch text are scanned too.
    await step("local track .env.local", () => t.ui("review.local.track", { path: P(".env.local"), isDir: false, action: "add" }));
    const localEnv = await step("local view .env.local", () => t.ui("review.view", { path: P(".env.local") }));
    await step("local text .env.local", () => t.ui("review.text", { path: P(".env.local"), source: true }));
    if (localEnv?.result?.blocks?.length) {
      await step("local annotate .env.local key", () => t.ui("review.annotate", { path: P(".env.local"), observation: { sha: localEnv.result.document.sha }, text: "Ключ локальный — сменить", kind: "action", targetKind: "block", block: Math.min(1, localEnv.result.blocks.length - 1) }));
      await step("local acknowledge .env.local", () => t.ui("review.acknowledge", { path: P(".env.local"), observation: { sha: localEnv.result.document.sha }, scope: "document" }));
    }
    const localSent = await step("local batch send", () => t.ui("review.batch.send", { scope: { kind: "document", path: P(".env.local") }, recipient: { mode: "current-thread", threadId: "thr_cur" } }));
    const localRun = localSent?.runId ?? localSent?.result?.runId;
    const localBatch = await step("agent local batch get", () => t.tool("review_batch_get", { runId: localRun }));
    await step("agent local document get", () => t.tool("review_document_get", { path: P(".env.local") }));
    const localItems = (() => { try { return JSON.parse(localBatch?.content?.[0]?.text ?? localBatch?.text ?? "{}").items ?? []; } catch { return localBatch?.result?.items ?? []; } })();
    for (const item of localItems) await step(`agent local item reply ${item.itemId}`, () => t.tool("review_item_reply", { runId: localRun, itemId: item.itemId, responseId: `l-${item.itemId}`, status: "done", text: "Сменил", edits: [] }));
    await step("agent local batch finish", () => t.tool("review_batch_finish", { runId: localRun }));
    await step("local round", () => (localRun ? t.ui("review.round", { runId: localRun }) : null));
    await step("local list", () => t.ui("review.local.list", {}));
    await step("cli local list", () => t.runCli("local list"));
    await step("settings: retention and a global secret key", () => t.ui("review.settings.save", { user: { retentionDays: 7, secretKeys: ["mode"] } }));
    await step("settings get", () => t.ui("review.settings.get", {}));
    await step("round", () => (runId ? t.ui("review.round", { runId }) : null));
    await step("batch status", () => t.ui("review.batch.status", {}));
    await step("validate", () => t.ui("review.validate", { limit: 500 }));
    await step("status", () => t.ui("review.status", {}));
    await step("orphans", () => t.callHost("orphans", { root: t.dir }));
    await step("perf", () => t.callHost("perf", { root: t.dir }));
    for (const command of ["status", "validate", "orphans", "batch status"]) await step(`cli ${command}`, () => t.runCli(command));
    for (const file of FILES) {
      await step(`cli view ${file}`, () => t.runCli("view", { doc: P(file) }));
      await step(`cli view --json ${file}`, () => t.runCli("view", { doc: P(file), json: "" }));
      await step(`cli document get ${file}`, () => t.runCli("document get", { doc: P(file) }));
    }
    await step("cli batch get", () => t.runCli("batch get", runId ? { run: runId } : {}));
    await step("cli summary", () => t.runCli("summary", { reader: "owner@bb-docs.invalid" }));
    if (options.check !== false) await step("check", () => t.callHost("check", { root: t.dir }));

    // Stored outputs.
    await t.harness.scanDir(".bb-docs", path.join(t.dir, ".bb-docs"));
    await t.harness.scanDir("data-dir", t.data, { exclude: (rel) => rel.startsWith("secrets/") });
    t.harness.scan("logs", t.logs.join("\n"));
    t.harness.scan("thread:sent", t.sent);
    // The device key and the HMACs of «value changed» stay in the device store: none in any output or stored file.
    const deviceKey = await fs.readFile(path.join(t.data, "secrets/device.key")).then((bytes) => bytes.toString("hex"), () => null);
    const macs = {};
    const walkMacs = async (dir) => { for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) { const full = path.join(dir, entry.name); if (entry.isDirectory()) await walkMacs(full); else Object.assign(macs, Object.fromEntries(Object.entries(JSON.parse(await fs.readFile(full, "utf8"))).map(([place, mac], index) => [`${entry.name}:${index}:${place}`, mac]))); } };
    await walkMacs(path.join(t.data, "secrets/seen"));
    const deviceFindings = t.harness.rescan({ ...(deviceKey ? { deviceKey } : {}), ...macs }).filter((finding) => !finding.output.startsWith("data-dir") || true);
    steps.push({ name: `device key and ${Object.keys(macs).length} HMACs are in no output`, ok: Boolean(deviceKey) && Object.keys(macs).length > 0 && !deviceFindings.length, error: JSON.stringify(deviceFindings.slice(0, 3)) });
    const report = t.harness.report();
    return { steps, ...report };
  } finally {
    if (!options.keep) await t.cleanup();
  }
}
