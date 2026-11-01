// The extension contract must be portable without importing the Documents runtime.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("visualizer contract remains a portable, import-free module", async () => {
  const source = await fs.readFile(new URL("../visualizers-contract.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^import\s/m);
  assert.match(source, /export function registerVisualizer/);
  assert.match(source, /VISUALIZERS_CONTRACT = 1/);
});
