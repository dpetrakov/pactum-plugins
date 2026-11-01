// Review service of one checkout on its host (EP-007-T03/T04/T05). One instance per canonical checkout path:
// commands are serialized here, every mutation re-checks HEAD/branch and expected heads, the journal is
// re-read whenever HEAD or the event list changed. This lock is not global across clones: divergence of
// independent clones is detected by the event model after merge (architecture §4).
import fs from "node:fs/promises";
import { tr } from "../core/i18n.ts";
import path from "node:path";
import ignore from "ignore";
import { canonicalBytes } from "../core/canonical-json.ts";
import { discussion, checkTransition } from "../core/discussion.ts";
import { newId, sha256 } from "../core/hash.ts";
import { entity, loadRepository, operationEntities, parentsFor, project, revisionHistory, revisionObject, type State, writeBlockers } from "../core/journal.ts";
import { sectionBlocks, targetRange } from "../core/targets.ts";
import { buildRevision, quoteAt, verifyQuote, blockSegments, projectionToSource, checkRevision } from "../core/markdown/index.ts";
import { type FileProjection, projectFile } from "../core/formats/project.ts";
import { linesOf } from "../core/formats/anchor.ts";
import { keyPathString } from "../core/formats/paths.ts";
import { checkReceipt, hasReadingBase, normalizeReaderId, readState, ReaderIdError, removalState } from "../core/reading.ts";
import { CONTEXT, type Config, type ObjectValue, type Operation, SCHEMA_VERSION, parseConfig, operationVersion } from "../core/schema.ts";
import { layout, objectReferences, operationReferences, publish, StoreError, writeConfig } from "../core/store.ts";
import type { Revision } from "../core/types.ts";
import { validate, type ValidateResult } from "../core/validate.ts";
import { layoutOf } from "../core/layouts.ts";
import { versionsInUse } from "../core/migrate.ts";
import { type CheckoutInfo, confine, generatedAttribute, git, isIgnored, resolveCheckout, uncommittedReviewFiles } from "./checkout.ts";
import { mergeLists } from "../core/rules.ts";
import { FsBackend } from "./fs-backend.ts";
import { IntentLog } from "./intent.ts";
import { JournalCache } from "./journal-cache.ts";
import { LaunchLog } from "./launch.ts";
import { ObservationLog } from "./observations.ts";
import { type FileClass, readContent, sharedRules } from "./content.ts";
import { exclusionsFor, walkRoots } from "./walk.ts";
import { classify } from "../core/formats/secrets.ts";
import { SecretStore } from "./secret-store.ts";
import { formatOf, isReviewable } from "../core/formats/registry.ts";

export class ReviewError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Largest document the service reads or snapshots. */
const MAX_DOCUMENT = 8 * 1024 * 1024;
/**
 * Files larger than this stay out of the initial base (2026-10-16): a multi-megabyte data file (JSON, CSV) costs
 * seconds of one blocked worker to register, and enabling must not freeze the machine's plugin. They are registered
 * like any new document — with the first annotation or «Mark read» on them.
 */
export const BASE_MAX = 1024 * 1024;
const SKIP_DIRS = new Set([".git", ".bb-docs", "node_modules"]);
// Keep a BOM: the projection drops it, but the snapshot hash covers the exact bytes.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

export interface Expectation {
  /** HEAD and branch the caller saw; a mismatch is a context change (DR-02, G6). */
  head?: string | null;
  branch?: string | null;
}

interface Cached {
  key: string;
  state: State;
}

export class ReviewService {
  readonly root: string;
  readonly store: FsBackend;
  readonly observations: ObservationLog;
  /** Local launch record of a batch of this checkout (DR-01). */
  readonly launch: LaunchLog;
  /** Unfinished two-step catalog write of this checkout (tracking resumed, EP-014-T01). */
  readonly intents: IntentLog;
  readonly dataDir: string;
  /** Parsed .bb-docs files of this checkout, kept by the host across restarts (EP-015-T01). */
  readonly journalCache: JournalCache;
  /** Device key and «value changed» HMACs (W-06c, §8): never leaves the plugin's data directory. */
  readonly secrets: SecretStore;
  private queue: Promise<unknown> = Promise.resolve();
  private cache: Cached | null = null;
  /** Count of journal re-reads, for diagnostics and the branch-switch test. */
  reloads = 0;

  /**
   * Shared review (`.bb-docs` of the checkout) or the local review of one user (W-06c, §9, EP-048): the same journal,
   * projection and rules in a store under the plugin's data directory, for files outside Git only.
   */
  readonly scope: "shared" | "local";

  constructor(root: string, dataDir: string, local: { storeDir: string; key: string } | null = null) {
    this.root = root;
    this.scope = local ? "local" : "shared";
    const key = local ? `${root}#local:${local.key}` : root;
    this.store = new FsBackend(local ? local.storeDir : path.join(root, ".bb-docs"));
    this.observations = new ObservationLog(path.join(dataDir, "observations", sha256(key).slice(0, 16)));
    this.launch = new LaunchLog(dataDir, key);
    this.intents = new IntentLog(dataDir, key);
    this.dataDir = dataDir;
    this.journalCache = new JournalCache(dataDir, key);
    this.secrets = new SecretStore(dataDir);
  }

  /** A «new» file with this reader's local data (the sticky local mode, §4): never taken by the shared review. */
  async keptLocally(docPath: string): Promise<boolean> {
    if (this.scope !== "shared") return false;
    const { isTrackedLocally } = await import("./local.ts");
    return isTrackedLocally(this, docPath).catch(() => false);
  }

  /** Whether this review keeps data for a file of this Git class: the shared one — in Git and new; the local one — outside Git. */
  reviews(fileClass: FileClass): boolean {
    // The local review keeps «new» files too: a file with local data that is not ignored in another branch but not in
    // the index remains local; its journal decides which newly discovered files keep local review data.
    return this.scope === "local" ? fileClass !== "git" : fileClass !== "outside";
  }

  /** Run commands of this checkout one at a time. */
  serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(run);
    this.queue = next;
    return next;
  }

  /** Drop runtime caches; the next read re-reads .bb-docs (watch invalidation, branch switch). */
  invalidate(): void {
    this.cache = null;
    this.readCheckout = null;
    this.classes = null;
    this.generation++;
  }

  /** Git classes of the checkout's files (W-06c, file-types.md §4): one pair of `git ls-files` per generation. */
  private classes: { at: number; generation: number; cached: Set<string>; ignored: Set<string>; ignoredDirs: string[]; isRepo: boolean; failed: boolean; folded: boolean } | null = null;

  async fileClasses() {
    if (this.classes && this.classes.generation === this.generation && Date.now() - this.classes.at < 5000) return this.classes;
    const info = await this.checkoutForRead();
    if (!info.isRepo) {
      this.classes = { at: Date.now(), generation: this.generation, cached: new Set(), ignored: new Set(), ignoredDirs: [], isRepo: false, failed: false, folded: false };
      return this.classes;
    }
    const cachedOut = await git(this.root, ["ls-files", "-z", "--cached"], { allowFailure: true });
    const ignoredOut = await git(this.root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], { allowFailure: true });
    // Case-insensitive file systems (macOS default): «.ENV.local» names the ignored «.env.local».
    const folded = (await git(this.root, ["config", "--bool", "core.ignorecase"], { allowFailure: true })).stdout.trim() === "true";
    const norm = (value: string) => (folded ? value.toLowerCase() : value);
    // A failing Git listing fails closed: every file is «outside Git» (shown only, nothing stored) — security review.
    const failed = cachedOut.code !== 0 || ignoredOut.code !== 0;
    const cached = new Set(failed ? [] : cachedOut.stdout.split("\0").filter(Boolean).map(norm));
    const ignored = new Set<string>();
    const ignoredDirs: string[] = [];
    if (!failed) {
      for (const entry of ignoredOut.stdout.split("\0").filter(Boolean)) {
        if (entry.endsWith("/")) ignoredDirs.push(norm(entry));
        else ignored.add(norm(entry));
      }
    }
    this.classes = { at: Date.now(), generation: this.generation, cached, ignored, ignoredDirs, isRepo: true, failed, folded };
    return this.classes;
  }

  /** Git classification: git means indexed, new means neither indexed nor ignored, outside means ignored. In a folder without Git all files use the ordinary git classification. */
  async fileClass(docPath: string): Promise<FileClass> {
    const classes = await this.fileClasses();
    if (!classes.isRepo) return "git";
    if (classes.failed) return "outside";
    const key = classes.folded ? docPath.toLowerCase() : docPath;
    if (classes.cached.has(key)) return "git";
    if (classes.ignored.has(key) || classes.ignoredDirs.some((dir) => key.startsWith(dir))) return "outside";
    return "new";
  }

  /** Bumped by every write and watch invalidation: a computation started before it is not shared after it. */
  generation = 0;

  async checkout(): Promise<CheckoutInfo> {
    const info = await resolveCheckout(this.root);
    if (info.root !== this.root) throw new ReviewError("context-changed", `checkout root moved: ${info.root}`);
    this.readCheckout = { at: Date.now(), info };
    return info;
  }

  private readCheckout: { at: number; info: CheckoutInfo } | null = null;

  /**
   * Checkout info for display paths (view, tree, document reads): reused for under a second so one view does not run
   * the Git calls twice. Every write still resolves the checkout afresh in writable() (DR-02, G6); watch and writes
   * invalidate it.
   */
  async checkoutForRead(): Promise<CheckoutInfo> {
    if (this.readCheckout && Date.now() - this.readCheckout.at < 750) return this.readCheckout.info;
    return this.checkout();
  }

  /** Projected journal, re-read when HEAD or the set of event files changed. */
  async state(info?: CheckoutInfo): Promise<State> {
    const checkout = info ?? (await this.checkout());
    const events = await this.store.list("events");
    const key = `${checkout.head ?? "-"}|${checkout.branch ?? "-"}|${events.length}|${sha256(events.join("\n"))}`;
    if (this.cache?.key === key) return this.cache.state;
    this.reloads++;
    const cache = await this.journalCache.open();
    const state = project(await loadRepository(this.store, { cache }));
    await cache.flush();
    this.cache = { key, state };
    return state;
  }

  /**
   * A Git merge conflict in config.json (EP-014-T02): the three index stages (common base, ours, theirs) and their
   * three-way merge. Null when the file is not unmerged in the index. Reading of every document keeps working.
   */
  async configConflict(): Promise<{ base: Config | null; ours: Config; theirs: Config; merged: Config; problem: string | null } | null> {
    const unmerged = await git(this.root, ["ls-files", "-u", "--", ".bb-docs/config.json"], { allowFailure: true });
    if (unmerged.code !== 0 || !unmerged.stdout.trim()) return null;
    const stage = async (n: number): Promise<Config | null> => {
      const shown = await git(this.root, ["show", `:${n}:.bb-docs/config.json`], { allowFailure: true });
      if (shown.code !== 0) return null;
      try {
        const parsed = parseConfig(JSON.parse(shown.stdout));
        return parsed.ok ? parsed.value : null;
      } catch {
        return null;
      }
    };
    const [base, ours, theirs] = await Promise.all([stage(1), stage(2), stage(3)]);
    if (!ours || !theirs) return null;
    const lists = { base: base ?? { roots: [], hidden: [], untracked: [] } };
    const merged: Config = {
      schemaVersion: ours.schemaVersion,
      repoId: ours.repoId,
      roots: mergeLists(lists.base.roots, ours.roots, theirs.roots),
      hidden: mergeLists(lists.base.hidden, ours.hidden, theirs.hidden),
      untracked: mergeLists(lists.base.untracked, ours.untracked, theirs.untracked),
    };
    const problem = ours.repoId !== theirs.repoId ? "the two branches have different review repositories (repoId); resolve config.json by hand"
      : ours.schemaVersion !== theirs.schemaVersion ? `the branches have different schema versions (${ours.schemaVersion} / ${theirs.schemaVersion}); resolve config.json by hand`
      : !merged.roots.length ? "the merged roots would be empty; resolve config.json by hand" : null;
    return { base, ours, theirs, merged, problem };
  }

  /** Write the three-way merge of a conflicted config.json (CAS on the conflicted bytes) and mark it resolved in Git. */
  async resolveConfigConflict(input: { configSha?: string | null } & Expectation) {
    return this.serial(async () => {
      const info = await this.checkout();
      if (input.head !== undefined && input.head !== info.head) throw new ReviewError("context-changed", "the checkout moved since it was shown; nothing was saved");
      const conflict = await this.configConflict();
      if (!conflict) throw new ReviewError("stale", "config.json is not in conflict any more; reload");
      if (conflict.problem) throw new ReviewError("bad-input", conflict.problem);
      const parsed = parseConfig(conflict.merged);
      if (!parsed.ok) throw new ReviewError("bad-input", parsed.issues.join("; "));
      const current = await this.store.read(layout.config);
      const currentSha = current ? sha256(current) : null;
      if (input.configSha !== undefined && input.configSha !== currentSha) throw new ReviewError("stale", "config.json changed since it was shown; reload");
      if ((await writeConfig(this.store, canonicalBytes(conflict.merged), currentSha)) !== "replaced") throw new ReviewError("config-conflict", "config.json changed concurrently; reload");
      await git(this.root, ["add", "--", ".bb-docs/config.json"]);
      this.invalidate();
      return { status: "resolved" as const, config: conflict.merged };
    });
  }

  /** config.json; damaged, foreign or unreadable config opens read-only instead of failing the command. */
  async config(): Promise<{ value: Config | null; sha: string | null; readOnly: boolean; problem?: string; configConflict?: boolean }> {
    let bytes: Uint8Array | null;
    try {
      bytes = await this.store.read(layout.config);
    } catch (error) {
      return { value: null, sha: null, readOnly: true, problem: error instanceof Error ? error.message : String(error) };
    }
    if (!bytes) return { value: null, sha: null, readOnly: false };
    let raw: unknown;
    try {
      raw = JSON.parse(decoder.decode(bytes));
    } catch {
      const text = decoder.decode(bytes);
      const merge = /^<<<<<<< /m.test(text) && /^>>>>>>> /m.test(text);
      if (!merge) return { value: null, sha: sha256(bytes), readOnly: true, problem: "config.json is not valid JSON" };
      // Reading goes on with this branch's rules (index stage 2); writes wait for the explicit resolution.
      const conflict = await this.configConflict().catch(() => null);
      return { value: conflict?.ours ?? null, sha: sha256(bytes), readOnly: true, configConflict: true, problem: "config.json has an unresolved Git merge conflict: reading works, writing waits for its resolution" };
    }
    const parsed = parseConfig(raw);
    return { value: parsed.ok ? parsed.value : null, sha: sha256(bytes), readOnly: !parsed.ok || parsed.version !== "current", ...(parsed.ok ? {} : { problem: parsed.issues[0] }) };
  }

  /**
   * A document the service may read: a regular file of a type of the format registry (W-06c), not inside .git, .bb-docs or dependencies,
   * not a symlink anywhere on the way, and of bounded size. Anything else in the checkout is not served.
   */
  async documentFile(docPath: string): Promise<string> {
    const absolute = await confine(this.root, docPath);
    if (docPath.split("/").some((segment) => SKIP_DIRS.has(segment.toLowerCase()))) throw new ReviewError("bad-path", `service directory: ${docPath}`);
    if (!isReviewable(docPath)) throw new ReviewError("not-supported", `not a reviewable file type: ${docPath}`);
    const stat = await fs.lstat(absolute).catch(() => null);
    if (!stat) throw new ReviewError("not-found", `no such document: ${docPath}`);
    if (!stat.isFile()) throw new ReviewError("bad-path", `not a regular file: ${docPath}`);
    if (stat.size > MAX_DOCUMENT) throw new ReviewError("too-large", `document larger than ${MAX_DOCUMENT} bytes: ${docPath}`);
    return absolute;
  }

  /** An excluded file (W-06c, §4) is neither shown nor tracked: no persistent references to it. */
  async refuseExcluded(config: Config, docPath: string): Promise<void> {
    const info = await this.checkoutForRead();
    let readerId: string | null = null;
    try { readerId = normalizeReaderId(info.identity.email); } catch { readerId = null; }
    const decision = (await exclusionsFor(this.dataDir, config, readerId)).decide(docPath);
    if (decision.excluded) throw new ReviewError("excluded", `excluded by the rule «${decision.rule?.pattern ?? "?"}» (${decision.rule?.level ?? "rule"}): ${docPath}`);
    if (config.types && !isReviewable(docPath, config.types)) throw new ReviewError("excluded", `the type of this file is turned off in this repository: ${docPath}`);
  }

  /** Persistent references (annotations, receipts) only for documents inside the review roots. */
  insideRoots(config: Config, docPath: string): boolean {
    return config.roots.some((root) => root === "." || docPath === root || docPath.startsWith(`${root}/`));
  }

  // ── context checks before any mutation ──────────────────────────────────

  async writable(expect: Expectation): Promise<{ info: CheckoutInfo; readerId: string; actor: Operation["actor"]; state: State }> {
    const info = await this.checkout();
    if (!info.isRepo) throw new ReviewError("read-only", "folder without Git: reading only, no review (A11)");
    if (expect.head !== undefined && expect.head !== info.head) {
      this.invalidate();
      throw new ReviewError("context-changed", "the checkout moved to another commit or branch since it was shown; nothing was saved", { head: info.head, branch: info.branch });
    }
    if (expect.branch !== undefined && expect.branch !== info.branch) {
      this.invalidate();
      throw new ReviewError("context-changed", "the branch changed since it was shown; nothing was saved", { head: info.head, branch: info.branch });
    }
    let readerId: string;
    try {
      readerId = normalizeReaderId(info.identity.email);
    } catch (error) {
      throw new ReviewError("no-identity", error instanceof ReaderIdError ? error.message : String(error));
    }
    const config = await this.config();
    if (config.readOnly) throw new ReviewError("read-only", config.problem ?? "config.json cannot be used for writing");
    if (!config.value) throw new ReviewError("not-enabled", "review is not enabled in this checkout");
    if (config.readOnly) throw new ReviewError("read-only", config.problem ?? "config.json is from another schema version");
    const state = await this.state(info);
    if (state.repoReadOnly.length) throw new ReviewError("read-only", state.repoReadOnly[0]);
    return { info, readerId, actor: { kind: "human", name: info.identity.name ?? readerId, email: info.identity.email!.trim() }, state };
  }

  async commit(state: State, actor: Operation["actor"], changes: Operation["changes"], objects: ObjectValue[], snapshots: Uint8Array[], extraParents: string[] = [], resolvingConflict = false) {
    // The oldest version that expresses the changes: 1.0 data stays readable by a 1.0 plugin (G3).
    const operation: Operation = { schemaVersion: operationVersion(changes, objects as { schemaVersion?: string }[]), id: newId(), actor, timestamp: new Date().toISOString(), parents: [], changes };
    operation.parents = [...new Set([...parentsFor(state, operationEntities(operation)), ...extraParents])].sort();
    // A conflict makes its entity read-only; only the explicit resolution may write there (G4).
    const blockers = writeBlockers(state, operationEntities(operation)).filter((reason) => !(resolvingConflict && /: conflict in /.test(reason)));
    if (blockers.length) throw new ReviewError("blocked", blockers[0], { blockers: blockers.slice(0, 10) });
    try {
      const result = await publish(this.store, { operation, objects, snapshots }, { isKnownRevision: (id) => state.revisions.has(id) });
      return { operation, result };
    } finally {
      this.invalidate();
    }
  }

  /** Record a promoted revision in its own operation (the oldest version it needs) and return the state after it. */
  async commitPromotion(state: State, actor: Operation["actor"], promoted: { changes: Operation["changes"]; objects: ObjectValue[]; snapshots: Uint8Array[] }): Promise<State> {
    await this.commit(state, actor, promoted.changes, promoted.objects, promoted.snapshots);
    return this.state(await this.checkout());
  }

  // ── documents ──────────────────────────────────────────────────────────

  /**
   * Tracked documents under the roots (A1–A8; W-06c): the same walk as the tree — files of the format registry and
   * enabled types, exclusion levels (built-in, the user's global rules, config exclude), symlinks skipped — without the
   * files outside Git (shown only until local review) and the untracked ones. No time budget: the set is complete.
   */
  async trackedDocuments(config: Config): Promise<{ path: string; size: number }[]> {
    const untracked = ignore().add(config.untracked);
    const info = await this.checkoutForRead();
    let readerId: string | null = null;
    try { readerId = normalizeReaderId(info.identity.email); } catch { readerId = null; }
    const exclusions = await exclusionsFor(this.dataDir, config, readerId);
    const walked = await walkRoots(this.root, config.roots, { exclusions, types: config.types ?? null, budgetMs: 600_000, maxEntries: 1_000_000 });
    const out: { path: string; size: number }[] = [];
    let known: Set<string> | null = null;
    for (const [file, meta] of walked.files) {
      if (untracked.ignores(file)) continue;
      const fileClass = await this.fileClass(file);
      if (!this.reviews(fileClass)) continue;
      if (this.scope === "local" && fileClass === "new") {
        known ??= new Set([...(await this.state()).documents.values()].filter((doc) => doc.path && !doc.removed).map((doc) => doc.path!));
        if (!known.has(file)) continue;
      }
      // A «new» file this reader keeps locally (§4) is not the shared review's (security review EP-048, finding 3).
      if (this.scope === "shared" && fileClass === "new" && (await this.keptLocally(file))) continue;
      out.push({ path: file, size: meta.size });
    }
    return out;
  }

  docIdOf(state: State, docPath: string): string | null {
    for (const record of state.documents.values()) if (record.path === docPath && !record.removed) return record.docId;
    return null;
  }

  /**
   * sha256 of the current bytes of a tracked document, without the checkout and journal work of readDocument: batch
   * preparation and finish compare every tracked document (1000 files must not cost a Git call each, EP-015-T01).
   */
  async documentSha(docPath: string): Promise<string | null> {
    try {
      return (await readContent(this, docPath)).sha;
    } catch {
      return null;
    }
  }

  /** Read current document bytes. Display reads record a verifiable observation. Internal batch comparisons and Mark all read pass record:false and reference current bytes directly, avoiding two observation files per document. */
  async readDocument(docPath: string, options: { record?: boolean } = {}) {
    const info = await this.checkoutForRead();
    const configRead = info.isRepo ? await this.config() : { value: null };
    let readerId: string | null = null;
    try { readerId = normalizeReaderId(info.identity.email); } catch { readerId = null; }
    // Through the redaction (W-06c, §8): these are the document bytes of the plugin.
    const content = await readContent(this, docPath, { config: configRead.value, readerId });
    if (content.bytes.length > MAX_DOCUMENT) throw new ReviewError("too-large", `document larger than ${MAX_DOCUMENT} bytes: ${docPath}`);
    const sha = content.sha;
    // Not reviewed here (a file outside Git for the shared review, a file in Git for the local one): shown only.
    const outside = !this.reviews(content.fileClass);
    const state = !outside && info.isRepo && configRead.value ? await this.state(info) : null;
    const docId = state ? this.docIdOf(state, docPath) : null;
    const heads = state && docId ? state.documents.get(docId)!.headRevisions : [];
    // A file outside Git is shown only: no observation, nothing written for it (DR-14, until EP-048).
    if (options.record !== false && !outside) await this.observations.record({ sha, path: docPath, heads, bytes: content.bytes, rules: content.rules });
    const persisted = heads.find((revisionId) => state && revisionObject(state, revisionId)?.snapshot === sha) ?? null;
    return { path: docPath, docId, sha, size: content.size, text: content.text, head: info.head, branch: info.branch, revisionId: persisted, headRevisions: heads,
      format: content.format, fileClass: content.fileClass, rules: content.rules, secrets: content.secrets, personalText: content.personalText, parseError: content.parseError };
  }

  /**
   * Turn a shown observation into a persistent Revision (DR-03): its snapshot and Revision object are
   * published by the same operation before the event that references them. Draft context is untrusted:
   * accepted are only observations this host served (with the heads known at that moment), the current
   * bytes of the file, or — for a comment target — a persistent revision of the same document.
   */
  async promote(state: State, docPath: string, docId: string | null, observation: { sha: string; text?: string }, purpose: "target" | "receipt", reason: "baseline" | "reference" | "batch-input" | "batch-output" | "tracking-resumed" | "reconcile" = "reference") {
    const record = docId ? state.documents.get(docId) ?? null : null;
    // After a transfer (§9, F15) the side the data left is read-only for the document.
    // Shared: only while the file is still outside the index — once it is back in Git, the shared review goes on for
    // everyone (security review EP-048, finding 5); local: after its data moved to Git or were kept read-only.
    if (record?.transferred === (this.scope === "shared" ? "to-local" : "to-git") && (this.scope === "local" || (await this.fileClass(docPath)) !== "git")) {
      throw new ReviewError("transferred", this.scope === "shared" ? `the review data of ${docPath} moved to the local store: the shared data is read-only` : `the local data of ${docPath} moved to the shared review (or was kept read-only)`);
    }
    if (this.scope === "shared" && (await this.fileClass(docPath)) === "new" && (await this.keptLocally(docPath))) {
      throw new ReviewError("local", `the file has local review data of yours: it stays local until it is in the Git index: ${docPath}`);
    }
    if (!this.reviews(await this.fileClass(docPath))) {
      if (this.scope === "local") throw new ReviewError("not-local", `the file is not outside Git any more: its review is shared (.bb-docs): ${docPath}`);
      throw new ReviewError("outside-git", `the file is ignored by Git: it is shown only until you track it locally (${tr("“Track locally”", "«Отслеживать локально»")}): ${docPath}`);
    }
    const sameSnapshot = (ids: string[]) => ids.find((revisionId) => revisionObject(state, revisionId)?.snapshot === observation.sha) ?? null;
    let bytes: Uint8Array | null = null;
    let heads: string[] = [];
    let rules: string | null = null;
    const logged = await this.observations.getAt(observation.sha, docPath);
    if (logged) {
      bytes = logged.bytes;
      heads = logged.heads.filter((revisionId) => state.revisions.has(revisionId));
      rules = logged.rules ?? null;
    } else {
      const current = await readContent(this, docPath).catch(() => null);
      if (current && current.sha === observation.sha) {
        bytes = current.bytes;
        rules = current.rules;
        heads = record?.headRevisions ?? [];
      } else if (purpose === "target" && record) {
        // A comment on an older persistent revision of this document: its exact target already exists.
        const existing = sameSnapshot(record.revisions);
        if (existing) bytes = await this.store.read(layout.snapshot(observation.sha));
        if (existing) rules = (revisionObject(state, existing) as Revision | null)?.redacted?.rules ?? null;
        heads = existing ? [existing] : [];
      }
    }
    if (!bytes || sha256(bytes) !== observation.sha) throw new ReviewError("unverifiable", "the shown revision cannot be verified on this host; reopen the document");
    const text = decoder.decode(bytes);
    // W-06c (§8): only a redacted form under today's shared rules becomes shared data — an older observation (raw bytes
    // of 1.3.x, or masked under weaker rules) is refused, never published (security review EP-039-T06).
    {
      const fileClass = await this.fileClass(docPath);
      const config = (await this.config()).value;
      if (classify(docPath, text, sharedRules(config, docPath, fileClass), "shared").redacted !== text) throw new ReviewError("unverifiable", "the shown revision predates the current secret rules; reopen the document");
    }
    if (observation.text !== undefined && observation.text !== text) throw new ReviewError("tampered", "draft context does not match the shown revision");

    // The same bytes as a revision that was current when they were shown: that revision is what was seen.
    // An equal older revision is not reused for a receipt (A→B→A is a new observation, DR-02).
    // Also the revision an earlier action on this very observation created: same bytes, same parents.
    const sameParents = (revisionId: string) => {
      const object = revisionObject(state, revisionId);
      return object?.snapshot === observation.sha && [...object.parents].sort().join() === [...heads].sort().join();
    };
    const reusable = reason === "baseline" ? null : sameSnapshot(heads) ?? (record?.revisions.find(sameParents) ?? null);
    if (reusable) return { revision: revisionObject(state, reusable) as Revision, text, changes: [], objects: [], snapshots: [], bytes };
    const id = docId ?? newId();
    const parents = [];
    for (const parentId of [...heads].sort()) {
      const parent = revisionObject(state, parentId);
      const parentBytes = parent ? await this.store.read(layout.snapshot(parent.snapshot)) : null;
      if (!parent || !parentBytes) throw new ReviewError("incomplete", `revision ${parentId} or its snapshot is missing`);
      parents.push({ revision: parent as Revision, source: decoder.decode(parentBytes) });
    }
    const { revision } = buildRevision({ revisionId: newId(), docId: id, path: docPath, source: text, snapshot: observation.sha, parents, ...(rules ? { redacted: { rules } } : {}) });
    const changes: Operation["changes"] = [];
    if (!docId) changes.push({ type: "document.registered", docId: id, path: docPath });
    changes.push({ type: "document.observed", docId: id, revisionId: revision.revisionId, revision: sha256(canonicalBytes(revision)), reason });
    return { revision, text, changes, objects: [revision as ObjectValue], snapshots: [bytes], bytes };
  }

  /** A new file starts tracking only when a human opens it in the viewer. */
  async openDocument(docPath: string): Promise<void> {
    await this.serial(async () => {
      const config = await this.config();
      if (!config.value || config.readOnly || !this.insideRoots(config.value, docPath) || ignore().add(config.value.untracked).ignores(docPath)) return;
      const info = await this.checkoutForRead();
      try { normalizeReaderId(info.identity.email); } catch { return; }
      const currentState = await this.state(info);
      // Opening an existing/read-only document must remain a read, including incomplete/newer review data.
      const record = [...currentState.documents.values()].find((doc) => doc.path === docPath);
      if (currentState.repoReadOnly.length || (record && hasReadingBase(currentState, record.docId))) return;
      if (!this.reviews(await this.fileClass(docPath))) return;
      const { state, actor } = await this.writable({ head: info.head, branch: info.branch });
      const current = await this.readDocument(docPath);
      const promoted = await this.promote(state, docPath, record?.docId ?? null, { sha: current.sha }, "target", "baseline");
      await this.commitPromotion(state, actor, promoted);
    });
  }

  // ── commands ───────────────────────────────────────────────────────────

  async status() {
    const info = await this.checkout();
    const config = info.isRepo ? await this.config() : { value: null, sha: null, readOnly: false };
    const base = {
      root: this.root, isRepo: info.isRepo, head: info.head, branch: info.branch, isWorktree: info.isWorktree,
      identity: info.identity, readerId: (() => { try { return normalizeReaderId(info.identity.email); } catch { return null; } })(),
      enabled: config.value !== null, repoId: config.value?.repoId ?? null, roots: config.value?.roots ?? [],
    };
    if (!config.value) return { ...base, documents: 0, annotations: 0, openAnnotations: 0, conflicts: 0, incomplete: 0, readOnly: config.readOnly, size: await this.size(), uncommitted: 0, ignoredByGit: info.isRepo ? await isIgnored(this.root, ".bb-docs/config.json") : false };
    const state = await this.state(info);
    const annotations = [...state.byEntity.keys()].filter((key) => key.startsWith("annotation:"));
    const open = annotations.filter((key) => state.registers.get(`${key}#status`)?.value === "open").length;
    return {
      ...base,
      documents: [...state.documents.values()].filter((doc) => !doc.removed).length,
      annotations: annotations.length,
      openAnnotations: open,
      conflicts: state.conflicts.length,
      incomplete: state.incomplete.size,
      readOnly: config.readOnly || state.repoReadOnly.length > 0,
      size: await this.size(),
      uncommitted: await uncommittedReviewFiles(this.root),
      ignoredByGit: await isIgnored(this.root, ".bb-docs/config.json"),
      /** Schema versions declared by the journal's events (G3). */
      schemaVersions: versionsInUse(state),
    };
  }

  /** Size of .bb-docs by kind (G8: the volume is visible). */
  async size() {
    const result = { events: { files: 0, bytes: 0 }, objects: { files: 0, bytes: 0 }, snapshots: { files: 0, bytes: 0 } };
    for (const kind of ["events", "objects", "snapshots"] as const) {
      for (const file of await this.store.list(kind)) {
        result[kind].files++;
        result[kind].bytes += (await fs.stat(path.join(this.store.root, file))).size;
      }
    }
    return result;
  }

  /**
   * Retention (G5, G8): nothing referenced by any event is ever removed — snapshots and objects of active and archived
   * annotations, receipts and rounds stay forever. Only files no event references (left by an interrupted write before
   * its event) are listed, and removed with `apply`. A file that an event names is never touched.
   */
  async orphans(input: { apply?: boolean } = {}) {
    return this.serial(async () => {
      const data = await loadRepository(this.store);
      const referencedObjects = new Set<string>();
      const referencedSnapshots = new Set<string>();
      for (const operation of data.events.values()) for (const sha of operationReferences(operation).objects) referencedObjects.add(sha);
      for (const sha of referencedObjects) {
        const object = data.objects.get(sha);
        if (object) for (const snapshot of objectReferences(object).snapshots) referencedSnapshots.add(snapshot);
      }
      // A newer-minor event the plugin cannot parse may reference anything: keep everything then.
      if (data.opaque.size) return { objects: [], snapshots: [], removed: 0, skipped: "events of a newer schema version are present; nothing is collected" };
      const objects = [...data.objects.keys()].filter((sha) => !referencedObjects.has(sha)).sort();
      const snapshots = [...data.snapshots].filter((sha) => !referencedSnapshots.has(sha)).sort();
      let removed = 0;
      if (input.apply) {
        for (const sha of objects) { await fs.rm(path.join(this.store.root, layout.object(sha)), { force: true }); removed++; }
        for (const sha of snapshots) { await fs.rm(path.join(this.store.root, layout.snapshot(sha)), { force: true }); removed++; }
        this.invalidate();
      }
      return { objects, snapshots, removed, skipped: null };
    });
  }

  async validate(limit = 50): Promise<ValidateResult> {
    return validate(this.store, {
      limit,
      checkRevision: ({ revision, snapshot, parents }) => checkRevision({
        revision: revision as Revision, source: decoder.decode(snapshot),
        parents: parents.map((parent) => ({ revision: parent.revision as Revision, source: decoder.decode(parent.snapshot) })),
      }).problems,
    });
  }

  /** What enabling would do, before anything is written (A10, G7, G8). */
  async enablePlan(roots?: string[]) {
    const info = await this.checkout();
    if (!info.isRepo) throw new ReviewError("read-only", "folder without Git: reading only, no review (A11)");
    const existing = await this.config();
    const config: Config = existing.value ?? { schemaVersion: SCHEMA_VERSION, repoId: newId(), roots: roots?.length ? roots : ["."], hidden: [], untracked: [] };
    const rootsMissing: string[] = [];
    for (const root of config.roots) {
      if (root === ".") continue;
      try {
        await fs.lstat(await confine(this.root, root));
      } catch {
        rootsMissing.push(root);
      }
    }
    const tracked = rootsMissing.length === config.roots.length ? [] : await this.trackedDocuments(config);
    const documents = tracked.filter((doc) => doc.size <= BASE_MAX);
    const deferred = tracked.filter((doc) => doc.size > BASE_MAX).sort((a, b) => b.size - a.size);
    return {
      alreadyEnabled: existing.value !== null,
      storage: path.join(this.root, ".bb-docs"),
      roots: config.roots,
      rootsMissing,
      documents: documents.length,
      snapshotBytes: documents.reduce((sum, doc) => sum + doc.size, 0),
      deferred: { count: deferred.length, bytes: deferred.reduce((sum, doc) => sum + doc.size, 0), limit: BASE_MAX, largest: deferred.slice(0, 20).map((doc) => ({ path: doc.path, size: doc.size })) },
      ignoredByGit: await isIgnored(this.root, ".bb-docs/config.json"),
      markedGenerated: await generatedAttribute(this.root),
      identity: info.identity,
      head: info.head,
      branch: info.branch,
    };
  }

  /**
   * Enable review: config (CAS create) and the initial base of every tracked document (F1). With `limit` one call
   * registers at most that many documents and returns what remains (`enabled: false`): the server runs the steps in
   * the background, so no call holds the checkout's queue for minutes (a queued call past its deadline gets the
   * worker killed). The config is written by the step that registers the last document.
   */
  async enable(input: { roots?: string[]; markGenerated?: boolean; limit?: number; budgetMs?: number } & Expectation) {
    return this.serial(async () => {
      const info = await this.checkout();
      if (!info.isRepo) throw new ReviewError("read-only", "folder without Git: reading only, no review (A11)");
      if (input.head !== undefined && input.head !== info.head) throw new ReviewError("context-changed", "HEAD moved since the plan was shown");
      const existing = await this.config();
      if (existing.readOnly) throw new ReviewError("read-only", existing.problem ?? "config.json cannot be used for writing");
      if (existing.value) return { enabled: true, created: false, documents: 0, operations: 0, remaining: 0, total: 0 };
      try {
        normalizeReaderId(info.identity.email);
      } catch (error) {
        throw new ReviewError("no-identity", error instanceof Error ? error.message : String(error));
      }
      for (const root of input.roots ?? []) if (root !== ".") await confine(this.root, root);
      if (input.markGenerated) {
        // Refuse before anything is written: a symlinked or odd .gitattributes must not leave review half-enabled.
        const attributes = await confine(this.root, ".gitattributes");
        const stat = await fs.lstat(attributes).catch(() => null);
        if (stat && !stat.isFile()) throw new ReviewError("bad-path", ".gitattributes is not a regular file");
      }
      const config: Config = { schemaVersion: SCHEMA_VERSION, repoId: newId(), roots: input.roots?.length ? input.roots : ["."], hidden: [], untracked: [] };
      const parsed = parseConfig(config);
      if (!parsed.ok) throw new ReviewError("bad-input", parsed.issues.join("; "));
      const actor = { kind: "human" as const, name: info.identity.name ?? info.identity.email!, email: info.identity.email!.trim() };
      let operations = 0;
      let count = 0;
      // The initial base first, config last: an interrupted enable is finished by running it again, and
      // documents registered by the interrupted run are not registered twice.
      const registered = new Set([...(await this.state()).documents.values()].map((doc) => doc.path));
      const tracked = await this.trackedDocuments(config);
      const deferred = tracked.filter((doc) => doc.size > BASE_MAX).length;
      const unregistered = tracked.filter((doc) => doc.size <= BASE_MAX && !registered.has(doc.path));
      const documents = input.limit ? unregistered.slice(0, input.limit) : unregistered;
      const total = registered.size + unregistered.length;
      // A step also ends on its time budget (a slower machine registers fewer documents per step, never a longer step).
      const deadline = input.budgetMs ? Date.now() + input.budgetMs : Infinity;
      let overBudget = false;
      for (let index = 0; index < documents.length && !overBudget; index += 400) {
        const state = await this.state();
        const changes: Operation["changes"] = [];
        const objects: ObjectValue[] = [];
        const snapshots: Uint8Array[] = [];
        for (const doc of documents.slice(index, index + 400)) {
          if (count > 0 && Date.now() > deadline) { overBudget = true; break; }
          const content = await readContent(this, doc.path, { config });
          const bytes = content.bytes;
          const docId = newId();
          const { revision } = buildRevision({ revisionId: newId(), docId, path: doc.path, source: content.text, snapshot: content.sha, parents: [], ...(content.rules ? { redacted: { rules: content.rules } } : {}) });
          changes.push({ type: "document.registered", docId, path: doc.path });
          changes.push({ type: "document.observed", docId, revisionId: revision.revisionId, revision: sha256(canonicalBytes(revision)), reason: "baseline" });
          objects.push(revision as ObjectValue);
          snapshots.push(bytes);
          count++;
        }
        if (changes.length) {
          await this.commit(state, actor, changes, objects, snapshots);
          operations++;
        }
      }
      const remaining = unregistered.length - count;
      if (remaining > 0) return { enabled: false, created: false, documents: count, operations, remaining, total, deferred };
      if ((await writeConfig(this.store, canonicalBytes(config), null)) === "mismatch") throw new ReviewError("conflict", "config.json appeared concurrently; reload");
      if (input.markGenerated) await this.markGenerated();
      // The next tree and view read the new config at once, not after the file watch catches up.
      this.invalidate();
      return { enabled: true, created: true, documents: count, operations, remaining: 0, total, deferred };
    });
  }

  private async markGenerated() {
    // confine() refuses a symlinked .gitattributes; the new content replaces the file atomically.
    const file = await confine(this.root, ".gitattributes");
    const stat = await fs.lstat(file).catch(() => null);
    if (stat && !stat.isFile()) throw new ReviewError("bad-path", ".gitattributes is not a regular file");
    const current = stat ? await fs.readFile(file, "utf8") : "";
    if (/^\.bb-docs\/\*\* .*linguist-generated/m.test(current)) return;
    const line = ".bb-docs/** linguist-generated=true -diff\n";
    const temp = path.join(this.root, `.gitattributes.bb-docs-${newId()}`);
    await fs.writeFile(temp, current && !current.endsWith("\n") ? `${current}\n${line}` : `${current}${line}`, { flag: "wx" });
    await fs.rename(temp, file);
  }

  /**
   * Create an annotation on a shown revision; the revision is promoted first if needed (AC23, AC28 server part).
   * The target is named by kind (text range + quote, block, section heading, document, change of a block or of a
   * removed block); its range is computed here from the shown revision (EP-008-T04), never taken from the client.
   * A change of a removed block targets the last revision that still had the block: the old text stays the target.
   */
  async annotate(input: { path: string; observation: { sha: string; text?: string }; text: string; kind: "action" | "note";
    range?: { start: number; end: number }; quote?: string; targetKind?: "text" | "block" | "section" | "document" | "change"; block?: number; tombstoneId?: string;
    /** W-06f (EP-073-T08): an element of an embedded object inside the block — the visualizer's id and words. */
    element?: { id: string; kind: "node" | "edge" | "group" | "text" | "other"; label: string; range?: { line: number; start: number; end: number } } } & Expectation) {
    return this.serial(async () => {
      const { actor, state } = await this.writable(input);
      const config = (await this.config()).value!;
      if (!this.insideRoots(config, input.path)) throw new ReviewError("outside-roots", `not inside the review roots (${config.roots.join(", ")}): ${input.path}`);
      await this.refuseExcluded(config, input.path);
      const docId = this.docIdOf(state, input.path);
      const promoted = await this.promote(state, input.path, docId, input.observation, "target");
      const targetKind = input.targetKind ?? "text";
      let revision = promoted.revision;
      let projection = projectFile(input.path, promoted.text);
      let range: { start: number; end: number };
      let tombstoneId: string | undefined;
      if (targetKind === "change" && input.tombstoneId) {
        // The removed block lives in a parent of the revision that recorded its tombstone: that parent is the target.
        const found = await this.tombstoneTarget(state, promoted, input.tombstoneId);
        revision = found.revision;
        projection = found.projection;
        range = found.range;
        tombstoneId = input.tombstoneId;
      } else {
        const request = targetKind === "text"
          ? { kind: "text" as const, range: input.range ?? { start: 0, end: 0 }, quote: input.quote ?? "" }
          : targetKind === "document" ? { kind: "document" as const }
          : { kind: targetKind, block: input.block ?? -1 };
        const computed = targetRange(projection.blocks, [...projection.text].length, request);
        if (typeof computed === "string") throw new ReviewError("bad-input", computed);
        range = computed;
        if (targetKind === "text" && !verifyQuote(projection, range, input.quote ?? "")) throw new ReviewError("quote-mismatch", "the selected text does not match the shown revision");
      }
      const annotationId = newId();
      const quote = quoteAt(projection, range);
      // W-06c (§7): a target inside one node of a structured file keeps its key path; a target of a line-based file
      // (text, .env, CSV, a structured file that did not parse) keeps its lines of the raw source. Both need 1.2.
      const formatSelectors: ({ type: "bbdr:KeyPathSelector"; value: string } | { type: "bbdr:LineRangeSelector"; start: number; end: number }
        | { type: "bbdr:ObjectSelector"; id: string; kind: "node" | "edge" | "group" | "text" | "other"; label: string; range?: { line: number; start: number; end: number } })[] = [];
      let objectSelector = false;
      if (input.element && targetKind === "block" && input.block !== undefined) {
        const block = revision.blocks[input.block];
        if (!block || block.type !== "code") throw new ReviewError("bad-input", "an element belongs to a fenced block of the shown revision");
        const { id, kind, label, range: elementRange } = input.element;
        if (typeof id !== "string" || !id || id.length > 200) throw new ReviewError("bad-input", "bad element id");
        formatSelectors.push({ type: "bbdr:ObjectSelector", id, kind, label: String(label ?? "").slice(0, 400), ...(elementRange ? { range: elementRange } : {}) });
        objectSelector = true;
      }
      const fileProjection = projection as Partial<FileProjection> & typeof projection;
      if (fileProjection.format && fileProjection.format !== "markdown" && targetKind !== "document") {
        const touched = blockSegments(projection, range).map(({ block }) => block);
        const pathOf = (index: number) => fileProjection.meta?.[index]?.path;
        // The node of the target: the named block (block, section, change), or the one block a text selection lies in.
        const own = targetKind === "text" ? (touched.length === 1 ? touched[0] : null) : tombstoneId ? null : input.block ?? null;
        if (projection.profile === "bbdr-structured" && own !== null && pathOf(own)) formatSelectors.push({ type: "bbdr:KeyPathSelector", value: keyPathString(pathOf(own)!) });
        const sources = projectionToSource(projection, range);
        if (sources.length && projection.profile !== "bbdr-structured") {
          const lines = linesOf(projection, Math.min(...sources.map((entry) => entry.start)), Math.max(...sources.map((entry) => entry.end)));
          formatSelectors.push({ type: "bbdr:LineRangeSelector", start: lines.start, end: Math.max(lines.start, lines.end) });
        }
      }
      const segments = blockSegments(projection, range).map(({ block, range: part }) => ({ lineageId: revision.blocks[block].lineageId, versionId: revision.blocks[block].versionId, start: part.start, end: part.end }));
      if (targetKind !== "text" && targetKind !== "document" && range.start === range.end) {
        // A block without projected text (image, thematic break) is addressed by its lineage alone.
        const index = tombstoneId ? revision.blocks.findIndex((block) => block.range.start === range.start && block.range.end === range.end) : input.block ?? -1;
        const block = revision.blocks[index];
        if (block && !segments.length) segments.push({ lineageId: block.lineageId, versionId: block.versionId, start: range.start, end: range.end });
      }
      const annotation = {
        "@context": [CONTEXT[0], { bbdr: CONTEXT[1].bbdr }],
        type: "Annotation",
        id: `urn:bb-docs:${config.repoId}:annotation:${annotationId}`,
        created: new Date().toISOString(),
        creator: { type: "Person", name: actor.kind === "human" ? actor.name : "agent", email: `mailto:${actor.kind === "human" ? actor.email : ""}` },
        motivation: "commenting",
        body: { type: "TextualBody", value: input.text, format: "text/markdown" },
        target: {
          type: "SpecificResource",
          source: `urn:bb-docs:${config.repoId}:doc:${revision.docId}:rev:${revision.revisionId}:proj:${revision.projection.profile}/${revision.projection.version}`,
          selector: [
            { type: "TextQuoteSelector", exact: quote.exact, prefix: quote.prefix, suffix: quote.suffix },
            { type: "TextPositionSelector", start: range.start, end: range.end },
            ...formatSelectors,
          ],
          "bbdr:targetKind": targetKind,
          "bbdr:docId": revision.docId,
          "bbdr:revisionId": revision.revisionId,
          "bbdr:path": input.path,
          "bbdr:snapshot": revision.snapshot,
          "bbdr:segments": segments,
          "bbdr:sourceRanges": projectionToSource(projection, range),
          ...(tombstoneId ? { "bbdr:tombstoneId": tombstoneId } : {}),
        },
        "bbdr:schemaVersion": objectSelector ? "1.3" : formatSelectors.length ? "1.2" : SCHEMA_VERSION,
      } as ObjectValue;
      // G3 (found on the workstation, W-06f): a newer-minor operation is opaque to an older plugin as a whole, so the promotion of
      // the revision (plain 1.0/1.2) goes in its own operation first — the document stays visible there, only the
      // annotation to an element is read-only.
      const base = objectSelector && promoted.changes.length ? await this.commitPromotion(state, actor, promoted) : state;
      const changes: Operation["changes"] = [
        ...(base === state ? promoted.changes : []),
        { type: "annotation.created", annotationId, docId: revision.docId, annotation: sha256(canonicalBytes(annotation)), kind: input.kind, messageId: newId() },
      ];
      const { operation } = await this.commit(base, actor, changes, [...(base === state ? promoted.objects : []), annotation], base === state ? promoted.snapshots : []);
      return { annotationId, revisionId: revision.revisionId, promoted: promoted.changes.length > 0, eventId: operation.id, targetKind, range };
    });
  }

  /** The revision that last had a removed block, with its projection and the block's range (AC22 first part). */
  private async tombstoneTarget(state: State, promoted: { revision: Revision }, tombstoneId: string) {
    const history = [promoted.revision.revisionId, ...revisionHistory(state, promoted.revision.revisionId)];
    for (const id of history) {
      const holder = id === promoted.revision.revisionId ? promoted.revision : (revisionObject(state, id) as Revision | null);
      const tombstone = holder?.removed.find((entry) => entry.tombstoneId === tombstoneId);
      if (!holder || !tombstone) continue;
      for (const parentId of holder.parents) {
        const parent = revisionObject(state, parentId) as Revision | null;
        const index = parent?.blocks.findIndex((block) => block.lineageId === tombstone.lineageId) ?? -1;
        if (!parent || index < 0) continue;
        const bytes = await this.store.read(layout.snapshot(parent.snapshot));
        if (!bytes) throw new ReviewError("incomplete", `snapshot of revision ${parent.revisionId} is missing`);
        return { revision: parent, projection: projectFile(parent.path, decoder.decode(bytes)), range: parent.blocks[index].range };
      }
    }
    throw new ReviewError("bad-input", "the removed block is not part of the shown revision's history");
  }

  /**
   * «Mark read» for blocks of a shown revision (DR-02): confirms exactly the shown versions, never refuses
   * because the file changed meanwhile; reports how many confirmed blocks changed since.
   */
  async acknowledge(input: { path: string; observation: { sha: string; text?: string }; blocks?: number[]; heading?: number; tombstones?: string[]; scope: "block" | "section" | "document"; receiptId?: string } & Expectation) {
    return this.serial(async () => {
      const { readerId, actor, state } = await this.writable(input);
      const config = (await this.config()).value!;
      if (!this.insideRoots(config, input.path)) throw new ReviewError("outside-roots", `not inside the review roots (${config.roots.join(", ")}): ${input.path}`);
      await this.refuseExcluded(config, input.path);
      // A client retry with the same receipt id: answer with the existing receipt instead of a silent no-op.
      if (input.receiptId) {
        const readerEvents = (state.byEntity.get(entity.reader(readerId)) ?? []).map((eventId) => ({ eventId, changes: state.events.get(eventId)!.changes }));
        if (readerEvents.some(({ changes }) => changes.some((change) => change.type === "read.revoked" && change.receiptId === input.receiptId))) {
          throw new ReviewError("bad-input", "this receipt id was revoked; use a new one");
        }
        for (const { eventId, changes } of readerEvents) {
          for (const change of changes) {
            if (change.type === "read.acknowledged" && change.receiptId === input.receiptId) {
              return { receiptId: input.receiptId, revisionId: change.revisionId, eventId, status: "duplicate" as const, confirmed: change.versions.length, staleBlocks: 0 };
            }
          }
        }
      }
      const docId = this.docIdOf(state, input.path);
      const promoted = await this.promote(state, input.path, docId, input.observation, "receipt");
      const revision = promoted.revision;
      // A section is computed here from the shown revision (heading and nested sections), not taken from the client.
      const chosen = input.scope === "section" && input.heading !== undefined ? sectionBlocks(revision.blocks, input.heading)
        : input.blocks ?? (input.scope === "document" ? revision.blocks.map((_, index) => index) : []);
      if (input.scope === "section" && input.heading !== undefined && !chosen.length) throw new ReviewError("bad-input", "not a heading of the shown revision");
      if (chosen.some((index) => !Number.isInteger(index) || index < 0 || index >= revision.blocks.length)) throw new ReviewError("bad-input", "block index outside the shown revision");
      const versions = chosen.map((index) => ({ lineageId: revision.blocks[index].lineageId, versionId: revision.blocks[index].versionId }));
      // Document scope confirms every deletion shown in the history; a block action can confirm named deletions.
      const shownTombstones = new Set<string>();
      for (const id of [revision.revisionId, ...revisionHistory(state, revision.revisionId)]) {
        const holder = id === revision.revisionId ? revision : revisionObject(state, id);
        for (const tombstone of holder?.removed ?? []) shownTombstones.add(tombstone.tombstoneId);
      }
      if ((input.tombstones ?? []).some((id) => !shownTombstones.has(id))) throw new ReviewError("bad-input", "a confirmed deletion is not part of the shown revision");
      const tombstones = input.scope === "document" ? [...shownTombstones].sort() : [...new Set(input.tombstones ?? [])].sort();
      if (!versions.length && !tombstones.length) throw new ReviewError("bad-input", "nothing to confirm");
      // The shown revision must exist in this checkout's history once this operation lands.
      if (!promoted.changes.length) {
        const check = checkReceipt(state, { revisionId: revision.revisionId, versions, tombstones, currentRevisionId: null });
        if (!check.ok) throw new ReviewError(check.reason, check.message);
      }
      const receiptId = input.receiptId ?? newId();
      const changes: Operation["changes"] = [...promoted.changes, { type: "read.acknowledged", receiptId, readerId, docId: revision.docId, revisionId: revision.revisionId, scope: input.scope, versions, tombstones }];
      const { operation, result } = await this.commit(state, actor, changes, promoted.objects, promoted.snapshots);
      // How many confirmed blocks already differ on disk: they stay unread, the UI names the number.
      const current = await this.readDocument(input.path).catch(() => null);
      let staleBlocks = 0;
      if (current && current.sha !== revision.snapshot) {
        const { revision: onDisk } = buildRevision({ revisionId: newId(), docId: revision.docId, path: input.path, source: current.text, snapshot: current.sha, parents: [{ revision, source: promoted.text }] });
        const now = new Map(onDisk.blocks.map((block) => [block.lineageId, block.versionId]));
        staleBlocks = versions.filter((ref) => now.get(ref.lineageId) !== ref.versionId).length;
      }
      return { receiptId, revisionId: revision.revisionId, eventId: operation.id, status: result.status, confirmed: versions.length, staleBlocks };
    });
  }

  /**
   * W-06f (1.3): pin or unpin nodes of this reader's layout of one Mermaid block of the shown revision — one finished
   * gesture, one operation. The layout entity is per reader, document and block lineage; a write by the reader settles
   * a conflict of the nodes it names (it descends from every concurrent value). Answers with an exact read-back.
   */
  async layout(input: { path: string; observation: { sha: string; text?: string }; block: number; pins?: { id: string; x: number; y: number }[]; unpin?: string[];
    /** `<pluginId>@<version>/<engine>` of the visualizer that laid the object out (contract «engine»). */
    engine?: string } & Expectation) {
    return this.serial(async () => {
      const { readerId, actor, state } = await this.writable(input);
      const config = (await this.config()).value!;
      if (!this.insideRoots(config, input.path)) throw new ReviewError("outside-roots", `not inside the review roots (${config.roots.join(", ")}): ${input.path}`);
      await this.refuseExcluded(config, input.path);
      const pins = input.pins ?? [];
      const unpin = [...new Set(input.unpin ?? [])].filter((id) => !pins.some((pin) => pin.id === id));
      if (!pins.length && !unpin.length) throw new ReviewError("bad-input", "nothing to change in the layout");
      const engine = typeof input.engine === "string" ? input.engine.trim() : "";
      if (pins.length && (!engine || engine.length > 64)) throw new ReviewError("bad-input", "the visualizer's engine id is required with pins (1..64 chars)");
      const docId = this.docIdOf(state, input.path);
      const promoted = await this.promote(state, input.path, docId, input.observation, "receipt");
      const revision = promoted.revision;
      const block = revision.blocks[input.block];
      if (!block || block.type !== "code") throw new ReviewError("bad-input", "not a diagram block of the shown revision");
      const scope = { doc: revision.docId, lineage: block.lineageId, reader: readerId };
      // G3: the promotion of the revision goes first in its own (1.0/1.2) operation; the 1.3 layout write follows.
      const base = promoted.changes.length ? await this.commitPromotion(state, actor, promoted) : state;
      const changes: Operation["changes"] = [];
      if (pins.length) changes.push({ type: "layout.pinned", scope, revisionId: revision.revisionId, engine, nodes: pins.map((pin) => ({ id: pin.id, x: Math.round(pin.x), y: Math.round(pin.y) })) });
      if (unpin.length) changes.push({ type: "layout.unpinned", scope, revisionId: revision.revisionId, nodes: unpin });
      const { operation, result } = await this.commit(base, actor, changes, [], [], [], true);
      const fresh = layoutOf(await this.state(await this.checkout()), scope);
      const conflicted = new Set(fresh.conflicts.map((conflict) => conflict.node));
      const lost = pins.filter((pin) => !conflicted.has(pin.id) && (fresh.pins[pin.id]?.x !== Math.round(pin.x) || fresh.pins[pin.id]?.y !== Math.round(pin.y)))
        .concat(unpin.filter((id) => !conflicted.has(id) && fresh.pins[id]).map((id) => ({ id, x: 0, y: 0 })));
      if (lost.length) throw new ReviewError("not-saved", `the layout was written but reads back differently for ${lost.map((pin) => pin.id).join(", ")}`);
      return { eventId: operation.id, status: result.status, block: input.block, pins: fresh.pins, conflicts: fresh.conflicts };
    });
  }

  /** Append a human reply; concurrent replies are both kept (AC10). */
  async reply(input: { annotationId: string; text: string; reopen?: boolean } & Expectation) {
    return this.serial(async () => {
      const { actor, state } = await this.writable(input);
      const view = discussion(state, input.annotationId);
      const changes: Operation["changes"] = [];
      if (input.reopen && view.status === "closed") changes.push({ type: "discussion.reopened", annotationId: input.annotationId });
      else {
        const check = checkTransition(view, { type: "append", role: "human" });
        if (!check.ok) throw new ReviewError("transition", check.reason);
      }
      const messageId = newId();
      changes.push({ type: "message.appended", annotationId: input.annotationId, messageId, text: input.text });
      const { operation } = await this.commit(state, actor, changes, [], []);
      return { messageId, eventId: operation.id };
    });
  }

  /**
   * Change status or kind. A decision is taken on what was shown: if the annotation moved on (new heads),
   * the decision is refused as stale instead of silently closing a newer question (DR-04 «Accept»).
   */
  async decide(input: { annotationId: string; action: "close" | "reopen" | "withdraw" | "restore" | "note" | "action"; expectedHeads: string[] } & Expectation) {
    return this.serial(async () => {
      const { actor, state } = await this.writable(input);
      const heads = state.heads.get(entity.annotation(input.annotationId)) ?? [];
      if ([...heads].sort().join() !== [...input.expectedHeads].sort().join()) {
        throw new ReviewError("stale", "the annotation changed since it was shown; review it again", { heads });
      }
      const view = discussion(state, input.annotationId);
      const transition = input.action === "note" || input.action === "action" ? { type: "change-kind" as const, kind: input.action } : { type: input.action };
      const check = checkTransition(view, transition);
      if (!check.ok) throw new ReviewError("transition", check.reason);
      const change: Operation["changes"][number] = input.action === "close" ? { type: "discussion.closed", annotationId: input.annotationId }
        : input.action === "reopen" ? { type: "discussion.reopened", annotationId: input.annotationId }
        : input.action === "withdraw" ? { type: "annotation.withdrawn", annotationId: input.annotationId }
        : input.action === "restore" ? { type: "annotation.restored", annotationId: input.annotationId }
        : { type: "annotation.kind-changed", annotationId: input.annotationId, kind: input.action };
      const { operation } = await this.commit(state, actor, [change], [], []);
      return { eventId: operation.id };
    });
  }

  /**
   * «Accept current state» for a new reader (F1, AC17) and «All read» of the whole checkout (F7): one receipt
   * (scope repo) per tracked document inside the roots that has unread changes for this reader, confirming exactly the
   * shown current revision — its blocks and the deletions of its history. Undone as a whole by revokeMany.
   */
  async acknowledgeAll(input: { expectedDocuments?: number } & Expectation) {
    return this.serial(async () => {
      const { readerId, actor, state } = await this.writable(input);
      const config = (await this.config()).value!;
      const docs = (await this.trackedDocuments(config)).filter((doc) => this.insideRoots(config, doc.path));
      const pending: { path: string; docId: string | null; sha: string }[] = [];
      for (const doc of docs) {
        const docId = this.docIdOf(state, doc.path);
        if (docId && state.incomplete.has(entity.doc(docId))) continue;
        const status = docId ? await this.readStatus(doc.path, { record: false }).catch(() => null) : null;
        if (docId && (!status || !status.tracked || status.unread === 0)) continue;
        const current = await this.readDocument(doc.path, { record: false }).catch(() => null);
        if (current) pending.push({ path: doc.path, docId, sha: current.sha });
      }
      // Deleted documents whose deletion this reader has not acknowledged (EP-014-T05).
      const deletions: { docId: string; revisionId: string }[] = [];
      for (const record of state.documents.values()) {
        if (!record.path || !this.insideRoots(config, record.path) || record.conflict || !record.headRevisions.length) continue;
        const onDisk = await this.documentFile(record.path).then(() => true, () => false);
        if (onDisk || removalState(state, readerId, record.docId) !== "unread") continue;
        deletions.push({ docId: record.docId, revisionId: record.headRevisions[record.headRevisions.length - 1] });
      }
      if (input.expectedDocuments !== undefined && input.expectedDocuments !== pending.length + deletions.length) {
        throw new ReviewError("stale", `the number of documents with unread changes changed (${pending.length} now, ${input.expectedDocuments} shown); review it again`, { documents: pending.length });
      }
      const receipts: string[] = [];
      const events: string[] = [];
      if (deletions.length) {
        const changes: Operation["changes"] = deletions.map((entry) => {
          const receiptId = newId();
          receipts.push(receiptId);
          return { type: "read.acknowledged" as const, receiptId, readerId, docId: entry.docId, revisionId: entry.revisionId, scope: "removal" as const, versions: [], tombstones: [] };
        });
        events.push((await this.commit(state, actor, changes, [], [])).operation.id);
      }
      for (let index = 0; index < pending.length; index += 100) {
        const current = index === 0 && !deletions.length ? state : await this.state();
        const changes: Operation["changes"] = [];
        const objects: ObjectValue[] = [];
        const snapshots: Uint8Array[] = [];
        for (const doc of pending.slice(index, index + 100)) {
          const promoted = await this.promote(current, doc.path, doc.docId, { sha: doc.sha }, "receipt");
          const revision = promoted.revision;
          const tombstones = new Set<string>();
          for (const id of [revision.revisionId, ...revisionHistory(current, revision.revisionId)]) {
            const holder = id === revision.revisionId ? revision : revisionObject(current, id);
            for (const tombstone of holder?.removed ?? []) tombstones.add(tombstone.tombstoneId);
          }
          const receiptId = newId();
          receipts.push(receiptId);
          changes.push(...promoted.changes, { type: "read.acknowledged", receiptId, readerId, docId: revision.docId, revisionId: revision.revisionId, scope: "repo",
            versions: revision.blocks.map((block) => ({ lineageId: block.lineageId, versionId: block.versionId })), tombstones: [...tombstones].sort() });
          objects.push(...promoted.objects);
          snapshots.push(...promoted.snapshots);
        }
        const { operation } = await this.commit(current, actor, changes, objects, snapshots);
        events.push(operation.id);
      }
      return { documents: pending.length + deletions.length, receipts, events, paths: pending.map((doc) => doc.path), deletions: deletions.length };
    });
  }

  /** Undo of «All read»: revokes the named receipts of this reader in one operation (DR-02, addressed). */
  async revokeMany(input: { receiptIds: string[] } & Expectation) {
    return this.serial(async () => {
      const { readerId, actor, state } = await this.writable(input);
      const own = (state.byEntity.get(entity.reader(readerId)) ?? []).flatMap((eventId) => state.events.get(eventId)!.changes);
      const mine = new Set(own.flatMap((change) => (change.type === "read.acknowledged" ? [change.receiptId] : [])));
      const revoked = new Set(own.flatMap((change) => (change.type === "read.revoked" ? [change.receiptId] : [])));
      const ids = [...new Set(input.receiptIds)].filter((id) => mine.has(id) && !revoked.has(id));
      if (!ids.length) return { revoked: 0 };
      const { operation } = await this.commit(state, actor, ids.map((receiptId) => ({ type: "read.revoked" as const, receiptId, readerId })), [], []);
      return { revoked: ids.length, eventId: operation.id };
    });
  }

  /** «Undo» of a «Mark read»: revokes exactly that receipt of this reader (DR-02), nothing else. */
  async revoke(input: { receiptId: string } & Expectation) {
    return this.serial(async () => {
      const { readerId, actor, state } = await this.writable(input);
      const own = (state.byEntity.get(entity.reader(readerId)) ?? []).flatMap((eventId) => state.events.get(eventId)!.changes);
      if (!own.some((change) => change.type === "read.acknowledged" && change.receiptId === input.receiptId)) throw new ReviewError("bad-input", "no such receipt of this reader");
      if (own.some((change) => change.type === "read.revoked" && change.receiptId === input.receiptId)) return { receiptId: input.receiptId, status: "duplicate" as const };
      const { operation } = await this.commit(state, actor, [{ type: "read.revoked", receiptId: input.receiptId, readerId }], [], []);
      return { receiptId: input.receiptId, eventId: operation.id, status: "published" as const };
    });
  }

  /**
   * Edit a human message: a new revision of it. Before the annotation was ever sent this is a free edit; after,
   * it is a new instruction for the next batch (C6); the earlier text stays in the history.
   */
  async revise(input: { annotationId: string; messageId: string; text: string } & Expectation) {
    return this.serial(async () => {
      const { actor, state } = await this.writable(input);
      const view = discussion(state, input.annotationId);
      const check = checkTransition(view, { type: "revise", messageId: input.messageId, role: "human" });
      if (!check.ok) throw new ReviewError("transition", check.reason);
      if (view.messages.find((message) => message.messageId === input.messageId)?.current?.text === input.text) return { status: "unchanged" as const };
      const { operation } = await this.commit(state, actor, [{ type: "message.revised", annotationId: input.annotationId, messageId: input.messageId, text: input.text }], [], []);
      return { status: "published" as const, eventId: operation.id };
    });
  }

  /**
   * Resolve a conflict after a Git merge by an explicit choice (G4): the user picks one of the concurrent values;
   * the conflicting events become ancestors of the resolution. Nothing is resolved automatically.
   */
  async resolveConflict(input: { annotationId: string; register: string; value: string } & Expectation) {
    return this.serial(async () => {
      const { actor, state } = await this.writable(input);
      const conflict = state.conflicts.find((entry) => entry.entity === entity.annotation(input.annotationId) && entry.register === input.register);
      if (!conflict) throw new ReviewError("stale", "no such conflict any more; reload");
      const register = input.register.replace(/^.*#/, "");
      const field = register === "status" ? "status" : register === "kind" ? "kind" : register.startsWith("message:") ? "message" : null;
      if (!field) throw new ReviewError("bad-input", "unknown register");
      if (!conflict.candidates.some((candidate) => candidate.value === input.value)) throw new ReviewError("bad-input", "the value is not one of the conflicting values");
      const messageId = field === "message" ? register.slice("message:".length) : undefined;
      const resolves = [...new Set(conflict.candidates.map((candidate) => candidate.eventId))].sort();
      const { operation } = await this.commit(state, actor, [{ type: "conflict.resolved", annotationId: input.annotationId, field, ...(messageId ? { messageId } : {}), value: input.value, resolves }], [], [], resolves, true);
      return { eventId: operation.id };
    });
  }

  /** «Retry processing»: instructions already answered become candidates again (DR-04). */
  async retry(input: { annotationId: string; expectedHeads: string[] } & Expectation) {
    return this.serial(async () => {
      const { actor, state } = await this.writable(input);
      const heads = state.heads.get(entity.annotation(input.annotationId)) ?? [];
      if ([...heads].sort().join() !== [...input.expectedHeads].sort().join()) throw new ReviewError("stale", "the annotation changed since it was shown; review it again", { heads });
      const check = checkTransition(discussion(state, input.annotationId), { type: "retry" });
      if (!check.ok) throw new ReviewError("transition", check.reason);
      const { operation } = await this.commit(state, actor, [{ type: "discussion.retry-requested", annotationId: input.annotationId }], [], []);
      return { eventId: operation.id };
    });
  }

  /** Read state of the current file for this checkout's reader. */
  async readStatus(docPath: string, options: { record?: boolean } = {}) {
    const info = await this.checkout();
    let readerId: string;
    try {
      readerId = normalizeReaderId(info.identity.email);
    } catch (error) {
      throw new ReviewError("no-identity", error instanceof Error ? error.message : String(error));
    }
    const state = await this.state(info);
    const docId = this.docIdOf(state, docPath);
    if (!docId) return { path: docPath, tracked: false as const };
    if (state.incomplete.has(entity.doc(docId))) throw new ReviewError("incomplete", state.incomplete.get(entity.doc(docId))![0]);
    const heads = state.documents.get(docId)!.headRevisions;
    const current = await this.readDocument(docPath, options);
    let revision = current.revisionId ? (revisionObject(state, current.revisionId) as Revision) : null;
    let ephemeral = false;
    if (!revision) {
      // Not persistent yet: an in-memory revision for display; nothing is written (G8).
      const parents = [];
      for (const id of heads) {
        const parent = revisionObject(state, id);
        const parentBytes = parent ? await this.store.read(layout.snapshot(parent.snapshot)) : null;
        if (!parent || !parentBytes) throw new ReviewError("incomplete", `revision ${id} or its snapshot is missing`);
        parents.push({ revision: parent as Revision, source: decoder.decode(parentBytes) });
      }
      revision = buildRevision({ revisionId: newId(), docId, path: docPath, source: current.text, snapshot: current.sha, parents }).revision;
      ephemeral = true;
    }
    if (ephemeral) {
      // Read state of an observation: lineages and versions inherited from the persistent heads.
      const fake = { ...state, revisions: new Map(state.revisions), objects: new Map(state.objects) };
      const sha = sha256(canonicalBytes(revision));
      fake.objects.set(sha, revision as ObjectValue);
      fake.revisions.set(revision.revisionId, { revisionId: revision.revisionId, docId, eventId: "ephemeral", objectSha: sha, reason: "observed" });
      return { path: docPath, tracked: true as const, ephemeral, ...readState(fake as State, readerId, revision.revisionId) };
    }
    return { path: docPath, tracked: true as const, ephemeral, ...readState(state, readerId, revision.revisionId) };
  }
}

const services = new Map<string, ReviewService>();

/** One service per canonical checkout path on this host (DR-01 coordination key: host + canonical path). */
/**
 * W-06c upgrade: caches written by 1.3.x hold raw bytes of every shown document (observations/) and parse trees of their
 * text (chunks/) — including secrets of Markdown and text files. They are caches: removed once per data directory.
 */
const purged = new Set<string>();
async function purgeLegacyCaches(dataDir: string): Promise<void> {
  if (purged.has(dataDir)) return;
  purged.add(dataDir);
  const marker = path.join(dataDir, ".w06c-redaction");
  if (await fs.stat(marker).catch(() => null)) return;
  await fs.rm(path.join(dataDir, "observations"), { recursive: true, force: true });
  await fs.rm(path.join(dataDir, "chunks"), { recursive: true, force: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(marker, "observations/ and chunks/ of 1.3.x removed: since 1.4 they hold only redacted text\n");
}

export async function serviceFor(directory: string, dataDir: string): Promise<ReviewService> {
  await purgeLegacyCaches(dataDir).catch(() => undefined);
  const info = await resolveCheckout(directory);
  let service = services.get(info.root);
  if (!service) {
    service = new ReviewService(info.root, dataDir);
    services.set(info.root, service);
  }
  return service;
}

export function allServices(): ReviewService[] {
  return [...services.values()];
}

export { StoreError };
