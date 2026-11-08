import type { AttributeValue } from "@jekimo/event-schema";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeftIcon, SearchXIcon } from "lucide-react";
import { type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { EmptyState, ErrorState, PageLoader } from "../../components/states";
import { Alert } from "../../components/ui/alert";
import { Card, CardHeader } from "../../components/ui/card";
import { useApi } from "../../lib/api-context";
import { isApiError } from "../../lib/errors";
import { useFormat } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";
import { useProject } from "../projects/use-project";
import { KindBadge, SeverityBadge, StatusBadge } from "./badges";
import { IssueActions } from "./issue-actions";
import { StackTrace } from "./stack-trace";

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <Card aria-labelledby={id}>
      <CardHeader title={title} titleId={id} />
      {children}
    </Card>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5 xl:grid-cols-[6.5rem_minmax(0,1fr)] xl:items-baseline xl:gap-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-[0.8125rem] font-medium">{children}</dd>
    </div>
  );
}

function KeyValues({ entries }: { entries: [string, ReactNode][] }) {
  return (
    <dl className="divide-y divide-border text-sm">
      {entries.map(([key, value]) => (
        <div
          key={key}
          className="grid gap-1 px-4 py-2 transition-colors hover:bg-sidebar sm:grid-cols-[minmax(8rem,13rem)_1fr] sm:gap-4"
        >
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
  const none = <span className="font-normal text-muted-foreground">{t("detail.none")}</span>;

  const back = (
    <Link
      to={listPath}
      className="-ms-1.5 inline-flex h-7 items-center gap-1 justify-self-start rounded-md pe-2 ps-1 text-[0.8125rem] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <ChevronLeftIcon className="size-4 rtl:rotate-180" aria-hidden="true" />
      {t("detail.back")}
    </Link>
  );
  const page = "mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-8";

  if (detail.isPending) return <PageLoader />;
  if (detail.isError) {
    return (
      <div className={page}>
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
    <article className={page}>
      <header className="grid gap-3">
        {back}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid min-w-0 gap-2.5">
            <h1 className="break-words text-xl font-semibold leading-snug tracking-tight">{issue.title}</h1>
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusBadge status={issue.status} />
              <SeverityBadge severity={issue.last_severity} />
              <KindBadge kind={issue.kind} />
              {event?.service && (
                <span className="ms-1 truncate font-mono text-xs text-muted-foreground">{event.service}</span>
              )}
            </div>
          </div>
          <IssueActions projectId={project.id} issue={issue} />
        </div>
      </header>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <aside className="xl:sticky xl:top-6 xl:order-last">
          <Card aria-labelledby="issue-details-title">
            <CardHeader title={t("detail.details")} titleId="issue-details-title" />
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3.5 p-4 sm:grid-cols-4 xl:grid-cols-1 xl:gap-y-3">
              <Meta label={t("detail.events")}>
                <span className="tabular-nums">{format.number(issue.event_count)}</span>
              </Meta>
              <Meta label={t("detail.firstSeen")}>{time(issue.first_seen)}</Meta>
              <Meta label={t("detail.lastSeen")}>{time(issue.last_seen)}</Meta>
              <Meta label={t("detail.environments")}>
                {issue.environments.length > 0 ? issue.environments.join(", ") : none}
              </Meta>
              <Meta label={t("detail.release")}>{event?.release ?? none}</Meta>
              <Meta label={t("detail.environment")}>{event?.environment ?? none}</Meta>
              <Meta label={t("detail.service")}>{event?.service ?? none}</Meta>
              <Meta label={t("detail.fingerprint")}>
                <span className="font-mono text-xs font-normal" title={issue.fingerprint}>
                  {issue.fingerprint}
                </span>
              </Meta>
            </dl>
          </Card>
        </aside>

        <div className="grid min-w-0 gap-5">
          {!latest || !event ? (
            <Alert>{t("detail.noLatestEvent")}</Alert>
          ) : (
            <>
              <Section title={t("detail.message")}>
                <p className="whitespace-pre-wrap break-words bg-code px-4 py-3 font-mono text-[0.8125rem] leading-6">
                  {event.message}
                </p>
              </Section>

              {event.exception && (
                <Section title={t("detail.exception")}>
                  <div className="grid gap-1 px-4 py-3">
                    <p className="break-words font-mono text-sm font-semibold">{event.exception.type}</p>
                    {event.exception.value && (
                      <p className="whitespace-pre-wrap break-words font-mono text-[0.8125rem] text-muted-foreground">
                        {event.exception.value}
                      </p>
                    )}
                  </div>
                </Section>
              )}

              {event.exception?.stacktrace ? (
                <StackTrace title={t("detail.stackTrace")} stacktrace={event.exception.stacktrace} />
              ) : (
                <Section title={t("detail.stackTrace")}>
                  <p className="px-4 py-3 text-sm text-muted-foreground">{t("detail.noStackTrace")}</p>
                </Section>
              )}

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
                    ...(event.sdk
                      ? [[t("detail.sdk"), `${event.sdk.name} ${event.sdk.version}`] as [string, string]]
                      : []),
                  ]}
                />
              </Section>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
