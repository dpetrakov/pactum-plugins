// The host's security corpus (docs visualizers contract Security): every source goes through this plugin's parser
// and never becomes markup — tags in labels are dropped, forbidden syntax is reported as warnings; diff and a11y stay text.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseMermaid } from "../core/mermaid.ts";
import { mermaidA11y, mermaidDiff } from "../ui/adapter.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(await fs.readFile(path.join(here, "./fixtures/visualizers-corpus.json"), "utf8"));

test("corpus sources: attack text stays text, what is not applied is named", () => {
  for (const item of corpus.sources) {
    const parsed = parseMermaid(item.text);
    assert.equal(parsed.ok, true, `${item.name}: parses`);
    const labels = parsed.model.nodes.map((node) => node.label).join("\n");
    if (item.mustContain) assert.ok(labels.includes(item.mustContain), `${item.name}: the text stays literal in the label`);
    if (item.mustNotContain) assert.ok(!labels.includes(item.mustNotContain), `${item.name}: no markup in the label (got ${JSON.stringify(labels)})`);
    if (item.warning) assert.ok(parsed.model.warnings.some((w) => w.code === item.warning), `${item.name}: warning ${item.warning} (got ${parsed.model.warnings.map((w) => w.code).join(",")})`);
    const diff = mermaidDiff("flowchart LR\n  A --> B", item.text);
    assert.ok("items" in diff);
    assert.ok(mermaidA11y(item.text).every((entry) => typeof entry.label === "string"));
  }
});

test("the contract copy is verbatim the host's", async () => {
  const mine = await fs.readFile(path.join(here, "../visualizers-contract.ts"), "utf8");
  assert.match(mine, /export const VISUALIZERS_CONTRACT = 1/);
  const host = await fs.readFile(path.join(here, "../../document-review/visualizers-contract.ts"), "utf8").catch(() => null);
  if (host) assert.equal(mine, host);
});
