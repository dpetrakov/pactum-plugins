// Persistent Revision from a raw snapshot and its persistent parents (DR-03). Pure and deterministic:
// identical inputs give a byte-identical canonicalJson(revision); parent order does not matter.

import { canonicalJson } from "../canonical-json.ts";
import { sha256 } from "../hash.ts";
import type { Block, BlockOrigin, Placement, Revision, Tombstone } from "../types.ts";
import { assertConsistent, type BlockMatch, maskOnlyChange, matchProjected } from "./lineage.ts";
import { type FileProjection, projectFile } from "../formats/project.ts";
import type { Projection } from "./projection.ts";

export interface RevisionInput {
  revisionId: string;
  docId: string;
  path: string;
  /** Raw snapshot decoded as UTF-8. */
  source: string;
  /** sha256 of the raw snapshot bytes. */
  snapshot: string;
  /** `projection` may be passed when the caller already has project(source) of the parent; it is checked against the revision. */
  parents: { revision: Revision; source: string; projection?: Projection }[];
  /** W-06c (§8): the source is the redacted form under these shared rules; recorded in the Revision (1.2). */
  redacted?: { rules: string } | null;
}

const ONE_TO_ONE = new Set(["same", "edited", "moved", "moved-edited"]);

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Where a block of a parent was, by neighbours and section that survive in the new revision. */
export function placementIn(parent: Revision, projection: Projection, index: number, survives: (lineageId: string) => boolean): Placement {
  let afterLineageId: string | null = null;
  for (let k = index - 1; k >= 0; k -= 1) if (survives(parent.blocks[k].lineageId)) {
    afterLineageId = parent.blocks[k].lineageId;
    break;
  }
  let beforeLineageId: string | null = null;
  for (let k = index + 1; k < parent.blocks.length; k += 1) if (survives(parent.blocks[k].lineageId)) {
    beforeLineageId = parent.blocks[k].lineageId;
    break;
  }
  let sectionLineageId: string | null = null;
  const headings = projection.blocks[index].headings;
  for (let k = headings.length - 1; k >= 0; k -= 1) if (survives(parent.blocks[headings[k]].lineageId)) {
    sectionLineageId = parent.blocks[headings[k]].lineageId;
    break;
  }
  return { afterLineageId, beforeLineageId, sectionLineageId };
}

interface ParentMatch {
  revision: Revision;
  projection: Projection;
  match: BlockMatch;
}

/**
 * Build the Revision of a snapshot.
 *
 * Lineage rules (projection.md «Lineage»): a block born in R at index n gets lineageId = versionId = `${R}.${n}`.
 * A block matched one-to-one keeps the parent lineage, and the parent versionId iff the semanticHash is equal.
 * Split/merge produce a new lineage with an origin. Several parents (Git merge): each parent is matched
 * independently in revisionId order; a block keeps a lineage only if every parent that matched it one-to-one agrees
 * and no other block claims the same lineage; otherwise it is new. Lost parent lineages become tombstones.
 */
export function buildRevision(input: RevisionInput): { revision: Revision; projection: FileProjection } {
  // The format of the file decides the profile (W-06c): Markdown — bbdr-markdown v1 as before; other types — §5.
  const projection = projectFile(input.path, input.source);
  const R = input.revisionId;
  const parents: ParentMatch[] = [...input.parents]
    .sort((a, b) => compare(a.revision.revisionId, b.revision.revisionId))
    .map((parent) => {
      const parentProjection = parent.projection && parent.projection.source === parent.source && parent.projection.profile === parent.revision.projection.profile
        ? parent.projection : projectFile(parent.revision.path, parent.source);
      assertConsistent(parent.revision, parentProjection);
      return { revision: parent.revision, projection: parentProjection, match: matchProjected(parentProjection.blocks, projection.blocks) };
    });
  const ids = parents.map((p) => p.revision.revisionId);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate parent revision");

  const N = projection.blocks.length;
  // One-to-one claims per new block.
  const claims: ({ lineageId: string; from: { parent: number; old: number }[] } | null)[] = [];
  for (let n = 0; n < N; n += 1) {
    const from: { parent: number; old: number; lineageId: string }[] = [];
    parents.forEach((p, pi) => {
      const link = p.match.next[n];
      if (ONE_TO_ONE.has(link.kind)) from.push({ parent: pi, old: link.old[0], lineageId: p.revision.blocks[link.old[0]].lineageId });
    });
    const lineages = new Set(from.map((f) => f.lineageId));
    claims.push(lineages.size === 1 ? { lineageId: from[0].lineageId, from } : null);
  }
  const claimCount = new Map<string, number>();
  for (const claim of claims) if (claim) claimCount.set(claim.lineageId, (claimCount.get(claim.lineageId) ?? 0) + 1);

  const blocks: Block[] = projection.blocks.map((pb, n) => {
    const own = `${R}.${n}`;
    const base: Omit<Block, "lineageId" | "versionId"> = {
      type: pb.type,
      range: { start: pb.range.start, end: pb.range.end },
      source: { start: pb.source.start, end: pb.source.end },
      semanticHash: pb.semanticHash,
      textHash: pb.textHash,
      headings: [...pb.headings],
    };
    const claim = claims[n];
    if (claim && claimCount.get(claim.lineageId) === 1) {
      // Same content, or only the mask changed (a value masked or unmasked by other rules — §8): the version is kept.
      const equal = claim.from.find((f) => parents[f.parent].revision.blocks[f.old].semanticHash === pb.semanticHash
        || maskOnlyChange(parents[f.parent].projection.blocks[f.old], pb));
      const first = parents[claim.from[0].parent].revision.blocks[claim.from[0].old];
      const block: Block = { lineageId: claim.lineageId, versionId: equal ? parents[equal.parent].revision.blocks[equal.old].versionId : own, ...base };
      if (first.origin) block.origin = { kind: first.origin.kind, sources: first.origin.sources.map((s) => ({ ...s })) };
      return block;
    }
    for (const p of parents) {
      const link = p.match.next[n];
      if (link.kind === "split" || link.kind === "merge") {
        const origin: BlockOrigin = {
          kind: link.kind,
          sources: link.old.map((o) => ({ lineageId: p.revision.blocks[o].lineageId, versionId: p.revision.blocks[o].versionId })),
        };
        return { lineageId: own, versionId: own, ...base, origin };
      }
    }
    return { lineageId: own, versionId: own, ...base };
  });

  const present = new Set(blocks.map((b) => b.lineageId));
  const consumed = new Set<string>();
  blocks.forEach((b, n) => {
    if (b.lineageId === `${R}.${n}` && b.origin) for (const s of b.origin.sources) consumed.add(s.lineageId);
  });
  const removed: Tombstone[] = [];
  const seen = new Set<string>();
  for (const p of parents) {
    p.revision.blocks.forEach((old, o) => {
      if (present.has(old.lineageId) || consumed.has(old.lineageId) || seen.has(old.lineageId)) return;
      seen.add(old.lineageId);
      removed.push({
        tombstoneId: `${R}~${old.lineageId}`,
        lineageId: old.lineageId,
        versionId: old.versionId,
        text: p.projection.blocks[o].text,
        type: old.type,
        placement: placementIn(p.revision, p.projection, o, (id) => present.has(id)),
      });
    });
  }

  const revision: Revision = {
    type: "Revision",
    schemaVersion: input.redacted ? "1.2" : projection.schemaVersion,
    revisionId: R,
    docId: input.docId,
    path: input.path,
    parents: ids,
    snapshot: input.snapshot,
    parser: { name: projection.parser.name, version: projection.parser.version },
    projection: { profile: projection.profile, version: projection.version },
    blocks,
    removed,
  };
  if (input.redacted) revision.redacted = { rules: input.redacted.rules };
  return { revision, projection };
}

/**
 * Recompute a stored Revision from its snapshot and parents and list every difference.
 * Used by validate: blocks (type, ranges, hashes, headings) come from the snapshot alone; lineage, versions,
 * origins and tombstones from the parent revisions and their snapshots.
 */
export function checkRevision(input: { revision: Revision; source: string; parents: { revision: Revision; source: string }[] }): { ok: boolean; problems: string[] } {
  const stored = input.revision;
  const problems: string[] = [];
  const expected = projectFile(stored.path, input.source);
  if (stored.projection?.profile !== expected.profile || stored.projection?.version !== expected.version) {
    return { ok: false, problems: [`projection ${stored.projection?.profile} v${stored.projection?.version} cannot be recomputed by ${expected.profile} v${expected.version}`] };
  }
  if (stored.parser?.name !== expected.parser.name || stored.parser?.version !== expected.parser.version) problems.push(`parser ${stored.parser?.name} ${stored.parser?.version} differs from ${expected.parser.name} ${expected.parser.version}`);
  if (sha256(input.source) !== stored.snapshot) problems.push("snapshot hash does not match the UTF-8 encoding of the source");
  const given = input.parents.map((p) => p.revision.revisionId).sort(compare);
  const listed = [...stored.parents].sort(compare);
  if (canonicalJson(given) !== canonicalJson(listed)) problems.push(`parents ${JSON.stringify(stored.parents)} but ${JSON.stringify(given)} provided`);
  let rebuilt: Revision;
  try {
    rebuilt = buildRevision({
      revisionId: stored.revisionId,
      docId: stored.docId,
      path: stored.path,
      source: input.source,
      snapshot: stored.snapshot,
      parents: input.parents,
      redacted: stored.redacted ?? null,
    }).revision;
  } catch (error) {
    problems.push(`cannot rebuild: ${(error as Error).message}`);
    return { ok: false, problems };
  }
  for (const key of ["type", "schemaVersion"] as const) if (stored[key] !== rebuilt[key]) problems.push(`${key} ${stored[key]} != ${rebuilt[key]}`);
  if (canonicalJson(stored.parents) !== canonicalJson(rebuilt.parents)) problems.push("parents are not sorted by revisionId");
  if (stored.blocks.length !== rebuilt.blocks.length) problems.push(`blocks: ${stored.blocks.length} stored, ${rebuilt.blocks.length} recomputed`);
  const count = Math.min(stored.blocks.length, rebuilt.blocks.length);
  for (let i = 0; i < count; i += 1) {
    const a = stored.blocks[i] as unknown as Record<string, unknown>;
    const b = rebuilt.blocks[i] as unknown as Record<string, unknown>;
    for (const key of ["type", "range", "source", "semanticHash", "textHash", "headings", "lineageId", "versionId", "origin"]) {
      if (canonicalJson(a[key] ?? null) !== canonicalJson(b[key] ?? null)) problems.push(`block ${i}: ${key} differs`);
    }
    const extra = Object.keys(a).filter((key) => !(key in b) && key !== "origin");
    if (extra.length) problems.push(`block ${i}: unexpected ${extra.join(", ")}`);
  }
  if (canonicalJson(stored.removed) !== canonicalJson(rebuilt.removed)) problems.push("removed (tombstones) differ");
  return { ok: problems.length === 0, problems };
}
