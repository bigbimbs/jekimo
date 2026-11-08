import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export const fieldClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground hover:border-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive read-only:bg-sidebar";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(fieldClass, className)} {...props} />;
}

export function NativeSelect({
  className,
  wrapperClassName,
  ...props
}: ComponentProps<"select"> & { wrapperClassName?: string }) {
  return (
    <div className={cn("relative inline-flex", wrapperClassName)}>
      <select className={cn(fieldClass, "w-full cursor-pointer appearance-none pe-8", className)} {...props} />
      <ChevronDownIcon
        aria-hidden="true"
        className="pointer-events-none absolute end-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}
