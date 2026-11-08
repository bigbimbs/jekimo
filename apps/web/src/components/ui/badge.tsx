import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * A label with a soft tint and an optional colored dot or icon. The text
 * keeps the foreground color, so its contrast never depends on the hue, and
 * color is never the only signal.
 */
export function Badge({
  className,
  dot,
  icon,
  children,
  ...props
}: ComponentProps<"span"> & { dot?: string; icon?: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-xs font-medium [&_svg]:size-3.5 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {dot && <span aria-hidden="true" className={cn("size-2 rounded-full", dot)} />}
      {icon}
      {children}
    </span>
  );
}
