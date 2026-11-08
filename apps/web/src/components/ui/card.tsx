import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils";

export function Card({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn("overflow-hidden rounded-lg border border-border bg-background shadow-xs", className)}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  titleId,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  titleId?: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-3",
        className,
      )}
    >
      <div className="grid min-w-0 gap-0.5">
        <h2 id={titleId} className="text-sm font-semibold">
          {title}
        </h2>
        {description && <p className="max-w-2xl text-[0.8125rem] text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
