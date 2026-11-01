import assert from "node:assert/strict";
import test from "node:test";
import { clampPointer, freshPanClock, panStep, PAN_DELAY_MS, PAN_MAX_PX_PER_SECOND, touchPanRect } from "../core/drag-motion.ts";
const rect = { left: 10, top: 20, right: 410, bottom: 320 };
test("the visible area is immediate; arbitrarily distant pointers stop at its boundary", () => {
  assert.deepEqual(clampPointer({ x: 120, y: 70 }, rect), { x: 120, y: 70 });
  assert.deepEqual(clampPointer({ x: -100000, y: 100000 }, rect), { x: 10, y: 320 });
});
test("outside motion waits, ramps gently and never exceeds the screen-space speed cap", () => {
  const clock = freshPanClock(), pointer = { x: 100000, y: 100000 };
  for (let now = 0; now <= PAN_DELAY_MS; now += 10) assert.deepEqual(panStep(clock, pointer, rect, now), { x: 0, y: 0 });
  let distance = 0;
  for (let now = PAN_DELAY_MS + 10; now <= PAN_DELAY_MS + 1010; now += 10) {
    const p = panStep(clock, pointer, rect, now); const length = Math.hypot(p.x, p.y);
    assert.ok(length <= PAN_MAX_PX_PER_SECOND * .01 + .0001); distance += length;
  }
  assert.ok(distance > 10 && distance < 24, `ramped distance ${distance}`);
});
test("returning inside or changing direction immediately stops panning and requires a new dwell", () => {
  const clock = freshPanClock(); panStep(clock, { x: 999, y: 100 }, rect, 0);
  assert.ok(panStep(clock, { x: 999, y: 100 }, rect, 1200).x > 0);
  assert.deepEqual(panStep(clock, { x: 200, y: 100 }, rect, 1210), { x: 0, y: 0 });
  assert.deepEqual(panStep(clock, { x: -999, y: 100 }, rect, 1220), { x: 0, y: 0 });
  assert.deepEqual(panStep(clock, { x: -999, y: 100 }, rect, 1800), { x: 0, y: 0 });
});
test("a stalled frame cannot teleport the view; motion is independent of frame rate", () => {
  const simulate = fps => {
    const clock = freshPanClock(); let total = 0;
    for (let i = 0; i <= fps * 3; i++) total += panStep(clock, { x: 999, y: 100 }, rect, i * 1000 / fps).x;
    return total;
  };
  assert.ok(Math.abs(simulate(60) - simulate(120)) < 1);
  const clock = freshPanClock(); panStep(clock, { x: 999, y: 100 }, rect, 0);
  assert.ok(panStep(clock, { x: 999, y: 100 }, rect, 100000).x <= 1.2);
});

test("touch can pan from an inner edge zone without slowing direct pointer movement", () => {
  const edge = { x: rect.right - 2, y: 100 }, clock = freshPanClock();
  assert.deepEqual(clampPointer(edge, rect), edge);
  assert.deepEqual(panStep(clock, edge, touchPanRect(rect), 0), { x: 0, y: 0 });
  assert.ok(panStep(clock, edge, touchPanRect(rect), 1200).x > 0);
});
