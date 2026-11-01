// Old geometry is useful only while its anchors and route still make sense in the current drawing.
import type { Box, Layout, Point } from "./layout.ts";
import type { FlowModel, NodeShape } from "./mermaid.ts";
export type Ghosts = { nodes: { id: string; label: string; shape: NodeShape; box: Box }[]; edges: { id: string; points: Point[] }[] };
const same = (a: Box | undefined, b: Box | undefined) => !!a && !!b && ["x", "y", "w", "h"].every(key => Math.abs(a[key as keyof Box] - b[key as keyof Box]) < 1);
const overlaps = (a: Box, b: Box) => Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h;
const inside = (p: Point, layout: Layout) => p.x >= layout.origin.x && p.y >= layout.origin.y && p.x <= layout.origin.x + layout.width && p.y <= layout.origin.y + layout.height;
function crosses(a: Point, b: Point, box: Box) {
  const l = box.x - box.w / 2, r = box.x + box.w / 2, t = box.y - box.h / 2, d = box.y + box.h / 2;
  return a.x === b.x ? a.x > l && a.x < r && Math.max(a.y, b.y) > t && Math.min(a.y, b.y) < d
    : a.y === b.y && a.y > t && a.y < d && Math.max(a.x, b.x) > l && Math.min(a.x, b.x) < r;
}
/** Unsafe or clipped ghosts stay in the host's complete change list, never as orphan line fragments. */
export function comparisonGhosts(base: FlowModel, before: Layout, current: Layout, removed: ReadonlySet<string>): Ghosts {
  const nodes = base.nodes.filter(node => {
    const box = before.nodes[node.id];
    return removed.has(node.id) && box && inside({ x: box.x - box.w / 2, y: box.y - box.h / 2 }, current)
      && inside({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, current)
      && !Object.values(current.nodes).some(other => overlaps(box, other));
  }).map(node => ({ id: node.id, label: node.label, shape: node.shape, box: before.nodes[node.id] }));
  const visibleRemoved = new Map(nodes.map(node => [node.id, node.box]));
  const oldBox = (id: string) => before.nodes[id] ?? before.groups[id];
  const newBox = (id: string) => current.nodes[id] ?? current.groups[id] ?? visibleRemoved.get(id);
  const byId = new Map(base.edges.map(edge => [edge.id, edge]));
  const edges = before.edges.filter(route => {
    const edge = byId.get(route.id);
    if (!edge || !removed.has(route.id) || !same(oldBox(edge.from), newBox(edge.from)) || !same(oldBox(edge.to), newBox(edge.to))) return false;
    return route.points.every(point => inside(point, current)) && !Object.entries(current.nodes).some(([id, box]) => id !== edge.from && id !== edge.to && route.points.some((point, i) => i > 0 && crosses(route.points[i - 1], point, box)));
  }).map(route => ({ id: route.id, points: route.points }));
  return { nodes, edges };
}
