// Base elements of «Documents» (EP-017-T04): one instance of each, used by every surface. Overlays come from the
// vendored @bb registry (components/ui: radix shared with the host — focus, layers, Esc, bottom sheet on a phone);
// small pieces (Kbd, Count, Dot, Badge, Banner, Empty, skeleton rows) are spans with the design-system classes of
// ui/theme.css. Every interactive element names itself and shows its key in the hint.
import { type ComponentProps, type ReactElement, type ReactNode, forwardRef } from "react";
import { Button, type ButtonProps } from "../components/ui/button.tsx";
import { Toggle } from "../components/ui/toggle.tsx";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip.tsx";
import { type CommandState, useCommand } from "../feedback.ts";
import { type BusyState, BusyIcon, BusyOverlay, busyProps, FbSpinner, InlineError as FbInlineError, Skeleton as FbSkeleton, StaleNote as FbStaleNote } from "../feedback-ui.tsx";
import { locale, tr } from "../core/i18n.ts";
import { Icon } from "./icons.tsx";

export { busyProps } from "../feedback-ui.tsx";

// The shared feedback elements (Russian by default, verbatim copies in every plugin) in the window's language (EP-126).
export const InlineError = (props: ComponentProps<typeof FbInlineError>) => <FbInlineError retryLabel={tr("Retry", "Повторить")} {...props} />;
export const Skeleton = (props: ComponentProps<typeof FbSkeleton>) => <FbSkeleton label={tr("Loading…", "Загружаю…")} {...props} />;
export const StaleNote = (props: ComponentProps<typeof FbStaleNote>) => <FbStaleNote label={tr("not updated", "не обновлено")} locale={locale()} {...props} />;
export { BusyOverlay };
export { Button } from "../components/ui/button.tsx";
export {
  DropdownMenu as Menu, DropdownMenuContent as MenuContent, DropdownMenuItem as MenuItem, DropdownMenuCheckboxItem as MenuCheck,
  DropdownMenuLabel as MenuLabel, DropdownMenuSeparator as MenuSeparator, DropdownMenuShortcut as MenuKey, DropdownMenuTrigger as MenuTrigger,
  DropdownMenuRadioGroup as MenuRadioGroup, DropdownMenuRadioItem as MenuRadio,
} from "../components/ui/dropdown-menu.tsx";
export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "../components/ui/popover.tsx";
export { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog.tsx";

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="dr-kbd">{children}</kbd>;
}

/** A number in a counter: neutral, or «waiting for you» (strong, the inversion). */
export function Count({ n, strong = false, label }: { n: number; strong?: boolean; label?: string }) {
  return <span className={`dr-count${strong ? " dr-count--strong" : ""}`} aria-label={label}>{n}</span>;
}

export function Dot({ tone }: { tone: "changed" | "waiting" | "added" | "removed" }) {
  return <span className={`dr-dot dr-dot--${tone}`} aria-hidden />;
}

/** A state badge: always a word; the tone adds a dot and a soft wash. */
export function Badge({ tone, children, title }: { tone?: "strong" | "changed" | "added" | "removed" | "waiting" | "quiet"; children: ReactNode; title?: string }) {
  return <span className={`dr-badge${tone ? ` dr-badge--${tone}` : ""}`} title={title}>{children}</span>;
}

/** One banner shape for every notice above the document (EP-020-T02): icon, text, actions on the right. */
export function Banner({ icon, tone, children, actions, role, sticky = false, ...data }: { icon: string; tone?: "error" | "warn" | "quiet"; children: ReactNode; actions?: ReactNode; role?: "alert" | "status"; sticky?: boolean; [key: `data-${string}`]: unknown }) {
  return <div className={`dr-banner${tone ? ` dr-banner--${tone}` : ""}${sticky ? " dr-banner--sticky" : ""}`} role={role} {...data}>
    <Icon name={icon} />
    <div className="dr-banner__text">{children}</div>
    {actions}
  </div>;
}

/** Empty state: what will be here and one next action. */
export function Empty({ icon, title, children, action }: { icon: string; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return <div className="dr-empty">
    <Icon name={icon} />
    {title && <b>{title}</b>}
    {children && <span>{children}</span>}
    {action}
  </div>;
}

/** Loading by the shape of the result: rows of different widths. */
export function SkeletonRows({ count = 8, row = 28 }: { count?: number; row?: number }) {
  const widths = [72, 54, 86, 40, 64, 78, 48, 60, 70, 44];
  return <div aria-busy="true" aria-label={tr("Loading", "Загрузка")} role="status">
    {Array.from({ length: count }, (_, index) => <div key={index} style={{ height: row, display: "flex", alignItems: "center", paddingLeft: 8 + (index % 3) * 12 }}>
      <div className="dr-skel" style={{ width: `${widths[index % widths.length]}%` }} />
    </div>)}
  </div>;
}

/** A hint with the key, shown on hover and keyboard focus (tooltip of the registry). */
export function Tip({ label, keys, children, side = "bottom" }: { label: ReactNode; keys?: string; children: ReactElement; side?: "top" | "bottom" | "left" | "right" }) {
  return <TooltipProvider delayDuration={400} skipDelayDuration={200}>
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}{keys && <kbd className="dr-kbd dr-kbd--inverse">{keys}</kbd>}</TooltipContent>
    </Tooltip>
  </TooltipProvider>;
}

/** An icon-only button: the name for screen readers and the hint with its key. */
export const IconButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, "children"> & { icon: string; label: string; keys?: string; small?: boolean; busy?: BusyState }>(
  function IconButton({ icon, label, keys, small = false, variant = "ghost", busy, ...props }, ref) {
    return <Tip label={label} keys={keys}>
      <Button ref={ref} variant={variant} size={small ? "icon-sm" : "icon"} aria-label={keys ? `${label} (${keys})` : label} {...(busy ? busyProps(busy) : {})} {...props}>
        {busy ? <BusyGlyph name={icon} size={small ? 14 : 16} /> : <Icon name={icon} />}
      </Button>
    </Tip>;
  },
);

/** A view toggle (aria-pressed): icon + label; the label may hide by width (class), the name stays. */
export function ToggleButton({ pressed, onChange, icon, label, keys, labelClass, hint, attrs }: { pressed: boolean; onChange: (next: boolean) => void; icon: string; label: string; keys?: string; labelClass?: string; hint?: string; attrs?: Record<`data-${string}`, string> }) {
  return <Tip label={hint ?? label} keys={keys}>
    <Toggle pressed={pressed} onPressedChange={onChange} aria-label={label} {...attrs}>
      <Icon name={icon} /><span className={labelClass}>{label}</span>
    </Toggle>
  </Tip>;
}

/** A segmented choice — one of N (radiogroup; arrows move the choice; Tab enters once). */
export function Segments<T extends string>({ value, onChange, items, label, className }: { value: T; onChange: (next: T) => void; items: { value: T; label: ReactNode; title?: string; aria?: string }[]; label: string; className?: string }) {
  return <ToggleGroup type="single" value={value} onValueChange={(next) => { if (next) onChange(next as T); }} aria-label={label} className={className}>
    {/* APG radiogroup: arrows move the choice, not only the focus (Radix moves the focus; the focus selects). */}
    {items.map((item) => <ToggleGroupItem key={item.value} value={item.value} title={item.title} aria-label={item.aria}
      onFocus={(event) => { if (item.value !== value && event.currentTarget.matches(":focus-visible")) onChange(item.value); }}>{item.label}</ToggleGroupItem>)}
  </ToggleGroup>;
}

/**
 * The icon of a control with a command (W-06b, EP-032 shared elements): the Lucide icon, which becomes the shared
 * loader-circle while the control has `data-fb-busy` (busyProps of feedback-ui.tsx) — the width never changes.
 */
export function BusyGlyph({ name, size = 16 }: { name: string; size?: number }) {
  return <BusyIcon size={size}><Icon name={name} size={size} /></BusyIcon>;
}

/** A spinner of a place that is loading (the shared loader-circle; reduced motion — a pulse). */
export function Spinner({ size = 14 }: { size?: number }) {
  return <FbSpinner size={size} />;
}

/** A short explanation of a long wait (> 1 s) at the place of the wait: spinner + text, announced politely. */
export function WaitNote({ children, className, ...data }: { children: ReactNode; className?: string; [key: `data-${string}`]: unknown }) {
  return <span className={`dr-waitnote${className ? ` ${className}` : ""}`} role="status" aria-live="polite" {...data}><FbSpinner size={14} /><span className="dr-trunc">{children}</span></span>;
}

/** A command button sets aria-busy and aria-disabled immediately without losing focus. Its indicator appears after 150 ms for at least 400 ms, replacing the icon or overlaying the label. Ignore duplicate presses; explain waits beyond one second. run resolves on completion. */
export function CommandButton({ run, icon, slow, children, ...props }: Omit<ButtonProps, "onClick"> & { run: () => Promise<unknown>; icon?: string; slow?: ReactNode }) {
  const command = useCommand(async () => { await run(); });
  const size = props.size === "sm" || props.size === "icon-sm" ? 14 : 16;
  const button = <Button {...props} {...busyProps(command.state)} onClick={() => void command.start()}>
    {icon ? <><BusyGlyph name={icon} size={size} />{children}</> : <><span className="inline-flex items-center gap-[inherit]">{children}</span><BusyOverlay size={size} /></>}
  </Button>;
  if (!slow) return button;
  return <>{button}{command.state.slow && <WaitNote>{slow}</WaitNote>}</>;
}

export type { ComponentProps, CommandState };
