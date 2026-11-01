// Share the existing device language choice with Documents, without importing a sibling package.
export function tr(en: string, ru: string): string {
  try {
    const storage = globalThis.localStorage;
    return (storage?.getItem("bb-workbench:lang:v1") ?? storage?.getItem("bbdr:lang:v1")) === "ru" ? ru : en;
  } catch { return en; }
}
