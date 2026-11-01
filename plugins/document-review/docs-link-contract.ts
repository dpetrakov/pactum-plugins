/** Documents link contract v1. Other plugins open a specific checkout without hardcoding viewer routes. The Documents app overlay publishes open() once per window and navigates through useBbNavigate().toPluginPanel. Callers bundle a verbatim contract copy and use the shared bb-workbench.document-review.link symbol. If absent, show Documents unavailable rather than a broken link. */

export const DOCS_LINK_CONTRACT = 1 as const;
export const DOCS_LINK_KEY = Symbol.for("bb-workbench.document-review.link");

/** A checkout is explicit: a bb environment, or a machine and an absolute checkout path. Never a default machine. */
export type DocsTarget =
  | { environmentId: string; doc?: string | null; annotationId?: string | null }
  | { hostId: string; path: string; doc?: string | null; annotationId?: string | null };

export interface DocsLink {
  contract: typeof DOCS_LINK_CONTRACT;
  /** Open the viewer at the checkout (and document, annotation); false when the target is malformed. */
  open(target: DocsTarget): boolean;
}

interface Slot {
  contract: typeof DOCS_LINK_CONTRACT;
  link: DocsLink | null;
  revision: number;
  listeners: Set<() => void>;
}

type Scope = Record<symbol, unknown>;
const globalScope = () => globalThis as unknown as Scope;

function slot(scope: Scope): Slot | null {
  const found = scope[DOCS_LINK_KEY];
  if (found === undefined) {
    const created: Slot = { contract: DOCS_LINK_CONTRACT, link: null, revision: 0, listeners: new Set() };
    scope[DOCS_LINK_KEY] = created;
    return created;
  }
  return typeof found === "object" && found !== null && (found as { contract?: unknown }).contract === DOCS_LINK_CONTRACT ? (found as Slot) : null;
}

function changed(current: Slot) {
  current.revision += 1;
  for (const listener of [...current.listeners]) {
    try { listener(); } catch (error) { console.error("[docs-link] listener failed", error); }
  }
}

/** Provider side: publish the opener; the returned disposer withdraws it only if it is still this one. */
export function provideDocsLink(link: DocsLink, scope: Scope = globalScope()): () => void {
  const current = slot(scope);
  if (!current) return () => {};
  current.link = link;
  changed(current);
  return () => {
    if (current.link !== link) return;
    current.link = null;
    changed(current);
  };
}

/** Caller side: the opener, or null while «Documents» is not installed, disabled or of another contract version. */
export function docsLink(scope: Scope = globalScope()): DocsLink | null {
  return slot(scope)?.link ?? null;
}

export function subscribeDocsLink(listener: () => void, scope: Scope = globalScope()): () => void {
  const current = slot(scope);
  if (!current) return () => {};
  current.listeners.add(listener);
  return () => { current.listeners.delete(listener); };
}

export function docsLinkRevision(scope: Scope = globalScope()): number {
  return slot(scope)?.revision ?? -1;
}
