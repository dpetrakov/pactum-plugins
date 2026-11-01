// Catalog writes of one checkout (EP-011-T03/T04): visibility and tracking rules in config.json (CAS, re-applied
// once on a concurrent change so the user's rule is not lost), the new base when tracking resumes (A7), renames
// (document.moved) and acknowledged deletions (document.removed). Every command runs in the service's queue.
import { isReviewable } from "../core/formats/registry.ts";
import { tr } from "../core/i18n.ts";
import fs from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import { canonicalBytes } from "../core/canonical-json.ts";
import { newId, sha256 } from "../core/hash.ts";
import { removalState } from "../core/reading.ts";
import { applyRule, ruleablePath, type RuleAction, type RuleList } from "../core/rules.ts";
import { confine } from "./checkout.ts";
import { type Config, type ObjectValue, type Operation, parseConfig } from "../core/schema.ts";
import { layout, writeConfig } from "../core/store.ts";
import { type Expectation, ReviewError, type ReviewService } from "./service.ts";
import { documentTree, type TreeResult } from "./tree.ts";


export interface RuleInput extends Expectation {
  list: RuleList;
  path: string;
  isDir: boolean;
  action: RuleAction;
  /** sha256 of config.json the user saw; a different one means someone changed it meanwhile. */
  configSha?: string | null;
}

/** Markdown files under a path (a file or a directory), for the tracking switch. */
async function markdownUnder(service: ReviewService, config: Config, target: string, isDir: boolean): Promise<string[]> {
  const docs = await service.trackedDocuments({ ...config, untracked: [] });
  return docs.map((doc) => doc.path).filter((doc) => (target === "." || (isDir ? doc.startsWith(`${target}/`) : doc === target)));
}

/**
 * «Hide / Show» and «Untracked / Track» (A5–A7, AC09). The config is written by compare-and-swap;
 * a concurrent change is re-read and the same rule is applied to it (reported as «merged»), never silently lost.
 * Resuming tracking first records the current revision of each affected document as a tracking-resumed base, so
 * changes made during the pause are not shown as unread and are not claimed as read either (the view marks them).
 */
export async function setRule(service: ReviewService, input: RuleInput) {
  return service.serial(async () => {
    const { actor } = await service.writable(input);
    await finishResume(service, actor);
    const refused = ruleablePath(input.path);
    if (refused) throw new ReviewError("bad-input", refused);
    // The kind of the path is the disk's, not the client's: a directory rule covers its contents.
    const stat = await fs.lstat(await confine(service.root, input.path)).catch(() => null);
    if (stat && stat.isDirectory() !== input.isDir) throw new ReviewError("bad-input", `${input.path} is ${stat.isDirectory() ? "a directory" : "a file"}`);
    let merged = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const read = await service.config();
      if (!read.value || read.readOnly) throw new ReviewError("read-only", read.problem ?? "config.json cannot be used for writing");
      if (input.configSha !== undefined && input.configSha !== null && input.configSha !== read.sha) merged = true;
      const config = read.value;
      const applied = applyRule(config[input.list], { path: input.path, isDir: input.isDir, action: input.action });
      if (!applied.changed) return { status: "unchanged" as const, merged, configSha: read.sha, resumed: 0 };
      const next: Config = { ...config, [input.list]: applied.patterns };
      const parsed = parseConfig(next);
      if (!parsed.ok) throw new ReviewError("bad-input", parsed.issues.join("; "));
      // Documents whose tracking resumes with this very version of the rules (computed before writing).
      const resuming = input.list === "untracked"
        ? (await markdownUnder(service, config, input.path, input.isDir)).filter((doc) => ignore().add(config.untracked).ignores(doc) && !ignore().add(applied.patterns).ignores(doc) && service.insideRoots(config, doc))
        : [];
      // Config first (CAS): only a rule that really landed gets its resumed bases; a lost race writes nothing.
      // The intent is recorded before the config: a crash between the two is finished by the next catalog command.
      const nextSha = sha256(canonicalBytes(next));
      if (resuming.length) await service.intents.put({ configSha: nextSha, docs: resuming, startedAt: new Date().toISOString() });
      if ((await writeConfig(service.store, canonicalBytes(next), read.sha)) !== "replaced") {
        if (resuming.length) await service.intents.clear();
        merged = true;
        continue;
      }
      const resumed = await resumeBases(service, actor, resuming);
      if (resuming.length) await service.intents.clear();
      return { status: "published" as const, merged, configSha: sha256(canonicalBytes(next)), resumed, patterns: applied.patterns };
    }
    throw new ReviewError("config-conflict", "config.json keeps changing concurrently; reload and try again");
  });
}

/**
 * Finish an interrupted «Track» (EP-014-T01): the intent names the documents whose tracking was resuming.
 * Those that are tracked under the current config get their tracking-resumed base now; if the config write never
 * landed they are still untracked and nothing is written. Runs inside the service queue of a catalog command.
 */
export async function finishResume(service: ReviewService, actor: Operation["actor"]): Promise<number> {
  const intent = await service.intents.get();
  if (!intent) return 0;
  const read = await service.config();
  if (!read.value || read.readOnly) return 0;
  const untracked = ignore().add(read.value.untracked);
  const config = read.value;
  const docs = intent.docs.filter((doc) => !untracked.ignores(doc) && service.insideRoots(config, doc));
  const resumed = docs.length ? await resumeBases(service, actor, docs) : 0;
  await service.intents.clear();
  return resumed;
}

/**
 * A7: the current revision of each document whose tracking resumed becomes its new base (tracking-resumed). If this
 * fails after the rule was written, the pause shows as unread changes — visible, never claimed as read.
 */
async function resumeBases(service: ReviewService, actor: Operation["actor"], docs: string[]): Promise<number> {
  let resumed = 0;
  for (let index = 0; index < docs.length; index += 200) {
    const current = await service.state();
    const changes: Operation["changes"] = [];
    const objects: ObjectValue[] = [];
    const snapshots: Uint8Array[] = [];
    for (const doc of docs.slice(index, index + 200)) {
      const shown = await service.readDocument(doc).catch(() => null);
      if (!shown) continue;
      const promoted = await service.promote(current, doc, shown.docId, { sha: shown.sha }, "receipt", "tracking-resumed");
      changes.push(...promoted.changes);
      // The same bytes as an existing revision: the resumed base is still recorded explicitly.
      if (!promoted.changes.some((change) => change.type === "document.observed")) {
        const record = current.revisions.get(promoted.revision.revisionId);
        if (record) changes.push({ type: "document.observed", docId: promoted.revision.docId, revisionId: promoted.revision.revisionId, revision: record.objectSha, reason: "tracking-resumed" });
      }
      objects.push(...promoted.objects);
      snapshots.push(...promoted.snapshots);
      resumed++;
    }
    if (changes.length) await service.commit(current, actor, changes, objects, snapshots);
  }
  return resumed;
}

/** Explicit rename resolution: renamed to a path produces document.moved; deleted produces document.removed. */
export async function resolveMove(service: ReviewService, input: { docId: string; to: string | null } & Expectation) {
  return service.serial(async () => {
    const { actor, readerId, state } = await service.writable(input);
    const record = state.documents.get(input.docId);
    if (!record?.path) throw new ReviewError("not-found", "no such document");
    if (record.conflict) throw new ReviewError("conflict", "the branches disagree about this document: resolve the conflict first");
    const from = record.path;
    const fromExists = await fs.lstat(path.join(service.root, ...from.split("/"))).then(() => true, () => false);
    if (fromExists && !record.removed) throw new ReviewError("bad-input", `${from} still exists: a copy gets its own document, nothing is moved`);
    if (input.to === null) {
      // The checkout's fact «removed, not renamed» once, and this reader's acknowledgement of it (EP-014-T05).
      const changes: Operation["changes"] = [];
      if (!record.removed) changes.push({ type: "document.removed", docId: input.docId, path: from });
      const head = record.headRevisions[record.headRevisions.length - 1];
      let receiptId: string | null = null;
      if (head && removalState(state, readerId, input.docId) !== "read") {
        receiptId = newId();
        changes.push({ type: "read.acknowledged", receiptId, readerId, docId: input.docId, revisionId: head, scope: "removal", versions: [], tombstones: [] });
      }
      if (!changes.length) return { status: "unchanged" as const };
      const { operation } = await service.commit(state, actor, changes, [], []);
      return { status: "removed" as const, eventId: operation.id, receiptId };
    }
    const config = (await service.config()).value!;
    if (!isReviewable(input.to, config.types) || !service.insideRoots(config, input.to)) throw new ReviewError("bad-input", `not a reviewable file inside the roots: ${input.to}`);
    await service.documentFile(input.to);
    if (service.docIdOf(state, input.to)) throw new ReviewError("bad-input", `${input.to} is already a document with its own history`);
    const { operation } = await service.commit(state, actor, [{ type: "document.moved", docId: input.docId, from, to: input.to }], [], []);
    return { status: "moved" as const, eventId: operation.id, from, to: input.to };
  });
}

/**
 * Explicit resolution of a document conflict after a Git merge (EP-014-T02, G4): two renames, or a rename/change on
 * one branch against a removal on the other. The resolution event names every conflicting head as a parent, so it
 * dominates them; nothing is decided automatically. `choice`: a candidate path, "keep" (the document stays at its
 * path: its current file is observed with reason reconcile) or "removed".
 */
export async function resolveDocumentConflict(service: ReviewService, input: { docId: string; choice: string } & Expectation) {
  return service.serial(async () => {
    const { actor, state } = await service.writable(input);
    const record = state.documents.get(input.docId);
    if (!record?.conflict) throw new ReviewError("stale", "no conflict for this document any more; reload");
    const resolves = record.conflict.candidates.map((candidate) => candidate.eventId);
    let changes: Operation["changes"];
    let objects: ObjectValue[] = [];
    let snapshots: Uint8Array[] = [];
    if (record.conflict.register === "path") {
      if (!record.conflict.candidates.some((candidate) => candidate.value === input.choice)) throw new ReviewError("bad-input", "the path is not one of the conflicting paths");
      changes = [{ type: "document.moved", docId: input.docId, from: record.path!, to: input.choice }];
    } else if (input.choice === "removed") {
      changes = [{ type: "document.removed", docId: input.docId, path: record.path! }];
    } else if (input.choice === "keep") {
      const shown = await service.readDocument(record.path!).catch(() => null);
      if (!shown) throw new ReviewError("not-found", `${record.path} is not on disk: restore the file or choose ${tr("“deleted”", "«удалён»")}`);
      const promoted = await service.promote(state, record.path!, input.docId, { sha: shown.sha }, "receipt", "reconcile");
      changes = [...promoted.changes];
      if (!changes.some((change) => change.type === "document.observed")) {
        const existing = state.revisions.get(promoted.revision.revisionId)!;
        changes.push({ type: "document.observed", docId: input.docId, revisionId: existing.revisionId, revision: existing.objectSha, reason: "reconcile" });
      }
      objects = promoted.objects;
      snapshots = promoted.snapshots;
    } else throw new ReviewError("bad-input", "choose «keep» or «removed»");
    const { operation } = await service.commit(state, actor, changes, objects, snapshots, resolves, true);
    return { status: "resolved" as const, eventId: operation.id, register: record.conflict.register, choice: input.choice };
  });
}

/** «Mark deletion read» of a whole document (AC08): acknowledged by this reader (removal receipt, 1.1), undone by revoke. */
export async function acknowledgeDeletion(service: ReviewService, input: { docId: string } & Expectation) {
  return resolveMove(service, { ...input, to: null });
}

/**
 * The tree with unambiguous renames applied (same bytes or a staged Git rename, one candidate both ways). Applied
 * moves are reported so the UI says what happened; ambiguous ones stay proposals for the user.
 */
export async function treeWithMoves(service: ReviewService, input: { roots?: string[]; budgetMs?: number } = {}): Promise<TreeResult> {
  // An «Track» interrupted by a crash or restart is finished before the tree is computed (EP-014-T01).
  if (await service.intents.get()) {
    await service.serial(async () => {
      const { actor } = await service.writable({});
      await finishResume(service, actor);
    }).catch(() => undefined);
  }
  const first = await documentTree(service, input);
  if (!first.moves.applied.length || !first.writable) return { ...first, moves: { applied: [], proposals: [...first.moves.proposals, ...first.moves.applied.map((move) => ({ docId: move.docId, from: move.from, open: 0, candidates: [{ path: move.to, exact: true, git: false, similarity: 1 }] }))] } };
  const applied: { docId: string; from: string; to: string }[] = [];
  for (const move of first.moves.applied) {
    const result = await resolveMove(service, { docId: move.docId, to: move.to }).catch(() => null);
    if (result && result.status === "moved") applied.push(move);
  }
  const second = await documentTree(service, input);
  return { ...second, moves: { applied, proposals: second.moves.proposals } };
}

/** sha256 of the current config.json bytes (for the client's CAS expectation). */
export async function configSha(service: ReviewService): Promise<string | null> {
  const bytes = await service.store.read(layout.config);
  return bytes ? sha256(bytes) : null;
}
