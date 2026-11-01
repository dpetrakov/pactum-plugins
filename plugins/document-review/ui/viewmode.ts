// Personal view settings kept on this device (W-06c, file-types.md §6, §12; F6): the view per file type («Pretty» by
// default, or “Raw”), long-line wrapping and line numbers of “Raw”. Not review data: localStorage only.
import { useSyncExternalStore } from "react";

export type ViewMode = "pretty" | "raw";

const KEY = "bbdr:view-prefs:v1";

interface Prefs {
  /** FormatId → mode; absent = «Pretty». */
  modes: Record<string, ViewMode>;
  wrap: boolean;
  numbers: boolean;
}

const listeners = new Set<() => void>();
let cached: Prefs | null = null;

function read(): Prefs {
  if (cached) return cached;
  let value: Partial<Prefs> = {};
  try {
    value = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "{}") as Partial<Prefs>;
  } catch {
    value = {};
  }
  const modes: Record<string, ViewMode> = {};
  for (const [format, mode] of Object.entries(value.modes ?? {})) if (mode === "pretty" || mode === "raw") modes[format] = mode;
  cached = { modes, wrap: value.wrap === true, numbers: value.numbers !== false };
  return cached;
}

function write(next: Prefs) {
  cached = next;
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(next));
  } catch {
    // A full or blocked storage keeps the setting for this session only.
  }
  for (const listener of listeners) listener();
}

export function viewPrefs(): Prefs {
  return read();
}

export function setViewMode(format: string, mode: ViewMode) {
  const prefs = read();
  const modes = { ...prefs.modes };
  if (mode === "pretty") delete modes[format];
  else modes[format] = mode;
  write({ ...prefs, modes });
}

export function setWrap(wrap: boolean) {
  write({ ...read(), wrap });
}

export function setNumbers(numbers: boolean) {
  write({ ...read(), numbers });
}

export function resetViewPrefs() {
  write({ modes: {}, wrap: false, numbers: true });
}

export function useViewPrefs(): Prefs {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, read, read);
}
