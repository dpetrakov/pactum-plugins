// «Review settings» on the host (W-06c, file-types.md §4, §12; EP-045-T01): the rules in force with their level and
// source, the preview of a change before it is written (the walk with the proposed rules — what becomes hidden or shown,
// by reason and level, the first 20 paths, documents with annotations that drop out; for the secret-key pattern how
// many values become masked in how many files and how many of those files already have revisions in .bb-docs), and
// the write: repository rules into config.json by compare-and-swap (schema 1.2 only with the new fields), the user's
// rules into the user's settings file in the plugin's data directory. The built-in sets are shown, never narrowed.
import { canonicalBytes } from "../core/canonical-json.ts";
import { sha256 } from "../core/hash.ts";
import { FORMATS, GROUP_LABEL, TYPE_GROUPS, formatOf, type TypeGroup } from "../core/formats/registry.ts";
import { BUILTIN_SECRET_KEYS, classify, patternProblem } from "../core/formats/secrets.ts";
import { type Config, configVersion, parseConfig } from "../core/schema.ts";
import { writeConfig } from "../core/store.ts";
import { tr } from "../core/i18n.ts";
import { readContent, readerOf, sharedRules } from "./content.ts";
import { BUILTIN_RULES, Exclusions, exclusionPatternProblem, IMMUTABLE_RULES, type RuleRef } from "./exclusions.ts";
import { ReviewError, type ReviewService } from "./service.ts";
import { readUserSettings, updateUserSettings } from "./user-settings.ts";
import { suggestRoots, walkRoots } from "./walk.ts";

/** A proposed change: any subset of the editable lists of one level (or both). */
export interface SettingsChange {
  repo?: { roots?: string[]; exclude?: string[]; types?: TypeGroup[] | null; secretKeys?: string[] };
  user?: { exclude?: string[]; exemptHere?: string[]; secretKeys?: string[]; retentionDays?: number | null };
}

const PREVIEW_PATHS = 20;

async function current(service: ReviewService) {
  const read = await service.config();
  if (!read.value) throw new ReviewError("not-enabled", "review is not enabled in this checkout");
  const readerId = await readerOf(service);
  const settings = await readUserSettings(service.dataDir, readerId);
  return { read, config: read.value, readerId, settings };
}

/** The rules in force, by level, with what can be changed where. */
export async function settingsGet(service: ReviewService) {
  const { read, config, readerId, settings } = await current(service);
  const exclusions = new Exclusions({ global: settings.exclude, globalExempt: settings.exemptFromGlobal[config.repoId] ?? [], repo: config.exclude ?? [] });
  return {
    configSha: read.sha, writable: !read.readOnly, readerId, repoId: config.repoId,
    repo: { roots: config.roots, exclude: config.exclude ?? [], types: config.types ?? null, secretKeys: config.secretKeys ?? [],
      secretExemptions: (config.secretExemptions ?? []).map((entry) => ({ path: entry.path, keyPath: entry.keyPath })), hidden: config.hidden, untracked: config.untracked },
    builtin: { exclude: BUILTIN_RULES, immutable: IMMUTABLE_RULES, secretKeys: BUILTIN_SECRET_KEYS.split("|") },
    user: { exclude: settings.exclude, exemptHere: settings.exemptFromGlobal[config.repoId] ?? [], secretKeys: settings.secretKeys, retentionDays: settings.retentionDays,
      missingCheckouts: await (await import("./local.ts")).missingCheckouts(service).catch(() => []),
      exemptions: Object.entries(settings.exemptions[config.repoId] ?? {}).flatMap(([path, keyPaths]) => keyPaths.map((keyPath) => ({ path, keyPath }))) },
    listing: exclusions.listing(),
    types: TYPE_GROUPS.map((group) => ({ group, label: GROUP_LABEL[group] })),
    suggestedRoots: await suggestRoots(service.root, exclusions).catch(() => []),
  };
}

/** Problems of the proposed patterns, in place (field and pattern), before anything is computed or written. */
function problemsOf(change: SettingsChange): { field: string; pattern: string; problem: string }[] {
  const out: { field: string; pattern: string; problem: string }[] = [];
  for (const [field, list] of [["repo.exclude", change.repo?.exclude], ["user.exclude", change.user?.exclude], ["user.exemptHere", change.user?.exemptHere]] as const) {
    for (const pattern of list ?? []) { const problem = exclusionPatternProblem(pattern); if (problem) out.push({ field, pattern, problem }); }
  }
  for (const [field, list] of [["repo.secretKeys", change.repo?.secretKeys], ["user.secretKeys", change.user?.secretKeys]] as const) {
    for (const pattern of list ?? []) { const problem = patternProblem(pattern); if (problem) out.push({ field, pattern, problem }); }
  }
  for (const root of change.repo?.roots ?? []) if (!root || root.startsWith("/") || root.split("/").includes("..")) out.push({ field: "repo.roots", pattern: root, problem: tr("a root is a path inside the checkout", "корень — путь внутри рабочей копии") });
  if (change.repo?.roots && !change.repo.roots.length) out.push({ field: "repo.roots", pattern: "", problem: tr("at least one root is required", "нужен хотя бы один корень") });
  return out;
}

/** What a change would do — computed with the proposed rules, nothing written. */
export async function settingsPreview(service: ReviewService, change: SettingsChange & { budgetMs?: number }) {
  const problems = problemsOf(change);
  if (problems.length) return { status: "invalid" as const, problems };
  const { config, settings } = await current(service);
  const before = { roots: config.roots, types: config.types ?? null, exclusions: new Exclusions({ global: settings.exclude, globalExempt: settings.exemptFromGlobal[config.repoId] ?? [], repo: config.exclude ?? [] }) };
  const after = {
    roots: change.repo?.roots ?? config.roots, types: change.repo?.types !== undefined ? change.repo.types : config.types ?? null,
    exclusions: new Exclusions({ global: change.user?.exclude ?? settings.exclude, globalExempt: change.user?.exemptHere ?? settings.exemptFromGlobal[config.repoId] ?? [], repo: change.repo?.exclude ?? config.exclude ?? [] }),
  };
  const budgetMs = change.budgetMs ?? 4000;
  const [was, will] = await Promise.all([
    walkRoots(service.root, before.roots, { exclusions: before.exclusions, types: before.types, budgetMs }),
    walkRoots(service.root, after.roots, { exclusions: after.exclusions, types: after.types, budgetMs }),
  ]);
  const why = (file: string): RuleRef | { level: "type" | "roots"; pattern: string } => {
    const decision = after.exclusions.decide(file);
    if (decision.excluded && decision.rule) return decision.rule;
    const format = formatOf(file);
    if (after.types && format && !after.types.includes(FORMATS[format].group as TypeGroup)) return { level: "type", pattern: FORMATS[format].group };
    return { level: "roots", pattern: after.roots.join(", ") };
  };
  const hidden = [...was.files.keys()].filter((file) => !will.files.has(file)).sort();
  const shown = [...will.files.keys()].filter((file) => !was.files.has(file)).sort();
  const byReason = new Map<string, { level: string; pattern: string; count: number }>();
  for (const file of hidden) {
    const reason = why(file);
    const key = `${reason.level}|${reason.pattern}`;
    byReason.set(key, { level: reason.level, pattern: reason.pattern, count: (byReason.get(key)?.count ?? 0) + 1 });
  }
  // Documents with open annotations that would drop out of the review (their annotations stay, read-only).
  const state = await service.state().catch(() => null);
  const annotated = new Set<string>();
  if (state) {
    const hiddenSet = new Set(hidden);
    for (const operation of state.events.values()) {
      for (const change of operation.changes) {
        if (change.type !== "annotation.created") continue;
        const path = state.documents.get(change.docId)?.path;
        if (path && hiddenSet.has(path)) annotated.add(path);
      }
    }
  }
  const secrets = await secretPreview(service, config, settings, change, will.files);
  return {
    status: "ok" as const, problems: [],
    partial: was.partial || will.partial,
    hidden: { count: hidden.length, paths: hidden.slice(0, PREVIEW_PATHS), reasons: [...byReason.values()] },
    shown: { count: shown.length, paths: shown.slice(0, PREVIEW_PATHS) },
    annotatedDropping: [...annotated].sort(),
    secrets,
    // Global rules apply to every checkout of this user on this machine; the plugin counts only this one here.
    otherCheckouts: change.user ? { counted: 0, note: tr("other checkouts on this machine are not recounted in the preview", "другие рабочие копии этой машины не пересчитываются в предпросмотре") } : null,
  };
}

/** Preview how many secret values in how many files would become hidden, and how many already have shared revisions. */
async function secretPreview(service: ReviewService, config: Config, settings: { secretKeys: string[] }, change: SettingsChange, files: Map<string, unknown>) {
  const repoKeys = change.repo?.secretKeys;
  const userKeys = change.user?.secretKeys;
  if (!repoKeys && !userKeys) return null;
  const state = await service.state().catch(() => null);
  let values = 0;
  const touched: string[] = [];
  let inHistory = 0;
  for (const file of [...files.keys()].sort()) {
    const format = formatOf(file);
    if (!format || FORMATS[format].secrets !== "keys") continue;
    const content = await readContent(service, file).catch(() => null);
    if (!content) continue;
    const rules = sharedRules(config, file, content.fileClass);
    // The shared form already has the current repository rules; count what the proposal adds on top of it.
    const base = classify(file, content.text, { ...rules, global: userKeys ? settings.secretKeys : undefined }, userKeys ? "personal" : "shared");
    const next = classify(file, content.text, { ...rules, repo: repoKeys ?? rules.repo, global: userKeys ?? undefined }, userKeys ? "personal" : "shared");
    const added = next.spans.length - base.spans.length;
    if (added <= 0) continue;
    values += added;
    touched.push(file);
    if (repoKeys && state) {
      const docId = service.docIdOf(state, file);
      if (docId && (state.documents.get(docId)?.revisions?.length ?? 0) > 0) inHistory++;
    }
  }
  return { values, files: touched.length, paths: touched.slice(0, PREVIEW_PATHS), inHistory,
    globalWarning: userKeys ? tr("a global extension changes what is shown, review batches for the agent, logs and the CLI, but not the shared .bb-docs data", "глобальное расширение меняет показ, пакеты агенту, журналы и CLI, но не общие данные .bb-docs") : null };
}

/** Write the change: repository level by CAS into config.json, the user's level into the settings file. */
export async function settingsSave(service: ReviewService, change: SettingsChange & { configSha?: string | null; head?: string | null; branch?: string | null }) {
  const problems = problemsOf(change);
  if (problems.length) throw new ReviewError("bad-input", problems.map((entry) => `${entry.field} «${entry.pattern}»: ${entry.problem}`).join("; "));
  return service.serial(async () => {
    const { read, config, readerId } = await current(service);
    let configSha = read.sha;
    if (change.repo) {
      await service.writable(change);
      if (read.readOnly) throw new ReviewError("read-only", read.problem ?? "config.json cannot be used for writing");
      if (change.configSha !== undefined && change.configSha !== null && change.configSha !== read.sha) throw new ReviewError("stale", "config.json changed since the preview; review it again");
      const next: Config = { ...config };
      if (change.repo.roots) next.roots = [...new Set(change.repo.roots)];
      if (change.repo.exclude) { if (change.repo.exclude.length) next.exclude = change.repo.exclude; else delete next.exclude; }
      if (change.repo.types !== undefined) { if (change.repo.types && change.repo.types.length < TYPE_GROUPS.length) next.types = change.repo.types; else delete next.types; }
      if (change.repo.secretKeys) { if (change.repo.secretKeys.length) next.secretKeys = change.repo.secretKeys; else delete next.secretKeys; }
      next.schemaVersion = configVersion(next) === "1.2" ? "1.2" : config.schemaVersion;
      const parsed = parseConfig(next);
      if (!parsed.ok) throw new ReviewError("bad-input", parsed.issues.join("; "));
      if ((await writeConfig(service.store, canonicalBytes(next), read.sha)) !== "replaced") throw new ReviewError("stale", "config.json changed concurrently; review it again");
      configSha = sha256(canonicalBytes(next));
      service.invalidate();
    }
    if (change.user) {
      if (!readerId) throw new ReviewError("no-identity", "Git user.email is not set in this checkout: personal settings need a reader");
      await updateUserSettings(service.dataDir, readerId, (settings) => {
        if (change.user!.exclude) settings.exclude = [...new Set(change.user!.exclude)];
        if (change.user!.exemptHere) settings.exemptFromGlobal[config.repoId] = [...new Set(change.user!.exemptHere)];
        if (change.user!.secretKeys) settings.secretKeys = [...new Set(change.user!.secretKeys)];
        if (change.user!.retentionDays !== undefined) settings.retentionDays = change.user!.retentionDays;
      });
      service.invalidate();
    }
    return { status: "saved" as const, configSha };
  });
}
