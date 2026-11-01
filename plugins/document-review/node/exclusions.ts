// Levels of exclusion rules (W-06c, file-types.md §4, DR-15): 0 immutable (.git/, .bb-docs/) → 1 built-in defaults
// (editable: `!pattern` returns them) → 2 global rules of this user on this machine (minus personal exemptions for this
// repository) → 3 repository rules (config.json `exclude`). One ordered list in .gitignore syntax: the last matching
// rule wins, `!pattern` includes again. An excluded file is neither shown nor tracked; «Hide» (hidden) is different:
// tracked and visible under «Hidden». Every decision names its rule and level, so the tree can say why a file is
// not shown and the settings preview can count consequences.
import ignore, { type Ignore } from "ignore";
import { tr } from "../core/i18n.ts";

export type RuleLevel = "immutable" | "builtin" | "global" | "repo";

export const IMMUTABLE_RULES = [".git/", ".bb-docs/"];
/** Built-in defaults (accepted 2026-10-08, §4 and Q9): dependencies, builds, caches, environments and lock files. */
export const BUILTIN_RULES = [
  "node_modules/", "dist/", "build/", "out/", "coverage/", ".next/", ".turbo/", ".cache/",
  ".venv/", "venv/", "__pycache__/", ".pytest_cache/", ".mypy_cache/", ".tox/", "target/", ".gradle/", ".idea/", ".terraform/",
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "Cargo.lock", "poetry.lock", "Gemfile.lock", "composer.lock", "go.sum",
];

export interface ExclusionRules {
  /** Global rules of the user (user settings), in order. */
  global?: readonly string[];
  /** Global rules this user does not apply in this repository (personal exemptions). */
  globalExempt?: readonly string[];
  /** Repository rules (config.json exclude), in order; `!build/` returns a built-in rule. */
  repo?: readonly string[];
}

export interface RuleRef {
  level: RuleLevel;
  pattern: string;
}

export interface Decision {
  excluded: boolean;
  /** The last matching rule (the one that decided), or null when no rule matched. */
  rule: RuleRef | null;
}

/** A pattern the settings may store: gitignore syntax, no NUL, no backslash, no line breaks, not empty. */
export function exclusionPatternProblem(pattern: string): string | null {
  const value = pattern.trim();
  if (!value || value === "!") return tr("empty pattern", "пустой шаблон");
  if (value.length > 4096) return tr("pattern longer than 4096 characters", "шаблон длиннее 4096 символов");
  if (/[\0\\\r\n]/.test(value)) return tr("pattern with an invalid character", "шаблон с недопустимым символом");
  try {
    ignore().add(value);
  } catch (error) {
    return `${tr("not a .gitignore pattern", "не шаблон .gitignore")}: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

export class Exclusions {
  readonly rules: (RuleRef & { matcher: Ignore })[];
  private readonly combined: Ignore;
  private readonly immutable: Ignore;

  constructor(input: ExclusionRules = {}) {
    const exempt = new Set(input.globalExempt ?? []);
    const ordered: RuleRef[] = [
      ...BUILTIN_RULES.map((pattern) => ({ level: "builtin" as const, pattern })),
      ...(input.global ?? []).filter((pattern) => !exempt.has(pattern) && !exclusionPatternProblem(pattern)).map((pattern) => ({ level: "global" as const, pattern })),
      ...(input.repo ?? []).filter((pattern) => !exclusionPatternProblem(pattern)).map((pattern) => ({ level: "repo" as const, pattern })),
    ];
    this.rules = ordered.map((rule) => ({ ...rule, matcher: ignore().add(rule.pattern) }));
    this.combined = ignore().add(ordered.map((rule) => rule.pattern));
    // Immutable rules are applied apart and last: nothing returns .git/ or .bb-docs/.
    this.immutable = ignore().add(IMMUTABLE_RULES);
  }

  /** Decide a repository path; directories are passed with `isDir` (dir-only patterns). */
  decide(path: string, isDir = false): Decision {
    const probe = isDir && !path.endsWith("/") ? `${path}/` : path;
    if (this.immutable.ignores(probe)) return { excluded: true, rule: { level: "immutable", pattern: IMMUTABLE_RULES.find((rule) => ignore().add(rule).ignores(probe)) ?? IMMUTABLE_RULES[0] } };
    if (!this.combined.ignores(probe)) {
      // Not excluded; a returning `!rule` may still have matched — report it for the settings view.
      return { excluded: false, rule: null };
    }
    for (let index = this.rules.length - 1; index >= 0; index--) {
      const result = this.rules[index].matcher.test(probe);
      if (result.ignored) return { excluded: true, rule: { level: this.rules[index].level, pattern: this.rules[index].pattern } };
    }
    // The combined matcher excluded it through a parent directory rule.
    const parts = probe.replace(/\/$/, "").split("/");
    for (let k = parts.length - 1; k > 0; k--) {
      const parent = `${parts.slice(0, k).join("/")}/`;
      for (let index = this.rules.length - 1; index >= 0; index--) if (this.rules[index].matcher.test(parent).ignored) return { excluded: true, rule: { level: this.rules[index].level, pattern: this.rules[index].pattern } };
    }
    return { excluded: true, rule: null };
  }

  /** The rule set as a list for the settings panel (built-in ones marked returned when a later `!rule` names them). */
  listing(): { level: RuleLevel; pattern: string; returned: boolean }[] {
    const negated = new Set(this.rules.filter((rule) => rule.pattern.startsWith("!")).map((rule) => rule.pattern.slice(1)));
    return [...IMMUTABLE_RULES.map((pattern) => ({ level: "immutable" as const, pattern, returned: false })),
      ...this.rules.map((rule) => ({ level: rule.level, pattern: rule.pattern, returned: !rule.pattern.startsWith("!") && negated.has(rule.pattern) }))];
  }
}
