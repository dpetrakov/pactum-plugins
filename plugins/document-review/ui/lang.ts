// The window's language (EP-126): imported first by app.tsx, so the language is fixed before any wording is built.
import { chooseLang, lang, loadWindowLang } from "../core/i18n.ts";

loadWindowLang();

export { chooseLang, lang };
