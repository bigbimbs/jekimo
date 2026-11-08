import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full caption-bottom border-collapse text-sm", className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead className={cn("bg-sidebar [&_tr]:border-b", className)} {...props} />;
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "h-8 whitespace-nowrap px-3 text-start align-middle text-xs font-medium text-muted-foreground first:ps-4 last:pe-4",
        className,
      )}
      {...props}
    />
  );
}

export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={cn("border-b border-border transition-colors last:border-0", className)} {...props} />;
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("px-3 py-2 align-middle first:ps-4 last:pe-4", className)} {...props} />;
}
