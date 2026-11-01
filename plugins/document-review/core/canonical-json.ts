// Deterministic serialization: sorted keys, two-space indent, LF, trailing newline, no non-integer numbers.
// The same value always gives the same bytes, so content hashes of objects are stable across machines.

export class CanonicalJsonError extends Error {}

function check(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new CanonicalJsonError(`${path}: only safe integers are allowed, got ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => check(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new CanonicalJsonError(`${path}: plain objects only`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) throw new CanonicalJsonError(`${path}.${key}: undefined is not serializable`);
      check(item, `${path}.${key}`);
    }
    return;
  }
  throw new CanonicalJsonError(`${path}: ${typeof value} is not serializable`);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    return sorted;
  }
  return value;
}

/** Canonical text of a JSON value. Keys are sorted by UTF-16 code units, the same order as Array.prototype.sort. */
export function canonicalJson(value: unknown): string {
  check(value, "$");
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

const encoder = new TextEncoder();

export function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalJson(value));
}

/** True when bytes are exactly the canonical serialization of what they parse to. */
export function isCanonical(text: string): boolean {
  try {
    return canonicalJson(JSON.parse(text)) === text;
  } catch {
    return false;
  }
}
