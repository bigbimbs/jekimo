import { useInfiniteQuery } from "@tanstack/react-query";
import { InboxIcon, LoaderCircleIcon, SearchXIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { EmptyState, ErrorState, PageHeader } from "../../components/states";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Table, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { ALL, ISSUE_PAGE_SIZE } from "../../constants/issues";
import { useApi } from "../../lib/api-context";
import { useErrorMessage } from "../../lib/errors";
import { useFormat } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";
import { cn } from "../../lib/utils";
import type { IssueFilters as Filters } from "../../types/issues";
import { useProject } from "../projects/use-project";
import { KindBadge, SeverityBadge, StatusBadge } from "./badges";
import { DEFAULT_FILTERS, filtersFromParams, filtersToParams, issueQuery } from "./filters";
import { IssueFilters } from "./issue-filters";

function LoadingRows() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: 8 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
        <div key={i} className="flex items-center gap-6 px-4 py-3">
          <div className="grid flex-1 gap-2">
            <Skeleton className="h-3.5" style={{ width: `${70 - ((i * 13) % 35)}%` }} />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="h-5 w-16" />
          <Skeleton className="hidden h-5 w-20 sm:block" />
          <Skeleton className="h-3.5 w-10" />
          <Skeleton className="h-3.5 w-20" />
        </div>
      ))}
    </div>
  );
}

export function IssueListPage() {
  const { t } = useTranslation("issues");
  const api = useApi();
  const project = useProject();
  const format = useFormat();
  const message = useErrorMessage();
  const [params, setParams] = useSearchParams();
  const filters = filtersFromParams(params);

  const issues = useInfiniteQuery({
    queryKey: queryKeys.issues(project.id, filters),
    queryFn: ({ pageParam }) => api.listIssues(project.id, issueQuery(filters, ISSUE_PAGE_SIZE, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor,
  });

  const rows = issues.data?.pages.flatMap((p) => p.issues) ?? [];
  const filtered = (Object.keys(DEFAULT_FILTERS) as (keyof Filters)[]).some(
    (k) => k !== "status" && filters[k] !== DEFAULT_FILTERS[k],
  );
  const base = `/projects/${encodeURIComponent(project.id)}`;
  // With one status selected the column repeats the filter, so narrow screens drop it.
  const statusColumn = filters.status === ALL ? undefined : "hidden xl:table-cell";
  const time = (iso: string) => (
    <time dateTime={iso} title={format.dateTime(iso)}>
      {format.relative(iso)}
    </time>
  );

  let body: ReactNode;
  if (issues.isPending) {
    body = <LoadingRows />;
  } else if (!issues.data) {
    body = <ErrorState error={issues.error} onRetry={() => issues.refetch()} />;
  } else if (rows.length === 0) {
    body =
      filtered || filters.status !== "unresolved" ? (
        <EmptyState icon={<SearchXIcon />} title={t("emptyTitle")} body={t("emptyBody")} />
      ) : (
        <EmptyState
          icon={<InboxIcon />}
          title={t("noneTitle")}
          body={t("noneBody")}
          action={
            <Button asChild variant="outline">
              <Link to={`${base}/settings`}>{t("toSettings")}</Link>
            </Button>
          }
        />
      );
  } else {
    body = (
      <>
        <Table className="table-fixed">
          <caption className="sr-only">{t("table.caption", { project: project.name })}</caption>
          <TableHeader>
            <TableRow>
              <TableHead>{t("table.issue")}</TableHead>
              <TableHead className="w-28">{t("table.severity")}</TableHead>
              <TableHead className={cn("w-32", statusColumn)}>{t("table.status")}</TableHead>
              <TableHead className="w-20 text-end">{t("table.events")}</TableHead>
              <TableHead className="w-36">{t("table.lastSeen")}</TableHead>
              <TableHead className="hidden w-36 lg:table-cell">{t("table.firstSeen")}</TableHead>
            </TableRow>
          </TableHeader>
          <tbody>
            {rows.map((issue) => (
              <TableRow key={issue.id} className="group relative hover:bg-sidebar">
                <TableCell className="py-2.5">
                  <Link
                    to={`${base}/issues/${encodeURIComponent(issue.id)}`}
                    className="block truncate font-medium text-foreground after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring group-hover:text-primary"
                  >
                    {issue.title}
                  </Link>
                  <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                    <KindBadge kind={issue.kind} />
                    {issue.environments.length > 0 && (
                      <span className="truncate font-mono text-[0.6875rem]">{issue.environments.join(" · ")}</span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <SeverityBadge severity={issue.last_severity} />
                </TableCell>
                <TableCell className={statusColumn}>
                  <StatusBadge status={issue.status} />
                </TableCell>
                <TableCell className="text-end font-medium tabular-nums">{format.number(issue.event_count)}</TableCell>
                <TableCell className="whitespace-nowrap text-[0.8125rem] text-muted-foreground">
                  {time(issue.last_seen)}
                </TableCell>
                <TableCell className="hidden whitespace-nowrap text-[0.8125rem] text-muted-foreground lg:table-cell">
                  {time(issue.first_seen)}
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-sidebar px-4 py-2.5">
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {t("shown", { count: rows.length })}
          </p>
          {issues.isFetchNextPageError && <p className="text-xs text-destructive">{message(issues.error)}</p>}
          {(issues.hasNextPage || issues.isFetchNextPageError) && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => issues.fetchNextPage()}
              disabled={issues.isFetchingNextPage}
            >
              {issues.isFetchingNextPage && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
              {t("loadMore")}
            </Button>
          )}
        </footer>
      </>
    );
  }

  return (
    <div className="mx-auto grid max-w-7xl gap-5 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <PageHeader title={t("title")} description={t("intro", { project: project.name })}>
        <IssueFilters filters={filters} onChange={(next) => setParams(filtersToParams(next), { replace: true })} />
      </PageHeader>
      <section
        aria-label={t("title")}
        className={cn(
          "relative overflow-hidden rounded-lg border border-border bg-background shadow-xs transition-opacity",
          issues.isFetching && !issues.isPending && !issues.isFetchingNextPage && "opacity-70",
        )}
        aria-busy={issues.isFetching}
      >
        {body}
      </section>
    </div>
  );
}
