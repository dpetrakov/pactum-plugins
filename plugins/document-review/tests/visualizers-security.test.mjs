// Host security boundary for visualizers. The corpus sources are
// run by every visualizer plugin in its own tests. Part 2 checks the SVG sanitiser and the post-render audit in a real browser (Playwright, `PLAYWRIGHT_CORE`); without
// a browser it is skipped and says so — the release check runs it on local and remote hosts.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(await fs.readFile(path.join(here, "fixtures/visualizers/corpus.json"), "utf8"));

test("the corpus has sources for visualizers and cases for the host", () => {
  assert.ok(corpus.sources.length >= 8 && corpus.svg.length >= 8 && corpus.dom.length >= 6);
  // The sources are run by every visualizer of the repository in its own tests (plugins/pactum-*/tests/security.test.mjs).
});

test("sanitiser and audit in a browser", { skip: (process.env.PLAYWRIGHT_CORE || process.env.PACTUM_BROWSER_TESTS) ? false : "set PLAYWRIGHT_CORE to the playwright-core entry to run the browser part" }, async () => {
  const require = createRequire(path.join(here, "../package.json"));
  const esbuild = require("esbuild");
  const built = await esbuild.build({ entryPoints: [path.join(here, "../ui/svg-sanitize.ts")], bundle: true, write: false, format: "iife", globalName: "__san", logLevel: "error" });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vis-sec-"));
  const page = path.join(dir, "index.html");
  await fs.writeFile(page, `<!doctype html><html><body><div id="c"></div><script>${built.outputFiles[0].text.replace(/<\/script/g, "<\\/script")}</script></body></html>`);
  const { chromium } = await import(process.env.PLAYWRIGHT_CORE || "playwright");
  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage();
    await tab.goto(`file://${page}`);
    const results = await tab.evaluate((corpus) => {
      const svg = corpus.svg.map((item) => {
        const result = __san.sanitizeSvg(item.markup);
        if (!result) return { name: item.name, null: true };
        const serialized = new XMLSerializer().serializeToString(result.svg);
        return { name: item.name, removed: result.removed, serialized, tags: [...result.svg.querySelectorAll("*")].map((n) => n.localName) };
      });
      const dom = corpus.dom.map((item) => { const c = document.getElementById("c"); c.innerHTML = item.html; const found = __san.auditCanvas(c); return { name: item.name, found, after: c.innerHTML }; });
      return { svg, dom };
    }, corpus);
    for (const [i, item] of corpus.svg.entries()) {
      const got = results.svg[i];
      if (item.null) { assert.equal(got.null, true, item.name); continue; }
      assert.equal(got.null, undefined, `${item.name}: is svg`);
      for (const name of item.removed) assert.ok(got.removed.includes(name), `${item.name}: removed ${name} (got ${got.removed.join(", ")})`);
      for (const tag of item.kept) assert.ok(got.tags.includes(tag), `${item.name}: kept <${tag}>`);
      assert.ok(!/<script|onclick|onmouseover|javascript:|evil\.example|<foreignObject|<iframe|<object/i.test(got.serialized), `${item.name}: nothing forbidden survives`);
    }
    for (const [i, item] of corpus.dom.entries()) {
      const got = results.dom[i];
      assert.deepEqual([...got.found].sort(), [...item.found].sort(), `${item.name} (got ${got.found.join(", ")})`);
      assert.ok(!/<script|onclick|javascript:|evil\.example|<iframe/i.test(got.after), `${item.name}: the canvas is clean after the audit`);
    }
  } finally { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
