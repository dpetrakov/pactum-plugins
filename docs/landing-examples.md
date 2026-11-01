# Landing examples

The static site at pactum.work uses the Trinity identity around examples rendered with bb host colors. No demo connects to an agent, Git checkout or Pactum service. Fixtures contain synthetic documents and identities. Only the site theme is persisted; all example edits and read states are in page memory.

## Build

```sh
npm ci --prefix plugins/document-review
npm ci --prefix plugins/pactum-mermaid-flowchart
node plugins/document-review/node_modules/typescript/bin/tsc -p site/tsconfig.json
node --experimental-strip-types scripts/build-site.mjs
node --test tests/site.test.mjs tests/site-browser.test.mjs tests/diagram-browser.test.mjs
python3 -m http.server --directory site 8080
```

Install Playwright Chromium from the Documents package before running browser checks. CI rebuilds the generated files and rejects drift. GitHub Pages serves the committed static output.

`build-site.mjs` renders the actual Documents `DocumentBody` into baseline/current templates, copies the actual plugin CSS, and bundles the actual Mermaid canvas with its license notices. `site/demos/fixtures.mjs` supplies only synthetic inputs. `site/site.js` hosts the examples; it never calls plugin RPC or agent APIs. The Mermaid entry is lazy loaded near the viewport.

## Scenarios

- Review: adjacent changes, read/undo, raw source, inline block or selected-text comments, team notes and one agent batch. A scripted response adds a human review step. Acceptance of a response stays separate from personal read receipts.
- Mermaid: compare nodes/connections, hide comparison, inspect code, move nodes, reset positions, comment on the selected node. Enter starts keyboard movement, arrows move, Enter commits and Escape cancels.
- Table: pointer/touch dividers or keyboard arrows change widths. Shift uses a larger step; Home/End set the bounds. Reset restores the initial widths. This example mirrors the plugin interaction; the source stays unchanged.
- Team: independently mark files read as Alex or Sam, share notes and toggle tracked roots. Actual collaboration uses normal Git commit/push/pull of `.bb-docs`, not a live cloud session.

Keep public install commands aligned with the package versions and marketplace ranges. The optional Mermaid package must remain independently installable so the site's diagram claims can be reproduced in bb.
