import assert from "node:assert/strict";
import test from "node:test";
import { blockSegments, project, quoteAt, resolveAnchor, sliceText, tokenize } from "../core/markdown/index.ts";
import { isWord, occurrences } from "../core/markdown/tokens.ts";
import { buildChain, loadSequence, revise, select, sequenceNames, sequenceTruth, withSource } from "./markdown-helpers.mjs";

const cps = (text) => Array.from(text).length;

/** Every quote the test anchors: each whole block, each word occurrence, and each pair of neighbouring blocks. */
function quotes(p) {
  const out = [];
  const nonEmpty = p.blocks.filter((b) => b.text);
  nonEmpty.forEach((b, k) => {
    out.push({ ...b.range });
    let at = 0;
    for (const token of tokenize(b.text)) {
      const length = cps(token);
      if (isWord(token)) out.push({ start: b.range.start + at, end: b.range.start + at + length });
      at += length;
    }
    const next = nonEmpty[k + 1];
    if (next) {
      const last = tokenize(b.text).filter(isWord).at(-1);
      const first = tokenize(next.text).filter(isWord)[0];
      if (last && first) out.push({ start: b.range.end - cps(b.text.slice(b.text.lastIndexOf(last))), end: next.range.start + cps(next.text.slice(0, next.text.indexOf(first) + first.length)) });
    }
  });
  return out;
}

/**
 * Ground-truth check of a confident (exact/mapped) result: every target block has a known continuation, the result
 * lies inside it, reads the same, and for repeated quotes is the same occurrence (k-th stays k-th in that block).
 */
function confidentProblem(result, target, current, truth) {
  const segments = blockSegments(target.projection, target.range);
  const allowed = new Set();
  for (const s of segments) {
    const t = truth[s.block];
    if (t === "unknown") return "target block cannot be known";
    if (!t.length) return "target block was deleted";
    for (const x of t) allowed.add(x);
  }
  if (result.ranges.length !== 1) return "several ranges";
  for (const s of blockSegments(current.projection, result.ranges[0])) if (!allowed.has(s.block)) return `lands in block ${s.block}`;
  if (sliceText(current.projection, result.ranges[0]) !== target.quote.exact) return "text differs";
  if (segments.length === 1) {
    const old = target.projection.blocks[segments[0].block];
    const inOld = occurrences(old.text, target.quote.exact);
    const landed = current.projection.blocks[blockSegments(current.projection, result.ranges[0])[0].block];
    const inNew = occurrences(landed.text, target.quote.exact);
    const kOld = inOld.indexOf(segments[0].range.start - old.range.start);
    const kNew = inNew.indexOf(result.ranges[0].start - landed.range.start);
    if (inOld.length !== inNew.length) {
      if (!(inOld.length === 1 && inNew.length === 1)) return "repeated quote with a different number of occurrences";
    } else if (kOld !== kNew) return `occurrence ${kOld} became ${kNew}`;
  }
  return null;
}

let memo = null;
function allResolutions() {
  if (memo) return memo;
  const out = [];
  for (const name of sequenceNames()) {
    const seq = loadSequence(name);
    const { letters, chain, direct } = buildChain(seq);
    const truth = sequenceTruth(seq, chain);
    const pairs = [];
    for (let i = 0; i < letters.length; i += 1) for (let j = i + 1; j < letters.length; j += 1) pairs.push([letters[i], letters[j], chain[letters[j]], "chain"]);
    for (const letter of Object.keys(direct)) pairs.push(["a", letter, direct[letter], "direct"]);
    for (const [x, y, current, how] of pairs) {
      const old = chain[x];
      for (const range of quotes(old.projection)) {
        const target = { revision: old.revision, projection: old.projection, range, quote: quoteAt(old.projection, range) };
        out.push({ label: `${name} ${x}>${y} ${how}`, target, current, truth: truth[`${x}>${y}`], result: resolveAnchor(target, current) });
      }
    }
  }
  memo = out;
  return out;
}

test("§11 no false exact/mapped anchor on the mandatory fixtures (every block, word and block pair, chained and direct revisions)", () => {
  const all = allResolutions();
  const counts = {};
  const problems = [];
  for (const r of all) {
    counts[r.result.status] = (counts[r.result.status] ?? 0) + 1;
    if (r.result.status !== "exact" && r.result.status !== "mapped") continue;
    const problem = confidentProblem(r.result, r.target, r.current, r.truth);
    if (problem) problems.push(`${r.label} ${JSON.stringify(r.target.quote.exact.slice(0, 40))}: ${problem}`);
  }
  assert.deepEqual(problems, []);
  assert.ok(all.length > 5000, `resolutions: ${all.length}`);
  assert.ok(counts.mapped > all.length * 0.7, `mapped ${counts.mapped} of ${all.length}: the resolver is not merely conservative`);
  for (const status of ["approximate", "ambiguous", "orphaned"]) assert.ok(counts[status] > 0, `${status} occurs`);
});

test("T05 same revision: verified offsets and quote give exact", () => {
  const { chain } = buildChain(loadSequence("real-guide"));
  const p = chain.a.projection;
  const range = { start: p.blocks[3].range.start + 2, end: p.blocks[5].range.end };
  const result = resolveAnchor({ revision: chain.a.revision, projection: p, range, quote: quoteAt(p, range) }, chain.a);
  assert.deepEqual(result, { status: "exact", revisionId: "real-guide:a", ranges: [range], place: null, evidence: ["same-revision", "quote-verified"], candidates: [] });
  const wrong = resolveAnchor({ revision: chain.a.revision, projection: p, range, quote: { ...quoteAt(p, range), exact: "чужой текст" } }, chain.a);
  assert.notEqual(wrong.status, "exact");
  assert.notEqual(wrong.status, "mapped");
  assert.ok(wrong.evidence.includes("target-quote-mismatch"));
});

function anchor(name, from, to, selector, part, direct = false) {
  const { chain, direct: d } = buildChain(loadSequence(name));
  const old = chain[from];
  const current = direct ? d[to] : chain[to];
  const block = old.projection.blocks[select(old.projection, selector)];
  let range = { ...block.range };
  if (part) {
    const at = cps(block.text.slice(0, block.text.indexOf(part)));
    range = { start: block.range.start + at, end: block.range.start + at + cps(part) };
  }
  const result = resolveAnchor({ revision: old.revision, projection: old.projection, range, quote: quoteAt(old.projection, range) }, current);
  const placeText = result.place ? current.projection.blocks[result.place.block].text : null;
  return { result, current, placeText, text: result.ranges.map((r) => sliceText(current.projection, r)) };
}

test("AC03 a rewritten, split or moved paragraph: the card is next to the result or honestly ambiguous/orphaned", () => {
  const rewritten = anchor("rewrite", "a", "b", "Система", "две секунды");
  assert.equal(rewritten.result.status, "orphaned");
  assert.match(rewritten.placeText, /^Время ответа/, "shown at the rewritten paragraph");
  const changedNumber = anchor("rewrite", "a", "b", "Журнал", "девяносто дней");
  assert.equal(changedNumber.result.status, "approximate");
  assert.deepEqual(changedNumber.text, ["сто восемьдесят дней"]);
  const kept = anchor("rewrite", "a", "b", "Журнал", "затем архивируется");
  assert.equal(kept.result.status, "mapped");
  const split = anchor("split-merge", "a", "b", "Сначала", "подготовьте краткий отчёт");
  assert.equal(split.result.status, "mapped");
  assert.ok(split.result.evidence.includes("split"));
  const wholeSplit = anchor("split-merge", "a", "b", "Сначала");
  assert.equal(wholeSplit.result.status, "approximate");
  assert.equal(wholeSplit.result.ranges.length, 2, "both pieces");
  const merged = anchor("split-merge", "a", "b", "Доступ");
  assert.equal(merged.result.status, "approximate");
  assert.match(merged.text[0], /доступ к каталогу есть у всех участников команды/);
  const moved = anchor("section-move", "a", "b", "Запустите");
  assert.equal(moved.result.status, "mapped");
  assert.deepEqual(moved.text, ["Запустите сервис командой start."]);
  const movedEdited = anchor("section-move", "b", "c", "Укажите", "порт подключения");
  assert.equal(movedEdited.result.status, "mapped");
  const deletedSection = anchor("rename-delete", "a", "c", "Нагрузка");
  assert.equal(deletedSection.result.status, "orphaned");
  assert.equal(deletedSection.placeText, "Время простоя составило четыре минуты.", "nearest surviving context");
  const renamed = anchor("rename-delete", "a", "b", "Итоги");
  assert.equal(renamed.result.status, "approximate");
  assert.deepEqual(renamed.text, ["Выводы"]);
});

test("AC04 the deleted copy of a duplicate is not captured by the other copy", () => {
  const second = anchor("dup-delete-second", "a", "b", "#7");
  assert.equal(second.result.status, "orphaned");
  assert.deepEqual(second.result.ranges, []);
  assert.equal(second.placeText, "Вводный абзац раздела Б.");
  assert.ok(second.result.candidates.every((c) => c.evidence.includes("other-copy") && c.score === 0), "the other copy is listed as such, never ranked");
  const first = anchor("dup-delete-first", "a", "b", "#3");
  assert.equal(first.result.status, "orphaned");
  assert.equal(first.placeText, "Вводный абзац раздела А.");
  const survivor = anchor("dup-delete-first", "a", "b", "#7");
  assert.equal(survivor.result.status, "mapped");
  assert.equal(survivor.current.projection.blocks[blockSegments(survivor.current.projection, survivor.result.ranges[0])[0].block].headings.length, 2);
  for (const sel of ["#2", "#3"]) {
    const adjacent = anchor("dup-adjacent", "a", "b", sel);
    assert.equal(adjacent.result.status, "ambiguous", "impossible to tell which copy survived");
    assert.deepEqual(adjacent.result.ranges, []);
    assert.ok(adjacent.result.candidates.length >= 1);
  }
  const swapped = anchor("dup-section-swap", "a", "b", "#2");
  assert.equal(swapped.result.status, "mapped");
  assert.equal(swapped.current.projection.blocks[swapped.current.projection.blocks.findIndex((b) => b.range.start <= swapped.result.ranges[0].start && swapped.result.ranges[0].end <= b.range.end) - 1].text, "Первый");
});

test("T05 a unique match of a short word alone is not proof", () => {
  const before = "# Заметки\n\nКот спит на окне весь день.\n\nДругой абзац.\n";
  const after = "# Заметки\n\nДругой абзац.\n\nНовый абзац про кот и собаку.\n";
  const A = withSource(revise("s:a", before), before);
  const B = revise("s:b", after, [A]);
  const p = A.projection;
  const at = Array.from(p.text).join("").indexOf("Кот");
  const range = { start: at, end: at + 3 };
  const lower = resolveAnchor({ revision: A.revision, projection: p, range, quote: { exact: "кот", prefix: "", suffix: "" } }, B);
  assert.notEqual(lower.status, "mapped");
  const quote = quoteAt(p, { start: p.blocks[1].range.start + 4, end: p.blocks[1].range.start + 8 });
  const r = resolveAnchor({ revision: A.revision, projection: p, range: { start: p.blocks[1].range.start + 4, end: p.blocks[1].range.start + 8 }, quote }, B);
  assert.equal(quote.exact, "спит");
  assert.notEqual(r.status, "mapped");
  assert.notEqual(r.status, "exact");
  const word = "# Заметки\n\nСлово кот здесь.\n\nКонец.\n";
  const moved = "# Заметки\n\nКонец.\n\nИ кот.\n";
  const W = withSource(revise("w:a", word), word);
  const M = revise("w:b", moved, [W]);
  const wr = { start: W.projection.blocks[1].range.start + 6, end: W.projection.blocks[1].range.start + 9 };
  const short = resolveAnchor({ revision: W.revision, projection: W.projection, range: wr, quote: quoteAt(W.projection, wr) }, M);
  assert.equal(short.status, "ambiguous");
  assert.ok(short.evidence.includes("short-quote"));
  assert.equal(short.candidates.length, 1);
});

test("D4 no pseudo-probabilities and the stored target is never modified; the resolution is a separate object", () => {
  const all = allResolutions().filter((_, i) => i % 7 === 0);
  for (const r of all) {
    for (const c of r.result.candidates) assert.ok(Number.isInteger(c.score), "scores are integer ranks");
    assert.ok(!r.result.evidence.some((e) => /%|confidence|probab/i.test(e)));
    assert.ok(!("confidence" in r.result));
  }
  const { chain } = buildChain(loadSequence("rewrite"));
  const range = { ...chain.a.projection.blocks[1].range };
  const target = { revision: chain.a.revision, projection: chain.a.projection, range, quote: quoteAt(chain.a.projection, range) };
  const snapshot = JSON.stringify({ revision: target.revision, range: target.range, quote: target.quote });
  Object.freeze(target.range);
  Object.freeze(target.quote);
  const result = resolveAnchor(target, chain.b);
  assert.equal(JSON.stringify({ revision: target.revision, range: target.range, quote: target.quote }), snapshot);
  assert.equal(result.revisionId, "rewrite:b");
  assert.ok(!("quote" in result), "the resolution never carries a replacement quote");
});

test("T05 every status is reachable and carries machine-readable evidence", () => {
  const seen = new Map();
  for (const r of allResolutions()) if (!seen.has(r.result.status)) seen.set(r.result.status, r.result);
  for (const status of ["mapped", "approximate", "ambiguous", "orphaned"]) {
    const r = seen.get(status);
    assert.ok(r, status);
    assert.ok(r.evidence.length > 0);
    if (status === "orphaned") assert.deepEqual(r.ranges, []);
    if (status !== "mapped") assert.ok(r.place === null || Number.isInteger(r.place.block));
  }
  assert.equal(project("").blocks.length, 0);
});
