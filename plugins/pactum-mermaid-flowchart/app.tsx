// pactum-mermaid-flowchart (W-06f, EP-074): the first visualizer of Documents as a plugin of its own. It registers
// with the host through the docs visualizers contract v1 (verbatim copy `visualizers-contract.ts`) when its frontend
// mounts and leaves when it unmounts; the host chooses it for ```mermaid blocks (and .mmd files) whose header says
// flowchart/graph, publishes a canvas slot and draws the frame; this plugin draws the canvas (ui/canvas.tsx).
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { useEffect } from "react";
import "./ui/canvas.css";
import { registerMermaidFlowchart } from "./ui/register.ts";
import { ChatMermaid } from "./ui/chat-fence.tsx";

function Registrar() {
  useEffect(() => registerMermaidFlowchart(), []);
  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "visualizer", component: Registrar });
  // bb 0.46: ```mermaid flowchart in agent replies — the same canvas, read-only; other fences stay bb's (Original).
  app.slots.experimental_codeFenceRenderer({ id: "mermaid-chat", languages: ["mermaid"], component: ChatMermaid });
});
