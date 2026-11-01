// Pure functions organize missing-file rename proposals for a single review dialog.
import type { MoveProposal } from "../node/tree.ts";

/** A candidate the reviewer can take without looking: the only one, and the same content or Git's own rename. */
export function sureCandidate(proposal: Pick<MoveProposal, "candidates">): MoveProposal["candidates"][number] | null {
  return proposal.candidates.length === 1 && (proposal.candidates[0]!.exact || proposal.candidates[0]!.git) ? proposal.candidates[0]! : null;
}

/**
 * sure — one evident new path (accept all at once); gone — no candidate, a reviewed file (mark removed at once;
 * local files are forgotten one by one, with a confirmation); ask — several candidates or only a resemblance.
 */
export function moveGroups<T extends Pick<MoveProposal, "candidates"> & { local?: boolean }>(proposals: readonly T[]): { sure: T[]; gone: T[]; ask: T[] } {
  const sure: T[] = [], gone: T[] = [], ask: T[] = [];
  for (const proposal of proposals) {
    if (sureCandidate(proposal)) sure.push(proposal);
    else if (!proposal.candidates.length && !proposal.local) gone.push(proposal);
    else ask.push(proposal);
  }
  return { sure, gone, ask };
}

/** «a/b/c.md» → { dir: "a/b/", name: "c.md" } — the name stays readable when the path is cut. */
export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? { dir: "", name: path } : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}
