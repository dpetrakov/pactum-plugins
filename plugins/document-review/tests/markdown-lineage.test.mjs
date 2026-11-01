import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../core/canonical-json.ts";
import { matchBlocks, matchProjected, project } from "../core/markdown/index.ts";
import { buildChain, loadSequence, revise, select, sequenceNames, sequenceTruth } from "./markdown-helpers.mjs";

/** Every pair the tests compare: consecutive revisions, the composed chain a→…→z and a→c built directly (DR-03). */
function pairs(name) {
  const seq = loadSequence(name);
  const built = buildChain(seq);
  const truth = sequenceTruth(seq, built.chain);
  const out = [];
  const { letters, chain, direct } = built;
  for (let i = 0; i < letters.length; i += 1) for (let j = i + 1; j < letters.length; j += 1) out.push({ x: letters[i], y: letters[j], old: chain[letters[i]], next: chain[letters[j]], truth: truth[`${letters[i]}>${letters[j]}`], how: "chain" });
  for (const letter of Object.keys(direct)) out.push({ x: "a", y: letter, old: chain.a, next: direct[letter], truth: truth[`a>${letter}`], how: "direct" });
  return { seq, built, out };
}

/** Old index -> new indices that continue its lineage (one-to-one) or came from it (split/merge). */
function continuations(old, next) {
  const out = old.revision.blocks.map(() => []);
  next.revision.blocks.forEach((block, j) => {
    old.revision.blocks.forEach((o, i) => {
      if (o.lineageId === block.lineageId || block.origin?.sources.some((s) => s.lineageId === o.lineageId)) out[i].push(j);
    });
  });
  return out;
}

test("T04 lineage never contradicts the ground truth of any mandatory fixture (chained and direct revisions)", () => {
  let links = 0;
  for (const name of sequenceNames()) {
    for (const pair of pairs(name).out) {
      const cont = continuations(pair.old, pair.next);
      cont.forEach((targets, i) => {
        const truth = pair.truth[i];
        const label = `${name} ${pair.x}>${pair.y} ${pair.how} block ${i} "${pair.old.projection.blocks[i].text.slice(0, 30)}"`;
        if (truth === "unknown") assert.deepEqual(targets, [], `${label}: unknowable block was linked`);
        else for (const t of targets) assert.ok(truth.includes(t), `${label}: linked to ${t}, truth ${JSON.stringify(truth)}`);
        links += targets.length;
      });
    }
  }
  assert.ok(links > 300, `links checked: ${links}`);
});

test("DR-03 A→C is matched without B, deterministically from persistent data", () => {
  for (const name of ["real-guide", "split-merge", "section-move", "rename-delete", "revert"]) {
    const { seq, built } = pairs(name);
    const again = buildChain(seq);
    assert.equal(canonicalJson(built.direct.c.revision), canonicalJson(again.direct.c.revision), name);
    assert.deepEqual(built.direct.c.revision.parents, [`${name}:a`]);
    const m1 = matchBlocks(built.chain.a, built.direct.c.projection);
    const m2 = matchBlocks({ revision: built.chain.a.revision, projection: project(seq.versions.a) }, project(seq.versions.c));
    assert.deepEqual(m1, m2, `${name}: matching only needs the stored revision and the two snapshots`);
  }
  const { built } = pairs("real-guide");
  const viaB = continuations(built.chain.a, built.chain.c);
  const direct = continuations(built.chain.a, built.direct.c);
  const same = viaB.filter((t, i) => canonicalJson(t) === canonicalJson(direct[i])).length;
  assert.ok(same >= viaB.length - 3, `chain and direct agree on ${same}/${viaB.length} blocks`);
});

test("T04 split and merge give a range map; a rewritten paragraph without enough evidence stays new", () => {
  const { built } = pairs("split-merge");
  const { a, b } = built.chain;
  const m = matchBlocks(a, b.projection);
  const P = select(a.projection, "Сначала");
  assert.deepEqual(m.next.map((l) => l.kind), ["same", "split", "split", "merge", "same", "same"]);
  assert.deepEqual([m.next[1].old, m.next[2].old], [[P], [P]]);
  assert.deepEqual(m.next[3].old, [select(a.projection, "Отчёт"), select(a.projection, "Доступ")]);
  assert.deepEqual(b.revision.blocks[1].origin, { kind: "split", sources: [{ lineageId: "split-merge:a.1", versionId: "split-merge:a.1" }] });
  assert.equal(b.revision.blocks[1].lineageId, "split-merge:b.1");
  assert.deepEqual(b.revision.removed, [], "split/merge sources are not tombstones");
  const rewrite = pairs("rewrite").built.chain;
  const r = matchBlocks(rewrite.a, rewrite.b.projection);
  assert.equal(r.next[1].kind, "new", "almost fully rewritten: not inherited");
  assert.equal(r.next[2].kind, "edited", "one number changed: inherited");
  assert.deepEqual(rewrite.b.revision.removed.map((t) => t.text), ["Система должна отвечать на запрос пользователя не дольше чем за две секунды при обычной нагрузке."]);
});

test("T04 a moved section is «moved», a moved and edited paragraph is «moved-edited»", () => {
  const { built } = pairs("section-move");
  const ab = matchBlocks(built.chain.a, built.chain.b.projection);
  assert.deepEqual(ab.next.map((l) => l.kind), ["same", "moved", "moved", "moved", "same", "same", "same", "same", "same", "same"]);
  const bc = matchBlocks(built.chain.b, built.chain.c.projection);
  const edited = select(built.chain.c.projection, "Укажите");
  assert.equal(bc.next[edited].kind, "moved-edited");
  assert.equal(built.chain.c.revision.blocks[edited].lineageId, built.chain.a.revision.blocks[select(built.chain.a.projection, "Укажите")].lineageId);
});

test("AC04 duplicates: the surviving copy keeps its own lineage; when it cannot be told which survived, nothing is inherited", () => {
  for (const [name, kept, lost] of [["dup-delete-second", 3, 7], ["dup-delete-first", 7, 3]]) {
    const { chain } = pairs(name).built;
    const survivor = chain.b.projection.blocks.findIndex((x) => x.text.startsWith("Повторяющийся"));
    assert.equal(chain.b.revision.blocks[survivor].lineageId, `${name}:a.${kept}`, name);
    assert.deepEqual(chain.b.revision.removed.map((t) => t.lineageId), [`${name}:a.${lost}`], name);
  }
  const { chain } = pairs("dup-adjacent").built;
  const m = matchBlocks(chain.a, chain.b.projection);
  assert.equal(m.next[2].kind, "new");
  assert.deepEqual(m.removed, [2, 3]);
  assert.ok(m.ambiguous.some((x) => x.reason === "duplicate" && canonicalJson(x.old) === canonicalJson([2, 3])));
  assert.deepEqual(chain.b.revision.removed.map((t) => t.lineageId), ["dup-adjacent:a.2", "dup-adjacent:a.3"]);
  const swap = pairs("dup-section-swap").built.chain;
  const s = matchBlocks(swap.a, swap.b.projection);
  assert.deepEqual(s.next[2].old, [5], "copy under «Второй» stays with its section");
  assert.deepEqual(s.next[5].old, [2]);
});

test("T04 table rows: cells keep their rows when a row with duplicate cells is inserted", () => {
  const { chain } = pairs("table-rows").built;
  const m = matchBlocks(chain.a, chain.b.projection);
  assert.deepEqual(m.next.slice(10, 13).map((l) => l.kind), ["new", "new", "new"], "inserted row");
  assert.deepEqual(m.next.slice(13, 16).map((l) => l.old), [[10], [11], [12]], "row 3 cells, including the duplicate «A»");
  assert.deepEqual(m.removed, [13, 14, 15]);
});

test("T04 removal: tombstones keep the last text and the placement by surviving neighbours and section", () => {
  const { chain } = pairs("rename-delete").built;
  const lineage = (p, r, text) => r.blocks[select(p, text)].lineageId;
  const a = chain.a;
  assert.deepEqual(chain.c.revision.removed, [
    {
      tombstoneId: "rename-delete:c~rename-delete:a.4",
      lineageId: "rename-delete:a.4",
      versionId: "rename-delete:a.4",
      text: "Риски",
      type: "heading",
      placement: { afterLineageId: lineage(a.projection, a.revision, "Время простоя"), beforeLineageId: lineage(a.projection, a.revision, "Следующие"), sectionLineageId: lineage(a.projection, a.revision, "Отчёт") },
    },
    {
      tombstoneId: "rename-delete:c~rename-delete:a.5",
      lineageId: "rename-delete:a.5",
      versionId: "rename-delete:a.5",
      text: "Нагрузка на базу данных растёт быстрее прогноза.",
      type: "paragraph",
      placement: { afterLineageId: lineage(a.projection, a.revision, "Время простоя"), beforeLineageId: lineage(a.projection, a.revision, "Следующие"), sectionLineageId: lineage(a.projection, a.revision, "Отчёт") },
    },
  ]);
  const renamed = matchBlocks(a, chain.b.projection).next[1];
  assert.equal(renamed.kind, "edited");
  assert.ok(renamed.evidence.includes("gap-substitution"), "a renamed heading is matched by its place between unchanged neighbours");
});

test("T04 low confidence is not inherited: two equally similar candidates leave the block new", () => {
  const before = "# Т\n\nАльфа бета гамма дельта эпсилон.\n\nКонец.\n";
  const after = "# Т\n\nАльфа бета гамма дельта эпсилон зета.\n\nАльфа бета гамма дельта эпсилон эта.\n\nКонец.\n";
  const m = matchProjected(project(before).blocks, project(after).blocks);
  assert.deepEqual(m.next.map((l) => l.kind), ["same", "new", "new", "same"]);
  assert.ok(m.ambiguous.some((x) => x.reason === "similar"));
  const old = revise("t:a", before);
  assert.deepEqual(revise("t:b", after, [{ ...old, source: before }]).revision.removed.map((t) => t.lineageId), ["t:a.1"]);
});

test("T04 a realistic guide: section move, split, edit, delete and add are all recognised", () => {
  const { built } = pairs("real-guide");
  const m = matchBlocks(built.chain.a, built.chain.b.projection);
  const kinds = m.next.reduce((acc, l) => ({ ...acc, [l.kind]: (acc[l.kind] ?? 0) + 1 }), {});
  assert.deepEqual(kinds, { same: 59, edited: 1, split: 2, moved: 3, new: 1 });
  assert.equal(m.removed.length, 1);
  assert.equal(built.chain.a.projection.blocks[m.removed[0]].text, "Delete a comment only when it was created by mistake; otherwise resolve it so its discussion remains available for later review.");
});
