import { AlertCircleIcon, LoaderCircleIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useErrorMessage } from "../lib/errors";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  body?: string | undefined;
  action?: ReactNode;
  className?: string | undefined;
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-14 text-center animate-fade-in", className)}>
      {icon && (
        <div className="relative isolate mb-4 flex size-11 items-center justify-center rounded-xl border border-border bg-background text-muted-foreground shadow-sm [&_svg]:size-5">
          <span aria-hidden="true" className="absolute -inset-2 -z-10 rounded-2xl bg-muted/60" />
          {icon}
        </div>
      )}
      <h2 className="text-[0.9375rem] font-semibold tracking-tight">{title}</h2>
      {body && <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string | undefined;
}) {
  const { t } = useTranslation();
  const message = useErrorMessage();
  return (
    <EmptyState
      className={className}
      icon={<AlertCircleIcon />}
      title={t("states.errorTitle")}
      body={message(error)}
      action={
        onRetry && (
          <Button variant="outline" onClick={onRetry}>
            {t("actions.retry")}
          </Button>
        )
      }
    />
  );
}

export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="grid min-w-0 gap-1">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

export function PageLoader({ className }: { className?: string | undefined }) {
  const { t } = useTranslation();
  return (
    <div role="status" className={cn("flex items-center justify-center p-16 text-muted-foreground", className)}>
      <LoaderCircleIcon className="size-5 animate-spin opacity-70" aria-hidden="true" />
      <span className="sr-only">{t("states.loading")}</span>
    </div>
  );
}
