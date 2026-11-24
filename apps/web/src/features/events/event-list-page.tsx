import { useInfiniteQuery } from "@tanstack/react-query";
import { RefreshCwIcon, SearchIcon, SearchXIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { EmptyState, ErrorState, PageHeader, PageLoader } from "../../components/states";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input, NativeSelect } from "../../components/ui/input";
import { Table, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { EVENT_PAGE_SIZE, EVENT_PERIODS } from "../../constants/events";
import { SEVERITIES } from "../../constants/issues";
import { useApi } from "../../lib/api-context";
import { useErrorMessage } from "../../lib/errors";
import { useFormat } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";
import type { EventQuery } from "../../types/api";
import { SeverityBadge } from "../issues/badges";
import { useProject } from "../projects/use-project";

export function EventListPage({ kind }: { kind: "log" | "event" }) {
  const { t } = useTranslation("events");
  const { t: ti } = useTranslation("issues");
  const api = useApi();
  const project = useProject();
  const format = useFormat();
  const message = useErrorMessage();
  const [params, setParams] = useSearchParams();
  const [refreshedAt, setRefreshedAt] = useState(() => Date.now());
  const rawPeriod = params.get("period") ?? "24h";
  const period = Object.hasOwn(EVENT_PERIODS, rawPeriod) ? (rawPeriod as keyof typeof EVENT_PERIODS) : "24h";
  const severity = SEVERITIES.find((value) => value === params.get("severity"));
  const q = params.get("q")?.trim() ?? "";
  const environment = params.get("environment")?.trim() ?? "";
  // Keep a fixed receipt window while walking cursor pages.
  const window = useMemo(
    () => ({
      from: new Date(refreshedAt - EVENT_PERIODS[period] * 3_600_000).toISOString(),
      to: new Date(refreshedAt).toISOString(),
    }),
    [period, refreshedAt],
  );
  const query: EventQuery = {
    kind,
    database: false,
    ...window,
    limit: EVENT_PAGE_SIZE,
    ...(severity && { severity }),
    ...(q && { q }),
    ...(environment && { environment }),
  };
  const records = useInfiniteQuery({
    queryKey: queryKeys.events(project.id, query),
    queryFn: ({ pageParam }) => api.listEvents(project.id, { ...query, ...(pageParam && { cursor: pageParam }) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor,
  });
  const rows = records.data?.pages.flatMap((page) => page.events) ?? [];
  const base = `/projects/${encodeURIComponent(project.id)}/${kind === "log" ? "logs" : "events"}`;
  const update = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: true });
  };
  return (
    <div className="mx-auto grid max-w-7xl gap-5 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <PageHeader
        title={t(`${kind}.title`)}
        description={t(`${kind}.intro`, { project: project.name })}
        actions={
          <Button variant="outline" size="sm" disabled={records.isFetching} onClick={() => setRefreshedAt(Date.now())}>
            <RefreshCwIcon aria-hidden="true" />
            {t("refresh")}
          </Button>
        }
      >
        <form
          key={`${q}/${environment}`}
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            const next = new URLSearchParams(params);
            for (const name of ["q", "environment"]) {
              const value = String(fields.get(name) ?? "").trim();
              if (value) next.set(name, value);
              else next.delete(name);
            }
            setParams(next, { replace: true });
          }}
        >
          <label htmlFor="record-search" className="grid min-w-48 flex-1 gap-1.5 text-xs text-muted-foreground">
            {t("search")}
            <Input id="record-search" name="q" defaultValue={q} placeholder={t("searchPlaceholder")} maxLength={256} />
          </label>
          <label htmlFor="record-environment" className="grid gap-1.5 text-xs text-muted-foreground">
            {t("environment")}
            <Input
              id="record-environment"
              name="environment"
              defaultValue={environment}
              placeholder={t("environmentPlaceholder")}
              maxLength={128}
            />
          </label>
          <Button type="submit" variant="outline">
            <SearchIcon aria-hidden="true" />
            {t("apply")}
          </Button>
        </form>
        <div className="flex flex-wrap items-end gap-3">
          <label htmlFor="record-severity" className="grid gap-1.5 text-xs text-muted-foreground">
            {t("severity")}
            <NativeSelect
              id="record-severity"
              value={severity ?? ""}
              onChange={(event) => update("severity", event.target.value)}
            >
              <option value="">{ti("filters.any")}</option>
              {SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {ti(`severity.${value}`)}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label htmlFor="record-period" className="grid gap-1.5 text-xs text-muted-foreground">
            {t("period")}
            <NativeSelect id="record-period" value={period} onChange={(event) => update("period", event.target.value)}>
              {(Object.keys(EVENT_PERIODS) as (keyof typeof EVENT_PERIODS)[]).map((value) => (
                <option key={value} value={value}>
                  {ti(`period.${value}`)}
                </option>
              ))}
            </NativeSelect>
          </label>
          {(q || environment || severity || period !== "24h") && (
            <Button variant="ghost" onClick={() => setParams({}, { replace: true })}>
              {t("clear")}
            </Button>
          )}
        </div>
      </PageHeader>
      <p className="text-xs text-muted-foreground">
        {t("window", { from: format.dateTime(window.from), to: format.dateTime(window.to) })}
      </p>
      <Card aria-label={t(`${kind}.title`)} aria-busy={records.isFetching}>
        {records.isPending ? (
          <PageLoader />
        ) : !records.data ? (
          <ErrorState error={records.error} onRetry={() => records.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState icon={<SearchXIcon />} title={t(`${kind}.empty`)} body={t("emptyBody")} />
        ) : (
          <>
            <Table className="min-w-[48rem] table-fixed">
              <caption className="sr-only">{t(`${kind}.title`)}</caption>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">{t("received")}</TableHead>
                  <TableHead className="w-28">{t("severity")}</TableHead>
                  <TableHead>{t("message")}</TableHead>
                  <TableHead className="w-36">{t("service")}</TableHead>
                  <TableHead className="w-32">{t("environment")}</TableHead>
                </TableRow>
              </TableHeader>
              <tbody>
                {rows.map(({ event, received_at }) => (
                  <TableRow key={`${event.event_id}:${received_at}`} className="hover:bg-sidebar">
                    <TableCell className="text-xs text-muted-foreground">
                      <time dateTime={received_at} title={format.dateTime(received_at)}>
                        {format.relative(received_at)}
                      </time>
                    </TableCell>
                    <TableCell>
                      <SeverityBadge severity={event.severity} />
                    </TableCell>
                    <TableCell>
                      <Link
                        className="block truncate font-mono text-xs hover:text-primary hover:underline"
                        to={`${base}/${encodeURIComponent(event.event_id)}`}
                      >
                        {event.message}
                      </Link>
                    </TableCell>
                    <TableCell className="truncate text-xs">{event.service ?? t("none")}</TableCell>
                    <TableCell className="truncate text-xs text-muted-foreground">
                      {event.environment ?? t("none")}
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </Table>
            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-sidebar px-4 py-3">
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {t("shown", { count: rows.length })}
              </p>
              {records.isFetchNextPageError && (
                <p role="alert" className="text-xs text-destructive">
                  {message(records.error)}
                </p>
              )}
              {(records.hasNextPage || records.isFetchNextPageError) && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={records.isFetchingNextPage}
                  onClick={() => records.fetchNextPage()}
                >
                  {t("loadMore")}
                </Button>
              )}
            </footer>
          </>
        )}
      </Card>
    </div>
  );
}
