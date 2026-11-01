// W-04 part of `bb document-review check`, on the machine the host entry runs on: the tree of 1000 files / 10 MiB
// (H7), rename / copy / delete with virtual documents (AC08), hide / untrack with a CAS conflict and the resumed
// base (AC09, A7). Every step works in its own temporary repository inside the check's work directory.
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { canonicalBytes } from "../core/canonical-json.ts";
import { layout, writeConfig } from "../core/store.ts";
import { acknowledgeDeletion, configSha, resolveMove, setRule, treeWithMoves } from "./catalog.ts";
import { git } from "./checkout.ts";
import { ReviewService } from "./service.ts";
import { documentTree } from "./tree.ts";
import { documentView } from "./view.ts";

type Step = (name: string, run: () => Promise<string | void>) => Promise<void>;

export async function scratch(work: string, name: string, files: Record<string, string>) {
  const dir = path.join(work, name);
  await fs.mkdir(dir, { recursive: true });
  const gx = (args: string[]) => git(dir, ["-c", "core.hooksPath=/dev/null", ...args], { timeoutMs: 120_000 });
  await gx(["init", "-q", "-b", "main"]);
  await gx(["config", "user.name", "Check Reader"]);
  await gx(["config", "user.email", "check@bb-docs.invalid"]);
  await gx(["config", "commit.gpgsign", "false"]);
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), text);
  }
  await gx(["add", "-A"]);
  await gx(["commit", "-q", "-m", "fixture"]);
  const real = await fs.realpath(dir);
  const service = new ReviewService(real, path.join(work, `${name}-data`));
  await service.enable({});
  return { dir: real, service, write: async (file: string, text: string) => { await fs.mkdir(path.dirname(path.join(real, file)), { recursive: true }); await fs.writeFile(path.join(real, file), text); } };
}

export async function catalogSteps(input: { step: Step; assert: (condition: unknown, message: string) => void; work: string; measurements: Record<string, string> }) {
  const { step, assert, work, measurements } = input;

  await step("W-04 tree: 1000 files / 10 MiB of Markdown in the roots — cold (journal load) and warm (H7 ≤ 2 s)", async () => {
    const files: Record<string, string> = {};
    const paragraph = "Текст абзаца для замера дерева документов. ".repeat(6);
    let bytes = 0;
    // Tests shorten the fixture; the real check always measures 1000 files.
    const count = Number(process.env.DOCUMENT_REVIEW_CHECK_TREE_FILES) || 1000;
    for (let index = 0; index < count; index++) {
      const text = `# Документ ${index}\n\n${Array.from({ length: 22 }, () => paragraph).join("\n\n")}\n`;
      files[`docs/d${Math.floor(index / 50)}/f${index}.md`] = text;
      bytes += Buffer.byteLength(text);
    }
    const t0 = performance.now();
    const repo = await scratch(work, "tree", files);
    const enableMs = performance.now() - t0;
    await repo.write("docs/d0/f0.md", `${files["docs/d0/f0.md"]}\nНовый абзац после включения.\n`);
    // A fresh service: the first tree includes reading the journal of 1000 documents from .bb-docs.
    const fresh = new ReviewService(repo.dir, path.join(work, "tree-data-2"));
    const t1 = performance.now();
    const cold = await documentTree(fresh);
    const coldMs = performance.now() - t1;
    const t2 = performance.now();
    const warm = await documentTree(fresh);
    const warmMs = performance.now() - t2;
    assert(cold.entries.length === count && warm.entries.length === count, `entries ${cold.entries.length}`);
    assert(warm.totals.unreadDocs === 1 && warm.entries.find((entry) => entry.path === "docs/d0/f0.md")?.unread === 1, "one edited document is unread with one block");
    assert(warmMs <= 2000, `warm tree ${Math.round(warmMs)} ms > 2000 ms`);
    measurements[`W-04 tree ${count} files`] = `${(bytes / 1024 / 1024).toFixed(1)} MiB; first tree with journal load ${Math.round(coldMs)} ms (tree ${cold.computeMs} ms), next ${Math.round(warmMs)} ms; enable ${Math.round(enableMs)} ms`;
    return `warm ${Math.round(warmMs)} ms, cold ${Math.round(coldMs)} ms`;
  });

  await step("W-04 rename / copy / delete: history follows a rename, a copy is new, a deletion stays virtual (AC08)", async () => {
    const repo = await scratch(work, "moves", { "docs/a.md": "# A\n\nпервый абзац\n\nвторой абзац\n", "docs/c.md": "# C\n\nкопируемый\n", "docs/amb.md": "# M\n\nодин\n\nдва\n\nтри\n" });
    const view = await documentView(repo.service, "docs/a.md");
    const created = await repo.service.annotate({ path: "docs/a.md", observation: { sha: view.document.sha }, text: "уточнить", kind: "action", targetKind: "block", block: 1 });
    await fs.rename(path.join(repo.dir, "docs/a.md"), path.join(repo.dir, "docs/renamed.md"));
    let tree = await treeWithMoves(repo.service);
    assert(tree.moves.applied.length === 1 && tree.moves.applied[0].to === "docs/renamed.md", `applied ${JSON.stringify(tree.moves.applied)}`);
    const moved = await documentView(repo.service, "docs/renamed.md");
    assert(moved.annotations[0]?.annotationId === created.annotationId && moved.unread === 0, "annotation and reading follow the rename");
    await repo.write("docs/c-copy.md", "# C\n\nкопируемый\n");
    tree = await treeWithMoves(repo.service);
    assert(tree.entries.find((entry) => entry.path === "docs/c-copy.md")?.docId === null, "a copy is a new document");
    await fs.rm(path.join(repo.dir, "docs/renamed.md"));
    tree = await treeWithMoves(repo.service);
    assert(tree.virtual.length === 1 && tree.virtual[0].reason === "missing" && tree.virtual[0].open === 1, `virtual ${JSON.stringify(tree.virtual)}`);
    const ghost = await documentView(repo.service, "docs/renamed.md");
    assert(ghost.document.missing && ghost.annotations.length === 1, "the deleted document opens with its annotation");
    await acknowledgeDeletion(repo.service, { docId: view.document.docId! });
    tree = await treeWithMoves(repo.service);
    assert(tree.virtual[0]?.reason === "removed", "acknowledged deletion stays while annotations are open");
    // Ambiguous: two similar candidates → a proposal, nothing moved until the user answers.
    const amb = await documentView(repo.service, "docs/amb.md");
    await fs.rm(path.join(repo.dir, "docs/amb.md"));
    await repo.write("docs/one.md", "# M\n\nодин\n\nдва\n\nтри и ещё\n");
    await repo.write("docs/two.md", "# M\n\nодин\n\nдва\n\nтри иначе\n");
    tree = await treeWithMoves(repo.service);
    const proposal = tree.moves.proposals.find((entry) => entry.docId === amb.document.docId);
    assert(proposal && proposal.candidates.length === 2 && !tree.moves.applied.length, "ambiguous rename is asked");
    await resolveMove(repo.service, { docId: amb.document.docId!, to: "docs/two.md" });
    tree = await treeWithMoves(repo.service);
    assert(tree.entries.find((entry) => entry.path === "docs/two.md")?.docId === amb.document.docId, "the user's answer is recorded");
    const report = await repo.service.validate(10);
    assert(report.ok, `validate: ${JSON.stringify(report.problems.slice(0, 3))}`);
    return "rename applied, copy new, deletion virtual, ambiguous asked; validate OK";
  });

  await step("W-04 hide / untrack: inherited rule with a point exception, CAS conflict merged, resumed base (AC09, A7)", async () => {
    const repo = await scratch(work, "rules", { "docs/a/x.md": "# X\n", "docs/a/y.md": "# Y\n", "docs/b.md": "# B\n" });
    await setRule(repo.service, { list: "hidden", path: "docs/a", isDir: true, action: "add" });
    await setRule(repo.service, { list: "hidden", path: "docs/a/x.md", isDir: false, action: "remove" });
    let tree = await documentTree(repo.service);
    const x = tree.entries.find((entry) => entry.path === "docs/a/x.md")!;
    const y = tree.entries.find((entry) => entry.path === "docs/a/y.md")!;
    assert(!x.hidden && y.hidden && y.hiddenFrom === "docs/a/", "inherited from the directory, x excepted");
    const seen = await configSha(repo.service);
    const current = JSON.parse(new TextDecoder().decode((await repo.service.store.read(layout.config))!));
    await writeConfig(repo.service.store, canonicalBytes({ ...current, hidden: [...current.hidden, "/docs/b.md"] }), seen);
    const merged = await setRule(repo.service, { list: "untracked", path: "docs/b.md", isDir: false, action: "add", configSha: seen });
    assert(merged.merged === true, "the concurrent change was detected");
    tree = await documentTree(repo.service);
    const b = tree.entries.find((entry) => entry.path === "docs/b.md")!;
    assert(b.hidden && b.untracked, "both rules kept");
    await repo.write("docs/b.md", "# B\n\nправка во время паузы\n");
    const resumed = await setRule(repo.service, { list: "untracked", path: "docs/b.md", isDir: false, action: "remove" });
    const view = await documentView(repo.service, "docs/b.md");
    assert(resumed.resumed === 1 && view.unread === 0 && view.document.trackingResumed !== null, "resumed: new base, pause marked");
    return "hide/except/untrack/CAS/resume ok";
  });
}
