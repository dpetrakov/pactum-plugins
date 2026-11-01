import assert from "node:assert/strict";
import test from "node:test";
import { composerTop } from "../ui/composer-position.ts";

test("document/selection composer stays in the visible zone at any reading depth", () => {
  for (const origin of [100, -800, -12000]) {
    const top = composerTop(origin, { top: 144, bottom: 850 }, null, 200);
    assert.equal(origin + top, 152);
  }
});

test("block composer stays beside its target, clamped above the footer or below the header", () => {
  const zone = { top: 144, bottom: 850 };
  assert.equal(composerTop(-800, zone, 420, 200), 1220);
  assert.equal(composerTop(-800, zone, 900, 200), 1442);
  assert.equal(composerTop(-800, zone, -100, 200), 952);
});

test("390 px layout uses the measured height; an oversized form keeps its beginning visible", () => {
  assert.equal(composerTop(-1000, { top: 132, bottom: 760 }, 600, 300), 1452);
  assert.equal(composerTop(-1000, { top: 132, bottom: 400 }, 600, 500), 1140);
});
