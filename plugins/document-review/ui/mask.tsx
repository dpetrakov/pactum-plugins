// Mask of a secret value (W-06c, file-types.md §8, F19; design system «Files of any type», D23): «•••• 32 chars» and an
// eye. «Reveal value» asks the host for one value (review.secret.reveal: context checked, never cached); the
// value lives only in this component's state and is dropped when the file is left (unmount), the view changes, the
// window is hidden, or 30 s pass without the pointer or the focus on it. «Value changed» — a badge without values.
// The bullets of the redacted text stay in the DOM (selection maps to the projection), the value is `data-skip`.
import { useEffect, useRef, useState } from "react";
import { call, explain } from "./actions.ts";
import { Icon } from "./icons.tsx";
import { getUi, notify } from "./store.ts";
import { num } from "./words.ts";
import { tr } from "../core/i18n.ts";

export interface MaskSecret {
  place: string;
  path: (string | number | { doc: number })[] | null;
  key: string | null;
  line: number;
  length: number;
  explicit: boolean;
  changed?: boolean;
  exempt?: "me" | null;
  scope?: "shared" | "personal";
}

const HIDE_AFTER_MS = 30_000;

/** «Not a secret…» of the page (the dialog lives there, EP-043-T07); null — the action is not offered. */
let exemptHandler: ((secret: MaskSecret) => void) | null = null;
export function setExemptHandler(handler: ((secret: MaskSecret) => void) | null) {
  exemptHandler = handler;
}

/** Every shown value of this page: hidden together (leaving the file, switching the view, hiding the window). */
const shown = new Set<() => void>();
export function hideAllSecrets() {
  for (const hide of [...shown]) hide();
}
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (document.hidden) hideAllSecrets(); });

export function Mask({ doc, secret, bullets }: { doc: string; secret: MaskSecret; bullets: string }) {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const holder = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hide = useRef(() => {});
  hide.current = () => { setValue(null); if (timer.current) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => {
    const fn = () => hide.current();
    shown.add(fn);
    return () => { shown.delete(fn); if (timer.current) clearTimeout(timer.current); };
  }, []);
  const arm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(function tick() {
      // Pointer or focus on the value extends the time; otherwise it hides itself.
      if (holder.current?.matches(":hover, :focus-within")) timer.current = setTimeout(tick, 2000);
      else hide.current();
    }, HIDE_AFTER_MS);
  };
  const reveal = async () => {
    if (value !== null) { hide.current(); return; }
    const { view, target } = getUi();
    if (!view || !target) return;
    setBusy(true);
    const reply = await call<{ value: string }>("review.secret.reveal", { target, path: doc, place: secret.place, keyPath: secret.path ? JSON.stringify(secret.path) : null, line: secret.line,
      head: view.context.head, branch: view.context.branch }).finally(() => setBusy(false));
    if (!reply.ok) {
      notify(reply.error.code === "not-found" ? tr("The value is no longer here: the file changed after it was shown. Refresh the document", "Значения здесь нет: файл изменился после показа — обновите документ") : tr(`Couldn't reveal the value: ${explain(reply.error)}`, `Не удалось показать значение: ${explain(reply.error)}`), { tone: "error", ms: 6000 });
      return;
    }
    setValue((reply as unknown as { result: { value: string } }).result.value);
    arm();
  };
  // «Not a secret — for me» (F17): shown without a click, through the same method, never cached.
  useEffect(() => {
    if (secret.exempt === "me" && value === null) void reveal();
  }, [secret.exempt]); // eslint-disable-line react-hooks/exhaustive-deps
  const label = secret.explicit && secret.length > 200 ? tr("key", "ключ") : tr(`${num(secret.length)}\u00a0chars`, `${num(secret.length)}\u00a0симв.`);
  return <span ref={holder} className={`dr-mask${value !== null ? " dr-mask--shown" : ""}`} data-secret={secret.place} onPointerEnter={() => value !== null && arm()}>
    <span className="dr-mask__dots" hidden={value !== null}>{bullets}</span>
    {value !== null && <span data-skip className="dr-mask__val" title={tr("Hides itself in 30 s", "Скроется само через 30 с")}>{value}</span>}
    {value === null && <span data-skip className="dr-mask__len">{label}</span>}
    <button type="button" data-skip className="dr-mask__eye" aria-label={value !== null ? tr("Hide value", "Скрыть значение") : tr("Reveal value", "Показать значение")} title={value !== null ? tr("Hide", "Скрыть") : tr("Reveal value", "Показать значение")}
      aria-busy={busy || undefined} onClick={(event) => { event.stopPropagation(); void reveal(); }}><Icon name={value !== null ? "EyeOff" : "Eye"} /></button>
    {exemptHandler && !secret.explicit && secret.path && <button type="button" data-skip className="dr-mask__eye" aria-label={tr("Not a secret…", "Не секрет…")} title={tr("Not a secret…", "Не секрет…")}
      onClick={(event) => { event.stopPropagation(); exemptHandler?.(secret); }}><Icon name="ShieldOff" /></button>}
    {secret.exempt === "me" && <span data-skip className="dr-mask__note">{tr("not a secret · for me", "не секрет · для меня")}</span>}
    {secret.changed && <span data-skip className="dr-mask__changed" title={tr("The value changed since this device last saw it; values are not stored", "Значение изменилось с тех пор, как его видело это устройство; значения не сохраняются")}>{tr("value changed", "значение изменено")}</span>}
  </span>;
}
