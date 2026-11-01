/**
 * Sidebar tabs contract v1 — how the sidebar-tabs host and the plugins that supply its views meet inside one app window.
 *
 * Every participant bundles a verbatim copy of this file (tests compare the copies); the shared object it manages,
 * `globalThis[Symbol.for("bb-workbench.sidebar-tabs")]`, is the contract. A window is one JS realm, so tabs and their
 * state never leak between windows. No React and no DOM access here: providers render their own UI, with their own
 * plugin context and CSS scope, into the element the host publishes for their view.
 */

export const SIDEBAR_TABS_CONTRACT = 1 as const;
export const REGISTRY_KEY = Symbol.for("bb-workbench.sidebar-tabs");

/** What the host hands a view: the sidebar's thread-list props plus whether the view's tab is the selected one. */
export interface ViewProps {
  activeThreadId: string | null;
  activeProjectId: string | null;
  isCompactViewport: boolean;
  /** The view's tab is selected and its element visible. */
  isActive: boolean;
  /** Call after opening a thread or page: closes the mobile drawer. */
  onNavigate(): void;
}

/** Routes whose opening selects the view's tab. Opening never changes the global list mode. */
export interface ViewFollow {
  /** Opening any thread. */
  threads?: boolean;
  /** Sidebar navigation item ids, `<pluginId>/<panelId>`. */
  navItems?: readonly string[];
  /** Path prefixes, e.g. `/plugins/<pluginId>/`. */
  routePrefixes?: readonly string[];
}

export interface ViewRegistration {
  contract: typeof SIDEBAR_TABS_CONTRACT;
  /** `<pluginId>/<view>`: lower-case letters, digits, `-` and `_`. */
  id: string;
  pluginId: string;
  /** Tab label. */
  title: string;
  /** Lower comes first; ties by title. Default 100. */
  order?: number;
  follows?: ViewFollow;
  /**
   * Lucide icon before the tab label, by its lucide-react name (`"FileText"`; kebab-case `"file-text"` reads the same).
   * Optional and additive (still contract 1): without it, or with a name the host does not draw, the tab shows its
   * label alone. Anything but a non-empty string is dropped at registration, never refused.
   */
  icon?: string;
}

export interface ViewEntry {
  registration: ViewRegistration;
  generation: number;
  /** Counter beside the tab label; null hides it. */
  badge: number | null;
}

export interface ViewSlot {
  /** The registration this slot was placed for; a provider renders only into a slot of its own generation. */
  generation: number;
  element: HTMLElement;
  props: ViewProps;
}

export interface HostEntry {
  generation: number;
  slots: ReadonlyMap<string, ViewSlot>;
}

export interface Registry {
  contract: typeof SIDEBAR_TABS_CONTRACT;
  /** Bumped on every change; a cheap snapshot for subscribers. */
  revision: number;
  nextGeneration: number;
  views: Map<string, ViewEntry>;
  host: HostEntry | null;
  listeners: Set<() => void>;
}

export type RegistryResult = { ok: true; registry: Registry } | { ok: false; reason: "incompatible"; found: unknown };

export type RegisterResult =
  | { ok: true; generation: number; setBadge(badge: number | null): void; dispose(): void }
  | { ok: false; reason: "incompatible" | "version" | "invalid" | "duplicate"; message: string };

export interface HostHandle {
  generation: number;
  /** Replace the published slots; unchanged slots keep their identity, so subscribers re-render only on real change. */
  publish(slots: ReadonlyMap<string, ViewSlot>): void;
  dispose(): void;
}

const VIEW_ID = /^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/;

type Scope = Record<symbol, unknown>;
const globalScope = () => globalThis as unknown as Scope;

/** The window's registry, created on first use. A registry of another contract major is left alone and reported. */
export function openRegistry(scope: Scope = globalScope()): RegistryResult {
  const found = scope[REGISTRY_KEY];
  if (found === undefined) {
    const registry: Registry = { contract: SIDEBAR_TABS_CONTRACT, revision: 0, nextGeneration: 1, views: new Map(), host: null, listeners: new Set() };
    scope[REGISTRY_KEY] = registry;
    return { ok: true, registry };
  }
  if (typeof found === "object" && found !== null && (found as { contract?: unknown }).contract === SIDEBAR_TABS_CONTRACT) return { ok: true, registry: found as Registry };
  return { ok: false, reason: "incompatible", found: (found as { contract?: unknown } | null)?.contract };
}

function notify(registry: Registry) {
  registry.revision += 1;
  for (const listener of [...registry.listeners]) {
    // One participant's listener must not stop the others from hearing the change.
    try { listener(); } catch (error) { console.error("[sidebar-tabs] listener failed", error); }
  }
}

/**
 * Register a view. A newer registration of the same id by the same plugin (a reload) replaces the older one;
 * the older disposer then does nothing. The same id from another plugin is refused while the first one lives.
 */
export function registerView(registration: ViewRegistration, scope: Scope = globalScope()): RegisterResult {
  const opened = openRegistry(scope);
  if (!opened.ok) return { ok: false, reason: "incompatible", message: `sidebar tabs contract ${String(opened.found)} in this window, view speaks ${SIDEBAR_TABS_CONTRACT}` };
  const { registry } = opened;
  if (registration.contract !== SIDEBAR_TABS_CONTRACT) return { ok: false, reason: "version", message: `view ${registration.id} speaks contract ${String(registration.contract)}, host speaks ${SIDEBAR_TABS_CONTRACT}` };
  if (!VIEW_ID.test(registration.id) || !registration.id.startsWith(`${registration.pluginId}/`) || !registration.title.trim()) {
    return { ok: false, reason: "invalid", message: `invalid view registration ${JSON.stringify(registration.id)}` };
  }
  const existing = registry.views.get(registration.id);
  if (existing && existing.registration.pluginId !== registration.pluginId) {
    return { ok: false, reason: "duplicate", message: `view ${registration.id} already belongs to ${existing.registration.pluginId}` };
  }
  const generation = registry.nextGeneration++;
  const { icon, ...rest } = registration;
  const stored: ViewRegistration = { ...rest, follows: registration.follows ?? {} };
  if (typeof icon === "string" && icon.trim()) stored.icon = icon.trim();
  registry.views.set(registration.id, { registration: stored, generation, badge: null });
  notify(registry);
  const current = () => registry.views.get(registration.id)?.generation === generation;
  return {
    ok: true,
    generation,
    setBadge(badge) {
      const entry = registry.views.get(registration.id);
      const next = typeof badge === "number" && Number.isFinite(badge) && badge > 0 ? Math.floor(badge) : null;
      if (!entry || entry.generation !== generation || entry.badge === next) return;
      registry.views.set(registration.id, { ...entry, badge: next });
      notify(registry);
    },
    dispose() {
      if (!current()) return;
      registry.views.delete(registration.id);
      notify(registry);
    },
  };
}

/** Attach the window's host. A newer host replaces an older one; the older handle then does nothing. */
export function attachHost(scope: Scope = globalScope()): HostHandle | { ok: false; reason: "incompatible"; message: string } {
  const opened = openRegistry(scope);
  if (!opened.ok) return { ok: false, reason: "incompatible", message: `sidebar tabs contract ${String(opened.found)} in this window, host speaks ${SIDEBAR_TABS_CONTRACT}` };
  const { registry } = opened;
  const generation = registry.nextGeneration++;
  registry.host = { generation, slots: new Map() };
  notify(registry);
  const current = () => registry.host?.generation === generation;
  return {
    generation,
    publish(slots) {
      if (!current()) return;
      const previous = registry.host!.slots;
      const next = new Map<string, ViewSlot>();
      let changed = previous.size !== slots.size;
      for (const [id, slot] of slots) {
        const old = previous.get(id);
        if (old && sameSlot(old, slot)) next.set(id, old);
        else { next.set(id, slot); changed = true; }
      }
      if (!changed) return;
      registry.host = { generation, slots: next };
      notify(registry);
    },
    dispose() {
      if (!current()) return;
      registry.host = null;
      notify(registry);
    },
  };
}

function sameSlot(a: ViewSlot, b: ViewSlot) {
  return a.generation === b.generation && a.element === b.element && a.props.activeThreadId === b.props.activeThreadId && a.props.activeProjectId === b.props.activeProjectId
    && a.props.isCompactViewport === b.props.isCompactViewport && a.props.isActive === b.props.isActive && a.props.onNavigate === b.props.onNavigate;
}

export function subscribe(listener: () => void, scope: Scope = globalScope()): () => void {
  const opened = openRegistry(scope);
  if (!opened.ok) return () => {};
  opened.registry.listeners.add(listener);
  return () => { opened.registry.listeners.delete(listener); };
}

export function revision(scope: Scope = globalScope()): number {
  const opened = openRegistry(scope);
  return opened.ok ? opened.registry.revision : -1;
}

/** Registered views in tab order. */
export function listViews(scope: Scope = globalScope()): ViewEntry[] {
  const opened = openRegistry(scope);
  if (!opened.ok) return [];
  return [...opened.registry.views.values()].sort((a, b) => (a.registration.order ?? 100) - (b.registration.order ?? 100)
    || a.registration.title.localeCompare(b.registration.title) || a.registration.id.localeCompare(b.registration.id));
}

/**
 * Where the view renders now; null while no host is attached, the host has not placed the view, or the slot was
 * placed for another generation (an older instance still mounted next to a newer one must not render twice).
 */
export function viewSlot(viewId: string, generation?: number, scope: Scope = globalScope()): ViewSlot | null {
  const opened = openRegistry(scope);
  const slot = opened.ok ? opened.registry.host?.slots.get(viewId) ?? null : null;
  return slot && (generation === undefined || slot.generation === generation) ? slot : null;
}
