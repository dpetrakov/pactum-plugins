// «Copy» (EP-081-T04): one copy button for every block of code in the document and for the frame of embedded
// objects (object.tsx). An icon-only button: `copy` → `check` for 1.5 s after success with a polite announcement;
// a failure — the error toast with the reason (the clipboard is unavailable or refused). The button is `[data-skip]`
// and has no text of its own, so selections, quotes and find-in-page of the document never see it. No Radix here: a
// document may hold hundreds of code blocks, the hint is the native `title` like the other buttons of the block.
import * as sdkApp from "@get-bb/plugin-sdk/app";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { tr } from "../core/i18n.ts";
import { Icon } from "./icons.tsx";
import { notify } from "./store.ts";

/** How long the check mark stays after a successful copy. */
export const COPIED_MS = 1500;

/**
 * Puts `text` into the clipboard. The async Clipboard API first; where it is missing (a page served over plain http
 * to another machine is not a secure context) — the legacy copy command through a detached textarea, with the focus
 * returned. Rejects when neither works.
 */
export async function copyText(text: string): Promise<void> {
  // bb 0.46: bb's own clipboard writer — the native one in bb Desktop (no window focus or secure origin needed);
  // the browser paths below stay for a host without it or when it reports failure.
  const bbCopy = (sdkApp as unknown as { experimental_copyToClipboard?: (input: { text: string }) => Promise<boolean> }).experimental_copyToClipboard;
  let copied = false;
  try { copied = bbCopy ? await bbCopy({ text }) : false; } catch { copied = false; /* outside the bb runtime (tests) */ }
  if (copied) return;
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return;
    } catch {
      // Refused (permissions, focus) — try the legacy command below.
    }
  }
  if (typeof document === "undefined") throw new Error(tr("clipboard unavailable", "буфер обмена недоступен"));
  const active = document.activeElement as HTMLElement | null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(area);
  let done = false;
  try {
    area.select();
    done = document.execCommand("copy");
  } finally {
    area.remove();
    active?.focus?.({ preventScroll: true });
  }
  if (!done) throw new Error(tr("clipboard unavailable", "буфер обмена недоступен"));
}

export interface CopyButtonProps {
  /** The text to copy, or a function that returns it at the moment of the click (e.g. the current source of a diagram). */
  text: string | (() => string);
  /** Accessible button name and hint: Copy code by default, Copy diagram in an object frame. */
  label?: string;
  /** Extra classes: placement is the caller's (`dr-codeblock__copy` in a code block, nothing in a toolbar). */
  className?: string;
  /** `sm` (24 px, 36 px on touch) — the corner of a code block; `md` (28 px) — a toolbar of controls. */
  size?: "sm" | "md";
  /** Called after a successful copy (e.g. to log or to close a menu). */
  onCopied?(): void;
}

/** The icon-only «Copy» button with the check mark after success and the error toast after a failure. */
export function CopyButton({ text, label = tr("Copy code", "Копировать код"), className, size = "sm", onCopied }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const click = (event: MouseEvent<HTMLButtonElement>) => {
    // The block and the frame around it have their own click handlers (selection of an element, focus of the block).
    event.stopPropagation();
    const value = typeof text === "function" ? text() : text;
    copyText(value).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      onCopied?.();
    }, () => notify(tr("Couldn’t copy: the clipboard is unavailable. Select the text and press ⌘ C", "Не удалось скопировать: буфер обмена недоступен. Выделите текст и нажмите ⌘ C"), { tone: "error", id: "dr-copy" }));
  };
  const name = copied ? tr("Copied", "Скопировано") : label;
  return <button type="button" data-skip contentEditable={false} data-copied={copied ? "" : undefined}
    className={`dr-btn dr-btn--icon dr-copy${size === "sm" ? " dr-btn--sm" : ""}${className ? ` ${className}` : ""}`}
    aria-label={label} title={name} onClick={click}>
    <Icon name={copied ? "Check" : "Copy"} />
    <span className="dr-sr" role="status" aria-live="polite">{copied ? tr("Copied", "Скопировано") : ""}</span>
  </button>;
}
