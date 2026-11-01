// Screen-space motion policy: immediate inside the viewport, delayed and bounded outside.
export type Point = { x: number; y: number };
export type Rect = { left: number; top: number; right: number; bottom: number };
export const PAN_DELAY_MS = 650;
export const PAN_RAMP_MS = 400;
export const PAN_MAX_PX_PER_SECOND = 24;
export const MAX_FRAME_MS = 50;
export const TOUCH_EDGE_PX = 12;
/** A finger cannot leave the physical display: dwell in a narrow inner edge zone instead. */
export function touchPanRect(rect: Rect): Rect {
  const x = Math.min(TOUCH_EDGE_PX, (rect.right - rect.left) / 4), y = Math.min(TOUCH_EDGE_PX, (rect.bottom - rect.top) / 4);
  return { left: rect.left + x, top: rect.top + y, right: rect.right - x, bottom: rect.bottom - y };
}
export type PanClock = { x: number; y: number; since: number; previous: number };
export const freshPanClock = (): PanClock => ({ x: 0, y: 0, since: 0, previous: 0 });
export function clampPointer(point: Point, rect: Rect): Point {
  return { x: Math.max(rect.left, Math.min(rect.right, point.x)), y: Math.max(rect.top, Math.min(rect.bottom, point.y)) };
}
export function panStep(clock: PanClock, pointer: Point, rect: Rect, now: number): Point {
  const x = pointer.x < rect.left ? -1 : pointer.x > rect.right ? 1 : 0;
  const y = pointer.y < rect.top ? -1 : pointer.y > rect.bottom ? 1 : 0;
  if (clock.x !== x || clock.y !== y) { Object.assign(clock, { x, y, since: now, previous: now }); return { x: 0, y: 0 }; }
  const dt = Math.min(MAX_FRAME_MS, Math.max(0, now - clock.previous));
  clock.previous = now;
  const ramp = Math.max(0, Math.min(1, (now - clock.since - PAN_DELAY_MS) / PAN_RAMP_MS));
  const length = Math.hypot(x, y) || 1;
  const distance = PAN_MAX_PX_PER_SECOND * dt / 1000 * ramp * ramp;
  return distance ? { x: x / length * distance, y: y / length * distance } : { x: 0, y: 0 };
}
