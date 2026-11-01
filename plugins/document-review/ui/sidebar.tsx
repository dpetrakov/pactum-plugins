// «Documents» as a view of the sidebar-tabs host (contract v1, EP-013-T01): registered once per window from an
// app overlay, rendered into the host's slot through a portal (this plugin's React context and CSS scope), follows
// the «Documents» screen, shows the waiting count as the tab badge. Without the host nothing renders here and the
// screen shows the same tree as a column (AC24 fallback).
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { Component, type ReactNode, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { rpcContract } from "../server.ts";
import { registerView, revision, subscribe, viewSlot } from "../sidebar-tabs-contract.ts";
import { bindRpc, loadBatch, loadTree, openContext } from "./actions.ts";
import { parseRoute } from "./route.ts";
import { getUi, lastContext, useUi } from "./store.ts";
import { Icon } from "./icons.tsx";
import { Banner, Button } from "./kit.tsx";
import { tr } from "../core/i18n.ts";
import { isEnableRunning } from "./enable-job.ts";
import { DocsTree } from "./tree.tsx";

export const PLUGIN_ID = "document-review";
export const VIEW_ID = `${PLUGIN_ID}/docs`;

let generation: number | null = null;
const listeners = new Set<() => void>();

/** Is the tree shown in the sidebar host right now (then the screen does not repeat it as a column)? */
export function useSidebarHosted(): boolean {
  useSyncExternalStore(subscribe, revision, revision);
  useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => generation, () => generation);
  return generation !== null && viewSlot(VIEW_ID, generation) !== null;
}

function setGeneration(value: number | null) {
  generation = value;
  for (const listener of listeners) listener();
}

export function SidebarView() {
  const rpc = useRpc<typeof rpcContract>();
  bindRpc(rpc);
  const [registration, setRegistration] = useState<{ generation: number; setBadge: (count: number | null) => void } | null>(null);
  useLayoutEffect(() => {
    const result = registerView({ contract: 1, id: VIEW_ID, pluginId: PLUGIN_ID, title: tr("Documents", "Документы"), order: 10, icon: "FileText", follows: { navItems: [VIEW_ID], routePrefixes: [`/plugins/${PLUGIN_ID}/`] } });
    if (!result.ok) { console.warn(`[document-review] sidebar view not registered: ${result.message}`); return; }
    setRegistration({ generation: result.generation, setBadge: result.setBadge });
    setGeneration(result.generation);
    return () => { result.dispose(); setRegistration(null); setGeneration(null); };
  }, []);
  useSyncExternalStore(subscribe, revision, revision);
  const slot = registration ? viewSlot(VIEW_ID, registration.generation) : null;
  const tree = useUi((ui) => ui.tree);
  const agentWaiting = useUi((ui) => Boolean(ui.batch?.thread?.waitingUser));
  const routeKind = useUi((ui) => ui.route.kind);

  // Outside the screen the tree follows the last selected checkout (I5).
  useEffect(() => {
    if (!slot || routeKind !== "none") return;
    const last = lastContext();
    const route = last ? parseRoute(last.subPath) : null;
    if (route && route.kind !== "none") void openContext(route);
  }, [Boolean(slot), routeKind]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!slot) return;
    // While the «Documents» screen is open its refresh (15 s, focus, file watch) already reloads the tree and the batch
    // of the same checkout; the sidebar keeps its own poll only outside the screen (W-06b).
    const timer = setInterval(() => { if (document.visibilityState === "visible" && getUi().target && getUi().route.kind === "none") { void loadTree(); void loadBatch(); } }, 30_000);
    return () => clearInterval(timer);
  }, [Boolean(slot)]); // eslint-disable-line react-hooks/exhaustive-deps
  useRealtime("review.changed", (payload) => {
    const { root, hostId } = (payload ?? {}) as { root?: string; hostId?: string };
    if (isEnableRunning(hostId, root)) return;
    const ui = getUi();
    // Changes of other checkouts are not this tree's (W-06b: the hint was unfiltered).
    if (slot && ui.target && ui.route.kind === "none" && (!root || !ui.tree?.root || root === ui.tree.root)) void loadTree();
  });
  useEffect(() => {
    if (!registration) return;
    const count = (tree?.totals.waiting ?? 0) + (agentWaiting ? 1 : 0);
    registration.setBadge(count || null);
  }, [registration, tree?.totals.waiting, agentWaiting]);

  if (!slot || !registration) return null;
  return createPortal(<div data-bb-plugin={PLUGIN_ID} data-dr className="h-full">
    <ViewBoundary>{slot.props.isActive ? <DocsTree onNavigate={slot.props.onNavigate} compact={slot.props.isCompactViewport} /> : null}</ViewBoundary>
  </div>, slot.element);
}

/** A broken tree stays inside its tab: the host, other tabs and the footer switch keep working. */
class ViewBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error("[document-review] sidebar view crashed", error); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div role="alert" className="p-2" data-dr>
      <Banner icon="TriangleAlert" tone="error" actions={<Button size="sm" onClick={() => this.setState({ error: null })}><Icon name="RefreshCw" />{tr("Retry", "Повторить")}</Button>}>{tr("The document tree did not render: ", "Дерево документов не отрисовалось: ")}{this.state.error.message}</Banner>
    </div>;
  }
}
