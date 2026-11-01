# Third-party notices

Project-owned source is Apache-2.0. Third-party licenses remain in force.

## Vendored source

- `plugins/document-review/components/ui/` contains modified components from the bb UI registry, based on Radix/shadcn patterns. Source: https://github.com/get-bb/bb, registry version `desktop-v0.45.0` from the original component manifest. bb is MIT; the complete notice is in `LICENSES/bb-MIT.txt`. Local modifications add Documents styles, responsive overlays, focus handling and feedback.
- `feedback-ui.tsx` includes Lucide loader geometry. `lucide-react` supplies the remaining icons under ISC, with inherited Feather icons under MIT. The package's license notice is retained in `LICENSES/lucide.txt`.

## Installed dependencies

The package manifests and lockfiles record the exact dependency versions. Their original licenses and notices are installed with their packages. They include Radix, React, Zod, YAML, diff, the unified/micromark/unist utilities, Lucide, Vaul and the bb Plugin SDK. A dependency-license inventory is maintained in `docs/dependency-licenses.json`.

Do not remove copyright or license notices while translating comments or moving source. Generated release archives include this file and LICENSES/.

## Landing fonts

Fraunces, Inter and JetBrains Mono are bundled as original variable font files from the [Google Fonts repository](https://github.com/google/fonts). Each uses SIL Open Font License 1.1. Full licenses and copyright notices are in `LICENSES/fraunces-OFL.txt`, `LICENSES/inter-OFL.txt` and `LICENSES/jetbrainsmono-OFL.txt`.

## Mermaid layout and landing bundle

`@dagrejs/dagre` and its `@dagrejs/graphlib` dependency use the MIT license. Their complete notices are retained in `LICENSES/dagre-MIT.txt` and `LICENSES/graphlib-MIT.txt`. The exact versions are recorded in the Mermaid package lockfile and `docs/mermaid-dependency-licenses.json`.

The landing's generated diagram bundle includes React, React DOM, Scheduler, Dagre and Graphlib. `site/assets/diagram-demo.js.LEGAL.txt` carries its bundled notices and full MIT grants, also retained under `LICENSES/`; its editable source is `site/demos/diagram.ts` and the public Mermaid package. Build it with `node --experimental-strip-types scripts/build-site.mjs` after installing both packages' dependencies. Document markup and CSS come from the public Documents package.
