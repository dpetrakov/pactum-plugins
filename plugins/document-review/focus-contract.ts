// Shared focus contract v1: one organization or bb project filters participating plugins.
//
// Store one object per window under Symbol.for("bb-workbench.focus"). The provider
// is the deploy-ops app overlay, backed by its own organization/project state;
// other plugins consume this optional integration. Keep the contract copy compatible with
// sessions, plan-board and document-review. Change the source contract and copy it
// verbatim to consumers.
import { useSyncExternalStore } from "react";

export const FOCUS_CONTRACT = 1;
const KEY = Symbol.for("bb-workbench.focus");

/** What the focus is on: an organization of the project catalog or one bb project (`proj_…`). */
export type FocusTarget = { kind: "org"; id: string } | { kind: "project"; id: string };
/**
 * Organizations, bb projects with their organization and deploy-ops project keys, and every deploy-ops project card
 * (also those not linked to bb: candidates, VPS placements) with its organization and bb project.
 */
export type FocusDirectory = {
  orgs: { id: string; name: string }[];
  projects: { id: string; name: string; org: string | null; keys: string[] }[];
  cards: { key: string; org: string | null; projectId: string | null }[];
};

type Store = {
  contract: number;
  focus: FocusTarget | null;
  directory: FocusDirectory | null;
  /** A provider (deploy-ops) is mounted: without it the focus can be neither read nor changed. */
  provided: boolean;
  setter: ((next: FocusTarget | null) => Promise<void>) | null;
  listeners: Set<() => void>;
  snapshot: FocusSnapshot | null;
};

export type FocusSnapshot = {
  focus: FocusTarget | null;
  directory: FocusDirectory | null;
  provided: boolean;
  /** The focus as people read it: «example-project», «review-workspace»; null without focus or before the directory. */
  label: string | null;
  /** bb project ids in focus; null — no focus (everything is shown) or the directory is not known yet. */
  projectIds: ReadonlySet<string> | null;
  /** deploy-ops project keys in focus; null as above. */
  keys: ReadonlySet<string> | null;
};

function store(): Store {
  const scope = globalThis as unknown as Record<symbol, Store | undefined>;
  let current = scope[KEY];
  if (!current || current.contract !== FOCUS_CONTRACT) {
    current = { contract: FOCUS_CONTRACT, focus: null, directory: null, provided: false, setter: null, listeners: current?.listeners ?? new Set(), snapshot: null };
    scope[KEY] = current;
  }
  return current;
}

/** Pure: who is in focus. */
export function focusProjects(focus: FocusTarget | null, directory: FocusDirectory | null): FocusDirectory["projects"] | null {
  if (!focus || !directory) return null;
  return focus.kind === "org"
    ? directory.projects.filter((project) => project.org === focus.id)
    : directory.projects.filter((project) => project.id === focus.id);
}

/** Pure: deploy-ops project keys in focus — cards of the organization, or the cards linked to the bb project. */
export function focusKeys(focus: FocusTarget | null, directory: FocusDirectory | null): string[] | null {
  if (!focus || !directory) return null;
  if (focus.kind === "org") return directory.cards.filter((card) => card.org === focus.id).map((card) => card.key);
  const linked = directory.projects.find((project) => project.id === focus.id)?.keys ?? [];
  return [...new Set([...linked, ...directory.cards.filter((card) => card.projectId === focus.id).map((card) => card.key)])];
}

export function focusLabel(focus: FocusTarget | null, directory: FocusDirectory | null): string | null {
  if (!focus || !directory) return null;
  return focus.kind === "org"
    ? directory.orgs.find((org) => org.id === focus.id)?.name ?? focus.id
    : directory.projects.find((project) => project.id === focus.id)?.name ?? focus.id;
}

/** True when nothing is focused, or the bb project is in focus. */
export function inFocus(snapshot: Pick<FocusSnapshot, "projectIds">, projectId: string | null | undefined): boolean {
  return !snapshot.projectIds || (!!projectId && snapshot.projectIds.has(projectId));
}

export function focusSnapshot(): FocusSnapshot {
  const current = store();
  if (!current.snapshot) {
    const projects = focusProjects(current.focus, current.directory);
    current.snapshot = {
      focus: current.focus, directory: current.directory, provided: current.provided,
      label: focusLabel(current.focus, current.directory),
      projectIds: projects ? new Set(projects.map((project) => project.id)) : null,
      keys: projects ? new Set(focusKeys(current.focus, current.directory)) : null,
    };
  }
  return current.snapshot;
}

export function subscribeFocus(listener: () => void): () => void {
  const current = store();
  current.listeners.add(listener);
  return () => { current.listeners.delete(listener); };
}

function changed(current: Store) {
  current.snapshot = null;
  for (const listener of [...current.listeners]) listener();
}

/** Provider side: what the server says now. */
export function publishFocus(state: { focus?: FocusTarget | null; directory?: FocusDirectory | null }): void {
  const current = store();
  if ("focus" in state) current.focus = state.focus ?? null;
  if ("directory" in state) current.directory = state.directory ?? null;
  changed(current);
}

/** Provider side: how a change is written; returns the disposer for unmount. */
export function provideFocus(setter: (next: FocusTarget | null) => Promise<void>): () => void {
  const current = store();
  current.setter = setter;
  current.provided = true;
  changed(current);
  return () => {
    if (current.setter !== setter) return;
    current.setter = null;
    current.provided = false;
    changed(current);
  };
}

/** Any plugin: change the focus (the provider writes it and handles failures); without a provider — nothing. */
export async function setFocus(next: FocusTarget | null): Promise<void> {
  const setter = store().setter;
  if (setter) await setter(next);
}

/** React: the focus of this window, re-rendering on every change. */
export function useWorkbenchFocus(): FocusSnapshot {
  return useSyncExternalStore(subscribeFocus, focusSnapshot, focusSnapshot);
}
