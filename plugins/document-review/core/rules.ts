// Visibility and tracking rules of config.json (A5–A7): two independent lists of .gitignore patterns where the last
// match wins. The UI never edits patterns as text; it adds or removes the path's own pattern and, when the path is
// still covered by an ancestor or glob adds a point exception `!...` and reports the inherited rule.
import ignore from "ignore";

export type RuleList = "hidden" | "untracked";
export type RuleAction = "add" | "remove";

/**
 * Paths the UI can turn into its own pattern: repo-relative, and without characters that .gitignore reads as syntax
 * (glob `* ? [ ]`, a leading `!` or `#`, trailing spaces, line breaks). Such names are refused with an explanation
 * instead of writing a pattern that would cover other files; complex rules are edited in config.json by hand (A5).
 */
export function ruleablePath(path: string): string | null {
  if (path === ".") return "the whole repository is not hidden or untracked from the tree; edit .bb-docs/config.json by hand";
  if (!path || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) return "not a repo-relative path";
  if (/[*?[\]\\\r\n\0]/.test(path) || /(^|\/)[!#]/.test(path) || / $/.test(path)) return "the name contains characters that .gitignore reads as a pattern; edit .bb-docs/config.json by hand";
  return null;
}

/** The pattern this UI writes for a path: anchored at the repository root; a directory covers its contents. */
export function ownPattern(path: string, isDir: boolean): string {
  return `/${path}${isDir ? "/**" : ""}`;
}

/** Spellings of a path's own pattern that count as «its own» (hand-written ones included). */
function ownForms(path: string, isDir: boolean): Set<string> {
  const forms = [path, `/${path}`];
  if (isDir) forms.push(`${path}/`, `/${path}/`, `${path}/**`, `/${path}/**`);
  return new Set(forms);
}

const positive = (pattern: string) => (pattern.startsWith("!") ? pattern.slice(1) : pattern);
/** Directories are tested through a probe child: `dir/**` covers everything inside, not the name itself. */
const probe = (path: string, isDir: boolean) => (isDir ? `${path}/.bbdr-probe` : path);

const single = new Map<string, ReturnType<typeof ignore>>();
function matcher(pattern: string) {
  let value = single.get(pattern);
  if (!value) {
    value = ignore().add(pattern);
    single.set(pattern, value);
    if (single.size > 4096) single.delete(single.keys().next().value!);
  }
  return value;
}

function safeIgnores(rules: ReturnType<typeof ignore>, path: string): boolean {
  try {
    return rules.ignores(path);
  } catch {
    return false;
  }
}

export interface Decision {
  /** The path is covered by the list (hidden / not tracked). */
  matched: boolean;
  /** The pattern that decided, last match wins; null when nothing matched. */
  by: string | null;
  /** The deciding pattern is the path's own (not inherited from an ancestor or a glob). */
  own: boolean;
}

/** Which pattern decides for a path (gitignore semantics, last match wins). */
export function decide(patterns: readonly string[], path: string, isDir = false): Decision {
  const target = probe(path, isDir);
  const all = ignore().add([...patterns]);
  const matched = safeIgnores(all, target);
  let by: string | null = null;
  for (let index = patterns.length - 1; index >= 0; index--) {
    const pattern = patterns[index];
    if (!pattern.trim() || pattern.startsWith("#")) continue;
    if (safeIgnores(matcher(positive(pattern)), target)) {
      by = pattern;
      break;
    }
  }
  const own = by !== null && ownForms(path, isDir).has(positive(by));
  return { matched, by, own };
}

/** The ancestor or glob from which a path inherits its rule. */
export function inheritedFrom(decision: Decision): string | null {
  if (!decision.matched || decision.own || !decision.by) return null;
  return decision.by.replace(/^\//, "").replace(/\/\*\*$/, "/");
}

/**
 * Apply «Hide / Show» or «Untracked / Track» to one list. Returns the new list and whether the
 * effective decision for the path is now the requested one. Patterns of other paths are kept in their order.
 */
export function applyRule(patterns: readonly string[], input: { path: string; isDir: boolean; action: RuleAction }): { patterns: string[]; changed: boolean } {
  const forms = ownForms(input.path, input.isDir);
  const want = input.action === "add";
  let next = [...patterns];
  const before = decide(next, input.path, input.isDir).matched;
  if (want) {
    // A point exception of this very path is dropped first; then the own pattern is added if still needed.
    next = next.filter((pattern) => !(pattern.startsWith("!") && forms.has(positive(pattern))));
    if (!decide(next, input.path, input.isDir).matched) next.push(ownPattern(input.path, input.isDir));
  } else {
    next = next.filter((pattern) => pattern.startsWith("!") || !forms.has(pattern));
    if (decide(next, input.path, input.isDir).matched) next.push(`!${ownPattern(input.path, input.isDir)}`);
  }
  // Point exceptions at or under the path that no longer except anything are dropped (reversible, no leftovers).
  next = next.filter((pattern, index) => {
    if (!pattern.startsWith("!")) return true;
    const target = positive(pattern).replace(/^\//, "").replace(/\/\*\*$/, "");
    if (target !== input.path && !target.startsWith(`${input.path}/`)) return true;
    const without = next.filter((_, other) => other !== index);
    return decide(without, target, pattern.endsWith("/**")).matched;
  });
  const after = decide(next, input.path, input.isDir).matched;
  return { patterns: next, changed: before !== after || next.join("\n") !== patterns.join("\n") };
}

/**
 * Three-way merge of one list of config.json after a Git conflict (EP-014-T02): what the other branch removed from
 * the common base is removed, what it added is appended after ours (its rules keep their relative order and, being
 * later, their precedence over ours for the paths they name). Nothing is dropped silently: the caller shows the
 * merged lists before writing.
 */
export function mergeLists(base: readonly string[], ours: readonly string[], theirs: readonly string[]): string[] {
  const removedByTheirs = new Set(base.filter((pattern) => !theirs.includes(pattern)));
  const result = ours.filter((pattern) => !removedByTheirs.has(pattern));
  for (const pattern of theirs) if (!base.includes(pattern) && !result.includes(pattern)) result.push(pattern);
  return result;
}
