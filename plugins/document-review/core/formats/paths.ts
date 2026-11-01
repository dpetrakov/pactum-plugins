// Key paths of structured files (W-06c): the forms people copy (dotted, JSON Pointer, jq), the identity form for hashing
// and the canonical string of a bbdr:keyPath selector. No dependencies: used by the host, the core and the viewer.

import { tr } from "../i18n.ts";

export type PathSegment = string | number | { doc: number };

const IDENT = /^[A-Za-z_$][\w$-]*$/;

/** Dotted path for people: services.api.env[2].value; documents of a multi-document YAML — «[document 2]» first. */
export function dottedPath(path: readonly PathSegment[], docWord: string = tr("document", "документ")): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "object") out += `[${docWord} ${segment.doc + 1}]`;
    else if (typeof segment === "number") out += `[${segment}]`;
    else if (IDENT.test(segment)) out += `${out ? "." : ""}${segment}`;
    else out += `[${JSON.stringify(segment)}]`;
  }
  return out;
}

/** JSON Pointer (RFC 6901); the document of a multi-document YAML is not expressible and is skipped. */
export function jsonPointer(path: readonly PathSegment[]): string {
  return path.filter((segment) => typeof segment !== "object").map((segment) => `/${String(segment).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

/** jq path: .services.api.env[2].value */
export function jqPath(path: readonly PathSegment[]): string {
  const out = path.filter((segment) => typeof segment !== "object").map((segment) => (typeof segment === "number" ? `[${segment}]` : IDENT.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`)).join("");
  return out || ".";
}

/** Identity form of a path for hashing: array indices become [] (an insertion does not change the others). */
export function identityPath(path: readonly PathSegment[]): string {
  return path.map((segment) => (typeof segment === "number" ? "[]" : typeof segment === "object" ? `#${segment.doc}` : JSON.stringify(segment))).join("/");
}

/** Canonical key path string stored in a bbdr:keyPath selector: JSON array of segments. */
export function keyPathString(path: readonly PathSegment[]): string {
  return JSON.stringify(path);
}

export function parseKeyPath(value: string): PathSegment[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    for (const segment of parsed) {
      const ok = typeof segment === "string" || (typeof segment === "number" && Number.isInteger(segment) && segment >= 0)
        || (segment !== null && typeof segment === "object" && Number.isInteger((segment as { doc?: unknown }).doc));
      if (!ok) return null;
    }
    return parsed as PathSegment[];
  } catch {
    return null;
  }
}
