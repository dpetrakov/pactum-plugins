// Canonical projection profile identity. Changing any rule in docs/plugins/document-review/projection.md
// that can change a projected text, a block boundary or a fingerprint requires a new PROJECTION_VERSION.

export const PROJECTION_PROFILE = "bbdr-markdown";
export const PROJECTION_VERSION = 1;

/** Parser stack the projection is computed with; recorded in every Revision. */
export const PARSER: { name: string; version: string } = {
  name: "mdast-util-from-markdown+gfm+frontmatter",
  version: "2.1.0;gfm 3.0.0/3.1.0;frontmatter 2.0.0/2.0.1",
};

/** Revision object schema produced by buildRevision. */
export const REVISION_SCHEMA_VERSION = "1.0";

/** Frontmatter flavours recognised at the very start of a document. */
export const FRONTMATTER = ["yaml", "toml"] as const;
