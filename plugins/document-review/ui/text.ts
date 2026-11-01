// Coordinates of the viewer (EP-008-T02). The DOM gives UTF-16 offsets inside one block's rendered text; W3C
// offsets are Unicode code points of the canonical projection. The rendered text of a block is exactly the block's
// projected text (inline tokens, or equal+insert words of a diff), so a block-local UTF-16 offset converts to a
// projection code point without guessing. DOM offsets never reach the host unconverted.

export interface TextBlock {
  text: string;
  range: { start: number; end: number };
  cell: { table: number; row: number } | null;
}

/** Number of code points in a string (a surrogate pair is one). */
export function cpLength(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index++;
    }
    count++;
  }
  return count;
}

/**
 * UTF-16 offset → code point offset within a text. An offset that splits a surrogate pair is moved to the start of
 * the pair, so a selection never covers half an emoji.
 */
export function utf16ToCp(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let end = clamped;
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
  }
  return cpLength(text.slice(0, end));
}

/** Code point offset → UTF-16 offset within a text (for highlighting ranges in the DOM). */
export function cpToUtf16(text: string, cp: number): number {
  let index = 0;
  let count = 0;
  while (index < text.length && count < cp) {
    const code = text.charCodeAt(index);
    index += code >= 0xd800 && code <= 0xdbff && index + 1 < text.length ? 2 : 1;
    count++;
  }
  return index;
}

/** Separator between two neighbouring blocks in the projection (projection.md): tab between cells of a row, LF between rows, blank line otherwise. */
export function separator(previous: TextBlock, next: TextBlock): string {
  if (previous.cell && next.cell && previous.cell.table === next.cell.table) return previous.cell.row === next.cell.row ? "\t" : "\n";
  return "\n\n";
}

/** The projection text, assembled from blocks exactly as the host projects it. */
export function projectionText(blocks: TextBlock[]): string {
  let text = "";
  blocks.forEach((block, index) => {
    if (index > 0) text += separator(blocks[index - 1], block);
    text += block.text;
  });
  return text;
}

/** Slice of the projection by code points. */
export function sliceCp(text: string, range: { start: number; end: number }): string {
  return text.slice(cpToUtf16(text, range.start), cpToUtf16(text, range.end));
}

/**
 * A DOM selection expressed as (block, UTF-16 offset in the block's rendered text) at both ends → projection range.
 * Returns null for an empty or reversed selection.
 */
export function selectionRange(blocks: TextBlock[], start: { block: number; offset: number }, end: { block: number; offset: number }): { start: number; end: number } | null {
  const a = blocks[start.block];
  const b = blocks[end.block];
  if (!a || !b) return null;
  const from = a.range.start + utf16ToCp(a.text, start.offset);
  const to = b.range.start + utf16ToCp(b.text, end.offset);
  if (to <= from) return null;
  return { start: from, end: to };
}

/** Trim whitespace at both ends of a selection (a triple click selects the trailing newline). */
export function trimRange(text: string, range: { start: number; end: number }): { start: number; end: number } | null {
  const quote = sliceCp(text, range);
  const lead = cpLength(/^\s*/u.exec(quote)?.[0] ?? "");
  const trail = cpLength(/\s*$/u.exec(quote)?.[0] ?? "");
  const start = range.start + lead;
  const end = range.end - trail;
  return end > start ? { start, end } : null;
}
