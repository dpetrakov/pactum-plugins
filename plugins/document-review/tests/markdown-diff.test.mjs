import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../core/canonical-json.ts";
import { blockDiff, project, rawDiff, REWRITE_THRESHOLD, semanticDiff, splitPortions } from "../core/markdown/index.ts";
import { buildChain, loadSequence, revise, select, withSource } from "./markdown-helpers.mjs";

const chainOf = (name) => buildChain(loadSequence(name));
const summary = (changes) => changes.map((c) => [c.kinds.join("+"), (c.after ?? c.before).text.slice(0, 24)]);

test("F4 change kinds: added, edited, moved, removed; moved and edited combine; removal keeps text and nearest place", () => {
  const { chain } = chainOf("section-move");
  const bc = semanticDiff(chain.b, chain.c);
  const movedEdited = bc.find((c) => c.after?.text.startsWith("Укажите"));
  assert.deepEqual(movedEdited.kinds, ["edited", "moved"]);
  assert.equal(movedEdited.before.text, "Укажите адрес сервера и порт подключения.");
  assert.equal(movedEdited.before.section, "Настройка", "the former section is named");
  assert.ok(movedEdited.words.some((w) => w.op === "insert" && w.text.includes("имя пользователя")));
  const ab = semanticDiff(chain.a, chain.b);
  assert.deepEqual(ab.map((c) => c.kinds), [["moved"], ["moved"], ["moved"]], "the moved section, nothing else");
  assert.equal(ab[0].before.section, "Руководство");

  const removal = chainOf("rename-delete").chain;
  const removed = semanticDiff(removal.b, removal.c);
  assert.deepEqual(summary(removed), [["removed", "Риски"], ["removed", "Нагрузка на базу данных "]]);
  for (const r of removed) {
    assert.equal(r.current, null);
    assert.equal(r.after, null);
    assert.equal(r.place.afterLineageId, removal.c.revision.blocks[select(removal.c.projection, "Время простоя")].lineageId);
    assert.equal(r.place.beforeLineageId, removal.c.revision.blocks[select(removal.c.projection, "Следующие")].lineageId);
  }
  assert.equal(removed[1].before.section, "Риски");

  const revert = chainOf("revert").chain;
  const ab2 = semanticDiff(revert.a, revert.b);
  assert.deepEqual(summary(ab2), [["edited", "Пароли хранятся только в"], ["edited", "Сессии истекают через пя"], ["added", "Новый абзац про двухфакт"]]);
  assert.equal(ab2[2].before, null);
});

test("F3 A→B→C without reading shows A→C; C = A clears the change though versions differ", () => {
  const { chain, direct } = chainOf("revert");
  assert.deepEqual(semanticDiff(chain.a, chain.c), [], "A→B→A: nothing changed for a reader who saw A");
  assert.notDeepEqual(chain.c.revision.blocks.map((b) => b.versionId), chain.a.revision.blocks.map((b) => b.versionId));
  assert.deepEqual(semanticDiff(chain.a, direct.c), []);
  assert.equal(semanticDiff(chain.b, chain.c).length, 3, "after reading B the reverts are changes");

  const guide = chainOf("real-guide");
  const viaB = semanticDiff(guide.chain.a, guide.chain.c);
  const skipB = semanticDiff(guide.chain.a, guide.direct.c);
  const view = (changes) => changes.map((c) => [c.kinds, c.before?.text ?? null, c.after?.text ?? null]);
  assert.deepEqual(view(viaB), view(skipB), "the same A→C whether B was persisted or not");
  const kinds = viaB.reduce((acc, c) => ({ ...acc, [c.kinds.join("+")]: (acc[c.kinds.join("+")] ?? 0) + 1 }), {});
  assert.deepEqual(kinds, { added: 1, edited: 3, moved: 3, removed: 1 });
});

test("F3 a block deleted in B and restored in C is matched by content and shows no change from A", () => {
  const a = "# Д\n\nПервый абзац остаётся.\n\nВременно удалённый абзац текста.\n\nПоследний абзац.\n";
  const b = "# Д\n\nПервый абзац остаётся.\n\nПоследний абзац.\n";
  const A = withSource(revise("r:a", a), a);
  const B = withSource(revise("r:b", b, [A]), b);
  const C = withSource(revise("r:c", a, [B]), a);
  assert.notEqual(C.revision.blocks[2].lineageId, A.revision.blocks[2].lineageId, "lineage was lost in B");
  assert.deepEqual(semanticDiff(A, C), []);
  assert.deepEqual(summary(semanticDiff(B, C)), [["added", "Временно удалённый абзац"]]);
});

test("F4 split and merge show the share of the old text in each piece", () => {
  const { chain } = chainOf("split-merge");
  const changes = semanticDiff(chain.a, chain.b);
  assert.deepEqual(changes.map((c) => [c.kinds, c.link]), [[["edited"], "split"], [["edited"], "split"], [["edited"], "merge"]]);
  assert.equal(changes[0].before.text, "Сначала соберите данные о текущей нагрузке. Затем сравните их с плановыми показателями и отметьте отклонения.");
  assert.equal(changes[1].before.text, "Наконец, подготовьте краткий отчёт для команды.");
  assert.ok(changes[0].words.every((w) => w.op === "equal"), "a pure split changes no words");
  assert.deepEqual(splitPortions("a b c d", ["a b", "c d"]), ["a b", "c d"]);
});

test("F5 word-level edits; heavily rewritten blocks switch to «Было / Стало» above the documented threshold", () => {
  assert.equal(REWRITE_THRESHOLD, 0.5);
  const small = blockDiff("Журнал действий хранится девяносто дней и затем архивируется.", "Журнал действий хранится сто восемьдесят дней и затем архивируется.");
  assert.equal(small.rewritten, false);
  assert.deepEqual(small.words, [
    { op: "equal", text: "Журнал действий хранится " },
    { op: "delete", text: "девяносто" },
    { op: "insert", text: "сто восемьдесят" },
    { op: "equal", text: " дней и затем архивируется." },
  ]);
  const big = blockDiff(
    "Система должна отвечать на запрос пользователя не дольше чем за две секунды при обычной нагрузке.",
    "Время ответа под обычной нагрузкой ограничено одной секундой для девяноста пяти процентов запросов.",
  );
  assert.equal(big.rewritten, true);
  const emoji = blockDiff("Семья 👨‍👩‍👧 дома", "Семья 👨‍👩‍👦 дома");
  assert.deepEqual(emoji.words.filter((w) => w.op !== "equal"), [{ op: "delete", text: "👨‍👩‍👧" }, { op: "insert", text: "👨‍👩‍👦" }], "a ZWJ sequence is one token");
  for (const [a, b] of [["", "x"], ["x y", "x y"], ["Café", "Café"]]) {
    const d = blockDiff(a, b);
    assert.equal(d.words.filter((w) => w.op !== "insert").map((w) => w.text).join(""), a);
    assert.equal(d.words.filter((w) => w.op !== "delete").map((w) => w.text).join(""), b);
  }
});

test("T06 the raw Markdown diff is separate from the semantic diff", () => {
  const { chain } = chainOf("rewrap");
  assert.deepEqual(semanticDiff(chain.a, chain.b), []);
  const raw = rawDiff(chain.a.source, chain.b.source, { before: "a.md", after: "b.md" });
  assert.match(raw, /^--- a\.md/m);
  assert.match(raw, /^\+без переносов, в нём есть _курсив_,$/m);
  assert.equal(rawDiff("x\n", "x\n").split("\n").filter((l) => /^[+-][^+-]/.test(l)).length, 0);
});

test("T06 the diff is reproducible after deleting all caches: only snapshots and revisions are needed", () => {
  const seq = loadSequence("real-guide");
  const { chain } = buildChain(seq);
  const first = canonicalJson(semanticDiff(chain.a, chain.c));
  // Rebuild everything from the persisted revisions and raw snapshots only.
  const stored = JSON.parse(JSON.stringify({ a: chain.a.revision, c: chain.c.revision }));
  const again = canonicalJson(semanticDiff({ revision: stored.a, projection: project(seq.versions.a) }, { revision: stored.c, projection: project(seq.versions.c) }));
  assert.equal(again, first);
});

test("AC06 each block is diffed against its own base: a block read at B shows B→C while the others show A→C", () => {
  const { chain } = chainOf("revert");
  const fromA = semanticDiff(chain.a, chain.c);
  const fromB = semanticDiff(chain.b, chain.c);
  const lineage = chain.c.revision.blocks[select(chain.c.projection, "Сессии")].lineageId;
  assert.equal(fromA.find((c) => c.lineageId === lineage), undefined, "unread since A: no change");
  const readAtB = fromB.find((c) => c.lineageId === lineage);
  assert.deepEqual(readAtB.kinds, ["edited"]);
  assert.deepEqual(blockDiff(readAtB.before.text, readAtB.after.text).words, readAtB.words);
});
