// Registry of file formats (W-06c, file-types.md §3, §5; DR-08): the single answer to «what is this file» for the
// host and the interface. formatOf(path) → FormatId of wave 1, or null («unsupported»). Wave 2 types are
// listed disabled so the tree can count them as «not shown»; everything else is out of scope (F8).
import { tr } from "../i18n.ts";

export type FormatId = "markdown" | "yaml" | "json" | "jsonc" | "toml" | "dotenv" | "text" | "csv" | "tsv";
export type ProfileId = "bbdr-markdown" | "bbdr-structured" | "bbdr-lines";
/** Secret policy (§8): every value; values of keys matching the secret-key pattern; only explicit secret shapes. */
export type SecretPolicy = "all-values" | "keys" | "explicit";
/** Type groups of the tree filter and the «File types» setting (a repository may turn a group off). */
export type TypeGroup = "markdown" | "yaml" | "json" | "toml" | "dotenv" | "text" | "csv";

export interface FormatInfo {
  id: FormatId;
  group: TypeGroup;
  /** User-facing name of the type. */
  label: string;
  /** Lucide icon name of the type in the tree (design system, «Files of any type»). */
  icon: string;
  /** Projection profile of the persistent Revision. */
  profile: ProfileId;
  /** «Pretty» form: rendered Markdown, key tree, table, plain paragraphs. */
  pretty: "markdown" | "keytree" | "table" | "paragraphs";
  /** Highlighter of the “Raw” view (core/formats/highlight.ts). */
  highlight: "markdown" | "yaml" | "json" | "toml" | "dotenv" | "text" | "csv" | "tsv";
  /** Folding by structure in “Raw”: nodes (structured), sections (Markdown) or none. */
  folding: "nodes" | "sections" | "none";
  secrets: SecretPolicy;
}

export const FORMATS: Record<FormatId, FormatInfo> = {
  markdown: { id: "markdown", group: "markdown", label: "Markdown", icon: "FileText", profile: "bbdr-markdown", pretty: "markdown", highlight: "markdown", folding: "sections", secrets: "explicit" },
  yaml: { id: "yaml", group: "yaml", label: "YAML", icon: "FileCog", profile: "bbdr-structured", pretty: "keytree", highlight: "yaml", folding: "nodes", secrets: "keys" },
  json: { id: "json", group: "json", label: "JSON", icon: "FileBraces", profile: "bbdr-structured", pretty: "keytree", highlight: "json", folding: "nodes", secrets: "keys" },
  jsonc: { id: "jsonc", group: "json", label: "JSON", icon: "FileBraces", profile: "bbdr-structured", pretty: "keytree", highlight: "json", folding: "nodes", secrets: "keys" },
  toml: { id: "toml", group: "toml", label: "TOML", icon: "FileSliders", profile: "bbdr-structured", pretty: "keytree", highlight: "toml", folding: "nodes", secrets: "keys" },
  dotenv: { id: "dotenv", group: "dotenv", label: ".env", icon: "FileKey", profile: "bbdr-lines", pretty: "table", highlight: "dotenv", folding: "none", secrets: "all-values" },
  text: { id: "text", group: "text", get label() { return tr("Text", "Текст"); }, icon: "FileType", profile: "bbdr-lines", pretty: "paragraphs", highlight: "text", folding: "none", secrets: "explicit" },
  csv: { id: "csv", group: "csv", label: "CSV/TSV", icon: "FileSpreadsheet", profile: "bbdr-lines", pretty: "table", highlight: "csv", folding: "none", secrets: "explicit" },
  tsv: { id: "tsv", group: "csv", label: "CSV/TSV", icon: "FileSpreadsheet", profile: "bbdr-lines", pretty: "table", highlight: "tsv", folding: "none", secrets: "explicit" },
};

export const TYPE_GROUPS: TypeGroup[] = ["markdown", "yaml", "json", "toml", "dotenv", "text", "csv"];
// The language is read at call time (getter): the host imports this module before it learns the language.
export const GROUP_LABEL: Record<TypeGroup, string> = { markdown: "Markdown", yaml: "YAML", json: "JSON", toml: "TOML", dotenv: ".env", get text() { return tr("Text", "Текст"); }, csv: "CSV/TSV" };

/** Wave 2 (future work, a separate decision of the user): recognised so the tree can say why they are not shown. */
const WAVE2 = /\.(ini|cfg|conf|properties|xml|plist|mdx|html?|svg)$/i;

function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

/**
 * Format of a repository path, or null when the file is not a reviewable type. Decided by the name only (no
 * content sniffing): the same path gives the same answer on every machine.
 */
export function formatOf(path: string): FormatId | null {
  const name = baseName(path);
  const lower = name.toLowerCase();
  if (lower === ".env" || lower.startsWith(".env.")) return "dotenv";
  if (/\.(md|markdown)$/.test(lower)) return "markdown";
  if (/\.ya?ml$/.test(lower)) return "yaml";
  if (/\.jsonc$/.test(lower) || /\.code-workspace$/.test(lower) || /^tsconfig.*\.json$/.test(lower) || /^jsconfig.*\.json$/.test(lower) || /^\.?(eslintrc|babelrc)\.json$/.test(lower)) return "jsonc";
  if (/\.json$/.test(lower)) return "json";
  if (/\.toml$/.test(lower)) return "toml";
  if (/\.txt$/.test(lower)) return "text";
  if (/\.csv$/.test(lower)) return "csv";
  if (/\.tsv$/.test(lower)) return "tsv";
  return null;
}

/** Extensions of the file opener of bb (app.tsx): every type of the registry (`.env*` files end in «env» or their suffix). */
export const OPENER_EXTENSIONS = ["md", "markdown", "yaml", "yml", "json", "jsonc", "toml", "txt", "csv", "tsv", "env"];

/** Why a file is not shown: a wave-2 type («future types») or any other file. */
export function unsupportedKind(path: string): "wave2" | "other" {
  const name = baseName(path);
  return WAVE2.test(name) || name === "Dockerfile" ? "wave2" : "other";
}

export function formatInfo(path: string): FormatInfo | null {
  const id = formatOf(path);
  return id ? FORMATS[id] : null;
}

/** A reviewable file of an enabled type group (config `types`, absent = every group of wave 1). */
export function isReviewable(path: string, types?: readonly string[] | null): boolean {
  const info = formatInfo(path);
  return Boolean(info && (!types || types.includes(info.group)));
}
