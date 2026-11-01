// One walk of the review roots (W-06c, file-types.md §4, §14) shared by the tree and the tracked set: files of the
// format registry (types enabled by config `types`), exclusion levels (immutable → built-in → global of the user →
// repository) with excluded directories pruned, symlinks never followed, and everything not shown counted with its
// reason (rule and level, file type, symlink). Bounded by MAX_ENTRIES and a time budget: past them the tree is partial
// and says so. Git classes are not decided here (service.fileClasses — one `git ls-files` per checkout).
import fs from "node:fs/promises";
import path from "node:path";
import { type FormatId, formatOf, FORMATS, unsupportedKind } from "../core/formats/registry.ts";
import type { Config } from "../core/schema.ts";
import { confine } from "./checkout.ts";
import { type Decision, Exclusions, type RuleLevel } from "./exclusions.ts";
import { readUserSettings } from "./user-settings.ts";

export const MAX_ENTRIES = 20_000;

export interface WalkedFile {
  kind: "file";
  size: number;
  mtime: number;
  format: FormatId;
  note: string | null;
}

export interface NotShown {
  /** By exclusion rule: files and directories it removed (a pruned directory counts once). */
  rules: { level: RuleLevel; pattern: string; files: number; dirs: number }[];
  /** Files of other types: a future type of wave 2, anything else, a type this repository turned off. */
  types: { wave2: number; other: number; disabled: number };
  symlinks: number;
}

export interface WalkResult {
  files: Map<string, WalkedFile>;
  /** Directories pruned by any rule (the tree's legacy `excluded`). */
  excludedDirs: string[];
  missing: string[];
  truncated: number;
  /** The time budget ran out: the walk is partial. */
  partial: boolean;
  notShown: NotShown;
}

/** Exclusions of a checkout for a reader: built-in, the user's global rules (minus exemptions here), config `exclude`. */
export async function exclusionsFor(dataDir: string, config: Config | null, readerId: string | null): Promise<Exclusions> {
  const settings = await readUserSettings(dataDir, readerId);
  const exempt = config ? settings.exemptFromGlobal[config.repoId] ?? [] : [];
  return new Exclusions({ global: settings.exclude, globalExempt: exempt, repo: config?.exclude ?? [] });
}

export async function walkRoots(root: string, roots: string[], options: { exclusions: Exclusions; types?: readonly string[] | null; budgetMs?: number; maxEntries?: number }): Promise<WalkResult> {
  const started = performance.now();
  const budget = options.budgetMs ?? 1200;
  const max = options.maxEntries ?? MAX_ENTRIES;
  const files = new Map<string, WalkedFile>();
  const excludedDirs = new Set<string>();
  const missing: string[] = [];
  const byRule = new Map<string, { level: RuleLevel; pattern: string; files: number; dirs: number }>();
  const notShown: NotShown = { rules: [], types: { wave2: 0, other: 0, disabled: 0 }, symlinks: 0 };
  let truncated = 0;
  let partial = false;
  const count = (decision: Decision, dir: boolean) => {
    if (!decision.rule) return;
    const key = `${decision.rule.level}\0${decision.rule.pattern}`;
    const entry = byRule.get(key) ?? { ...decision.rule, files: 0, dirs: 0 };
    if (dir) entry.dirs++;
    else entry.files++;
    byRule.set(key, entry);
  };
  const typeOf = (relative: string): FormatId | null => {
    const format = formatOf(relative);
    if (!format) {
      notShown.types[unsupportedKind(relative)]++;
      return null;
    }
    if (options.types && !options.types.includes(FORMATS[format].group)) {
      notShown.types.disabled++;
      return null;
    }
    return format;
  };
  const visited = new Set<string>();
  const walkDir = async (relative: string, absolute: string): Promise<void> => {
    if (visited.has(relative)) return;
    visited.add(relative);
    if (performance.now() - started > budget) { partial = true; return; }
    let list;
    try {
      list = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs: [string, string][] = [];
    const sized: [string, string, FormatId][] = [];
    for (const entry of list) {
      const child = relative === "." ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) { notShown.symlinks++; continue; }
      if (entry.isDirectory()) {
        const decision = options.exclusions.decide(child, true);
        if (decision.excluded) {
          excludedDirs.add(child);
          if (decision.rule?.level !== "immutable") count(decision, true);
          continue;
        }
        dirs.push([child, path.join(absolute, entry.name)]);
      } else if (entry.isFile()) {
        const format = typeOf(child);
        if (!format) continue;
        const decision = options.exclusions.decide(child, false);
        if (decision.excluded) { count(decision, false); continue; }
        sized.push([child, path.join(absolute, entry.name), format]);
      }
    }
    const stats = await Promise.all(sized.map(([, file]) => fs.lstat(file).then((stat) => stat, () => null)));
    sized.forEach(([child, , format], index) => {
      const stat = stats[index];
      if (!stat || !stat.isFile() || files.has(child)) return;
      if (files.size >= max) { truncated++; return; }
      files.set(child, { kind: "file", size: stat.size, mtime: stat.mtimeMs, format, note: null });
    });
    await Promise.all(dirs.map(([child, dir]) => walkDir(child, dir)));
  };
  // Overlapping roots (docs and docs/a.md, or «.» and docs) list every file once.
  for (const entry of roots) {
    let absolute: string;
    try {
      absolute = entry === "." ? root : await confine(root, entry);
    } catch {
      notShown.symlinks++;
      continue;
    }
    const stat = await fs.lstat(absolute).catch(() => null);
    if (!stat) { missing.push(entry); continue; }
    if (stat.isFile()) {
      if (entry === ".") continue;
      const format = typeOf(entry);
      if (!format) continue;
      const decision = options.exclusions.decide(entry, false);
      if (decision.excluded) { count(decision, false); continue; }
      if (!files.has(entry)) files.set(entry, { kind: "file", size: stat.size, mtime: stat.mtimeMs, format, note: null });
      continue;
    }
    if (stat.isDirectory()) {
      if (entry !== ".") {
        const decision = options.exclusions.decide(entry, true);
        if (decision.excluded) { excludedDirs.add(entry); count(decision, true); continue; }
      }
      await walkDir(entry, absolute);
    }
  }
  notShown.rules = [...byRule.values()].sort((a, b) => b.files + b.dirs - (a.files + a.dirs) || (a.pattern < b.pattern ? -1 : 1));
  const sorted = new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { files: sorted, excludedDirs: [...excludedDirs].sort(), missing, truncated, partial, notShown };
}

/** Directories (two levels) that hold reviewable files: suggestions when the configured roots are missing. */
export async function suggestRoots(root: string, exclusions: Exclusions): Promise<string[]> {
  const found: string[] = [];
  const has = async (dir: string, relative: string, depth: number): Promise<boolean> => {
    const list = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of list) if (entry.isFile() && formatOf(entry.name) && !exclusions.decide(relative ? `${relative}/${entry.name}` : entry.name).excluded) return true;
    if (depth <= 0) return false;
    for (const entry of list) {
      if (!entry.isDirectory()) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (exclusions.decide(child, true).excluded) continue;
      if (await has(path.join(dir, entry.name), child, depth - 1)) return true;
    }
    return false;
  };
  const top = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  if (top.some((entry) => entry.isFile() && formatOf(entry.name))) found.push(".");
  for (const entry of top.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory() || exclusions.decide(entry.name, true).excluded) continue;
    if (await has(path.join(root, entry.name), entry.name, 2)) found.push(entry.name);
    if (found.length >= 20) break;
  }
  return found;
}
