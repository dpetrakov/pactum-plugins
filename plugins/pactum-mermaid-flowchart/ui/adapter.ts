import { tr } from "../core/i18n.ts";
// The pure part of the Mermaid flowchart visualizer (no DOM, no React): match by header, semantic diff in the
// contract's words, the list for screen readers. Tested in Node; the canvas is ui/mermaid-canvas.tsx.
import { diagramDiff } from "../core/diff.ts";
import { LAYOUT_ENGINE_VERSION } from "../core/engine.ts";
import { parseMermaid, type FlowModel } from "../core/mermaid.ts";
import type { A11yItem, ObjectDiff } from "../visualizers-contract.ts";

export const BUILTIN_MERMAID = "pactum-mermaid-flowchart";
export const HEADER = /^\s*(?:%%.*\n\s*)*(flowchart|graph)\b/;
const KIND: Record<string, string> = { label: tr("label", "подпись"), shape: tr("shape", "форма"), group: tr("group", "группа"), line: tr("line", "линия"), ends: tr("ends", "концы"), title: tr("title", "название"), parent: tr("parent", "вложенность"), direction: tr("direction", "направление") };

const model = (source: string): FlowModel | null => { const parsed = parseMermaid(source); return parsed.ok ? parsed.model : null; };

export function mermaidDiff(base: string, source: string): ObjectDiff | { unsupported: string } {
  const before = model(base);
  const after = model(source);
  if (!before || !after) return { unsupported: !before ? tr("The previous version cannot be rendered as a flowchart", "прежняя версия не строится как flowchart") : tr("The diagram cannot be rendered as a flowchart", "схема не строится как flowchart") };
  const diff = diagramDiff(before, after);
  const name = (m: FlowModel, id: string) => m.nodes.find((node) => node.id === id)?.label ?? m.groups.find((group) => group.id === id)?.title ?? id;
  const edgeLabel = (m: FlowModel, id: string) => { const edge = m.edges.find((e) => e.id === id); return edge ? `${name(m, edge.from)} → ${name(m, edge.to)}${edge.label ? ` («${edge.label}»)` : ""}` : id; };
  const items: ObjectDiff["items"] = [];
  if (diff.direction) items.push({ id: "#direction", kind: "other", label: tr(`direction ${diff.direction.before} → ${diff.direction.after}`, `направление ${diff.direction.before} → ${diff.direction.after}`), change: "changed", fields: [tr("direction", "направление")] });
  for (const id of diff.groups.added) items.push({ id, kind: "group", label: name(after, id), change: "added" });
  for (const entry of diff.groups.changed) items.push({ id: entry.id, kind: "group", label: name(after, entry.id), change: "changed", fields: entry.fields.map((f) => KIND[f] ?? f), before: entry.fields.includes("title") ? entry.before.title : undefined });
  for (const group of diff.groups.removed) items.push({ id: group.id, kind: "group", label: group.title, change: "removed" });
  for (const id of diff.nodes.added) items.push({ id, kind: "node", label: name(after, id), change: "added" });
  for (const entry of diff.nodes.changed) items.push({ id: entry.id, kind: "node", label: name(after, entry.id), change: "changed", fields: entry.fields.map((f) => KIND[f] ?? f), before: entry.fields.includes("label") ? entry.before.label : undefined });
  for (const node of diff.nodes.removed) items.push({ id: node.id, kind: "node", label: node.label, change: "removed" });
  for (const id of diff.edges.added) items.push({ id, kind: "edge", label: edgeLabel(after, id), change: "added" });
  for (const entry of diff.edges.changed) items.push({ id: entry.id, kind: "edge", label: edgeLabel(after, entry.id), change: "changed", fields: entry.fields.map((f) => KIND[f] ?? f) });
  for (const edge of diff.edges.removed) items.push({ id: edge.id, kind: "edge", label: edgeLabel(before, edge.id), change: "removed" });
  return { items, total: diff.total };
}

export function mermaidA11y(source: string): A11yItem[] {
  const m = model(source);
  if (!m) return [];
  const group = new Map(m.groups.map((g) => [g.id, g.title]));
  const label = new Map(m.nodes.map((node) => [node.id, node.label]));
  return [
    ...m.groups.map((g): A11yItem => ({ id: g.id, kind: "group", label: g.title })),
    ...m.nodes.map((node): A11yItem => ({ id: node.id, kind: "node", label: node.label, detail: node.group ? tr(`group ${group.get(node.group)}`, `группа «${group.get(node.group)}»`) : undefined })),
    ...m.edges.map((edge): A11yItem => ({ id: edge.id, kind: "edge", label: `${label.get(edge.from) ?? group.get(edge.from) ?? edge.from} → ${label.get(edge.to) ?? group.get(edge.to) ?? edge.to}`, detail: edge.label || undefined })),
  ];
}

