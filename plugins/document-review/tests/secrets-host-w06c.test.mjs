// EP-039-T03/T05/T07 on the host: «Reveal value» (one value, context checked, never cached), «value changed»
// with the device HMAC store, a cold host gives the same redacted data, and «Not a secret» exemptions — for me (display
// only) and for everyone in the repository (the value becomes shared: positive control), with the host's refusals.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clearContentCache } from "../node/content.ts";
import { revealSecret, setSecretExemption } from "../node/secrets-host.ts";
import { ReviewService } from "../node/service.ts";
import { clearViewCaches, documentText, documentView, markSecretsSeen } from "../node/view.ts";
import { canary, LeakHarness } from "./leak-harness.mjs";

async function repo(files) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-sec-")));
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Owner");
  git("config", "user.email", "owner@bb-docs.invalid");
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), text);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-sec-data-"));
  const service = new ReviewService(dir, data);
  await service.enable({ roots: ["."] });
  return { dir, data, git, service, cleanup: () => Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]) };
}

async function outputsOf(service, files) {
  const out = [];
  for (const file of files) {
    out.push(JSON.stringify(await service.readDocument(file)));
    out.push(JSON.stringify(await documentText(service, file)));
    out.push(JSON.stringify(await documentView(service, file)));
  }
  return out;
}

test("EP-039-T05 reveal: one value, only in the right context; nothing keeps it; «значение изменено» on this device without values; the device store is disposable", async () => {
  const c = { A: canary(), B: canary(), C: canary() };
  const r = await repo({ "config/app.yaml": `db:\n  password: ${c.A}\n  host: h\napi_key: ${c.B}\n`, ".env.example": `TOKEN=${c.C}\n` });
  try {
    const view = await documentView(r.service, "config/app.yaml");
    const password = view.secrets.find((secret) => JSON.stringify(secret.path) === '["db","password"]');
    assert.ok(password && password.length === [...c.A].length && password.changed === false);
    assert.equal(view.secrets.length, 2);
    const info = await r.service.checkout();
    const shown = await revealSecret(r.service, { path: "config/app.yaml", keyPath: '["db","password"]', head: info.head, branch: info.branch });
    assert.equal(shown.value, c.A, "one value");
    assert.ok(!JSON.stringify(shown).includes(c.B), "only the asked value");
    await assert.rejects(revealSecret(r.service, { path: "config/app.yaml", keyPath: '["db","password"]', head: "0".repeat(40), branch: info.branch }), (error) => error.code === "context-changed");
    await assert.rejects(revealSecret(r.service, { path: "config/app.yaml", keyPath: '["db","password"]' }), (error) => error.code === "context-changed", "the shown context is required");
    await assert.rejects(revealSecret(r.service, { path: "config/app.yaml", keyPath: '["db","host"]', head: info.head, branch: info.branch }), (error) => error.code === "not-found", "not a secret: nothing to reveal");
    await assert.rejects(revealSecret(r.service, { path: "config/gone.yaml", keyPath: '["x"]', head: info.head, branch: info.branch }), (error) => error.code === "not-found", "«файла здесь нет»");
    // After the reveal no output and no stored file holds the value.
    const harness = new LeakHarness(c);
    for (const output of await outputsOf(r.service, ["config/app.yaml", ".env.example"])) harness.scan("outputs", output);
    await harness.scanDir(".bb-docs", path.join(r.dir, ".bb-docs"));
    await harness.scanDir("data-dir", r.data, { exclude: (rel) => rel.startsWith("secrets/") });
    assert.deepEqual(harness.report().findings, []);
    // The value changes in Git: the redacted bytes are the same, the device sees «value changed» without values.
    await fs.writeFile(path.join(r.dir, "config/app.yaml"), `db:\n  password: ${c.A}-rotated\n  host: h\napi_key: ${c.B}\n`);
    r.service.invalidate();
    const changed = await documentView(r.service, "config/app.yaml");
    assert.equal(changed.document.sha, view.document.sha, "same redacted bytes");
    assert.equal(changed.secrets.find((secret) => secret.place === password.place).changed, true);
    assert.equal(changed.secrets.find((secret) => JSON.stringify(secret.path) === '["api_key"]').changed, false);
    assert.ok(!JSON.stringify(changed).includes("rotated"));
    await markSecretsSeen(r.service, "config/app.yaml", [password.place]);
    assert.equal((await documentView(r.service, "config/app.yaml")).secrets.find((secret) => secret.place === password.place).changed, false, "looking clears it");
    // Device key and HMACs never appear in outputs or the repository.
    const key = (await fs.readFile(path.join(r.data, "secrets/device.key"))).toString("hex");
    const macs = [];
    const walk = async (dir) => { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) await walk(full); else if (entry.name.endsWith(".json")) macs.push(...Object.values(JSON.parse(await fs.readFile(full, "utf8")))); } };
    await walk(path.join(r.data, "secrets/seen"));
    assert.ok(macs.length >= 2);
    const deviceHarness = new LeakHarness(Object.fromEntries([["KEY", key], ...macs.map((mac, index) => [`MAC${index}`, mac])]));
    for (const output of await outputsOf(r.service, ["config/app.yaml", ".env.example"])) deviceHarness.scan("outputs", output);
    await deviceHarness.scanDir(".bb-docs", path.join(r.dir, ".bb-docs"));
    await deviceHarness.scanDir("repo", r.dir, { exclude: (rel) => rel.startsWith(".git/") });
    await deviceHarness.scanDir("data-dir", r.data, { exclude: (rel) => rel.startsWith("secrets/") });
    assert.deepEqual(deviceHarness.report().findings, []);
    // The device store is disposable: removing it loses only the hint.
    await fs.rm(path.join(r.data, "secrets"), { recursive: true, force: true });
    assert.equal((await r.service.validate()).ok, true);
    assert.equal((await documentView(r.service, "config/app.yaml")).secrets.every((secret) => !secret.changed), true);
  } finally {
    await r.cleanup();
  }
});

test("EP-039-T03 a cold host (new service, empty caches) gives the same redacted data; a quote taken from a secret value is refused", async () => {
  const c = { A: canary(), B: canary() };
  const r = await repo({ "config/app.yaml": `db:\n  password: ${c.A}\n  host: h\n`, "docs/a.md": `# A\n\npostgres://u:${c.B.replace("/", "-")}@h/db\n` });
  try {
    const warm = await documentView(r.service, "config/app.yaml");
    const node = warm.blocks.findIndex((block) => block.text.startsWith("password:"));
    await r.service.annotate({ path: "config/app.yaml", observation: { sha: warm.document.sha }, text: "ротация", kind: "action", targetKind: "block", block: node });
    await assert.rejects(r.service.annotate({ path: "config/app.yaml", observation: { sha: warm.document.sha }, text: "x", kind: "note", targetKind: "text",
      range: { start: warm.blocks[node].range.start + 10, end: warm.blocks[node].range.start + 16 }, quote: c.A.slice(0, 6) }), (error) => error.code === "quote-mismatch");
    clearViewCaches();
    clearContentCache();
    await fs.rm(path.join(r.data, "observations"), { recursive: true, force: true });
    await fs.rm(path.join(r.data, "chunks"), { recursive: true, force: true });
    const cold = new ReviewService(r.dir, r.data);
    const again = await documentView(cold, "config/app.yaml");
    assert.equal(again.document.sha, warm.document.sha, "same redacted bytes on a cold host");
    assert.equal(again.annotations.length, 1);
    assert.equal((await cold.validate()).ok, true);
    const harness = new LeakHarness(c);
    for (const output of await outputsOf(cold, ["config/app.yaml", "docs/a.md"])) harness.scan("outputs", output);
    await harness.scanDir(".bb-docs", path.join(r.dir, ".bb-docs"));
    await harness.scanDir("data-dir", r.data, { exclude: (rel) => rel.startsWith("secrets/") });
    assert.deepEqual(harness.report().findings, []);
  } finally {
    await r.cleanup();
  }
});

test("EP-039-T07 exemptions: for me — display only; for the repository — the value becomes shared (positive control); shifts, renames, explicit secrets and an ignored .env", async () => {
  const c = { COUNT: canary(), SIB: canary(), ME: canary(), A: canary(), B: canary(), Z: canary(), PEM: canary(), LOCAL: canary() };
  const yaml = `limits:\n  token_count: ${c.COUNT}\n  token_salt: ${c.SIB}\nregion:\n  session_key: ${c.ME}\nlist:\n  - name: a\n    token: ${c.A}\n  - name: b\n    token: ${c.B}\nkey: "postgres://u:${c.PEM.replace("/", "-")}@h/db"\n`;
  const r = await repo({ "config/app.yaml": yaml, ".gitignore": ".env.local\n" });
  try {
    await fs.writeFile(path.join(r.dir, ".env.local"), `LOCAL=${c.LOCAL}\n`);
    r.service.invalidate();
    const info = await r.service.checkout();
    // Explicit secret: refused at both levels.
    await assert.rejects(setSecretExemption(r.service, { path: "config/app.yaml", keyPath: '["key"]', level: "repo", action: "add" }), (error) => error.code === "explicit-secret" || error.code === "bad-input");
    await assert.rejects(setSecretExemption(r.service, { path: "config/app.yaml", keyPath: '["key"]', level: "me", action: "add" }), (error) => error.code === "explicit-secret" || error.code === "bad-input");
    // An ignored .env: only «for me».
    await assert.rejects(setSecretExemption(r.service, { path: ".env.local", keyPath: '["LOCAL"]', level: "repo", action: "add" }), (error) => error.code === "outside-git");
    // For me: the view marks it, the bytes stay masked (same sha), reveal gives it.
    const before = await documentView(r.service, "config/app.yaml");
    await setSecretExemption(r.service, { path: "config/app.yaml", keyPath: '["region","session_key"]', level: "me", action: "add" });
    const mine = await documentView(r.service, "config/app.yaml");
    assert.equal(mine.document.sha, before.document.sha, "a personal exemption does not change the shared redaction");
    assert.equal(mine.secrets.find((secret) => JSON.stringify(secret.path) === '["region","session_key"]').exempt, "me");
    assert.ok(!JSON.stringify(mine).includes(c.ME));
    // For the repository: preview first, then the value becomes part of the shared data.
    const preview = await setSecretExemption(r.service, { path: "config/app.yaml", keyPath: '["limits","token_count"]', level: "repo", action: "add", preview: true, head: info.head });
    assert.equal(preview.status, "preview");
    assert.equal(preview.irreversible, true);
    await setSecretExemption(r.service, { path: "config/app.yaml", keyPath: '["limits","token_count"]', level: "repo", action: "add", head: info.head });
    await setSecretExemption(r.service, { path: "config/app.yaml", keyPath: '["list",1,"token"]', level: "repo", action: "add", head: info.head });
    const config = JSON.parse(await fs.readFile(path.join(r.dir, ".bb-docs/config.json"), "utf8"));
    assert.equal(config.schemaVersion, "1.2");
    assert.equal(config.secretExemptions.length, 2);
    assert.ok(!JSON.stringify(config).includes(c.B), "the element fingerprint has no derivative of the secret value");
    const shared = await documentView(r.service, "config/app.yaml");
    await r.service.annotate({ path: "config/app.yaml", observation: { sha: shared.document.sha }, text: "общий", kind: "note", targetKind: "document" });
    // An element inserted before b: the exemption follows b. A neighbour key renamed: its own exemption no longer applies.
    await fs.writeFile(path.join(r.dir, "config/app.yaml"), yaml.replace("list:\n", `list:\n  - name: z\n    token: ${c.Z}\n`));
    r.service.invalidate();
    const shifted = await documentView(r.service, "config/app.yaml");
    await r.service.annotate({ path: "config/app.yaml", observation: { sha: shifted.document.sha }, text: "после вставки", kind: "note", targetKind: "document" });
    const harness = new LeakHarness(c);
    harness.allow(".bb-docs", "COUNT");
    harness.allow(".bb-docs", "B");
    harness.allow("outputs", "COUNT");
    harness.allow("outputs", "B");
    // The journal cache of the data directory is a parsed copy of .bb-docs: the shared values are there too.
    harness.allow("data-dir", "COUNT");
    harness.allow("data-dir", "B");
    for (const output of await outputsOf(r.service, ["config/app.yaml", ".env.local"])) harness.scan("outputs", output);
    await harness.scanDir(".bb-docs", path.join(r.dir, ".bb-docs"));
    await harness.scanDir("data-dir", r.data, { exclude: (rel) => rel.startsWith("secrets/") || rel.startsWith("user-settings/") });
    assert.deepEqual(harness.report().findings, [], "siblings, the personal one, the shifted element, the explicit secret and the ignored .env stay masked");
    const snapshots = await fs.readdir(path.join(r.dir, ".bb-docs/snapshots"), { recursive: true });
    const texts = await Promise.all(snapshots.filter((f) => f.endsWith(".md")).map((f) => fs.readFile(path.join(r.dir, ".bb-docs/snapshots", f), "utf8")));
    assert.ok(texts.some((text) => text.includes(c.COUNT)), "positive control: the repository exemption put the value into .bb-docs");
    // Removing the repository exemption: the mask returns in new snapshots; nothing turns unread.
    const unreadBefore = (await documentView(r.service, "config/app.yaml")).unread;
    const removal = await setSecretExemption(r.service, { path: "config/app.yaml", keyPath: '["limits","token_count"]', level: "repo", action: "remove", preview: true });
    assert.ok(removal.revisionsWithValue >= 1, "the preview names revisions that keep the value in history");
    await setSecretExemption(r.service, { path: "config/app.yaml", keyPath: '["limits","token_count"]', level: "repo", action: "remove" });
    const masked = await documentView(r.service, "config/app.yaml");
    assert.ok(!masked.blocks.some((block) => block.text.includes(c.COUNT)), "masked again");
    assert.equal(masked.unread, unreadBefore, "a mask-only change is not an edit");
    // Personal exemption removed: still the same shared bytes.
    await setSecretExemption(r.service, { path: "config/app.yaml", keyPath: '["region","session_key"]', level: "me", action: "remove" });
    assert.equal((await documentView(r.service, "config/app.yaml")).secrets.find((secret) => JSON.stringify(secret.path) === '["region","session_key"]').exempt, null);
    assert.equal((await r.service.validate()).ok, true);
  } finally {
    await r.cleanup();
  }
});

test("EP-039-T04 a personal extension of the secret pattern (F14) masks the show too: view, text, read and CLI view of the host without the value, lengths and offsets kept", async () => {
  const c = { MINE: canary(), SHARED: canary() };
  const r = await repo({ "config/app.yaml": `vault_phrase: ${c.MINE}\npassword: ${c.SHARED}\nhost: h\n` });
  try {
    const { updateUserSettings } = await import("../node/user-settings.ts");
    await updateUserSettings(r.data, "owner@bb-docs.invalid", (settings) => { settings.secretKeys.push("vault_phrase"); });
    clearContentCache();
    const hostEntry = (await import("../host.ts")).default;
    const context = { experimental_paths: { dataDir: r.data, tempDir: os.tmpdir() }, experimental_watch: async () => ({ dispose: async () => {} }), experimental_emitSignal: async () => {} };
    const harness = new LeakHarness(c);
    for (const method of ["view", "text", "read", "viewPersonal"]) {
      const input = { root: r.dir, path: "config/app.yaml", ...(method === "text" ? { source: true } : {}) };
      const reply = await hostEntry.handlers[method](input, context);
      assert.equal(reply.ok, true, `${method}: ${JSON.stringify(reply.error ?? "")}`);
      harness.scan(`host:${method}`, reply);
    }
    assert.deepEqual(harness.findings, []);
    const text = (await hostEntry.handlers.text({ root: r.dir, path: "config/app.yaml", source: true }, context)).result;
    const personal = text.secrets.find((secret) => secret.scope === "personal");
    assert.ok(personal, "the personal extra is listed for the mask");
    assert.equal(text.source.slice(personal.start, personal.end), "•".repeat([...c.MINE].length), "same length: offsets stay valid");
    assert.equal(text.blocks.length > 0, true);
    // The shared data stays as it was: the extension does not protect .bb-docs (Q11), the value is in the shared form.
    const shared = await r.service.readDocument("config/app.yaml");
    assert.ok(shared.text.includes(c.MINE) || JSON.stringify(shared).includes(c.MINE));
  } finally {
    await r.cleanup();
  }
});
