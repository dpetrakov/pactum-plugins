// Tokenization and text similarity shared by lineage matching, anchoring and the word diff.
// Deterministic and locale-free: no Intl.Segmenter (ICU data differs between runtimes), no case folding beyond toLowerCase.

/**
 * Tokens: words (letters, combining marks, digits, connector punctuation), whitespace runs, emoji sequences
 * (ZWJ, skin tone, VS16, keycap), regional-indicator pairs, otherwise one code point with its combining marks.
 * Concatenating the tokens gives back the input exactly.
 */
const TOKEN =
  /[\p{L}\p{M}\p{N}\p{Pc}]+|\s+|\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️|⃣)*(?:‍\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️)*)*|\p{Regional_Indicator}{2}|[\s\S]\p{M}*/gu;

const WORD = /^[\p{L}\p{M}\p{N}\p{Pc}]+$/u;
const SPACE = /^\s+$/u;

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

export function isWord(token: string): boolean {
  return WORD.test(token);
}

export function isSpace(token: string): boolean {
  return SPACE.test(token);
}

/** Lowercased words of a text, in order. */
export function words(text: string): string[] {
  return tokenize(text).filter(isWord).map((word) => word.toLowerCase());
}

function bag(items: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) out.set(item, (out.get(item) ?? 0) + 1);
  return out;
}

function overlap(a: string[], b: string[]): number {
  const counts = bag(b);
  let common = 0;
  for (const item of a) {
    const left = counts.get(item) ?? 0;
    if (left > 0) {
      common += 1;
      counts.set(item, left - 1);
    }
  }
  return common;
}

function bigrams(text: string): string[] {
  const cps = Array.from(text.toLowerCase().replace(/\s+/gu, " ").trim());
  const out: string[] = [];
  for (let i = 0; i + 1 < cps.length; i += 1) out.push(cps[i] + cps[i + 1]);
  return out;
}

/** Below this many words on either side, similarity falls back to character bigrams. */
export const SHORT_WORDS = 3;

/**
 * Similarity in [0, 1]: Dice coefficient over word multisets, or over character bigrams for short texts.
 * An internal ranking heuristic, never shown to users as a probability.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const wa = words(a);
  const wb = words(b);
  if (Math.min(wa.length, wb.length) >= SHORT_WORDS) return (2 * overlap(wa, wb)) / (wa.length + wb.length);
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (!ba.length || !bb.length) return a.trim().toLowerCase() === b.trim().toLowerCase() && a.trim() ? 1 : 0;
  return (2 * overlap(ba, bb)) / (ba.length + bb.length);
}

/** Share of the words of `part` that also occur in `whole` (multiset), in [0, 1]. */
export function containment(part: string, whole: string): number {
  const wp = words(part);
  if (!wp.length) return 0;
  return overlap(wp, words(whole)) / wp.length;
}

/** Number of (possibly overlapping) occurrences of needle in haystack and their code point offsets. */
export function occurrences(haystack: string, needle: string, limit = 1000): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let from = 0;
  while (out.length < limit) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    out.push(at);
    from = at + 1;
  }
  // Convert UTF-16 indices to code point offsets.
  if (!out.length) return out;
  const result: number[] = [];
  let cp = 0;
  let unit = 0;
  let k = 0;
  for (const char of haystack) {
    while (k < out.length && out[k] === unit) {
      result.push(cp);
      k += 1;
    }
    if (k >= out.length) break;
    unit += char.length;
    cp += 1;
  }
  while (k < out.length && out[k] === unit) {
    result.push(cp);
    k += 1;
  }
  return result;
}
