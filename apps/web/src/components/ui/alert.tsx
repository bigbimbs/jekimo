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
        "flex gap-3 rounded-md border px-4 py-3 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0",
        variant === "default" && "border-border bg-muted/50",
        variant === "warning" && "border-warning/40 bg-warning/10 [&>svg]:text-warning",
        variant === "destructive" && "border-destructive/40 bg-destructive/10 [&>svg]:text-destructive",
        className,
      )}
      {...props}
    />
  );
}
