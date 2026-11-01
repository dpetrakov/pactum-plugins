// Registry toggle (@bb/toggle) in the design system: a pressed button (aria-pressed), icon + label; on — --dr-pressed.
import * as React from "react";
import * as TogglePrimitive from "@radix-ui/react-toggle";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const toggleVariants = cva("dr-tgl", {
  variants: {
    variant: { default: "", segment: "dr-seg__item" },
    size: { default: "", icon: "dr-tgl--icon" },
  },
  defaultVariants: { variant: "default", size: "default" },
});

const Toggle = React.forwardRef<
  React.ElementRef<typeof TogglePrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>
>(({ className, variant, size, ...props }, ref) => <TogglePrimitive.Root ref={ref} className={cn(toggleVariants({ variant, size, className }))} {...props} />);

Toggle.displayName = TogglePrimitive.Root.displayName;

export { Toggle, toggleVariants };
