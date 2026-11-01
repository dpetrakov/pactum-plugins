// Semantic diff of two Mermaid flowchart models (W-06f, EP-061-T03): what was added, removed or changed in the graph
// between the reader's base and the shown revision. Pure and deterministic. Identity is the Mermaid id of a node or a
// group and the explicit id of an edge; edges without one are matched by their ends only when the pair has a single
// edge on both sides — parallel edges are matched by their full look, never by order, so a reorder is not a change and
// an unclear pair is reported as removed + added, never as a guessed «changed». Positions are not part of the model:
// the reader's layout is personal and never a semantic change.
import type { FlowModel, GraphEdge, GraphGroup, GraphNode } from "./mermaid.ts";

export type NodeField = "label" | "shape" | "group";
export type EdgeField = "label" | "line" | "ends";
export type GroupField = "title" | "parent" | "direction";
export type DiagramDiff = {
  direction: { before: FlowModel["direction"]; after: FlowModel["direction"] } | null;
  nodes: { added: string[]; removed: GraphNode[]; changed: { id: string; fields: NodeField[]; before: GraphNode }[] };
  edges: { added: string[]; removed: GraphEdge[]; changed: { id: string; fields: EdgeField[]; before: GraphEdge }[] };
  groups: { added: string[]; removed: GraphGroup[]; changed: { id: string; fields: GroupField[]; before: GraphGroup }[] };
  /** Number of all differences; 0 — the graphs are the same (the source may differ in formatting only). */
  total: number;
};

const look = (edge: GraphEdge) => JSON.stringify([edge.from, edge.to, edge.label, edge.line, edge.head, edge.tail]);
const pairOf = (edge: GraphEdge) => `${edge.from}\n${edge.to}`;

function nodeFields(a: GraphNode, b: GraphNode): NodeField[] {
  const out: NodeField[] = [];
  if (a.label !== b.label) out.push("label");
  if (a.shape !== b.shape) out.push("shape");
  if (a.group !== b.group) out.push("group");
  return out;
}

function edgeFields(a: GraphEdge, b: GraphEdge): EdgeField[] {
  const out: EdgeField[] = [];
  if (a.label !== b.label) out.push("label");
  if (a.line !== b.line) out.push("line");
  if (a.head !== b.head || a.tail !== b.tail) out.push("ends");
  return out;
}

function groupFields(a: GraphGroup, b: GraphGroup): GroupField[] {
  const out: GroupField[] = [];
  if (a.title !== b.title) out.push("title");
  if (a.parent !== b.parent) out.push("parent");
  if (a.direction !== b.direction) out.push("direction");
  return out;
}

function diffEdges(before: GraphEdge[], after: GraphEdge[]): DiagramDiff["edges"] {
  const out: DiagramDiff["edges"] = { added: [], removed: [], changed: [] };
  const left = new Set(before);
  const right = new Set(after);
  // 1. Explicit ids are identity.
  const explicitBefore = new Map(before.filter((edge) => edge.explicitId).map((edge) => [edge.id, edge]));
  for (const edge of after) {
    if (!edge.explicitId) continue;
    const old = explicitBefore.get(edge.id);
    if (!old) continue;
    left.delete(old); right.delete(edge);
    const fields = edgeFields(old, edge);
    if (old.from !== edge.from || old.to !== edge.to) { out.removed.push(old); out.added.push(edge.id); }
    else if (fields.length) out.changed.push({ id: edge.id, fields, before: old });
  }
  // 2. Same look (ends, label, line, heads) — the same edge, whatever its order among parallel ones.
  const byLook = new Map<string, GraphEdge[]>();
  for (const edge of left) if (!edge.explicitId) byLook.set(look(edge), [...(byLook.get(look(edge)) ?? []), edge]);
  for (const edge of [...right]) {
    if (edge.explicitId) continue;
    const same = byLook.get(look(edge));
    const old = same?.shift();
    if (old) { left.delete(old); right.delete(edge); }
  }
  // 3. A pair that has exactly one edge (without an explicit id) in both versions: changed in place. Parallel edges
  // are not matched here — which one changed would be a guess.
  const count = (edges: Iterable<GraphEdge>) => { const map = new Map<string, GraphEdge[]>(); for (const edge of edges) if (!edge.explicitId) map.set(pairOf(edge), [...(map.get(pairOf(edge)) ?? []), edge]); return map; };
  const leftAll = count(before);
  const rightAll = count(after);
  for (const [pair, edges] of rightAll) {
    const olds = leftAll.get(pair);
    if (edges.length !== 1 || olds?.length !== 1 || !right.has(edges[0]) || !left.has(olds[0])) continue;
    const [edge] = edges;
    const [old] = olds;
    left.delete(old); right.delete(edge);
    out.changed.push({ id: edge.id, fields: edgeFields(old, edge), before: old });
  }
  for (const edge of after) if (right.has(edge)) out.added.push(edge.id);
  for (const edge of before) if (left.has(edge)) out.removed.push(edge);
  return out;
}

export function diagramDiff(before: FlowModel, after: FlowModel): DiagramDiff {
  const oldNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const newNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const nodes: DiagramDiff["nodes"] = { added: [], removed: [], changed: [] };
  for (const node of after.nodes) {
    const old = oldNodes.get(node.id);
    if (!old) { nodes.added.push(node.id); continue; }
    const fields = nodeFields(old, node);
    if (fields.length) nodes.changed.push({ id: node.id, fields, before: old });
  }
  for (const node of before.nodes) if (!newNodes.has(node.id)) nodes.removed.push(node);
  const oldGroups = new Map(before.groups.map((group) => [group.id, group]));
  const newGroups = new Map(after.groups.map((group) => [group.id, group]));
  const groups: DiagramDiff["groups"] = { added: [], removed: [], changed: [] };
  for (const group of after.groups) {
    const old = oldGroups.get(group.id);
    if (!old) { groups.added.push(group.id); continue; }
    const fields = groupFields(old, group);
    if (fields.length) groups.changed.push({ id: group.id, fields, before: old });
  }
  for (const group of before.groups) if (!newGroups.has(group.id)) groups.removed.push(group);
  const edges = diffEdges(before.edges, after.edges);
  const direction = before.direction !== after.direction ? { before: before.direction, after: after.direction } : null;
  const total = (direction ? 1 : 0) + nodes.added.length + nodes.removed.length + nodes.changed.length
    + edges.added.length + edges.removed.length + edges.changed.length + groups.added.length + groups.removed.length + groups.changed.length;
  return { direction, nodes, edges, groups, total };
}
