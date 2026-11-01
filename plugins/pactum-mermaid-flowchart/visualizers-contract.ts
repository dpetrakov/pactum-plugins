/**
 * Docs visualizers contract v1 — how «Documents» (the host) and the plugins that draw embedded objects (visualizers)
 * meet inside one app window (W-06f, EP-073; docs/plugins/document-review/visualizers-contract.md).
 *
 * Every visualizer bundles a verbatim copy of this file (the host's tests compare the copies in this repository); the
 * shared object it manages, `globalThis[Symbol.for("bb-workbench.docs-visualizers")]`, is the contract. A window is one
 * JS realm, so registrations and canvases never leak between windows. No React, no DOM access and no imports here: a
 * visualizer renders its own canvas, with its own plugin context and CSS scope, into the element the host publishes.
 */

export const VISUALIZERS_CONTRACT = 1 as const;
export const REGISTRY_KEY = Symbol.for("bb-workbench.docs-visualizers");

/** Where the source comes from: a fenced block of a document or a whole file of the review tree. */
export interface MatchContext {
  kind: "fence" | "file";
  /** Fence language in lower case; null for a whole file. */
  language: string | null;
  /** Repo-relative path of the document or file. */
  path: string;
}

/** A visualizer's answer to «is this yours?»: the dialect it recognised and how sure it is. */
export interface Match {
  dialect: string;
  /** 0 — «any code of this language», 10 — by the header, 20 — by a full check. */
  specificity: number;
}

export type ElementKind = "node" | "edge" | "group" | "text" | "other";
export type Point = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };
export type SourceRange = { line: number; start: number; end: number };

export type ParseFailure =
  | { reason: "syntax"; line: number; message: string }
  | { reason: "unsupported" | "too-large" | "empty"; message: string };

/** What changed in the object between two sources (only the file, never personal positions). */
export interface ObjectDiff {
  items: { id: string; kind: ElementKind; label: string; change: "added" | "removed" | "changed"; fields?: string[]; before?: string }[];
  /** 0 — the model did not change (the edit is in the source's spelling only). */
  total: number;
}

/** One line of the hidden list for screen readers. */
export interface A11yItem {
  id: string;
  kind: ElementKind;
  label: string;
  detail?: string;
}

/** Geometry and words of every element at zoom 1: the host draws annotation markers, ghosts and focus from it. */
export type ElementInfo = Box & { kind: ElementKind; label: string; range?: SourceRange };

export interface CanvasReport {
  /** Natural size of the canvas in CSS px at zoom 1. */
  size: { w: number; h: number };
  elements: Record<string, ElementInfo>;
  /** Which ids were applied from `positions`. */
  pinned: string[];
  overlaps?: [string, string][];
  /** Edges drawn without a route around obstacles (dashed). */
  fallbacks?: string[];
  /** Source the visualizer did not apply (styles, clicks, directives). */
  warnings?: { line: number; message: string }[];
}

export interface CanvasProps {
  /** The exact source of the object: the fence body or the whole file. */
  source: string;
  context: MatchContext & { dialect: string };
  /** For measurements only; colours come from inherited tokens. */
  theme: "light" | "dark";
  /** 1 — natural size; the host scales the element itself. */
  zoom: number;
  /** «Layout» is on: the canvas takes gestures. */
  moving: boolean;
  /** Gestures are not accepted (the host shows why). */
  readOnly: boolean;
  /** The reader's pins by element id (format 1.3) plus the host's draft during a write. */
  positions: Record<string, Point>;
  selected: string | null;
  /** «Changes» are shown: the base source (ghosts of removed elements) and the marks — file changes only. */
  compare: { base: string | null; marks: Record<string, "added" | "changed" | "removed"> } | null;
  /** The owner's annotations by element id. */
  annotations: Record<string, { count: number; waiting: boolean }>;
  reducedMotion: boolean;
}

export interface CanvasActions {
  /** A finished gesture: pins and/or ids reset to the automatic layout. Once per gesture, never per pointer move. */
  commit(positions: Record<string, Point>, reset?: string[]): void;
  select(id: string | null): void;
  /** After every layout. */
  report(state: CanvasReport): void;
  /** The source does not build: the host shows the code and the reason. */
  fail(failure: ParseFailure): void;
}

/** A canvas the host published for one object; a visualizer renders only into a slot of its own generation. */
export interface CanvasSlot {
  generation: number;
  /** The host's stable key of the object (doc + lineage), without the source. */
  blockKey: string;
  element: HTMLElement;
  props: CanvasProps;
  actions: CanvasActions;
}

export interface CanvasHandle {
  update(slot: CanvasSlot): void;
  dispose(): void;
}

export interface StaticRender {
  /** SVG markup; elements carry `data-vis-id`. The host sanitises it before inserting. */
  svg: string;
  size: { w: number; h: number };
  elements: Record<string, ElementInfo>;
}

export interface VisualizerRegistration {
  contract: typeof VISUALIZERS_CONTRACT;
  /** The plugin id: lower-case letters, digits, `-` and `_`; repository convention `pactum-<type>[-<dialect>]`. */
  id: string;
  /** Plugin version; recorded in the `engine` of layout writes. */
  version: string;
  /** Type label in the object's bar: «Mermaid · flowchart». */
  title: string;
  /** Lucide icon name; the host draws `workflow` without it. */
  icon?: string;
  claims: { languages?: readonly string[]; extensions?: readonly string[] };
  canvas: "interactive" | "static";
  capabilities: {
    /** Moves elements and applies `positions`. */
    layout: boolean;
    /** Draws removed elements as ghosts where they stood (from `compare.base`). */
    ghosts: boolean;
  };
  /** Own limits; the host checks `bytes` before any call. */
  limits?: { bytes?: number; items?: number };
  /** Layout engine id: "dagre-3.1.1+route-1". */
  engine: string;
  match(source: string, context: MatchContext): Match | null;
  /** The host requires diff and a11y for a marketplace visualizer. Without them registration succeeds but only source code is displayed with an explanatory notice. */
  diff?(base: string, source: string, context: MatchContext): ObjectDiff | { unsupported: string };
  a11y?(source: string, context: MatchContext): A11yItem[];
  /** `canvas: "static"` only. */
  render?(source: string, context: MatchContext, signal: AbortSignal): Promise<StaticRender | ParseFailure>;
  /** `canvas: "interactive"` only. */
  mount?(slot: CanvasSlot): CanvasHandle;
}

export interface VisualizerEntry {
  registration: VisualizerRegistration;
  generation: number;
  /** `complete` — diff and a11y are there; `missing` names what is not. */
  status: { complete: boolean; missing: string[] };
}

export interface HostEntry {
  generation: number;
  slots: ReadonlyMap<string, CanvasSlot>;
}

export interface Registry {
  contract: typeof VISUALIZERS_CONTRACT;
  /** Bumped on every change; a cheap snapshot for subscribers. */
  revision: number;
  nextGeneration: number;
  visualizers: Map<string, VisualizerEntry>;
  host: HostEntry | null;
  listeners: Set<() => void>;
}

export type RegistryResult = { ok: true; registry: Registry } | { ok: false; reason: "incompatible"; found: unknown };

export type RegisterResult =
  | { ok: true; generation: number; dispose(): void }
  | { ok: false; reason: "incompatible" | "version" | "invalid"; message: string };

export interface HostHandle {
  generation: number;
  /** Replace the published canvases; unchanged slots keep their identity, so subscribers re-render only on real change. */
  publish(slots: ReadonlyMap<string, CanvasSlot>): void;
  dispose(): void;
}

const PLUGIN_ID = /^[a-z0-9][a-z0-9_-]*$/;

type Scope = Record<symbol, unknown>;
const globalScope = () => globalThis as unknown as Scope;

/** The window's registry, created on first use. A registry of another contract major is left alone and reported. */
export function openRegistry(scope: Scope = globalScope()): RegistryResult {
  const found = scope[REGISTRY_KEY];
  if (found === undefined) {
    const registry: Registry = { contract: VISUALIZERS_CONTRACT, revision: 0, nextGeneration: 1, visualizers: new Map(), host: null, listeners: new Set() };
    scope[REGISTRY_KEY] = registry;
    return { ok: true, registry };
  }
  if (typeof found === "object" && found !== null && (found as { contract?: unknown }).contract === VISUALIZERS_CONTRACT) return { ok: true, registry: found as Registry };
  return { ok: false, reason: "incompatible", found: (found as { contract?: unknown } | null)?.contract };
}

function notify(registry: Registry) {
  registry.revision += 1;
  for (const listener of [...registry.listeners]) {
    // One participant's listener must not stop the others from hearing the change.
    try { listener(); } catch (error) { console.error("[docs-visualizers] listener failed", error); }
  }
}

const words = (list: readonly unknown[] | undefined, fix: (word: string) => string): string[] =>
  [...new Set((list ?? []).filter((word): word is string => typeof word === "string").map((word) => fix(word.trim().toLowerCase())).filter(Boolean))];

function invalid(registration: VisualizerRegistration): string | null {
  if (!PLUGIN_ID.test(registration.id)) return `invalid visualizer id ${JSON.stringify(registration.id)}`;
  if (typeof registration.version !== "string" || !registration.version.trim()) return `visualizer ${registration.id} has no version`;
  if (typeof registration.title !== "string" || !registration.title.trim()) return `visualizer ${registration.id} has no title`;
  if (typeof registration.engine !== "string" || !registration.engine.trim()) return `visualizer ${registration.id} has no engine`;
  if (registration.canvas !== "interactive" && registration.canvas !== "static") return `visualizer ${registration.id}: canvas must be interactive or static`;
  if (typeof registration.match !== "function") return `visualizer ${registration.id} has no match()`;
  if (registration.canvas === "interactive" && typeof registration.mount !== "function") return `interactive visualizer ${registration.id} has no mount()`;
  if (registration.canvas === "static" && typeof registration.render !== "function") return `static visualizer ${registration.id} has no render()`;
  if (!registration.claims || typeof registration.claims !== "object") return `visualizer ${registration.id} has no claims`;
  return null;
}

/**
 * Register a visualizer. A newer registration of the same id (a reload) replaces the older one; the older disposer
 * then does nothing. Claims are normalised: languages lower-cased, extensions lower-cased with a leading dot.
 */
export function registerVisualizer(registration: VisualizerRegistration, scope: Scope = globalScope()): RegisterResult {
  const opened = openRegistry(scope);
  if (!opened.ok) return { ok: false, reason: "incompatible", message: `docs visualizers contract ${String(opened.found)} in this window, visualizer speaks ${VISUALIZERS_CONTRACT}` };
  const { registry } = opened;
  if (registration.contract !== VISUALIZERS_CONTRACT) return { ok: false, reason: "version", message: `visualizer ${String(registration?.id)} speaks contract ${String(registration?.contract)}, host speaks ${VISUALIZERS_CONTRACT}` };
  const problem = invalid(registration);
  if (problem) return { ok: false, reason: "invalid", message: problem };
  const languages = words(registration.claims.languages, (word) => word);
  const extensions = words(registration.claims.extensions, (word) => (word.startsWith(".") ? word : `.${word}`));
  if (!languages.length && !extensions.length) return { ok: false, reason: "invalid", message: `visualizer ${registration.id} claims nothing` };
  const generation = registry.nextGeneration++;
  const { icon, limits, ...rest } = registration;
  const stored: VisualizerRegistration = { ...rest, claims: { languages, extensions }, title: registration.title.trim(), version: registration.version.trim(), engine: registration.engine.trim() };
  if (typeof icon === "string" && icon.trim()) stored.icon = icon.trim();
  if (limits && typeof limits === "object") stored.limits = limits;
  const missing = [typeof registration.diff === "function" ? null : "diff", typeof registration.a11y === "function" ? null : "a11y"].filter((name): name is string => name !== null);
  registry.visualizers.set(registration.id, { registration: stored, generation, status: { complete: missing.length === 0, missing } });
  notify(registry);
  return {
    ok: true,
    generation,
    dispose() {
      if (registry.visualizers.get(registration.id)?.generation !== generation) return;
      registry.visualizers.delete(registration.id);
      notify(registry);
    },
  };
}

/** Attach the window's host. A newer host replaces an older one; the older handle then does nothing. */
export function attachHost(scope: Scope = globalScope()): HostHandle | { ok: false; reason: "incompatible"; message: string } {
  const opened = openRegistry(scope);
  if (!opened.ok) return { ok: false, reason: "incompatible", message: `docs visualizers contract ${String(opened.found)} in this window, host speaks ${VISUALIZERS_CONTRACT}` };
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
      const next = new Map<string, CanvasSlot>();
      let changed = previous.size !== slots.size;
      for (const [key, slot] of slots) {
        const old = previous.get(key);
        if (old && sameSlot(old, slot)) next.set(key, old);
        else { next.set(key, slot); changed = true; }
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

const PROP_KEYS: (keyof CanvasProps)[] = ["source", "context", "theme", "zoom", "moving", "readOnly", "positions", "selected", "compare", "annotations", "reducedMotion"];

function sameSlot(a: CanvasSlot, b: CanvasSlot) {
  return a.generation === b.generation && a.blockKey === b.blockKey && a.element === b.element && a.actions === b.actions
    && PROP_KEYS.every((key) => a.props[key] === b.props[key]);
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

/** Registered visualizers in registration order. */
export function listVisualizers(scope: Scope = globalScope()): VisualizerEntry[] {
  const opened = openRegistry(scope);
  if (!opened.ok) return [];
  return [...opened.registry.visualizers.values()].sort((a, b) => a.generation - b.generation);
}

/**
 * The canvas published for an object; null while no host is attached, the host has not placed the object, or the
 * slot was placed for another generation (an older instance still mounted next to a newer one must not render twice).
 */
export function canvasSlot(blockKey: string, generation?: number, scope: Scope = globalScope()): CanvasSlot | null {
  const opened = openRegistry(scope);
  const slot = opened.ok ? opened.registry.host?.slots.get(blockKey) ?? null : null;
  return slot && (generation === undefined || slot.generation === generation) ? slot : null;
}

/** Does the registration claim this context (before asking `match`)? */
export function claims(registration: VisualizerRegistration, context: MatchContext): boolean {
  if (context.kind === "fence") return context.language !== null && (registration.claims.languages ?? []).includes(context.language.toLowerCase());
  const dot = context.path.lastIndexOf(".");
  const extension = dot >= 0 ? context.path.slice(dot).toLowerCase() : "";
  return extension !== "" && (registration.claims.extensions ?? []).includes(extension);
}

export interface Candidate { entry: VisualizerEntry; match: Match }

/**
 * The visualizers that take an object, best first: highest `specificity`, then the user's order (`preference` — ids,
 * earlier wins), then registration order. Ids in `disabled` are not asked. A `match` that throws is skipped with a
 * warning — one plugin's bug must not hide the others.
 */
export function matchVisualizers(source: string, context: MatchContext, options: { preference?: readonly string[]; disabled?: readonly string[]; scope?: Scope } = {}): Candidate[] {
  const disabled = new Set(options.disabled ?? []);
  const preference = options.preference ?? [];
  const rank = (id: string) => { const at = preference.indexOf(id); return at < 0 ? preference.length : at; };
  const out: Candidate[] = [];
  for (const entry of listVisualizers(options.scope)) {
    const { registration } = entry;
    if (disabled.has(registration.id) || !claims(registration, context)) continue;
    let match: Match | null = null;
    try { match = registration.match(source, context); } catch (error) { console.warn(`[docs-visualizers] ${registration.id}.match failed`, error); continue; }
    if (!match || typeof match.dialect !== "string" || !Number.isFinite(match.specificity)) continue;
    out.push({ entry, match });
  }
  return out.sort((a, b) => b.match.specificity - a.match.specificity || rank(a.entry.registration.id) - rank(b.entry.registration.id) || a.entry.generation - b.entry.generation);
}
