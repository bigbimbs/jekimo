import { useQuery } from "@tanstack/react-query";
import {
  ActivityIcon,
  ArrowUpRightIcon,
  BugIcon,
  CheckCircleIcon,
  DatabaseIcon,
  LogsIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { EmptyState, ErrorState, PageHeader, PageLoader } from "../../components/states";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { SEVERITIES } from "../../constants/issues";
import { useApi } from "../../lib/api-context";
import { useFormat } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";
import { SeverityBadge } from "../issues/badges";
import { useProject } from "../projects/use-project";

export function DashboardPage() {
  const { t } = useTranslation("dashboard");
  const api = useApi();
  const project = useProject();
  const format = useFormat();
  const base = `/projects/${encodeURIComponent(project.id)}`;
  const summary = useQuery({
    queryKey: queryKeys.eventSummary(project.id),
    queryFn: () => api.getEventSummary(project.id),
  });
  const issues = useQuery({
    queryKey: queryKeys.recentIssues(project.id),
    queryFn: () => api.listIssues(project.id, { status: "unresolved", limit: 5 }),
  });
  const data = summary.data;
  const total = data?.activity.reduce((sum, row) => sum + row.count, 0) ?? 0;
  const countKind = (kind: string) =>
    data?.activity.filter((row) => row.kind === kind).reduce((sum, row) => sum + row.count, 0) ?? 0;
  const hours: { hour: string; count: number }[] = [];
  if (data) {
    const first = new Date(data.from);
    first.setUTCMinutes(0, 0, 0);
    for (let at = first.getTime(); at < Date.parse(data.to); at += 3_600_000) {
      const hour = new Date(at).toISOString();
      hours.push({
        hour,
        count: data.activity.filter((row) => row.hour === hour).reduce((sum, row) => sum + row.count, 0),
      });
    }
  }
  const max = Math.max(1, ...hours.map((hour) => hour.count));
  const cards = [
    { label: t("total"), count: total, icon: DatabaseIcon },
    {
      label: t("exception"),
      count: countKind("exception"),
      icon: BugIcon,
      to: `${base}/issues?kind=exception&status=all&period=24h`,
    },
    { label: t("log"), count: countKind("log"), icon: LogsIcon, to: `${base}/logs` },
    { label: t("event"), count: countKind("event"), icon: ActivityIcon, to: `${base}/events` },
  ];
  return (
    <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <PageHeader
        title={t("title")}
        description={t("intro", { project: project.name })}
        actions={
          <>
            <span className="text-xs text-muted-foreground">{t("period")}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={summary.isFetching || issues.isFetching}
              onClick={() => {
                void summary.refetch();
                void issues.refetch();
              }}
            >
              <RefreshCwIcon aria-hidden="true" />
              {t("refresh")}
            </Button>
          </>
        }
      />
      {summary.isPending ? (
        <PageLoader />
      ) : summary.isError ? (
        <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            {cards.map(({ label, count, icon: Icon, to }) => (
              <Card key={label} className="relative p-4 sm:p-5">
                <div className="flex items-center justify-between gap-2 text-muted-foreground">
                  <h2 className="text-xs font-medium">{label}</h2>
                  <Icon className="size-4" aria-hidden="true" />
                </div>
                <p className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">{format.number(count)}</p>
                {to && (
                  <Link
                    to={to}
                    aria-label={label}
                    className="absolute inset-0 rounded-lg transition-colors hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ArrowUpRightIcon
                      aria-hidden="true"
                      className="absolute bottom-4 end-4 size-4 text-muted-foreground rtl:-rotate-90"
                    />
                  </Link>
                )}
              </Card>
            ))}
          </div>
          <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(15rem,1fr)]">
            <Card>
              <CardHeader title={t("volume")} description={t("volumeDescription")} />
              {total === 0 ? (
                <EmptyState
                  icon={<ActivityIcon />}
                  title={t("noActivity")}
                  body={t("noActivityBody")}
                  action={
                    <Button asChild variant="outline">
                      <Link to={`${base}/settings`}>{t("settings")}</Link>
                    </Button>
                  }
                />
              ) : (
                <div className="p-4 sm:p-5">
                  <div
                    className="flex h-40 items-end gap-1 border-b border-border"
                    role="img"
                    aria-label={t("volumeDescription")}
                  >
                    {hours.map(({ hour, count }) => (
                      <div
                        key={hour}
                        className="group flex h-full min-w-0 flex-1 items-end"
                        title={t("chartPoint", { hour: format.dateTime(hour), count: format.number(count) })}
                      >
                        <div
                          className="w-full rounded-t-sm bg-primary transition-colors group-hover:bg-primary/70"
                          style={{ height: `${(count / max) * 100}%` }}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex flex-wrap justify-between gap-2 text-[0.6875rem] text-muted-foreground">
                    <span>{format.dateTime(summary.data.from)}</span>
                    <span>{format.dateTime(summary.data.to)}</span>
                  </div>
                  <details className="mt-4 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">{t("chartData")}</summary>
                    <table className="mt-2 w-full text-start">
                      <thead>
                        <tr>
                          <th className="text-start">{t("hour")}</th>
                          <th className="text-end">{t("count")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {hours.map(({ hour, count }) => (
                          <tr key={hour}>
                            <td className="py-1">{format.dateTime(hour)}</td>
                            <td className="text-end tabular-nums">{format.number(count)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                </div>
              )}
            </Card>
            <Card>
              <CardHeader title={t("severity")} />
              <dl className="grid gap-4 p-4 sm:p-5">
                {SEVERITIES.map((severity) => {
                  const count = summary.data.activity
                    .filter((row) => row.severity === severity)
                    .reduce((sum, row) => sum + row.count, 0);
                  return (
                    <div key={severity} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2">
                      <dt>
                        <SeverityBadge severity={severity} />
                      </dt>
                      <dd className="text-sm font-medium tabular-nums">{format.number(count)}</dd>
                      <div aria-hidden="true" className="col-span-2 h-1 rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${total ? (count / total) * 100 : 0}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </dl>
            </Card>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("retention")} <span>{t("updated", { time: format.dateTime(summary.data.to) })}</span>
          </p>
        </>
      )}
      <Card>
        <CardHeader
          title={t("recent")}
          description={t("recentDescription")}
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link to={`${base}/issues`}>
                {t("allIssues")}
                <ArrowUpRightIcon aria-hidden="true" />
              </Link>
            </Button>
          }
        />
        {issues.isPending ? (
          <PageLoader />
        ) : issues.isError ? (
          <ErrorState error={issues.error} onRetry={() => issues.refetch()} />
        ) : issues.data.issues.length === 0 ? (
          <EmptyState icon={<CheckCircleIcon />} title={t("noIssues")} body={t("noIssuesBody")} />
        ) : (
          <ul className="divide-y divide-border">
            {issues.data.issues.map((issue) => (
              <li key={issue.id}>
                <Link
                  to={`${base}/issues/${encodeURIComponent(issue.id)}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-sidebar sm:px-5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{issue.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("occurrences", { count: issue.event_count })} · {format.relative(issue.last_seen)}
                    </p>
                  </div>
                  <SeverityBadge severity={issue.last_severity} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
