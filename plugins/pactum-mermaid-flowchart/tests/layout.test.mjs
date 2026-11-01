// W-06f (EP-058-T02, EP-060-T04): automatic layout, the reader's pins and edge routing around node bodies.
import assert from "node:assert/strict";
import test from "node:test";
import { parseMermaid } from "../core/mermaid.ts";
import { layoutGraph, routeCollisions } from "../core/layout.ts";
import { MEMORY } from "./mermaid.test.mjs";

const parse = (source) => { const result = parseMermaid(source); assert.equal(result.ok, true, JSON.stringify(result)); return result.model; };
const overlapping = (layout) => {
  const boxes = Object.entries(layout.nodes);
  const hits = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const [a, A] = boxes[i], [b, B] = boxes[j];
    if (Math.abs(A.x - B.x) * 2 < A.w + B.w && Math.abs(A.y - B.y) * 2 < A.h + B.h) hits.push(`${a}/${b}`);
  }
  return hits;
};

test("the memory diagram lays out without overlaps; routes avoid node bodies; every visible edge is routed", () => {
  const model = parse(MEMORY);
  const layout = layoutGraph(model);
  assert.deepEqual(overlapping(layout), []);
  assert.equal(layout.edges.length, model.edges.length);
  assert.deepEqual(routeCollisions(model, layout), []);
  for (const route of layout.edges) assert.ok(route.points.length >= 2 && route.points.every((p) => Number.isInteger(p.x) && Number.isInteger(p.y)));
});

test("moving C and G: pinned nodes stay exactly where the reader put them, others keep their place, routes recomputed", () => {
  const model = parse(MEMORY);
  const before = layoutGraph(model);
  const pins = { C: { x: before.nodes.C.x + 40, y: before.nodes.C.y + 160 }, G: { x: before.nodes.G.x - 60, y: before.nodes.G.y + 120 } };
  const after = layoutGraph(model, undefined, pins);
  assert.deepEqual({ x: after.nodes.C.x, y: after.nodes.C.y }, pins.C);
  assert.deepEqual({ x: after.nodes.G.x, y: after.nodes.G.y }, pins.G);
  for (const id of ["A", "B", "D", "E", "F"]) {
    const moved = Math.abs(after.nodes[id].x - before.nodes[id].x) + Math.abs(after.nodes[id].y - before.nodes[id].y);
    if (moved) assert.ok(overlapping(before).length === 0, `${id} moved only to clear a pinned node`);
  }
  assert.deepEqual(overlapping(after), []);
  assert.deepEqual(routeCollisions(model, after), []);
  assert.deepEqual(after.pinned.sort(), ["C", "G"]);
  // Same input → same output (deterministic): pins do not drift between renders.
  assert.deepEqual(layoutGraph(model, undefined, pins), after);
});

test("cycles, self loops, parallel edges and subgraphs are routed; membership is kept when a member is dragged far", () => {
  const model = parse(`flowchart LR
  subgraph g1 [Группа]
    a --> b
    b --> a
  end
  a --> c
  a --> c
  a -->|третья| c
  c --> c
  c --> g1`);
  const layout = layoutGraph(model);
  assert.equal(layout.edges.length, 7);
  assert.deepEqual(routeCollisions(model, layout), []);
  const ac = layout.edges.filter((r) => r.id.startsWith("a->c#"));
  assert.equal(new Set(ac.map((r) => JSON.stringify(r.points))).size, 3, "parallel edges take different routes");
  assert.ok(layout.edges.find((r) => r.id === "c->c#0").points.length >= 4, "self loop drawn as a loop");
  const g = layout.groups.g1;
  const inside = (box) => Math.abs(box.x - g.x) * 2 <= g.w && Math.abs(box.y - g.y) * 2 <= g.h;
  assert.ok(inside(layout.nodes.a) && inside(layout.nodes.b));
  const far = layoutGraph(model, undefined, { a: { x: layout.nodes.a.x, y: layout.nodes.a.y + 400 } });
  const g2 = far.groups.g1;
  assert.ok(Math.abs(far.nodes.a.y - g2.y) * 2 <= g2.h, "the group grows to keep its member");
});

test("pinned nodes may overlap only if the reader put them so; it is reported", () => {
  const model = parse("flowchart LR\n  a --> b\n  b --> c");
  const base = layoutGraph(model);
  const pins = { a: { x: base.nodes.b.x, y: base.nodes.b.y }, b: { x: base.nodes.b.x, y: base.nodes.b.y } };
  const layout = layoutGraph(model, undefined, pins);
  assert.deepEqual(layout.overlaps, [["a", "b"]]);
});

test("budget: 200 nodes / 400 edges lay out and route within the first-render target", () => {
  const lines = ["flowchart TB"];
  for (let i = 0; i < 200; i++) lines.push(`n${i}[Узел ${i}]`);
  for (let i = 0; i < 400; i++) lines.push(`n${i % 200} --> n${(i * 7 + 13) % 200}`);
  const model = parse(lines.join("\n"));
  const started = performance.now();
  const layout = layoutGraph(model);
  const ms = performance.now() - started;
  console.log(`layout 200/400: ${Math.round(ms)} ms, fallback routes ${layout.edges.filter((r) => r.fallback).length}`);
  assert.equal(layout.edges.length, 400);
  assert.ok(ms < 8000, `took ${ms} ms`);
});

test("edge labels lie inside the drawing: a labelled edge routed around the graph is not cut by the canvas", () => {
  const model = parse("flowchart TB\n  Верх --> Низ\n  Низ --> Ещё[Ещё ниже, до самого дна]\n  Ещё --> Дно([Дно])\n  Верх -.->|напрямую| Дно");
  const layout = layoutGraph(model);
  const route = layout.edges.find((edge) => model.edges.find((e) => e.id === edge.id)?.label === "напрямую");
  assert.ok(route?.label, "the labelled edge has a label point");
  const half = [..."напрямую"].length * 3.5 + 8; // the drawn pill: ≈ 7 px a character + 8 px each side
  assert.ok(route.label.x - half >= layout.origin.x, `left edge of the label ${route.label.x - half} ≥ ${layout.origin.x}`);
  assert.ok(route.label.x + half <= layout.origin.x + layout.width, "right edge of the label inside");
  assert.ok(route.label.y - 10 >= layout.origin.y && route.label.y + 10 <= layout.origin.y + layout.height, "label inside vertically");
});
