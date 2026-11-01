// Measurements of the tree and the document view on the machine that has the checkout (W-06a, EP-027-T07/T08):
// `bb document-review perf`. A checkout is measured read-only; a Git bundle is cloned into the plugin's temporary
// directory first (optionally kept, with a generated 1 MiB document, so the viewer can open the same clone through a
// host route). Cold = a new service with an empty data directory and cleared in-memory caches; warm = the same call
// again. Times are wall-clock milliseconds on that machine; sizes are bytes of the JSON the host would return.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git, resolveCheckout } from "./checkout.ts";
import { ReviewError, ReviewService } from "./service.ts";
import { clearTreeCaches, documentTree } from "./tree.ts";
import { clearViewCaches, compactView, documentText, documentView } from "./view.ts";

export const BIG_DOC = "docs/w06a-big-1mib.md";

/** A Markdown document of about `bytes` bytes with the usual mix: headings, paragraphs, lists, code, tables, quotes. */
export function bigMarkdown(bytes = 1024 * 1024): string {
  const parts: string[] = ["# Большой документ для замеров\n", "Сгенерирован `bb document-review perf` (W-06a): разделы, абзацы, списки, код и таблицы.\n"];
  let size = Buffer.byteLength(parts.join("\n"));
  for (let section = 1; size < bytes; section++) {
    const chunk = [
      `## Раздел ${section}`, "",
      `Абзац ${section}.1: документация описывает поведение просмотрщика, пометки изменений и замечания к тексту; строка достаточно длинная, чтобы переноситься на широком экране и проверять меру чтения.`, "",
      `Абзац ${section}.2 со [ссылкой](https://example.com/${section}), **жирным**, *курсивом* и \`кодом\` внутри строки.`, "",
      `### Подраздел ${section}.a`, "",
      `- пункт первый раздела ${section}`, `- пункт второй с подробностями`, `  - вложенный пункт`, `- [ ] задача раздела ${section}`, "",
      "```ts", `const section${section} = { id: ${section}, title: "Раздел ${section}" };`, "export default section" + section + ";", "```", "",
      "| Поле | Значение | Примечание |", "| --- | --- | --- |", `| id | ${section} | номер раздела |`, `| size | ${size} | байт до раздела |`, "",
      `> Цитата раздела ${section}: читать по многу документов подряд, между тредами bb.`, "",
    ].join("\n");
    parts.push(chunk);
    size += Buffer.byteLength(chunk) + 1;
  }
  return parts.join("\n");
}

const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] ?? 0; };
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** Kept clones live in the plugin's data directory (they survive host restarts) until `perf --clean`. */
const keptDir = (dataDir: string) => path.join(dataDir, "perf-clones");

export async function cleanPerf(dataDir: string): Promise<{ removed: string[] }> {
  const list = await fs.readdir(keptDir(dataDir)).catch(() => [] as string[]);
  await fs.rm(keptDir(dataDir), { recursive: true, force: true });
  return { removed: list };
}

export async function runPerf(input: { root?: string; bundle?: string; keep?: boolean; docs?: string[]; rounds?: number; tempDir: string; dataDir: string }) {
  let root = input.root ?? null;
  let work: string | null = null;
  const data = await fs.mkdtemp(path.join(input.tempDir, "bb-docs-perf-data-"));
  try {
    if (input.bundle) {
      if (!path.isAbsolute(input.bundle)) throw new ReviewError("bad-path", "bundle path must be absolute");
      if (input.keep) await fs.mkdir(keptDir(input.dataDir), { recursive: true });
      work = await fs.mkdtemp(path.join(input.keep ? keptDir(input.dataDir) : input.tempDir, "bb-docs-perf-"));
      root = path.join(work, "clone");
      await git(work, ["-c", "core.hooksPath=/dev/null", "clone", "-q", input.bundle, root], { timeoutMs: 300_000 });
      // The clone gets the 1 MiB document as a new file of the roots (not committed: nothing is published anywhere).
      await fs.writeFile(path.join(root, BIG_DOC), bigMarkdown());
    }
    if (!root) throw new ReviewError("bad-input", "root or bundle required");
    const info = await resolveCheckout(root);
    const rounds = Math.max(1, Math.min(input.rounds ?? 3, 10));
    const tree = { cold: [] as number[], warm: [] as number[], bytes: 0, entries: 0, supported: 0, unsupported: 0, symlinks: 0, phases: {} as Record<string, number> };
    for (let round = 0; round < rounds; round++) {
      clearTreeCaches();
      clearViewCaches();
      const service = new ReviewService(info.root, await fs.mkdtemp(path.join(data, "r-")));
      let started = performance.now();
      const result = await documentTree(service, { budgetMs: 1200 });
      tree.cold.push(Math.round(performance.now() - started));
      tree.phases = (result as { phases?: Record<string, number> }).phases ?? {};
      started = performance.now();
      const again = await documentTree(service, { budgetMs: 1200 });
      tree.warm.push(Math.round(performance.now() - started));
      tree.bytes = bytesOf(again);
      tree.entries = again.entries.length;
      tree.supported = again.entries.filter((entry) => entry.supported).length;
      tree.unsupported = again.entries.filter((entry) => !entry.supported && entry.kind === "file").length;
      tree.symlinks = again.entries.filter((entry) => entry.kind === "symlink").length;
    }
    const docs = input.docs?.length ? input.docs : [];
    if (!docs.length) {
      const exists = async (doc: string) => Boolean(await fs.stat(path.join(info.root, doc)).catch(() => null));
      for (const doc of ["docs/plugins/document-review/architecture.md", "docs/plugins/document-review/format.md", "README.md", BIG_DOC]) if (await exists(doc)) docs.push(doc);
    }
    const views: Record<string, { cold: number; warm: number; bytes: number; blocks: number; size: number; textCold: number; textWarm: number; textBytes: number; compactBytes: number }> = {};
    for (const doc of docs) {
      const cold: number[] = [];
      const warm: number[] = [];
      let last: Awaited<ReturnType<typeof documentView>> | null = null;
      const textCold: number[] = [];
      const textWarm: number[] = [];
      let textBytes = 0;
      for (let round = 0; round < rounds; round++) {
        clearTreeCaches();
        clearViewCaches();
        const service = new ReviewService(info.root, await fs.mkdtemp(path.join(data, "v-")));
        // The fast path (first screens, EP-027-T08) on a cold host, then again; then the full view on top of it.
        let started = performance.now();
        const text = await documentText(service, doc, { limit: 400 });
        textCold.push(Math.round(performance.now() - started));
        textBytes = bytesOf(text);
        started = performance.now();
        await documentText(service, doc, { limit: 400 });
        textWarm.push(Math.round(performance.now() - started));
        clearViewCaches();
        started = performance.now();
        last = await documentView(service, doc);
        cold.push(Math.round(performance.now() - started));
        started = performance.now();
        last = await documentView(service, doc);
        warm.push(Math.round(performance.now() - started));
      }
      views[doc] = { cold: median(cold), warm: median(warm), bytes: last ? bytesOf(last) : 0, blocks: last?.blocks.length ?? 0, size: last?.document.size ?? 0,
        textCold: median(textCold), textWarm: median(textWarm), textBytes, compactBytes: last ? bytesOf(compactView(last)) : 0 };
    }
    return {
      host: os.hostname(), root: info.root, kept: input.keep && work ? root : null, head: info.head, rounds,
      tree: { coldMs: median(tree.cold), warmMs: median(tree.warm), coldAll: tree.cold, warmAll: tree.warm, bytes: tree.bytes, entries: tree.entries, supported: tree.supported, unsupported: tree.unsupported, symlinks: tree.symlinks, phases: tree.phases },
      views,
    };
  } finally {
    await fs.rm(data, { recursive: true, force: true }).catch(() => undefined);
    if (work && !input.keep) await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
