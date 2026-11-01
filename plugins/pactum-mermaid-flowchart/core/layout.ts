// Layout and edge routing of a flowchart model (W-06f, EP-058-T02, EP-060-T04). Three separate functions, as the
// concept requires: the first automatic layout (dagre, layered, compound groups), the reader's pins (fixed centres
// that the automatic layout never moves), and the edge router (orthogonal routes around node bodies, recomputed for
// any set of positions). Coordinates are integers in diagram units, independent of zoom, theme and column width.
import dagre from "@dagrejs/dagre";
import type { FlowModel, GraphEdge, NodeShape } from "./mermaid.ts";

import { LAYOUT_ENGINE_VERSION } from "./engine.ts";
export { LAYOUT_ENGINE_VERSION };

export type Point = { x: number; y: number };
/** Centre and size. */
export type Box = { x: number; y: number; w: number; h: number };
export type Size = { w: number; h: number };
export type Measure = (label: string, shape: NodeShape) => Size;
/** The reader's pins: node id → centre. Unknown ids are ignored (a node removed from the source). */
export type Pins = Record<string, Point>;
export type Route = { id: string; points: Point[]; label: Point | null; fallback: boolean };
export type GroupBox = Box & { title: number };
export type Layout = {
  /** Drawing bounds: the SVG viewBox is (origin.x, origin.y, width, height); coordinates themselves are never shifted. */
  engine: string; origin: Point; width: number; height: number;
  nodes: Record<string, Box>; groups: Record<string, GroupBox>; edges: Route[];
  /** Pinned ids that are known nodes; overlaps — pairs of pinned nodes whose bodies overlap (shown, not fixed). */
  pinned: string[]; overlaps: [string, string][];
};

/** Room around a label inside a node card (D39: 18 px each side, 11 px above and below — a one-line card is 40 px high). */
export const NODE_PAD = { x: 18, y: 11 };
const GROUP_PAD = 14;
const GROUP_TITLE = 24;
const MARGIN = 10;
const STUB = 14;
const BEND = 24;

/** Approximate measure for tests and the server; the browser passes canvas measurements with the bb font. */
export const approxMeasure: Measure = (label, shape) => {
  const lines = label.split("\n");
  const longest = Math.max(1, ...lines.map((line) => [...line].length));
  // ≈ the width of a character of 500 13px Inter, the weight of node labels (the browser measures it exactly).
  let w = Math.ceil(longest * 7.8) + NODE_PAD.x * 2;
  let h = lines.length * 18 + NODE_PAD.y * 2;
  return shapeSize({ w, h }, shape);
};

/** Extra room the outline of a shape needs around its text box. */
export function shapeSize(text: Size, shape: NodeShape): Size {
  let { w, h } = text;
  switch (shape) {
    case "diamond": w = Math.ceil(w * 1.45); h = Math.ceil(h * 1.6); break;
    // A circle fits its label line without the card's side padding (D39): 12 px less than the card is wide.
    case "circle": case "double-circle": { const d = Math.ceil(Math.max(w - 12, h)) + (shape === "double-circle" ? 8 : 0); w = d; h = d; break; }
    case "hexagon": w += 24; break;
    case "parallelogram": case "parallelogram-alt": case "trapezoid": case "trapezoid-alt": w += 24; break;
    case "cylinder": h += 14; break;
    case "stadium": w += 12; break;
    case "subroutine": w += 16; break;
    case "asymmetric": w += 14; break;
  }
  return { w: Math.max(w, 40), h: Math.max(h, 34) };
}

const round = (value: number) => Math.round(value);

/** The automatic part, cached by the caller per (model, measure): node sizes and dagre positions. */
export type AutoLayout = { sizes: Map<string, Size>; positions: Map<string, Point> };
export function autoPositions(model: FlowModel, measure: Measure = approxMeasure): AutoLayout {
  const sizes = new Map(model.nodes.map((node) => [node.id, measure(node.label, node.shape)]));
  return { sizes, positions: autoLayout(model, sizes) };
}

/** First automatic layout, then pins; unpinned nodes overlapping a pinned one are pushed aside. */
export function layoutGraph(model: FlowModel, measure: Measure = approxMeasure, pins: Pins = {}): Layout {
  return layoutWith(model, autoPositions(model, measure), pins);
}

/** Pins and routes over a cached automatic layout — fast enough to run on every pointer move. */
export function layoutWith(model: FlowModel, auto: AutoLayout, pins: Pins = {}): Layout {
  const { sizes } = auto;
  const nodes: Record<string, Box> = {};
  const pinned: string[] = [];
  for (const node of model.nodes) {
    const size = sizes.get(node.id)!;
    const pin = pins[node.id];
    const at = pin && Number.isFinite(pin.x) && Number.isFinite(pin.y) ? pin : auto.positions.get(node.id)!;
    if (pin) pinned.push(node.id);
    nodes[node.id] = { x: round(at.x), y: round(at.y), w: size.w, h: size.h };
  }
  if (pinned.length) separate(model, nodes, new Set(pinned));
  const groups = groupBoxes(model, nodes);
  const edges = routeEdges(model, nodes, groups);
  const xs: number[] = [], ys: number[] = [];
  for (const b of [...Object.values(nodes), ...Object.values(groups)]) { xs.push(b.x - b.w / 2, b.x + b.w / 2); ys.push(b.y - b.h / 2, b.y + b.h / 2); }
  for (const r of edges) for (const p of r.points) { xs.push(p.x); ys.push(p.y); }
  // Edge labels are pills centred on their point (diagram.tsx): the drawing must hold them too, or a label of an edge
  // routed around the graph is cut by the canvas (the reported clipping case). Estimated a little wider than drawn.
  const labelOf = new Map(model.edges.map((edge) => [edge.id, edge.label]));
  for (const r of edges) {
    const text = labelOf.get(r.id);
    if (!r.label || !text) continue;
    const half = Math.max(...text.split("\n").map((line) => [...line].length)) * 3.8 + 12;
    xs.push(r.label.x - half, r.label.x + half); ys.push(r.label.y - 12, r.label.y + 12);
  }
  const origin = { x: round((xs.length ? Math.min(...xs) : 0) - MARGIN), y: round((ys.length ? Math.min(...ys) : 0) - MARGIN) };
  const width = round((xs.length ? Math.max(...xs) : 0) + MARGIN - origin.x);
  const height = round((ys.length ? Math.max(...ys) : 0) + MARGIN - origin.y);
  const overlaps: [string, string][] = [];
  for (let i = 0; i < pinned.length; i++) for (let j = i + 1; j < pinned.length; j++) if (intersects(nodes[pinned[i]], nodes[pinned[j]], 0)) overlaps.push([pinned[i], pinned[j]]);
  return { engine: LAYOUT_ENGINE_VERSION, origin, width, height, nodes, groups, edges, pinned, overlaps };
}

function autoLayout(model: FlowModel, sizes: Map<string, Size>): Map<string, Point> {
  const g = new dagre.graphlib.Graph({ compound: true });
  g.setGraph({ rankdir: model.direction, nodesep: 40, ranksep: 56, edgesep: 18, marginx: MARGIN, marginy: MARGIN });
  g.setDefaultEdgeLabel(() => ({}));
  const groupIds = new Set(model.groups.map((group) => group.id));
  for (const group of model.groups) g.setNode(group.id, { paddingTop: GROUP_TITLE, paddingLeft: GROUP_PAD, paddingRight: GROUP_PAD, paddingBottom: GROUP_PAD });
  for (const group of model.groups) if (group.parent) g.setParent(group.id, group.parent);
  for (const node of model.nodes) {
    const size = sizes.get(node.id)!;
    g.setNode(node.id, { width: size.w, height: size.h });
    if (node.group) g.setParent(node.id, node.group);
  }
  // Only node positions are taken from dagre (routes are ours): one edge per ordered pair, the longest minlen and the
  // widest label. Parallel edges given to dagre separately broke its intersection step on large graphs.
  const pairs = new Map<string, { from: string; to: string; minlen: number; width: number; height: number }>();
  for (const edge of model.edges) {
    // dagre cannot lay out edges to a cluster: an edge to a group joins its first member for ranking only.
    const from = groupIds.has(edge.from) ? firstMember(model, edge.from) : edge.from;
    const to = groupIds.has(edge.to) ? firstMember(model, edge.to) : edge.to;
    if (!from || !to || from === to) continue;
    const key = `${from}\u0000${to}`;
    const width = edge.label ? Math.min(240, [...edge.label].length * 7 + 20) : 0;
    const current = pairs.get(key);
    pairs.set(key, { from, to, minlen: Math.max(current?.minlen ?? 1, Math.min(edge.length, 3)), width: Math.max(current?.width ?? 0, width), height: width || current?.height ? 20 : 0 });
  }
  for (const pair of pairs.values()) g.setEdge(pair.from, pair.to, { minlen: pair.minlen, width: pair.width, height: pair.height });
  try { dagre.layout(g); }
  catch {
    // A dagre failure must not break the document: a plain grid in source order, still routed and draggable.
    const out = new Map<string, Point>();
    const columns = Math.max(1, Math.ceil(Math.sqrt(model.nodes.length)));
    model.nodes.forEach((node, i) => out.set(node.id, { x: MARGIN + 110 + (i % columns) * 220, y: MARGIN + 40 + Math.floor(i / columns) * 110 }));
    return out;
  }
  const out = new Map<string, Point>();
  for (const node of model.nodes) { const n = g.node(node.id); out.set(node.id, { x: n.x, y: n.y }); }
  return out;
}

function firstMember(model: FlowModel, group: string): string | null {
  const direct = model.nodes.find((node) => node.group === group);
  if (direct) return direct.id;
  for (const child of model.groups.filter((g) => g.parent === group)) { const found = firstMember(model, child.id); if (found) return found; }
  return null;
}

function intersects(a: Box, b: Box, gap: number): boolean {
  return Math.abs(a.x - b.x) * 2 < a.w + b.w + gap * 2 && Math.abs(a.y - b.y) * 2 < a.h + b.h + gap * 2;
}

/** Push unpinned nodes off pinned ones (and off each other after moving), along the cheaper axis. */
function separate(model: FlowModel, nodes: Record<string, Box>, pinned: Set<string>) {
  const ids = model.nodes.map((node) => node.id);
  for (let pass = 0; pass < 24; pass++) {
    let moved = false;
    for (const id of ids) {
      if (pinned.has(id)) continue;
      const box = nodes[id];
      for (const other of ids) {
        if (other === id || !intersects(box, nodes[other], 8)) continue;
        if (!pinned.has(other) && ids.indexOf(other) > ids.indexOf(id)) continue;
        const o = nodes[other];
        const dx = (box.w + o.w) / 2 + 8 - Math.abs(box.x - o.x);
        const dy = (box.h + o.h) / 2 + 8 - Math.abs(box.y - o.y);
        if (dx < dy) box.x += (box.x >= o.x ? 1 : -1) * Math.ceil(dx);
        else box.y += (box.y >= o.y ? 1 : -1) * Math.ceil(dy);
        moved = true;
      }
    }
    if (!moved) break;
  }
}

/** Group boxes enclose their members and nested groups (membership never changes; a group grows with its nodes). */
function groupBoxes(model: FlowModel, nodes: Record<string, Box>): Record<string, GroupBox> {
  const out: Record<string, GroupBox> = {};
  const depth = (id: string): number => { const g = model.groups.find((x) => x.id === id); return g?.parent ? depth(g.parent) + 1 : 0; };
  const order = [...model.groups].sort((a, b) => depth(b.id) - depth(a.id));
  for (const group of order) {
    const members: Box[] = [
      ...model.nodes.filter((node) => node.group === group.id).map((node) => nodes[node.id]),
      ...model.groups.filter((child) => child.parent === group.id).map((child) => out[child.id]).filter(Boolean),
    ];
    if (!members.length) { out[group.id] = { x: 0, y: 0, w: 120, h: GROUP_TITLE + 30, title: GROUP_TITLE }; continue; }
    const left = Math.min(...members.map((b) => b.x - b.w / 2)) - GROUP_PAD;
    const right = Math.max(...members.map((b) => b.x + b.w / 2)) + GROUP_PAD;
    const top = Math.min(...members.map((b) => b.y - b.h / 2)) - GROUP_PAD - GROUP_TITLE;
    const bottom = Math.max(...members.map((b) => b.y + b.h / 2)) + GROUP_PAD;
    out[group.id] = { x: round((left + right) / 2), y: round((top + bottom) / 2), w: round(right - left), h: round(bottom - top), title: GROUP_TITLE };
  }
  return out;
}

// ── Routing ──

type Side = "left" | "right" | "top" | "bottom";
const sideOf = (from: Box, to: Box): Side => {
  const dx = to.x - from.x, dy = to.y - from.y;
  // Prefer the axis of larger separation measured in body sizes, so stacked nodes connect top/bottom.
  const sx = Math.abs(dx) / ((from.w + to.w) / 2 || 1), sy = Math.abs(dy) / ((from.h + to.h) / 2 || 1);
  return sx >= sy ? (dx >= 0 ? "right" : "left") : (dy >= 0 ? "bottom" : "top");
};
const opposite: Record<Side, Side> = { left: "right", right: "left", top: "bottom", bottom: "top" };
const portAt = (box: Box, side: Side, offset: number): Point => side === "left" ? { x: box.x - box.w / 2, y: box.y + offset } : side === "right" ? { x: box.x + box.w / 2, y: box.y + offset }
  : side === "top" ? { x: box.x + offset, y: box.y - box.h / 2 } : { x: box.x + offset, y: box.y + box.h / 2 };
const stubOf = (p: Point, side: Side): Point => side === "left" ? { x: p.x - STUB, y: p.y } : side === "right" ? { x: p.x + STUB, y: p.y } : side === "top" ? { x: p.x, y: p.y - STUB } : { x: p.x, y: p.y + STUB };

/** Routes for every visible edge; endpoints may be nodes or groups. */
export function routeEdges(model: FlowModel, nodes: Record<string, Box>, groups: Record<string, GroupBox>): Route[] {
  const boxOf = (id: string): Box | undefined => nodes[id] ?? groups[id];
  const obstacles = Object.entries(nodes).map(([id, box]) => ({ id, box: inflate(box, MARGIN) }));
  // Spread several edges on one side of a node: offsets by the position of the other end.
  const plans = model.edges.filter((edge) => edge.line !== "invisible").map((edge) => {
    const a = boxOf(edge.from), b = boxOf(edge.to);
    if (!a || !b) return null;
    if (edge.from === edge.to) return { edge, a, b, sa: "right" as Side, sb: "top" as Side };
    const sa = sideOf(a, b);
    return { edge, a, b, sa, sb: opposite[sa] };
  }).filter((plan): plan is NonNullable<typeof plan> => plan !== null);
  const slots = new Map<string, { plan: (typeof plans)[number]; end: "a" | "b"; key: number }[]>();
  for (const plan of plans) {
    if (plan.edge.from === plan.edge.to) continue;
    for (const end of ["a", "b"] as const) {
      const id = end === "a" ? plan.edge.from : plan.edge.to;
      const side = end === "a" ? plan.sa : plan.sb;
      const other = end === "a" ? plan.b : plan.a;
      const key = side === "left" || side === "right" ? other.y : other.x;
      const list = slots.get(`${id}:${side}`) ?? [];
      list.push({ plan, end, key });
      slots.set(`${id}:${side}`, list);
    }
  }
  const offsets = new Map<string, number>();
  for (const [slot, list] of slots) {
    const [id, side] = slot.split(":") as [string, Side];
    const box = boxOf(id)!;
    const span = (side === "left" || side === "right" ? box.h : box.w) - 12;
    list.sort((p, q) => p.key - q.key || p.plan.edge.id.localeCompare(q.plan.edge.id));
    list.forEach((item, i) => offsets.set(`${item.plan.edge.id}:${item.end}`, list.length === 1 ? 0 : round(-span / 2 + span * (i + 0.5) / list.length)));
  }
  return plans.map(({ edge, a, b, sa, sb }) => {
    if (edge.from === edge.to) return selfLoop(edge, a);
    const p0 = portAt(a, sa, offsets.get(`${edge.id}:a`) ?? 0);
    const p1 = portAt(b, sb, offsets.get(`${edge.id}:b`) ?? 0);
    const s0 = stubOf(p0, sa), s1 = stubOf(p1, sb);
    const blockers = obstacles.filter((o) => o.id !== edge.from && o.id !== edge.to).map((o) => o.box);
    const middle = route(s0, s1, blockers);
    const points = simplify(middle ? [p0, ...middle, p1] : [p0, s0, s1, p1]);
    return { id: edge.id, points: points.map((p) => ({ x: round(p.x), y: round(p.y) })), label: edge.label ? labelPoint(points) : null, fallback: !middle };
  });
}

function selfLoop(edge: GraphEdge, box: Box): Route {
  const r = { x: box.x + box.w / 2, y: box.y - box.h / 4 };
  const t = { x: box.x + box.w / 4, y: box.y - box.h / 2 };
  const out = 22;
  const points = [r, { x: r.x + out, y: r.y }, { x: r.x + out, y: t.y - out }, { x: t.x, y: t.y - out }, t].map((p) => ({ x: round(p.x), y: round(p.y) }));
  return { id: edge.id, points, label: edge.label ? { x: round(r.x + out + 4), y: round(t.y - out) } : null, fallback: false };
}

const inflate = (b: Box, m: number): Box => ({ x: b.x, y: b.y, w: b.w + m * 2, h: b.h + m * 2 });

/** Does the axis-parallel segment p→q cross the interior of the box? */
function crosses(p: Point, q: Point, b: Box): boolean {
  const l = b.x - b.w / 2, r = b.x + b.w / 2, t = b.y - b.h / 2, btm = b.y + b.h / 2;
  if (p.y === q.y) { const y = p.y; if (y <= t || y >= btm) return false; const lo = Math.min(p.x, q.x), hi = Math.max(p.x, q.x); return hi > l && lo < r; }
  if (p.x === q.x) { const x = p.x; if (x <= l || x >= r) return false; const lo = Math.min(p.y, q.y), hi = Math.max(p.y, q.y); return hi > t && lo < btm; }
  return true;
}
const free = (path: Point[], obstacles: Box[]) => path.every((p, i) => i === 0 || obstacles.every((o) => !crosses(path[i - 1], p, o)));

/** Orthogonal route between two stub points: simple shapes first, then A* on the sparse grid of obstacle lines. */
function route(s: Point, e: Point, obstacles: Box[]): Point[] | null {
  const candidates: Point[][] = [
    [s, { x: e.x, y: s.y }, e], [s, { x: s.x, y: e.y }, e],
    [s, { x: (s.x + e.x) / 2, y: s.y }, { x: (s.x + e.x) / 2, y: e.y }, e],
    [s, { x: s.x, y: (s.y + e.y) / 2 }, { x: e.x, y: (s.y + e.y) / 2 }, e],
  ];
  if (s.x === e.x || s.y === e.y) candidates.unshift([s, e]);
  for (const path of candidates) if (free(path, obstacles)) return path;
  return astar(s, e, obstacles);
}

function astar(s: Point, e: Point, obstacles: Box[]): Point[] | null {
  const xs = new Set<number>([s.x, e.x]), ys = new Set<number>([s.y, e.y]);
  for (const o of obstacles) { xs.add(o.x - o.w / 2 - 1); xs.add(o.x + o.w / 2 + 1); ys.add(o.y - o.h / 2 - 1); ys.add(o.y + o.h / 2 + 1); }
  const X = [...xs].sort((a, b) => a - b), Y = [...ys].sort((a, b) => a - b);
  if (X.length * Y.length > 250_000) return null;
  const inside = (x: number, y: number) => obstacles.some((o) => Math.abs(x - o.x) * 2 < o.w && Math.abs(y - o.y) * 2 < o.h);
  const key = (i: number, j: number) => i * Y.length + j;
  const si = X.indexOf(s.x), sj = Y.indexOf(s.y), ei = X.indexOf(e.x), ej = Y.indexOf(e.y);
  // State: grid point + direction of arrival (0 none, 1 horizontal, 2 vertical) — bends cost extra.
  const best = new Map<number, number>();
  const prev = new Map<number, number>();
  const heap: [number, number, number, number, number][] = []; // f, g, i, j, dir
  const push = (item: [number, number, number, number, number]) => { heap.push(item); let n = heap.length - 1; while (n > 0) { const p = (n - 1) >> 1; if (heap[p][0] <= heap[n][0]) break; [heap[p], heap[n]] = [heap[n], heap[p]]; n = p; } };
  const pop = () => { const top = heap[0]; const last = heap.pop()!; if (heap.length) { heap[0] = last; let n = 0; for (;;) { const l = 2 * n + 1, r = l + 1; let m = n; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === n) break; [heap[m], heap[n]] = [heap[n], heap[m]]; n = m; } } return top; };
  const h = (i: number, j: number) => Math.abs(X[i] - e.x) + Math.abs(Y[j] - e.y);
  const state = (i: number, j: number, d: number) => key(i, j) * 3 + d;
  push([h(si, sj), 0, si, sj, 0]);
  best.set(state(si, sj, 0), 0);
  let expanded = 0;
  while (heap.length) {
    const [, g, i, j, d] = pop();
    if (g > (best.get(state(i, j, d)) ?? Infinity)) continue;
    if (i === ei && j === ej) {
      const out: Point[] = [];
      for (let st: number | undefined = state(i, j, d); st !== undefined; st = prev.get(st)) { const k = Math.floor(st / 3); out.push({ x: X[Math.floor(k / Y.length)], y: Y[k % Y.length] }); }
      return out.reverse();
    }
    if (++expanded > 60_000) return null;
    for (const [di, dj, nd] of [[1, 0, 1], [-1, 0, 1], [0, 1, 2], [0, -1, 2]] as const) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= X.length || nj >= Y.length) continue;
      if (inside(X[ni], Y[nj]) && !(ni === ei && nj === ej)) continue;
      const a = { x: X[i], y: Y[j] }, b = { x: X[ni], y: Y[nj] };
      if (obstacles.some((o) => crosses(a, b, o))) continue;
      const cost = g + Math.abs(b.x - a.x) + Math.abs(b.y - a.y) + (d && d !== nd ? BEND : 0);
      const st = state(ni, nj, nd);
      if (cost < (best.get(st) ?? Infinity)) { best.set(st, cost); prev.set(st, state(i, j, d)); push([cost + h(ni, nj), cost, ni, nj, nd]); }
    }
  }
  return null;
}

/** Drop repeated and collinear points. */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    if (out.length && out.at(-1)!.x === p.x && out.at(-1)!.y === p.y) continue;
    if (out.length >= 2) {
      const a = out.at(-2)!, b = out.at(-1)!;
      if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) out.pop();
    }
    out.push(p);
  }
  return out;
}

/** Label at the middle of the longest segment. */
function labelPoint(points: Point[]): Point {
  let best = 0, at = { x: points[0].x, y: points[0].y };
  for (let i = 1; i < points.length; i++) {
    const len = Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
    if (len > best) { best = len; at = { x: round((points[i].x + points[i - 1].x) / 2), y: round((points[i].y + points[i - 1].y) / 2) }; }
  }
  return at;
}

/** Check used by tests and the spike: does any route pass through a node body other than its own ends? */
export function routeCollisions(model: FlowModel, layout: Layout): string[] {
  const hits: string[] = [];
  for (const routeOf of layout.edges) {
    const edge = model.edges.find((e) => e.id === routeOf.id)!;
    for (const [id, box] of Object.entries(layout.nodes)) {
      if (id === edge.from || id === edge.to) continue;
      for (let i = 1; i < routeOf.points.length; i++) if (crosses(routeOf.points[i - 1], routeOf.points[i], box)) { hits.push(`${routeOf.id}×${id}`); break; }
    }
  }
  return hits;
}
