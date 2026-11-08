import type { AttributeValue } from "@jekimo/event-schema";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftIcon, SearchXIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { EmptyState, ErrorState, PageLoader } from "../../components/states";
import { Alert } from "../../components/ui/alert";
import { useApi } from "../../lib/api-context";
import { isApiError } from "../../lib/errors";
import { useFormat } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";
import { useProject } from "../projects/use-project";
import { KindBadge, SeverityBadge, StatusBadge } from "./badges";
import { IssueActions } from "./issue-actions";
import { StackTrace } from "./stack-trace";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-sm">{children}</dd>
    </div>
  );
}

function KeyValues({ entries }: { entries: [string, ReactNode][] }) {
  return (
    <dl className="divide-y divide-border rounded-md border border-border text-sm">
      {entries.map(([key, value]) => (
        <div key={key} className="grid gap-1 px-3 py-2 sm:grid-cols-[minmax(8rem,14rem)_1fr] sm:gap-4">
          <dt className="break-all font-mono text-xs leading-5 text-muted-foreground">{key}</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-all font-mono text-xs leading-5">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function attributeText(value: AttributeValue): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function IssueDetailPage() {
  const { t } = useTranslation("issues");
  const api = useApi();
  const project = useProject();
  const format = useFormat();
  const { issueId = "" } = useParams();
  const detail = useQuery({
    queryKey: queryKeys.issue(project.id, issueId),
    queryFn: () => api.getIssue(project.id, issueId),
    retry: (count, error) => !isApiError(error, 404) && count < 2,
  });
  const listPath = `/projects/${encodeURIComponent(project.id)}/issues`;
  const none = <span className="text-muted-foreground">{t("detail.none")}</span>;

  const back = (
    <Link
      to={listPath}
      className="inline-flex items-center gap-1.5 justify-self-start rounded-sm text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeftIcon className="size-4 rtl:rotate-180" aria-hidden="true" />
      {t("detail.back")}
    </Link>
  );

  if (detail.isPending) return <PageLoader />;
  if (detail.isError) {
    return (
      <div className="mx-auto grid max-w-5xl gap-6 p-6 lg:p-8">
        {back}
        {isApiError(detail.error, 404) ? (
          <EmptyState icon={<SearchXIcon />} title={t("detail.notFoundTitle")} body={t("detail.notFoundBody")} />
        ) : (
          <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
        )}
      </div>
    );
  }

  const { issue, latest_event: latest } = detail.data;
  const event = latest?.event;
  const time = (iso: string) => (
    <time dateTime={iso} title={format.dateTime(iso)}>
      {format.relative(iso)}
    </time>
  );

  return (
    <article className="mx-auto grid max-w-5xl gap-8 p-6 lg:p-8">
      <header className="grid gap-4">
        {back}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid min-w-0 gap-2">
            <h1 className="break-words text-xl font-semibold tracking-tight">{issue.title}</h1>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={issue.status} />
              <SeverityBadge severity={issue.last_severity} />
              <KindBadge kind={issue.kind} />
            </div>
          </div>
          <IssueActions projectId={project.id} issue={issue} />
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-lg border border-border p-4 sm:grid-cols-3 lg:grid-cols-4">
          <Meta label={t("detail.events")}>{format.number(issue.event_count)}</Meta>
          <Meta label={t("detail.firstSeen")}>{time(issue.first_seen)}</Meta>
          <Meta label={t("detail.lastSeen")}>{time(issue.last_seen)}</Meta>
          <Meta label={t("detail.environments")}>
            {issue.environments.length > 0 ? issue.environments.join(", ") : none}
          </Meta>
          <Meta label={t("detail.release")}>{event?.release ?? none}</Meta>
          <Meta label={t("detail.environment")}>{event?.environment ?? none}</Meta>
          <Meta label={t("detail.service")}>{event?.service ?? none}</Meta>
          <Meta label={t("detail.fingerprint")}>
            <span className="font-mono text-xs" title={issue.fingerprint}>
              {issue.fingerprint}
            </span>
          </Meta>
        </dl>
      </header>

      {!latest || !event ? (
        <Alert>{t("detail.noLatestEvent")}</Alert>
      ) : (
        <>
          <Section title={t("detail.message")}>
            <p className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 px-4 py-3 font-mono text-sm">
              {event.message}
            </p>
          </Section>

          {event.exception && (
            <Section title={t("detail.exception")}>
              <div className="grid gap-1">
                <p className="break-words font-mono text-sm font-semibold">{event.exception.type}</p>
                {event.exception.value && (
                  <p className="whitespace-pre-wrap break-words font-mono text-sm text-muted-foreground">
                    {event.exception.value}
                  </p>
                )}
              </div>
            </Section>
          )}

          <Section title={t("detail.stackTrace")}>
            {event.exception?.stacktrace ? (
              <StackTrace stacktrace={event.exception.stacktrace} />
            ) : (
              <p className="text-sm text-muted-foreground">{t("detail.noStackTrace")}</p>
            )}
          </Section>

          {event.context && Object.keys(event.context).length > 0 && (
            <Section title={t("detail.context")}>
              <KeyValues entries={Object.entries(event.context)} />
            </Section>
          )}

          {event.attributes && Object.keys(event.attributes).length > 0 && (
            <Section title={t("detail.attributes")}>
              <KeyValues entries={Object.entries(event.attributes).map(([k, v]) => [k, attributeText(v)])} />
            </Section>
          )}

          <Section title={t("detail.latestEvent")}>
            <KeyValues
              entries={[
                [t("detail.eventId"), event.event_id],
                [t("detail.occurredAt"), format.dateTime(event.timestamp)],
                [t("detail.receivedAt"), format.dateTime(latest.received_at)],
                ...(event.sdk ? [[t("detail.sdk"), `${event.sdk.name} ${event.sdk.version}`] as [string, string]] : []),
              ]}
            />
          </Section>
        </>
      )}
    </article>
  );
}
