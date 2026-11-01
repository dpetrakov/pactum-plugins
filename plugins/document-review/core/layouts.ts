// Read model of personal diagram layouts (1.3, W-06f EP-060-T01): the pins of one reader for one diagram block, from
// the per-node registers of the journal. Pure: the journal computed causality, this only reads the registers.
import { entity, layoutNodeRegister, type State } from "./journal.ts";

export type LayoutScope = { doc: string; lineage: string; reader: string };
export type LayoutPin = { x: number; y: number };
/** A node whose concurrent writes disagree (two machines of one reader): every value, null — «unpinned». */
export type LayoutConflict = { node: string; candidates: (LayoutPin | null)[] };
export type LayoutView = { pins: Record<string, LayoutPin>; conflicts: LayoutConflict[]; heads: string[]; events: number };

const parse = (value: string): LayoutPin | null => {
  if (value === "-") return null;
  const [x, y] = value.split(",").map(Number);
  return Number.isInteger(x) && Number.isInteger(y) ? { x, y } : null;
};

export function layoutOf(state: State, scope: LayoutScope): LayoutView {
  const key = entity.layout(scope);
  const prefix = `${key}#node:`;
  const pins: Record<string, LayoutPin> = {};
  for (const [register, value] of state.registers) {
    if (!register.startsWith(prefix) || value.value === null) continue;
    const pin = parse(value.value);
    if (pin) pins[decodeURIComponent(register.slice(prefix.length))] = pin;
  }
  const conflicts: LayoutConflict[] = state.conflicts.filter((conflict) => conflict.entity === key && conflict.register.startsWith("node:"))
    .map((conflict) => ({ node: decodeURIComponent(conflict.register.slice("node:".length)), candidates: conflict.candidates.map((candidate) => parse(candidate.value)) }));
  return { pins, conflicts, heads: [...(state.heads.get(key) ?? [])].sort(), events: state.byEntity.get(key)?.length ?? 0 };
}

export { layoutNodeRegister };
