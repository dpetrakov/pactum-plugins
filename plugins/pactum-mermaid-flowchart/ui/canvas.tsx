// The canvas of the Mermaid flowchart visualizer `pactum-mermaid-flowchart` (W-06f, EP-074): what a visualizer does with a
// slot of the contract — its own React root in the host's element, the model from the source, the automatic layout
// with the reader's positions, drag/keyboard gestures ending in one `commit`, marks of file changes with ghosts of the
// removed, and `report` with the geometry of every element.
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { layoutWith, type Pins, type Point } from "../core/layout.ts";
import { parseMermaid, type FlowModel } from "../core/mermaid.ts";
import type { CanvasHandle, CanvasReport, CanvasSlot, ElementInfo } from "../visualizers-contract.ts";
import { comparisonGhosts, type Ghosts } from "../core/ghosts.ts";
import type { DiagramViewport } from "./drag-viewport.ts";
import { cachedAuto, Diagram, type Marks } from "./diagram.tsx";

function MermaidCanvas({ slot }: { slot: CanvasSlot }) {
  const { props, actions } = slot;
  const parsed = useMemo(() => parseMermaid(props.source), [props.source]);
  const model = parsed.ok ? parsed.model : null;
  useEffect(() => { if (!parsed.ok) actions.fail(parsed); }, [parsed, actions]);
  const auto = useMemo(() => (model ? cachedAuto(model, props.source) : null), [model, props.source]);
  const [viewport, setViewport] = useState<DiagramViewport | null>(null);
  const [draft, setDraft] = useState<Pins | null>(null);
  useEffect(() => { setDraft(null); }, [props.source]);
  const pins = useMemo(() => ({ ...props.positions, ...draft }), [props.positions, draft]);
  const layout = useMemo(() => (model && auto ? layoutWith(model, auto, pins) : null), [model, auto, pins]);
  // Marks of file changes by id (never the reader's moves) and ghosts of the removed where they stood in the base.
  const marks = useMemo((): Marks | null => {
    if (!props.compare || !model) return null;
    const of = (kind: "node" | "edge" | "group") => new Map(Object.entries(props.compare!.marks).filter(([id, mark]) => mark !== "removed"
      && (kind === "node" ? model.nodes.some((n) => n.id === id) : kind === "edge" ? model.edges.some((e) => e.id === id) : model.groups.some((g) => g.id === id))).map(([id, mark]) => [id, mark as "added" | "changed"]));
    return { nodes: of("node"), edges: of("edge"), groups: of("group") };
  }, [props.compare, model]);
  const ghosts = useMemo((): Ghosts | null => {
    const base = props.compare?.base;
    if (!base || !props.compare) return null;
    const removed = new Set(Object.entries(props.compare.marks).filter(([, mark]) => mark === "removed").map(([id]) => id));
    if (!removed.size) return null;
    const parsedBase = parseMermaid(base);
    if (!parsedBase.ok) return null;
    const baseLayout = layoutWith(parsedBase.model, cachedAuto(parsedBase.model, base), {});
    return layout ? comparisonGhosts(parsedBase.model, baseLayout, layout, removed) : null;
  }, [props.compare, layout]);
  // Geometry for the host: annotation markers, focus and the hint words are drawn there.
  useEffect(() => {
    if (!model || !layout) return;
    // Geometry in canvas px at zoom 1 (the contract): the SVG draws its viewBox from layout.origin, so shift by it.
    const frame = viewport ?? layout;
    const ox = frame.origin.x, oy = frame.origin.y;
    const elements: Record<string, ElementInfo> = {};
    for (const node of model.nodes) { const b = layout.nodes[node.id]; if (b) elements[node.id] = { x: b.x - b.w / 2 - ox, y: b.y - b.h / 2 - oy, w: b.w, h: b.h, kind: "node", label: node.label, range: node.ranges[0] }; }
    for (const group of model.groups) { const g = layout.groups[group.id]; if (g) elements[group.id] = { x: g.x - g.w / 2 - ox, y: g.y - g.h / 2 - oy, w: g.w, h: g.h, kind: "group", label: group.title, range: group.range }; }
    for (const route of layout.edges) {
      const edge = model.edges.find((e) => e.id === route.id);
      if (!edge || !route.points.length) continue;
      const xs = route.points.map((p) => p.x), ys = route.points.map((p) => p.y);
      const x = Math.min(...xs) - ox, y = Math.min(...ys) - oy;
      elements[edge.id] = { x, y, w: Math.max(1, Math.max(...xs) - ox - x), h: Math.max(1, Math.max(...ys) - oy - y), kind: "edge", label: edge.label || `${edge.from} → ${edge.to}`, range: edge.range };
    }
    const report: CanvasReport = { size: { w: frame.width, h: frame.height }, elements, pinned: layout.pinned, overlaps: layout.overlaps, fallbacks: layout.edges.filter((r) => r.fallback).map((r) => r.id), warnings: model.warnings };
    actions.report(report);
  }, [model, layout, viewport, actions]);
  const draftRef = useRef<Pins | null>(null);
  draftRef.current = draft;
  const onDrag = (ids: string[], delta: Point, origin: Pins) => setDraft((current) => ({ ...current, ...Object.fromEntries(ids.map((id) => [id, { x: origin[id].x + delta.x, y: origin[id].y + delta.y }])) }));
  const onDrop = (ids: string[]) => {
    const current = draftRef.current;
    if (!current) return;
    const done = Object.fromEntries(ids.filter((id) => current[id]).map((id) => [id, current[id]]));
    if (Object.keys(done).length) actions.commit(done);
    const rest = { ...current };
    for (const id of ids) delete rest[id];
    setDraft(Object.keys(rest).length ? rest : null);
  };
  const onCancel = (origin: Pins) => setDraft((current) => { if (!current) return current; const rest = { ...current }; for (const id of Object.keys(origin)) delete rest[id]; return Object.keys(rest).length ? rest : null; });
  if (!model || !layout) return null;
  return <Diagram model={model} layout={layout} moving={props.moving && !props.readOnly} uid={`dg${slot.blockKey}`} selected={props.selected} onSelect={actions.select}
    zoom={props.zoom} onDrag={onDrag} onDrop={onDrop} onCancel={onCancel} marks={marks} ghosts={ghosts} reducedMotion={props.reducedMotion} onViewport={setViewport} />;
}

/** `mount` of the built-in visualizer: a React root of its own in the host's element. */
export function mountMermaidCanvas(slot: CanvasSlot): CanvasHandle {
  const root: Root = createRoot(slot.element);
  const draw = (current: CanvasSlot) => root.render(<MermaidCanvas slot={current} />);
  draw(slot);
  return { update: draw, dispose: () => root.unmount() };
}
