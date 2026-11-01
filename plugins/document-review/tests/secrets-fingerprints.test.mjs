// Element fingerprints in one pass (2026-10-16) give exactly the fingerprints of the former element-by-element scan
// — saved exemptions keep matching — and a large JSON array is classified in linear time.
import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../core/canonical-json.ts";
import { sha256 } from "../core/hash.ts";
import { elementFingerprints, exemptionKeyPath, looksExplicit } from "../core/formats/secrets.ts";
import { parseStructured } from "../core/formats/structured.ts";

/** The former implementation, verbatim, as the reference. */
function formerFingerprint(metas, arrayPath, index, isSecretPath) {
  const prefix = JSON.stringify([...arrayPath, index]).slice(0, -1);
  const pairs = [];
  for (const meta of metas) {
    if (!meta.path || meta.kind === undefined || meta.value === undefined) continue;
    const key = JSON.stringify(meta.path);
    if (!(key.startsWith(`${prefix},`) || key === `${prefix}]`)) continue;
    if (isSecretPath(meta.path) || looksExplicit(meta.value)) continue;
    pairs.push([JSON.stringify(meta.path.slice(arrayPath.length + 1)), meta.value]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(canonicalJson(pairs)).slice(0, 12);
}

const SAMPLES = [
  ["json", JSON.stringify({ users: [{ name: "a", token: "x1", tags: ["t", "u"] }, { name: "b", password: "p", nested: [[1, 2], [3]] }, { name: "a", token: "x2", tags: ["t", "u"] }], empty: [[], {}], keys: ["AKIAABCDEFGHIJKLMNOP", "plain"] }, null, 2)],
  ["yaml", "list:\n  - id: 1\n    secret: s\n    items: [a, b]\n  - id: 2\n    api_key: k\n    items: []\n  - &anc\n    id: 3\n---\nother:\n  - x\n  - ghp_abcdefghijklmnopqrstuvwxyz0123456789\n"],
  ["toml", "[[servers]]\nname = \"a\"\npassword = \"p\"\n[[servers]]\nname = \"b\"\nports = [1, 2]\n"],
];
const isSecretPath = (path) => path.some((segment) => typeof segment === "string" && /pass|secret|token|key/i.test(segment));

test("one-pass element fingerprints equal the former element-by-element ones", () => {
  for (const [format, source] of SAMPLES) {
    const parsed = parseStructured(format, source);
    assert.ok(parsed.ok, format);
    const metas = parsed.atoms.map((atom) => atom.meta ?? {});
    const prints = elementFingerprints(metas, isSecretPath);
    let compared = 0;
    for (const meta of metas) {
      if (!meta.path) continue;
      meta.path.forEach((segment, k) => {
        if (typeof segment !== "number") return;
        const arrayPath = meta.path.slice(0, k);
        const expected = formerFingerprint(metas, arrayPath, segment, isSecretPath);
        assert.equal(prints.get(`${JSON.stringify(arrayPath)}#${segment}`) ?? sha256(canonicalJson([])).slice(0, 12), expected, `${format} ${JSON.stringify(meta.path)}`);
        compared++;
      });
      // Exemption key paths built from the index are the former ones.
      const former = JSON.stringify(meta.path.map((segment, k) => (typeof segment === "number" ? { i: segment, fp: formerFingerprint(metas, meta.path.slice(0, k), segment, isSecretPath) } : segment)));
      assert.equal(exemptionKeyPath(metas, meta.path, isSecretPath, prints), former);
    }
    assert.ok(compared > 5, `${format}: elements compared`);
  }
});

test("a large JSON array is fingerprinted in linear time", () => {
  const rows = Array.from({ length: 20000 }, (_, i) => ({ sku: `4140-${i}`, name: `Запчасть ${i}`, price: i * 3.5, tags: ["a", "b"] }));
  const parsed = parseStructured("json", JSON.stringify({ items: rows }, null, 2));
  const metas = parsed.atoms.map((atom) => atom.meta ?? {});
  const started = Date.now();
  const prints = elementFingerprints(metas, isSecretPath);
  const elapsed = Date.now() - started;
  assert.equal(prints.size, 20000 + 40000, "every record and every tag");
  assert.ok(elapsed < 5000, `took ${elapsed} ms`);
});
