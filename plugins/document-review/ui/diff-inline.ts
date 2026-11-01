// «Changes in the text» with the formatting kept (EP-012-T04, F5): the word diff of a block (equal / insert / delete over
// the projected text) is merged into the block's inline tokens. Inserted runs become `ins` marks inside whatever
// marks are open there (bold, link, code…); deleted words become `deleted` leaves at their place. The strings of the
// result still concatenate to the current projected text, so selection offsets are unchanged.

export type DiffWord = { op: string; text: string };

const INS_OPEN = { open: "ins" };
const INS_CLOSE = { close: "ins" };

/**
 * Merge a word diff into inline tokens. Returns null when the diff does not describe the tokens' text (then the
 * caller falls back to the plain diff, which is always correct).
 */
export function mergeDiff(tokens: readonly unknown[], words: readonly DiffWord[]): unknown[] | null {
  const current = tokens.filter((token): token is string => typeof token === "string").join("");
  const visible = words.filter((word) => word.op !== "delete").map((word) => word.text).join("");
  if (visible !== current) return null;
  // Segments over the current text: [start, end) with the op; deletions sit at a position.
  const inserts: { start: number; end: number }[] = [];
  const deletions: { at: number; text: string }[] = [];
  let position = 0;
  for (const word of words) {
    if (word.op === "delete") {
      deletions.push({ at: position, text: word.text });
      continue;
    }
    if (word.op === "insert") inserts.push({ start: position, end: position + word.text.length });
    position += word.text.length;
  }
  const out: unknown[] = [];
  let offset = 0;
  let nextDeletion = 0;
  const flushDeletions = (upTo: number, inclusive: boolean) => {
    while (nextDeletion < deletions.length && (deletions[nextDeletion].at < upTo || (inclusive && deletions[nextDeletion].at === upTo))) {
      out.push({ deleted: deletions[nextDeletion].text });
      nextDeletion++;
    }
  };
  for (const token of tokens) {
    if (typeof token !== "string") {
      out.push(token);
      continue;
    }
    const start = offset;
    const end = offset + token.length;
    // Cut points inside this string: insert boundaries and deletion positions.
    const cuts = new Set<number>([start, end]);
    for (const insert of inserts) {
      if (insert.start > start && insert.start < end) cuts.add(insert.start);
      if (insert.end > start && insert.end < end) cuts.add(insert.end);
    }
    for (const deletion of deletions) if (deletion.at > start && deletion.at < end) cuts.add(deletion.at);
    const points = [...cuts].sort((a, b) => a - b);
    for (let index = 0; index < points.length - 1; index++) {
      const from = points[index];
      const to = points[index + 1];
      flushDeletions(from, true);
      const piece = token.slice(from - start, to - start);
      const inserted = inserts.some((insert) => insert.start <= from && insert.end >= to);
      if (inserted) out.push(INS_OPEN, piece, INS_CLOSE);
      else out.push(piece);
    }
    if (token.length === 0) flushDeletions(start, false);
    offset = end;
  }
  flushDeletions(Number.POSITIVE_INFINITY, true);
  return out;
}
