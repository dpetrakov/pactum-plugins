// Tree of the review roots on the host of the checkout (EP-011-T01…T04; W-06a): every Markdown document of all roots
// once — other files, symlinks and directories without Markdown are filtered here, on the host, and only counted
// (EP-027-T07: the reader asked for supported files only), service directories skipped, hidden/untracked decisions with the
// pattern they come from, per-document signals (unread, annotations waiting, new instructions) and documents that
// are gone from disk (virtual entries) or moved (rename proposals). Read-only except the unambiguous rename, which
// is written as document.moved by the checkout's own identity (reconcileMoves).
import fs from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import { waitsForUser } from "../core/batch.ts";
import { discussion } from "../core/discussion.ts";
import { sha256 } from "../core/hash.ts";
import { entity, revisionObject, type State } from "../core/journal.ts";
import { buildRevision } from "../core/markdown/index.ts";
import { projectFile } from "../core/formats/project.ts";
import { readContent } from "./content.ts";
import { isKnownReader, normalizeReaderId, readState, removalState } from "../core/reading.ts";
import { decide, inheritedFrom } from "../core/rules.ts";
import { type Config, isRepoPath } from "../core/schema.ts";
import type { Revision } from "../core/types.ts";
import { confine, git } from "./checkout.ts";
import { ReviewError, type ReviewService } from "./service.ts";
import { exclusionsFor, type NotShown, suggestRoots, walkRoots } from "./walk.ts";
import { FORMATS, type FormatId } from "../core/formats/registry.ts";
import type { FileClass } from "./content.ts";
import { currentBuilt, persistentBuilt, withEphemeral } from "./view.ts";

const MAX_DOCUMENT = 8 * 1024 * 1024;

export type DocState = "read" | "unread" | "new" | "changed" | "untracked" | null;

export interface TreeEntry {
  path: string;
  /** EP-048-T08: the file's Git status changed and its review data may move (to the shared review or the local store). */
  transfer?: "to-git" | "to-local";
  /** EP-048: a file outside Git tracked locally — its state comes from this reader's local review. */
  local?: boolean;
  kind: "file" | "symlink";
  size: number;
  /** A file of the format registry (W-06c): it can be opened and reviewed (outside Git — shown only). */
  supported: boolean;
  /** W-06c: format and type group of the file (icon, filter), and its Git class (§4). */
  format: FormatId;
  group: string;
  fileClass: FileClass;
  /** Why a symlink is not followed (A8). */
  note: string | null;
  hidden: boolean;
  hiddenFrom: string | null;
  untracked: boolean;
  untrackedFrom: string | null;
  docId: string | null;
  /** read / unread (with count) / new (appeared after enabling) / changed (not counted yet) / untracked. */
  state: DocState;
  unread: number | null;
  open: number;
  waiting: number;
  candidates: number;
  /** Branches disagree about this document's path or presence (EP-014-T02). */
  conflict: boolean;
}

export interface VirtualEntry {
  /** EP-048: a tracked local file that is gone (data kept in the local store). */
  local?: boolean;
  path: string;
  docId: string;
  /** removed: deletion acknowledged (document.removed) but annotations remain; missing: gone, not acknowledged. */
  reason: "missing" | "removed";
  open: number;
  waiting: number;
  candidates: number;
  hidden: boolean;
  conflict: boolean;
  /** This reader has not acknowledged the deletion yet (per reader, EP-014-T05). */
  deletionUnread: boolean;
}

export interface MoveProposal {
  /** Local review rename proposal for a tracked file. */
  local?: boolean;
  docId: string;
  from: string;
  open: number;
  candidates: { path: string; exact: boolean; git: boolean; similarity: number }[];
}

export interface TreeResult {
  /** EP-048: this reader's local tracking rules (files and folders outside Git), when any. */
  localRules?: { roots: string[]; untracked: string[] };
  enabled: boolean;
  isRepo: boolean;
  roots: string[];
  missingRoots: string[];
  /** Existing directories with Markdown, offered when the default docs/ is missing (A1). */
  suggestions: string[];
  entries: TreeEntry[];
  virtual: VirtualEntry[];
  moves: { applied: { docId: string; from: string; to: string }[]; proposals: MoveProposal[] };
  /** Service directories found inside the roots and skipped (A3): «.git», «.bb-docs», «node_modules». */
  excluded: string[];
  /** Not shown (W-06a): files of other formats and symlinks inside the roots — counted, never listed. */
  skipped: { other: number; symlinks: number };
  /** W-06c: what is not shown and why — exclusion rules with their level, file types, symlinks (§4). */
  notShown: NotShown;
  /** The walk stopped at the time budget: the tree is partial (§14). */
  partial: boolean;
  truncated: number;
  /** Documents whose unread count was not computed within the time budget (shown as «changed»). */
  pending: number;
  totals: { waiting: number; candidates: number; unreadDocs: number; unread: number; changedDocs: number; open: number };
  computeMs: number;
  /** Where the time went (walk, state, read, unread, rest), ms: measurements (bb document-review perf). */
  phases: Record<string, number>;
  head: string | null;
  branch: string | null;
  hiddenRules: string[];
  untrackedRules: string[];
  /** The checkout's reader (Git email); `known` is false until the first receipt — a new reader is offered to accept the current state (F1, AC17). */
  reader: { id: string | null; known: boolean };
  writable: boolean;
}

/** Built revisions of current bytes per (sha, heads): the expensive part of an unread count; content-addressed. */
const builtCache = new Map<string, Revision>();
/** Forget built revisions (a cold host in measurements). */
export function clearTreeCaches(): void {
  builtCache.clear();
  headingCache.clear();
}
function cacheBuilt(key: string, revision: Revision) {
  builtCache.set(key, revision);
  if (builtCache.size > 4000) builtCache.delete(builtCache.keys().next().value!);
}

/** Read and hash many files with bounded parallelism — through the redaction (W-06c, §8). */
async function readAll(service: ReviewService, list: string[]): Promise<Map<string, { sha: string; text: string; rules: string | null } | null>> {
  const result = new Map<string, { sha: string; text: string; rules: string | null } | null>();
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const file = list[next++];
      const content = await readContent(service, file).catch(() => null);
      result.set(file, content ? { sha: content.sha, text: content.text, rules: content.rules } : null);
    }
  };
  await Promise.all(Array.from({ length: Math.min(32, list.length) }, worker));
  return result;
}

/** Annotation counts per docId: open, waiting for the user (an agent answer without a decision), new instructions. */
export function annotationCounts(state: State): Map<string, { open: number; waiting: number; candidates: number }> {
  const counts = new Map<string, { open: number; waiting: number; candidates: number }>();
  for (const key of state.byEntity.keys()) {
    if (!key.startsWith("annotation:")) continue;
    const view = discussion(state, key.slice("annotation:".length));
    if (!view.docId) continue;
    const entry = counts.get(view.docId) ?? { open: 0, waiting: 0, candidates: 0 };
    if (view.status === "open") entry.open++;
    if (waitsForUser(view)) entry.waiting++;
    if (view.candidate) entry.candidates++;
    counts.set(view.docId, entry);
  }
  return counts;
}

/** Renames Git already knows (staged): `R old -> new`. Only a hint; the content decides together with it. */
async function gitRenames(root: string): Promise<Map<string, string>> {
  const result = await git(root, ["status", "--porcelain=v1", "-M", "--untracked-files=no"], { allowFailure: true, timeoutMs: 10_000 });
  const renames = new Map<string, string>();
  if (result.code !== 0) return renames;
  for (const line of result.stdout.split("\n")) {
    const match = /^R. (.+) -> (.+)$/.exec(line);
    if (match) renames.set(match[1].replace(/^"|"$/g, ""), match[2].replace(/^"|"$/g, ""));
  }
  return renames;
}

function blockHashes(revision: Revision): Set<string> {
  return new Set(revision.blocks.map((block) => block.textHash));
}

/**
 * The last complete tree per service (W-06a): returned again while the Markdown files (path, size, mtime), the journal,
 * config.json, HEAD and the reader are the same — the viewer polls the tree every 15 s and on focus. A tree with
 * uncounted documents (budget ran out) is never reused, so the next call continues the count.
 */
const treeResults = new WeakMap<ReviewService, { key: string; result: TreeResult }>();

/**
 * The tree of a checkout (W-06c): the shared review's tree, and over it this reader's local review (EP-048) — files
 * outside Git tracked locally get their review state from the local journal, gone tracked files their virtual entries.
 */
export async function documentTree(service: ReviewService, input: { roots?: string[]; budgetMs?: number } = {}): Promise<TreeResult> {
  const tree = await buildTree(service, input);
  if (service.scope !== "shared" || !tree.isRepo) return tree;
  const { localFor, localConfig } = await import("./local.ts");
  const local = await localFor(service).catch(() => null);
  const config = local ? await localConfig(local).catch(() => null) : null;
  // Git → local (§9, F15): a file with shared review data that is now ignored and not in the index. Never while Git's
  // listing fails (every file would look «outside Git» then — security review, finding 4).
  const gitKnown = !(await service.fileClasses()).failed;
  const sharedState = tree.enabled && gitKnown ? await service.state().catch(() => null) : null;
  const toLocal = new Set<string>();
  if (sharedState) {
    for (const record of sharedState.documents.values()) {
      if (!record.path || record.removed || record.transferred === "to-local") continue;
      const entry = tree.entries.find((item) => item.path === record.path);
      if (entry?.fileClass === "outside" && record.revisions.length > 1) toLocal.add(record.path);
      else if (entry?.fileClass === "outside" && [...sharedState.events.values()].some((operation) => operation.changes.some((change) => change.type === "annotation.created" && change.docId === record.docId))) toLocal.add(record.path);
    }
  }
  if (!local || !config) return toLocal.size ? { ...tree, entries: tree.entries.map((entry) => (toLocal.has(entry.path) ? { ...entry, transfer: "to-local" as const } : entry)) } : tree;
  const localTree = await buildTree(local, { budgetMs: input.budgetMs });
  // Files outside Git under the local rules, and «new» files that already have local data (they stay local, §4).
  const tracked = new Map(localTree.entries.filter((entry) => entry.supported && (entry.fileClass === "outside" || entry.docId)).map((entry) => [entry.path, entry] as const));
  // Local → Git (§9, F15): a file with local data that is now in the index — offered «Move to Git…».
  const localState = await local.state().catch(() => null);
  const toGit = new Set<string>();
  for (const record of gitKnown ? localState?.documents.values() ?? [] : []) {
    if (record.path && !record.removed && record.transferred !== "to-git" && tree.entries.find((entry) => entry.path === record.path)?.fileClass === "git") toGit.add(record.path);
  }
  const entries = tree.entries.map((entry) => {
    const own = tracked.get(entry.path);
    const merged = own ? { ...own, hidden: entry.hidden, hiddenFrom: entry.hiddenFrom, local: true } : entry;
    return toGit.has(entry.path) ? { ...merged, transfer: "to-git" as const } : toLocal.has(entry.path) ? { ...merged, transfer: "to-local" as const } : merged;
  });
  const totals = { ...tree.totals };
  for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += localTree.totals[key];
  // For a missing local tracked file, propose existing files outside Git with identical bytes anywhere in the checkout;
  // content are proposed first (the local rules may cover only the old path).
  const proposals = localTree.moves.proposals.map((proposal) => ({ ...proposal, local: true }));
  const missing = localTree.virtual.filter((entry) => entry.reason === "missing" && !proposals.some((proposal) => proposal.docId === entry.docId));
  if (missing.length && missing.length <= 50) {
    const localState = await local.state();
    const outside = tree.entries.filter((entry) => entry.fileClass === "outside" && !tracked.has(entry.path)).slice(0, 500);
    const shas = new Map<string, string>();
    for (const entry of outside) {
      const content = await readContent(service, entry.path).catch(() => null);
      if (content) shas.set(content.sha, entry.path);
    }
    for (const entry of missing) {
      const heads = localState.documents.get(entry.docId)?.headRevisions ?? [];
      const match = heads.map((id) => (revisionObject(localState, id) as Revision | null)?.snapshot).map((sha) => (sha ? shas.get(sha) : undefined)).find(Boolean);
      if (match) proposals.push({ docId: entry.docId, from: entry.path, open: entry.open, candidates: [{ path: match, exact: true, git: false, similarity: 1 }], local: true });
    }
  }
  return { ...tree, entries, virtual: [...tree.virtual, ...localTree.virtual.map((entry) => ({ ...entry, local: true }))], totals,
    moves: { applied: tree.moves.applied, proposals: [...tree.moves.proposals, ...proposals] },
    localRules: { roots: config.roots.filter((root) => root !== ".bb-local-none"), untracked: config.untracked } };
}

async function buildTree(service: ReviewService, input: { roots?: string[]; budgetMs?: number } = {}): Promise<TreeResult> {
  const started = performance.now();
  const budget = input.budgetMs ?? 1200;
  const info = await service.checkoutForRead();
  const configRead = info.isRepo ? await service.config() : { value: null as Config | null, readOnly: false };
  const config = configRead.value;
  const roots = config?.roots ?? (input.roots?.length ? input.roots : ["."]);
  for (const entry of roots) if (entry !== "." && !isRepoPath(entry)) throw new ReviewError("bad-input", `bad root: ${entry}`);
  const phases: Record<string, number> = {};
  let mark = performance.now();
  const phase = (name: string) => { const now = performance.now(); phases[name] = Math.round((phases[name] ?? 0) + now - mark); mark = now; };
  phase("checkout");
  let readerId: string | null = null;
  try {
    readerId = normalizeReaderId(info.identity.email);
  } catch {
    readerId = null;
  }
  const exclusions = await exclusionsFor(service.dataDir, config, readerId);
  // The Git classes (one pair of `git ls-files`) run while the directories are read.
  const [walked] = await Promise.all([walkRoots(service.root, roots, { exclusions, types: config?.types ?? null, budgetMs: budget }), service.fileClasses()]);
  phase("walk");
  const classOf = new Map<string, FileClass>();
  for (const file of walked.files.keys()) classOf.set(file, await service.fileClass(file));
  phase("classes");
  const hiddenRules = config?.hidden ?? [];
  const untrackedRules = config?.untracked ?? [];
  const untrackedAll = ignore().add([...untrackedRules]);
  const state = config ? await service.state(info) : null;
  const counts = state ? annotationCounts(state) : new Map();
  const live = new Map<string, { docId: string; headRevisions: string[] }>();
  if (state) for (const record of state.documents.values()) if (record.path && !record.removed) live.set(record.path, { docId: record.docId, headRevisions: record.headRevisions });

  phase("state");
  const signature = state ? sha256([
    service.generation, info.head, info.branch, readerId, JSON.stringify(roots), JSON.stringify(config), state.events.size, JSON.stringify(exclusions.listing()),
    ...[...walked.files].map(([file, meta]) => `${file}|${meta.size}|${meta.mtime}`),
  ].join("\n")) : null;
  const reused = signature ? treeResults.get(service) : undefined;
  if (signature && reused?.key === signature) {
    phase("reused");
    return { ...reused.result, moves: { applied: [], proposals: reused.result.moves.proposals }, computeMs: Math.round(performance.now() - started), phases };
  }
  const entries: TreeEntry[] = [];
  const contents = new Map<string, { sha: string; text: string }>();
  const toRead = state ? [...walked.files].filter(([file, meta]) => meta.size <= MAX_DOCUMENT && service.reviews(classOf.get(file) ?? "git") && !decide(untrackedRules, file).matched).map(([file]) => file) : [];
  const read = await readAll(service, toRead);
  phase("read");
  let pending = 0;
  const totals = { waiting: 0, candidates: 0, unreadDocs: 0, unread: 0, changedDocs: 0, open: 0 };
  const insideRoots = (file: string) => roots.some((rootPath) => rootPath === "." || file === rootPath || file.startsWith(`${rootPath}/`));
  for (const [file, meta] of [...walked.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const fileClass = classOf.get(file) ?? "git";
    // A file the review does not keep (outside Git for the shared one) is shown only: no review state here.
    const supported = service.reviews(fileClass);
    const hidden = decide(hiddenRules, file);
    const untracked = supported ? decide(untrackedRules, file) : { matched: false, by: null, own: false };
    const record = supported ? live.get(file) ?? null : null;
    const count = record ? counts.get(record.docId) : undefined;
    const entry: TreeEntry = {
      path: file, kind: meta.kind, size: meta.size, supported, note: meta.note, format: meta.format, group: FORMATS[meta.format].group, fileClass,
      hidden: hidden.matched, hiddenFrom: inheritedFrom(hidden), untracked: untracked.matched, untrackedFrom: inheritedFrom(untracked),
      docId: record?.docId ?? null, state: null, unread: null,
      open: count?.open ?? 0, waiting: count?.waiting ?? 0, candidates: count?.candidates ?? 0,
      conflict: Boolean(record && state?.documents.get(record.docId)?.conflict),
    };
    totals.waiting += entry.waiting;
    totals.candidates += entry.candidates;
    totals.open += entry.open;
    if (supported && state && meta.size <= MAX_DOCUMENT) {
      if (untracked.matched) entry.state = "untracked";
      else {
        const loaded = read.get(file) ?? null;
        if (loaded) {
          const { sha, text } = loaded;
          contents.set(file, loaded);
          if (!record) entry.state = insideRoots(file) ? "new" : null;
          else if (readerId) {
            const persisted = record.headRevisions.find((revisionId) => revisionObject(state, revisionId)?.snapshot === sha) ?? null;
            const key = `${sha}|${[...record.headRevisions].sort().join(",")}`;
            let revisionId: string | null = persisted;
            let scoped = state;
            if (!persisted) {
              let built = builtCache.get(key) ?? null;
              if (!built && performance.now() - started < budget) {
                try {
                  built = (await currentBuilt(service, state, { path: file, docId: record.docId, text, sha, revisionId: null, headRevisions: record.headRevisions })).revision;
                  cacheBuilt(key, built);
                } catch {
                  built = null;
                }
              }
              if (built) {
                scoped = withEphemeral(state, built);
                revisionId = built.revisionId;
              }
            }
            if (revisionId && !state.incomplete.has(entity.doc(record.docId))) {
              try {
                entry.unread = readState(scoped, readerId, revisionId).unread;
                entry.state = entry.unread ? "unread" : "read";
              } catch {
                entry.state = "changed";
              }
            } else {
              entry.state = "changed";
              pending++;
            }
          }
        }
      }
    }
    if (entry.state === "unread") { totals.unreadDocs++; totals.unread += entry.unread ?? 0; }
    if (entry.state === "changed" || entry.state === "new") totals.changedDocs++;
    entries.push(entry);
  }

  phase("entries");
  // Documents gone from disk: virtual entries while they have annotations or an unacknowledged deletion (D5, AC08).
  const virtual: VirtualEntry[] = [];
  const present = new Set(walked.files.keys());
  if (state) {
    for (const record of state.documents.values()) {
      if (!record.path || present.has(record.path) || !insideRoots(record.path)) continue;
      // A document now excluded by a rule (or of a type turned off) is not «missing»: it is not shown on purpose.
      if (exclusions.decide(record.path).excluded) continue;
      const count = counts.get(record.docId) ?? { open: 0, waiting: 0, candidates: 0 };
      const deletionUnread = readerId ? removalState(state, readerId, record.docId) === "unread" : !record.removed;
      // A removed document stays while it has open annotations, a conflict, or an unread deletion for this reader.
      if (record.removed && !count.open && !record.conflict && !deletionUnread) continue;
      virtual.push({ path: record.path, docId: record.docId, reason: record.removed ? "removed" : "missing", ...count, hidden: decide(hiddenRules, record.path).matched, conflict: Boolean(record.conflict), deletionUnread });
      if (deletionUnread) totals.unreadDocs++;
      totals.waiting += count.waiting;
      totals.candidates += count.candidates;
      totals.open += count.open;
    }
  }

  // Renames: a missing document and a new unregistered one with the same bytes (or a staged Git rename) form a
  // unique pair → applied as document.moved; similar but not identical, or several candidates → asked (AC08).
  const proposals: MoveProposal[] = [];
  const unique: { docId: string; from: string; to: string }[] = [];
  const missing = virtual.filter((entry) => entry.reason === "missing" && !entry.conflict);
  const fresh = entries.filter((entry) => entry.state === "new" && entry.supported);
  if (state && missing.length && fresh.length) {
    const renames = await gitRenames(service.root);
    const heads = new Map<string, Revision[]>();
    for (const entry of missing) heads.set(entry.docId, state.documents.get(entry.docId)!.headRevisions.map((id) => revisionObject(state, id) as Revision | null).filter((value): value is Revision => Boolean(value)));
    const freshHashes = new Map<string, Set<string>>();
    if (missing.length <= 50 && fresh.length <= 200) {
      for (const entry of fresh) {
        const content = contents.get(entry.path);
        if (!content) continue;
        const projected = buildRevision({ revisionId: "00000000-0000-4000-8000-000000000000", docId: "00000000-0000-4000-8000-000000000000", path: entry.path, source: content.text, snapshot: content.sha, parents: [] }).revision;
        freshHashes.set(entry.path, blockHashes(projected));
      }
    }
    for (const entry of missing) {
      const revisions = heads.get(entry.docId) ?? [];
      const candidates: MoveProposal["candidates"] = [];
      for (const candidate of fresh) {
        const content = contents.get(candidate.path);
        const exact = Boolean(content && revisions.some((revision) => revision.snapshot === content.sha));
        const viaGit = renames.get(entry.path) === candidate.path;
        let similarity = exact ? 1 : 0;
        const hashes = freshHashes.get(candidate.path);
        if (!exact && hashes && revisions.length) {
          const before = blockHashes(revisions[0]);
          let common = 0;
          for (const hash of before) if (hashes.has(hash)) common++;
          similarity = Math.round((common / Math.max(before.size, hashes.size, 1)) * 100) / 100;
        }
        if (exact || viaGit || similarity >= 0.5) candidates.push({ path: candidate.path, exact, git: viaGit, similarity });
      }
      if (!candidates.length) continue;
      candidates.sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.git) - Number(a.git) || b.similarity - a.similarity);
      proposals.push({ docId: entry.docId, from: entry.path, open: entry.open, candidates });
    }
    // Applied automatically only when unambiguous both ways, with the same bytes, and the old path is still in HEAD
    // (a rename in the working tree). A path the checked-out branch does not have — a branch switch, a pull — is
    // only proposed: the journal is shared by all branches and must not record moves back and forth.
    for (const proposal of proposals) {
      const strong = proposal.candidates.filter((candidate) => candidate.exact);
      if (strong.length !== 1 || proposal.candidates.length !== 1) continue;
      const to = strong[0].path;
      const rivals = proposals.filter((other) => other !== proposal && other.candidates.some((candidate) => candidate.path === to));
      if (rivals.length || !info.head) continue;
      const inHead = await git(service.root, ["cat-file", "-e", `HEAD:${proposal.from}`], { allowFailure: true, timeoutMs: 5000 });
      if (inHead.code === 0) unique.push({ docId: proposal.docId, from: proposal.from, to });
    }
  }

  phase("virtual+moves");
  const writable = Boolean(config) && !configRead.readOnly && readerId !== null && Boolean(state && !state.repoReadOnly.length);
  const result: TreeResult = {
    enabled: Boolean(config), isRepo: info.isRepo, roots, missingRoots: walked.missing,
    suggestions: walked.missing.length === roots.length ? await suggestRoots(service.root, exclusions) : [],
    entries, virtual, moves: { applied: unique, proposals: proposals.filter((proposal) => !unique.some((move) => move.docId === proposal.docId)) },
    excluded: walked.excludedDirs, skipped: { other: walked.notShown.types.other + walked.notShown.types.wave2 + walked.notShown.types.disabled, symlinks: walked.notShown.symlinks },
    notShown: walked.notShown, partial: walked.partial, truncated: walked.truncated, pending, totals,
    computeMs: Math.round(performance.now() - started), phases, head: info.head, branch: info.branch,
    hiddenRules: [...hiddenRules], untrackedRules: [...untrackedRules], writable,
    reader: { id: readerId, known: Boolean(state && readerId && isKnownReader(state, readerId)) },
  };
  if (signature && !pending && !unique.length && !walked.partial) treeResults.set(service, { key: signature, result });
  return result;
}

/** Headings of every supported document for search (EP-011-T02), cached by content hash. */
const headingCache = new Map<string, { text: string; depth: number }[]>();
export async function searchIndex(service: ReviewService, tree: TreeResult, query: string, options: { showHidden?: boolean; limit?: number } = {}) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const limit = options.limit ?? 50;
  const results: { path: string; heading: string | null; depth: number | null; hidden: boolean }[] = [];
  if (!terms.length) return { results, more: false };
  const visible = tree.entries.filter((entry) => options.showHidden || !entry.hidden);
  const has = (text: string) => terms.every((term) => text.toLowerCase().includes(term));
  for (const entry of visible) if (has(entry.path)) results.push({ path: entry.path, heading: null, depth: null, hidden: entry.hidden });
  for (const entry of visible) {
    if (!entry.supported || entry.kind !== "file" || entry.size > MAX_DOCUMENT) continue;
    const content = await readContent(service, entry.path).catch(() => null);
    if (!content) continue;
    const sha = content.sha;
    let headings = headingCache.get(`${entry.path}|${sha}`);
    if (!headings) {
      const projection = projectFile(entry.path, content.text);
      headings = projection.blocks.filter((block) => block.type === "heading").map((block) => ({ text: block.text, depth: block.depth ?? 1 }));
      headingCache.set(`${entry.path}|${sha}`, headings);
      if (headingCache.size > 4000) headingCache.delete(headingCache.keys().next().value!);
    }
    for (const heading of headings) if (has(heading.text)) results.push({ path: entry.path, heading: heading.text, depth: heading.depth, hidden: entry.hidden });
    if (results.length > limit * 2) break;
  }
  return { results: results.slice(0, limit), more: results.length > limit };
}

export { persistentBuilt };
