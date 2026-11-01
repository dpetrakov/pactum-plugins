// A gesture owns one stable coordinate basis. Only deliberate, delayed panning moves its viewport.
import { clampPointer, freshPanClock, panStep, touchPanRect, type Rect } from "../core/drag-motion.ts";
import type { Layout, Pins, Point } from "../core/layout.ts";
export type DiagramViewport = Pick<Layout, "origin" | "width" | "height">;
export type ScreenAnchor = { world: Point; screen: Point; scroller: HTMLElement | null };
type ClientPoint = { clientX: number; clientY: number };
const copy = (frame: DiagramViewport): DiagramViewport => ({ ...frame, origin: { ...frame.origin } });
function scrollParent(svg: SVGSVGElement): HTMLElement | null {
  for (let p = svg.parentElement; p; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (/(auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) return p;
  }
  return null;
}
function clientRect(element: HTMLElement): Rect {
  const r = element.getBoundingClientRect();
  return { left: r.left + element.clientLeft, top: r.top + element.clientTop, right: r.left + element.clientLeft + element.clientWidth, bottom: r.top + element.clientTop + element.clientHeight };
}
/** Clip to the actual scrollport, its clipping ancestors and the browser viewport, never the changing SVG extent. */
function visibleRect(svg: SVGSVGElement, scroller: HTMLElement | null): Rect {
  const visual = window.visualViewport;
  const out: Rect = { left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0,
    right: Math.min(window.innerWidth, document.documentElement.clientWidth, (visual?.offsetLeft ?? 0) + (visual?.width ?? window.innerWidth)),
    bottom: Math.min(window.innerHeight, (visual?.offsetTop ?? 0) + (visual?.height ?? window.innerHeight)) };
  for (let p = scroller ?? svg.parentElement; p; p = p.parentElement) {
    const style = getComputedStyle(p), r = clientRect(p);
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { out.left = Math.max(out.left, r.left); out.right = Math.min(out.right, r.right); }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { out.top = Math.max(out.top, r.top); out.bottom = Math.min(out.bottom, r.bottom); }
  }
  out.right = Math.max(out.left, out.right); out.bottom = Math.max(out.top, out.bottom);
  return out;
}
export function restoreScreenAnchor(svg: SVGSVGElement, anchor: ScreenAnchor) {
  const matrix = svg.getScreenCTM();
  if (!matrix || !anchor.scroller?.isConnected) return;
  const after = new DOMPoint(anchor.world.x, anchor.world.y).matrixTransform(matrix);
  // Restore the view before paint, letting native scroll bounds clamp tiny margins.
  anchor.scroller.scrollLeft += after.x - anchor.screen.x;
  anchor.scroller.scrollTop += after.y - anchor.screen.y;
}
export type PointerDrag = ReturnType<typeof startPointerDrag>;
export function startPointerDrag(input: {
  svg: SVGSVGElement; layout: Layout; ids: string[]; origin: Pins; pointer: number; event: ClientPoint & { pointerType?: string };
  viewport(frame: DiagramViewport | null): void;
  drag(ids: string[], delta: Point, origin: Pins): void;
  finish(commit: boolean, anchor: ScreenAnchor): void;
}) {
  const { svg, ids, origin } = input;
  const matrix = svg.getScreenCTM() ?? new DOMMatrix(), inverse = matrix.inverse();
  const vector = (x: number, y: number): Point => ({ x: inverse.a * x + inverse.c * y, y: inverse.b * x + inverse.d * y });
  const scroller = scrollParent(svg), initialRect = svg.getBoundingClientRect();
  let alignedRect = initialRect, needsAlignment = true;
  const frame = copy(input.layout);
  const scale = Math.hypot(matrix.a, matrix.b) || 1;
  if (scroller) {
    const style = getComputedStyle(svg.parentElement!);
    frame.width = Math.max(frame.width, (scroller.clientWidth - parseFloat(style.paddingLeft || "0") - parseFloat(style.paddingRight || "0")) / scale);
    frame.height = Math.max(frame.height, (scroller.clientHeight - parseFloat(style.paddingTop || "0") - parseFloat(style.paddingBottom || "0")) / scale);
  }
  const pan = { x: 0, y: 0 }, start = { x: input.event.clientX, y: input.event.clientY };
  let pointer = { ...start }, delta = { x: 0, y: 0 }, active = false, stopped = false, raf = 0;
  const clock = freshPanClock();
  const showFrame = () => input.viewport(copy(frame));
  const align = () => {
    if (!needsAlignment || stopped) return;
    needsAlignment = false;
    alignedRect = svg.getBoundingClientRect();
    const shift = vector(alignedRect.left - initialRect.left, alignedRect.top - initialRect.top);
    frame.origin.x += shift.x; frame.origin.y += shift.y;
    showFrame();
  };
  const tick = (now: number) => {
    if (stopped || !active) return;
    const rect = visibleRect(svg, scroller), target = clampPointer(pointer, rect);
    const step = panStep(clock, pointer, input.event.pointerType === "touch" ? touchPanRect(rect) : rect, now);
    const shift = vector(step.x, step.y);
    if (shift.x || shift.y) {
      pan.x += shift.x; pan.y += shift.y;
      frame.origin.x += shift.x; frame.origin.y += shift.y; showFrame();
    }
    const screen = svg.getBoundingClientRect();
    const direct = vector(target.x - start.x - (screen.left - alignedRect.left), target.y - start.y - (screen.top - alignedRect.top));
    const next = { x: Math.round(direct.x + pan.x), y: Math.round(direct.y + pan.y) };
    if (next.x !== delta.x || next.y !== delta.y) { delta = next; input.drag(ids, delta, origin); }
  };
  const loop = (now: number) => { tick(now); if (!stopped && active) raf = requestAnimationFrame(loop); };
  showFrame();
  return {
    pointer: input.pointer,
    align,
    move(event: ClientPoint) {
      if (stopped) return;
      pointer = { x: event.clientX, y: event.clientY };
      if (!active && Math.hypot(pointer.x - start.x, pointer.y - start.y) < 4) return;
      if (!active) { active = true; raf = requestAnimationFrame(loop); }
      tick(performance.now());
    },
    end(cancel: boolean) {
      if (stopped) return;
      stopped = true; cancelAnimationFrame(raf);
      const first = origin[ids[0]] ?? { x: 0, y: 0 };
      const world = { x: first.x + (cancel ? 0 : delta.x), y: first.y + (cancel ? 0 : delta.y) };
      const m = cancel ? matrix : svg.getScreenCTM() ?? matrix;
      const screen = new DOMPoint(world.x, world.y).matrixTransform(m);
      input.finish(active && !cancel, { world, screen: { x: screen.x, y: screen.y }, scroller });
    },
    dispose() { stopped = true; cancelAnimationFrame(raf); },
  };
}
