// Overlay coordinates belong to the content, but its field must stay in the visible reading zone.
export function composerTop(origin: number, zone: { top: number; bottom: number }, desired: number | null, height: number): number {
  const min = zone.top + 8;
  const max = Math.max(min, zone.bottom - height - 8);
  return Math.max(min, Math.min(desired ?? min, max)) - origin;
}
