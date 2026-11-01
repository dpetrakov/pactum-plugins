import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "../../lib/portal-scope";
import { isLastInputKeyboard } from "./overlay-trigger.js";

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>
>(function TooltipTriggerComponent({ onFocus, ...props }, ref) {
  return (
    <TooltipPrimitive.Trigger
      ref={ref}
      onFocus={(event) => {
        onFocus?.(event);
        if (!event.defaultPrevented && !isLastInputKeyboard()) {
          event.preventDefault();
        }
      }}
      {...props}
    />
  );
});
TooltipTrigger.displayName = TooltipPrimitive.Trigger.displayName;

const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContentComponent(
  {
    avoidCollisions = true,
    className,
    collisionPadding = 8,
    sideOffset = 4,
    ...props
  },
  ref,
) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        {...usePortalScopeProps()}
        avoidCollisions={avoidCollisions}
        collisionPadding={collisionPadding}
        sideOffset={sideOffset}
        className={cn(
          "z-50 inline-flex max-w-[min(20rem,var(--radix-tooltip-content-available-width))] items-center gap-1.5 overflow-hidden rounded-[var(--dr-r-xs)] bg-foreground px-2 py-1 text-xs text-background shadow-[var(--shadow-md)] break-words animate-in fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
});
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
