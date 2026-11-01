// Ordered list numbering of the renderer (W-06): the projection keeps the list's start, the position is counted here.
/** Numbers of ordered list items per nesting level; an unordered item or a block outside the list restarts the count. */
export function listNumbers(blocks: { index: number; type: string; attrs: Record<string, unknown> }[]): Map<number, number> {
  const numbers = new Map<number, number>();
  const counters: (number | undefined)[] = [];
  for (const block of blocks) {
    const depth = Number(block.attrs.list ?? 0);
    if (block.type === "listItem" && depth > 0) {
      counters.length = Math.min(counters.length, depth);
      if (block.attrs.ordered === true) {
        const next = (counters[depth - 1] ?? Number(block.attrs.start ?? 1) - 1) + 1;
        counters[depth - 1] = next;
        numbers.set(block.index, next);
      } else counters[depth - 1] = undefined;
    } else counters.length = Math.min(counters.length, depth);
  }
  return numbers;
}

