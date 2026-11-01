import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** A visualizer lives in the window (app.tsx): it registers with Documents through the docs visualizers contract. No server side. */
export default function plugin(_bb: BbPluginApi) {}
