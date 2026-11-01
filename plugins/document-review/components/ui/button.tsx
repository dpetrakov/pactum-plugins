// Registry button (@bb/button), restyled to the «Documents» design system: the variants map to the dr-btn classes of
// ui/theme.css (one place for sizes and states). Primary is the inversion (--foreground fill), one per screen.
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const buttonVariants = cva("dr-btn", {
  variants: {
    variant: {
      default: "",
      primary: "dr-btn--primary",
      ghost: "dr-btn--ghost",
      danger: "dr-btn--danger",
    },
    size: {
      default: "",
      lg: "dr-btn--lg",
      sm: "dr-btn--sm",
      icon: "dr-btn--icon",
      "icon-sm": "dr-btn--sm dr-btn--icon",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, type, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} type={asChild ? undefined : (type ?? "button")} {...props} />;
});
Button.displayName = "Button";

export { Button, buttonVariants };
