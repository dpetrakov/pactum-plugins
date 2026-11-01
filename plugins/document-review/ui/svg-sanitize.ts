// Sanitize static SVG with an allowlist rather than a denylist: only
// shapes, text, groups and defs with geometry attributes survive; scripts, foreign content, event handlers, external
// and `javascript:` references, inline styles with url() never reach the document. Pure DOM: works in the window only.

const TAGS = new Set(["svg", "g", "defs", "marker", "clipPath", "mask", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "title", "desc", "symbol", "use", "linearGradient", "radialGradient", "stop", "pattern"]);
const ATTRS = new Set(["id", "class", "viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "transform", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-opacity", "opacity", "font-size", "font-family", "font-weight", "font-style", "text-anchor", "dominant-baseline", "dx", "dy", "dominant-baseline", "letter-spacing", "clip-path", "mask", "marker-start", "marker-mid", "marker-end", "markerWidth", "markerHeight", "refX", "refY", "orient", "markerUnits", "viewBox", "preserveAspectRatio", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "patternUnits", "patternTransform", "href", "xlink:href", "clipPathUnits", "maskUnits", "aria-hidden", "role", "data-vis-id", "xmlns", "xmlns:xlink", "lang", "xml:space"]);
/** Attribute values that may reference something: only a fragment of this document. */
const REF_ATTRS = new Set(["href", "xlink:href", "clip-path", "mask", "marker-start", "marker-mid", "marker-end", "fill", "stroke"]);
const URL = /url\(\s*['"]?\s*([^'")\s]*)/i;

export type SanitizeResult = { svg: SVGSVGElement; removed: string[] };

function safeReference(name: string, value: string): boolean {
  const trimmed = value.trim();
  if (name === "href" || name === "xlink:href") return trimmed.startsWith("#") && !/[\s<>]/.test(trimmed);
  const match = URL.exec(trimmed);
  if (!match) return !/^(javascript|data|vbscript):/i.test(trimmed);
  return match[1].startsWith("#");
}

/**
 * Parse markup as SVG and keep only the allowlist. Returns the clean root and what was removed (for the audit log);
 * null when the markup is not an SVG document at all.
 */
export function sanitizeSvg(markup: string): SanitizeResult | null {
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = parsed.documentElement;
  if (!root || root.localName !== "svg" || parsed.querySelector("parsererror")) return null;
  const removed: string[] = [];
  const walk = (element: Element) => {
    for (const child of [...element.children]) {
      if (!TAGS.has(child.localName) || child.namespaceURI !== "http://www.w3.org/2000/svg") { removed.push(`<${child.localName}>`); child.remove(); continue; }
      walk(child);
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name;
      const ok = ATTRS.has(name) && !name.toLowerCase().startsWith("on") && (!REF_ATTRS.has(name) || safeReference(name, attribute.value));
      if (!ok) { removed.push(`${element.localName}@${name}`); element.removeAttribute(name); }
    }
  };
  walk(root);
  for (const attribute of [...root.attributes]) if (!ATTRS.has(attribute.name)) { removed.push(`svg@${attribute.name}`); root.removeAttribute(attribute.name); }
  return { svg: (document.importNode(root, true) as unknown) as SVGSVGElement, removed };
}

const BAD_NODES = "script, iframe, object, embed, link, meta, base, foreignObject, video, audio, frame, applet";
const BAD_REF = /^\s*(javascript|vbscript|data):/i;

/** Audit the rendered canvas subtree, remove forbidden content and report it. External use/image references and inline styles with external URLs are forbidden too. */
export function auditCanvas(root: Element): string[] {
  const found: string[] = [];
  for (const node of [...root.querySelectorAll(BAD_NODES)]) { found.push(`<${node.localName}>`); node.remove(); }
  for (const node of [...root.querySelectorAll("*")]) {
    if ((node.localName === "use" || node.localName === "image") && !(node.getAttribute("href") ?? node.getAttribute("xlink:href") ?? "#").trim().startsWith("#")) {
      found.push(`<${node.localName}> external`); node.remove(); continue;
    }
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      // A canvas may reference only fragments of this document: no scripts, no external resources, no links out.
      const reference = name === "href" || name === "xlink:href" || name === "src" || name === "action" || name === "formaction";
      const bad = name.startsWith("on") || name === "srcdoc"
        || (reference && (BAD_REF.test(value) || (value.trim() !== "" && !value.trim().startsWith("#"))))
        || (name === "style" && /url\(\s*['"]?\s*(?!#)/i.test(value));
      if (bad) { found.push(`${node.localName}@${name}`); node.removeAttribute(attribute.name); }
    }
  }
  return found;
}
