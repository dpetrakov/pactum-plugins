import assert from "node:assert/strict";
import test from "node:test";
import { parseMermaid } from "../core/mermaid.ts";
import { layoutGraph } from "../core/layout.ts";
import { comparisonGhosts } from "../core/ghosts.ts";
const model = source => { const parsed = parseMermaid(source); assert.equal(parsed.ok, true); return parsed.model; };
const before = model("flowchart LR\n A-->B\n B-->C"), base = layoutGraph(before);
const after = model("flowchart LR\n A-->B\n C"), pins = Object.fromEntries(Object.entries(base.nodes).map(([id, b]) => [id, { x: b.x, y: b.y }]));
const current = () => layoutGraph(after, undefined, pins);
const removed = new Set(["B->C#0"]);
test("a removed edge with unchanged, visible endpoints keeps its complete ghost", () => {
  assert.equal(comparisonGhosts(before, base, current(), removed).edges.length, 1);
});
test("a changed layout never leaves an orphan segment at an obsolete node position", () => {
  const now = current(); now.nodes.B = { ...now.nodes.B, y: now.nodes.B.y + 50 };
  assert.equal(comparisonGhosts(before, base, now, removed).edges.length, 0);
});
test("a new node occluding an old edge falls back to the complete change list", () => {
  const now = current(); now.nodes.review = { x: (now.nodes.B.x + now.nodes.C.x) / 2, y: now.nodes.B.y, w: 15, h: 50 };
  assert.equal(comparisonGhosts(before, base, now, removed).edges.length, 0);
});
test("clipped routes and overlapping removed nodes do not produce fragments", () => {
  const now = current(); now.width = 10;
  assert.equal(comparisonGhosts(before, base, now, removed).edges.length, 0);
  const empty = { ...base, nodes: { A: base.nodes.A, B: base.nodes.B } };
  assert.equal(comparisonGhosts(before, base, empty, new Set(["C"])).nodes.length, 1);
  empty.nodes.replacement = base.nodes.C;
  assert.equal(comparisonGhosts(before, base, empty, new Set(["C"])).nodes.length, 0);
});
