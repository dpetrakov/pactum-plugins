// Client logic of the W-04 catalog without a browser: the word diff merged into formatted inline tokens (F5 with
// formatting kept), the tree order with hidden entries, and the documents of a pass across the checkout (I2).
import assert from "node:assert/strict";
import test from "node:test";
import { blockDiff, project } from "../core/markdown/index.ts";
import { mergeDiff } from "../ui/diff-inline.ts";
import { passDocuments, treeOrder } from "../ui/tree-model.ts";

const strings = (tokens) => tokens.filter((token) => typeof token === "string").join("");

test("diff in the text keeps bold, links and code; strings still equal the current text", () => {
  const before = project("Было **важное** слово и [ссылка](https://a.example) в `коде` тут.\n").blocks[0];
  const after = project("Стало **очень важное** слово и [ссылка](https://a.example) в `коде` здесь.\n").blocks[0];
  const { words } = blockDiff(before.text, after.text);
  const merged = mergeDiff(after.fingerprint.inline, words);
  assert.ok(merged, "merge succeeded");
  assert.equal(strings(merged), after.text, "selection offsets are unchanged");
  // Insert a word inside the bold mark and delete the old words at their original positions.
  const strong = merged.findIndex((token) => token?.open === "strong");
  const close = merged.findIndex((token, index) => index > strong && token?.close === "strong");
  const inside = merged.slice(strong, close);
  assert.ok(inside.some((token) => token?.open === "ins"), "the insertion is inside the bold text");
  assert.ok(merged.some((token) => token?.open === "link"), "the link survives");
  assert.ok(merged.some((token) => token?.open === "code"), "inline code survives");
  const deleted = merged.filter((token) => typeof token?.deleted === "string").map((token) => token.deleted.trim()).filter(Boolean);
  assert.deepEqual(deleted.sort(), ["Было", "тут"].sort());
});

test("a diff that does not describe the tokens falls back (null), never a wrong merge", () => {
  assert.equal(mergeDiff(["abc"], [{ op: "equal", text: "abd" }]), null);
  assert.deepEqual(mergeDiff(["ab"], [{ op: "delete", text: "x" }, { op: "equal", text: "ab" }]), [{ deleted: "x" }, "ab"]);
});

const entry = (path, extra = {}) => ({ path, kind: "file", size: 1, supported: /\.md$/.test(path), note: null, hidden: false, hiddenFrom: null, untracked: false, untrackedFrom: null,
  docId: null, state: "read", unread: 0, open: 0, waiting: 0, candidates: 0, ...extra });
const tree = (entries, virtual = []) => ({ enabled: true, entries, virtual, moves: { applied: [], proposals: [] }, roots: ["docs"], missingRoots: [], suggestions: [], excluded: [], truncated: 0, pending: 0,
  totals: { waiting: 0, candidates: 0, unreadDocs: 0, unread: 0, changedDocs: 0, open: 0 } });

test("tree order: folders before files at each level; hidden only on request; unsupported files are not documents", () => {
  const t = tree([entry("docs/z.md"), entry("docs/a/b.md"), entry("docs/a/c.png"), entry("docs/h.md", { hidden: true })], [{ path: "docs/gone.md", docId: "d", reason: "missing", open: 1, waiting: 0, candidates: 0, hidden: false }]);
  assert.deepEqual(treeOrder(t), ["docs/a/b.md", "docs/z.md", "docs/gone.md"]);
  assert.deepEqual(treeOrder(t, true), ["docs/a/b.md", "docs/h.md", "docs/z.md", "docs/gone.md"]);
});

test("pass across documents: only documents with something for the mode, the current one always", () => {
  const t = tree([
    entry("docs/a.md", { state: "unread", unread: 2 }), entry("docs/b.md", { waiting: 1 }), entry("docs/c.md"), entry("docs/d.md", { state: "new" }),
  ], [{ path: "docs/gone.md", docId: "g", reason: "missing", open: 0, waiting: 0, candidates: 0, hidden: false }]);
  assert.deepEqual(passDocuments(t, "changes", "docs/c.md"), ["docs/a.md", "docs/c.md", "docs/d.md", "docs/gone.md"]);
  assert.deepEqual(passDocuments(t, "comments", null), ["docs/b.md"]);
  assert.deepEqual(passDocuments(t, "all", "docs/b.md"), ["docs/a.md", "docs/b.md", "docs/d.md", "docs/gone.md"]);
});
