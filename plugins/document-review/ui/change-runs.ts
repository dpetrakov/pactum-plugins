/** The same adjacent marks that the Markdown renderer joins into a continuous run. */
export interface ChangeBlock {
  index: number;
  read: "read" | "unread" | "ambiguous" | null;
  change?: "added" | "edited" | null;
  type?: string;
}

export function changeKind(block: ChangeBlock): "added" | "changed" | "unclear" | null {
  if (block.read === "ambiguous") return "unclear";
  return block.read === "unread" ? block.change === "added" ? "added" : "changed" : null;
}

export function changeRuns(view: { blocks: ChangeBlock[]; removed: { after: number }[] }): number[][] {
  const boundaries = new Set(view.removed.map((entry) => entry.after));
  const runs: number[][] = [];
  let previous: ChangeBlock | null = null;
  for (const block of view.blocks) {
    const kind = changeKind(block);
    if (kind) {
      const joins = previous && previous.index + 1 === block.index && changeKind(previous) === kind
        && !boundaries.has(previous.index) && previous.type !== "tableCell" && block.type !== "tableCell";
      if (joins) runs[runs.length - 1].push(block.index);
      else runs.push([block.index]);
    }
    previous = block;
  }
  return runs;
}

export function changeRun(view: Parameters<typeof changeRuns>[0], index: number): number[] {
  return changeRuns(view).find((run) => run.includes(index)) ?? [index];
}
