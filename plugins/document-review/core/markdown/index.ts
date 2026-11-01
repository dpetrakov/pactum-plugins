// Public API of the Markdown core (EP-006): projection, source map, revisions, lineage, anchoring, diff.

export { PARSER, PROJECTION_PROFILE, PROJECTION_VERSION, REVISION_SCHEMA_VERSION } from "./profile.ts";
export { TextCoords } from "./text-coords.ts";
export {
  blockAt,
  blockSegments,
  codePoints,
  type Fingerprint,
  type InlineToken,
  type ProjectedBlock,
  type Projection,
  project,
  projectionToSource,
  quoteAt,
  sliceText,
  sourceToProjection,
  verifyQuote,
} from "./projection.ts";
export { buildRevision, checkRevision, placementIn, type RevisionInput } from "./revision.ts";
export { assertConsistent, type BlockLink, type BlockMatch, MATCH, type MatchKind, matchBlocks, matchProjected } from "./lineage.ts";
export { ANCHOR, type AnchorCandidate, type AnchorResolution, type AnchorStatus, type AnchorTarget, charMap, resolveAnchor } from "./anchoring.ts";
export { type BlockChange, blockDiff, type ChangeKind, rawDiff, REWRITE_THRESHOLD, semanticDiff, splitPortions, type WordOp } from "./diff.ts";
export { containment, similarity, tokenize, words } from "./tokens.ts";
