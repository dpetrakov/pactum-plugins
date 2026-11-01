// Visualizers on this device (W-06f, EP-073-T03): the host's side of the docs visualizers contract — the registry of
// the window registry and device-local visualizer preference for priority order
// dispute, switched-off ids, ids the security audit switched off) and the choice of a visualizer for one object.
// localStorage only; never review data. A value of an unknown shape is ignored.
import { useSyncExternalStore } from "react";
import { attachHost, canvasSlot, claims, listVisualizers, matchVisualizers, revision, subscribe, type Candidate, type CanvasSlot, type HostHandle, type MatchContext, type VisualizerEntry } from "../visualizers-contract.ts";

const KEY = "bbdr:visualizers:v1";
export type VisualizerPrefs = {
  /** Ids in the user's order; a visualizer not listed comes after the listed ones (registration order). */
  order: string[];
  /** Switched off by the user. */
  disabled: string[];
  /** Switched off by the host's security audit until the user turns it on again: id → what was found. */
  blocked: Record<string, string>;
};

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
let cache: VisualizerPrefs | null = null;
const listeners = new Set<() => void>();

function read(): VisualizerPrefs {
  if (cache) return cache;
  const prefs: VisualizerPrefs = { order: [], disabled: [], blocked: {} };
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "{}") as Record<string, unknown>;
    const ids = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && ID.test(id)) : []);
    prefs.order = [...new Set(ids(raw.order))];
    prefs.disabled = [...new Set(ids(raw.disabled))];
    if (raw.blocked && typeof raw.blocked === "object") for (const [id, why] of Object.entries(raw.blocked as Record<string, unknown>)) if (ID.test(id) && typeof why === "string") prefs.blocked[id] = why.slice(0, 200);
  } catch { /* unknown shape: defaults */ }
  cache = prefs;
  return prefs;
}

function write(next: VisualizerPrefs) {
  cache = next;
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable: the choice lives until reload */ }
  for (const listener of listeners) listener();
}

export const visualizerPrefs = (): VisualizerPrefs => read();

export function setVisualizerEnabled(id: string, enabled: boolean) {
  const prefs = read();
  const disabled = prefs.disabled.filter((entry) => entry !== id);
  const blocked = { ...prefs.blocked };
  if (enabled) delete blocked[id]; else disabled.push(id);
  write({ ...prefs, disabled, blocked });
}

/** The security audit found something: the visualizer is off until the user turns it on again (concept §4). */
export function blockVisualizer(id: string, why: string) {
  const prefs = read();
  write({ ...prefs, blocked: { ...prefs.blocked, [id]: why } });
}

/** Move a visualizer one step up (earlier wins a dispute) or down in the user's order. */
export function moveVisualizer(id: string, delta: -1 | 1) {
  const order = orderedIds();
  const at = order.indexOf(id);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= order.length) return;
  order.splice(at, 1);
  order.splice(to, 0, id);
  write({ ...read(), order });
}

/** Every registered id in the effective order: the user's list first, then the rest by registration. */
export function orderedIds(): string[] {
  const registered = listVisualizers().map((entry) => entry.registration.id);
  const listed = read().order.filter((id) => registered.includes(id));
  return [...listed, ...registered.filter((id) => !listed.includes(id))];
}

export const isVisualizerOff = (id: string): boolean => { const prefs = read(); return prefs.disabled.includes(id) || id in prefs.blocked; };

/** Does any registered visualizer claim this context (even one switched off)? The object frame then owns the block. */
export function claimedBy(context: MatchContext): boolean {
  return listVisualizers().some((entry) => claims(entry.registration, context));
}

/** The visualizer that takes this object, or null — the host shows the code. */
export function pickVisualizer(source: string, context: MatchContext): Candidate | null {
  const prefs = read();
  const candidates = matchVisualizers(source, context, { preference: orderedIds(), disabled: [...prefs.disabled, ...Object.keys(prefs.blocked)] });
  return candidates[0] ?? null;
}

const snapshot = () => `${revision()}|${JSON.stringify(read())}`;
const subscribeAll = (listener: () => void) => {
  listeners.add(listener);
  const off = subscribe(listener);
  return () => { listeners.delete(listener); off(); };
};

/** Re-renders when a visualizer registers, leaves or the device preference changes. */
export function useVisualizersVersion(): string {
  return useSyncExternalStore(subscribeAll, snapshot, snapshot);
}

export function useVisualizers(): { entries: VisualizerEntry[]; prefs: VisualizerPrefs; order: string[] } {
  useVisualizersVersion();
  return { entries: listVisualizers(), prefs: read(), order: orderedIds() };
}

// ── the host of canvases ──────────────────────────────────────────────────────────────────────────────────────
// One host per window (the first mounted «Documents» page); it publishes a slot per object that is near the screen.
let host: HostHandle | null = null;
const slots = new Map<string, CanvasSlot>();

function ensureHost(): HostHandle | null {
  if (host) return host;
  const attached = attachHost();
  if ("publish" in attached) host = attached;
  return host;
}

/** Publish (or with `null` withdraw) the canvas of one object. */
export function publishCanvas(blockKey: string, slot: Omit<CanvasSlot, "generation"> | null) {
  const handle = ensureHost();
  if (!handle) return;
  if (slot) slots.set(blockKey, { ...slot, generation: handle.generation }); else slots.delete(blockKey);
  handle.publish(new Map(slots));
}

export const hostGeneration = (): number | null => ensureHost()?.generation ?? null;
export { canvasSlot };
