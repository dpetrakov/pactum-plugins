// W-04 catalog on a real checkout (EP-011-T01…T04): the tree of several roots, unsupported files, symlinks and
// service directories; search; hide / untrack with inherited rules and point exceptions; CAS conflicts of
// config.json; tracking resumed as a new base; rename / copy / delete with virtual documents.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalBytes } from "../core/canonical-json.ts";
import { layout, writeConfig } from "../core/store.ts";
import { acknowledgeDeletion, configSha, resolveMove, setRule, treeWithMoves } from "../node/catalog.ts";
import { locateFile } from "../node/checkout.ts";
import { ReviewService } from "../node/service.ts";
import { documentTree, searchIndex } from "../node/tree.ts";
import { documentView } from "../node/view.ts";

async function repo(files, { roots } = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-cat-")));
  const run = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.name", "Owner");
  run("config", "user.email", "owner@bb-docs.invalid");
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), text);
  }
  run("add", "-A");
  run("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "init", "--allow-empty");
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-cat-data-"));
  const service = new ReviewService(dir, data);
  if (roots !== null) await service.enable({ roots });
  return { dir, data, service, run, write: (file, text) => fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true }).then(() => fs.writeFile(path.join(dir, file), text)),
    cleanup: () => Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]) };
}

const entryOf = (tree, file) => tree.entries.find((entry) => entry.path === file);

test("tree: several roots and a file root once each; reviewable types listed (W-06c), other files, wave-2 types and symlinks counted", async () => {
  const r = await repo({
    "docs/a.md": "# A\n\nтекст\n", "docs/sub/B.MD": "# B\n", "docs/x.mdx": "# mdx\n", "docs/pic.png": "png", "docs/notes.markdown": "# N\n",
    "docs/design/wireframe.html": "<p>", "docs/evidence/shot.png": "png", "docs/evidence/log.txt": "x",
    "README.md": "# Readme\n", "guides/g.md": "# G\n",
  }, { roots: ["docs", "docs/a.md", "README.md", "guides"] });
  try {
    await fs.mkdir(path.join(r.dir, "docs/node_modules/pkg"), { recursive: true });
    await r.write("docs/node_modules/pkg/readme.md", "# dep\n");
    await fs.symlink(path.join(r.dir, "guides/g.md"), path.join(r.dir, "docs/inside-link.md"));
    await fs.symlink("/etc/hosts", path.join(r.dir, "docs/outside-link.md"));
    const tree = await documentTree(r.service, { budgetMs: 30_000 });
    const paths = tree.entries.map((entry) => entry.path);
    assert.equal(paths.filter((file) => file === "docs/a.md").length, 1, "overlapping roots list a file once");
    assert.ok(paths.includes("README.md") && paths.includes("guides/g.md"));
    assert.equal(entryOf(tree, "docs/sub/B.MD").supported, true, ".MD is Markdown regardless of case");
    assert.equal(entryOf(tree, "docs/notes.markdown").supported, true);
    // W-06c: every type of the registry is listed (text here); wave-2 types, images and symlinks are not sent at all.
    assert.equal(entryOf(tree, "docs/evidence/log.txt").format, "text");
    assert.ok(tree.entries.every((entry) => entry.supported && entry.kind === "file"), "only reviewable files are listed");
    for (const file of ["docs/x.mdx", "docs/pic.png", "docs/design/wireframe.html", "docs/evidence/shot.png", "docs/inside-link.md", "docs/outside-link.md"]) assert.equal(entryOf(tree, file), undefined, `${file} is not listed`);
    assert.ok(!paths.some((file) => file.startsWith("docs/design/")), "a folder without reviewable files has no entries, so no tree node");
    assert.deepEqual(tree.skipped, { other: 4, symlinks: 2 }, "what is not shown is counted");
    assert.deepEqual(tree.notShown.types, { wave2: 2, other: 2, disabled: 0 });
    assert.deepEqual(tree.notShown.rules.map((rule) => [rule.level, rule.pattern, rule.dirs]), [["builtin", "node_modules/", 1]]);
    assert.deepEqual(tree.excluded, ["docs/node_modules"]);
    assert.ok(!paths.some((file) => file.includes("node_modules")));
    assert.equal(entryOf(tree, "docs/a.md").state, "read", "the initial base is read (F1)");
    assert.equal(entryOf(tree, "docs/a.md").unread, 0);
    // A new document after enabling is «new»; an edited one is unread with a count.
    await r.write("docs/new.md", "# New\n");
    await r.write("docs/a.md", "# A\n\nтекст изменён\n\nещё абзац\n");
    const after = await documentTree(r.service);
    assert.equal(entryOf(after, "docs/new.md").state, "new");
    assert.equal(entryOf(after, "docs/a.md").state, "unread");
    assert.equal(entryOf(after, "docs/a.md").unread, 2);
    assert.equal(after.totals.unreadDocs, 1);
    const found = await searchIndex(r.service, after, "изменён");
    assert.deepEqual(found.results, []);
    const byHeading = await searchIndex(r.service, after, "readme");
    assert.ok(byHeading.results.some((entry) => entry.path === "README.md" && entry.heading === null), "path match");
    assert.ok(byHeading.results.some((entry) => entry.path === "README.md" && entry.heading === "Readme"), "heading match");
  } finally {
    await r.cleanup();
  }
});

test("tree: the default root is «.» (F1); a missing root creates nothing and directories with reviewable files are offered (A1)", async () => {
  const r = await repo({ "manual/intro.md": "# Intro\n", "src/code.ts": "x", "TOP.md": "# Top\n" }, { roots: null });
  try {
    const whole = await documentTree(r.service);
    assert.equal(whole.enabled, false);
    assert.deepEqual(whole.roots, ["."], "W-06c F1: the whole repository by default");
    assert.deepEqual(whole.entries.map((entry) => entry.path), ["TOP.md", "manual/intro.md"], "code is not a reviewable type");
    const tree = await documentTree(r.service, { roots: ["docs"] });
    assert.deepEqual(tree.missingRoots, ["docs"]);
    assert.deepEqual(tree.suggestions, [".", "manual"]);
    assert.equal(await fs.access(path.join(r.dir, "docs")).then(() => true, () => false), false, "docs is not created");
    const chosen = await documentTree(r.service, { roots: ["manual"] });
    assert.deepEqual(chosen.entries.map((entry) => entry.path), ["manual/intro.md"]);
  } finally {
    await r.cleanup();
  }
});

test("rules: hide and untrack are independent, inherited with a point exception, reversible (AC09)", async () => {
  const r = await repo({ "docs/a/x.md": "# X\n\nодин\n", "docs/a/y.md": "# Y\n", "docs/b.md": "# B\n" });
  try {
    let result = await setRule(r.service, { list: "hidden", path: "docs/a", isDir: true, action: "add" });
    assert.equal(result.status, "published");
    let tree = await documentTree(r.service);
    assert.equal(entryOf(tree, "docs/a/x.md").hidden, true);
    assert.equal(entryOf(tree, "docs/a/x.md").hiddenFrom, "docs/a/", "inherited from the directory");
    assert.equal(entryOf(tree, "docs/a/x.md").state, "read", "hiding does not stop tracking (A6)");
    assert.equal((await searchIndex(r.service, tree, "X")).results.length, 0, "hidden: not in search");
    assert.ok((await searchIndex(r.service, tree, "X", { showHidden: true })).results.length > 0, "«Показать скрытые» returns it");
    await setRule(r.service, { list: "hidden", path: "docs/a/x.md", isDir: false, action: "remove" });
    tree = await documentTree(r.service);
    assert.equal(entryOf(tree, "docs/a/x.md").hidden, false, "point exception");
    assert.equal(entryOf(tree, "docs/a/y.md").hidden, true);
    await setRule(r.service, { list: "hidden", path: "docs/a", isDir: true, action: "remove" });
    tree = await documentTree(r.service);
    assert.equal(entryOf(tree, "docs/a/y.md").hidden, false);
    assert.deepEqual(tree.hiddenRules, [], "reversible: no leftover rules");

    // Untrack b, edit it during the pause, resume: the current revision becomes the base (A7).
    await setRule(r.service, { list: "untracked", path: "docs/b.md", isDir: false, action: "add" });
    await r.write("docs/b.md", "# B\n\nправка во время паузы\n");
    tree = await documentTree(r.service);
    assert.equal(entryOf(tree, "docs/b.md").state, "untracked");
    assert.equal(entryOf(tree, "docs/b.md").hidden, false, "untracking does not hide");
    const paused = await documentView(r.service, "docs/b.md");
    assert.equal(paused.unread, 0, "no unread marks while untracked (A6)");
    result = await setRule(r.service, { list: "untracked", path: "docs/b.md", isDir: false, action: "remove" });
    assert.equal(result.resumed, 1);
    tree = await documentTree(r.service);
    assert.equal(entryOf(tree, "docs/b.md").state, "read", "the pause is not unread …");
    const resumed = await documentView(r.service, "docs/b.md");
    assert.equal(resumed.unread, 0);
    assert.ok(resumed.document.trackingResumed, "… and is marked «не отслеживался» instead of claimed read");
    await r.write("docs/b.md", "# B\n\nправка во время паузы\n\nпосле возобновления\n");
    assert.equal((await documentView(r.service, "docs/b.md")).unread, 1, "changes after resuming are unread again");
  } finally {
    await r.cleanup();
  }
});

test("rules: a concurrent change of config.json is re-read and the rule applied to it, not lost", async () => {
  const r = await repo({ "docs/a.md": "# A\n", "docs/b.md": "# B\n" });
  try {
    const seen = await configSha(r.service);
    // Someone else hides b meanwhile (another window, a hand edit).
    const current = JSON.parse(new TextDecoder().decode(await r.service.store.read(layout.config)));
    await writeConfig(r.service.store, canonicalBytes({ ...current, hidden: ["/docs/b.md"] }), seen);
    const result = await setRule(r.service, { list: "hidden", path: "docs/a.md", isDir: false, action: "add", configSha: seen });
    assert.equal(result.status, "published");
    assert.equal(result.merged, true, "the conflict is reported");
    const tree = await documentTree(r.service);
    assert.equal(entryOf(tree, "docs/a.md").hidden, true);
    assert.equal(entryOf(tree, "docs/b.md").hidden, true, "the other change survives");
  } finally {
    await r.cleanup();
  }
});

test("rename keeps annotations and reading; copy is a new document; delete is a virtual entry (AC08)", async () => {
  const r = await repo({ "docs/a.md": "# A\n\nпервый абзац\n\nвторой абзац\n", "docs/c.md": "# C\n\nкопируемый\n" });
  try {
    const view = await documentView(r.service, "docs/a.md");
    const created = await r.service.annotate({ path: "docs/a.md", observation: { sha: view.document.sha }, text: "уточнить", kind: "action", targetKind: "block", block: 1 });
    // Rename with the same bytes: applied automatically, history follows.
    await fs.rename(path.join(r.dir, "docs/a.md"), path.join(r.dir, "docs/renamed.md"));
    const tree = await treeWithMoves(r.service);
    assert.deepEqual(tree.moves.applied.map((move) => [move.from, move.to]), [["docs/a.md", "docs/renamed.md"]]);
    assert.equal(entryOf(tree, "docs/renamed.md").docId, view.document.docId, "the same document");
    assert.equal(entryOf(tree, "docs/renamed.md").open, 1);
    assert.equal(entryOf(tree, "docs/renamed.md").state, "read", "reading kept");
    const moved = await documentView(r.service, "docs/renamed.md");
    assert.equal(moved.annotations[0].annotationId, created.annotationId);
    assert.equal(moved.annotations[0].anchor.status, "exact");

    // Copy: the original stays, the copy gets its own document.
    await r.write("docs/c-copy.md", "# C\n\nкопируемый\n");
    const copied = await treeWithMoves(r.service);
    assert.equal(copied.moves.applied.length, 0);
    assert.equal(entryOf(copied, "docs/c-copy.md").docId, null);
    assert.equal(entryOf(copied, "docs/c-copy.md").state, "new");
    assert.notEqual(entryOf(copied, "docs/c.md").docId, null);

    // Delete: a virtual entry with its annotation; the view shows the last revision; acknowledging removes it.
    await fs.rm(path.join(r.dir, "docs/renamed.md"));
    const gone = await treeWithMoves(r.service);
    assert.deepEqual(gone.virtual.map((entry) => [entry.path, entry.reason, entry.open]), [["docs/renamed.md", "missing", 1]]);
    const ghost = await documentView(r.service, "docs/renamed.md");
    assert.equal(ghost.document.missing, true);
    assert.equal(ghost.document.deletionUnread, true);
    assert.equal(ghost.context.writable, false);
    assert.equal(ghost.annotations.length, 1, "annotations stay reachable");
    await acknowledgeDeletion(r.service, { docId: view.document.docId });
    const acknowledged = await treeWithMoves(r.service);
    assert.deepEqual(acknowledged.virtual.map((entry) => [entry.reason, entry.open]), [["removed", 1]], "stays while it has open annotations");
    assert.equal((await documentView(r.service, "docs/renamed.md")).document.deletionUnread, false);
  } finally {
    await r.cleanup();
  }
});

test("ambiguous rename is asked, never moved silently; the user's answer is recorded", async () => {
  const r = await repo({ "docs/a.md": "# A\n\nабзац один\n\nабзац два\n\nабзац три\n" });
  try {
    const before = await documentView(r.service, "docs/a.md");
    await fs.rm(path.join(r.dir, "docs/a.md"));
    await r.write("docs/one.md", "# A\n\nабзац один\n\nабзац два\n\nабзац три изменён\n");
    await r.write("docs/two.md", "# A\n\nабзац один\n\nабзац два\n\nабзац три другой\n");
    const tree = await treeWithMoves(r.service);
    assert.equal(tree.moves.applied.length, 0);
    assert.equal(tree.moves.proposals.length, 1);
    assert.deepEqual(tree.moves.proposals[0].candidates.map((candidate) => candidate.path).sort(), ["docs/one.md", "docs/two.md"]);
    await resolveMove(r.service, { docId: before.document.docId, to: "docs/two.md" });
    const after = await treeWithMoves(r.service);
    assert.equal(entryOf(after, "docs/two.md").docId, before.document.docId);
    assert.equal(entryOf(after, "docs/two.md").state, "unread", "the edit made with the move is unread");
    assert.equal(after.moves.proposals.length, 0);
    await assert.rejects(resolveMove(r.service, { docId: before.document.docId, to: "docs/one.md" }), /still exists/);
  } finally {
    await r.cleanup();
  }
});

test("tree of 200 files stays fast (the full H7 measurement is a step of `bb document-review check`)", async () => {
  const files = {};
  const paragraph = "Текст абзаца для замера дерева документов. ".repeat(6);
  for (let index = 0; index < 200; index++) files[`docs/d${Math.floor(index / 50)}/f${index}.md`] = `# Документ ${index}\n\n${Array.from({ length: 22 }, () => paragraph).join("\n\n")}\n`;
  const r = await repo(files);
  try {
    await documentTree(r.service);
    const started = performance.now();
    const tree = await documentTree(r.service);
    const ms = performance.now() - started;
    assert.equal(tree.entries.length, 200);
    assert.equal(tree.totals.unreadDocs, 0);
    assert.ok(ms < 2000, `tree took ${Math.round(ms)} ms`);
  } finally {
    await r.cleanup();
  }
});

test("file opener: an absolute host file resolves to its Git checkout and repo path; outside a repository it is refused", async () => {
  const r = await repo({ "docs/deep/x.md": "# X\n" });
  try {
    assert.deepEqual(await locateFile(path.join(r.dir, "docs/deep/x.md")), { root: r.dir, relative: "docs/deep/x.md" });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-plain-"));
    await fs.writeFile(path.join(outside, "y.md"), "# Y\n");
    await assert.rejects(locateFile(path.join(outside, "y.md")), (error) => error.code === "not-a-repo");
    await assert.rejects(locateFile("relative.md"), (error) => error.code === "bad-path");
    await fs.rm(outside, { recursive: true, force: true });
  } finally {
    await r.cleanup();
  }
});

test("review fixes: names that .gitignore would read as patterns are refused; isDir comes from the disk", async () => {
  const r = await repo({ "docs/[draft].md": "# D\n", "docs/a.md": "# A\n", "docs/sub/x.md": "# X\n" });
  try {
    await assert.rejects(setRule(r.service, { list: "hidden", path: "docs/[draft].md", isDir: false, action: "add" }), /pattern/);
    await assert.rejects(setRule(r.service, { list: "hidden", path: "x\n*.md", isDir: false, action: "add" }), /pattern|repo-relative/);
    await assert.rejects(setRule(r.service, { list: "untracked", path: "docs/sub", isDir: false, action: "add" }), /directory/);
    const tree = await documentTree(r.service);
    assert.deepEqual(tree.hiddenRules, []);
    assert.deepEqual(tree.untrackedRules, []);
  } finally {
    await r.cleanup();
  }
});

test("review fixes: a document missing because of the checked-out branch is proposed, never moved automatically", async () => {
  const r = await repo({ "docs/a.md": "# A\n\nтекст\n" });
  try {
    r.run("checkout", "-q", "-b", "other");
    r.run("mv", "docs/a.md", "docs/b.md");
    r.run("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "rename on a branch");
    const tree = await treeWithMoves(r.service);
    assert.equal(tree.moves.applied.length, 0, "HEAD does not have docs/a.md: no automatic move");
    assert.deepEqual(tree.moves.proposals.map((proposal) => proposal.from), ["docs/a.md"]);
  } finally {
    await r.cleanup();
  }
});

test("review fixes: locateFile refuses a symlink on the way and files of other types", async () => {
  const r = await repo({ "docs/a.md": "# A\n" });
  try {
    await fs.symlink(path.join(r.dir, "docs"), path.join(r.dir, "linked"));
    await assert.rejects(locateFile(path.join(r.dir, "linked/a.md")), (error) => error.code === "symlink");
    // W-06c: every type of the registry opens (text included); other files do not.
    await fs.writeFile(path.join(r.dir, "docs/x.png"), "x");
    await assert.rejects(locateFile(path.join(r.dir, "docs/x.png")), (error) => error.code === "bad-path");
  } finally {
    await r.cleanup();
  }
});
