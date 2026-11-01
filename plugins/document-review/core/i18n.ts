// Language of the bb-workbench plugins (EP-126): English by default (published as open source), Russian by choice.
// The master is plugins/document-review/core/i18n.ts; other plugins keep verbatim copies (i18n.ts at the plugin root),
// tests/i18n-ep126.test.mjs compares them. One module for the window, the server and the host: `tr(en, ru)` picks the
// phrase of the current language, so the text of a place stays next to the place. The window fixes the language at
// load (`loadWindowLang`, one device setting for every plugin of the window: slot titles and module-level wording are
// built once) and applies a change by reloading; a server learns it from its window and, in «Documents», hands it to
// the host with every call.
export type Lang = "en" | "ru";
export const LANGS: readonly Lang[] = ["en", "ru"];
export const LANG_NAME: Record<Lang, string> = { en: "English", ru: "Русский" };

let current: Lang = "en";

export function isLang(value: unknown): value is Lang {
  return value === "en" || value === "ru";
}

export function lang(): Lang {
  return current;
}

export function setLang(next: Lang): void {
  if (isLang(next)) current = next;
}

/** The device setting shared by the plugins of the window; the first key of «Documents» is still read. */
export const LANG_KEY = "bb-workbench:lang:v1";
const LEGACY_KEYS = ["bbdr:lang:v1"];

/** Window only: the stored choice of this device becomes the current language (English when none). */
export function loadWindowLang(): Lang {
  let value: string | null | undefined = null;
  try {
    const storage = globalThis.localStorage;
    value = storage?.getItem(LANG_KEY);
    for (const key of LEGACY_KEYS) if (!isLang(value)) value = storage?.getItem(key);
  } catch {
    value = null;
  }
  setLang(isLang(value) ? value : "en");
  return current;
}

/** Window only: keep the choice for every plugin of the window and reload it to apply. */
export function chooseLang(next: Lang): void {
  if (!isLang(next) || next === current) return;
  try {
    globalThis.localStorage?.setItem(LANG_KEY, next);
    for (const key of LEGACY_KEYS) globalThis.localStorage?.removeItem(key);
  } catch {
    // A blocked storage keeps the language of this load.
    return;
  }
  globalThis.location?.reload();
}

/** The phrase of the current language. */
export function tr(en: string, ru: string): string {
  return current === "ru" ? ru : en;
}

/** BCP 47 locale for Intl (numbers, dates). */
export function locale(): string {
  return current === "ru" ? "ru-RU" : "en-US";
}

/** Plural forms: Russian uses one/few/many; English uses one/other/other. */
export type Forms = readonly [string, string, string];

/** Forms of both languages: English [one, other], Russian [one, few, many]. */
export function forms(en: readonly [string, string], ru: Forms): Forms {
  return current === "ru" ? ru : [en[0], en[1], en[1]];
}

const rules: Partial<Record<Lang, Intl.PluralRules>> = {};
const numbers: Partial<Record<Lang, Intl.NumberFormat>> = {};

export function plural(count: number, of: Forms): string {
  const rule = (rules[current] ??= new Intl.PluralRules(current)).select(count);
  return rule === "one" ? of[0] : rule === "few" ? of[1] : of[2];
}

export function num(count: number): string {
  return (numbers[current] ??= new Intl.NumberFormat(locale())).format(count);
}

/** Format a localized count, including grouping separators and the correct noun form. */
export function counted(count: number, of: Forms): string {
  return `${num(count)} ${plural(count, of)}`;
}
