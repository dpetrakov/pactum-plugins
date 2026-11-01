// One entry point for the projection of any reviewable file (W-06c, file-types.md §5): the registry decides the
// format by path, the format decides the profile. Markdown keeps bbdr-markdown v1 unchanged; YAML/JSON/JSONC/TOML give
// bbdr-structured v1, falling back to bbdr-lines v1 with the error line when they do not parse; text, CSV/TSV and .env
// give bbdr-lines v1. Pure and deterministic: the same path and source give the same projection on every machine.

import { PARSER as MARKDOWN_PARSER, REVISION_SCHEMA_VERSION as MARKDOWN_SCHEMA } from "../markdown/profile.ts";
import { type Projection, project as projectMarkdown } from "../markdown/projection.ts";
import { assemble, type BlockMeta } from "./assemble.ts";
import { csvBlocks, envBlocks, textLines } from "./lines.ts";
import { type FormatId, formatOf, FORMATS } from "./registry.ts";
import { parseStructured } from "./structured.ts";

export const STRUCTURED_PROFILE = "bbdr-structured";
export const LINES_PROFILE = "bbdr-lines";
export const FORMAT_PROFILE_VERSION = 1;
/** Revisions of the new profiles need schema 1.2 (new block types): an older plugin opens them read-only (G3). */
export const FORMAT_SCHEMA_VERSION = "1.2";

/** Parser identity recorded in a Revision (validate recomputes with the same one). */
export const PARSERS: Record<Exclude<FormatId, "markdown"> | "lines-fallback", { name: string; version: string }> = {
  yaml: { name: "yaml", version: "2.9.1" },
  json: { name: "jsonc-parser", version: "3.3.1;json" },
  jsonc: { name: "jsonc-parser", version: "3.3.1;jsonc" },
  toml: { name: "toml-eslint-parser", version: "1.0.3" },
  dotenv: { name: "bbdr-dotenv", version: "1" },
  text: { name: "bbdr-lines", version: "1" },
  csv: { name: "bbdr-csv", version: "1;comma" },
  tsv: { name: "bbdr-csv", version: "1;tab" },
  "lines-fallback": { name: "bbdr-lines", version: "1;parse-error" },
};

export interface FileProjection extends Projection {
  format: FormatId;
  parser: { name: string; version: string };
  /** Schema version of a Revision object built from this projection. */
  schemaVersion: string;
  /** Unhashed per-block metadata for views (key path, key, value as shown, kind, comment, cells). */
  meta: (BlockMeta | undefined)[];
  /** A structured file that does not parse: shown as lines, «Pretty» unavailable until fixed. */
  parseError: { line: number; message: string } | null;
}

/** Format of a path for projection; anything the registry does not know is projected as Markdown (legacy behaviour). */
export function projectionFormat(path: string): FormatId {
  return formatOf(path) ?? "markdown";
}

export function projectFile(path: string, source: string, options: { wholeDocument?: boolean } = {}): FileProjection {
  const format = projectionFormat(path);
  if (format === "markdown") {
    const p = projectMarkdown(source, options);
    return Object.assign(p, { format, parser: MARKDOWN_PARSER, schemaVersion: MARKDOWN_SCHEMA, meta: [] as (BlockMeta | undefined)[], parseError: null });
  }
  if (FORMATS[format].profile === "bbdr-structured") {
    const parsed = parseStructured(format as "yaml" | "json" | "jsonc" | "toml", source);
    if (parsed.ok) {
      const p = assemble(STRUCTURED_PROFILE, FORMAT_PROFILE_VERSION, source, parsed.atoms);
      return Object.assign(p, { format, parser: PARSERS[format as "yaml"], schemaVersion: FORMAT_SCHEMA_VERSION, parseError: null });
    }
    const p = assemble(LINES_PROFILE, FORMAT_PROFILE_VERSION, source, textLines(source));
    return Object.assign(p, { format, parser: PARSERS["lines-fallback"], schemaVersion: FORMAT_SCHEMA_VERSION, parseError: { line: parsed.line, message: parsed.message } });
  }
  const atoms = format === "dotenv" ? envBlocks(source) : format === "csv" ? csvBlocks(source, ",") : format === "tsv" ? csvBlocks(source, "\t") : textLines(source);
  const p = assemble(LINES_PROFILE, FORMAT_PROFILE_VERSION, source, atoms);
  return Object.assign(p, { format, parser: PARSERS[format as "text"], schemaVersion: FORMAT_SCHEMA_VERSION, parseError: null });
}
