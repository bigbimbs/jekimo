import { useQuery } from "@tanstack/react-query";
import { ChevronLeftIcon, SearchXIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { EmptyState, ErrorState, PageHeader, PageLoader } from "../../components/states";
import { Card, CardHeader } from "../../components/ui/card";
import { useApi } from "../../lib/api-context";
import { isApiError } from "../../lib/errors";
import { useFormat } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";
import { SeverityBadge } from "../issues/badges";
import { useProject } from "../projects/use-project";
import { TraceLink } from "../traces/trace-link";

export function EventDetailPage({ kind }: { kind: "log" | "event" }) {
  const { t } = useTranslation("events");
  const api = useApi();
  const project = useProject();
  const format = useFormat();
  const { eventId = "" } = useParams();
  const detail = useQuery({
    queryKey: queryKeys.event(project.id, eventId),
    queryFn: () => api.getEvent(project.id, eventId),
    retry: (count, error) => !isApiError(error, 404) && count < 2,
  });
  const event = detail.data?.event;
  const base = `/projects/${encodeURIComponent(project.id)}/${kind === "log" ? "logs" : "events"}`;
  return (
    <article className="mx-auto grid max-w-7xl gap-5 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <Link to={base} className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeftIcon className="size-4 rtl:rotate-180" aria-hidden="true" />
        {t(`${kind}.back`)}
      </Link>
      {detail.isPending ? (
        <PageLoader />
      ) : isApiError(detail.error, 404) || (event && event.kind !== kind) ? (
        <EmptyState icon={<SearchXIcon />} title={t("notFound")} body={t("notFoundBody")} />
      ) : detail.isError ? (
        <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
      ) : detail.data && event ? (
        <>
          <PageHeader title={t(`${kind}.detail`)} actions={<SeverityBadge severity={event.severity} />} />
          <TraceLink projectId={project.id} traceId={event.context?.trace_id} receivedAt={detail.data.received_at} />
          <Card>
            <CardHeader title={t("message")} />
            <p className="whitespace-pre-wrap break-words bg-code p-4 font-mono text-sm leading-6">{event.message}</p>
          </Card>
          <Card>
            <dl className="grid gap-x-8 gap-y-5 p-4 sm:grid-cols-2 lg:grid-cols-3">
              {[
                [t("id"), event.event_id],
                [t("received"), format.dateTime(detail.data.received_at)],
                [t("occurred"), format.dateTime(event.timestamp)],
                [t("service"), event.service],
                [t("environment"), event.environment],
                [t("release"), event.release],
                [t("fingerprint"), event.fingerprint],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="mt-1 break-all text-sm">{value ?? t("none")}</dd>
                </div>
              ))}
            </dl>
          </Card>
          {(["context", "attributes"] as const).map((field) =>
            event[field] && Object.keys(event[field]).length > 0 ? (
              <Card key={field}>
                <CardHeader title={t(field)} />
                <pre className="overflow-x-auto bg-code p-4 text-xs leading-6">
                  {JSON.stringify(event[field], null, 2)}
                </pre>
              </Card>
            ) : null,
          )}
          <details className="rounded-lg border border-border p-4">
            <summary className="cursor-pointer text-sm text-muted-foreground">{t("raw")}</summary>
            <pre className="mt-3 overflow-x-auto text-xs leading-6">{JSON.stringify(event, null, 2)}</pre>
          </details>
        </>
      ) : null}
    </article>
  );
}
