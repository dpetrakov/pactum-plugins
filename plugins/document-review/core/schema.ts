// Schemas v1 of .bb-docs (format.md). Zod is the source; schemas/v1/*.schema.json are generated from it.
// Everything here is untrusted input when read back from a repository.
import { z } from "zod";
import { canonicalJson } from "./canonical-json.ts";

/**
 * Version written by default (objects, config, events without 1.1 features): the oldest that can express them, so a
 * plugin of an older minor keeps reading everything it can (G3). `SCHEMA_LATEST` is the newest this code knows.
 */
export const SCHEMA_VERSION = "1.0";
export const SCHEMA_LATEST = "1.3";
export const SCHEMA_MAJOR = 1;
export const SCHEMA_MINOR = 3;
export const VOCAB = "urn:bb-docs:vocab:v1#";
export const W3C_CONTEXT = "http://www.w3.org/ns/anno.jsonld";
export const CONTEXT = [W3C_CONTEXT, { bbdr: VOCAB }] as const;

const MAX_TEXT = 1_000_000;

export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "sha256: 64 lowercase hex");
export const Id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "lowercase UUID");
/** `<revisionId>.<n>`: lineage and version ids are born in a revision. */
export const BlockRef = z.string().regex(/^[0-9a-f-]{36}\.\d+$/, "<revisionId>.<n>");
export const TombstoneId = z.string().regex(/^[0-9a-f-]{36}~[0-9a-f-]{36}\.\d+$/, "<revisionId>~<lineageId>");
export const Timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "UTC ISO 8601 with milliseconds");
export const SchemaVersion = z.string().regex(/^\d+\.\d+$/, "<major>.<minor>");
export const Email = z.string().min(3).max(320).regex(/^[^\s@]+@[^\s@]+$/, "email");
/** Normalized email: what identifies a reader (DR-02). */
export const ReaderId = Email.refine((value) => value === value.trim().toLowerCase(), "readerId is the lowercased, trimmed email");

/** Repo-relative POSIX path: no absolute paths, drive letters, backslashes, empty or dot segments. */
export function isRepoPath(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  if (value.includes("\\") || value.includes("\0")) return false;
  if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
export const RepoPath = z.string().refine(isRepoPath, "repo-relative path without ., .., leading / or backslashes");
/** A root may also be the repository itself. */
export const RootPath = z.union([z.literal("."), RepoPath]);
/** gitignore-style pattern; a leading / anchors it at the repository root, not at the machine root. */
const Pattern = z.string().min(1).max(4096).refine((value) => !value.includes("\0") && !value.includes("\\") && !/[\r\n]/.test(value), "gitignore-style pattern");

export const CpRange = z.object({ start: z.number().int().min(0), end: z.number().int().min(0) })
  .refine((range) => range.end >= range.start, "end >= start");

export const GitIdentity = z.object({ name: z.string().min(1).max(512), email: Email });

export const Actor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), name: z.string().min(1).max(512), email: Email }),
  z.object({ kind: z.literal("agent"), model: z.string().min(1).max(256), threadId: z.string().max(256).nullable(), requestedBy: GitIdentity }),
]);

// ── config.json ─────────────────────────────────────────────────────────────

export const Config = z.object({
  schemaVersion: SchemaVersion,
  repoId: Id,
  /** Review roots; documents outside are visible to no tree but still openable. */
  roots: z.array(RootPath).min(1).max(256),
  /** Visibility rules (tree and search only), gitignore semantics, last match wins. */
  hidden: z.array(Pattern).max(4096),
  /** Tracking rules: matched documents accumulate no unread changes. */
  untracked: z.array(Pattern).max(4096),
  /** 1.2 (W-06c, file-types.md §4): repository exclusion rules over the built-in ones (gitignore syntax, `!` returns). */
  exclude: z.array(Pattern).max(4096).optional(),
  /** 1.2: reviewable type groups of this repository (absent = every type of wave 1). */
  types: z.array(z.enum(["markdown", "yaml", "json", "toml", "dotenv", "text", "csv"])).max(16).optional(),
  /** 1.2 (§8, F14): extensions of the built-in secret-key pattern (key name regular expressions, case-insensitive). */
  secretKeys: z.array(z.string().min(1).max(512)).max(256).optional(),
  /** 1.2 (§8, F17): «not a secret for everyone in the repository» — file path + key path (JSON array of segments). */
  secretExemptions: z.array(z.object({ path: RepoPath, keyPath: z.string().min(2).max(4096) })).max(4096).optional(),
});
export type Config = z.infer<typeof Config>;
/** Fields of config.json that need schema 1.2. */
export const CONFIG_12_FIELDS = ["exclude", "types", "secretKeys", "secretExemptions"] as const;
/** The oldest schema version that expresses a config: 1.2 only when a 1.2 field is present (G3). */
export function configVersion(config: Partial<Config>): string {
  return CONFIG_12_FIELDS.some((field) => config[field] !== undefined) ? "1.2" : "1.0";
}

// ── changes inside an operation ────────────────────────────────────────────

const Kind = z.enum(["action", "note"]);
const VersionRef = z.object({ lineageId: BlockRef, versionId: BlockRef });

export const ObservationReason = z.enum(["baseline", "tracking-resumed", "reference", "batch-input", "batch-output", "reconcile"]);

/**
 * 1.3 (W-06f): a reader's personal layout of an embedded diagram. The scope is nested on purpose: a plugin of 1.2 reads
 * an event it cannot parse by its top-level docId/readerId and would make the whole document and the reader's receipts
 * read-only; nested, only the layout entity of that older plugin is affected.
 */
export const LayoutScope = z.object({ doc: Id, lineage: BlockRef, reader: ReaderId });
const LayoutCoord = z.number().int().min(-100_000).max(100_000);
const DiagramNodeId = z.string().min(1).max(200);

export const Change = z.discriminatedUnion("type", [
  z.object({ type: z.literal("document.registered"), docId: Id, path: RepoPath }),
  z.object({ type: z.literal("document.moved"), docId: Id, from: RepoPath, to: RepoPath }),
  z.object({ type: z.literal("document.removed"), docId: Id, path: RepoPath }),
  /** 1.2 (§9, F15): the review data of a document moved between .bb-docs and the local store; after `to-local` the shared data is read-only. */
  z.object({ type: z.literal("document.transferred"), docId: Id, direction: z.enum(["to-git", "to-local"]) }),
  /** A persistent Revision: the object and its snapshot are published before this event. */
  z.object({ type: z.literal("document.observed"), docId: Id, revisionId: Id, revision: Sha256, reason: ObservationReason }),

  z.object({ type: z.literal("annotation.created"), annotationId: Id, docId: Id, annotation: Sha256, kind: Kind, messageId: Id }),
  z.object({ type: z.literal("annotation.withdrawn"), annotationId: Id }),
  z.object({ type: z.literal("annotation.restored"), annotationId: Id }),
  z.object({ type: z.literal("annotation.kind-changed"), annotationId: Id, kind: Kind }),
  /** Manual re-anchoring: a new target object; the original target stays in the annotation. */
  z.object({ type: z.literal("annotation.reanchored"), annotationId: Id, revisionId: Id, target: Sha256 }),
  z.object({ type: z.literal("anchor.resolved"), annotationId: Id, revisionId: Id, resolution: Sha256 }),

  z.object({ type: z.literal("message.appended"), annotationId: Id, messageId: Id, text: z.string().min(1).max(MAX_TEXT),
    runId: Id.optional(), itemId: z.string().max(64).optional() }),
  z.object({ type: z.literal("message.revised"), annotationId: Id, messageId: Id, text: z.string().min(1).max(MAX_TEXT) }),
  z.object({ type: z.literal("discussion.closed"), annotationId: Id }),
  z.object({ type: z.literal("discussion.reopened"), annotationId: Id }),
  /** «Retry processing»: instructions covered by earlier results become candidates again. */
  z.object({ type: z.literal("discussion.retry-requested"), annotationId: Id }),
  /** Explicit resolution of concurrent contradicting changes; `resolves` are the conflicting events. */
  z.object({ type: z.literal("conflict.resolved"), annotationId: Id, field: z.enum(["status", "kind", "message"]),
    messageId: Id.optional(), value: z.string().min(1).max(MAX_TEXT), resolves: z.array(Id).min(2).max(64) }),

  z.object({ type: z.literal("read.acknowledged"), receiptId: Id, readerId: ReaderId, docId: Id, revisionId: Id,
    /** 1.1: «removal» — the reader acknowledged the deletion of the whole document at revisionId (no versions, DR-02). */
    scope: z.enum(["block", "section", "document", "repo", "accept", "removal"]),
    versions: z.array(VersionRef).max(100_000), tombstones: z.array(TombstoneId).max(100_000) }),
  z.object({ type: z.literal("read.revoked"), receiptId: Id, readerId: ReaderId }),

  z.object({ type: z.literal("batch.prepared"), runId: Id, manifest: Sha256,
    items: z.array(z.object({ itemId: z.string().min(1).max(64), annotationId: Id, seenHeads: z.array(Id).min(1).max(256) })).min(1).max(10_000) }),
  z.object({ type: z.literal("batch.dispatched"), runId: Id, attemptId: Id,
    recipient: z.object({ mode: z.enum(["current-thread", "new-thread"]), threadId: z.string().max(256).nullable() }) }),
  /** DR-01: a document outside the input manifest registered before the agent's first edit. */
  z.object({ type: z.literal("batch.input-registered"), runId: Id, docId: Id, revisionId: Id }),
  z.object({ type: z.literal("item.result-recorded"), runId: Id, attemptId: Id, itemId: z.string().min(1).max(64), responseId: Id,
    annotationId: Id, status: z.enum(["done", "needs-input", "failed", "skipped"]), seenHeads: z.array(Id).min(1).max(256),
    messageId: Id, before: z.array(Id).max(1024), after: z.array(Id).max(1024),
    claimedEdits: z.array(z.object({ docId: Id, revisionId: Id, range: CpRange })).max(1024) }),
  z.object({ type: z.literal("batch.finished"), runId: Id, attemptId: Id, outcome: z.enum(["completed", "partial", "failed", "cancelled"]) }),

  /** 1.3: a finished gesture — nodes pinned at diagram coordinates (integers, independent of zoom/theme/column). */
  z.object({ type: z.literal("layout.pinned"), scope: LayoutScope, revisionId: Id, engine: z.string().min(1).max(64),
    nodes: z.array(z.object({ id: DiagramNodeId, x: LayoutCoord, y: LayoutCoord })).min(1).max(200) }),
  /** 1.3: «Reset» — the named nodes return to the automatic layout. */
  z.object({ type: z.literal("layout.unpinned"), scope: LayoutScope, revisionId: Id, nodes: z.array(DiagramNodeId).min(1).max(400) }),
]);
export type Change = z.infer<typeof Change>;
export type ChangeType = Change["type"];
export const CHANGE_TYPES = Change.options.map((option) => option.shape.type.value);

// ── operation (one event file) ─────────────────────────────────────────────

export const Operation = z.object({
  schemaVersion: SchemaVersion,
  id: Id,
  actor: Actor,
  /** Display only: order comes from parents, never from clocks. */
  timestamp: Timestamp,
  /** Heads of every touched entity at write time, sorted and unique. */
  parents: z.array(Id).max(4096).refine((ids) => ids.every((id, index) => index === 0 || ids[index - 1] < id), "sorted, unique"),
  changes: z.array(Change).min(1).max(1024),
});
export type Operation = z.infer<typeof Operation>;

// ── objects (objects/<sha>.json) ───────────────────────────────────────────

const Selector = z.discriminatedUnion("type", [
  z.object({ type: z.literal("TextQuoteSelector"), exact: z.string().max(MAX_TEXT), prefix: z.string().max(4096), suffix: z.string().max(4096) }),
  z.object({ type: z.literal("TextPositionSelector"), start: z.number().int().min(0), end: z.number().int().min(0) }),
  /** 1.2 (§7): key path of a structured target — JSON array of segments (keys, indices, {"doc": n}). */
  z.object({ type: z.literal("bbdr:KeyPathSelector"), value: z.string().min(2).max(4096) }),
  /** 1.2 (§7): 1-based inclusive line range of the raw source the target was made on (“Raw”). */
  z.object({ type: z.literal("bbdr:LineRangeSelector"), start: z.number().int().min(1), end: z.number().int().min(1) }),
  /** 1.3 (W-06f, EP-073-T08): an element of an embedded object — by the visualizer's id inside the block, with its words. */
  z.object({ type: z.literal("bbdr:ObjectSelector"), id: z.string().min(1).max(200), kind: z.enum(["node", "edge", "group", "text", "other"]), label: z.string().max(400),
    range: z.object({ line: z.number().int().min(1), start: z.number().int().min(0), end: z.number().int().min(0) }).optional() }),
]);

export const TargetKind = z.enum(["text", "block", "section", "document", "change"]);

/** W3C Web Annotation target. Only W3C terms are unprefixed; everything of ours is `bbdr:`. */
export const Target = z.object({
  type: z.literal("SpecificResource"),
  /** urn:bb-docs:<repoId>:doc:<docId>:rev:<revisionId>:proj:<profile>/<version> */
  source: z.string().regex(/^urn:bb-docs:[0-9a-f-]{36}:doc:[0-9a-f-]{36}:rev:[0-9a-f-]{36}:proj:[a-z0-9-]+\/\d+$/),
  selector: z.array(Selector).max(4).optional(),
  "bbdr:targetKind": TargetKind,
  "bbdr:docId": Id,
  "bbdr:revisionId": Id,
  "bbdr:path": RepoPath,
  "bbdr:snapshot": Sha256,
  "bbdr:segments": z.array(z.object({ lineageId: BlockRef, versionId: BlockRef, start: z.number().int().min(0), end: z.number().int().min(0) })).max(10_000),
  "bbdr:sourceRanges": z.array(CpRange).max(10_000),
  "bbdr:tombstoneId": TombstoneId.optional(),
});

export const Annotation = z.object({
  "@context": z.tuple([z.literal(W3C_CONTEXT), z.object({ bbdr: z.literal(VOCAB) })]),
  type: z.literal("Annotation"),
  /** urn:bb-docs:<repoId>:annotation:<annotationId> */
  id: z.string().regex(/^urn:bb-docs:[0-9a-f-]{36}:annotation:[0-9a-f-]{36}$/),
  created: Timestamp,
  creator: z.object({ type: z.literal("Person"), name: z.string().min(1).max(512), email: z.string().regex(/^mailto:[^\s@]+@[^\s@]+$/) }),
  motivation: z.literal("commenting"),
  body: z.object({ type: z.literal("TextualBody"), value: z.string().min(1).max(MAX_TEXT), format: z.literal("text/markdown") }),
  target: Target,
  "bbdr:schemaVersion": SchemaVersion,
});
export type Annotation = z.infer<typeof Annotation>;

const Placement = z.object({ afterLineageId: BlockRef.nullable(), beforeLineageId: BlockRef.nullable(), sectionLineageId: BlockRef.nullable() });
const BlockType = z.enum(["heading", "paragraph", "listItem", "tableCell", "code", "image", "thematicBreak", "html", "frontmatter", "footnoteDefinition", "definition",
  /* 1.2 (W-06c): bbdr-structured leaf and group, bbdr-lines line */ "node", "group", "line"]);

export const Revision = z.object({
  type: z.literal("Revision"),
  schemaVersion: SchemaVersion,
  revisionId: Id,
  docId: Id,
  path: RepoPath,
  parents: z.array(Id).max(64),
  snapshot: Sha256,
  parser: z.object({ name: z.string().min(1).max(256), version: z.string().min(1).max(256) }),
  projection: z.object({ profile: z.string().min(1).max(64), version: z.number().int().min(1) }),
  blocks: z.array(z.object({
    lineageId: BlockRef,
    versionId: BlockRef,
    type: BlockType,
    range: CpRange,
    source: CpRange,
    semanticHash: Sha256,
    textHash: Sha256,
    headings: z.array(z.number().int().min(0)).max(64),
    origin: z.object({ kind: z.enum(["split", "merge"]), sources: z.array(VersionRef).min(1).max(64) }).optional(),
  })).max(200_000),
  removed: z.array(z.object({
    tombstoneId: TombstoneId, lineageId: BlockRef, versionId: BlockRef, text: z.string().max(MAX_TEXT), type: BlockType, placement: Placement,
  })).max(200_000),
  /** 1.2 (§8): the snapshot is the redacted form; `rules` is sha256 of the canonical masking rules (built-in ∪ repository − exemptions). */
  redacted: z.object({ rules: Sha256 }).optional(),
});

export const AnchorResolution = z.object({
  type: z.literal("AnchorResolution"),
  schemaVersion: SchemaVersion,
  annotationId: Id,
  revisionId: Id,
  status: z.enum(["exact", "mapped", "approximate", "ambiguous", "orphaned"]),
  ranges: z.array(CpRange).max(10_000),
  place: z.object({ lineageId: BlockRef }).nullable(),
  evidence: z.array(z.string().max(256)).max(256),
  /** Ranked candidates; `rank` is an internal heuristic order 0…1000, not a probability. */
  candidates: z.array(z.object({ range: CpRange, rank: z.number().int().min(0).max(1000), evidence: z.array(z.string().max(256)).max(64) })).max(32),
});

/** Input manifest of a batch; the lifecycle is W-03, the shape is fixed here so events can reference it. */
export const BatchManifest = z.object({
  type: z.literal("BatchManifest"),
  schemaVersion: SchemaVersion,
  runId: Id,
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("document"), docId: Id }),
    z.object({ kind: z.literal("all") }),
    z.object({ kind: z.literal("annotation"), annotationId: Id }),
  ]),
  editScope: z.array(RootPath).max(256),
  documents: z.array(z.object({ docId: Id, path: RepoPath, revisionId: Id })).max(100_000),
  items: z.array(z.object({ itemId: z.string().min(1).max(64), annotationId: Id, seenHeads: z.array(Id).min(1).max(256) })).max(10_000),
  requestedBy: GitIdentity,
});

export const ObjectValue = z.discriminatedUnion("type", [Annotation, Revision, AnchorResolution, BatchManifest]);
export type ObjectValue = z.infer<typeof ObjectValue>;

// ── version handling (G3) ─────────────────────────────────────────────────

export type VersionVerdict = "current" | "newer-minor" | "unknown-major" | "invalid";

export function versionOf(value: string | undefined): VersionVerdict {
  const match = typeof value === "string" ? /^(\d+)\.(\d+)$/.exec(value) : null;
  if (!match) return "invalid";
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== SCHEMA_MAJOR) return "unknown-major";
  return minor > SCHEMA_MINOR ? "newer-minor" : "current";
}

export type Parsed<T> =
  | { ok: true; value: T; version: "current" | "newer-minor" }
  | { ok: false; version: VersionVerdict; issues: string[] };

function issuesOf(error: z.ZodError): string[] {
  return error.issues.slice(0, 20).map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`);
}

/**
 * Parse with the v1 schema. A newer minor of the same major keeps known fields and reports
 * "newer-minor" (the caller opens it read-only); fields not known to this version are an error
 * for the current minor, so a typo cannot silently disappear on rewrite.
 */
export function parseVersioned<T>(schema: z.ZodType<T>, raw: unknown, versionField: string, rawText?: string): Parsed<T> {
  const declared = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>)[versionField] : undefined;
  const version = versionOf(typeof declared === "string" ? declared : undefined);
  if (version === "invalid" || version === "unknown-major") {
    return { ok: false, version, issues: [`${versionField}: ${version === "invalid" ? "missing or malformed" : `unsupported major ${String(declared)}`}`] };
  }
  const result = schema.safeParse(raw);
  // A newer minor that this code cannot parse keeps its verdict: the caller opens what it touches read-only (G3).
  if (!result.success) return { ok: false, version: version === "newer-minor" ? "newer-minor" : "invalid", issues: issuesOf(result.error) };
  if (version === "current") {
    let same = false;
    try {
      // Fast path: canonical bytes on disk equal the canonical text of the parsed value (no second serialization).
      const parsedText = canonicalJson(result.data);
      same = parsedText === rawText || parsedText === canonicalJson(raw);
    } catch {
      // Non-integer numbers and other values outside canonical JSON.
    }
    if (!same) return { ok: false, version: "invalid", issues: ["unknown fields or non-canonical values for schema 1.0"] };
  }
  return { ok: true, value: result.data, version };
}

/** The oldest schema version that can express an operation: features of a newer minor need that minor. */
export function requiredVersion(operation: Pick<Operation, "changes">): string {
  if (operation.changes.some((change) => change.type === "layout.pinned" || change.type === "layout.unpinned")) return "1.3";
  if (operation.changes.some((change) => change.type === "document.transferred")) return "1.2";
  return operation.changes.some((change) => change.type === "read.acknowledged" && change.scope === "removal") ? "1.1" : "1.0";
}

/**
 * Version of an operation that also publishes objects: never older than the newest object it brings. A previous
 * release then treats the whole operation as a newer minor (its entities read-only) instead of reporting the 1.2
 * objects it cannot parse as damaged or missing (G3, EP-040-T06).
 */
export function operationVersion(changes: Operation["changes"], objects: readonly { schemaVersion?: string; "bbdr:schemaVersion"?: string }[] = []): string {
  let best = requiredVersion({ changes });
  for (const object of objects) {
    const version = (object as { "bbdr:schemaVersion"?: string })["bbdr:schemaVersion"] ?? object.schemaVersion;
    if (version && /^1\.\d+$/.test(version) && Number(version.split(".")[1]) > Number(best.split(".")[1])) best = version;
  }
  return best;
}

/** Semantic checks a schema cannot express: version-gated features and the shape of a removal receipt. */
function operationIssues(operation: Operation): string[] {
  const issues: string[] = [];
  const minor = (version: string) => Number(version.split(".")[1]);
  const required = requiredVersion(operation);
  if (minor(operation.schemaVersion) < minor(required)) issues.push(`changes need schema ${required}, the operation declares ${operation.schemaVersion}`);
  for (const change of operation.changes) {
    if (change.type === "read.acknowledged" && change.scope === "removal" && (change.versions.length || change.tombstones.length)) issues.push("a removal receipt confirms the deletion of the document only: no versions or tombstones");
    if (change.type === "layout.pinned" && new Set(change.nodes.map((node) => node.id)).size !== change.nodes.length) issues.push("a node is pinned twice in one change");
    if (change.type === "layout.unpinned" && new Set(change.nodes).size !== change.nodes.length) issues.push("a node is unpinned twice in one change");
  }
  return issues;
}

const minorOf = (version: string) => Number(version.split(".")[1]);
const NEW_BLOCK_TYPES = new Set(["node", "group", "line"]);

/** Version-gated features of objects (G3): what 1.2 introduced must declare 1.2, so an older plugin opens it read-only. */
function objectIssues(object: ObjectValue): string[] {
  if (object.type === "Revision") {
    const needs = object.redacted !== undefined || object.blocks.some((block) => NEW_BLOCK_TYPES.has(block.type) || block.headings.length > 6)
      || object.removed.some((tombstone) => NEW_BLOCK_TYPES.has(tombstone.type));
    if (needs && minorOf(object.schemaVersion) < 2) return [`revision features need schema 1.2, the object declares ${object.schemaVersion}`];
  }
  if (object.type === "Annotation") {
    const selectors = object.target.selector ?? [];
    if (selectors.some((selector) => selector.type === "bbdr:ObjectSelector") && minorOf(object["bbdr:schemaVersion"]) < 3) return [`an object element selector needs schema 1.3, the object declares ${object["bbdr:schemaVersion"]}`];
    const needs = selectors.some((selector) => selector.type.startsWith("bbdr:"));
    if (needs && minorOf(object["bbdr:schemaVersion"]) < 2) return [`annotation selectors need schema 1.2, the object declares ${object["bbdr:schemaVersion"]}`];
  }
  return [];
}

export function parseConfig(raw: unknown): Parsed<Config> {
  const parsed = parseVersioned(Config, raw, "schemaVersion");
  if (parsed.ok && minorOf(parsed.value.schemaVersion) < 2 && configVersion(parsed.value) === "1.2") {
    return { ok: false, version: "invalid", issues: [`config fields ${CONFIG_12_FIELDS.filter((field) => parsed.value[field] !== undefined).join(", ")} need schema 1.2`] };
  }
  return parsed;
}
export function parseOperation(raw: unknown, rawText?: string): Parsed<Operation> {
  const parsed = parseVersioned(Operation, raw, "schemaVersion", rawText);
  if (!parsed.ok) return parsed;
  const issues = operationIssues(parsed.value);
  return issues.length ? { ok: false, version: "invalid", issues } : parsed;
}
export function parseObject(raw: unknown, rawText?: string): Parsed<ObjectValue> {
  const field = raw !== null && typeof raw === "object" && (raw as Record<string, unknown>).type === "Annotation" ? "bbdr:schemaVersion" : "schemaVersion";
  const parsed = parseVersioned(ObjectValue, raw, field, rawText);
  if (!parsed.ok) return parsed;
  const issues = objectIssues(parsed.value);
  return issues.length ? { ok: false, version: "invalid", issues } : parsed;
}

/** JSON Schemas published in schemas/v1/. */
export const JSON_SCHEMAS = {
  "config": Config,
  "operation": Operation,
  "annotation": Annotation,
  "revision": Revision,
  "anchor-resolution": AnchorResolution,
  "batch-manifest": BatchManifest,
} as const;
