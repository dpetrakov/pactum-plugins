// EP-018-T01: every navigation source goes through revealBlock → revealDelta; the target's top is never under the
// sticky header and (for center/nearest) its bottom never under the pass footer — with a header of 1, 2 and 3 rows.
import assert from "node:assert/strict";
import test from "node:test";
import { PAD, revealDelta, focusWithoutScroll, keepFocusVisible } from "../ui/reveal.ts";

test("returning overlay focus suppresses both native and page focus scrolling; Tab still reveals", () => {
  let focusOptions;
  let scrolls = 0;
  const container = {
    scrollTop: 500,
    getBoundingClientRect: () => ({ top: 0, bottom: 900 }),
    querySelectorAll: () => [],
    style: { setProperty() {} },
    scrollTo: () => { scrolls++; },
  };
  const element = {
    getBoundingClientRect: () => ({ top: -200, bottom: -100 }),
    focus: options => { focusOptions = options; keepFocusVisible(container, element); },
  };
  focusWithoutScroll(element);
  assert.deepEqual(focusOptions, { preventScroll: true });
  assert.equal(scrolls, 0);
  keepFocusVisible(container, element);
  assert.equal(scrolls, 1);
});

const container = { top: 0, bottom: 900 };
const FOOTER = 40;
const HEADERS = { "1 ряд": 44, "2 ряда": 88, "3 ряда": 132 };

/** Apply a delta like scrollTop += delta does: content moves up by delta. */
const after = (target, delta) => ({ top: target.top - (delta ?? 0), bottom: target.bottom - (delta ?? 0) });

// Sources and how they reveal (ui/page.tsx, ui/tree.tsx, ui/comments.tsx, ui/agent.tsx).
const SOURCES = {
  "раздел в дереве (тот же документ)": "start",
  "раздел в дереве (другой документ, pendingHash)": "start",
  "результат поиска": "start",
  "ссылка .md#раздел": "start",
  "deep link замечания": "center",
  "карточка в «Замечаниях»": "center",
  "J/K": "center",
  "«Прочитано и дальше»": "center",
  "«Принять и дальше»": "center",
  "следующий документ «Все документы»": "center",
  "«Просмотреть» итога раунда": "center",
  "фокус Tab": "nearest",
};

for (const [rows, header] of Object.entries(HEADERS)) {
  for (const [source, how] of Object.entries(SOURCES)) {
    test(`${source}, хедер ${rows}: цель целиком в безопасной зоне`, () => {
      const chrome = { header, footer: FOOTER };
      // Targets: hidden under the header, far below, under the footer, partly visible above, tall.
      for (const target of [{ top: 10, bottom: 40 }, { top: 3000, bottom: 3060 }, { top: 870, bottom: 930 }, { top: header - 20, bottom: header + 10 }, { top: 2000, bottom: 2400 }]) {
        const shown = after(target, revealDelta(container, target, chrome, how));
        assert.ok(shown.top >= container.top + header - 0.5, `${JSON.stringify(target)}: верх ${shown.top} под хедером ${header}`);
        const tall = target.bottom - target.top > container.bottom - container.top - header - FOOTER - 2 * PAD;
        if (!tall) assert.ok(shown.bottom <= container.bottom - FOOTER + 0.5, `${JSON.stringify(target)}: низ ${shown.bottom} под футером`);
      }
    });
  }
}

test("цель уже видна целиком — прокрутки нет", () => {
  assert.equal(revealDelta(container, { top: 300, bottom: 340 }, { header: 44, footer: 40 }, "start"), null);
  assert.equal(revealDelta(container, { top: 300, bottom: 340 }, { header: 44, footer: 40 }, "center"), null);
  assert.equal(revealDelta(container, { top: 300, bottom: 340 }, { header: 44, footer: 40 }, "nearest"), null);
});

test("start ставит верх цели на 12 px ниже хедера", () => {
  const delta = revealDelta(container, { top: 1200, bottom: 1240 }, { header: 88, footer: 40 }, "start");
  assert.equal(1200 - delta, 88 + PAD);
});

test("высокая цель при center показывается с начала", () => {
  const delta = revealDelta(container, { top: 1500, bottom: 2600 }, { header: 44, footer: 40 }, "center");
  assert.equal(1500 - delta, 44 + PAD);
});

test("нумерация пунктов: по позиции в списке и уровню вложенности", async () => {
  const { listNumbers } = await import("../ui/lists.ts");
  const li = (index, list, ordered, start = 1) => ({ index, type: "listItem", attrs: { list, ordered, start: ordered ? start : null } });
  const p = (index, list = 0) => ({ index, type: "paragraph", attrs: { list } });
  const numbers = listNumbers([li(0, 1, true), li(1, 2, true), li(2, 2, true), li(3, 1, true), p(4), li(5, 1, true, 5), li(6, 1, true, 5), li(7, 1, false), li(8, 1, true)]);
  assert.deepEqual([...numbers], [[0, 1], [1, 1], [2, 2], [3, 2], [5, 5], [6, 6], [8, 1]]);
});
