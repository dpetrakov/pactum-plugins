// Break opportunities inside long tokens of table cells (EP-047): a cell keeps whole words (overflow-wrap: normal — the
// column is never narrower than its longest word), and a long token without spaces — a path, an identifier like
// annotation.kind-changed, a URL — may wrap after its dots, slashes, hyphens and similar separators. The renderer puts
// <wbr> between the segments: it adds no characters, so the block's text, selections and quotes stay exactly the same.

/** Short tokens wrap only at spaces; leave short abbreviations and hyphenated words intact. */
export const LONG_TOKEN = 12;
const SEPARATOR = /[./\\_\-:=#?&|,;@+~]/;

/** Segments of `text`; a <wbr> goes between consecutive segments. Their concatenation is always `text`. */
export function breakSegments(text: string): string[] {
  if (text.length < LONG_TOKEN || !SEPARATOR.test(text)) return [text];
  const segments: string[] = [];
  let current = "";
  // Runs of non-space characters; spaces already are break opportunities.
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part) || part.length < LONG_TOKEN) { current += part; continue; }
    const chars = [...part];
    for (let index = 0; index < chars.length; index++) {
      current += chars[index];
      // After a separator (the last of a run, like «--» or «://»), never at the token's start or end.
      const next = chars[index + 1];
      if (index > 0 && next !== undefined && SEPARATOR.test(chars[index]) && !SEPARATOR.test(next)) {
        segments.push(current);
        current = "";
      }
    }
  }
  if (current) segments.push(current);
  return segments;
}
