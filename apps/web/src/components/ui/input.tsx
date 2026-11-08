import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export const fieldClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(fieldClass, className)} {...props} />;
}

export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(fieldClass, "w-auto cursor-pointer pe-8", className)} {...props} />;
}
