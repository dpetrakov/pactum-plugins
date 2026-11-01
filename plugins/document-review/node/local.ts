// Local review of files outside Git (W-06c, file-types.md §9, DR-14; EP-048): the same journal, projection and rules
// as `.bb-docs`, in a store of the plugin's data directory — `local-review/<repoId>/<checkout>/<reader>/` (checkout and
// reader as hashes) — so nothing reaches the repository. Tracking is switched on explicitly for a file or a folder
// (a folder rule tracks new files outside Git inside it); the local config's `roots` are those paths, `untracked` the
// files switched off inside a tracked folder. Requests about a tracked file outside Git are served by the local review.
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalBytes } from "../core/canonical-json.ts";
import { newId, sha256 } from "../core/hash.ts";
import { buildRevision } from "../core/markdown/index.ts";
import { type Config, isRepoPath, type ObjectValue, type Operation, parseConfig, SCHEMA_VERSION } from "../core/schema.ts";
import { writeConfig } from "../core/store.ts";
import { entity } from "../core/journal.ts";
import ignore from "ignore";
import { confine } from "./checkout.ts";
import { readContent, readerOf } from "./content.ts";
import { ReviewError, ReviewService, type Expectation } from "./service.ts";

const locals = new Map<string, ReviewService>();

/** Hash used in the store path: the canonical checkout path (as DR-01) and the reader id. */
const hash = (value: string) => sha256(value).slice(0, 16);

export function localStoreDir(dataDir: string, repoId: string, root: string, readerId: string): string {
  return path.join(dataDir, "local-review", repoId, hash(root), hash(readerId.trim().toLowerCase()));
}

/**
 * The repository id of the local store: the shared one when review is on (exemptions and settings are keyed by it),
 * otherwise a stable id of this checkout kept beside the local stores.
 */
async function repoIdOf(shared: ReviewService): Promise<string>;
async function repoIdOf(shared: ReviewService, options: { create: false }): Promise<string | null>;
async function repoIdOf(shared: ReviewService, options: { create?: boolean } = {}): Promise<string | null> {
  const config = (await shared.config()).value;
  if (config) return config.repoId;
  const file = path.join(shared.dataDir, "local-review", "_ids", `${hash(shared.root)}.json`);
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as { repoId?: string };
    if (typeof value.repoId === "string" && /^[0-9a-f-]{36}$/.test(value.repoId)) return value.repoId;
  } catch {
    // first local tracking in a checkout without shared review
  }
  // Reading (the tree, a view) never writes: the id is created by the first “Track locally”.
  if (options.create === false) return null;
  const repoId = newId();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ repoId, root: shared.root }) + "\n", { mode: 0o600 });
  return repoId;
}

/** The local review of this checkout's reader (null without a Git identity: local data is per reader). */
export async function localFor(shared: ReviewService, options: { create?: boolean } = {}): Promise<ReviewService | null> {
  if (shared.scope === "local") return shared;
  const readerId = await readerOf(shared);
  if (!readerId) return null;
  const repoId = await repoIdOf(shared, { create: false }) ?? (options.create ? await repoIdOf(shared) : null);
  if (!repoId) return null;
  const storeDir = localStoreDir(shared.dataDir, repoId, shared.root, readerId);
  const key = `${shared.dataDir}|${storeDir}`;
  let local = locals.get(key);
  if (!local) {
    // Other OS users must not traverse the local stores (security review, finding 11).
    const base = path.join(shared.dataDir, "local-review");
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
    await fs.chmod(base, 0o700).catch(() => undefined);
    await adoptUnderOtherRepoId(shared, repoId, storeDir, readerId);
    local = new ReviewService(shared.root, shared.dataDir, { storeDir, key: hash(readerId) });
    locals.set(key, local);
    if (locals.size > 64) locals.delete(locals.keys().next().value!);
  }
  return local;
}

/**
 * The repository id changed (review enabled after local tracking, a branch with another config): this checkout's
 * store of this reader under the old id moves to the new one (security review, finding 10), its config follows.
 */
async function adoptUnderOtherRepoId(shared: ReviewService, repoId: string, storeDir: string, readerId: string): Promise<void> {
  if (await fs.lstat(storeDir).then(() => true, () => false)) return;
  const base = path.join(shared.dataDir, "local-review");
  for (const other of await fs.readdir(base).catch(() => [] as string[])) {
    if (other === repoId || other === "_ids") continue;
    const candidate = path.join(base, other, hash(shared.root), hash(readerId.trim().toLowerCase()));
    if (!(await fs.lstat(path.join(candidate, "config.json")).then(() => true, () => false))) continue;
    await fs.mkdir(path.dirname(storeDir), { recursive: true, mode: 0o700 });
    await fs.rename(candidate, storeDir);
    const file = path.join(storeDir, "config.json");
    try {
      const config = JSON.parse(await fs.readFile(file, "utf8")) as Config;
      const next = { ...config, repoId };
      const temp = `${file}.${newId()}`;
      await fs.writeFile(temp, canonicalBytes(next), { mode: 0o600 });
      await fs.rename(temp, file);
    } catch {
      // A damaged config stays as it was: the store opens read-only and says so.
    }
    return;
  }
}

/** Local tracking rules (null — nothing tracked locally yet). */
export async function localConfig(local: ReviewService): Promise<Config | null> {
  return (await local.config()).value;
}

/**
 * A file tracked locally by this reader: outside Git under a file or folder rule (not switched off), or a «new» file
 * (not ignored here, not in the index) that already has local data — it stays local until it is in the index (§4).
 */
export async function isTrackedLocally(shared: ReviewService, docPath: string): Promise<boolean> {
  // Git's listing failed: classes are unknown, nothing is routed to the local store (security review, finding 4).
  if ((await shared.fileClasses()).failed) return false;
  const fileClass = await shared.fileClass(docPath);
  if (fileClass === "git") return false;
  const local = await localFor(shared);
  const config = local ? await localConfig(local) : null;
  if (!config || !local!.insideRoots(config, docPath) || ignore().add(config.untracked).ignores(docPath)) return false;
  if (fileClass === "outside") return true;
  const state = await local!.state().catch(() => null);
  return Boolean(state && local!.docIdOf(state, docPath));
}

/** The review that serves a document: the local one for a tracked file outside Git, the shared one otherwise. */
export async function serviceForPath(shared: ReviewService, docPath: string | null | undefined): Promise<ReviewService> {
  if (!docPath || shared.scope === "local") return shared;
  if ((await shared.fileClasses()).failed) return shared;
  if (await isTrackedLocally(shared, docPath)) return (await localFor(shared))!;
  // A tracked file that disappeared keeps its local data: its virtual entry is served by the local review too.
  const local = await localFor(shared).catch(() => null);
  const config = local ? await localConfig(local) : null;
  if (local && config) {
    const state = await local.state().catch(() => null);
    if (state && local.docIdOf(state, docPath)) {
      // Only a gone file: a present file switched off is shown only (its data sleep until it is tracked again).
      const exists = await fs.lstat(path.join(shared.root, docPath)).then(() => true, () => false);
      if (!exists) return local;
    }
  }
  return shared;
}

/** The review that holds an annotation: the shared journal first, then this reader's local one. */
export async function serviceForAnnotation(shared: ReviewService, annotationId: string): Promise<ReviewService> {
  const state = await shared.state().catch(() => null);
  if (state?.byEntity.has(entity.annotation(annotationId))) return shared;
  const local = await localFor(shared).catch(() => null);
  if (local && (await localConfig(local))) {
    const localState = await local.state().catch(() => null);
    if (localState?.byEntity.has(entity.annotation(annotationId))) return local;
  }
  return shared;
}

/** Track or stop tracking a file or folder outside Git. Enabling records the initial base before the CAS rule update. Disabling keeps existing data, removes the explicit root, or adds an untracked exception inside a tracked folder. */
export async function trackLocally(shared: ReviewService, input: { path: string; isDir: boolean; action: "add" | "remove" } & Expectation) {
  const local = await localFor(shared, { create: true });
  if (!local) throw new ReviewError("no-identity", "Git user.email is not set in this checkout: local review is kept per reader");
  return local.serial(async () => {
    const info = await shared.checkout();
    if (!info.isRepo) throw new ReviewError("read-only", "folder without Git: nothing is outside Git here");
    shared.invalidate();
    if ((await shared.fileClasses()).failed) throw new ReviewError("git-unavailable", "Git could not list the files of this checkout: what is outside Git is unknown now; try again");
    if (input.head !== undefined && input.head !== info.head) throw new ReviewError("context-changed", "the checkout moved since it was shown; nothing was saved");
    if (input.branch !== undefined && input.branch !== info.branch) throw new ReviewError("context-changed", "the branch changed since it was shown; nothing was saved");
    const target = input.path.replace(/\/+$/, "");
    if (!target || target === "." || target.split("/").some((segment) => segment === ".." || segment === ".git" || segment === ".bb-docs")) throw new ReviewError("bad-path", `not a path for local tracking: ${input.path}`);
    const stat = await fs.lstat(await confine(shared.root, target)).catch(() => null);
    if (!stat) throw new ReviewError("not-found", `no such path: ${target}`);
    if (stat.isDirectory() !== input.isDir) throw new ReviewError("bad-input", `${target} is ${stat.isDirectory() ? "a directory" : "a file"}`);
    if (!input.isDir && (await shared.fileClass(target)) !== "outside") throw new ReviewError("not-outside", `the file is not outside Git: it is reviewed in the shared review: ${target}`);
    const read = await local.config();
    if (read.readOnly) throw new ReviewError("read-only", read.problem ?? "the local config cannot be used for writing");
    const repoId = await repoIdOf(shared);
    const current: Config = read.value ?? { schemaVersion: SCHEMA_VERSION, repoId, roots: [target], hidden: [], untracked: [] };
    let next: Config;
    if (input.action === "add") {
      const roots = read.value ? [...new Set([...current.roots, target])] : [target];
      next = { ...current, roots, untracked: current.untracked.filter((pattern) => pattern !== `/${target}` && pattern !== `/${target}/`) };
    } else {
      const inRoots = current.roots.includes(target);
      next = inRoots
        ? { ...current, roots: current.roots.filter((root) => root !== target) }
        : { ...current, untracked: [...new Set([...current.untracked, input.isDir ? `/${target}/` : `/${target}`])] };
      // The schema needs at least one root: an empty set of rules keeps a root that matches nothing.
      if (!next.roots.length) next.roots = [".bb-local-none"];
    }
    const parsed = parseConfig(next);
    if (!parsed.ok) throw new ReviewError("bad-input", parsed.issues.join("; "));
    let registered = 0;
    if (input.action === "add") {
      // Bases first, rules last: an interrupted switch-on is finished by repeating it, nothing is registered twice.
      const state = await local.state();
      const known = new Set([...state.documents.values()].filter((doc) => !doc.removed).map((doc) => doc.path));
      const files = (await local.trackedDocuments(next)).filter((doc) => !known.has(doc.path) && (doc.path === target || doc.path.startsWith(`${target}/`)));
      const actor = { kind: "human" as const, name: info.identity.name ?? info.identity.email!, email: info.identity.email!.trim() };
      // One operation per file: a local file's data can be forgotten alone (its events touch only its document).
      for (let index = 0; index < files.length; index += 1) {
        const now = await local.state();
        const changes: Operation["changes"] = [];
        const objects: ObjectValue[] = [];
        const snapshots: Uint8Array[] = [];
        for (const doc of files.slice(index, index + 1)) {
          const content = await readContent(local, doc.path, { config: next });
          const docId = newId();
          const { revision } = buildRevision({ revisionId: newId(), docId, path: doc.path, source: content.text, snapshot: content.sha, parents: [], ...(content.rules ? { redacted: { rules: content.rules } } : {}) });
          changes.push({ type: "document.registered", docId, path: doc.path });
          changes.push({ type: "document.observed", docId, revisionId: revision.revisionId, revision: sha256(canonicalBytes(revision)), reason: "baseline" });
          objects.push(revision as ObjectValue);
          snapshots.push(content.bytes);
          registered++;
        }
        if (changes.length) await local.commit(now, actor, changes, objects, snapshots);
      }
    }
    if ((await writeConfig(local.store, canonicalBytes(next), read.sha)) !== "replaced") throw new ReviewError("stale", "the local tracking rules changed concurrently; try again");
    local.invalidate();
    shared.invalidate();
    await touchMeta(shared).catch(() => undefined);
    return { status: "saved" as const, action: input.action, path: target, registered, rules: { roots: next.roots.filter((root) => root !== ".bb-local-none"), untracked: next.untracked } };
  });
}

/** The local rules cover this file (a new config or one more root); no base is recorded — for a transfer to the local store. */
export async function ensureLocalRule(shared: ReviewService, docPath: string): Promise<void> {
  if (!isRepoPath(docPath)) throw new ReviewError("bad-path", `not a repository path: ${docPath}`);
  await confine(shared.root, docPath);
  const local = await localFor(shared, { create: true });
  if (!local) throw new ReviewError("no-identity", "Git user.email is not set in this checkout");
  const read = await local.config();
  if (read.value && local.insideRoots(read.value, docPath) && !ignore().add(read.value.untracked).ignores(docPath)) return;
  const next: Config = read.value
    ? { ...read.value, roots: [...new Set([...read.value.roots.filter((root) => root !== ".bb-local-none"), docPath])], untracked: read.value.untracked.filter((pattern) => pattern !== `/${docPath}`) }
    : { schemaVersion: SCHEMA_VERSION, repoId: await repoIdOf(shared), roots: [docPath], hidden: [], untracked: [] };
  const parsed = parseConfig(next);
  if (!parsed.ok) throw new ReviewError("bad-input", parsed.issues.join("; "));
  if ((await writeConfig(local.store, canonicalBytes(next), read.sha)) !== "replaced") throw new ReviewError("stale", "the local tracking rules changed concurrently; try again");
  local.invalidate();
  await touchMeta(shared).catch(() => undefined);
}

/** CLI `local list`: this reader's local review of this checkout — rules, documents and where the store is. */
export async function localList(shared: ReviewService) {
  const local = await localFor(shared);
  if (!local) {
    if (!(await readerOf(shared))) throw new ReviewError("no-identity", "Git user.email is not set in this checkout");
    return { store: null, rules: null, documents: [] };
  }
  const config = await localConfig(local);
  const state = config ? await local.state() : null;
  const documents = [];
  for (const doc of state?.documents.values() ?? []) {
    if (!doc.path) continue;
    const exists = await fs.lstat(path.join(shared.root, doc.path)).then(() => true, () => false);
    documents.push({ path: doc.path, docId: doc.docId, removed: doc.removed, missing: !exists, revisions: doc.revisions.length });
  }
  return { store: (local.store as unknown as { root?: string }).root ?? null, rules: config ? { roots: config.roots.filter((root) => root !== ".bb-local-none"), untracked: config.untracked } : null, documents: documents.sort((a, b) => a.path.localeCompare(b.path)) };
}

/** Forget file removes this reader's local document and annotation events, then unreferenced objects and snapshots. Receipts remain reader-owned. Remove the file's explicit tracking rule too. */
export async function localForget(shared: ReviewService, input: { path: string } & Expectation) {
  const local = await localFor(shared);
  if (!local) throw new ReviewError("no-identity", "Git user.email is not set in this checkout");
  const config = await localConfig(local);
  if (!config) throw new ReviewError("not-found", "nothing is tracked locally in this checkout");
  const result = await local.serial(async () => {
    const state = await local.state();
    const docIds = new Set([...state.documents.values()].filter((doc) => doc.path === input.path).map((doc) => doc.docId));
    if (!docIds.size) throw new ReviewError("not-found", `no local data for ${input.path}`);
    return rewriteWithout(local, docIds);
  });
  if (config.roots.includes(input.path)) await trackLocally(shared, { path: input.path, isDir: false, action: "remove" }).catch(() => undefined);
  local.invalidate();
  shared.invalidate();
  return { status: "forgotten" as const, path: input.path, events: result.dropped, files: result.files };
}

/**
 * The local journal rebuilt without some documents (security review EP-048, finding 2): every other event is replayed
 * in a fresh store with the same ids and objects; the documents' own changes, their annotations, this reader's
 * receipts of them and the batches that held them are left out (an agent's answer stays as a message). Deleting single
 * event files instead broke the reader's and the batches' references. The old store is replaced at the end; the
 * observations and the journal cache of the local review go with it.
 */
async function rewriteWithout(local: ReviewService, docIds: Set<string>): Promise<{ dropped: number; files: number }> {
  const { FsBackend } = await import("./fs-backend.ts");
  const { layout, objectReferences, operationReferences, publish } = await import("../core/store.ts");
  const { operationEntities, parentsFor } = await import("../core/journal.ts");
  const state = await local.state();
  const annotations = new Set<string>();
  const receipts = new Set<string>();
  const runs = new Set<string>();
  for (const id of state.order) for (const change of state.events.get(id)!.changes) {
    if (change.type === "annotation.created" && docIds.has(change.docId)) annotations.add(change.annotationId);
    if (change.type === "read.acknowledged" && docIds.has(change.docId)) receipts.add(change.receiptId);
    if (change.type === "batch.input-registered" && docIds.has(change.docId)) runs.add(change.runId);
    if (change.type === "batch.prepared" && change.items.some((item) => annotations.has(item.annotationId))) runs.add(change.runId);
    if (change.type === "batch.prepared") {
      const manifest = state.objects.get(change.manifest) as { documents?: { docId: string }[] } | undefined;
      if (manifest?.documents?.some((doc) => docIds.has(doc.docId))) runs.add(change.runId);
    }
  }
  const keep = (change: Operation["changes"][number]): Operation["changes"][number] | null => {
    switch (change.type) {
      case "document.registered": case "document.observed": case "document.moved": case "document.removed": case "document.transferred":
        return docIds.has(change.docId) ? null : change;
      case "annotation.created":
        return annotations.has(change.annotationId) ? null : change;
      case "read.acknowledged":
        return receipts.has(change.receiptId) ? null : change;
      case "read.revoked":
        return receipts.has(change.receiptId) ? null : change;
      case "layout.pinned": case "layout.unpinned":
        return docIds.has(change.scope.doc) ? null : change;
      case "batch.prepared": case "batch.dispatched": case "batch.input-registered": case "batch.finished":
        return runs.has(change.runId) ? null : change;
      case "item.result-recorded":
        return runs.has(change.runId) || annotations.has(change.annotationId) ? null : change;
      case "message.appended":
        if (annotations.has(change.annotationId)) return null;
        return change.runId && runs.has(change.runId) ? { type: "message.appended", annotationId: change.annotationId, messageId: change.messageId, text: change.text } : change;
      default:
        return "annotationId" in change && annotations.has(change.annotationId) ? null : change;
    }
  };
  const storeDir = local.store.root;
  const temp = `${storeDir}.rewrite-${newId()}`;
  const target = new FsBackend(temp);
  await fs.mkdir(temp, { recursive: true, mode: 0o700 });
  for (const file of ["config.json", "local-meta.json"]) await fs.copyFile(path.join(storeDir, file), path.join(temp, file)).catch(() => undefined);
  const known = new Set<string>();
  let pending = state.order.map((id) => state.events.get(id)!);
  let dropped = 0;
  let written = 0;
  const heads = new Map<string, string[]>();
  for (let pass = 0; pending.length && pass < 64; pass++) {
    const waiting: Operation[] = [];
    for (const source of pending) {
      const changes = source.changes.map(keep).filter((change): change is Operation["changes"][number] => change !== null);
      if (!changes.length) { dropped++; continue; }
      const draft = { ...source, changes } as Operation;
      const objects = operationReferences(draft).objects.map((sha) => state.objects.get(sha)!).filter(Boolean);
      const observed = new Set(changes.flatMap((change) => (change.type === "document.observed" ? [change.revisionId] : [])));
      const needs = [...operationReferences(draft).revisions, ...objects.flatMap((object) => objectReferences(object).revisions)];
      if (needs.some((id) => !observed.has(id) && !known.has(id))) { waiting.push(source); continue; }
      const snapshots: Uint8Array[] = [];
      for (const object of objects) for (const sha of objectReferences(object).snapshots) {
        const bytes = await local.store.read(layout.snapshot(sha));
        if (bytes) snapshots.push(bytes);
      }
      const entities = operationEntities(draft);
      const parents = [...new Set(entities.flatMap((key) => heads.get(key) ?? []))].sort();
      const operation: Operation = { ...source, parents, changes };
      await publish(target, { operation, objects, snapshots }, { isKnownRevision: (id) => known.has(id) });
      for (const id of observed) known.add(id);
      for (const key of entities) heads.set(key, [operation.id]);
      written++;
      if (changes.length !== source.changes.length) dropped++;
    }
    if (waiting.length === pending.length) break;
    pending = waiting;
  }
  void parentsFor;
  const old = `${storeDir}.old-${newId()}`;
  await fs.rename(storeDir, old);
  await fs.rename(temp, storeDir);
  await fs.rm(old, { recursive: true, force: true });
  // Leftovers of the old journal (finding 15): the local review's observations and journal cache.
  await fs.rm(path.join(local.dataDir, "observations", sha256(`${local.root}#local:${path.basename(storeDir)}`).slice(0, 16)), { recursive: true, force: true }).catch(() => undefined);
  await local.journalCache.reset();
  local.invalidate();
  return { dropped, files: written };
}

// ── lifecycle (EP-048-T03): renames, the stores of this reader, retention ─────────────────────────────────────────

/** The review holding a document id: the shared journal first, then this reader's local one. */
export async function serviceForDoc(shared: ReviewService, docId: string): Promise<ReviewService> {
  const state = await shared.state().catch(() => null);
  if (state?.documents.has(docId)) return shared;
  const local = await localFor(shared).catch(() => null);
  if (local && (await localConfig(local))) {
    const localState = await local.state().catch(() => null);
    if (localState?.documents.has(docId)) return local;
  }
  return shared;
}

/** Resolve a local tracked-file rename: add the destination to tracking roots when no folder root covers it, remove the old file root, and publish document.moved in the local journal. */
export async function localRulesForMove(local: ReviewService, from: string, to: string): Promise<void> {
  if (!isRepoPath(to)) throw new ReviewError("bad-path", `not a repository path: ${to}`);
  await confine(local.root, to);
  const read = await local.config();
  if (!read.value || local.insideRoots(read.value, to)) return;
  const next: Config = { ...read.value, roots: [...new Set([...read.value.roots.filter((root) => root !== from), to])] };
  const parsed = parseConfig(next);
  if (!parsed.ok) throw new ReviewError("bad-input", parsed.issues.join("; "));
  if ((await writeConfig(local.store, canonicalBytes(next), read.sha)) !== "replaced") throw new ReviewError("stale", "the local tracking rules changed concurrently; try again");
  local.invalidate();
}

/** A local rename destination must exist outside Git. Move tracking rules with the file and restore them if the move is rejected. */
export async function localMove(shared: ReviewService, local: ReviewService, input: { docId: string; to: string | null } & Expectation) {
  const { resolveMove } = await import("./catalog.ts");
  if (!input.to) return resolveMove(local, input);
  if (!isRepoPath(input.to)) throw new ReviewError("bad-path", `not a repository path: ${input.to}`);
  await confine(shared.root, input.to);
  if ((await shared.fileClass(input.to)) === "git") throw new ReviewError("not-outside", `${input.to} is in Git: its review is shared`);
  const from = (await local.state()).documents.get(input.docId)?.path;
  if (!from) throw new ReviewError("not-found", "no such local document");
  const before = await local.config();
  await localRulesForMove(local, from, input.to);
  try {
    return await resolveMove(local, input);
  } catch (error) {
    const now = await local.config();
    if (before.value && now.sha !== before.sha) await writeConfig(local.store, canonicalBytes(before.value), now.sha).catch(() => undefined);
    local.invalidate();
    throw error;
  }
}

interface StoreMeta { root: string; repoId: string; reader: string; goneSince?: string | null; gone?: Record<string, string> }

const META = "local-meta.json";
async function readMeta(storeDir: string): Promise<StoreMeta | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(storeDir, META), "utf8")) as StoreMeta;
  } catch {
    return null;
  }
}
async function writeMeta(storeDir: string, meta: StoreMeta): Promise<void> {
  await fs.mkdir(storeDir, { recursive: true, mode: 0o700 });
  const temp = path.join(storeDir, `${META}.${newId()}`);
  await fs.writeFile(temp, JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(temp, path.join(storeDir, META));
}

/** Record which checkout owns the store at the first tracking action, for detecting missing checkouts. */
export async function touchMeta(shared: ReviewService): Promise<void> {
  const local = await localFor(shared);
  const readerId = await readerOf(shared);
  if (!local || !readerId) return;
  const storeDir = local.store.root;
  const meta = await readMeta(storeDir);
  await writeMeta(storeDir, { ...(meta ?? {}), root: shared.root, repoId: await repoIdOf(shared), reader: hash(readerId.trim().toLowerCase()), goneSince: null, gone: meta?.gone ?? {} });
}

/** The local stores of this reader on this machine whose checkout is gone (moved or deleted): «attach» and «Forget». */
export async function missingCheckouts(shared: ReviewService): Promise<{ storeDir: string; root: string; repoId: string; documents: number; goneSince: string | null }[]> {
  const readerId = await readerOf(shared);
  if (!readerId) return [];
  const reader = hash(readerId.trim().toLowerCase());
  const base = path.join(shared.dataDir, "local-review");
  const out = [];
  for (const repoId of await fs.readdir(base).catch(() => [] as string[])) {
    if (repoId === "_ids") continue;
    for (const checkout of await fs.readdir(path.join(base, repoId)).catch(() => [] as string[])) {
      const storeDir = path.join(base, repoId, checkout, reader);
      const meta = await readMeta(storeDir);
      if (!meta || meta.root === shared.root) continue;
      if (await fs.lstat(meta.root).then(() => true, () => false)) {
        // Present again: its absence is over (security review, finding 9).
        if (meta.goneSince) await writeMeta(storeDir, { ...meta, goneSince: null }).catch(() => undefined);
        continue;
      }
      // An unmounted volume or a folder without access is not a deleted checkout: its parent must exist.
      if (!(await fs.lstat(path.dirname(meta.root)).then(() => true, () => false))) continue;
      const events = await fs.readdir(path.join(storeDir, "events"), { recursive: true }).catch(() => [] as string[]);
      out.push({ storeDir, root: meta.root, repoId, documents: events.filter((name) => String(name).endsWith(".json")).length, goneSince: meta.goneSince ?? null });
    }
  }
  return out;
}

/** Attach a moved checkout store with the same repoId when this checkout has no store yet. */
export async function bindStore(shared: ReviewService, input: { storeDir: string }) {
  const local = await localFor(shared);
  if (!local) throw new ReviewError("no-identity", "Git user.email is not set in this checkout");
  const candidates = await missingCheckouts(shared);
  const found = candidates.find((entry) => entry.storeDir === input.storeDir);
  if (!found) throw new ReviewError("not-found", "no such store of yours with a missing checkout");
  if (found.repoId !== (await repoIdOf(shared))) throw new ReviewError("bad-input", "the store belongs to another repository");
  if (await localConfig(local)) throw new ReviewError("conflict", "this checkout already has local review data: forget one of them first");
  const target = local.store.root;
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(found.storeDir, target);
  local.invalidate();
  await touchMeta(shared);
  return { status: "bound" as const, from: found.root, to: shared.root };
}

/** «Forget» a store of this reader whose checkout is gone. */
export async function forgetStore(shared: ReviewService, input: { storeDir: string }) {
  const found = (await missingCheckouts(shared)).find((entry) => entry.storeDir === input.storeDir);
  if (!found) throw new ReviewError("not-found", "no such store of yours with a missing checkout");
  await fs.rm(found.storeDir, { recursive: true, force: true });
  return { status: "forgotten" as const, root: found.root };
}

/** Retention of missing tracked local files and missing checkouts: N days, zero immediately, null never. Record the first missing observation; the host performs cleanup while building the tree. */
export async function cleanupLocal(shared: ReviewService, options: { now?: number } = {}) {
  const readerId = await readerOf(shared);
  const local = await localFor(shared).catch(() => null);
  if (!readerId || !local || !(await localConfig(local))) return { forgotten: [] as string[], stores: [] as string[] };
  const { readUserSettings } = await import("./user-settings.ts");
  const days = (await readUserSettings(shared.dataDir, readerId)).retentionDays;
  const now = options.now ?? Date.now();
  const due = (since: string) => days !== null && now - Date.parse(since) >= days * 86_400_000;
  await touchMeta(shared).catch(() => undefined);
  const meta = (await readMeta(local.store.root)) ?? { root: shared.root, repoId: await repoIdOf(shared), reader: hash(readerId.trim().toLowerCase()), gone: {} };
  const gone = { ...(meta.gone ?? {}) };
  const forgotten: string[] = [];
  const state = await local.state();
  const present = new Set<string>();
  for (const doc of state.documents.values()) {
    if (!doc.path) continue;
    if (await fs.lstat(path.join(shared.root, doc.path)).then(() => true, () => false)) { present.add(doc.path); continue; }
    gone[doc.path] ??= new Date(now).toISOString();
  }
  for (const file of Object.keys(gone)) {
    if (present.has(file)) { delete gone[file]; continue; }
    if (!due(gone[file])) continue;
    await localForget(shared, { path: file }).catch(() => undefined);
    delete gone[file];
    forgotten.push(file);
  }
  await writeMeta(local.store.root, { ...meta, gone });
  const stores: string[] = [];
  for (const entry of await missingCheckouts(shared)) {
    const since = entry.goneSince ?? new Date(now).toISOString();
    if (!entry.goneSince) await writeMeta(entry.storeDir, { ...((await readMeta(entry.storeDir)) as StoreMeta), goneSince: since });
    // Retain an entire store for at least one day even with immediate cleanup, so moving a checkout away and back does not lose data.
    const storeDue = days !== null && now - Date.parse(since) >= Math.max(days, 1) * 86_400_000;
    if (storeDue) { await fs.rm(entry.storeDir, { recursive: true, force: true }); stores.push(entry.root); }
  }
  return { forgotten, stores };
}

// Batches of local files.

/** The review holding a batch: the shared journal first, then this reader's local one. */
export async function serviceForRun(shared: ReviewService, runId: string): Promise<ReviewService> {
  const { runsOf } = await import("../core/batch.ts");
  const state = await shared.state().catch(() => null);
  if (state && runsOf(state).some((run) => run.runId === runId)) return shared;
  const local = await localFor(shared).catch(() => null);
  if (local && (await localConfig(local))) {
    const localState = await local.state().catch(() => null);
    if (localState && runsOf(localState).some((run) => run.runId === runId)) return local;
  }
  return shared;
}

/**
 * «Send to agent» over both reviews (§9): local items go as a batch of their own, recorded in the local store (in
 * .bb-docs nothing); shared and local batches stand in one DR-01 queue of the checkout — one is prepared while the
 * other is unfinished only for the same thread (the send of a pass with both: two batches in a row to one thread).
 */
const checkoutLocks = new Map<string, Promise<unknown>>();
/** One batch preparation at a time per checkout over both stores (DR-01; security review, finding 13). */
function withCheckoutLock<T>(root: string, run: () => Promise<T>): Promise<T> {
  const previous = checkoutLocks.get(root) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  checkoutLocks.set(root, next);
  return next;
}

export function prepareAny(shared: ReviewService, input: Parameters<typeof import("./batches.ts").prepareBatch>[1]) {
  return withCheckoutLock(shared.root, () => prepareBoth(shared, input));
}

async function prepareBoth(shared: ReviewService, input: Parameters<typeof import("./batches.ts").prepareBatch>[1]) {
  const { prepareBatch } = await import("./batches.ts");
  const { unfinishedRuns } = await import("../core/batch.ts");
  const local = await localFor(shared).catch(() => null);
  const localOn = Boolean(local && (await localConfig(local)));
  const busyElsewhere = async (other: ReviewService | null, threadId: string | null) => {
    if (!other || (other === local && !localOn)) return;
    const state = await other.state().catch(() => null);
    const open = state ? unfinishedRuns(state) : [];
    const launch = await other.launch.get();
    const foreign = open.filter((run) => !threadId || !run.attempts.some((attempt) => attempt.threadId === threadId));
    if (foreign.length || (launch && (!threadId || launch.recipient.threadId !== threadId))) {
      throw new ReviewError("busy", "another batch of this checkout is not finished yet; new instructions wait for it (DR-01)", { runId: foreign[0]?.runId ?? launch?.runId ?? null });
    }
  };
  if (input.scope.kind === "document") {
    const service = await serviceForPath(shared, input.scope.path);
    await busyElsewhere(service === shared ? local : shared, input.recipient.threadId);
    return { ...(await prepareBatch(service, input)), local: service.scope === "local" };
  }
  const prepared: (Awaited<ReturnType<typeof prepareBatch>> & { local: boolean })[] = [];
  const attempt = async (service: ReviewService) => {
    try {
      prepared.push({ ...(await prepareBatch(service, input)), local: service.scope === "local" });
    } catch (error) {
      if (!(error instanceof ReviewError) || error.code !== "nothing-to-send") throw error;
    }
  };
  if ((await shared.config()).value) {
    await busyElsewhere(local, input.recipient.threadId);
    await attempt(shared);
  }
  if (local && localOn) await attempt(local);
  if (!prepared.length) throw new ReviewError("nothing-to-send", "no annotation with new instructions in this scope");
  return { ...prepared[0], next: prepared[1] ?? null };
}
