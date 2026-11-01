// Visualizer preference of the device and the choice of a visualizer (W-06f, EP-073-T03): order decides a dispute,
// switched-off and audit-blocked ids are not asked, an unknown stored shape falls back to defaults.
import assert from "node:assert/strict";
import test from "node:test";
import { openRegistry, registerVisualizer, REGISTRY_KEY } from "../visualizers-contract.ts";

const store = new Map();
globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) };
const prefs = await import("../ui/visualizers.ts");

const vis = (id, specificity = 10) => ({
  contract: 1, id, version: "0.1.0", title: id, claims: { languages: ["mermaid"] }, canvas: "interactive", capabilities: { layout: true, ghosts: false },
  engine: "t", match: () => ({ dialect: "flowchart", specificity }), diff: () => ({ items: [], total: 0 }), a11y: () => [], mount: () => ({ update() {}, dispose() {} }),
});
const fence = { kind: "fence", language: "mermaid", path: "docs/a.md" };

test("order, switch-off and audit block decide the choice; the preference survives in localStorage", () => {
  store.set("bbdr:visualizers:v1", JSON.stringify({ order: ["b", "Bad Id"], disabled: 5, blocked: { c: "script" } }));
  const a = registerVisualizer(vis("a"));
  const b = registerVisualizer(vis("b"));
  const c = registerVisualizer(vis("c", 20));
  assert.deepEqual(prefs.visualizerPrefs(), { order: ["b"], disabled: [], blocked: { c: "script" } }, "unknown shapes dropped");
  assert.deepEqual(prefs.orderedIds(), ["b", "a", "c"]);
  assert.equal(prefs.pickVisualizer("flowchart LR", fence).entry.registration.id, "b", "the user's order wins a tie; the blocked one (even more specific) is not asked");
  prefs.setVisualizerEnabled("c", true);
  assert.equal(prefs.pickVisualizer("flowchart LR", fence).entry.registration.id, "c", "unblocked: highest specificity wins");
  prefs.blockVisualizer("c", "iframe");
  prefs.setVisualizerEnabled("b", false);
  assert.equal(prefs.pickVisualizer("flowchart LR", fence).entry.registration.id, "a");
  prefs.moveVisualizer("a", 1);
  assert.deepEqual(prefs.orderedIds(), ["b", "c", "a"]);
  prefs.moveVisualizer("a", 1);
  assert.deepEqual(prefs.orderedIds(), ["b", "c", "a"], "cannot move past the end");
  prefs.setVisualizerEnabled("a", false);
  assert.equal(prefs.pickVisualizer("flowchart LR", fence), null, "nobody left: the host shows the code");
  const saved = JSON.parse(store.get("bbdr:visualizers:v1"));
  assert.deepEqual(saved.disabled, ["b", "a"]);
  assert.equal(saved.blocked.c, "iframe");
  assert.equal(prefs.isVisualizerOff("c"), true);
  a.dispose(); b.dispose(); c.dispose();
});

test("the host publishes canvases for objects and withdraws them", () => {
  const element = {};
  prefs.publishCanvas("k1", { blockKey: "k1", element, props: {}, actions: {} });
  const generation = prefs.hostGeneration();
  assert.equal(prefs.canvasSlot("k1", generation)?.element, element);
  prefs.publishCanvas("k1", null);
  assert.equal(prefs.canvasSlot("k1", generation), null);
  assert.equal(openRegistry().registry, globalThis[REGISTRY_KEY]);
});
