/** Visible command feedback. Timing, retries and rollback live in feedback.ts; markup lives here and styles in feedback.css. Lucide ISC icon geometry is embedded so consumers do not need lucide-react. Use BusyIcon in an icon button, BusyOverlay above an iconless label, data-fb-row-busy for an opening row, data-fb-seam-busy for background loading and data-fb-dim when switching objects. */
import type { ReactNode } from "react";

/** Command state compatible with CommandState in feedback.ts. */
export type BusyState = { running: boolean; busy: boolean };

/** Running commands set aria-busy and aria-disabled while preserving focus. data-fb-busy enables the delayed indicator. The command handler ignores duplicate presses. */
export function busyProps(state: BusyState): { "aria-busy"?: true; "aria-disabled"?: true; "data-fb-busy"?: "" } {
  return {
    ...(state.running ? { "aria-busy": true as const, "aria-disabled": true as const } : {}),
    ...(state.busy ? { "data-fb-busy": "" as const } : {}),
  };
}

const svg = (size: number, className: string | undefined, children: ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>{children}</svg>
);

/** Lucide loader-circle inherits the text color. feedback.css owns rotation and reduced-motion behavior. */
export function FbSpinner({ size = 16 }: { size?: number }) {
  return svg(size, "fb-spin", <path d="M21 12a9 9 0 1 1-6.219-8.56" />);
}

/** Replace the button icon with a spinner during a command without changing the cell width. */
export function BusyIcon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return <span className="fb-ico" style={{ width: size, height: size }}>{children}<FbSpinner size={size} /></span>;
}

/** Overlay a spinner above an iconless button label; apply busyProps to the button. */
export function BusyOverlay({ size = 16 }: { size?: number }) {
  return <span className="fb-over" aria-hidden="true"><FbSpinner size={size} /></span>;
}

/** Skeleton rows with widths expressed as percentages of the expected result. */
export function Skeleton({ widths = [72, 90, 56], label = "Загружаю…" }: { widths?: number[]; label?: string }) {
  return <div className="fb-skel-list" role="status" aria-label={label}>
    {widths.map((width, index) => <span key={index} className="fb-skel" style={{ width: `${width}%` }} />)}
  </div>;
}

/** Long-operation progress with a completion rail and Cancel. The caller handles Escape; ofLabel supplies the localized count separator. */
export function ProgressLine({ verb, done, total, current, onCancel, cancelLabel = "Отменить", ofLabel = "из" }:
  { verb: string; done: number; total: number; current?: string | null; onCancel?: () => void; cancelLabel?: string; ofLabel?: string }) {
  const share = total > 0 ? Math.min(1, done / total) : 0;
  return <div className="fb-progress" role="status" aria-live="polite">
    <span className="fb-grow">{verb} <b>{Math.min(done + 1, total)} {ofLabel} {total}</b>{current ? ` · ${current}…` : "…"}</span>
    {onCancel && <button type="button" className="fb-btn" onClick={onCancel}>{cancelLabel}</button>}
    <span className="fb-bar" style={{ width: `${Math.round(share * 100)}%` }} />
  </div>;
}

/** An inline error explains the failure and offers Retry. */
export function InlineError({ children, onRetry, retryLabel = "Повторить" }: { children: ReactNode; onRetry?: () => void; retryLabel?: string }) {
  return <div className="fb-error" aria-live="polite">
    {svg(16, undefined, <><circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" /></>)}
    <span className="fb-grow">{children}</span>
    {onRetry && <button type="button" className="fb-btn" onClick={onRetry}>{retryLabel}</button>}
  </div>;
}

/** A quiet stale-data notice: the last background refresh failed and the displayed data is from at. label and locale support localization. */
export function StaleNote({ at, reason, label = "не обновлено", locale = "ru-RU" }: { at: number; reason?: string; label?: string; locale?: string }) {
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(at);
  return <span className="fb-stale" title={reason}>
    {svg(14, undefined, <><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>)}
    {label} · {time}
  </span>;
}
