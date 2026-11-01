// Registry toggle group (@bb/toggle-group): with type="single" it is the segmented choice of the design system —
// a radiogroup on the --muted track, arrows move the choice (roving focus), the chosen segment is raised.
import * as React from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";

import { cn } from "../../lib/utils";

const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <ToggleGroupPrimitive.Root ref={ref} className={cn("dr-seg", className)} {...props}>
    {children}
  </ToggleGroupPrimitive.Root>
));
ToggleGroup.displayName = ToggleGroupPrimitive.Root.displayName;

const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <ToggleGroupPrimitive.Item ref={ref} className={cn("dr-seg__item", className)} {...props}>
    {children}
  </ToggleGroupPrimitive.Item>
));
ToggleGroupItem.displayName = ToggleGroupPrimitive.Item.displayName;

export { ToggleGroup, ToggleGroupItem };
