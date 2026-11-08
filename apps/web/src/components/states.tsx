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
    <div className={cn("flex flex-col items-center px-6 py-16 text-center", className)}>
      {icon && (
        <div className="mb-4 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">
          {icon}
        </div>
      )}
      <h2 className="text-base font-semibold">{title}</h2>
      {body && <p className="mt-1 max-w-md text-sm text-muted-foreground">{body}</p>}
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

export function PageLoader({ className }: { className?: string | undefined }) {
  const { t } = useTranslation();
  return (
    <div role="status" className={cn("flex items-center justify-center p-16 text-muted-foreground", className)}>
      <LoaderCircleIcon className="size-5 animate-spin" aria-hidden="true" />
      <span className="sr-only">{t("states.loading")}</span>
    </div>
  );
}
