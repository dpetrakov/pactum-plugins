// All document navigation, including headings, search and Markdown fragment links, accounts for sticky layers;
// a deep link to an annotation, a card in «Comments», J/K, «Mark read and next», «Accept and next», the next document
// of a «All documents» pass, «Review» of a round — goes through revealBlock, which shows the target inside the safe
// zone of the scroll container: below the sticky header (and sticky bars) and above the pass footer. A target already
// fully visible in that zone is not scrolled. The zone is measured at the moment of the jump; the same heights are kept
// in --dr-header-h / --dr-footer-h for scroll-padding, so the browser's own focus scrolling respects them too.

export interface Edge { top: number; bottom: number }
export type How = "start" | "center" | "nearest";

/** Breathing room between the sticky layer and the target (design-system.md: + 12 px). */
export const PAD = 12;

/**
 * Scroll delta (px, positive = scroll down) that brings `target` into the safe zone of `container`, or null when the
 * target is already fully visible there. Pure: rectangles in the same (viewport) coordinates.
 */
export function revealDelta(container: Edge, target: Edge, chrome: { header: number; footer: number }, how: How, pad = PAD): number | null {
  const zoneTop = container.top + chrome.header + pad;
  const zoneBottom = container.bottom - chrome.footer - pad;
  const height = target.bottom - target.top;
  const fits = height <= zoneBottom - zoneTop;
  if (target.top >= zoneTop - 0.5 && target.bottom <= zoneBottom + 0.5) return null;
  if (how === "start" || !fits) return target.top - zoneTop;
  if (how === "center") return (target.top + target.bottom) / 2 - (zoneTop + zoneBottom) / 2;
  return target.top < zoneTop ? target.top - zoneTop : target.bottom - zoneBottom;
}

/** Heights of the sticky layers inside a scroll container: the header (and sticky bars under it) and the footer. */
export function chromeOf(container: HTMLElement): { header: number; footer: number; outer: number } {
  const box = container.getBoundingClientRect();
  let header = 0;
  for (const element of container.querySelectorAll<HTMLElement>("[data-dr-sticky=top]")) {
    const rect = element.getBoundingClientRect();
    if (rect.height && rect.bottom > box.top) header = Math.max(header, rect.bottom - box.top);
  }
  // An inner sticky bar (the key tree's path and filter, W-06c) sticks under the header once scrolled to it: the safe
  // zone always leaves room for it (a jump may scroll it into its stuck place), and the header height it sticks to
  // (`outer`) never includes it.
  const outer = header;
  for (const element of container.querySelectorAll<HTMLElement>("[data-dr-sticky=inner]")) header = Math.max(header, outer + element.getBoundingClientRect().height);
  let footer = 0;
  for (const element of container.querySelectorAll<HTMLElement>("[data-dr-sticky=bottom]")) {
    const rect = element.getBoundingClientRect();
    if (rect.height && rect.top < box.bottom) footer = Math.max(footer, box.bottom - rect.top);
  }
  return { header, footer, outer };
}

const reducedMotion = () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

/**
 * Show `target` inside the safe zone of its scroll container and mark the arrival (600 ms rail and wash; without
 * animation under prefers-reduced-motion). Instant: J/K is repeated hundreds of times a day. Returns whether it scrolled.
 */
let jumpListener: (() => void) | null = null;
/** The page learns about every jump: a jump replaces a pinned reading position (W-06a). */
export function onJump(listener: (() => void) | null): void {
  jumpListener = listener;
}

export function revealBlock(target: Element | null | undefined, how: How = "start", options: { arrive?: boolean } = {}): boolean {
  if (!target) return false;
  jumpListener?.();
  const container = target.closest<HTMLElement>("[data-dr-scroll]");
  if (!container) {
    target.scrollIntoView({ block: how === "center" ? "center" : how === "nearest" ? "nearest" : "start" });
    return true;
  }
  const box = container.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  const delta = revealDelta({ top: box.top, bottom: box.bottom }, { top: rect.top, bottom: rect.bottom }, chromeOf(container), how);
  if (delta !== null) container.scrollTo({ top: container.scrollTop + delta, behavior: "auto" });
  if (options.arrive !== false) arrive(target.closest("[data-block]") ?? target);
  void reducedMotion;
  return delta !== null;
}

/** On arrival, show the rail and fade the target wash after 600 ms; respect reduced motion. */
export function arrive(element: Element): void {
  // The last target stays marked (data-arrived) until the next jump: tests and the evidence script measure it.
  for (const previous of document.querySelectorAll("[data-arrived]")) previous.removeAttribute("data-arrived");
  element.setAttribute("data-arrived", "");
  element.classList.remove("dr-blk--arrive");
  // Restart the animation when arriving twice in a row.
  void (element as HTMLElement).offsetWidth;
  element.classList.add("dr-blk--arrive");
  setTimeout(() => element.classList.remove("dr-blk--arrive"), 650);
}

/** Keep focus out from under the sticky layers (WCAG 2.4.11): a focused element below/above them is brought in. */
const preservedFocus = new WeakSet<Element>();
/** Return focus after an overlay without turning that return into reading navigation. */
export function focusWithoutScroll(element: HTMLElement): void {
  preservedFocus.add(element);
  try { element.focus({ preventScroll: true }); }
  finally { preservedFocus.delete(element); }
}

export function keepFocusVisible(container: HTMLElement, element: Element): void {
  if (preservedFocus.has(element)) return;
  const box = container.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  const delta = revealDelta({ top: box.top, bottom: box.bottom }, { top: rect.top, bottom: rect.bottom }, chromeOf(container), "nearest", 4);
  if (delta !== null) container.scrollTo({ top: container.scrollTop + delta, behavior: "auto" });
}

// ── targets not mounted yet (EP-027-T08): a large document mounts its blocks progressively ──────────────────────
let mountHook: ((index: number | null) => void) | null = null;
/** The page registers how to mount a block index (null: everything) before a jump to it. */
export function onMountRequest(hook: ((index: number | null) => void) | null): void {
  mountHook = hook;
}
/** Ask the page to mount block `index` (a reading position restored in a very large document). */
export function requestMount(index: number): void {
  mountHook?.(index);
}

/**
 * Jump to block `index` of the open document: at once when it is mounted, otherwise after the page mounted it (a few
 * frames). Every jump by block index goes through here, so a large document still being mounted never loses a jump.
 */
export function revealIndex(index: number, how: How = "center", options: { arrive?: boolean } = {}): void {
  const find = () => document.querySelector(`[data-docs-page] [data-block="${index}"]`);
  if (revealBlock(find(), how, options) || find()) return;
  mountHook?.(index);
  let tries = 0;
  const step = () => {
    const element = find();
    if (element) revealBlock(element, how, options);
    else if (tries++ < 60) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Jump to a heading slug, mounting the remainder of a large document if necessary. */
export function revealHeading(slug: string, root: ParentNode = document): void {
  const find = () => root.querySelector(`[data-docs-page] #${CSS.escape(slug)}`) ?? root.querySelector(`#${CSS.escape(slug)}`);
  const found = find();
  if (found) { revealBlock(found.closest("[data-block]") ?? found, "start"); return; }
  mountHook?.(null);
  let tries = 0;
  const step = () => {
    const element = find();
    if (element) revealBlock(element.closest("[data-block]") ?? element, "start");
    else if (tries++ < 60) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
