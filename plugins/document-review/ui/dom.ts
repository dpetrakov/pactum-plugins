// DOM ↔ block text. Each block renders `[data-block=i]` with one `[data-text]` element whose text nodes, minus
// anything inside `[data-skip]` (deleted words, list markers, labels), spell the block's projected text exactly.
import { cpToUtf16, utf16ToCp } from "./text.ts";

const skipped = (text: Node, root: Element) => {
  const skip = text.parentElement?.closest("[data-skip]");
  return Boolean(skip && root.contains(skip));
};

function textNodes(root: Element): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (skipped(node, root) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

/** Block index and UTF-16 offset in its rendered text for a DOM point, or null outside any block. */
export function pointOf(node: Node, offset: number, edge: "start" | "end"): { block: number; offset: number } | null {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const blockElement = element?.closest("[data-block]");
  if (!blockElement) return null;
  const block = Number(blockElement.getAttribute("data-block"));
  const textElement = blockElement.querySelector("[data-text]");
  if (!textElement || !Number.isInteger(block)) return null;
  // A point in a gutter or a skipped label clamps to the block's edge.
  if (!textElement.contains(node)) {
    const total = textNodes(textElement).reduce((sum, text) => sum + text.data.length, 0);
    const at = document.createRange();
    at.setStart(node, offset);
    // The text starts at or after the point: the point is before the text; otherwise it is after its end.
    void edge;
    return { block, offset: at.comparePoint(textElement, 0) >= 0 ? 0 : total };
  }
  const boundary = document.createRange();
  boundary.setStart(node, offset);
  let total = 0;
  for (const text of textNodes(textElement)) {
    if (text === node) return { block, offset: total + offset };
    if (boundary.comparePoint(text, text.data.length) <= 0) total += text.data.length;
    else break;
  }
  return { block, offset: total };
}

/** DOM range for a code point range inside one block (for highlights and the composer anchor). */
export function domRange(container: Element, block: number, text: string, range: { start: number; end: number }): Range | null {
  const blockElement = container.querySelector(`[data-block="${block}"]`);
  const textElement = blockElement?.querySelector("[data-text]");
  if (!textElement) return null;
  const from = cpToUtf16(text, range.start);
  const to = cpToUtf16(text, range.end);
  const nodes = textNodes(textElement);
  const result = document.createRange();
  let total = 0;
  let started = false;
  for (const node of nodes) {
    const length = node.data.length;
    if (!started && from <= total + length) {
      result.setStart(node, Math.max(0, from - total));
      started = true;
    }
    if (started && to <= total + length) {
      result.setEnd(node, Math.max(0, to - total));
      return result;
    }
    total += length;
  }
  if (!started) return null;
  const last = nodes[nodes.length - 1];
  result.setEnd(last, last.data.length);
  return result;
}

/** Code point inside the projection under a viewport point (click on a highlighted quote). */
export function cpAtPoint(x: number, y: number, blocks: { text: string; range: { start: number } }[]): number | null {
  const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretPositionFromPoint) {
    const position = doc.caretPositionFromPoint(x, y);
    if (position) {
      node = position.offsetNode;
      offset = position.offset;
    }
  } else if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  if (!node) return null;
  const point = pointOf(node, offset, "start");
  if (!point || !blocks[point.block]) return null;
  return blocks[point.block].range.start + utf16ToCp(blocks[point.block].text, point.offset);
}
