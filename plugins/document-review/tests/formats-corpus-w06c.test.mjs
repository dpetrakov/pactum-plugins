// EP-040 acceptance: a corpus of edit sequences for every wave-1 format with known truth — no false exact/mapped
// anchor (W-02 rule), reordering object keys gives no change. Every value carries a unique token (`v17`), so the true
// counterpart of a node or line in the next version is the one with the same token; an edit records how tokens move.
import assert from "node:assert/strict";
import test from "node:test";
import { formatDiff, resolveFormatAnchor } from "../core/formats/anchor.ts";
import { keyPathString } from "../core/formats/assemble.ts";
import { sha256 } from "../core/hash.ts";
import { buildRevision, quoteAt } from "../core/markdown/index.ts";

let counter = 0;
const rid = () => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;
const DOC = "00000000-0000-4000-8000-00000000c0de";
const build = (file, source, parent) => ({ ...buildRevision({ revisionId: rid(), docId: DOC, path: file, source, snapshot: sha256(source), parents: parent ? [{ revision: parent.revision, source: parent.source, projection: parent.projection }] : [] }), source });

// ── a model object and its serializations ──
function model() {
  return { name: "v1", version: "v2", server: { host: "v3", port: "v4", tls: { cert: "v5", key_file: "v6" } }, env: [{ name: "v7", value: "v8" }, { name: "v9", value: "v10" }], tags: ["v11", "v12", "v13"] };
}
function toYaml(value, indent = "") {
  if (Array.isArray(value)) return value.map((item) => (item && typeof item === "object" ? `${indent}-\n${toYaml(item, `${indent}  `)}` : `${indent}- ${item}\n`)).join("");
  return Object.entries(value).map(([k, v]) => (v && typeof v === "object" ? `${indent}${k}:\n${toYaml(v, `${indent}  `)}` : `${indent}${k}: ${v}\n`)).join("");
}
function toToml(value) {
  let top = "";
  let tables = "";
  const walk = (obj, prefix) => {
    let own = "";
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v) && v.every((x) => x && typeof x === "object")) for (const item of v) { tables += `\n[[${[...prefix, k].join(".")}]]\n`; for (const [ik, iv] of Object.entries(item)) tables += `${ik} = "${iv}"\n`; }
      else if (Array.isArray(v)) own += `${k} = [${v.map((x) => `"${x}"`).join(", ")}]\n`;
      else if (v && typeof v === "object") { tables += `\n[${[...prefix, k].join(".")}]\n`; walk(v, [...prefix, k]); }
      else own += `${k} = "${v}"\n`;
    }
    if (prefix.length) tables += own; else top += own;
  };
  walk(value, []);
  return top + tables;
}
const SERIALIZE = { "c.json": (v) => JSON.stringify(v, null, 2), "c.yaml": (v) => toYaml(v), "c.toml": (v) => toToml(v) };

// Edits: [name, transform, token map (old → new | null deleted)]
const EDITS = [
  ["reorder keys", (m) => ({ tags: m.tags, env: m.env, server: { tls: m.server.tls, port: m.server.port, host: m.server.host }, version: m.version, name: m.name }), {}],
  ["insert at array start", (m) => ({ ...m, env: [{ name: "v20", value: "v21" }, ...m.env], tags: ["v22", ...m.tags] }), {}],
  ["rename a key", (m) => ({ ...m, server: { ...m.server, listen_port: m.server.port, port: undefined } }), {}],
  ["delete a key", (m) => ({ ...m, server: { ...m.server, tls: { cert: m.server.tls.cert } } }), { v6: null }],
  ["change a value", (m) => ({ ...m, server: { ...m.server, host: "v30" } }), { v3: "v30" }],
  ["delete an array element", (m) => ({ ...m, env: [m.env[1]], tags: [m.tags[0], m.tags[2]] }), { v7: null, v8: null, v12: null }],
];
const clean = (value) => JSON.parse(JSON.stringify(value));
const tokenOf = (text) => /v\d+/.exec(text)?.[0] ?? null;

function audit(file, a, b, map, label) {
  const problems = [];
  a.projection.blocks.forEach((block, index) => {
    if (block.type !== "node" && block.type !== "line") return;
    const token = tokenOf(block.text);
    if (!token) return;
    const expected = token in map ? map[token] : token;
    const target = { revision: a.revision, projection: a.projection, range: block.range, quote: quoteAt(a.projection, block.range) };
    const path = a.projection.meta?.[index]?.path;
    if (path) target.keyPath = keyPathString(path);
    const resolved = resolveFormatAnchor(target, b);
    if (resolved.status === "exact") problems.push(`${label} ${token}: exact on another revision`);
    if (resolved.status === "mapped") {
      // The block that holds the mapped range (a quote may map onto part of an edited block — the same node).
      const holder = b.projection.blocks.find((candidate) => candidate.range.start <= resolved.ranges[0].start && resolved.ranges[0].end <= candidate.range.end);
      const text = holder ? holder.text : [...b.projection.text].slice(resolved.ranges[0].start, resolved.ranges[0].end).join("");
      const got = tokenOf(text);
      if (expected === null) problems.push(`${label} ${token}: mapped although deleted (→ «${text}»)`);
      else if (got !== expected) problems.push(`${label} ${token}: false mapped to «${text}» (expected ${expected})`);
    }
  });
  return problems;
}

test("corpus: structured formats — no false exact/mapped over reorder, insertion, rename, deletion, value change; reorder is no change", () => {
  const problems = [];
  let mappedCount = 0;
  for (const [file, serialize] of Object.entries(SERIALIZE)) {
    const base = model();
    const a = build(file, serialize(base));
    assert.equal(a.projection.parseError, null, `${file} parses`);
    for (const [name, transform, map] of EDITS) {
      const b = build(file, serialize(clean(transform(base))), a);
      assert.equal(b.projection.parseError, null, `${file} ${name} parses`);
      problems.push(...audit(file, a, b, map, `${file} ${name}:`));
      for (const block of a.projection.blocks) {
        const token = tokenOf(block.text);
        if (token && !(token in map)) {
          const resolved = resolveFormatAnchor({ revision: a.revision, projection: a.projection, range: block.range, quote: quoteAt(a.projection, block.range) }, b);
          if (resolved.status === "mapped") mappedCount++;
        }
      }
      if (name === "reorder keys" && file !== "c.toml") assert.deepEqual(formatDiff(a, b).filter((change) => change.kinds.some((kind) => kind !== "moved" || typeof b.projection.meta[change.current]?.path?.at(-1) === "string")), [], `${file}: reordering keys is no change`);
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(mappedCount > 100, `anchors follow their nodes (${mappedCount} mapped)`);
});

test("corpus: line formats (.env, CSV, text) — no false exact/mapped over insertion, deletion, edit and move of lines", () => {
  const files = {
    ".env": (rows) => rows.map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
    "d.csv": (rows) => ["key,value", ...rows.map(([k, v]) => `${k},${v}`)].join("\n") + "\n",
    "t.txt": (rows) => rows.map(([k, v]) => `${k} — заметка ${v}`).join("\n") + "\n",
  };
  const base = Array.from({ length: 12 }, (_, i) => [`KEY_${i}`, `v${i + 1}`]);
  const edits = [
    ["insert at start", (rows) => [["KEY_NEW", "v50"], ...rows], {}],
    ["delete a line", (rows) => rows.filter((_, i) => i !== 4), { v5: null }],
    ["edit a line", (rows) => rows.map((row, i) => (i === 6 ? [row[0], "v60"] : row)), { v7: "v60" }],
    ["move a line", (rows) => [...rows.slice(1, 8), rows[0], ...rows.slice(8)], {}],
  ];
  const problems = [];
  for (const [file, serialize] of Object.entries(files)) {
    const a = build(file, serialize(base));
    for (const [name, transform, map] of edits) problems.push(...audit(file, a, build(file, serialize(transform(base)), a), map, `${file} ${name}:`));
  }
  assert.deepEqual(problems, []);
});
