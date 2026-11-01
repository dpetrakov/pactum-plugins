import { tr } from "../core/i18n.ts";
// The canvas of a Mermaid flowchart (W-06f, EP-059-T04, EP-060-T05; EP-073-T04): the diagram drawn from the parsed
// model (never from the source as markup). Where the layout is stored, nodes and groups can always be moved by pointer,
// touch or keyboard (EP-081: no separate layout mode mode) — a press becomes a drag only past a small threshold, so a
// click or a tap selects; only nodes and group titles take touches, the empty canvas leaves page scroll to the document. The frame around it (bar, states, comparison, reader's list) is the host's (`document-review/ui/object.tsx`).
import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { FlowModel, GraphEdge, GraphNode, NodeShape } from "../core/mermaid.ts";
import { autoPositions, LAYOUT_ENGINE_VERSION, NODE_PAD, shapeSize, type Box, type GroupBox, type Layout, type Measure, type Pins, type Point } from "../core/layout.ts";

import { startPointerDrag, restoreScreenAnchor, type PointerDrag, type DiagramViewport, type ScreenAnchor } from "./drag-viewport.ts";
import type { Ghosts } from "../core/ghosts.ts";
export type { Ghosts } from "../core/ghosts.ts";

const STEP = 8, BIG_STEP = 40;
const family = () => getComputedStyle(document.body).fontFamily || "sans-serif";
/** Node labels: 500 13px (canvas.css `.dr-dg__text`); edge labels: 500 12px (`.dr-dg__elabel text`). */
const font = () => `500 13px ${family()}`;
const smallFont = () => `500 12px ${family()}`;
let canvas: CanvasRenderingContext2D | null = null;
const widths = new Map<string, number>();
function textWidth(line: string, f: string, perChar: number): number {
  canvas ??= document.createElement("canvas").getContext("2d");
  const key = `${f}\0${line}`;
  let width = widths.get(key);
  if (width === undefined) { if (canvas) { canvas.font = f; width = canvas.measureText(line).width; } else width = [...line].length * perChar; widths.set(key, width); }
  return width;
}
/** Text size with the bb font (canvas), cached per label line. */
export const browserMeasure: Measure = (label, shape) => {
  const f = font();
  const lines = label.split("\n");
  const w = Math.max(0, ...lines.map((line) => textWidth(line, f, 7.8)));
  return shapeSize({ w: Math.ceil(w) + NODE_PAD.x * 2, h: lines.length * 18 + NODE_PAD.y * 2 }, shape);
};

// The automatic layout is the heavy part (dagre): computed only for a block near the screen and cached by engine, font
// and source — switching documents and back, or a second identical diagram, does not lay it out again (EP-059-T03).
const autoCache = new Map<string, ReturnType<typeof autoPositions>>();
const AUTO_CACHE = 32;
export function cachedAuto(model: FlowModel, source: string): ReturnType<typeof autoPositions> {
  const key = `${LAYOUT_ENGINE_VERSION}\n${font()}\n${source}`;
  let auto = autoCache.get(key);
  if (auto) { autoCache.delete(key); autoCache.set(key, auto); return auto; }
  auto = autoPositions(model, browserMeasure);
  autoCache.set(key, auto);
  if (autoCache.size > AUTO_CACHE) autoCache.delete(autoCache.keys().next().value!);
  return auto;
}

/** Visual family of a shape (D39): the outline says the kind, the soft tone of the card repeats it. */
type Family = "process" | "terminal" | "decision" | "data";
const familyOf = (shape: NodeShape): Family => shape === "stadium" || shape === "circle" || shape === "double-circle" ? "terminal"
  : shape === "diamond" || shape === "hexagon" ? "decision" : shape === "cylinder" ? "data" : "process";
/** Half-height of the cylinder's lid (shapeSize gives the cylinder 14 px more height for it). */
const LID = 7;

/** The outline of a shape: the card itself or, inflated, the selection/focus ring around it. */
function outline(shape: NodeShape, box: Box, className: string) {
  const { x, y, w, h } = box;
  const l = x - w / 2, r = x + w / 2, t = y - h / 2, b = y + h / 2;
  const poly = (pts: [number, number][]) => <polygon className={className} points={pts.map((p) => p.join(",")).join(" ")} />;
  switch (shape) {
    case "round": return <rect className={className} x={l} y={t} width={w} height={h} rx={Math.min(12, h / 2)} />;
    case "stadium": return <rect className={className} x={l} y={t} width={w} height={h} rx={h / 2} />;
    case "subroutine": return <rect className={className} x={l} y={t} width={w} height={h} rx={4} />;
    case "cylinder": return <path className={className} d={`M${l},${t + LID} A${w / 2},${LID} 0 0,1 ${r},${t + LID} V${b - LID} A${w / 2},${LID} 0 0,1 ${l},${b - LID} Z`} />;
    case "circle": case "double-circle": return <circle className={className} cx={x} cy={y} r={w / 2} />;
    case "diamond": return poly([[x, t], [r, y], [x, b], [l, y]]);
    case "hexagon": return poly([[l + 12, t], [r - 12, t], [r, y], [r - 12, b], [l + 12, b], [l, y]]);
    case "parallelogram": return poly([[l + 12, t], [r, t], [r - 12, b], [l, b]]);
    case "parallelogram-alt": return poly([[l, t], [r - 12, t], [r, b], [l + 12, b]]);
    case "trapezoid": return poly([[l + 12, t], [r - 12, t], [r, b], [l, b]]);
    case "trapezoid-alt": return poly([[l, t], [r, t], [r - 12, b], [l + 12, b]]);
    case "asymmetric": return poly([[l, t], [r, t], [r, b], [l, b], [l + 12, y]]);
    default: return <rect className={className} x={l} y={t} width={w} height={h} rx={5} />;
  }
}

function NodeShapeSvg({ shape, box }: { shape: NodeShape; box: Box }) {
  const { x, y, w, h } = box;
  const l = x - w / 2, r = x + w / 2, t = y - h / 2, b = y + h / 2;
  return <>
    {outline(shape, box, "dr-dg__shape")}
    {shape === "subroutine" && <><line className="dr-dg__line" x1={l + 8} y1={t} x2={l + 8} y2={b} /><line className="dr-dg__line" x1={r - 8} y1={t} x2={r - 8} y2={b} /></>}
    {shape === "cylinder" && <ellipse className="dr-dg__lid" cx={x} cy={t + LID} rx={w / 2} ry={LID} />}
    {shape === "double-circle" && <circle className="dr-dg__line" cx={x} cy={y} r={w / 2 - 4} />}
  </>;
}

/** The ring of a selected or focused node: the same outline 4 px outside (a diamond's edges need more to clear 4 px). */
function Halo({ shape, box }: { shape: NodeShape; box: Box }) {
  const pad = shape === "diamond" ? 7 : 4;
  return outline(shape, { x: box.x, y: box.y, w: box.w + pad * 2, h: box.h + pad * 2 }, "dr-dg__halo");
}

function Label({ text, x, y }: { text: string; x: number; y: number }) {
  const lines = text.split("\n");
  return <text className="dr-dg__text" x={x} y={y - (lines.length - 1) * 9} textAnchor="middle" dominantBaseline="central">
    {lines.map((line, i) => <tspan key={i} x={x} dy={i ? 18 : 0}>{line}</tspan>)}
  </text>;
}

/** Orthogonal polyline with rounded corners (radius up to 10, never more than half of a segment). */
function pathOf(points: Point[]): string {
  if (points.length < 2) return "";
  const n = (v: number) => Math.round(v * 10) / 10;
  let d = `M${n(points[0].x)},${n(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i - 1], c = points[i], q = points[i + 1];
    const r = Math.min(10, Math.hypot(c.x - p.x, c.y - p.y) / 2, Math.hypot(q.x - c.x, q.y - c.y) / 2);
    const a = { x: c.x - Math.sign(c.x - p.x) * r, y: c.y - Math.sign(c.y - p.y) * r };
    const b = { x: c.x + Math.sign(q.x - c.x) * r, y: c.y + Math.sign(q.y - c.y) * r };
    d += ` L${n(a.x)},${n(a.y)} Q${n(c.x)},${n(c.y)} ${n(b.x)},${n(b.y)}`;
  }
  const last = points[points.length - 1];
  return `${d} L${n(last.x)},${n(last.y)}`;
}

// Edge ends are drawn as shapes of the edge itself (not <marker>s): they take the edge's colour in every state —
// file-change marks, the highlighted links of a node — from the same CSS rules as the line.
type End = { at: Point; dir: Point };
type EndKind = GraphEdge["head"];
/** The end point of a route and the unit direction of arrival there. */
function endOf(points: Point[], last: boolean): End | null {
  if (points.length < 2) return null;
  const at = last ? points[points.length - 1] : points[0], from = last ? points[points.length - 2] : points[1];
  const len = Math.hypot(at.x - from.x, at.y - from.y);
  return len ? { at, dir: { x: (at.x - from.x) / len, y: (at.y - from.y) / len } } : null;
}
const tipScale = (thick: boolean) => (thick ? 1.3 : 1);
/** How far the line stops short of the end so it does not poke through the tip. */
const insetOf = (kind: EndKind, thick: boolean) => (kind === "arrow" ? 6.5 : kind === "circle" ? 7 : 0) * tipScale(thick);
function trim(points: Point[], last: boolean, by: number): Point[] {
  if (!by || points.length < 2) return points;
  const out = points.slice();
  const i = last ? out.length - 1 : 0, j = last ? out.length - 2 : 1;
  const len = Math.hypot(out[i].x - out[j].x, out[i].y - out[j].y);
  const k = Math.min(by, Math.max(0, len - 1)) / (len || 1);
  out[i] = { x: out[i].x + (out[j].x - out[i].x) * k, y: out[i].y + (out[j].y - out[i].y) * k };
  return out;
}
function Tip({ kind, end, thick }: { kind: EndKind; end: End; thick: boolean }) {
  const s = tipScale(thick), { at, dir } = end, nx = -dir.y, ny = dir.x;
  const n = (v: number) => Math.round(v * 10) / 10;
  if (kind === "arrow") {
    // A slim arrow with a notched back: 9 long, 8 wide (×1.3 on thick lines).
    const len = 9 * s, half = 4 * s, back = { x: at.x - dir.x * len, y: at.y - dir.y * len }, notch = { x: at.x - dir.x * len * 0.72, y: at.y - dir.y * len * 0.72 };
    return <path className="dr-dg__tip" d={`M${n(at.x)},${n(at.y)} L${n(back.x + nx * half)},${n(back.y + ny * half)} L${n(notch.x)},${n(notch.y)} L${n(back.x - nx * half)},${n(back.y - ny * half)} Z`} />;
  }
  if (kind === "circle") { const r = 3.5 * s; return <circle className="dr-dg__tip" cx={n(at.x - dir.x * r)} cy={n(at.y - dir.y * r)} r={r} />; }
  if (kind === "cross") {
    const c = { x: at.x - dir.x * 5 * s, y: at.y - dir.y * 5 * s }, a = 3.5 * s;
    return <path className="dr-dg__tip dr-dg__tip--cross" d={`M${n(c.x - a)},${n(c.y - a)} L${n(c.x + a)},${n(c.y + a)} M${n(c.x + a)},${n(c.y - a)} L${n(c.x - a)},${n(c.y + a)}`} />;
  }
  return null;
}

/** A node at an end of an edge: routes end on the node's box; curved and slanted outlines are reached by extending the last segment. */
type Body = { shape: NodeShape; box: Box };
/** How deep inside the box the outline is at the port `p` for a segment arriving along `dir`. */
function depthOf({ shape, box }: Body, p: Point, dir: Point): number {
  const vertical = Math.abs(dir.y) > Math.abs(dir.x);
  const along = vertical ? Math.abs(p.x - box.x) : Math.abs(p.y - box.y);
  const half = vertical ? box.w / 2 : box.h / 2, across = vertical ? box.h / 2 : box.w / 2;
  const k = Math.min(1, along / (half || 1));
  switch (shape) {
    case "diamond": return across * k;
    case "circle": case "double-circle": { const r = box.w / 2; return r - Math.sqrt(Math.max(0, r * r - along * along)); }
    case "cylinder": return vertical ? LID * (1 - Math.sqrt(Math.max(0, 1 - k * k))) : 0;
    case "hexagon": return vertical ? 0 : 12 * k;
    case "asymmetric": return vertical || dir.x < 0 ? 0 : 12 * (1 - k);
  }
  // Slanted sides of parallelograms and trapezoids: 12 px of slant over the height, by side and by height of the port.
  if (vertical) return 0;
  const down = (p.y - box.y) / (box.h || 1) + 0.5, up = 1 - down;
  const left = dir.x > 0;
  switch (shape) {
    case "parallelogram": return 12 * (left ? up : down);
    case "parallelogram-alt": return 12 * (left ? down : up);
    case "trapezoid": return 12 * up;
    case "trapezoid-alt": return 12 * down;
    default: return 0;
  }
}
function reach(points: Point[], last: boolean, body: Body | undefined): Point[] {
  const end = body && endOf(points, last);
  if (!end) return points;
  const depth = depthOf(body, end.at, end.dir);
  if (depth < 0.5) return points;
  const out = points.slice();
  out[last ? out.length - 1 : 0] = { x: end.at.x + end.dir.x * depth, y: end.at.y + end.dir.y * depth };
  return out;
}

function Edge({ edge, points: route, label, fallback, mark, hl, from, to }: { edge: GraphEdge; points: Point[]; label: Point | null; fallback: boolean; mark?: Mark; hl: boolean; from?: Body; to?: Body }) {
  const cls = `dr-dg__edge dr-dg__edge--${edge.line}${fallback ? " dr-dg__edge--fallback" : ""}`;
  const thick = edge.line === "thick";
  const points = reach(reach(route, true, to), false, from);
  const head = edge.head !== "none" ? endOf(points, true) : null;
  const tail = edge.tail !== "none" ? endOf(points, false) : null;
  let line = points;
  if (head) line = trim(line, true, insetOf(edge.head, thick));
  if (tail) line = trim(line, false, insetOf(edge.tail, thick));
  // Edge label as a pill: measured with the bb font, 8 px each side, 20 high.
  const pill = label && edge.label ? Math.ceil(textWidth(edge.label, smallFont(), 7)) + 16 : 0;
  return <g className="dr-dg__link" data-diff={mark} data-hl={hl || undefined}>
    <path className={cls} d={pathOf(line)} />
    {head && <Tip kind={edge.head} end={head} thick={thick} />}
    {tail && <Tip kind={edge.tail} end={tail} thick={thick} />}
    {label && edge.label && <g className="dr-dg__elabel">
      <rect x={label.x - pill / 2} y={label.y - 10} width={pill} height={20} rx={10} />
      <text x={label.x} y={label.y} textAnchor="middle" dominantBaseline="central">{edge.label}</text>
    </g>}
  </g>;
}

export type Mark = "added" | "changed" | undefined;
/** What changed in the file since the base, by id (EP-061; never the reader's moves): the shape of the mark is in the drawing, not only its colour. */
export type Marks = { nodes: Map<string, Mark>; edges: Map<string, Mark>; groups: Map<string, Mark> };
/** Removed elements drawn where they stood in the base (D37: a dashed ghost, not focusable, not movable). */


/** «+» added, «~» changed: a small badge on the node's corner (the word is in the summary and the reader's list). */
function Badge({ mark, x, y }: { mark: Mark | "removed"; x: number; y: number }) {
  if (!mark) return null;
  return <g className="dr-dg__badge" aria-hidden="true"><circle cx={x} cy={y} r={8} /><text x={x} y={y} textAnchor="middle" dominantBaseline="central">{mark === "added" ? "+" : mark === "removed" ? "−" : "~"}</text></g>;
}

const membersOf = (model: FlowModel, group: string): string[] => [
  ...model.nodes.filter((node) => node.group === group).map((node) => node.id),
  ...model.groups.filter((g) => g.parent === group).flatMap((g) => membersOf(model, g.id)),
];

/** The diagram itself: SVG from the layout; in layout mode nodes/groups are draggable and focusable. */
export const Diagram = memo(function Diagram({ model, layout, moving, onDrag, onDrop, onCancel, uid, selected, onSelect, zoom, marks, ghosts = null, reducedMotion = false, onViewport }: {
  model: FlowModel; layout: Layout; moving: boolean; uid: string; selected: string | null; zoom: number; marks: Marks | null; ghosts?: Ghosts | null; reducedMotion?: boolean;
  onViewport?(frame: DiagramViewport | null): void;
  onSelect(id: string | null): void; onDrag(ids: string[], delta: Point, origin: Pins): void; onDrop(ids: string[]): void; onCancel(origin: Pins): void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<PointerDrag | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [viewport, setViewport] = useState<DiagramViewport | null>(null);
  const anchor = useRef<ScreenAnchor | null>(null);
  const callbacks = useRef({ onDrag, onDrop, onCancel, onViewport });
  callbacks.current = { onDrag, onDrop, onCancel, onViewport };
  const updateViewport = (frame: DiagramViewport | null) => { setViewport(frame); callbacks.current.onViewport?.(frame); };
  useLayoutEffect(() => {
    if (drag.current) { drag.current.align(); return; }
    if (viewport) {
      const x = Math.min(viewport.origin.x, layout.origin.x), y = Math.min(viewport.origin.y, layout.origin.y);
      const width = Math.max(viewport.origin.x + viewport.width, layout.origin.x + layout.width) - x;
      const height = Math.max(viewport.origin.y + viewport.height, layout.origin.y + layout.height) - y;
      if (Math.abs(x - viewport.origin.x) > .01 || Math.abs(y - viewport.origin.y) > .01 || Math.abs(width - viewport.width) > .01 || Math.abs(height - viewport.height) > .01) {
        updateViewport({ origin: { x, y }, width, height }); return;
      }
    }
    if (anchor.current && svg.current) { restoreScreenAnchor(svg.current, anchor.current); anchor.current = null; }
  }, [viewport, layout]);
  const previousPinned = useRef(layout.pinned.length);
  useEffect(() => {
    if (!drag.current && previousPinned.current > 0 && !layout.pinned.length) updateViewport(null);
    previousPinned.current = layout.pinned.length;
  }, [layout.pinned.length]);
  useLayoutEffect(() => {
    updateViewport(null); anchor.current = null;
    return () => { drag.current?.dispose(); drag.current = null; anchor.current = null; };
  }, [model]);
  useEffect(() => { drag.current?.end(true); }, [zoom]);
  useEffect(() => {
    const cancel = () => drag.current?.end(true);
    const hidden = () => { if (document.hidden) cancel(); };
    window.addEventListener("blur", cancel); document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("blur", cancel); document.removeEventListener("visibilitychange", hidden); drag.current?.dispose(); };
  }, []);
  useEffect(() => {
    const element = svg.current;
    if (!moving || !element) return;
    // Native scrolling can still cancel pointer gestures on SVG descendants.
    // Consume touches only on node/group handles; blank canvas retains scrolling.
    const touch = (event: TouchEvent) => {
      if (event.touches.length > 1) { drag.current?.end(true); return; }
      if (event.target instanceof Element && event.target.closest(".dr-dg__node:not(.dr-dg__ghost),.dr-dg__gtitle")) event.preventDefault();
    };
    element.addEventListener("touchstart", touch, { passive: false });
    return () => element.removeEventListener("touchstart", touch);
  }, [moving]);
  useEffect(() => { if (!moving) drag.current?.end(true); }, [moving]);
  const originOf = (ids: string[]): Pins => Object.fromEntries(ids.map((id) => [id, { x: layout.nodes[id].x, y: layout.nodes[id].y }]));
  const start = (event: PointerEvent, kind: "node" | "group", id: string) => {
    if (event.button !== 0 || drag.current) return;
    if (!moving) { onSelect(id); return; }
    event.preventDefault(); event.stopPropagation();
    const ids = kind === "node" ? [id] : membersOf(model, id), origin = originOf(ids);
    const previousViewport = viewport;
    drag.current = startPointerDrag({ svg: svg.current!, layout: { ...layout, ...(viewport ?? {}) }, ids, origin, pointer: event.pointerId, event,
      viewport: updateViewport,
      drag(...args) { callbacks.current.onDrag(...args); },
      finish(commit, at) {
        drag.current = null; anchor.current = at;
        if (commit) callbacks.current.onDrop(ids); else { callbacks.current.onCancel(origin); updateViewport(previousViewport); }
      },
    });
    (event.currentTarget as SVGElement).focus({ preventScroll: true });
    (event.currentTarget as Element).setPointerCapture(event.pointerId); onSelect(id);
  };
  const move = (event: PointerEvent) => {
    if (drag.current?.pointer !== event.pointerId) return;
    event.preventDefault(); drag.current.move(event);
  };
  const end = (event: PointerEvent) => {
    if (drag.current?.pointer === event.pointerId) drag.current.end(event.type !== "pointerup");
  };
  // Keyboard: Enter starts moving the focused node, arrows move (Shift — larger step), Enter confirms, Esc cancels.
  const keyboard = useRef<{ id: string; ids: string[]; origin: Pins; delta: Point } | null>(null);
  const key = (event: KeyboardEvent, kind: "node" | "group", id: string) => {
    if (drag.current) {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); drag.current.end(true); }
      else if (["Enter", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) event.preventDefault();
      return;
    }
    if (!moving) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(id); } return; }
    const k = keyboard.current;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (k && k.id === id) { keyboard.current = null; if (k.delta.x || k.delta.y) onDrop(k.ids); }
      else { const ids = kind === "node" ? [id] : membersOf(model, id); keyboard.current = { id, ids, origin: originOf(ids), delta: { x: 0, y: 0 } }; onSelect(id); }
      return;
    }
    if (event.key === "Escape" && k) { event.preventDefault(); event.stopPropagation(); keyboard.current = null; onCancel(k.origin); return; }
    const step = event.shiftKey ? BIG_STEP : STEP;
    const dir = event.key === "ArrowLeft" ? { x: -step, y: 0 } : event.key === "ArrowRight" ? { x: step, y: 0 } : event.key === "ArrowUp" ? { x: 0, y: -step } : event.key === "ArrowDown" ? { x: 0, y: step } : null;
    if (!dir || !k || k.id !== id) return;
    event.preventDefault();
    k.delta = { x: k.delta.x + dir.x, y: k.delta.y + dir.y };
    onDrag(k.ids, k.delta, k.origin);
  };
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(model.edges.map((edge) => [edge.id, edge]));
  // The node under the pointer (mouse or pen; a touch never hovers): its links and neighbours stand out, the rest dims.
  // The selected node's links stand out too, without dimming the diagram (marks of changes stay readable).
  const shown = hover && nodeById.has(hover) ? hover : null;
  const focusNode = shown ?? (selected && nodeById.has(selected) ? selected : null);
  const neighbours = new Set<string>();
  if (shown) { neighbours.add(shown); for (const edge of model.edges) if (edge.from === shown || edge.to === shown) { neighbours.add(edge.from); neighbours.add(edge.to); } }
  const bodyOf = (id: string): Body | undefined => { const node = nodeById.get(id), box = layout.nodes[id]; return node && box ? { shape: node.shape, box } : undefined; };
  const enter = (event: PointerEvent, id: string) => { if (event.pointerType !== "touch") setHover(id); };
  const leave = (id: string) => setHover((current) => (current === id ? null : current));
  const box = viewport ?? layout;
  return <svg ref={svg} className="dr-dg" data-moving={moving || undefined} data-reduced-motion={reducedMotion || undefined} data-compare={marks ? "" : undefined} data-dim={shown ? "" : undefined}
    viewBox={`${box.origin.x} ${box.origin.y} ${box.width} ${box.height}`}
    width={Math.round(box.width * zoom)} height={Math.round(box.height * zoom)} role="img" aria-roledescription={tr("diagram", "схема")}
    aria-label={tr(`Diagram: ${model.nodes.length} nodes, ${model.edges.length} edges`, `Схема: ${model.nodes.length} узлов, ${model.edges.length} связей`)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
    {model.groups.map((group) => {
      const g: GroupBox = layout.groups[group.id];
      if (!g) return null;
      // A group is a recessed well with a title band (D39): the band is the handle that moves the whole group.
      const l = g.x - g.w / 2, t = g.y - g.h / 2, r = l + g.w, band = g.title, rr = 8;
      return <g key={group.id} className="dr-dg__group" data-selected={selected === group.id || undefined} data-diff={marks?.groups.get(group.id)}>
        <rect className="dr-dg__gbox" x={l} y={t} width={g.w} height={g.h} rx={rr} />
        <path className="dr-dg__band" d={`M${l},${t + band} V${t + rr} Q${l},${t} ${l + rr},${t} H${r - rr} Q${r},${t} ${r},${t + rr} V${t + band} Z`} aria-hidden="true" />
        <line className="dr-dg__bandline" x1={l} y1={t + band} x2={r} y2={t + band} aria-hidden="true" />
        <text className="dr-dg__gtitle" x={l + 10} y={t + band / 2} dominantBaseline="central" tabIndex={0} role="button"
          aria-label={moving ? tr(`Group ${group.title}: Enter to move, arrows to shift, Enter to finish, Escape to cancel`, `Группа «${group.title}»: Enter — двигать группу, стрелки — сдвиг, Enter — готово, Esc — отмена`) : tr(`Group ${group.title}: Enter to select, C to comment`, `Группа «${group.title}»: Enter — выбрать, C — замечание`)}
          onFocus={() => onSelect(group.id)} onPointerDown={(event) => start(event, "group", group.id)} onKeyDown={(event) => key(event, "group", group.id)}>{group.title}</text>
      </g>;
    })}
    {ghosts?.edges.map((ghost) => <path key={`ghost-${ghost.id}`} className="dr-dg__ghost dr-dg__ghost-edge" d={pathOf(ghost.points)} aria-hidden="true" />)}
    {ghosts?.nodes.map((ghost) => <g key={`ghost-${ghost.id}`} className="dr-dg__ghost dr-dg__node" data-diff="removed" data-family={familyOf(ghost.shape)} aria-hidden="true">
      <NodeShapeSvg shape={ghost.shape} box={ghost.box} /><Label text={ghost.label} x={ghost.box.x} y={ghost.box.y + (ghost.shape === "cylinder" ? LID / 2 : 0)} />
      <Badge mark="removed" x={ghost.box.x + ghost.box.w / 2 - 2} y={ghost.box.y - ghost.box.h / 2 + 2} />
    </g>)}
    {layout.edges.map((route) => {
      const edge = edgeById.get(route.id);
      return edge ? <Edge key={route.id} edge={edge} points={route.points} label={route.label} fallback={route.fallback} mark={marks?.edges.get(route.id)}
        hl={focusNode !== null && (edge.from === focusNode || edge.to === focusNode)} from={bodyOf(edge.from)} to={bodyOf(edge.to)} /> : null;
    })}
    {model.nodes.map((node: GraphNode) => {
      const b = layout.nodes[node.id];
      const shape = nodeById.get(node.id)!.shape;
      return <g key={node.id} className="dr-dg__node" data-node={node.id} data-family={familyOf(shape)} data-pinned={layout.pinned.includes(node.id) || undefined} data-diff={marks?.nodes.get(node.id)}
        data-selected={selected === node.id || undefined} data-hl={neighbours.has(node.id) || undefined} tabIndex={0} role="button"
        aria-label={moving ? tr(`Node ${node.label}: Enter to move, arrows to shift (Shift for larger steps), Enter to finish, Escape to cancel`, `Узел «${node.label}»: Enter — двигать, стрелки — сдвиг (Shift — крупнее), Enter — готово, Esc — отмена`) : tr(`Node ${node.label}: Enter to select, C to comment`, `Узел «${node.label}»: Enter — выбрать, C — замечание`)}
        onFocus={() => onSelect(node.id)} onPointerDown={(event) => start(event, "node", node.id)} onKeyDown={(event) => key(event, "node", node.id)}
        onPointerEnter={(event) => enter(event, node.id)} onPointerLeave={() => leave(node.id)}>
        <Halo shape={shape} box={b} />
        <NodeShapeSvg shape={shape} box={b} />
        <Label text={node.label} x={b.x} y={b.y + (shape === "cylinder" ? LID / 2 : 0)} />
        <Badge mark={marks?.nodes.get(node.id)} x={b.x + b.w / 2 - 2} y={b.y - b.h / 2 + 2} />
      </g>;
    })}
  </svg>;
});
