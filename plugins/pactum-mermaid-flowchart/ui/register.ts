// The registration of the Mermaid flowchart visualizer (W-06f, EP-074): what the host learns about this plugin.
// Shared by the bb plugin (app.tsx) and the demo sheet of Documents (docs/plugins/document-review/design/embedded).
import { LAYOUT_ENGINE_VERSION } from "../core/engine.ts";
import { registerVisualizer, type VisualizerRegistration } from "../visualizers-contract.ts";
import { HEADER, mermaidA11y, mermaidDiff } from "./adapter.ts";
import { mountMermaidCanvas } from "./canvas.tsx";

export const PLUGIN_ID = "pactum-mermaid-flowchart";
export const PLUGIN_VERSION = "0.3.0";

export const registration: VisualizerRegistration = {
  contract: 1,
  id: PLUGIN_ID,
  version: PLUGIN_VERSION,
  title: "Mermaid · flowchart",
  icon: "Workflow",
  claims: { languages: ["mermaid"], extensions: [".mmd", ".mermaid"] },
  canvas: "interactive",
  capabilities: { layout: true, ghosts: true },
  limits: { bytes: 64 * 1024, items: 600 },
  engine: LAYOUT_ENGINE_VERSION,
  match: (source) => (HEADER.test(source) ? { dialect: "flowchart", specificity: 10 } : null),
  diff: (base, source) => mermaidDiff(base, source),
  a11y: (source) => mermaidA11y(source),
  mount: (slot) => mountMermaidCanvas(slot),
};

/** Register once per window; returns the disposer. A reload of the plugin registers again and replaces the older one. */
export function registerMermaidFlowchart(): () => void {
  const result = registerVisualizer(registration);
  if (!result.ok) { console.warn(`[${PLUGIN_ID}] not registered: ${result.message}`); return () => {}; }
  return () => result.dispose();
}
