// Shared shapes of the document-review core. Persistent forms are validated by core/schema.ts;
// these interfaces are what the pure modules exchange in memory.

/** Half-open range [start, end) in Unicode code points. */
export interface CpRange {
  start: number;
  end: number;
}

export type BlockType =
  | "heading"
  | "paragraph"
  | "listItem"
  | "tableCell"
  | "code"
  | "image"
  | "thematicBreak"
  | "html"
  | "frontmatter"
  | "footnoteDefinition"
  | "definition"
  /** bbdr-structured (W-06c): a leaf «key path = value». */
  | "node"
  /** bbdr-structured: the header of a keyed object or array (a «section» of its children). */
  | "group"
  /** bbdr-lines: a line, a CSV record or a .env entry. */
  | "line";

/** One block of a revision: what can be read, commented on and diffed as a unit. */
export interface Block {
  /** Stable identity across revisions; two equal copies are different lineages. */
  lineageId: string;
  /** Changes when the semantic content of this lineage changes; A→B→A gives three versions. */
  versionId: string;
  type: BlockType;
  /** Range of the block text in the canonical projection (code points of the projection). */
  range: CpRange;
  /** Range of the block in the raw snapshot (code points of the raw source). */
  source: CpRange;
  /** sha256 of the canonical semantic fingerprint: text, inline structure, URLs, list state, image attrs, table shape. */
  semanticHash: string;
  /** sha256 of the projected text only. */
  textHash: string;
  /** Index (into blocks) of the nearest preceding heading of each lower depth; [] at top level. */
  headings: number[];
  /** Set when this block was not inherited one-to-one but split from or merged out of earlier versions. */
  origin?: BlockOrigin;
}

export interface BlockOrigin {
  kind: "split" | "merge";
  sources: { lineageId: string; versionId: string }[];
}

/** Where a removed block used to be, by surviving neighbours of the same revision. */
export interface Placement {
  afterLineageId: string | null;
  beforeLineageId: string | null;
  /** Lineage of the heading the block was under, if that heading survives. */
  sectionLineageId: string | null;
}

/** A lineage that a parent revision had and this revision lost. */
export interface Tombstone {
  tombstoneId: string;
  lineageId: string;
  /** Last version of the lineage before removal. */
  versionId: string;
  /** Projected text of that last version, kept so a deletion can be shown without the old snapshot. */
  text: string;
  type: BlockType;
  placement: Placement;
}

/** Persistent revision of one document (DR-03): always backed by an existing raw snapshot. */
export interface Revision {
  type: "Revision";
  schemaVersion: string;
  revisionId: string;
  docId: string;
  /** Repo-relative path the bytes were read from. */
  path: string;
  /** Persistent parent revisions of the same document (more than one after a merge). */
  parents: string[];
  /** sha256 of the raw snapshot bytes. */
  snapshot: string;
  parser: { name: string; version: string };
  projection: { profile: string; version: number };
  blocks: Block[];
  removed: Tombstone[];
  /** 1.2 (W-06c, §8): the snapshot is the redacted form under these shared masking rules. */
  redacted?: { rules: string };
}

/** One version of a lineage as recorded in a receipt or baseline. */
export interface VersionRef {
  lineageId: string;
  versionId: string;
}

export interface GitIdentity {
  name: string;
  email: string;
}

export type Actor =
  | { kind: "human"; name: string; email: string }
  | { kind: "agent"; model: string; threadId: string | null; requestedBy: GitIdentity };
