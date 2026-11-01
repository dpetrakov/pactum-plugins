import fs from "node:fs/promises";
import path from "node:path";
import { createRequire, register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sources } from "../site/demos/fixtures.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "plugins/document-review/package.json"));
const { build } = require("esbuild");
register(new URL("../plugins/document-review/tests/tsx-loader.mjs", import.meta.url), import.meta.url);
const { createElement } = await import(pathToFileURL(require.resolve("react")));
const { renderToStaticMarkup } = await import(pathToFileURL(require.resolve("react-dom/server")));
const { DocumentBody } = await import("../plugins/document-review/ui/render.tsx");
const { project, blockDiff } = await import("../plugins/document-review/core/markdown/index.ts");
const handlers = { doc: "docs/release-plan.md", previewBase: null, showDiff: true, onlyChanges: false, markers: new Map([[4, [{ annotationId: "demo-note", waiting: false }]]]), focusBlocks: new Set(), writable: true,
  openDoc() {}, openUrl() {}, onRead() {}, onReadSection() {}, onComment() {}, onReadRemoved() {}, onCommentRemoved() {}, onMarker() {} };
const variants = [[1, 0], [1, 1], [2, 0], [2, 1], [2, 2]];
const templates = [];
for (const [current, baseline] of variants) {
  const before = project(sources[baseline]).blocks;
  const blocks = project(sources[current]).blocks.map((b, index) => {
    const changed = b.text !== before[index]?.text;
    return { ...b, index, inline: b.fingerprint?.inline ?? b.inline ?? [b.text], attrs: b.fingerprint?.attrs ?? b.attrs ?? {}, depth: b.depth ?? null, cell: b.cell ?? null, headings: b.headings ?? [], lineageId: `demo-${index}`, versionId: `demo-${current}-${index}`, read: changed ? "unread" : "read", change: changed ? "edited" : null, diff: changed ? { ...blockDiff(before[index]?.text ?? "", b.text), before: before[index]?.text ?? "" } : null, moved: false, movedFrom: null };
  });
  templates.push(`<template id="document-${current}-${baseline}" data-unread="${blocks.filter(b => b.read === "unread").length}">${renderToStaticMarkup(createElement(DocumentBody, { blocks, removed: [], handlers }))}</template>`);
}
const htmlPath = path.join(root, "site/index.html");
const html = await fs.readFile(htmlPath, "utf8");
await fs.writeFile(htmlPath, html.replace(/<!--review:templates-->[\s\S]*?<!--review:templates:end-->/, `<!--review:templates-->\n${templates.join("\n")}\n<!--review:templates:end-->`));
await fs.copyFile(path.join(root, "plugins/document-review/ui/theme.css"), path.join(root, "site/assets/document-demo.css"));
await fs.copyFile(path.join(root, "plugins/pactum-mermaid-flowchart/ui/canvas.css"), path.join(root, "site/assets/diagram-demo.css"));
await build({ entryPoints: [path.join(root, "site/demos/diagram.ts")], outfile: path.join(root, "site/assets/diagram-demo.js"), bundle: true, minify: true, format: "esm", target: "es2022", define: { "process.env.NODE_ENV": '"production"' }, legalComments: "linked", logLevel: "warning" });
console.log("Built site examples with the Documents renderer and Mermaid canvas.");
// Static-site deployments include full dependency notices alongside the generated bundle.
const notices = await Promise.all(["react-MIT.txt", "react-dom-MIT.txt", "scheduler-MIT.txt", "dagre-MIT.txt", "graphlib-MIT.txt"].map(async file => `${file}\n${await fs.readFile(path.join(root, "LICENSES", file), "utf8")}`));
await fs.appendFile(path.join(root, "site/assets/diagram-demo.js.LEGAL.txt"), `\n\n${notices.join("\n\n")}\n`);
