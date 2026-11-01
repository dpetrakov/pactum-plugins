import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Skeleton({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-[var(--dr-r-xs)] bg-muted motion-reduce:animate-none", className)}
      {...props}
    />
  );
}
