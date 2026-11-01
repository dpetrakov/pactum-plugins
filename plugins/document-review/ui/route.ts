// Route of the «Documents» screen: the checkout is always explicit (project environment, or machine + absolute
// path), never a default host (H4). subPath forms:
//   env/<environmentId>/<doc path segments>
//   host/<hostId>/<base64url(root)>/<doc path segments>
// An annotation to focus may follow the checkout part: …/~a/<annotationId>/<doc path segments> (published deep link,
// docs/plugins/document-review/architecture.md §13).

export type Target = { environmentId?: string; hostId?: string; path?: string };
export type Route =
  | { kind: "none" }
  | { kind: "env"; environmentId: string; doc: string | null; annotationId?: string | null }
  | { kind: "host"; hostId: string; root: string; doc: string | null; annotationId?: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Split an optional `~a/<annotationId>` prefix off the document segments. */
function withAnnotation(segments: string[]): { annotationId: string | null; rest: string[] } {
  if (segments[0] === "~a" && segments[1] && UUID.test(segments[1])) return { annotationId: segments[1], rest: segments.slice(2) };
  return { annotationId: null, rest: segments };
}

function b64url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(value: string): string | null {
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

function docOf(segments: string[]): string | null {
  if (!segments.length || segments.every((segment) => !segment)) return null;
  try {
    const parts = segments.map((segment) => decodeURIComponent(segment));
    // Only repo-relative paths: no empty, dot or dot-dot segments (the host re-checks confinement anyway).
    if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) return null;
    return parts.join("/");
  } catch {
    return null;
  }
}

export function parseRoute(subPath: string): Route {
  const segments = subPath.split("/");
  if (segments[0] === "env" && segments[1]) {
    const { annotationId, rest } = withAnnotation(segments.slice(2));
    return { kind: "env", environmentId: decodeURIComponent(segments[1]), doc: docOf(rest), ...(annotationId ? { annotationId } : {}) };
  }
  if (segments[0] === "host" && segments[1] && segments[2]) {
    const root = unb64url(segments[2]);
    const { annotationId, rest } = withAnnotation(segments.slice(3));
    if (root && root.startsWith("/")) return { kind: "host", hostId: decodeURIComponent(segments[1]), root, doc: docOf(rest), ...(annotationId ? { annotationId } : {}) };
  }
  return { kind: "none" };
}

const docPath = (doc: string | null) => (doc ? `/${doc.split("/").map(encodeURIComponent).join("/")}` : "");

export function subPathOf(route: Route): string {
  const annotation = route.kind !== "none" && route.annotationId ? `/~a/${route.annotationId}` : "";
  if (route.kind === "env") return `env/${encodeURIComponent(route.environmentId)}${annotation}${docPath(route.doc)}`;
  if (route.kind === "host") return `host/${encodeURIComponent(route.hostId)}/${b64url(route.root)}${annotation}${docPath(route.doc)}`;
  return "";
}

export function targetOf(route: Route): Target | null {
  if (route.kind === "env") return { environmentId: route.environmentId };
  if (route.kind === "host") return { hostId: route.hostId, path: route.root };
  return null;
}

/** Stable key of a checkout context: drafts and the last document are kept per context (A9). */
export function contextKey(route: Route): string {
  if (route.kind === "env") return `env:${route.environmentId}`;
  if (route.kind === "host") return `host:${route.hostId}:${route.root}`;
  return "none";
}

/** Resolve a relative Markdown link of a document to a repo path and heading anchor (B4). */
export function resolveLink(fromDoc: string, href: string): { doc: string | null; hash: string | null } | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null;
  const [pathPart, hash = null] = href.split("#", 2) as [string, string | undefined];
  if (!pathPart) return { doc: null, hash };
  const base = pathPart.startsWith("/") ? [] : fromDoc.split("/").slice(0, -1);
  for (const part of pathPart.replace(/^\//, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!base.length) return null;
      base.pop();
    } else base.push(decodeURIComponentSafe(part));
  }
  return { doc: base.join("/"), hash };
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** GitHub-style heading slug for `.md#heading` links. */
export function slug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}
