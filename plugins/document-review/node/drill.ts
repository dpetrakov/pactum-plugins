// Cross-machine merge drill (EP-014-T02/T03): review data written on two machines in two clones of one repository,
// exchanged only as Git bundles (bb file-gateway copy), merged by Git and by the review model. Everything happens in
// temporary directories of the host; no user checkout is touched.
//   start (machine 1): base repository with review enabled → branch `first` with this machine's writes → bundle.
//   merge (machine 2): clone the bundle → branch `second` from the base with this machine's writes → git merge
//         first → Git conflicts (rename/delete, config.json) and review conflicts are listed, then resolved explicitly
//         → merged bundle and the reader's digest. `summary --bundle` on machine 1 must give the same digest (AC01).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discussion } from "../core/discussion.ts";
import { entity } from "../core/journal.ts";
import { sha256 } from "../core/hash.ts";
import { acknowledgeDeletion, resolveDocumentConflict, setRule, treeWithMoves } from "./catalog.ts";
import { summary } from "./check.ts";
import { git, resolveCheckout } from "./checkout.ts";
import { ReviewService } from "./service.ts";
import { documentView } from "./view.ts";

export const DRILL_READER = "drill@bb-docs.invalid";
const DOC = "# Учения\n\nПервый абзац.\n\nВторой абзац.\n";

function gx(cwd: string, args: string[], allowFailure = false) {
  return git(cwd, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { allowFailure, timeoutMs: 120_000 });
}

async function identity(dir: string, name: string) {
  await gx(dir, ["config", "user.name", name]);
  await gx(dir, ["config", "user.email", DRILL_READER]);
}

async function commit(dir: string, message: string) {
  await gx(dir, ["add", "-A"]);
  await gx(dir, ["commit", "-q", "--no-verify", "-m", message], true);
}

const BUNDLE = /^bb-docs-drill-[0-9a-f]{12}(-merged)?\.bundle$/;

/** Machine 1: base + branch `first` with a reply, an edit read by the reader, a rename, a closed annotation, a rule. */
export async function drillStart(input: { tempDir: string }) {
  const id = sha256(`${Date.now()}-${Math.random()}`).slice(0, 12);
  const work = await fs.mkdtemp(path.join(input.tempDir, "bb-docs-drill-"));
  try {
    const dir = path.join(work, "repo");
    await fs.mkdir(path.join(dir, "docs"), { recursive: true });
    await gx(dir, ["init", "-q", "-b", "main"]);
    await identity(dir, `Drill ${os.hostname()}`);
    await fs.writeFile(path.join(dir, "docs/a.md"), DOC);
    await fs.writeFile(path.join(dir, "docs/r.md"), "# R\n\nабзац один\n\nабзац два\n");
    await fs.writeFile(path.join(dir, "docs/other.md"), "# Other\n\nЧитается всегда.\n");
    const service = new ReviewService((await resolveCheckout(dir)).root, path.join(work, "data"));
    await service.enable({});
    const shown = await documentView(service, "docs/a.md");
    const created = await service.annotate({ path: "docs/a.md", observation: { sha: shown.document.sha }, kind: "action", text: "Обсудить на двух машинах", targetKind: "block", block: 1 });
    await commit(dir, "drill: base");
    await gx(dir, ["checkout", "-q", "-b", "first"]);
    await service.reply({ annotationId: created.annotationId, text: `ответ с ${os.hostname()}` });
    await fs.writeFile(path.join(dir, "docs/a.md"), DOC.replace("Первый абзац.", "Первый абзац, правка первой машины."));
    const edited = await documentView(service, "docs/a.md");
    await service.acknowledge({ path: "docs/a.md", observation: { sha: edited.document.sha }, scope: "document" });
    await gx(dir, ["mv", "docs/r.md", "docs/r2.md"]);
    await treeWithMoves(service);
    const heads = (await service.state()).heads.get(entity.annotation(created.annotationId))!;
    await service.decide({ annotationId: created.annotationId, action: "close", expectedHeads: heads });
    await setRule(service, { list: "hidden", path: "docs/other.md", isDir: false, action: "add" });
    await commit(dir, "drill: first machine");
    const bundle = path.join(input.tempDir, `bb-docs-drill-${id}.bundle`);
    await gx(dir, ["bundle", "create", "-q", bundle, "HEAD", "main", "first"]);
    const state = await service.state();
    return { host: os.hostname(), bundle, annotationId: created.annotationId, events: state.events.size, head: (await gx(dir, ["rev-parse", "first"])).stdout.trim() };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

/** Machine 2: branch `second` from the base, its own writes, Git merge of `first`, explicit resolutions, merged bundle. */
export async function drillMerge(input: { bundle: string; tempDir: string }) {
  if (!path.isAbsolute(input.bundle)) throw new Error("bundle path must be absolute");
  const id = sha256(`${input.bundle}-${Date.now()}`).slice(0, 12);
  const work = await fs.mkdtemp(path.join(input.tempDir, "bb-docs-drill-"));
  try {
    const dir = path.join(work, "repo");
    await gx(work, ["clone", "-q", "-b", "main", input.bundle, dir]);
    await identity(dir, `Drill ${os.hostname()}`);
    await gx(dir, ["fetch", "-q", input.bundle, "first:first"]);
    await gx(dir, ["checkout", "-q", "-b", "second"]);
    const service = new ReviewService((await resolveCheckout(dir)).root, path.join(work, "data"));
    // AC01/AC17: no plugin data on this machine; the same reader email sees the base state from the repository.
    const base = await documentView(service, "docs/a.md");
    const annotationId = base.annotations[0]?.annotationId;
    if (!annotationId) throw new Error("the annotation of the base is not visible after clone");
    const readable = { annotations: base.annotations.length, unread: base.unread, writable: base.context.writable };
    await service.reply({ annotationId, text: `ответ с ${os.hostname()}` });
    await fs.writeFile(path.join(dir, "docs/a.md"), DOC.replace("Второй абзац.", "Второй абзац, правка второй машины."));
    const edited = await documentView(service, "docs/a.md");
    await service.acknowledge({ path: "docs/a.md", observation: { sha: edited.document.sha }, scope: "document" });
    const rDoc = (await documentView(service, "docs/r.md")).document.docId!;
    await gx(dir, ["rm", "-q", "docs/r.md"]);
    await acknowledgeDeletion(service, { docId: rDoc });
    await setRule(service, { list: "hidden", path: "docs/a.md", isDir: false, action: "add" });
    // A choice contradicting the first machine's closed state: close and reopen here.
    let heads = (await service.state()).heads.get(entity.annotation(annotationId))!;
    await service.decide({ annotationId, action: "close", expectedHeads: heads });
    heads = (await service.state()).heads.get(entity.annotation(annotationId))!;
    await service.decide({ annotationId, action: "reopen", expectedHeads: heads });
    await commit(dir, "drill: second machine");

    const merge = await gx(dir, ["merge", "--no-edit", "first"], true);
    const unmerged = (await gx(dir, ["diff", "--name-only", "--diff-filter=U"])).stdout.trim().split("\n").filter(Boolean).sort();
    // Documents are resolved in Git as usual: keep the renamed file. config.json is left to the plugin.
    await gx(dir, ["add", "-A", "docs"]);
    service.invalidate();
    const mergedConfig = await service.config();
    const conflict = await service.configConflict();
    const other = await documentView(service, "docs/other.md");
    const duringConflict = { configReadOnly: mergedConfig.readOnly, problem: mergedConfig.problem ?? null, otherReadable: other.blocks.length > 0, proposed: conflict?.merged ?? null };
    if (conflict) await service.resolveConfigConflict({});
    await gx(dir, ["commit", "-q", "--no-edit"], true);
    service.invalidate();
    const state = await service.state();
    const conflicts = state.conflicts.map((entry) => ({ entity: entry.entity.split(":")[0], register: entry.register, values: entry.candidates.map((candidate) => candidate.value).sort() }));
    const view = discussion(state, annotationId);
    const replies = view.messages.map((message) => message.current?.text ?? null);
    const merged = await documentView(service, "docs/a.md");
    const reading = { unread: merged.unread, blocks: merged.blocks.map((block) => block.read) };
    // Explicit resolutions: the rename stays (the file exists), the status conflict is decided by the user.
    const r = state.documents.get(rDoc)!;
    if (r.conflict) await resolveDocumentConflict(service, { docId: rDoc, choice: "keep" });
    if (state.conflicts.some((entry) => entry.entity === entity.annotation(annotationId) && entry.register === "status")) {
      await service.resolveConflict({ annotationId, register: "status", value: "closed" });
    }
    await commit(dir, "drill: resolutions");
    const after = await service.state();
    const report = await service.validate(10);
    const digestText = await summary(service, DRILL_READER);
    const bundle = path.join(input.tempDir, `bb-docs-drill-${id}-merged.bundle`);
    await gx(dir, ["bundle", "create", "-q", bundle, "HEAD", "second"]);
    return {
      host: os.hostname(), bundle, gitMerge: merge.code === 0 ? "clean" : "conflicts", unmerged, readable, duringConflict, conflicts, replies,
      reading, resolved: { conflictsLeft: after.conflicts.length, rPath: after.documents.get(rDoc)?.path ?? null, status: discussion(after, annotationId).status },
      validate: { ok: report.ok, counts: report.counts, problems: report.problems.slice(0, 5) }, digest: sha256(digestText),
    };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

/** Remove drill bundles this plugin left in its temporary directory on this host. */
export async function drillClean(input: { tempDir: string }) {
  const removed: string[] = [];
  for (const name of await fs.readdir(input.tempDir).catch(() => [] as string[])) {
    if (!BUNDLE.test(name)) continue;
    await fs.rm(path.join(input.tempDir, name), { force: true });
    removed.push(name);
  }
  return { host: os.hostname(), removed };
}
