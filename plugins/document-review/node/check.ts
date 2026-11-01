// End-to-end check of the core on a temporary clone (EP-007-T06; the wave's manual_check as a repeatable
// command). The source repository is only cloned, never written. Everything happens on the machine the
// host entry runs on, so the same check proves local (the local host) and remote (the remote host) behaviour.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { canonicalJson } from "../core/canonical-json.ts";
import { discussion } from "../core/discussion.ts";
import { tr } from "../core/i18n.ts";
import { sha256 } from "../core/hash.ts";
import { entity, loadRepository, project } from "../core/journal.ts";
import { buildRevision, project as projectMarkdown, resolveAnchor } from "../core/markdown/index.ts";
import { readState } from "../core/reading.ts";
import { SCHEMA_VERSION } from "../core/schema.ts";
import { CrashingBackend, layout, publish, StoreError } from "../core/store.ts";
import type { Revision } from "../core/types.ts";
import { validate } from "../core/validate.ts";
import { git, resolveCheckout } from "./checkout.ts";
import { loopSteps } from "./check-loop.ts";
import { catalogSteps } from "./check-catalog.ts";
import { w05PerformanceSteps, w05ReliabilitySteps } from "./check-w05.ts";
import { FsBackend } from "./fs-backend.ts";
import { ReviewError, ReviewService } from "./service.ts";
import { randomBytes } from "node:crypto";
import { documentGet } from "./batches.ts";
import { documentText, documentView } from "./view.ts";
import { exclusionsFor, walkRoots } from "./walk.ts";

type Watch = (options: { rootPath: string; ignoredPaths?: readonly string[]; debounceMs?: number; maxWaitMs?: number }, listener: (event: { kind: string; changes?: readonly { path: string; type: string }[] }) => void | Promise<void>) => Promise<{ dispose(): Promise<void> }>;

export interface CheckStep {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface CheckReport {
  ok: boolean;
  durationMs: number;
  host: string;
  source: string;
  steps: CheckStep[];
  measurements: Record<string, string>;
  kept: string | null;
}

const DOC_DIR = "docs/review-check";

/** Git inside temporary clones: hooks of the user's global configuration never run there. */
function gx(cwd: string, args: string[], options?: Parameters<typeof git>[2]) {
  return git(cwd, ["-c", "core.hooksPath=/dev/null", ...args], options);
}

export const CHECK_DOCS: Record<string, string> = {
  "guide.md": [
    "# Руководство",
    "",
    "Вступление с [ссылкой](https://example.com/a) и эмодзи 👩‍💻 в одном абзаце.",
    "Вторая строка того же абзаца.",
    "",
    "Второй абзац: проверка выделения через два блока 🚀.",
    "",
    "## Повтор",
    "",
    "Одинаковый абзац.",
    "",
    "## Ещё повтор",
    "",
    "Одинаковый абзац.",
    "",
    "## Таблица",
    "",
    "| Ключ | Значение |",
    "|------|----------|",
    "| a    | один     |",
    "",
  ].join("\n"),
  "notes.md": "# Заметки\n\n- [ ] задача\n- [x] сделано\n\nТекст заметок.\n",
};

async function exists(file: string) {
  return fs.access(file).then(() => true, () => false);
}

async function commitAll(dir: string, message: string) {
  await gx(dir, ["add", "-A"]);
  await gx(dir, ["commit", "-q", "--no-verify", "-m", message], { allowFailure: true });
}

/** Summary of everything a user would see: annotations, discussions and unread state per document. */
export async function summary(service: ReviewService, readerId: string) {
  const state = project(await loadRepository(service.store));
  const annotations = [...state.byEntity.keys()].filter((key) => key.startsWith("annotation:")).sort().map((key) => {
    const view = discussion(state, key.slice("annotation:".length));
    return { id: view.annotationId, status: view.status, kind: view.kind, messages: view.messages.map((message) => message.current?.text ?? null) };
  });
  const documents = [...state.documents.values()].sort((a, b) => (a.docId < b.docId ? -1 : 1)).map((doc) => ({
    docId: doc.docId, path: doc.path, heads: doc.headRevisions,
    incomplete: state.incomplete.get(`doc:${doc.docId}`) ?? [],
    read: doc.headRevisions.map((revisionId) => {
      // Incomplete data (a crafted or half-committed bundle) is reported, not thrown.
      try {
        const result = readState(state, readerId, revisionId);
        return { revisionId, unread: result.unread, blocks: result.blocks.map((block) => block.state) };
      } catch (error) {
        return { revisionId, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  }));
  return canonicalJson({ annotations, documents });
}

export async function runCheck(input: { source: string; dataDir: string; tempDir: string; keep: boolean; watch: Watch | null }): Promise<CheckReport> {
  const work = await fs.mkdtemp(path.join(input.keep ? os.tmpdir() : input.tempDir, "bb-docs-check-"));
  try {
    return await runCheckIn(work, input);
  } finally {
    // The temporary clone is removed on every outcome, including failures outside a step.
    if (!input.keep) await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runCheckIn(work: string, input: { source: string; dataDir: string; tempDir: string; keep: boolean; watch: Watch | null }): Promise<CheckReport> {
  const started = performance.now();
  const steps: CheckStep[] = [];
  const measurements: Record<string, string> = {};
  const dataDir = path.join(work, "data");
  const step = async (name: string, run: () => Promise<string | void>) => {
    try {
      const detail = await run();
      steps.push({ name, ok: true, ...(detail ? { detail } : {}) });
    } catch (error) {
      steps.push({ name, ok: false, detail: error instanceof Error ? `${error.message}` : String(error) });
    }
  };
  const expectError = async (code: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      if (error instanceof ReviewError && error.code === code) return error;
      if (error instanceof Error && (error as { code?: string }).code === code) return error;
      throw new Error(`expected ${code}, got ${error instanceof Error ? `${(error as { code?: string }).code ?? ""} ${error.message}` : String(error)}`);
    }
    throw new Error(`expected ${code}, but it succeeded`);
  };
  const assert = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
  };

  const source = await resolveCheckout(input.source);
  if (!source.isRepo) throw new ReviewError("not-a-repo", `${input.source} is not a Git repository`);
  const a = path.join(work, "a");
  const b = path.join(work, "b");
  const email = "check@bb-docs.invalid";

  // ── setup: clone, fixture documents, identity of the clone ─────────────
  await step("clone source into a temporary directory (source untouched)", async () => {
    const t0 = performance.now();
    await gx(work, ["clone", "-q", "--no-hardlinks", source.root, a], { timeoutMs: 300_000 });
    measurements["clone"] = `${Math.round(performance.now() - t0)} ms`;
    await gx(a, ["config", "user.name", "Check Reader"]);
    await gx(a, ["config", "user.email", email]);
    await gx(a, ["config", "commit.gpgsign", "false"]);
    await fs.rm(path.join(a, ".bb-docs"), { recursive: true, force: true });
    await fs.mkdir(path.join(a, DOC_DIR), { recursive: true });
    for (const [name, text] of Object.entries(CHECK_DOCS)) await fs.writeFile(path.join(a, DOC_DIR, name), text);
    await commitAll(a, "check: fixture documents");
    return source.branch ? `branch ${source.branch}` : "detached";
  });

  let service = new ReviewService((await resolveCheckout(a)).root, dataDir);
  const docPath = `${DOC_DIR}/guide.md`;

  await step("identity from the checkout's effective Git config (repository, worktree, includeIf)", async () => {
    const info = await resolveCheckout(a);
    assert(info.identity.email === email, `repository config: got ${info.identity.email}`);
    const included = path.join(work, "included.gitconfig");
    await fs.writeFile(included, "[user]\n\temail = included@bb-docs.invalid\n");
    // gitdir pattern of the checkout directory (trailing slash: the .git inside it), as users write it.
    await gx(a, ["config", `includeIf.gitdir:${info.root}/.path`, included]);
    await gx(a, ["config", "--unset", "user.email"]);
    const viaInclude = await resolveCheckout(a);
    await gx(a, ["config", "--unset-all", `includeIf.gitdir:${info.root}/.path`]);
    await gx(a, ["config", "user.email", email]);
    assert(viaInclude.identity.email === "included@bb-docs.invalid", `includeIf: got ${viaInclude.identity.email}`);
    const tree = path.join(work, "wt");
    await gx(a, ["worktree", "add", "-q", "-b", "check-worktree", tree]);
    await gx(a, ["config", "extensions.worktreeConfig", "true"]);
    await gx(tree, ["config", "--worktree", "user.email", "worktree@bb-docs.invalid"]);
    const worktree = await resolveCheckout(tree);
    await gx(a, ["worktree", "remove", "--force", tree]);
    await gx(a, ["config", "--unset", "extensions.worktreeConfig"]);
    assert(worktree.isWorktree && worktree.identity.email === "worktree@bb-docs.invalid", `worktree: got ${worktree.identity.email}`);
    return "repository, includeIf and per-worktree user.email are respected";
  });

  await step("confinement: .., absolute paths and symlinks out of the repository are refused", async () => {
    await expectError("bad-path", () => service.readDocument("../outside.md"));
    await expectError("bad-path", () => service.readDocument("/etc/hosts"));
    await expectError("bad-path", () => service.readDocument(".git/config"));
    await expectError("not-supported", () => service.readDocument("program.ts"));
    await fs.symlink(os.tmpdir(), path.join(a, DOC_DIR, "escape"));
    await expectError("outside-repo", () => service.readDocument(`${DOC_DIR}/escape/x.md`));
    await fs.symlink("guide.md", path.join(a, DOC_DIR, "alias.md"));
    await expectError("symlink", () => service.readDocument(`${DOC_DIR}/alias.md`));
    await fs.rm(path.join(a, DOC_DIR, "escape"));
    await fs.rm(path.join(a, DOC_DIR, "alias.md"));
  });

  await step("enable: plan shows storage and volume before writing; initial base", async () => {
    const plan = await service.enablePlan([DOC_DIR]);
    assert(plan.documents === 2 && !plan.alreadyEnabled, `plan: ${plan.documents} documents`);
    const result = await service.enable({ roots: [DOC_DIR], head: plan.head });
    assert(result.created && result.documents === 2, "enable");
    const report = await service.validate();
    assert(report.ok, `validate after enable: ${JSON.stringify(report.problems.slice(0, 3))}`);
    return `${plan.documents} documents, ${plan.snapshotBytes} bytes of snapshots, ignoredByGit=${plan.ignoredByGit}`;
  });

  // Observation A: the baseline revision, as a client would hold it.
  const shownA = await service.readDocument(docPath);
  const projectionA = projectMarkdown(shownA.text);
  const textA = [...projectionA.text];
  const find = (projectionText: string[], needle: string) => {
    const index = projectionText.join("").indexOf(needle);
    if (index < 0) throw new Error(`fixture text not found: ${needle}`);
    return [...projectionText.join("").slice(0, index)].length;
  };
  let annotationId = "";

  await step("W-06c: secrets are not visible — .env, a YAML secret key, a PEM in text and an ignored .env.local open only redacted (read, text, view, document get); writes on a file outside Git are refused", async () => {
    // Values are made up here and never written anywhere but this temporary clone.
    const values = [0, 1, 2, 3].map(() => `chk${randomBytes(9).toString("hex")}`);
    await fs.writeFile(path.join(a, ".env"), `API_TOKEN=${values[0]}\n`);
    await fs.writeFile(path.join(a, "secrets-check.yaml"), `db:\n  password: ${values[1]}\nname: x\n`);
    await fs.writeFile(path.join(a, "secrets-check.txt"), `-----BEGIN PRIVATE KEY-----\n${values[2]}\n-----END PRIVATE KEY-----\n`);
    const gitignore = await fs.readFile(path.join(a, ".gitignore"), "utf8").catch(() => null);
    await fs.writeFile(path.join(a, ".gitignore"), `${gitignore ?? ""}${gitignore && !gitignore.endsWith("\n") ? "\n" : ""}${DOC_DIR}/.env.local\n`);
    await fs.writeFile(path.join(a, DOC_DIR, ".env.local"), `LOCAL=${values[3]}\n`);
    service.invalidate();
    const outputs: string[] = [];
    for (const file of [".env", "secrets-check.yaml", "secrets-check.txt", `${DOC_DIR}/.env.local`]) {
      outputs.push(JSON.stringify(await service.readDocument(file)));
      outputs.push(JSON.stringify(await documentText(service, file)));
      outputs.push(JSON.stringify(await documentView(service, file)));
      outputs.push(JSON.stringify(await documentGet(service, { path: file })));
    }
    const leaked = values.filter((value) => outputs.some((output) => output.includes(value) || output.includes(value.slice(0, 8))));
    assert(!leaked.length, `secret values visible: ${leaked.length}`);
    const local = await documentView(service, `${DOC_DIR}/.env.local`);
    assert(local.fileClass === "outside", `.env.local class ${local.fileClass}`);
    await expectError("outside-git", () => service.annotate({ path: `${DOC_DIR}/.env.local`, observation: { sha: local.document.sha }, text: "x", kind: "note", targetKind: "document" }));
    for (const file of [".env", "secrets-check.yaml", "secrets-check.txt", `${DOC_DIR}/.env.local`]) await fs.rm(path.join(a, file));
    if (gitignore === null) await fs.rm(path.join(a, ".gitignore"));
    else await fs.writeFile(path.join(a, ".gitignore"), gitignore);
    service.invalidate();
    return `4 files, ${outputs.length} outputs, 0 values; .env.local shown only`;
  });

  await step("W-06c: the walk from «.» — registry types, Git classes (in Git / new / outside), built-in exclusions; a .env outside Git is shown only", async () => {
    const base = "w06c-walk";
    const files: Record<string, string> = { [`${base}/app.yaml`]: "a: 1\n", [`${base}/data.csv`]: "a,b\n1,2\n", [`${base}/code.ts`]: "x", [`${base}/node_modules/dep/readme.md`]: "# dep\n",
      [`${base}/build/out.md`]: "# out\n", [`${base}/package-lock.json`]: "{}\n", [`${base}/.env`]: "TOKEN=x\n" };
    for (const [file, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(a, file)), { recursive: true }); await fs.writeFile(path.join(a, file), text); }
    const gitignore = await fs.readFile(path.join(a, ".gitignore"), "utf8").catch(() => null);
    await fs.writeFile(path.join(a, ".gitignore"), `${gitignore ?? ""}${gitignore && !gitignore.endsWith("\n") ? "\n" : ""}${base}/.env\n`);
    service.invalidate();
    const config = (await service.config()).value;
    const walked = await walkRoots(a, [base], { exclusions: await exclusionsFor(dataDir, config, null), budgetMs: 60_000 });
    const listed = [...walked.files.keys()];
    assert(listed.includes(`${base}/app.yaml`) && listed.includes(`${base}/data.csv`), `types: ${listed.join(", ")}`);
    assert(!listed.some((file) => file.includes("node_modules") || file.includes("/build/") || file.endsWith("package-lock.json") || file.endsWith(".ts")), `exclusions: ${listed.join(", ")}`);
    assert(listed.includes(`${base}/.env`), ".env is shown");
    assert((await service.fileClass(`${base}/.env`)) === "outside", ".env ignored by Git is outside Git");
    assert((await service.fileClass(`${base}/app.yaml`)) === "new", "an untracked file is new");
    const rules = walked.notShown.rules.map((rule) => `${rule.level}:${rule.pattern}`);
    assert(rules.includes("builtin:node_modules/") && rules.includes("builtin:build/"), `rules: ${rules.join(", ")}`);
    await fs.rm(path.join(a, base), { recursive: true, force: true });
    if (gitignore === null) await fs.rm(path.join(a, ".gitignore"));
    else await fs.writeFile(path.join(a, ".gitignore"), gitignore);
    service.invalidate();
    return `${listed.length} listed, not shown: ${rules.join(", ")}, ${walked.notShown.types.other} other`;
  });

  await step(tr("W-06c: local review: a file outside Git tracked locally: marks and an annotation in the local store of this machine and reader, nothing in .bb-docs or Git; “Forget” removes it",
    "W-06c: local review — a file outside Git tracked locally: marks and an annotation in the local store of this machine and reader, nothing in .bb-docs or Git; «Забыть» removes it"), async () => {
    const { localFor, localForget, localList, serviceForPath, trackLocally } = await import("./local.ts");
    const base = "w06c-local";
    const file = `${base}/notes.md`;
    await fs.mkdir(path.join(a, base), { recursive: true });
    await fs.writeFile(path.join(a, file), "# Локальные заметки\n\nАбзац.\n");
    const gitignore = await fs.readFile(path.join(a, ".gitignore"), "utf8").catch(() => null);
    await fs.writeFile(path.join(a, ".gitignore"), `${gitignore ?? ""}${gitignore && !gitignore.endsWith("\n") ? "\n" : ""}${base}/\n`);
    service.invalidate();
    const listing = async (root: string) => (await fs.readdir(root, { recursive: true }).catch(() => [] as string[])).map(String).sort();
    const before = await listing(path.join(a, ".bb-docs"));
    const statusBefore = (await git(a, ["status", "--porcelain"])).stdout;
    await trackLocally(service, { path: file, isDir: false, action: "add" });
    const local = await localFor(service);
    assert(local && (await serviceForPath(service, file)) === local, "the file is served by the local review");
    const shown = await documentView(local!, file);
    await local!.annotate({ path: file, observation: { sha: shown.document.sha }, text: "Только здесь", kind: "note", targetKind: "block", block: 1 });
    await local!.acknowledge({ path: file, observation: { sha: shown.document.sha }, scope: "document" });
    assert(JSON.stringify(await listing(path.join(a, ".bb-docs"))) === JSON.stringify(before), "nothing new in .bb-docs");
    // The check's clone may hold .bb-docs uncommitted: Git's view must simply not change by the local review.
    assert((await git(a, ["status", "--porcelain"])).stdout === statusBefore, "git status unchanged by the local review");
    const store = (await localList(service)).store ?? "";
    assert(store.startsWith(dataDir), "the local store is in the plugin's data directory of this machine");
    await localForget(service, { path: file });
    assert(!(await localList(service)).documents.some((doc) => doc.path === file), "forgotten");
    await fs.rm(path.join(a, base), { recursive: true, force: true });
    if (gitignore === null) await fs.rm(path.join(a, ".gitignore"));
    else await fs.writeFile(path.join(a, ".gitignore"), gitignore);
    service.invalidate();
    return "tracked, annotated and read locally; .bb-docs unchanged; forgotten";
  });

  await step("AC02: selection with a link, emoji and two paragraphs is saved with an exact quote", async () => {
    const start = find(textA, "ссылкой");
    const end = find(textA, "два блока") + [..."два блока"].length;
    const quote = textA.slice(start, end).join("");
    assert(quote.includes("👩‍💻") && quote.includes("\n\n"), `quote spans two blocks: ${JSON.stringify(quote)}`);
    const created = await service.annotate({ path: docPath, observation: { sha: shownA.sha }, range: { start, end }, quote, text: "Сократить вступление", kind: "action", head: shownA.head, branch: shownA.branch });
    annotationId = created.annotationId;
    assert(!created.promoted, "baseline revision is reused, not snapshotted again");
    const state = await service.state();
    const object = [...state.objects.values()].find((value) => value.type === "Annotation");
    assert(object && object.type === "Annotation", "annotation object");
    const selector = object!.type === "Annotation" ? object!.target.selector! : [];
    assert(selector[0].type === "TextQuoteSelector" && selector[0].exact === quote, "TextQuoteSelector.exact equals the selection");
    assert(object!.type === "Annotation" && object!.target["bbdr:segments"].length === 2, "two block segments");
    await expectError("quote-mismatch", () => service.annotate({ path: docPath, observation: { sha: shownA.sha }, range: { start, end }, quote: "другая цитата", text: "x", kind: "note" }));
  });

  await step("receipts: read the whole document at A", async () => {
    const receipt = await service.acknowledge({ path: docPath, observation: { sha: shownA.sha }, scope: "document", head: shownA.head });
    assert(receipt.staleBlocks === 0, "nothing stale");
    const read = await service.readStatus(docPath);
    assert(read.tracked && read.unread === 0, `unread after reading: ${read.tracked ? read.unread : "untracked"}`);
  });

  // B: text edited and moved; C: another edit while the user is still writing a comment on B.
  const fileA = path.join(a, docPath);
  const textB = CHECK_DOCS["guide.md"]
    .replace("Второй абзац: проверка выделения через два блока 🚀.", "Второй абзац переписан агентом: выделение через два блока 🚀 осталось.")
    .replace("## Таблица\n\n| Ключ | Значение |\n|------|----------|\n| a    | один     |\n", "")
    .replace("# Руководство\n", "# Руководство\n\n## Таблица\n\n| Ключ | Значение |\n|------|----------|\n| a    | один     |\n");
  let shownB: Awaited<ReturnType<ReviewService["readDocument"]>> | null = null;

  await step("AC23/AC28: a comment on shown B is saved to exact B after B→C, reload and host restart; snapshot precedes event", async () => {
    await fs.writeFile(fileA, textB);
    shownB = await service.readDocument(docPath);
    await fs.writeFile(fileA, `${textB}\nНовый абзац после показа.\n`);
    // "Restart": a fresh service instance (no runtime caches), same plugin data dir with observations.
    service = new ReviewService(service.root, dataDir);
    const projectionB = [...projectMarkdown(shownB.text).text];
    const start = find(projectionB, "переписан");
    const end = start + [..."переписан агентом"].length;
    const quote = projectionB.slice(start, end).join("");
    const created = await service.annotate({ path: docPath, observation: { sha: shownB.sha }, range: { start, end }, quote, text: "Уточнить формулировку", kind: "action", head: shownB.head });
    assert(created.promoted, "B was promoted to a persistent revision");
    const state = await service.state();
    const record = state.revisions.get(created.revisionId)!;
    const revision = state.objects.get(record.objectSha);
    assert(revision?.type === "Revision" && revision.snapshot === shownB.sha, "the target revision is exactly B");
    assert(state.snapshots.has(shownB.sha), "snapshot of B exists");
    const report = await service.validate();
    assert(report.ok, `validate: ${JSON.stringify(report.problems.slice(0, 3))}`);
    return `B ${shownB.sha.slice(0, 12)} persisted; disk already at C`;
  });

  await step("forged draft context is refused", async () => {
    await expectError("tampered", () => service.annotate({ path: docPath, observation: { sha: shownB!.sha, text: "подделка" }, range: { start: 0, end: 1 }, quote: "x", text: "x", kind: "note" }));
    await expectError("unverifiable", () => service.annotate({ path: docPath, observation: { sha: sha256("never shown") }, range: { start: 0, end: 1 }, quote: "x", text: "x", kind: "note" }));
  });

  await step("AC27: a late receipt of the older revision does not roll the base back", async () => {
    await service.acknowledge({ path: docPath, observation: { sha: shownB!.sha }, scope: "document" });
    const before = await service.readStatus(docPath);
    await service.acknowledge({ path: docPath, observation: { sha: shownA.sha }, scope: "document" });
    const after = await service.readStatus(docPath);
    assert(before.tracked && after.tracked && before.unread === after.unread, `unread ${before.tracked ? before.unread : "?"} → ${after.tracked ? after.unread : "?"}`);
    return `unread on disk (C) stays ${after.tracked ? after.unread : "?"}`;
  });

  await step("anchors after edit and move: exact on A, mapped/approximate/ambiguous on C — never a false exact", async () => {
    const state = await service.state();
    const shownC = await service.readDocument(docPath);
    const heads = state.documents.get(state.revisions.get([...state.revisions.keys()][0])!.docId)!.headRevisions;
    const head = state.objects.get(state.revisions.get(heads[0])!.objectSha) as Revision;
    const headSource = new TextDecoder("utf-8", { ignoreBOM: true }).decode((await service.store.read(layout.snapshot(head.snapshot)))!);
    const current = buildRevision({ revisionId: "00000000-0000-4000-8000-00000000c0c0", docId: head.docId, path: docPath, source: shownC.text, snapshot: shownC.sha, parents: [{ revision: head, source: headSource }] });
    const original = [...state.objects.values()].find((value) => value.type === "Annotation" && value.id.endsWith(annotationId));
    assert(original?.type === "Annotation", "first annotation");
    const targetRevision = state.objects.get(state.revisions.get(original!.type === "Annotation" ? original!.target["bbdr:revisionId"] : "")!.objectSha) as Revision;
    const targetSource = new TextDecoder("utf-8", { ignoreBOM: true }).decode((await service.store.read(layout.snapshot(targetRevision.snapshot)))!);
    const selectors = original!.type === "Annotation" ? original!.target.selector! : [];
    const quote = selectors.find((selector) => selector.type === "TextQuoteSelector")!;
    const position = selectors.find((selector) => selector.type === "TextPositionSelector")!;
    const resolution = resolveAnchor({
      revision: targetRevision, projection: projectMarkdown(targetSource),
      range: { start: position.type === "TextPositionSelector" ? position.start : 0, end: position.type === "TextPositionSelector" ? position.end : 0 },
      quote: quote.type === "TextQuoteSelector" ? { exact: quote.exact, prefix: quote.prefix, suffix: quote.suffix } : { exact: "", prefix: "", suffix: "" },
    }, current);
    if (resolution.status === "exact" || resolution.status === "mapped") {
      const text = [...current.projection.text];
      const found = resolution.ranges.map((range) => text.slice(range.start, range.end).join("")).join("");
      assert(found === (quote.type === "TextQuoteSelector" ? quote.exact : ""), `a ${resolution.status} anchor must quote the original text exactly`);
    }
    return `first annotation on C: ${resolution.status} (${resolution.evidence.slice(0, 3).join(", ")})`;
  });

  await step("crash at every publish step on the real file system: no dangling refs, retry completes", async () => {
    for (let crashAt = 0; crashAt < 3; crashAt++) {
      const state = await service.state();
      const bytes = new TextEncoder().encode(`crash ${crashAt}\n`);
      const docId = state.revisions.get([...state.revisions.keys()][0])!.docId;
      const parent = state.documents.get(docId)!.headRevisions[0];
      const parentRevision = state.objects.get(state.revisions.get(parent)!.objectSha) as Revision;
      const parentSource = new TextDecoder("utf-8", { ignoreBOM: true }).decode((await service.store.read(layout.snapshot(parentRevision.snapshot)))!);
      const { revision } = buildRevision({ revisionId: `00000000-0000-4000-8000-0000000000c${crashAt}`, docId, path: docPath, source: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes), snapshot: sha256(bytes), parents: [{ revision: parentRevision, source: parentSource }] });
      const operation = {
        schemaVersion: SCHEMA_VERSION, id: `00000000-0000-4000-8000-00000000ca5${crashAt}`, actor: { kind: "human" as const, name: "Check Reader", email },
        timestamp: new Date().toISOString(), parents: state.heads.get(entity.doc(docId)) ?? [],
        changes: [{ type: "document.observed" as const, docId, revisionId: revision.revisionId, revision: sha256(new TextEncoder().encode(canonicalJson(revision))), reason: "reference" as const }],
      };
      const draft = { operation, objects: [revision as never], snapshots: [bytes] };
      const crashing = new CrashingBackend(service.store, crashAt, "before");
      try {
        await publish(crashing, draft, { isKnownRevision: (id) => state.revisions.has(id) });
      } catch (error) {
        if (!(error instanceof StoreError) || error.code !== "crash") throw error;
      }
      service.invalidate();
      const mid = await service.validate();
      assert(mid.problems.every((problem) => !problem.code.startsWith("dangling")), `dangling after crash at ${crashAt}`);
      await publish(service.store, draft, { isKnownRevision: (id) => state.revisions.has(id) });
      service.invalidate();
    }
    const report = await service.validate();
    assert(report.ok, `validate: ${JSON.stringify(report.problems.slice(0, 3))}`);
  });

  await step("AC10 on the host: concurrent replies are both kept; a concurrent decision is refused as stale", async () => {
    await Promise.all([service.reply({ annotationId, text: "Ответ из окна 1" }), service.reply({ annotationId, text: "Ответ из окна 2" })]);
    const state = await service.state();
    const view = discussion(state, annotationId);
    assert(view.messages.filter((message) => message.current?.text.startsWith("Ответ из окна")).length === 2, "both replies");
    const heads = state.heads.get(entity.annotation(annotationId))!;
    const outcomes = await Promise.allSettled([
      service.decide({ annotationId, action: "close", expectedHeads: heads }),
      service.decide({ annotationId, action: "note", expectedHeads: heads }),
    ]);
    const stale = outcomes.filter((outcome) => outcome.status === "rejected" && (outcome.reason as ReviewError).code === "stale").length;
    assert(outcomes.filter((outcome) => outcome.status === "fulfilled").length === 1 && stale === 1, "one decision wins, the other is stale");
  });

  await step("AC01/AC12: commit, clone to b, independent writes, Git merge: no dangling refs, conflicts explicit", async () => {
    await commitAll(a, "check: review data");
    await gx(work, ["clone", "-q", "--no-hardlinks", a, b]);
    await gx(b, ["config", "user.name", "Check Reader B"]);
    await gx(b, ["config", "user.email", email]);
    await gx(b, ["config", "commit.gpgsign", "false"]);
    const serviceB = new ReviewService((await resolveCheckout(b)).root, path.join(work, "data-b"));
    // Same reader on another machine sees the same state after clone, without any plugin data (AC01 core).
    const left = await summary(service, email);
    const right = await summary(serviceB, email);
    assert(left === right, "state after clone equals the original");
    const headsA = (await service.state()).heads.get(entity.annotation(annotationId))!;
    // Both clones reopen if needed and reply; then contradicting decisions: close in a, withdraw in b.
    await service.reply({ annotationId, text: "Ветка a", reopen: true });
    await serviceB.reply({ annotationId, text: "Ветка b", reopen: true });
    await service.decide({ annotationId, action: "close", expectedHeads: (await service.state()).heads.get(entity.annotation(annotationId))! });
    await serviceB.decide({ annotationId, action: "withdraw", expectedHeads: (await serviceB.state()).heads.get(entity.annotation(annotationId))! });
    await commitAll(a, "check: a");
    await commitAll(b, "check: b");
    await gx(a, ["pull", "-q", "--no-rebase", "--no-edit", b, "HEAD"], { timeoutMs: 60_000 });
    service.invalidate();
    const merged = await service.state();
    const view = discussion(merged, annotationId);
    assert(view.messages.some((message) => message.current?.text === "Ветка a") && view.messages.some((message) => message.current?.text === "Ветка b"), "both branches' replies after merge");
    const report = await service.validate();
    assert(report.problems.every((problem) => !problem.code.startsWith("dangling") && problem.code !== "incomplete"), `merge: ${JSON.stringify(report.problems.slice(0, 3))}`);
    assert(merged.conflicts.some((conflict) => conflict.entity === entity.annotation(annotationId) && conflict.register === "status"), "close vs withdraw is an explicit conflict");
    assert(discussion(merged, annotationId).status === null, "no last-write-wins");
    const count = merged.conflicts.length;
    // Conflict resolution is explicit: the user chooses closed and the conflict disappears.
    await service.resolveConflict({ annotationId, register: "status", value: "closed" });
    const resolved = await service.state();
    assert(discussion(resolved, annotationId).status === "closed" && !resolved.conflicts.some((conflict) => conflict.entity === entity.annotation(annotationId) && conflict.register === "status"), "resolved explicitly");
    return `${count} explicit conflict(s) after merge; ${headsA.length} head(s) before; resolved explicitly → closed`;
  });

  await step("G6/DR-02: branch switch drops the runtime cache; a receipt for history absent in the branch is not written", async () => {
    const shownHere = await service.readDocument(docPath);
    const reloads = service.reloads;
    const first = (await gx(a, ["rev-list", "--max-parents=0", "HEAD"])).stdout.trim().split("\n")[0];
    await gx(a, ["checkout", "-q", "-b", "check-old", first]);
    await expectError("context-changed", () => service.acknowledge({ path: docPath, observation: { sha: shownHere.sha }, scope: "document", head: shownHere.head, branch: shownHere.branch }));
    const status = await service.status();
    assert(!status.enabled || service.reloads > reloads, "journal re-read after switch");
    await gx(a, ["checkout", "-q", "-"]);
    service.invalidate();
    return `on the old branch review is ${status.enabled ? "enabled" : "absent"}; nothing was written there`;
  });

  await step("delete every cache and the plugin data, reopen: same state (persistent data only)", async () => {
    const before = await summary(service, email);
    await fs.rm(dataDir, { recursive: true, force: true });
    service = new ReviewService(service.root, dataDir);
    const after = await summary(service, email);
    assert(before === after, "summary differs after cache removal");
    const report = await service.validate();
    assert(report.ok, `validate: ${JSON.stringify(report.problems.slice(0, 3))}`);
    return `${report.counts.events} events, ${report.counts.objects} objects, ${report.counts.snapshots} snapshots; revisions recomputed from snapshots`;
  });

  if (input.watch) {
    await step("native watch: file change and Git checkout on this machine", async () => {
      const events: { kind: string; count: number; at: number }[] = [];
      const t0 = performance.now();
      const subscription = await input.watch!({ rootPath: service.root, ignoredPaths: [".git", "node_modules"], debounceMs: 100, maxWaitMs: 1000 }, (event) => {
        events.push({ kind: event.kind, count: event.changes?.length ?? 0, at: Math.round(performance.now() - t0) });
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const writeAt = performance.now();
        await fs.writeFile(path.join(a, DOC_DIR, "notes.md"), `${CHECK_DOCS["notes.md"]}\nПравка для watch.\n`);
        await waitFor(() => events.length > 0, 5000);
        measurements["watch latency after write"] = events.length ? `${Math.round(events[0].at - (writeAt - t0))} ms` : "no event in 5 s";
        await gx(a, ["checkout", "-q", "--", "."]);
        const before = events.length;
        await gx(a, ["checkout", "-q", "-b", "check-watch", "HEAD~2"]);
        await waitFor(() => events.length > before, 5000);
        await gx(a, ["checkout", "-q", "-"]);
        await waitFor(() => events.length > before + 1, 5000);
      } finally {
        await subscription.dispose();
      }
      const kinds = events.map((event) => `${event.kind}${event.count ? `(${event.count})` : ""}`);
      assert(events.length >= 2, `events: ${kinds.join(", ")}`);
      return kinds.slice(0, 8).join(", ");
    });
  }

  await loopSteps({ step, assert, service: () => service, root: service.root, docDir: DOC_DIR, measurements });
  await catalogSteps({ step, assert, work, measurements });
  await w05ReliabilitySteps({ step, assert, work, measurements });
  await w05PerformanceSteps({ step, assert, work, measurements });

  await step("measure: tree of the source checkout and projection of large documents", async () => {
    const t0 = performance.now();
    let files = 0;
    let markdown = 0;
    let bytes = 0;
    const walk = async (dir: string) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          files++;
          if (/\.(md|markdown)$/i.test(entry.name)) {
            markdown++;
            bytes += (await fs.stat(full)).size;
          }
        }
      }
    };
    await walk(source.root);
    measurements["source tree walk"] = `${files} files (${markdown} Markdown, ${(bytes / 1024).toFixed(0)} KiB) in ${Math.round(performance.now() - t0)} ms`;
    for (const size of [200 * 1024, 1024 * 1024]) {
      const paragraph = `${CHECK_DOCS["guide.md"]}\n`;
      const text = paragraph.repeat(Math.ceil(size / Buffer.byteLength(paragraph)));
      const t1 = performance.now();
      const revision = buildRevision({ revisionId: "00000000-0000-4000-8000-0000000000aa", docId: "00000000-0000-4000-8000-0000000000bb", path: "big.md", source: text, snapshot: sha256(text), parents: [] });
      const cold = performance.now() - t1;
      const t2 = performance.now();
      projectMarkdown(text);
      const warm = performance.now() - t2;
      measurements[`document ${size / 1024} KiB`] = `${revision.revision.blocks.length} blocks; projection+revision ${Math.round(cold)} ms, projection again ${Math.round(warm)} ms`;
    }
    return `${files} files`;
  });

  const durationMs = Math.round(performance.now() - started);
  return { ok: steps.every((entry) => entry.ok), durationMs, host: os.hostname(), source: source.root, steps, measurements, kept: input.keep ? work : null };
}

async function waitFor(condition: () => boolean, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (!condition() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
}

export { exists };

/**
 * Summary of a checkout, or of a Git bundle cloned into a temporary directory first (restoring review data
 * on another machine from the repository alone, AC01). Nothing outside the temporary clone is written.
 */
export async function summarize(input: { root?: string; bundle?: string; reader: string; dataDir: string; tempDir: string }) {
  let root = input.root ?? null;
  let work: string | null = null;
  try {
    if (input.bundle) {
      if (!path.isAbsolute(input.bundle)) throw new ReviewError("bad-path", "bundle path must be absolute");
      work = await fs.mkdtemp(path.join(input.tempDir, "bb-docs-bundle-"));
      root = path.join(work, "clone");
      await gx(work, ["clone", "-q", input.bundle, root], { timeoutMs: 300_000 });
    }
    if (!root) throw new ReviewError("bad-input", "root or bundle required");
    const info = await resolveCheckout(root);
    const service = new ReviewService(info.root, path.join(work ?? input.dataDir, "summary-data"));
    const text = await summary(service, input.reader.trim().toLowerCase());
    const report = await service.validate(20);
    return { host: os.hostname(), head: info.head, reader: input.reader.trim().toLowerCase(), digest: sha256(text), validateOk: report.ok, counts: report.counts, problems: report.problems, summary: JSON.parse(text) };
  } finally {
    if (work) await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
