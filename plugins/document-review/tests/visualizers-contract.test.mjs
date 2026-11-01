// Docs visualizers contract v1 (W-06f, EP-073-T02): one registry per window, generations, a reload replaces the older
// registration, claims and the dispute between two visualizers of one language, host slots with identity, another
// contract major left alone. Copies of the contract in the repository's visualizers are compared by the EP-074 test.
import assert from "node:assert/strict";
import test from "node:test";
import { attachHost, canvasSlot, claims, listVisualizers, matchVisualizers, openRegistry, REGISTRY_KEY, registerVisualizer, revision, subscribe } from "../visualizers-contract.ts";

const vis = (id, extra = {}) => ({
  contract: 1, id, version: "0.1.0", title: id, claims: { languages: ["mermaid"] }, canvas: "interactive", capabilities: { layout: true, ghosts: true },
  engine: "test-1", match: () => ({ dialect: "flowchart", specificity: 10 }), diff: () => ({ items: [], total: 0 }), a11y: () => [], mount: () => ({ update() {}, dispose() {} }), ...extra,
});
const fence = (language = "mermaid") => ({ kind: "fence", language, path: "docs/a.md" });
const file = (path) => ({ kind: "file", language: null, path });
const props = (extra = {}) => ({ source: "flowchart LR\n A-->B", context: { ...fence(), dialect: "flowchart" }, theme: "light", zoom: 1, moving: false, readOnly: false, positions: {}, selected: null, compare: null, annotations: {}, reducedMotion: false, ...extra });
const actions = () => ({ commit() {}, select() {}, report() {}, fail() {} });

test("each window gets one registry; another contract major is left alone", () => {
  const scope = {};
  const first = openRegistry(scope);
  assert.equal(first.ok, true);
  assert.equal(openRegistry(scope).registry, first.registry);
  const foreign = { [REGISTRY_KEY]: { contract: 2 } };
  assert.deepEqual(openRegistry(foreign), { ok: false, reason: "incompatible", found: 2 });
  const refused = registerVisualizer(vis("pactum-mermaid-flowchart"), foreign);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "incompatible");
  assert.equal(foreign[REGISTRY_KEY].contract, 2, "an incompatible registry is not overwritten");
  assert.equal("publish" in attachHost(foreign), false);
  assert.deepEqual(listVisualizers(foreign), []);
  assert.deepEqual(matchVisualizers("flowchart LR", fence(), { scope: foreign }), []);
  assert.equal(revision(foreign), -1);
});

test("a reload's newer registration survives the older disposer; claims are normalised", () => {
  const scope = {};
  const old = registerVisualizer(vis("pactum-mermaid-flowchart", { claims: { languages: [" Mermaid ", "mermaid"], extensions: ["MMD", ".mmd"] } }), scope);
  const fresh = registerVisualizer(vis("pactum-mermaid-flowchart", { version: " 0.2.0 " }), scope);
  assert.ok(old.ok && fresh.ok && fresh.generation > old.generation);
  old.dispose();
  const [entry] = listVisualizers(scope);
  assert.equal(entry.generation, fresh.generation);
  assert.equal(entry.registration.version, "0.2.0");
  assert.deepEqual(entry.status, { complete: true, missing: [] });
  fresh.dispose();
  assert.deepEqual(listVisualizers(scope), []);
  fresh.dispose();
  const again = registerVisualizer(vis("pactum-mermaid-flowchart", { claims: { languages: [" Mermaid "], extensions: ["MMD"] } }), scope);
  assert.ok(again.ok);
  assert.deepEqual(listVisualizers(scope)[0].registration.claims, { languages: ["mermaid"], extensions: [".mmd"] });
});

test("bad registrations are refused with a reason; a visualizer without diff/a11y registers as incomplete", () => {
  const scope = {};
  const reason = (extra) => { const result = registerVisualizer(vis("vis-x", extra), scope); return result.ok ? "ok" : result.reason; };
  assert.equal(reason({ contract: 2 }), "version");
  assert.equal(reason({ id: "Vis/X" }), "invalid");
  assert.equal(reason({ title: "  " }), "invalid");
  assert.equal(reason({ version: "" }), "invalid");
  assert.equal(reason({ engine: "" }), "invalid");
  assert.equal(reason({ canvas: "svg" }), "invalid");
  assert.equal(reason({ match: null }), "invalid");
  assert.equal(reason({ mount: undefined }), "invalid", "interactive needs mount");
  assert.equal(reason({ canvas: "static", mount: undefined }), "invalid", "static needs render");
  assert.equal(reason({ canvas: "static", mount: undefined, render: async () => ({ svg: "", size: { w: 1, h: 1 }, elements: {} }) }), "ok");
  assert.equal(reason({ claims: { languages: [], extensions: [] } }), "invalid", "claims nothing");
  assert.deepEqual(listVisualizers(scope).map((entry) => entry.registration.id), ["vis-x"]);
  const incomplete = registerVisualizer(vis("vis-plain", { diff: undefined, a11y: undefined }), scope);
  assert.ok(incomplete.ok);
  assert.deepEqual(listVisualizers(scope).find((entry) => entry.registration.id === "vis-plain").status, { complete: false, missing: ["diff", "a11y"] });
});

test("claims and the dispute: specificity first, then the user's order, then registration order; a throwing match is skipped", () => {
  const scope = {};
  registerVisualizer(vis("pactum-mermaid-flowchart", { match: (source) => (/^\s*(flowchart|graph)\b/.test(source) ? { dialect: "flowchart", specificity: 10 } : null) }), scope);
  registerVisualizer(vis("pactum-mermaid-sequence", { match: (source) => (/^\s*sequenceDiagram\b/.test(source) ? { dialect: "sequence", specificity: 10 } : null) }), scope);
  registerVisualizer(vis("pactum-mermaid-static", { claims: { languages: ["mermaid"], extensions: [".mmd"] }, match: () => ({ dialect: "any", specificity: 0 }) }), scope);
  registerVisualizer(vis("vis-broken", { match: () => { throw new Error("boom"); } }), scope);
  const quiet = console.warn;
  console.warn = () => {};
  test.after(() => { console.warn = quiet; });
  const ids = (source, context, options) => matchVisualizers(source, context, { scope, ...options }).map((candidate) => candidate.entry.registration.id);
  assert.deepEqual(ids("flowchart LR\n A-->B", fence()), ["pactum-mermaid-flowchart", "pactum-mermaid-static"]);
  assert.deepEqual(ids("sequenceDiagram\n A->>B: hi", fence()), ["pactum-mermaid-sequence", "pactum-mermaid-static"]);
  assert.deepEqual(ids("pie\n a: 1", fence()), ["pactum-mermaid-static"], "only the catch-all takes a pie");
  assert.deepEqual(ids("flowchart LR", fence("plantuml")), [], "another language is nobody's");
  assert.deepEqual(ids("flowchart LR", fence("MERMAID")), ["pactum-mermaid-flowchart", "pactum-mermaid-static"], "language case does not matter");
  assert.deepEqual(ids("flowchart LR", file("docs/x.MMD")), ["pactum-mermaid-static"], "a whole file goes by extension");
  assert.deepEqual(ids("flowchart LR", file("docs/x.md")), []);
  assert.deepEqual(ids("flowchart LR", fence(), { disabled: ["pactum-mermaid-flowchart"] }), ["pactum-mermaid-static"]);
  // Two visualizers with equal specificity: the user's order decides.
  registerVisualizer(vis("pactum-mermaid-flowchart-2", { match: () => ({ dialect: "flowchart", specificity: 10 }) }), scope);
  assert.deepEqual(ids("flowchart LR", fence()).slice(0, 2), ["pactum-mermaid-flowchart", "pactum-mermaid-flowchart-2"], "registration order by default");
  assert.deepEqual(ids("flowchart LR", fence(), { preference: ["pactum-mermaid-flowchart-2"] }).slice(0, 2), ["pactum-mermaid-flowchart-2", "pactum-mermaid-flowchart"]);
  assert.equal(claims(listVisualizers(scope)[0].registration, fence("mermaid")), true);
});

test("the host publishes canvases; unchanged slots keep identity; an older host and generation cannot render", () => {
  const scope = {};
  let changes = 0;
  const unsubscribe = subscribe(() => { changes += 1; }, scope);
  const host = attachHost(scope);
  assert.ok("publish" in host);
  const element = { name: "canvas" };
  const shared = actions();
  const same = props();
  const first = { generation: host.generation, blockKey: "k1", element, props: same, actions: shared };
  host.publish(new Map([["k1", first]]));
  assert.equal(canvasSlot("k1", undefined, scope), first);
  assert.equal(canvasSlot("k1", host.generation, scope), first);
  assert.equal(canvasSlot("k1", host.generation + 7, scope), null, "a slot of another generation is not rendered");
  const before = changes;
  host.publish(new Map([["k1", { ...first, props: { ...same } }]]));
  assert.equal(changes, before, "a new props object with the same values does not notify");
  assert.equal(canvasSlot("k1", undefined, scope), first, "identity kept");
  host.publish(new Map([["k1", { ...first, props: { ...same, moving: true } }]]));
  assert.equal(changes, before + 1);
  assert.equal(canvasSlot("k1", undefined, scope).props.moving, true);
  const newer = attachHost(scope);
  host.publish(new Map([["k2", { ...first, blockKey: "k2" }]]));
  assert.equal(canvasSlot("k2", undefined, scope), null, "the older host lost the right to publish");
  newer.publish(new Map([["k2", { ...first, blockKey: "k2", generation: newer.generation }]]));
  assert.equal(canvasSlot("k2", newer.generation, scope)?.blockKey, "k2");
  newer.dispose();
  assert.equal(canvasSlot("k2", undefined, scope), null);
  unsubscribe();
  const after = changes;
  attachHost(scope);
  assert.equal(changes, after, "unsubscribed");
});

test("a failing listener does not silence the others", () => {
  const scope = {};
  const heard = [];
  const quiet = console.error;
  console.error = () => {};
  try {
    subscribe(() => { throw new Error("boom"); }, scope);
    subscribe(() => heard.push(revision(scope)), scope);
    registerVisualizer(vis("vis-a"), scope);
    assert.deepEqual(heard, [1]);
  } finally { console.error = quiet; }
});
