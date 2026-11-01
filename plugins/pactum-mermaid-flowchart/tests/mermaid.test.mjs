// W-06f (EP-058-T02, EP-059-T02): the Mermaid flowchart adapter — model, source ranges, edge identity, limits, safety.
import assert from "node:assert/strict";
import test from "node:test";
import { diagramType, LIMITS, parseMermaid } from "../core/mermaid.ts";

export const MEMORY = `flowchart LR
    A[Работа в тредах] --> B[Доказательства и проверка]
    B --> C[BB Memory: проверенный опыт]
    D[Документы и навыки проекта] --> C
    C --> E[Короткий каталог]
    E --> F[Новая задача любого агента]
    F --> G[Поиск и чтение подробностей]
    G --> C
    G --> D
    G --> B`;

const model = (source) => {
  const result = parseMermaid(source);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.model;
};

test("the memory diagram A–G: 7 nodes with Russian labels, 9 edges incl. cycles, ranges point at the source", () => {
  const m = model(MEMORY);
  assert.equal(m.direction, "LR");
  assert.deepEqual(m.nodes.map((n) => n.id), ["A", "B", "C", "D", "E", "F", "G"]);
  assert.equal(m.nodes.find((n) => n.id === "C").label, "BB Memory: проверенный опыт");
  assert.equal(m.edges.length, 9);
  assert.deepEqual(m.edges.map((e) => e.id), ["A->B#0", "B->C#0", "D->C#0", "C->E#0", "E->F#0", "F->G#0", "G->C#0", "G->D#0", "G->B#0"]);
  const lines = MEMORY.split("\n");
  const a = m.nodes[0].ranges[0];
  assert.equal(lines[a.line - 1].slice(a.start, a.end), "A[Работа в тредах]");
  const ab = m.edges[0].range;
  assert.equal(lines[ab.line - 1].slice(ab.start, ab.end).trim(), "--> B[Доказательства и проверка]");
});

test("shapes, chains, & groups, link styles and labels", () => {
  const m = model(`graph TD
  a([stadium]) --> b[[sub]] --> c[(db)]
  d((circle)) -.-> e{decision} ==> f{{hex}}
  g[/para/] --- h[\\alt\\] -- text --> i[/trap\\]
  j[\\tra/] -->|label| k>flag]
  l & m --> n & o
  p <--> q
  r --o s
  t --x u
  v ~~~ w
  x -. dotted text .-> y
  z == thick text ==> a`);
  const shape = (id) => m.nodes.find((n) => n.id === id).shape;
  assert.deepEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"].map(shape),
    ["stadium", "subroutine", "cylinder", "circle", "diamond", "hexagon", "parallelogram", "parallelogram-alt", "trapezoid", "trapezoid-alt", "asymmetric"]);
  const edge = (from, to) => m.edges.find((e) => e.from === from && e.to === to);
  assert.equal(edge("d", "e").line, "dotted");
  assert.equal(edge("e", "f").line, "thick");
  assert.equal(edge("g", "h").head, "none");
  assert.equal(edge("h", "i").label, "text");
  assert.equal(edge("j", "k").label, "label");
  assert.equal(m.edges.filter((e) => ["l", "m"].includes(e.from) && ["n", "o"].includes(e.to)).length, 4);
  assert.equal(edge("p", "q").tail, "arrow");
  assert.equal(edge("r", "s").head, "circle");
  assert.equal(edge("t", "u").head, "cross");
  assert.equal(edge("v", "w").line, "invisible");
  assert.equal(edge("x", "y").label, "dotted text");
  assert.equal(edge("x", "y").line, "dotted");
  assert.equal(edge("z", "a").label, "thick text");
  assert.equal(edge("z", "a").line, "thick");
});

test("parallel edges and self loops get stable distinct ids; explicit edge ids are kept", () => {
  const m = model(`flowchart LR
  A --> B
  A --> B
  A -->|again| B
  B --> B
  A e1@--> C`);
  assert.deepEqual(m.edges.map((e) => e.id), ["A->B#0", "A->B#1", "A->B#2", "B->B#0", "e1"]);
  assert.equal(m.edges[4].explicitId, true);
});

test("nested subgraphs keep membership, titles and direction", () => {
  const m = model(`flowchart TB
  subgraph outer [Внешняя]
    direction LR
    a --> b
    subgraph inner["Внутренняя группа"]
      c
    end
  end
  b --> c
  d`);
  assert.deepEqual(m.groups.map((g) => [g.id, g.title, g.parent, g.direction]), [["outer", "Внешняя", null, "LR"], ["inner", "Внутренняя группа", "outer", null]]);
  assert.equal(m.nodes.find((n) => n.id === "c").group, "inner");
  assert.equal(m.nodes.find((n) => n.id === "a").group, "outer");
  assert.equal(m.nodes.find((n) => n.id === "d").group, null);
});

test("unsafe source is never executed: directives, styles, click, HTML labels become warnings and text", () => {
  const m = model(`%%{init: {"securityLevel": "loose", "theme": "dark"}}%%
flowchart LR
  A["<img src=x onerror=alert(1)>Привет<br>мир"] --> B
  click A call alert("x")
  click B href "javascript:alert(1)"
  style A fill:#f00
  classDef bad fill:#f00
  B:::bad --> C`);
  const a = m.nodes.find((n) => n.id === "A");
  assert.equal(a.label, "Привет\nмир");
  assert.ok(!JSON.stringify(m).includes("onerror"));
  assert.ok(!JSON.stringify(m).includes("javascript:"));
  const codes = new Set(m.warnings.map((w) => w.code));
  for (const code of ["directive", "click", "style", "class", "html-label"]) assert.ok(codes.has(code), code);
});

test("errors carry the source line; other diagram types are reported, not drawn", () => {
  const bad = parseMermaid("flowchart LR\n  A --> B\n  C --> \n");
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "syntax");
  assert.equal(bad.line, 3);
  assert.equal(parseMermaid("flowchart LR\n subgraph x\n A\n").reason, "syntax");
  const seq = parseMermaid("sequenceDiagram\n  Alice->>Bob: hi");
  assert.equal(seq.reason, "unsupported");
  assert.equal(seq.diagram, "sequenceDiagram");
  assert.equal(diagramType("---\ntitle: x\n---\n%% comment\ngantt"), "gantt");
  assert.equal(parseMermaid("   \n").reason, "empty");
});

test("limits are checked before layout: too many nodes or bytes", () => {
  const many = ["flowchart LR", ...Array.from({ length: LIMITS.nodes + 1 }, (_, i) => `n${i}`)].join("\n");
  assert.equal(parseMermaid(many).reason, "too-large");
  assert.equal(parseMermaid(`flowchart LR\n${"A --> B\n".repeat(LIMITS.bytes / 8 + 10)}`).reason, "too-large");
});
