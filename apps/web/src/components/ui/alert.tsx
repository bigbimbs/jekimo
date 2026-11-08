import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export function Alert({
  className,
  variant = "default",
  ...props
}: ComponentProps<"div"> & { variant?: "default" | "warning" | "destructive" }) {
  return (
    <div
      role={variant === "default" ? "status" : "alert"}
      className={cn(
        "flex gap-2.5 rounded-lg border px-3.5 py-3 text-sm leading-relaxed animate-fade-in [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0",
        variant === "default" && "border-border bg-sidebar [&>svg]:text-muted-foreground",
        variant === "warning" && "border-warning/40 bg-warning/10 [&>svg]:text-warning",
        variant === "destructive" && "border-destructive/40 bg-destructive/10 [&>svg]:text-destructive",
        className,
      )}
      {...props}
    />
  );
}
