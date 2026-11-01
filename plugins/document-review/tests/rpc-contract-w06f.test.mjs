// The RPC contract accepts what the W-06f client sends (found live on the workstation: strict schemas refused `engine` and
// `element`, and every earlier probe intercepted the writes). The contract is the gate between the window and the host.
import assert from "node:assert/strict";
import test from "node:test";
import { hostContract } from "../host-contract.ts";
import { rpcContract } from "../server.ts";

const target = { environmentId: "env_x" };
const observation = { sha: "a".repeat(64) };

test("review.layout takes the visualizer's engine; review.annotate takes an element of an object", () => {
  const layout = rpcContract["review.layout"].input.safeParse({ target, path: "docs/a.md", observation, block: 2, pins: [{ id: "D", x: 479, y: 119 }], unpin: [], engine: "pactum-mermaid-flowchart@0.1.0/dagre-3.1.1+route-1" });
  assert.equal(layout.success, true, JSON.stringify(layout.error?.issues));
  assert.equal(rpcContract["review.layout"].input.safeParse({ target, path: "docs/a.md", observation, block: 2, pins: [], unpin: ["D"] }).success, true, "engine is optional for a reset");
  assert.equal(rpcContract["review.layout"].input.safeParse({ target, path: "docs/a.md", observation, block: 2, pins: [], engine: "x".repeat(65) }).success, false);
  const annotate = rpcContract["review.annotate"].input.safeParse({ target, path: "docs/a.md", observation, text: "x", kind: "action", targetKind: "block", block: 2,
    element: { id: "note", kind: "node", label: "Пишет замечание", range: { line: 3, start: 30, end: 58 } } });
  assert.equal(annotate.success, true, JSON.stringify(annotate.error?.issues));
  assert.equal(rpcContract["review.annotate"].input.safeParse({ target, path: "docs/a.md", observation, text: "x", kind: "note", targetKind: "block", block: 2, element: { id: "n", kind: "shape", label: "" } }).success, false);
});

test("the host contract (server → host on the checkout's machine) takes the same fields", () => {
  const root = "/tmp/checkout";
  const layout = hostContract.layout.input.safeParse({ root, path: "docs/a.md", observation, block: 2, pins: [{ id: "D", x: 479, y: 119 }], unpin: [], engine: "pactum-mermaid-flowchart@0.1.0/dagre-3.1.1+route-1" });
  assert.equal(layout.success, true, JSON.stringify(layout.error?.issues));
  const annotate = hostContract.annotate.input.safeParse({ root, path: "docs/a.md", observation, text: "x", kind: "action", targetKind: "block", block: 2, element: { id: "note", kind: "node", label: "Пишет", range: { line: 3, start: 30, end: 58 } } });
  assert.equal(annotate.success, true, JSON.stringify(annotate.error?.issues));
});

test("viewer opening and bounded file downloads survive both strict RPC contracts", () => {
  for (const [contract, context, view, file] of [[rpcContract, { target }, "review.view", "review.fileInfo"], [hostContract, { root: "/tmp/docs" }, "view", "fileInfo"]]) {
    assert.equal(contract[view].input.safeParse({ ...context, path: "a.md", opened: true, compact: true }).success, true);
    assert.equal(contract[file].input.safeParse({ ...context, path: "a.md", chunk: { offset: 524288, version: "size:mtime:ctime" } }).success, true);
    assert.equal(contract[file].input.safeParse({ ...context, path: "a.md", chunk: { offset: -1, version: "v" } }).success, false);
  }
});
