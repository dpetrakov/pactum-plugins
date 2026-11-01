// W-06f (EP-061-T03, T05): the semantic diff of two Mermaid flowcharts — formatting is not a change, parallel edges are
// never matched by order, an unclear pair is removed + added (no guessed «changed»), positions are not part of it.
import assert from "node:assert/strict";
import test from "node:test";
import { diagramDiff } from "../core/diff.ts";
import { parseMermaid } from "../core/mermaid.ts";

const model = (source) => { const parsed = parseMermaid(source); assert.ok(parsed.ok, JSON.stringify(parsed)); return parsed.model; };
const diff = (a, b) => diagramDiff(model(a), model(b));

test("the same graph written differently is not a change", () => {
  const d = diff("flowchart LR\n  A[Старт] --> B --> C", "flowchart LR\n\n  A[Старт]\n  A --> B\n  B   -->   C\n");
  assert.equal(d.total, 0);
  assert.equal(diff("flowchart LR\n A-->B", "flowchart LR\n A-->B").total, 0);
});

test("nodes: added, removed, label / shape / group changed", () => {
  const d = diff("flowchart TB\n  subgraph g [Группа]\n    A\n  end\n  A[Старт] --> B(Шаг)\n  B --> C",
    "flowchart TB\n  subgraph g [Группа]\n    B\n  end\n  A[Начало] --> B{Шаг}\n  B --> D");
  assert.deepEqual(d.nodes.added, ["D"]);
  assert.deepEqual(d.nodes.removed.map((node) => node.id), ["C"]);
  assert.deepEqual(Object.fromEntries(d.nodes.changed.map((entry) => [entry.id, entry.fields])), { A: ["label", "group"], B: ["shape", "group"] });
  assert.equal(d.nodes.changed.find((entry) => entry.id === "A").before.label, "Старт");
  assert.deepEqual(d.edges.added, ["B->D#0"]);
  assert.deepEqual(d.edges.removed.map((edge) => edge.id), ["B->C#0"]);
});

test("a single edge of a pair changes in place; direction and groups are compared", () => {
  const d = diff("flowchart LR\n  A -->|да| B\n  subgraph s [Старое]\n    B\n  end", "flowchart TB\n  A -.->|нет| B\n  subgraph s [Новое]\n    B\n  end");
  assert.deepEqual(d.direction, { before: "LR", after: "TB" });
  assert.deepEqual(d.edges.changed.map((entry) => [entry.id, entry.fields]), [["A->B#0", ["label", "line"]]]);
  assert.deepEqual(d.groups.changed.map((entry) => [entry.id, entry.fields]), [["s", ["title"]]]);
  assert.equal(d.total, 3);
});

test("parallel edges: a reorder is not a change; a change among them is removed + added, never a guessed match", () => {
  const before = "flowchart LR\n  A -->|один| B\n  A -->|два| B";
  assert.equal(diff(before, "flowchart LR\n  A -->|два| B\n  A -->|один| B").total, 0, "reorder");
  const d = diff(before, "flowchart LR\n  A -->|два| B\n  A -->|три| B");
  assert.deepEqual(d.edges.changed, []);
  assert.deepEqual(d.edges.removed.map((edge) => edge.label), ["один"]);
  assert.equal(d.edges.added.length, 1);
  assert.equal(d.total, 2);
});

test("explicit edge ids are identity: a label change is «changed», new ends are removed + added", () => {
  const d = diff("flowchart LR\n  A e1@--> B\n  A e2@--> C", "flowchart LR\n  A e1@-->|метка| B\n  B e2@--> C");
  assert.deepEqual(d.edges.changed.map((entry) => [entry.id, entry.fields]), [["e1", ["label"]]]);
  assert.deepEqual(d.edges.removed.map((edge) => edge.id), ["e2"]);
  assert.deepEqual(d.edges.added, ["e2"]);
});

test("deterministic for the same pair", () => {
  const a = "flowchart LR\n  A --> B\n  A --> B\n  B --> C\n  C --> A";
  const b = "flowchart LR\n  A --> B\n  B --> C\n  B --> C\n  C -.-> A\n  D";
  assert.deepEqual(diff(a, b), diff(a, b));
  const d = diff(a, b);
  assert.equal(d.edges.removed.length, 1, "one of the two A→B edges is gone");
  assert.equal(d.edges.added.length, 1, "a second B→C");
  assert.deepEqual(d.edges.changed.map((entry) => entry.fields), [["line"]]);
  assert.deepEqual(d.nodes.added, ["D"]);
});
