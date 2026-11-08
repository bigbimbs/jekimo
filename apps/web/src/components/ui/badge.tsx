import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/** A label with an optional colored dot; the text keeps the foreground color so it meets contrast in both themes. */
export function Badge({ className, dot, children, ...props }: ComponentProps<"span"> & { dot?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-xs font-medium",
        className,
      )}
      {...props}
    >
      {dot && <span aria-hidden="true" className={cn("size-2 rounded-full", dot)} />}
      {children}
    </span>
  );
}
